import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Bot, MessageSquarePlus, RefreshCw } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import type {
  ConversationMessage,
  TerminalSnapshotResponse,
} from "@codex-deck/api";
import {
  claimTerminalWrite,
  getTerminalFrozenBlocks,
  getTerminalSnapshot,
  persistTerminalFrozenBlock,
  releaseTerminalWrite,
  restartTerminal,
  resizeTerminal,
  sendTerminalInput,
  subscribeTerminalStream,
} from "../api";
import { TERMINAL_FONT_FAMILY } from "../terminal-font";
import type { ResolvedTheme } from "../theme";
import {
  extractConversationMessageText,
  parseAiTerminalMessage,
  type AiTerminalStepDirective,
  type AiTerminalStepState,
} from "../ai-terminal";
import {
  buildTerminalTimeline,
  getFrozenTerminalTranscript,
  getTerminalInlineAnchorOffset,
  normalizeFrozenTerminalOutputsInOrder,
  restoreTerminalTimelineRenderState,
  sanitizeTerminalTranscriptChunk,
  type TerminalTimelineAnchor,
  type TerminalTimelineRenderState,
} from "../terminal-timeline";
import { fitTerminalViewport } from "../terminal-render";
import { shouldAutoClaimWriteAfterRestart } from "../terminal-write-ownership";
import MessageBlock from "./message-block";
import { AnsiText } from "./tool-renderers/ansi-text";

function generateClientId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    try {
      return crypto.randomUUID();
    } catch {
      // Not available in insecure contexts (HTTP on non-localhost).
    }
  }
  // Fallback using crypto.getRandomValues (available in all contexts).
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const TERMINAL_TIMELINE_STATE_CACHE_LIMIT = 50;
const terminalTimelineStateCache = new Map<
  string,
  TerminalTimelineRenderState
>();

function getTerminalTimelineStateCacheKey(
  terminalId: string,
  boundSessionId: string | null | undefined,
): string {
  return `${terminalId}\u0000${boundSessionId?.trim() ?? ""}`;
}

function rememberTerminalTimelineState(
  key: string,
  state: TerminalTimelineRenderState,
): void {
  terminalTimelineStateCache.delete(key);
  terminalTimelineStateCache.set(key, {
    output: state.output,
    anchors: { ...state.anchors },
    anchorOrder: state.anchorOrder,
  });

  while (
    terminalTimelineStateCache.size > TERMINAL_TIMELINE_STATE_CACHE_LIMIT
  ) {
    const oldestKey = terminalTimelineStateCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    terminalTimelineStateCache.delete(oldestKey);
  }
}

interface TerminalViewProps {
  terminalId: string;
  resolvedTheme: ResolvedTheme;
  boundSessionId?: string | null;
  embeddedMessages?: Array<{
    messageKey: string;
    message: ConversationMessage;
    isActionable: boolean;
    stepStates?: Record<string, AiTerminalStepState | undefined>;
  }>;
  embeddedMessagesLoading?: boolean;
  chatBusy?: boolean;
  onChatInSession?: () => void;
  onTerminalRestarted?: () => void;
  onFilePathLinkClick?: (href: string) => boolean;
  onApproveAiTerminalStep?: (input: {
    sessionId: string;
    terminalId: string;
    messageKey: string;
    step: AiTerminalStepDirective;
  }) => void;
  onRejectAiTerminalStep?: (input: {
    sessionId: string;
    terminalId: string;
    messageKey: string;
    step: AiTerminalStepDirective;
    reason: string;
  }) => void;
  onEmbeddedConversationMessages?: (
    sessionId: string,
    messages: ConversationMessage[],
    batch?: {
      messages: ConversationMessage[];
      phase: "bootstrap" | "incremental";
      nextOffset: number;
      done: boolean;
      insertion?: "append" | "prepend";
    },
  ) => void;
  onEmbeddedConversationHeartbeat?: () => void;
}

function getTerminalTheme(resolvedTheme: ResolvedTheme): {
  background: string;
  foreground: string;
  cursor: string;
} {
  if (resolvedTheme === "light") {
    return {
      background: "#f8fafc",
      foreground: "#1f2937",
      cursor: "#0f172a",
    };
  }

  return {
    background: "#09090b",
    foreground: "#e4e4e7",
    cursor: "#d4d4d8",
  };
}

function TerminalTranscriptOutput(props: { text: string }) {
  const sanitizedText = sanitizeTerminalTranscriptChunk(props.text);
  if (!sanitizedText.trim()) {
    return null;
  }

  return (
    <div className="shrink-0 rounded-xl border border-zinc-800/80 bg-black/35 px-3 py-2 shadow-[0_0_0_1px_rgba(24,24,27,0.35)]">
      <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-zinc-100">
        <AnsiText text={sanitizedText} />
      </pre>
    </div>
  );
}

function shouldFreezeTerminalTranscript(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }

  const lines = normalized
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return false;
  }

  if (lines.length > 1) {
    return true;
  }

  return !(
    /[#$%>»]$/.test(normalized) &&
    (normalized.includes("/") ||
      normalized.includes("~") ||
      normalized.startsWith("(") ||
      normalized.startsWith("["))
  );
}

function isTerminalCompletionMessage(message: ConversationMessage): boolean {
  const parsed = parseAiTerminalMessage(
    extractConversationMessageText(message),
  );
  return parsed?.directive.kind === "finished";
}

const TerminalView = memo(function TerminalView(props: TerminalViewProps) {
  const {
    terminalId,
    resolvedTheme,
    boundSessionId = null,
    embeddedMessages = [],
    embeddedMessagesLoading = false,
    chatBusy = false,
    onChatInSession,
    onTerminalRestarted,
    onFilePathLinkClick,
    onApproveAiTerminalStep,
    onRejectAiTerminalStep,
    onEmbeddedConversationMessages,
    onEmbeddedConversationHeartbeat,
  } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const streamCleanupRef = useRef<(() => void) | null>(null);
  const seqRef = useRef(0);
  const inputBufferRef = useRef("");
  const inputFlushPromiseRef = useRef<Promise<void> | null>(null);
  const isDisposedRef = useRef(false);
  const hasStartedRef = useRef(false);
  const clientIdRef = useRef(generateClientId());
  const writeOwnerIdRef = useRef<string | null>(null);
  const restartInFlightRef = useRef(false);
  const readOnlyWarningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const readOnlyWarningVisibleRef = useRef(false);
  const readOnlyWarningShownAtRef = useRef(0);
  const timelineViewportRef = useRef<HTMLDivElement | null>(null);
  const terminalOutputRef = useRef("");
  const timelineAnchorsRef = useRef<
    Record<string, TerminalTimelineAnchor | undefined>
  >({});
  const anchorOrderRef = useRef(0);
  const renderedLiveOutputRef = useRef("");
  const renderedContextKeyRef = useRef("");
  const restoredFrozenOutputsInOrderRef = useRef<string[]>([]);
  const persistedFrozenMessageKeysRef = useRef(new Set<string>());
  const persistingFrozenMessageKeysRef = useRef(new Set<string>());
  const persistedFrozenBeforeMessageKeysRef = useRef(new Set<string>());
  const persistingFrozenBeforeMessageKeysRef = useRef(new Set<string>());
  const persistedFrozenOutputByMessageKeyRef = useRef(new Map<string, string>());
  const persistedFrozenOutputByBeforeMessageKeyRef = useRef(
    new Map<string, string>(),
  );
  const [running, setRunning] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [writeOwnerId, setWriteOwnerId] = useState<string | null>(null);
  const [showReadOnlyWarning, setShowReadOnlyWarning] = useState(false);
  const [terminalOutput, setTerminalOutput] = useState("");
  const [timelineResetVersion, setTimelineResetVersion] = useState(0);
  const [timelineAnchors, setTimelineAnchors] = useState<
    Record<string, TerminalTimelineAnchor | undefined>
  >({});
  const [frozenOutputByMessageKey, setFrozenOutputByMessageKey] = useState<
    Record<string, string | undefined>
  >({});
  const [frozenOutputByBeforeMessageKey, setFrozenOutputByBeforeMessageKey] =
    useState<Record<string, string | undefined>>({});
  const [frozenOutputsLoaded, setFrozenOutputsLoaded] = useState(false);
  const terminalTheme = useMemo(
    () => getTerminalTheme(resolvedTheme),
    [resolvedTheme],
  );
  const timelineStateCacheKey = useMemo(
    () => getTerminalTimelineStateCacheKey(terminalId, boundSessionId),
    [boundSessionId, terminalId],
  );

  const isReadOnly =
    writeOwnerId !== null && writeOwnerId !== clientIdRef.current;

  const dismissReadOnlyWarning = useCallback(() => {
    readOnlyWarningVisibleRef.current = false;
    setShowReadOnlyWarning(false);
    if (readOnlyWarningTimerRef.current) {
      clearTimeout(readOnlyWarningTimerRef.current);
      readOnlyWarningTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    writeOwnerIdRef.current = writeOwnerId;
  }, [writeOwnerId]);

  useEffect(() => {
    terminalOutputRef.current = terminalOutput;
  }, [terminalOutput]);

  useEffect(() => {
    timelineAnchorsRef.current = timelineAnchors;
  }, [timelineAnchors]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    terminal.options.theme = terminalTheme;
  }, [terminalTheme]);

  useEffect(() => {
    if (!isReadOnly) {
      dismissReadOnlyWarning();
    }
  }, [isReadOnly, dismissReadOnlyWarning]);

  useEffect(() => {
    const normalizedSessionId = boundSessionId?.trim() ?? "";
    if (!normalizedSessionId) {
      restoredFrozenOutputsInOrderRef.current = [];
      persistedFrozenMessageKeysRef.current = new Set();
      persistingFrozenMessageKeysRef.current = new Set();
      persistedFrozenBeforeMessageKeysRef.current = new Set();
      persistingFrozenBeforeMessageKeysRef.current = new Set();
      persistedFrozenOutputByMessageKeyRef.current = new Map();
      persistedFrozenOutputByBeforeMessageKeyRef.current = new Map();
      setFrozenOutputByMessageKey({});
      setFrozenOutputByBeforeMessageKey({});
      setFrozenOutputsLoaded(true);
      return;
    }

    let cancelled = false;
    restoredFrozenOutputsInOrderRef.current = [];
    persistedFrozenMessageKeysRef.current = new Set();
    persistingFrozenMessageKeysRef.current = new Set();
    persistedFrozenBeforeMessageKeysRef.current = new Set();
    persistingFrozenBeforeMessageKeysRef.current = new Set();
    persistedFrozenOutputByMessageKeyRef.current = new Map();
    persistedFrozenOutputByBeforeMessageKeyRef.current = new Map();
    setFrozenOutputsLoaded(false);
    const timer = setTimeout(() => {
      void getTerminalFrozenBlocks(terminalId, normalizedSessionId)
        .then((response) => {
          if (cancelled) {
            return;
          }
          restoredFrozenOutputsInOrderRef.current =
            normalizeFrozenTerminalOutputsInOrder(
              response.frozenOutputsInOrder,
            );
          persistedFrozenMessageKeysRef.current = new Set(
            Object.keys(response.frozenOutputByMessageKey),
          );
          persistedFrozenBeforeMessageKeysRef.current = new Set(
            Object.keys(response.frozenOutputByBeforeMessageKey),
          );
          persistedFrozenOutputByMessageKeyRef.current = new Map(
            Object.entries(response.frozenOutputByMessageKey),
          );
          persistedFrozenOutputByBeforeMessageKeyRef.current = new Map(
            Object.entries(response.frozenOutputByBeforeMessageKey),
          );
          setFrozenOutputByMessageKey(response.frozenOutputByMessageKey);
          setFrozenOutputByBeforeMessageKey(
            response.frozenOutputByBeforeMessageKey,
          );
        })
        .catch(() => {
          if (cancelled) {
            return;
          }
          restoredFrozenOutputsInOrderRef.current = [];
          persistedFrozenMessageKeysRef.current = new Set();
          persistedFrozenBeforeMessageKeysRef.current = new Set();
          persistedFrozenOutputByMessageKeyRef.current = new Map();
          persistedFrozenOutputByBeforeMessageKeyRef.current = new Map();
          setFrozenOutputByMessageKey({});
          setFrozenOutputByBeforeMessageKey({});
        })
        .finally(() => {
          if (!cancelled) {
            setFrozenOutputsLoaded(true);
          }
        });
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      restoredFrozenOutputsInOrderRef.current = [];
    };
  }, [boundSessionId, terminalId]);

  useEffect(() => {
    if (!frozenOutputsLoaded) {
      return;
    }
    if (embeddedMessagesLoading && embeddedMessages.length === 0) {
      return;
    }

    const messageKeys = embeddedMessages.map((item) => item.messageKey);
    const visibleMessageKeys = new Set(messageKeys);
    const currentTerminalOutput = terminalOutputRef.current;

    setTimelineAnchors((current) => {
      let changed = false;
      const next: Record<string, TerminalTimelineAnchor | undefined> = {};

      for (const [messageKey, anchor] of Object.entries(current)) {
        if (visibleMessageKeys.has(messageKey)) {
          next[messageKey] = anchor;
        } else {
          changed = true;
        }
      }

      for (const item of embeddedMessages) {
        if (next[item.messageKey]) {
          continue;
        }
        next[item.messageKey] = {
          offset: getTerminalInlineAnchorOffset(terminalOutputRef.current),
          order: anchorOrderRef.current,
        };
        anchorOrderRef.current += 1;
        changed = true;
      }

      const resolved = changed ? next : current;
      timelineAnchorsRef.current = resolved;
      return resolved;
    });

    setFrozenOutputByMessageKey((current) => {
      let changed = false;
      const next: Record<string, string | undefined> = {};
      const completionItems = embeddedMessages.filter((item) =>
        isTerminalCompletionMessage(item.message),
      );
      const normalizedCurrentOutputs = normalizeFrozenTerminalOutputsInOrder(
        completionItems
          .map((item) => current[item.messageKey])
          .filter(
            (value): value is string => typeof value === "string" && !!value,
          ),
      );
      const normalizedCurrentByMessageKey = new Map<string, string>();
      let normalizedIndex = 0;
      for (const item of completionItems) {
        const currentOutput = current[item.messageKey];
        if (!currentOutput) {
          continue;
        }
        const normalizedOutput = normalizedCurrentOutputs[normalizedIndex];
        normalizedIndex += 1;
        if (normalizedOutput) {
          normalizedCurrentByMessageKey.set(item.messageKey, normalizedOutput);
        }
      }

      for (const [messageKey, output] of Object.entries(current)) {
        if (visibleMessageKeys.has(messageKey) && output) {
          next[messageKey] =
            normalizedCurrentByMessageKey.get(messageKey) ?? output;
          if (next[messageKey] !== output) {
            changed = true;
          }
        } else {
          changed = true;
        }
      }

      const firstMissingItem = embeddedMessages.find(
        (item) =>
          !timelineAnchors[item.messageKey] &&
          isTerminalCompletionMessage(item.message),
      );
      if (firstMissingItem && !next[firstMissingItem.messageKey]) {
        const frozenSnapshot = getFrozenTerminalTranscript({
          output: currentTerminalOutput,
          messageKeys,
          anchors: timelineAnchors,
          messageKey: firstMissingItem.messageKey,
        });
        if (shouldFreezeTerminalTranscript(frozenSnapshot)) {
          next[firstMissingItem.messageKey] = frozenSnapshot;
          changed = true;
        }
      }

      const restoredOutputs = restoredFrozenOutputsInOrderRef.current;
      if (restoredOutputs.length > 0) {
        let completionIndex = 0;
        for (const item of completionItems) {
          if (!next[item.messageKey]) {
            const restoredOutput = restoredOutputs[completionIndex];
            if (restoredOutput) {
              next[item.messageKey] = restoredOutput;
              changed = true;
            }
          }
          completionIndex += 1;
        }
      }

      return changed ? next : current;
    });

    setFrozenOutputByBeforeMessageKey((current) => {
      let changed = false;
      const next: Record<string, string | undefined> = {};

      for (const [messageKey, output] of Object.entries(current)) {
        if (visibleMessageKeys.has(messageKey) && output) {
          next[messageKey] = output;
        } else {
          changed = true;
        }
      }

      for (const item of embeddedMessages) {
        if (next[item.messageKey]) {
          continue;
        }
        if (isTerminalCompletionMessage(item.message)) {
          continue;
        }
        if (frozenOutputByMessageKey[item.messageKey]) {
          continue;
        }
        if (!timelineAnchors[item.messageKey]) {
          continue;
        }

        const frozenSnapshot = getFrozenTerminalTranscript({
          output: currentTerminalOutput,
          messageKeys,
          anchors: timelineAnchors,
          messageKey: item.messageKey,
        });
        if (shouldFreezeTerminalTranscript(frozenSnapshot)) {
          next[item.messageKey] = frozenSnapshot;
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [
    embeddedMessages,
    embeddedMessagesLoading,
    frozenOutputByMessageKey,
    frozenOutputsLoaded,
    timelineAnchors,
    timelineResetVersion,
  ]);

  useEffect(() => {
    const normalizedSessionId = boundSessionId?.trim() ?? "";
    if (!frozenOutputsLoaded || !normalizedSessionId) {
      return;
    }

    const completionItems = embeddedMessages.filter((item) =>
      isTerminalCompletionMessage(item.message),
    );
    for (const item of completionItems) {
      const transcript = frozenOutputByMessageKey[item.messageKey];
      if (!transcript) {
        continue;
      }
      if (persistedFrozenMessageKeysRef.current.has(item.messageKey)) {
        const persistedTranscript =
          persistedFrozenOutputByMessageKeyRef.current.get(item.messageKey);
        if (persistedTranscript === transcript) {
          continue;
        }
      }
      if (
        persistedFrozenOutputByMessageKeyRef.current.get(item.messageKey) ===
        transcript
      ) {
        continue;
      }
      if (persistingFrozenMessageKeysRef.current.has(item.messageKey)) {
        continue;
      }

      persistingFrozenMessageKeysRef.current.add(item.messageKey);
      void persistTerminalFrozenBlock(terminalId, {
        sessionId: normalizedSessionId,
        messageKey: item.messageKey,
        transcript,
      })
        .then(() => {
          persistedFrozenMessageKeysRef.current.add(item.messageKey);
          persistedFrozenOutputByMessageKeyRef.current.set(
            item.messageKey,
            transcript,
          );
        })
        .catch(() => {
          persistingFrozenMessageKeysRef.current.delete(item.messageKey);
        })
        .finally(() => {
          persistingFrozenMessageKeysRef.current.delete(item.messageKey);
        });
    }
  }, [
    boundSessionId,
    embeddedMessages,
    frozenOutputByMessageKey,
    frozenOutputsLoaded,
    terminalId,
  ]);

  useEffect(() => {
    const normalizedSessionId = boundSessionId?.trim() ?? "";
    if (!frozenOutputsLoaded || !normalizedSessionId) {
      return;
    }

    for (const item of embeddedMessages) {
      const transcript = frozenOutputByBeforeMessageKey[item.messageKey];
      if (!transcript) {
        continue;
      }
      if (persistedFrozenBeforeMessageKeysRef.current.has(item.messageKey)) {
        const persistedTranscript =
          persistedFrozenOutputByBeforeMessageKeyRef.current.get(
            item.messageKey,
          );
        if (persistedTranscript === transcript) {
          continue;
        }
      }
      if (
        persistedFrozenOutputByBeforeMessageKeyRef.current.get(item.messageKey) ===
        transcript
      ) {
        continue;
      }
      if (persistingFrozenBeforeMessageKeysRef.current.has(item.messageKey)) {
        continue;
      }

      persistingFrozenBeforeMessageKeysRef.current.add(item.messageKey);
      void persistTerminalFrozenBlock(terminalId, {
        sessionId: normalizedSessionId,
        beforeMessageKey: item.messageKey,
        transcript,
      })
        .then(() => {
          persistedFrozenBeforeMessageKeysRef.current.add(item.messageKey);
          persistedFrozenOutputByBeforeMessageKeyRef.current.set(
            item.messageKey,
            transcript,
          );
        })
        .catch(() => {
          persistingFrozenBeforeMessageKeysRef.current.delete(item.messageKey);
        })
        .finally(() => {
          persistingFrozenBeforeMessageKeysRef.current.delete(item.messageKey);
        });
    }
  }, [
    boundSessionId,
    embeddedMessages,
    frozenOutputByBeforeMessageKey,
    frozenOutputsLoaded,
    terminalId,
  ]);

  const applyFullSnapshot = useCallback(
    (snapshot: TerminalSnapshotResponse) => {
      const restoredTimelineState = restoreTerminalTimelineRenderState({
        cachedState: terminalTimelineStateCache.get(timelineStateCacheKey),
        output: snapshot.output,
      });
      const nextAnchors = restoredTimelineState?.anchors ?? {};
      const nextAnchorOrder = restoredTimelineState?.anchorOrder ?? 0;

      anchorOrderRef.current = nextAnchorOrder;
      timelineAnchorsRef.current = nextAnchors;
      terminalOutputRef.current = snapshot.output;
      renderedLiveOutputRef.current = "";
      renderedContextKeyRef.current = "";
      setTimelineAnchors(nextAnchors);
      setTerminalOutput(snapshot.output);
      setTimelineResetVersion((current) => current + 1);
      setRunning(snapshot.running);
      seqRef.current = snapshot.seq;
      writeOwnerIdRef.current = snapshot.writeOwnerId;
      setWriteOwnerId(snapshot.writeOwnerId);
    },
    [timelineStateCacheKey],
  );

  const sendResize = useCallback(async () => {
    if (!hasStartedRef.current) {
      return;
    }

    if (restartInFlightRef.current) {
      return;
    }

    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    if (writeOwnerIdRef.current !== clientIdRef.current) {
      return;
    }

    try {
      await resizeTerminal(
        terminalId,
        {
          cols: terminal.cols,
          rows: terminal.rows,
        },
        clientIdRef.current,
      );
    } catch (resizeError) {
      setError(
        resizeError instanceof Error
          ? resizeError.message
          : String(resizeError),
      );
    }
  }, [terminalId]);

  const flushInputBuffer = useCallback(async () => {
    if (inputFlushPromiseRef.current) {
      return inputFlushPromiseRef.current;
    }

    inputFlushPromiseRef.current = (async () => {
      while (inputBufferRef.current.length > 0 && !isDisposedRef.current) {
        const chunk = inputBufferRef.current;
        inputBufferRef.current = "";

        try {
          await sendTerminalInput(
            terminalId,
            { input: chunk },
            clientIdRef.current,
          );
        } catch (sendError) {
          setError(
            sendError instanceof Error ? sendError.message : String(sendError),
          );
          inputBufferRef.current = `${chunk}${inputBufferRef.current}`;
          break;
        }
      }
    })().finally(() => {
      inputFlushPromiseRef.current = null;
    });

    return inputFlushPromiseRef.current;
  }, [terminalId]);

  const queueInput = useCallback(
    (chunk: string) => {
      if (!chunk || isDisposedRef.current) {
        return;
      }

      if (
        writeOwnerIdRef.current !== null &&
        writeOwnerIdRef.current !== clientIdRef.current
      ) {
        // Read-only: show or dismiss warning
        if (readOnlyWarningVisibleRef.current) {
          // Dismiss if shown for at least 500ms (prevents flicker from fast typing)
          if (Date.now() - readOnlyWarningShownAtRef.current > 500) {
            dismissReadOnlyWarning();
          }
        } else {
          // Show warning with 3-second auto-dismiss
          readOnlyWarningVisibleRef.current = true;
          readOnlyWarningShownAtRef.current = Date.now();
          setShowReadOnlyWarning(true);
          if (readOnlyWarningTimerRef.current) {
            clearTimeout(readOnlyWarningTimerRef.current);
          }
          readOnlyWarningTimerRef.current = setTimeout(() => {
            readOnlyWarningVisibleRef.current = false;
            setShowReadOnlyWarning(false);
          }, 3000);
        }
        return;
      }

      inputBufferRef.current += chunk;
      void flushInputBuffer();
    },
    [flushInputBuffer, dismissReadOnlyWarning],
  );

  const closeStream = useCallback(() => {
    if (streamCleanupRef.current) {
      streamCleanupRef.current();
      streamCleanupRef.current = null;
    }
  }, []);

  const fitTerminal = useCallback(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    const container = containerRef.current;
    if (!terminal || !fitAddon || !container) {
      return { didFit: false, sizeChanged: false };
    }

    return fitTerminalViewport({
      container,
      fitAddon,
      terminal,
      replayOutput: renderedLiveOutputRef.current,
    });
  }, []);

  const applyStreamEvent = useCallback(
    (event: {
      seq: number;
      type: "output" | "state" | "reset" | "ownership";
      chunk?: string;
      running?: boolean;
      output?: string;
      writeOwnerId?: string | null;
    }) => {
      setConnected(true);
      setError(null);

      if (!event || typeof event !== "object" || event.seq <= seqRef.current) {
        return;
      }

      if (event.type === "output") {
        if (typeof event.chunk === "string" && event.chunk.length > 0) {
          setTerminalOutput((current) => {
            const next = `${current}${event.chunk ?? ""}`;
            terminalOutputRef.current = next;
            return next;
          });
        }
      } else if (event.type === "state") {
        setRunning(event.running === true);
      } else if (event.type === "reset") {
        anchorOrderRef.current = 0;
        timelineAnchorsRef.current = {};
        terminalOutputRef.current =
          typeof event.output === "string" ? event.output : "";
        renderedLiveOutputRef.current = "";
        renderedContextKeyRef.current = "";
        setTimelineAnchors({});
        setTerminalOutput(terminalOutputRef.current);
        setTimelineResetVersion((current) => current + 1);
        setRunning(event.running === true);
      } else if (event.type === "ownership") {
        writeOwnerIdRef.current = event.writeOwnerId ?? null;
        setWriteOwnerId(event.writeOwnerId ?? null);
      }

      seqRef.current = event.seq;
    },
    [],
  );

  const connectStream = useCallback(
    (fromSeq: number) => {
      if (isDisposedRef.current) {
        return;
      }

      closeStream();
      streamCleanupRef.current = subscribeTerminalStream(
        {
          onEvent: (event) => {
            applyStreamEvent(event);
          },
          onConversationMessages: (messages, batch) => {
            if (!boundSessionId) {
              return;
            }
            onEmbeddedConversationMessages?.(boundSessionId, messages, batch);
          },
          onConversationHeartbeat: () => {
            onEmbeddedConversationHeartbeat?.();
          },
          onError: () => {
            setConnected(false);
          },
        },
        {
          fromSeq,
          terminalId,
          clientId: clientIdRef.current,
          conversationSessionId: boundSessionId,
          conversationInitialOffset: 0,
        },
      );
      setConnected(true);
    },
    [
      applyStreamEvent,
      boundSessionId,
      closeStream,
      onEmbeddedConversationHeartbeat,
      onEmbeddedConversationMessages,
      terminalId,
    ],
  );

  const bootstrap = useCallback(async () => {
    setError(null);

    try {
      const snapshot = await getTerminalSnapshot(terminalId);
      if (isDisposedRef.current) {
        return;
      }

      hasStartedRef.current = true;
      applyFullSnapshot(snapshot);
      connectStream(snapshot.seq);

      fitTerminal();

      if (snapshot.writeOwnerId === null) {
        const claim = await claimTerminalWrite(terminalId, clientIdRef.current);
        writeOwnerIdRef.current = claim.writeOwnerId;
        setWriteOwnerId(claim.writeOwnerId);
        await sendResize();
        return;
      }

      if (snapshot.writeOwnerId === clientIdRef.current) {
        await sendResize();
      }
    } catch (bootstrapError) {
      if (isDisposedRef.current) {
        return;
      }
      setError(
        bootstrapError instanceof Error
          ? bootstrapError.message
          : String(bootstrapError),
      );
      setConnected(false);
    }
  }, [applyFullSnapshot, connectStream, fitTerminal, sendResize, terminalId]);

  useEffect(() => {
    isDisposedRef.current = false;

    const terminal = new Terminal({
      convertEol: false,
      scrollback: 10000,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: TERMINAL_FONT_FAMILY,
      theme: terminalTheme,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const container = containerRef.current;

    const disposable = terminal.onData((chunk) => {
      queueInput(chunk);
    });

    if (container && typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => {
        const fitResult = fitTerminal();
        if (fitResult.didFit) {
          void sendResize();
        }
      });
      observer.observe(container);
      resizeObserverRef.current = observer;
    }

    // Open inside requestAnimationFrame to ensure the browser has completed
    // layout so that xterm.js character measurement returns valid dimensions.
    const retryTimers: ReturnType<typeof setTimeout>[] = [];
    const rafId = requestAnimationFrame(() => {
      if (isDisposedRef.current || !container) {
        return;
      }

      terminal.open(container);
      fitTerminal();

      // Schedule retry fits for cases where the first measurement isn't stable.
      for (const delay of [100, 500]) {
        retryTimers.push(
          setTimeout(() => {
            if (!isDisposedRef.current) {
              const fitResult = fitTerminal();
              if (fitResult.didFit) {
                void sendResize();
              }
            }
          }, delay),
        );
      }

      void bootstrap();
    });

    const capturedClientId = clientIdRef.current;
    return () => {
      rememberTerminalTimelineState(timelineStateCacheKey, {
        output: terminalOutputRef.current,
        anchors: timelineAnchorsRef.current,
        anchorOrder: anchorOrderRef.current,
      });
      isDisposedRef.current = true;
      cancelAnimationFrame(rafId);
      for (const timer of retryTimers) {
        clearTimeout(timer);
      }
      closeStream();
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      disposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      terminalOutputRef.current = "";
      renderedLiveOutputRef.current = "";
      renderedContextKeyRef.current = "";
      timelineAnchorsRef.current = {};
      anchorOrderRef.current = 0;
      setTerminalOutput("");
      setTimelineAnchors({});
      setTimelineResetVersion(0);
      setConnected(false);
      setRunning(false);
      setError(null);
      setWriteOwnerId(null);
      if (readOnlyWarningTimerRef.current) {
        clearTimeout(readOnlyWarningTimerRef.current);
      }
      void releaseTerminalWrite(terminalId, capturedClientId).catch(() => {});
    };
  }, [
    bootstrap,
    closeStream,
    fitTerminal,
    queueInput,
    sendResize,
    terminalId,
    terminalTheme,
    timelineStateCacheKey,
  ]);

  const embeddedMessagesByKey = useMemo(
    () =>
      new Map(embeddedMessages.map((item) => [item.messageKey, item] as const)),
    [embeddedMessages],
  );
  const terminalTimeline = useMemo(
    () =>
      buildTerminalTimeline({
        output: terminalOutput,
        messageKeys: embeddedMessages.map((item) => item.messageKey),
        anchors: timelineAnchors,
        frozenOutputByMessageKey,
        frozenOutputByBeforeMessageKey,
      }),
    [
      embeddedMessages,
      frozenOutputByBeforeMessageKey,
      frozenOutputByMessageKey,
      terminalOutput,
      timelineAnchors,
    ],
  );
  const hasEmbeddedTimelineEntries = terminalTimeline.entries.length > 0;
  const hasLiveTerminalOutput = terminalTimeline.liveOutput.trim().length > 0;
  const shouldShowActivateTerminalCta =
    !running && !hasLiveTerminalOutput && !embeddedMessagesLoading;
  const liveTerminalContextKey = useMemo(
    () =>
      [
        timelineResetVersion,
        ...embeddedMessages.map((item) => {
          const anchor = timelineAnchors[item.messageKey];
          return `${item.messageKey}:${anchor?.offset ?? -1}:${anchor?.order ?? -1}`;
        }),
      ].join("|"),
    [embeddedMessages, timelineAnchors, timelineResetVersion],
  );

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    const nextOutput = terminalTimeline.liveOutput;
    if (
      renderedContextKeyRef.current !== liveTerminalContextKey ||
      !nextOutput.startsWith(renderedLiveOutputRef.current)
    ) {
      terminal.reset();
      if (nextOutput.length > 0) {
        terminal.write(nextOutput);
      }
      renderedLiveOutputRef.current = nextOutput;
      renderedContextKeyRef.current = liveTerminalContextKey;
      return;
    }

    if (nextOutput.length > renderedLiveOutputRef.current.length) {
      terminal.write(nextOutput.slice(renderedLiveOutputRef.current.length));
    }
    renderedLiveOutputRef.current = nextOutput;
    renderedContextKeyRef.current = liveTerminalContextKey;
  }, [liveTerminalContextKey, terminalTimeline.liveOutput]);

  useEffect(() => {
    if (!hasEmbeddedTimelineEntries) {
      return;
    }
    const viewport = timelineViewportRef.current;
    if (!viewport) {
      return;
    }
    viewport.scrollTop = viewport.scrollHeight;
  }, [
    hasEmbeddedTimelineEntries,
    terminalOutput,
    terminalTimeline.entries.length,
    terminalTimeline.liveOutput,
  ]);

  const statusText = useMemo(() => {
    if (!connected) {
      return "Disconnected";
    }
    return running ? "Running" : "Stopped";
  }, [connected, running]);

  const handleRestart = useCallback(() => {
    void (async () => {
      const previousWriteOwnerId = writeOwnerIdRef.current;
      const shouldClaimWrite = shouldAutoClaimWriteAfterRestart(
        previousWriteOwnerId,
        clientIdRef.current,
      );

      restartInFlightRef.current = true;
      try {
        const snapshot = await restartTerminal(terminalId, clientIdRef.current);
        if (isDisposedRef.current) {
          return;
        }

        applyFullSnapshot(snapshot);
        let nextWriteOwnerId = snapshot.writeOwnerId;

        if (shouldClaimWrite && nextWriteOwnerId === null) {
          const claim = await claimTerminalWrite(
            terminalId,
            clientIdRef.current,
          );
          if (isDisposedRef.current) {
            return;
          }
          nextWriteOwnerId = claim.writeOwnerId;
          writeOwnerIdRef.current = claim.writeOwnerId;
          setWriteOwnerId(claim.writeOwnerId);
        }

        restartInFlightRef.current = false;
        fitTerminal();
        if (nextWriteOwnerId === clientIdRef.current) {
          await sendResize();
        }
        onTerminalRestarted?.();
      } catch (reconnectError) {
        setError(
          reconnectError instanceof Error
            ? reconnectError.message
            : String(reconnectError),
        );
      } finally {
        restartInFlightRef.current = false;
      }
    })();
  }, [
    applyFullSnapshot,
    fitTerminal,
    onTerminalRestarted,
    sendResize,
    terminalId,
  ]);

  const handleTakeOver = useCallback(() => {
    void (async () => {
      try {
        const claim = await claimTerminalWrite(terminalId, clientIdRef.current);
        writeOwnerIdRef.current = claim.writeOwnerId;
        setWriteOwnerId(claim.writeOwnerId);
        fitTerminal();
        await sendResize();
      } catch (claimError) {
        setError(
          claimError instanceof Error ? claimError.message : String(claimError),
        );
      }
    })();
  }, [fitTerminal, sendResize, terminalId]);

  return (
    <div className="h-full flex flex-col bg-zinc-950">
      <div className="h-10 border-b border-zinc-800/60 px-3 flex items-center gap-2 text-xs">
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${
            connected
              ? running
                ? "bg-emerald-400"
                : "bg-zinc-400"
              : "bg-red-400"
          }`}
          aria-label={`Terminal status: ${statusText}`}
          title={statusText}
        />
        <button
          type="button"
          onClick={handleRestart}
          className="h-6 w-6 shrink-0 rounded border border-zinc-700 bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800/80 transition-colors"
          aria-label="Restart terminal"
          title="Restart terminal"
        >
          <RefreshCw className="h-3.5 w-3.5 mx-auto" />
        </button>
        {isReadOnly && (
          <>
            <span className="text-amber-300/80 truncate">
              Read-only — another client has write permission
            </span>
            <button
              type="button"
              onClick={handleTakeOver}
              className="h-7 rounded border border-amber-600/60 bg-amber-700/20 px-2.5 text-amber-200 transition-colors hover:bg-amber-700/40"
            >
              Take Over
            </button>
          </>
        )}
        {error && (
          <span className="ml-auto text-red-300 truncate" title={error}>
            {error}
          </span>
        )}
        {!error ? <div className="ml-auto" /> : null}
        <button
          type="button"
          onClick={onChatInSession}
          disabled={!onChatInSession || chatBusy}
          className="inline-flex h-7 items-center gap-1.5 rounded border border-cyan-600/70 bg-cyan-600/20 px-2.5 text-[11px] text-cyan-100 transition-colors hover:bg-cyan-600/30 disabled:cursor-not-allowed disabled:opacity-55"
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
          Chat in session
        </button>
      </div>
      <div className="flex-1 min-h-0 relative overflow-hidden">
        <div ref={timelineViewportRef} className="h-full overflow-y-auto">
          <div
            className={`flex min-h-full flex-col ${
              hasEmbeddedTimelineEntries ? "gap-3 px-2 py-1" : "px-2 py-1"
            }`}
          >
            {hasEmbeddedTimelineEntries ? (
              <div className="flex items-center gap-2 px-1 pt-1 text-[11px] text-zinc-500">
                <Bot className="h-3.5 w-3.5 shrink-0 text-cyan-300/80" />
                <span className="truncate">
                  {boundSessionId
                    ? `Terminal chat cards inline from session ${boundSessionId}`
                    : "Terminal chat cards inline"}
                </span>
              </div>
            ) : null}
            {embeddedMessagesLoading && !hasEmbeddedTimelineEntries ? (
              <div className="shrink-0 px-1 text-[11px] text-zinc-500">
                Loading bound session replies...
              </div>
            ) : null}
            {terminalTimeline.entries.map((entry) => {
              if (entry.type === "output") {
                return (
                  <TerminalTranscriptOutput key={entry.key} text={entry.text} />
                );
              }

              const item = embeddedMessagesByKey.get(entry.messageKey);
              if (!item) {
                return null;
              }

              return (
                <div
                  key={entry.key}
                  className="shrink-0 rounded-xl border border-zinc-800/80 bg-zinc-900/55 p-2"
                >
                  <MessageBlock
                    message={item.message}
                    aiTerminalContext={
                      boundSessionId
                        ? {
                            sessionId: boundSessionId,
                            terminalId,
                            messageKey: item.messageKey,
                            isActionable: item.isActionable,
                            stepStates: item.stepStates,
                            onApproveStep: onApproveAiTerminalStep,
                            onRejectStep: onRejectAiTerminalStep,
                          }
                        : undefined
                    }
                    onFilePathLinkClick={onFilePathLinkClick}
                  />
                </div>
              );
            })}
            <div
              className={
                hasEmbeddedTimelineEntries
                  ? "shrink-0 overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-950 shadow-[0_0_0_1px_rgba(24,24,27,0.4)]"
                  : "min-h-full flex-1 overflow-hidden"
              }
            >
              <div
                ref={containerRef}
                className={
                  hasEmbeddedTimelineEntries
                    ? "h-[16rem] w-full px-2 py-1"
                    : "h-full w-full"
                }
              />
            </div>
          </div>
        </div>
        {showReadOnlyWarning && (
          <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
            <div className="rounded-lg border border-zinc-600/50 bg-zinc-800/90 px-5 py-3 text-sm text-zinc-200 shadow-lg">
              Read-only mode — press{" "}
              <strong className="text-amber-300">Take Over</strong> to type
            </div>
          </div>
        )}
        {shouldShowActivateTerminalCta && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center px-6">
            <div className="pointer-events-auto w-full max-w-lg rounded-[28px] border border-zinc-800 bg-zinc-950 px-8 py-9 text-center shadow-[0_30px_80px_-52px_rgba(0,0,0,0.95)]">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-zinc-700 bg-zinc-900 text-cyan-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                <RefreshCw className="h-6 w-6" />
              </div>
              <div className="mt-5 text-lg font-semibold tracking-tight text-zinc-100">
                Activate terminal emulator
              </div>
              <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-zinc-400">
                This terminal is inactive. Restart it to bring back live input
                and output in this pane.
              </p>
              <button
                type="button"
                onClick={handleRestart}
                className="mt-6 inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-cyan-500/35 bg-cyan-500/10 px-5 text-sm font-medium text-cyan-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-colors hover:border-cyan-400/55 hover:bg-cyan-500/16 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
                aria-label="Activate terminal emulator"
                title="Activate terminal emulator"
              >
                <RefreshCw className="h-4 w-4" />
                Activate terminal
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

export default TerminalView;

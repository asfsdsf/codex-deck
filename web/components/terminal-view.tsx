import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  AArrowDown,
  AArrowUp,
  Bot,
  Keyboard,
  MessageSquarePlus,
  RefreshCw,
} from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import type {
  ConversationMessage,
  TerminalSessionArtifactsResponse,
  TerminalTimelineEntry,
  TerminalSnapshotResponse,
} from "@codex-deck/api";
import {
  claimTerminalWrite,
  releaseTerminalWrite,
  restartTerminal,
  resizeTerminal,
} from "../api";
import { TERMINAL_FONT_FAMILY } from "../terminal-font";
import {
  connectTerminalSession,
  createBufferedTerminalInputController,
  createTerminalClientId,
  type TerminalIncrementalStreamEvent,
} from "../terminal-session-client";
import {
  bindTerminalInputHandlers,
  type TerminalInputQueueOptions,
} from "../terminal-user-input";
import type { ResolvedTheme } from "../theme";
import {
  deriveAiTerminalStepStatesByArtifactMessageKey,
  type AiTerminalStepDirective,
  type AiTerminalStepState,
} from "../ai-terminal";
import { fitTerminalViewport, isUsableTerminalSize } from "../terminal-render";
import { getTerminalTheme } from "../terminal-theme";
import { shouldAutoClaimWriteAfterRestart } from "../terminal-write-ownership";
import { createTerminalOutputWriter } from "../terminal-output-writer";
import {
  findTerminalBufferLinks,
  isOpenableTerminalUrl,
} from "../terminal-links";
import {
  TERMINAL_EXTRA_KEYS,
  applyTerminalCtrlModifier,
  getTerminalExtraKeySequence,
  type TerminalExtraKeyId,
} from "../terminal-extra-keys";
import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  clampTerminalFontSize,
  readStoredTerminalFontSize,
  writeStoredTerminalFontSize,
} from "../terminal-preferences";
import MessageBlock from "./message-block";
import { TerminalSnapshotBlock } from "./terminal-snapshot-block";

// Resizes arrive in bursts while a pane is dragged; fitting redraws the whole
// retained output, so wait for the burst to settle.
const RESIZE_DEBOUNCE_MS = 60;

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
  onFilePathLinkClick?: (href: string) => boolean;
  onApproveAiTerminalStep?: (input: {
    sessionId: string;
    terminalId: string;
    messageKey: string;
    clientId?: string;
    bracketedPasteMode?: boolean | null;
    step: AiTerminalStepDirective;
  }) => Promise<boolean>;
  onRejectAiTerminalStep?: (input: {
    sessionId: string;
    terminalId: string;
    messageKey: string;
    step: AiTerminalStepDirective;
    reason: string;
  }) => Promise<boolean>;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDocumentVisible(): boolean {
  return (
    typeof document === "undefined" || document.visibilityState !== "hidden"
  );
}

function isApplePlatform(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/u.test(navigator.userAgent)
  );
}

function detectCoarsePointer(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}

function openTerminalUrl(url: string): void {
  if (!isOpenableTerminalUrl(url)) {
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

async function copyTextToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // The async clipboard API needs a secure context; fall back below.
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand("copy");
  } finally {
    textarea.remove();
  }
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
    onFilePathLinkClick,
    onApproveAiTerminalStep,
    onRejectAiTerminalStep,
  } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const streamCleanupRef = useRef<(() => void) | null>(null);
  const seqRef = useRef(0);
  const isDisposedRef = useRef(false);
  const hasBootstrappedRef = useRef(false);
  const clientIdRef = useRef(createTerminalClientId());
  const writeOwnerIdRef = useRef<string | null>(null);
  const restartInFlightRef = useRef(false);
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const fitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ctrlArmedRef = useRef(false);
  const readOnlyWarningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const readOnlyWarningVisibleRef = useRef(false);
  const readOnlyWarningShownAtRef = useRef(0);
  const timelineViewportRef = useRef<HTMLDivElement | null>(null);
  const [running, setRunning] = useState(false);
  const [connected, setConnected] = useState(false);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [writeOwnerId, setWriteOwnerId] = useState<string | null>(null);
  const [showReadOnlyWarning, setShowReadOnlyWarning] = useState(false);
  const [hasVisibleOutput, setHasVisibleOutput] = useState(false);
  const [fontSize, setFontSize] = useState(() => readStoredTerminalFontSize());
  const [isCoarsePointer, setIsCoarsePointer] = useState(detectCoarsePointer);
  const [extraKeysHidden, setExtraKeysHidden] = useState(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [timelineEntries, setTimelineEntries] = useState<
    TerminalTimelineEntry[]
  >([]);
  const [artifactStepStatesByMessageKey, setArtifactStepStatesByMessageKey] =
    useState<Record<string, Record<string, AiTerminalStepState | undefined>>>(
      {},
    );
  const terminalTheme = useMemo(
    () => getTerminalTheme(resolvedTheme),
    [resolvedTheme],
  );
  // Read when the xterm instance is created; later changes are applied to the
  // live instance so a theme or font change never rebuilds the terminal.
  const terminalThemeRef = useRef(terminalTheme);
  terminalThemeRef.current = terminalTheme;
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;

  // Set once fitAndSyncSize exists; redraws finish asynchronously.
  const fitAndSyncSizeRef = useRef<() => void>(() => undefined);
  const [outputWriter] = useState(() =>
    createTerminalOutputWriter({
      getSink: () => terminalRef.current,
      onVisibleOutputChange: setHasVisibleOutput,
      // A redraw may have switched the grid to the PTY's size; fit it back to
      // this screen (xterm reflows the history) and sync the PTY if we own it.
      onRedrawComplete: () => {
        fitAndSyncSizeRef.current();
      },
    }),
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

  const clearArtifactTimelineState = useCallback(() => {
    setTimelineEntries([]);
    setArtifactStepStatesByMessageKey({});
  }, []);

  const handleReadOnlyAttempt = useCallback(() => {
    if (readOnlyWarningVisibleRef.current) {
      if (Date.now() - readOnlyWarningShownAtRef.current > 500) {
        dismissReadOnlyWarning();
      }
      return;
    }

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
  }, [dismissReadOnlyWarning]);

  const terminalInputController = useMemo(
    () =>
      createBufferedTerminalInputController({
        terminalId,
        clientId: clientIdRef.current,
        isDisposed: () => isDisposedRef.current,
        getWriteOwnerId: () => writeOwnerIdRef.current,
        setError: (message) => {
          setError(message);
        },
        onReadOnlyAttempt: handleReadOnlyAttempt,
      }),
    [handleReadOnlyAttempt, terminalId],
  );

  const setCtrlArmedState = useCallback((armed: boolean) => {
    ctrlArmedRef.current = armed;
    setCtrlArmed(armed);
  }, []);

  // Every byte headed for the shell goes through here, so the sticky Ctrl key
  // from the touch key row also applies to the on-screen keyboard.
  const queueTerminalData = useCallback(
    (
      data: string,
      options: TerminalInputQueueOptions = { userInitiated: true },
    ) => {
      let nextData = data;
      if (options.userInitiated && ctrlArmedRef.current) {
        nextData = applyTerminalCtrlModifier(data);
        setCtrlArmedState(false);
      }
      terminalInputController.queueInput(nextData, options);
    },
    [setCtrlArmedState, terminalInputController],
  );

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
    if (!(boundSessionId?.trim() ?? "")) {
      clearArtifactTimelineState();
    }
  }, [boundSessionId, clearArtifactTimelineState]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return;
    }
    const query = window.matchMedia("(pointer: coarse)");
    const handleChange = () => {
      setIsCoarsePointer(query.matches);
    };
    query.addEventListener?.("change", handleChange);
    return () => {
      query.removeEventListener?.("change", handleChange);
    };
  }, []);

  const sendResize = useCallback(
    async (force = false) => {
      if (
        !hasBootstrappedRef.current ||
        restartInFlightRef.current ||
        isDisposedRef.current
      ) {
        return;
      }

      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }

      // Only the write owner sizes the PTY; other clients render whatever
      // size the owner picked.
      if (writeOwnerIdRef.current !== clientIdRef.current) {
        return;
      }

      // Ask for the size this screen fits rather than the grid's current
      // size, which is temporarily the PTY's own while a snapshot is redrawn.
      const container = containerRef.current;
      if (
        !container ||
        container.clientWidth <= 0 ||
        container.clientHeight <= 0
      ) {
        return;
      }
      const proposed = fitAddonRef.current?.proposeDimensions();
      const size = proposed
        ? { cols: proposed.cols, rows: proposed.rows }
        : { cols: terminal.cols, rows: terminal.rows };
      if (!isUsableTerminalSize(size)) {
        return;
      }
      const lastSize = lastSentSizeRef.current;
      if (
        !force &&
        lastSize &&
        lastSize.cols === size.cols &&
        lastSize.rows === size.rows
      ) {
        return;
      }
      lastSentSizeRef.current = size;

      try {
        await resizeTerminal(terminalId, size, clientIdRef.current);
      } catch (resizeError) {
        lastSentSizeRef.current = null;
        if (!isDisposedRef.current) {
          setError(getErrorMessage(resizeError));
        }
      }
    },
    [terminalId],
  );

  const applyWriteOwner = useCallback(
    (nextWriteOwnerId: string | null) => {
      const previousWriteOwnerId = writeOwnerIdRef.current;
      writeOwnerIdRef.current = nextWriteOwnerId;
      setWriteOwnerId(nextWriteOwnerId);
      // Whoever just gained write (claim, take over, or the server claiming
      // on first input) pushes its size so the PTY matches its screen.
      if (
        nextWriteOwnerId === clientIdRef.current &&
        previousWriteOwnerId !== clientIdRef.current
      ) {
        void sendResize(true);
      }
    },
    [sendResize],
  );

  const applyFullSnapshot = useCallback(
    (
      snapshot: TerminalSnapshotResponse,
      options: { authoritative: boolean },
    ) => {
      // A snapshot from an HTTP response can be older than events the stream
      // already delivered; the stream is newer, so keep it.
      if (!options.authoritative && snapshot.seq < seqRef.current) {
        return;
      }
      outputWriter.replace(snapshot.output, {
        cols: snapshot.cols,
        rows: snapshot.rows,
      });
      setRunning(snapshot.running);
      seqRef.current = snapshot.seq;
      applyWriteOwner(snapshot.writeOwnerId);
    },
    [applyWriteOwner, outputWriter],
  );

  const applyArtifacts = useCallback(
    (artifacts: TerminalSessionArtifactsResponse | null | undefined) => {
      setTimelineEntries(artifacts?.timelineEntries ?? []);
      setArtifactStepStatesByMessageKey(
        deriveAiTerminalStepStatesByArtifactMessageKey(artifacts?.blocks ?? []),
      );
    },
    [],
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
    // While a snapshot is being redrawn at the PTY's size, fitting would
    // change the width under it; the redraw fits when it finishes.
    if (
      !terminal ||
      !fitAddon ||
      !container ||
      !terminal.element ||
      outputWriter.isReplaying()
    ) {
      return { didFit: false, sizeChanged: false };
    }

    // xterm reflows existing lines to the new width itself.
    return fitTerminalViewport({ container, fitAddon, terminal });
  }, [outputWriter]);

  const fitAndSyncSize = useCallback(() => {
    if (isDisposedRef.current) {
      return;
    }
    const result = fitTerminal();
    if (result.didFit) {
      void sendResize();
    }
  }, [fitTerminal, sendResize]);
  fitAndSyncSizeRef.current = fitAndSyncSize;

  const scheduleFit = useCallback(() => {
    if (fitTimerRef.current) {
      clearTimeout(fitTimerRef.current);
    }
    fitTimerRef.current = setTimeout(() => {
      fitTimerRef.current = null;
      fitAndSyncSize();
    }, RESIZE_DEBOUNCE_MS);
  }, [fitAndSyncSize]);

  const claimWrite = useCallback(async () => {
    try {
      const claim = await claimTerminalWrite(terminalId, clientIdRef.current);
      if (!isDisposedRef.current) {
        applyWriteOwner(claim.writeOwnerId);
      }
    } catch (claimError) {
      if (!isDisposedRef.current) {
        setError(getErrorMessage(claimError));
      }
    }
  }, [applyWriteOwner, terminalId]);

  const applyStreamEvent = useCallback(
    (event: TerminalIncrementalStreamEvent) => {
      setConnected(true);
      setError(null);

      if (!event || typeof event !== "object") {
        return;
      }
      // Resets are authoritative snapshots (their seq can go backwards after
      // a backend restart); ownership shares its seq with the reset before it.
      const isStale =
        event.type === "reset"
          ? false
          : event.type === "ownership"
            ? event.seq < seqRef.current
            : event.seq <= seqRef.current;
      if (isStale) {
        return;
      }

      if (event.type === "output") {
        if (typeof event.chunk === "string" && event.chunk.length > 0) {
          outputWriter.append(event.chunk);
        }
      } else if (event.type === "state") {
        setRunning(event.running === true);
      } else if (event.type === "reset") {
        outputWriter.replace(
          typeof event.output === "string" ? event.output : "",
          { cols: event.cols, rows: event.rows },
        );
        setRunning(event.running === true);
      } else if (event.type === "ownership") {
        applyWriteOwner(event.writeOwnerId ?? null);
      } else if (event.type === "artifacts") {
        applyArtifacts(event.artifacts);
      }

      seqRef.current = event.seq;
    },
    [applyArtifacts, applyWriteOwner, outputWriter],
  );

  const connect = useCallback(async () => {
    setError(null);

    const unsubscribe = await connectTerminalSession({
      terminalId,
      clientId: clientIdRef.current,
      isDisposed: () => isDisposedRef.current,
      // Sent on the first connection and again after every reconnect.
      onBootstrap: (event) => {
        hasBootstrappedRef.current = true;
        setBootstrapped(true);
        fitTerminal();
        applyFullSnapshot(event.snapshot, { authoritative: true });
        applyArtifacts(event.artifacts);

        const currentWriteOwnerId = event.snapshot.writeOwnerId;
        if (currentWriteOwnerId === null) {
          // Take the free write slot so the PTY gets this screen's size
          // before anything is typed. Background tabs leave it free.
          if (isDocumentVisible()) {
            void claimWrite();
          }
        } else if (currentWriteOwnerId === clientIdRef.current) {
          void sendResize(true);
        }
      },
      onEvent: applyStreamEvent,
      onConnectedChange: setConnected,
      onError: (message) => {
        setError(message);
      },
    });

    if (isDisposedRef.current) {
      unsubscribe();
      return;
    }

    closeStream();
    streamCleanupRef.current = unsubscribe;
  }, [
    applyArtifacts,
    applyFullSnapshot,
    applyStreamEvent,
    claimWrite,
    closeStream,
    fitTerminal,
    sendResize,
    terminalId,
  ]);

  useEffect(() => {
    isDisposedRef.current = false;
    hasBootstrappedRef.current = false;
    seqRef.current = 0;
    writeOwnerIdRef.current = null;
    lastSentSizeRef.current = null;
    outputWriter.clear();

    const terminal = new Terminal({
      convertEol: false,
      scrollback: 10000,
      cursorBlink: true,
      fontSize: fontSizeRef.current,
      fontFamily: TERMINAL_FONT_FAMILY,
      theme: terminalThemeRef.current,
      // OSC 8 hyperlinks printed by programs.
      linkHandler: {
        activate: (_event, text) => {
          openTerminalUrl(text);
        },
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const container = containerRef.current;
    const disposers: Array<() => void> = [];
    let resizeObserver: ResizeObserver | null = null;

    if (container && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        scheduleFit();
      });
      resizeObserver.observe(container);
    }

    // Open inside requestAnimationFrame to ensure the browser has completed
    // layout so that xterm.js character measurement returns valid dimensions.
    const retryTimers: ReturnType<typeof setTimeout>[] = [];
    const rafId = requestAnimationFrame(() => {
      if (isDisposedRef.current || !container) {
        return;
      }

      terminal.open(container);
      disposers.push(
        bindTerminalInputHandlers({
          terminal,
          controller: { queueInput: queueTerminalData },
          isReplayingOutput: () => outputWriter.isReplaying(),
        }),
      );

      // Plain http(s) URLs in the output.
      const linkProvider = terminal.registerLinkProvider({
        provideLinks(bufferLineNumber, callback) {
          const links = findTerminalBufferLinks(
            terminal.buffer.active,
            bufferLineNumber,
          );
          callback(
            links.length > 0
              ? links.map((link) => ({
                  range: link.range,
                  text: link.url,
                  decorations: { underline: true, pointerCursor: true },
                  activate: (_event: MouseEvent, text: string) => {
                    openTerminalUrl(text);
                  },
                }))
              : undefined,
          );
        },
      });
      disposers.push(() => {
        linkProvider.dispose();
      });

      // Ctrl+C / Ctrl+V belong to the shell, so Linux and Windows get the
      // usual terminal shortcuts Ctrl+Shift+C / Ctrl+Shift+V. (On macOS,
      // Cmd+C / Cmd+V already work.)
      if (!isApplePlatform()) {
        terminal.attachCustomKeyEventHandler((event) => {
          if (
            event.type !== "keydown" ||
            !event.ctrlKey ||
            !event.shiftKey ||
            event.altKey ||
            event.metaKey
          ) {
            return true;
          }
          const key = event.key.toLowerCase();
          if (key === "c") {
            const selection = terminal.getSelection();
            if (selection) {
              void copyTextToClipboard(selection);
            }
            event.preventDefault();
            return false;
          }
          if (key === "v") {
            // Let the browser fire its paste event; xterm handles it.
            return false;
          }
          return true;
        });
      }

      fitTerminal();

      // Schedule retry fits for cases where the first measurement isn't stable.
      for (const delay of [100, 500]) {
        retryTimers.push(
          setTimeout(() => {
            fitAndSyncSize();
          }, delay),
        );
      }

      void connect().catch((connectError) => {
        if (!isDisposedRef.current) {
          setError(getErrorMessage(connectError));
          setConnected(false);
        }
      });
    });

    const capturedClientId = clientIdRef.current;
    return () => {
      isDisposedRef.current = true;
      cancelAnimationFrame(rafId);
      for (const timer of retryTimers) {
        clearTimeout(timer);
      }
      if (fitTimerRef.current) {
        clearTimeout(fitTimerRef.current);
        fitTimerRef.current = null;
      }
      closeStream();
      resizeObserver?.disconnect();
      for (const dispose of disposers) {
        dispose();
      }
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      terminalInputController.reset();
      outputWriter.clear();
      setTimelineEntries([]);
      setConnected(false);
      setBootstrapped(false);
      setRunning(false);
      setError(null);
      setWriteOwnerId(null);
      setCtrlArmedState(false);
      if (readOnlyWarningTimerRef.current) {
        clearTimeout(readOnlyWarningTimerRef.current);
      }
      void releaseTerminalWrite(terminalId, capturedClientId).catch(() => {});
    };
  }, [
    closeStream,
    connect,
    fitAndSyncSize,
    fitTerminal,
    outputWriter,
    queueTerminalData,
    scheduleFit,
    setCtrlArmedState,
    terminalId,
    terminalInputController,
  ]);

  useEffect(() => {
    writeStoredTerminalFontSize(fontSize);
    const terminal = terminalRef.current;
    if (!terminal || terminal.options.fontSize === fontSize) {
      return;
    }
    terminal.options.fontSize = fontSize;
    scheduleFit();
  }, [fontSize, scheduleFit]);

  const embeddedMessagesByKey = useMemo(
    () =>
      new Map(embeddedMessages.map((item) => [item.messageKey, item] as const)),
    [embeddedMessages],
  );
  const hasEmbeddedTimelineEntries = timelineEntries.length > 0;
  const shouldShowActivateTerminalCta =
    bootstrapped &&
    !running &&
    !restarting &&
    !hasVisibleOutput &&
    !embeddedMessagesLoading;
  const shouldShowExitedBanner =
    bootstrapped && connected && !running && !restarting && hasVisibleOutput;
  const showExtraKeys = isCoarsePointer && !extraKeysHidden;

  useEffect(() => {
    if (!hasEmbeddedTimelineEntries) {
      return;
    }
    const viewport = timelineViewportRef.current;
    if (!viewport) {
      return;
    }
    viewport.scrollTop = viewport.scrollHeight;
  }, [hasEmbeddedTimelineEntries, timelineEntries.length]);

  const statusText = useMemo(() => {
    if (!connected) {
      return bootstrapped ? "Reconnecting…" : "Connecting…";
    }
    if (!bootstrapped) {
      return "Connecting…";
    }
    return running ? "Running" : "Exited";
  }, [bootstrapped, connected, running]);

  const handleRestart = useCallback(
    (source: "restart" | "activate") => {
      if (restartInFlightRef.current) {
        return;
      }
      void (async () => {
        const previousWriteOwnerId = writeOwnerIdRef.current;
        const shouldClaimWrite = shouldAutoClaimWriteAfterRestart(
          previousWriteOwnerId,
          clientIdRef.current,
        );

        restartInFlightRef.current = true;
        setRestarting(true);
        try {
          const snapshot = await restartTerminal(
            terminalId,
            clientIdRef.current,
            source,
          );
          if (isDisposedRef.current) {
            return;
          }

          applyFullSnapshot(snapshot, { authoritative: false });
          if (shouldClaimWrite && writeOwnerIdRef.current === null) {
            const claim = await claimTerminalWrite(
              terminalId,
              clientIdRef.current,
            );
            if (isDisposedRef.current) {
              return;
            }
            applyWriteOwner(claim.writeOwnerId);
          }

          restartInFlightRef.current = false;
          fitTerminal();
          // The new shell starts at the default 80x24.
          await sendResize(true);
          terminalRef.current?.focus();
        } catch (restartError) {
          if (!isDisposedRef.current) {
            setError(getErrorMessage(restartError));
          }
        } finally {
          restartInFlightRef.current = false;
          if (!isDisposedRef.current) {
            setRestarting(false);
          }
        }
      })();
    },
    [applyFullSnapshot, applyWriteOwner, fitTerminal, sendResize, terminalId],
  );

  const handleTakeOver = useCallback(() => {
    void (async () => {
      try {
        const claim = await claimTerminalWrite(terminalId, clientIdRef.current);
        if (isDisposedRef.current) {
          return;
        }
        applyWriteOwner(claim.writeOwnerId);
        fitTerminal();
        await sendResize(true);
        terminalRef.current?.focus();
      } catch (claimError) {
        setError(getErrorMessage(claimError));
      }
    })();
  }, [applyWriteOwner, fitTerminal, sendResize, terminalId]);

  const handleExtraKey = useCallback(
    (id: TerminalExtraKeyId) => {
      if (id === "ctrl") {
        setCtrlArmedState(!ctrlArmedRef.current);
        return;
      }
      const sequence = getTerminalExtraKeySequence(id, {
        applicationCursorKeys:
          terminalRef.current?.modes.applicationCursorKeysMode ?? false,
      });
      if (sequence) {
        queueTerminalData(sequence, { userInitiated: true });
      }
    },
    [queueTerminalData, setCtrlArmedState],
  );

  const changeFontSize = useCallback((delta: number) => {
    setFontSize((current) => clampTerminalFontSize(current + delta));
  }, []);

  const handleApproveStep = useCallback(
    async (input: {
      sessionId: string;
      terminalId: string;
      messageKey: string;
      step: AiTerminalStepDirective;
    }): Promise<boolean> => {
      if (!onApproveAiTerminalStep) {
        return false;
      }
      return onApproveAiTerminalStep({
        ...input,
        clientId: clientIdRef.current,
        bracketedPasteMode: terminalRef.current?.modes.bracketedPasteMode,
      });
    },
    [onApproveAiTerminalStep],
  );

  const headerIconButtonClassName =
    "h-6 w-6 shrink-0 rounded border border-zinc-700 bg-zinc-900/70 text-zinc-300 transition-colors hover:bg-zinc-800/80 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-zinc-900/70";

  return (
    <div className="h-full flex flex-col bg-zinc-950">
      <div className="h-10 border-b border-zinc-800/60 px-3 flex items-center gap-2 text-xs">
        <span
          className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
            connected && bootstrapped
              ? running
                ? "bg-emerald-400"
                : "bg-zinc-400"
              : "bg-red-400"
          }`}
          role="img"
          aria-label={`Terminal status: ${statusText}`}
          title={statusText}
        />
        {statusText !== "Running" ? (
          <span
            className={`shrink-0 ${
              connected ? "text-zinc-500" : "text-red-300/90"
            }`}
          >
            {statusText}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => handleRestart("restart")}
          disabled={isReadOnly || restarting}
          className={headerIconButtonClassName}
          aria-label="Restart terminal"
          title={
            isReadOnly
              ? "Take over to restart the terminal"
              : "Restart terminal"
          }
        >
          <RefreshCw
            className={`h-3.5 w-3.5 mx-auto ${restarting ? "animate-spin" : ""}`}
          />
        </button>
        {isReadOnly && (
          <>
            <span className="min-w-0 truncate text-amber-300/80">
              Read-only — another client has write permission
            </span>
            <button
              type="button"
              onClick={handleTakeOver}
              className="h-7 shrink-0 rounded border border-amber-600/60 bg-amber-700/20 px-2.5 text-amber-200 transition-colors hover:bg-amber-700/40"
            >
              Take Over
            </button>
          </>
        )}
        {error ? (
          <span className="ml-auto min-w-0 truncate text-red-300" title={error}>
            {error}
          </span>
        ) : (
          <div className="ml-auto" />
        )}
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => changeFontSize(-1)}
            disabled={fontSize <= MIN_TERMINAL_FONT_SIZE}
            className={headerIconButtonClassName}
            aria-label="Decrease terminal font size"
            title={`Smaller text (${fontSize}px)`}
          >
            <AArrowDown className="h-3.5 w-3.5 mx-auto" />
          </button>
          <button
            type="button"
            onClick={() => changeFontSize(1)}
            disabled={fontSize >= MAX_TERMINAL_FONT_SIZE}
            className={headerIconButtonClassName}
            aria-label="Increase terminal font size"
            title={`Larger text (${fontSize}px)`}
          >
            <AArrowUp className="h-3.5 w-3.5 mx-auto" />
          </button>
          {isCoarsePointer ? (
            <button
              type="button"
              onClick={() => setExtraKeysHidden((hidden) => !hidden)}
              className={`${headerIconButtonClassName} ${
                showExtraKeys ? "border-cyan-600/60 text-cyan-200" : ""
              }`}
              aria-label={
                showExtraKeys ? "Hide terminal keys" : "Show terminal keys"
              }
              aria-pressed={showExtraKeys}
              title={
                showExtraKeys ? "Hide terminal keys" : "Show terminal keys"
              }
            >
              <Keyboard className="h-3.5 w-3.5 mx-auto" />
            </button>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onChatInSession}
          disabled={!onChatInSession || chatBusy}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded border border-cyan-600/70 bg-cyan-600/20 px-2.5 text-[11px] text-cyan-100 transition-colors hover:bg-cyan-600/30 disabled:cursor-not-allowed disabled:opacity-55"
          aria-label="Chat in session"
          title="Chat in session"
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Chat in session</span>
        </button>
      </div>
      <div className="flex-1 min-h-0 relative overflow-hidden">
        <div ref={timelineViewportRef} className="h-full overflow-y-auto">
          <div
            className={`flex min-h-full flex-col ${
              hasEmbeddedTimelineEntries ? "gap-3 px-2 py-1" : ""
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
              <div className="shrink-0 px-3 py-1 text-[11px] text-zinc-500">
                Loading bound session replies...
              </div>
            ) : null}
            {timelineEntries.map((entry) => {
              if (entry.type === "snapshot") {
                return (
                  <TerminalSnapshotBlock
                    key={entry.key}
                    snapshot={entry.snapshot}
                    resolvedTheme={resolvedTheme}
                  />
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
                            stepStates:
                              artifactStepStatesByMessageKey[item.messageKey] ??
                              item.stepStates,
                            onApproveStep: handleApproveStep,
                            onRejectStep: onRejectAiTerminalStep,
                          }
                        : undefined
                    }
                    onFilePathLinkClick={onFilePathLinkClick}
                  />
                </div>
              );
            })}
            {/* The xterm host is absolutely positioned so it always gets a
                definite size to fit to; a percentage height here would
                collapse to xterm's own default 24 rows. */}
            <div
              className={
                hasEmbeddedTimelineEntries
                  ? "relative h-[16rem] shrink-0 overflow-hidden rounded-xl border border-zinc-800/80"
                  : "relative min-h-0 flex-1 overflow-hidden"
              }
              style={{ backgroundColor: terminalTheme.background }}
            >
              <div
                ref={containerRef}
                className="terminal-host absolute inset-0"
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
        {shouldShowExitedBanner && (
          <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-3">
            <div
              className="pointer-events-auto inline-flex items-center gap-3 rounded-lg border border-zinc-700/70 bg-zinc-900/95 px-3 py-2 text-xs text-zinc-300 shadow-lg"
              role="status"
            >
              <span>The shell has exited.</span>
              <button
                type="button"
                onClick={() => handleRestart("restart")}
                disabled={isReadOnly}
                title={
                  isReadOnly
                    ? "Take over to restart the terminal"
                    : "Start a new shell"
                }
                className="inline-flex h-7 items-center gap-1.5 rounded border border-cyan-600/70 bg-cyan-600/20 px-2.5 text-cyan-100 transition-colors hover:bg-cyan-600/30 disabled:cursor-not-allowed disabled:opacity-55"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Restart
              </button>
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
                onClick={() => handleRestart("activate")}
                disabled={isReadOnly}
                className="mt-6 inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-cyan-500/35 bg-cyan-500/10 px-5 text-sm font-medium text-cyan-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-colors hover:border-cyan-400/55 hover:bg-cyan-500/16 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:opacity-55"
                aria-label="Activate terminal emulator"
                title={
                  isReadOnly
                    ? "Take over to activate the terminal"
                    : "Activate terminal emulator"
                }
              >
                <RefreshCw className="h-4 w-4" />
                Activate terminal
              </button>
            </div>
          </div>
        )}
      </div>
      {showExtraKeys ? (
        <div
          className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-zinc-800/60 px-2 py-1.5"
          role="toolbar"
          aria-label="Terminal keys"
        >
          {TERMINAL_EXTRA_KEYS.map((key) => {
            const isActiveModifier = key.id === "ctrl" && ctrlArmed;
            return (
              <button
                key={key.id}
                type="button"
                // Keep focus (and the on-screen keyboard) on the terminal.
                onPointerDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => handleExtraKey(key.id)}
                aria-label={key.ariaLabel}
                aria-pressed={key.id === "ctrl" ? ctrlArmed : undefined}
                className={`h-8 min-w-[2.5rem] shrink-0 rounded-md border px-2 font-mono text-xs transition-colors ${
                  isActiveModifier
                    ? "border-cyan-500/60 bg-cyan-500/20 text-cyan-100"
                    : "border-zinc-700/70 bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800"
                }`}
              >
                {key.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
});

export default TerminalView;

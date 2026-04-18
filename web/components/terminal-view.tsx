import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Bot, MessageSquarePlus, RefreshCw } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import type {
  ConversationMessage,
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
} from "../terminal-session-client";
import type { ResolvedTheme } from "../theme";
import {
  type AiTerminalStepDirective,
  type AiTerminalStepState,
} from "../ai-terminal";
import { fitTerminalViewport } from "../terminal-render";
import { shouldAutoClaimWriteAfterRestart } from "../terminal-write-ownership";
import MessageBlock from "./message-block";
import { TerminalSnapshotBlock } from "./terminal-snapshot-block";

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
  } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const streamCleanupRef = useRef<(() => void) | null>(null);
  const seqRef = useRef(0);
  const isDisposedRef = useRef(false);
  const hasStartedRef = useRef(false);
  const clientIdRef = useRef(createTerminalClientId());
  const writeOwnerIdRef = useRef<string | null>(null);
  const restartInFlightRef = useRef(false);
  const readOnlyWarningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const readOnlyWarningVisibleRef = useRef(false);
  const readOnlyWarningShownAtRef = useRef(0);
  const timelineViewportRef = useRef<HTMLDivElement | null>(null);
  const terminalOutputRef = useRef("");
  const renderedLiveOutputRef = useRef("");
  const [running, setRunning] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [writeOwnerId, setWriteOwnerId] = useState<string | null>(null);
  const [showReadOnlyWarning, setShowReadOnlyWarning] = useState(false);
  const [terminalOutput, setTerminalOutput] = useState("");
  const [timelineEntries, setTimelineEntries] = useState<TerminalTimelineEntry[]>(
    [],
  );
  const terminalTheme = useMemo(
    () => getTerminalTheme(resolvedTheme),
    [resolvedTheme],
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

  const resetFrozenTimelineState = useCallback(() => {
    setTimelineEntries([]);
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

  useEffect(() => {
    writeOwnerIdRef.current = writeOwnerId;
  }, [writeOwnerId]);

  useEffect(() => {
    terminalOutputRef.current = terminalOutput;
  }, [terminalOutput]);

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
      resetFrozenTimelineState();
    }
  }, [boundSessionId, resetFrozenTimelineState]);

  const applyFullSnapshot = useCallback(
    (snapshot: TerminalSnapshotResponse) => {
      terminalOutputRef.current = snapshot.output;
      renderedLiveOutputRef.current = "";
      setTerminalOutput(snapshot.output);
      setRunning(snapshot.running);
      seqRef.current = snapshot.seq;
      writeOwnerIdRef.current = snapshot.writeOwnerId;
      setWriteOwnerId(snapshot.writeOwnerId);
    },
    [],
  );

  const applyArtifacts = useCallback(
    (entries: TerminalTimelineEntry[] | null | undefined) => {
      setTimelineEntries(entries ?? []);
    },
    [],
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
        terminalOutputRef.current =
          typeof event.output === "string" ? event.output : "";
        renderedLiveOutputRef.current = "";
        setTerminalOutput(terminalOutputRef.current);
        setRunning(event.running === true);
      } else if (event.type === "ownership") {
        writeOwnerIdRef.current = event.writeOwnerId ?? null;
        setWriteOwnerId(event.writeOwnerId ?? null);
      } else if (event.type === "artifacts") {
        applyArtifacts(event.artifacts.timelineEntries);
      }

      seqRef.current = event.seq;
    },
    [applyArtifacts],
  );

  const bootstrap = useCallback(async () => {
    setError(null);

    try {
      let initialSnapshot: TerminalSnapshotResponse | null = null;
      const unsubscribe = await connectTerminalSession({
        terminalId,
        clientId: clientIdRef.current,
        isDisposed: () => isDisposedRef.current,
        onBootstrap: (event) => {
          initialSnapshot = event.snapshot;
          hasStartedRef.current = true;
          applyFullSnapshot(event.snapshot);
          applyArtifacts(event.artifacts?.timelineEntries);
          fitTerminal();
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

      const snapshot = initialSnapshot;
      if (!snapshot) {
        return;
      }

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
    } catch (error) {
      if (!isDisposedRef.current) {
        setError(error instanceof Error ? error.message : String(error));
        setConnected(false);
      }
    }
  }, [
    applyFullSnapshot,
    applyArtifacts,
    applyStreamEvent,
    closeStream,
    fitTerminal,
    sendResize,
    terminalId,
  ]);

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
      terminalInputController.queueInput(chunk);
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
      terminalInputController.reset();
      terminalOutputRef.current = "";
      renderedLiveOutputRef.current = "";
      setTerminalOutput("");
      setTimelineEntries([]);
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
    sendResize,
    terminalId,
    terminalInputController,
    terminalTheme,
  ]);

  const embeddedMessagesByKey = useMemo(
    () =>
      new Map(embeddedMessages.map((item) => [item.messageKey, item] as const)),
    [embeddedMessages],
  );
  const hasEmbeddedTimelineEntries = timelineEntries.length > 0;
  const hasLiveTerminalOutput = terminalOutput.trim().length > 0;
  const shouldShowActivateTerminalCta =
    !running && !hasLiveTerminalOutput && !embeddedMessagesLoading;

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    const nextOutput = terminalOutput;
    if (!nextOutput.startsWith(renderedLiveOutputRef.current)) {
      terminal.reset();
      if (nextOutput.length > 0) {
        terminal.write(nextOutput);
      }
      renderedLiveOutputRef.current = nextOutput;
      return;
    }

    if (nextOutput.length > renderedLiveOutputRef.current.length) {
      terminal.write(nextOutput.slice(renderedLiveOutputRef.current.length));
    }
    renderedLiveOutputRef.current = nextOutput;
  }, [terminalOutput]);

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
    timelineEntries.length,
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

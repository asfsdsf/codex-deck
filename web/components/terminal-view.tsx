import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { RefreshCw } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import type { TerminalSnapshotResponse } from "@codex-deck/api";
import {
  claimTerminalWrite,
  getTerminalSnapshot,
  releaseTerminalWrite,
  restartTerminal,
  resizeTerminal,
  sendTerminalInput,
  subscribeTerminalStream,
} from "../api";
import { TERMINAL_FONT_FAMILY } from "../terminal-font";

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

interface TerminalViewProps {
  terminalId: string;
}

const TerminalView = memo(function TerminalView(props: TerminalViewProps) {
  const { terminalId } = props;
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
  const readOnlyWarningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const readOnlyWarningVisibleRef = useRef(false);
  const readOnlyWarningShownAtRef = useRef(0);
  const [running, setRunning] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [writeOwnerId, setWriteOwnerId] = useState<string | null>(null);
  const [showReadOnlyWarning, setShowReadOnlyWarning] = useState(false);

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
    if (!isReadOnly) {
      dismissReadOnlyWarning();
    }
  }, [isReadOnly, dismissReadOnlyWarning]);

  const applyFullSnapshot = useCallback(
    (snapshot: TerminalSnapshotResponse) => {
      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }

      terminal.reset();
      if (snapshot.output.length > 0) {
        terminal.write(snapshot.output);
      }
      setRunning(snapshot.running);
      seqRef.current = snapshot.seq;
      writeOwnerIdRef.current = snapshot.writeOwnerId;
      setWriteOwnerId(snapshot.writeOwnerId);
    },
    [],
  );

  const sendResize = useCallback(async () => {
    if (!hasStartedRef.current) {
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

      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }

      if (event.type === "output") {
        if (typeof event.chunk === "string" && event.chunk.length > 0) {
          terminal.write(event.chunk);
        }
      } else if (event.type === "state") {
        setRunning(event.running === true);
      } else if (event.type === "reset") {
        terminal.reset();
        if (typeof event.output === "string" && event.output.length > 0) {
          terminal.write(event.output);
        }
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
          onError: () => {
            setConnected(false);
          },
        },
        {
          fromSeq,
          clientId: clientIdRef.current,
          terminalId,
        },
      );
      setConnected(true);
    },
    [applyStreamEvent, closeStream, terminalId],
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

      const fitAddon = fitAddonRef.current;
      if (fitAddon) {
        fitAddon.fit();
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
  }, [applyFullSnapshot, connectStream, sendResize, terminalId]);

  useEffect(() => {
    isDisposedRef.current = false;

    const terminal = new Terminal({
      convertEol: false,
      scrollback: 10000,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: TERMINAL_FONT_FAMILY,
      theme: {
        background: "#09090b",
        foreground: "#e4e4e7",
        cursor: "#d4d4d8",
      },
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
        fitAddon.fit();
        void sendResize();
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
      fitAddon.fit();

      // Schedule retry fits for cases where the first measurement isn't stable.
      for (const delay of [100, 500]) {
        retryTimers.push(
          setTimeout(() => {
            if (!isDisposedRef.current) {
              fitAddon.fit();
              void sendResize();
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
      setConnected(false);
      setRunning(false);
      setError(null);
      setWriteOwnerId(null);
      if (readOnlyWarningTimerRef.current) {
        clearTimeout(readOnlyWarningTimerRef.current);
      }
      void releaseTerminalWrite(terminalId, capturedClientId).catch(() => {});
    };
  }, [bootstrap, closeStream, queueInput, sendResize, terminalId]);

  const statusText = useMemo(() => {
    if (!connected) {
      return "Disconnected";
    }
    return running ? "Running" : "Stopped";
  }, [connected, running]);

  const handleRestart = useCallback(() => {
    void (async () => {
      try {
        const snapshot = await restartTerminal(terminalId, clientIdRef.current);
        if (isDisposedRef.current) {
          return;
        }

        applyFullSnapshot(snapshot);
      } catch (reconnectError) {
        setError(
          reconnectError instanceof Error
            ? reconnectError.message
            : String(reconnectError),
        );
      }
    })();
  }, [applyFullSnapshot, terminalId]);

  const handleTakeOver = useCallback(() => {
    void (async () => {
      try {
        const claim = await claimTerminalWrite(terminalId, clientIdRef.current);
        writeOwnerIdRef.current = claim.writeOwnerId;
        setWriteOwnerId(claim.writeOwnerId);
        fitAddonRef.current?.fit();
        await sendResize();
      } catch (claimError) {
        setError(
          claimError instanceof Error ? claimError.message : String(claimError),
        );
      }
    })();
  }, [sendResize, terminalId]);

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
      </div>
      <div className="flex-1 overflow-hidden relative">
        <div ref={containerRef} className="h-full w-full px-2 py-1" />
        {showReadOnlyWarning && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
            <div className="bg-zinc-800/90 border border-zinc-600/50 rounded-lg px-5 py-3 text-sm text-zinc-200 shadow-lg">
              Read-only mode — press{" "}
              <strong className="text-amber-300">Take Over</strong> to type
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

export default TerminalView;

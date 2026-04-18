import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type JSX,
  type KeyboardEvent,
} from "react";
import { CheckCircle2, LoaderCircle, TerminalSquare } from "lucide-react";
import { claimTerminalWrite, releaseTerminalWrite } from "../api";
import {
  cleanAiTerminalExecutionOutput,
  cleanLiveAiTerminalExecutionOutput,
  type AiTerminalStepExecution,
} from "../ai-terminal-runtime";
import { TERMINAL_FONT_FAMILY } from "../terminal-font";
import {
  connectTerminalSession,
  createBufferedTerminalInputController,
  createTerminalClientId,
} from "../terminal-session-client";
import { AnsiText } from "./tool-renderers/ansi-text";

interface AiTerminalExecutionBlockProps {
  execution: AiTerminalStepExecution;
}

function StaticExecutionOutput(props: {
  execution: AiTerminalStepExecution;
}): JSX.Element {
  const sanitizedOutput = cleanAiTerminalExecutionOutput(
    props.execution.frozenOutput ?? "",
    props.execution.command,
  );
  const statusLabel =
    props.execution.status === "failed" ? "Failed" : "Completed";

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-950/85">
      <div className="flex items-center gap-2 border-b border-zinc-800/80 bg-zinc-900/70 px-3 py-2 text-[11px] text-zinc-300">
        <CheckCircle2
          className={`h-3.5 w-3.5 ${
            props.execution.status === "failed"
              ? "text-rose-300"
              : "text-emerald-300"
          }`}
        />
        <span>{statusLabel} terminal block</span>
      </div>
      <div className="max-h-72 overflow-auto px-3 py-3">
        {sanitizedOutput.trim() ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-zinc-100">
            <AnsiText text={sanitizedOutput} />
          </pre>
        ) : (
          <div className="font-mono text-[12px] text-zinc-500">
            No terminal output captured.
          </div>
        )}
      </div>
    </div>
  );
}

export function AiTerminalExecutionBlock(
  props: AiTerminalExecutionBlockProps,
): JSX.Element {
  const { execution } = props;
  const isRunning = execution.status === "running";
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const streamCleanupRef = useRef<(() => void) | null>(null);
  const rawOutputRef = useRef("");
  const seqRef = useRef(0);
  const writeOwnerIdRef = useRef<string | null>(null);
  const isDisposedRef = useRef(false);
  const clientIdRef = useRef(createTerminalClientId());
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [writeOwnerId, setWriteOwnerId] = useState<string | null>(null);
  const [displayOutput, setDisplayOutput] = useState("");
  const [hasFocus, setHasFocus] = useState(false);
  const isReadOnly =
    writeOwnerId !== null && writeOwnerId !== clientIdRef.current;
  const statusText = useMemo(() => {
    if (execution.status === "failed") {
      return "Failed";
    }
    if (execution.status === "completed") {
      return "Completed";
    }
    return connected ? "Live" : "Connecting";
  }, [connected, execution.status]);

  const claimWrite = useCallback(async () => {
    const claim = await claimTerminalWrite(
      execution.terminalId,
      clientIdRef.current,
    );
    writeOwnerIdRef.current = claim.writeOwnerId;
    setWriteOwnerId(claim.writeOwnerId);
  }, [execution.terminalId]);

  const updateDisplayOutput = useCallback(
    (nextRawOutput: string) => {
      rawOutputRef.current = nextRawOutput;
      setDisplayOutput(
        cleanLiveAiTerminalExecutionOutput(execution, nextRawOutput),
      );
    },
    [execution],
  );

  const terminalInputController = useMemo(
    () =>
      createBufferedTerminalInputController({
        terminalId: execution.terminalId,
        clientId: clientIdRef.current,
        isDisposed: () => isDisposedRef.current,
        getWriteOwnerId: () => writeOwnerIdRef.current,
        setError: (message) => {
          setError(message);
        },
      }),
    [execution.terminalId],
  );

  useEffect(() => {
    writeOwnerIdRef.current = writeOwnerId;
  }, [writeOwnerId]);

  useEffect(() => {
    if (!isRunning) {
      return;
    }

    isDisposedRef.current = false;

    const bootstrap = async () => {
      streamCleanupRef.current = await connectTerminalSession({
        terminalId: execution.terminalId,
        clientId: clientIdRef.current,
        isDisposed: () => isDisposedRef.current,
        onBootstrap: (event) => {
          seqRef.current = event.snapshot.seq;
          writeOwnerIdRef.current = event.snapshot.writeOwnerId;
          setWriteOwnerId(event.snapshot.writeOwnerId);
          updateDisplayOutput(
            event.snapshot.output.slice(execution.startOffset),
          );
        },
        onEvent: (event) => {
          if (event.seq <= seqRef.current) {
            return;
          }
          seqRef.current = event.seq;

          if (event.type === "output") {
            updateDisplayOutput(rawOutputRef.current + (event.chunk ?? ""));
            return;
          }

          if (event.type === "reset") {
            updateDisplayOutput(event.output.slice(execution.startOffset));
            return;
          }

          if (event.type === "ownership") {
            writeOwnerIdRef.current = event.writeOwnerId ?? null;
            setWriteOwnerId(event.writeOwnerId ?? null);
          }
        },
        onConnectedChange: setConnected,
        onError: (message) => {
          setError(message);
        },
      });
    };

    void bootstrap();

    return () => {
      isDisposedRef.current = true;
      streamCleanupRef.current?.();
      streamCleanupRef.current = null;
      rawOutputRef.current = "";
      seqRef.current = 0;
      terminalInputController.reset();
      setConnected(false);
      setWriteOwnerId(null);
      setDisplayOutput("");
      setError(null);
      void releaseTerminalWrite(
        execution.terminalId,
        clientIdRef.current,
      ).catch(() => {});
    };
  }, [
    execution.startOffset,
    execution.terminalId,
    isRunning,
    terminalInputController,
    updateDisplayOutput,
  ]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    viewport.scrollTop = viewport.scrollHeight;
  }, [displayOutput]);

  const handlePointerDown = useCallback(() => {
    containerRef.current?.focus();
    if (writeOwnerIdRef.current === null) {
      void claimWrite().catch((claimError) => {
        setError(
          claimError instanceof Error ? claimError.message : String(claimError),
        );
      });
    }
  }, [claimWrite]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.metaKey) {
        return;
      }

      const queueKey = (value: string) => {
        event.preventDefault();
        terminalInputController.queueInput(value);
      };

      if (event.ctrlKey && !event.altKey) {
        const lowerKey = event.key.toLowerCase();
        if (lowerKey === "c") {
          queueKey("\u0003");
          return;
        }
        if (lowerKey === "d") {
          queueKey("\u0004");
          return;
        }
      }

      if (event.key === "Enter") {
        queueKey("\r");
        return;
      }
      if (event.key === "Backspace") {
        queueKey("\u007f");
        return;
      }
      if (event.key === "Tab") {
        queueKey("\t");
        return;
      }
      if (event.key === "Escape") {
        queueKey("\u001b");
        return;
      }

      const navigationSequences: Record<string, string> = {
        ArrowUp: "\u001b[A",
        ArrowDown: "\u001b[B",
        ArrowRight: "\u001b[C",
        ArrowLeft: "\u001b[D",
        Delete: "\u001b[3~",
        Home: "\u001b[H",
        End: "\u001b[F",
      };
      const navigationSequence = navigationSequences[event.key];
      if (navigationSequence) {
        queueKey(navigationSequence);
        return;
      }

      if (!event.ctrlKey && !event.altKey && event.key.length === 1) {
        queueKey(event.key);
      }
    },
    [terminalInputController],
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const text = event.clipboardData.getData("text/plain");
      if (!text) {
        return;
      }
      event.preventDefault();
      terminalInputController.queueInput(text);
    },
    [terminalInputController],
  );

  if (!isRunning) {
    return <StaticExecutionOutput execution={execution} />;
  }

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-cyan-500/30 bg-zinc-950/90 shadow-[0_0_0_1px_rgba(8,145,178,0.1)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800/80 bg-zinc-900/75 px-3 py-2 text-[11px] text-zinc-300">
        <TerminalSquare className="h-3.5 w-3.5 text-cyan-300" />
        <span>Live terminal block</span>
        <span className="rounded-full border border-zinc-700/70 bg-zinc-950/80 px-2 py-0.5 uppercase tracking-wide text-[10px] text-zinc-400">
          {statusText}
        </span>
        {isReadOnly ? (
          <button
            type="button"
            onClick={() => {
              void claimWrite().catch((claimError) => {
                setError(
                  claimError instanceof Error
                    ? claimError.message
                    : String(claimError),
                );
              });
            }}
            className="rounded border border-amber-600/60 bg-amber-700/15 px-2 py-1 text-amber-200 transition-colors hover:bg-amber-700/30"
          >
            Take Over
          </button>
        ) : null}
        {error ? (
          <span className="ml-auto text-rose-300" title={error}>
            {error}
          </span>
        ) : null}
        {!error ? (
          <span className="ml-auto inline-flex items-center gap-1 text-zinc-500">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            Click to focus. Typing, paste, arrows, and Ctrl+C are forwarded to
            the shared terminal.
          </span>
        ) : null}
      </div>
      <div
        ref={containerRef}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onFocus={() => setHasFocus(true)}
        onBlur={() => setHasFocus(false)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        className={`px-3 py-3 outline-none ${
          hasFocus
            ? "bg-zinc-950 ring-1 ring-inset ring-cyan-400/50"
            : "bg-zinc-950/95"
        }`}
        data-ai-terminal-live="true"
      >
        <div
          ref={viewportRef}
          className="max-h-56 overflow-auto"
          style={{
            fontFamily: TERMINAL_FONT_FAMILY,
          }}
        >
          {displayOutput.trim() ? (
            <pre className="whitespace-pre-wrap break-words text-[12px] leading-5 text-zinc-100">
              <AnsiText text={displayOutput} />
            </pre>
          ) : (
            <div className="font-mono text-[12px] text-zinc-500">
              Waiting for command output...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

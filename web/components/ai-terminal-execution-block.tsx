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
import {
  claimTerminalWrite,
  getTerminalSnapshot,
  releaseTerminalWrite,
  sendTerminalInput,
  subscribeTerminalStream,
} from "../api";
import { buildAiTerminalExecutionWrapper } from "../ai-terminal";
import {
  cleanAiTerminalExecutionOutput,
  type AiTerminalStepExecution,
} from "../ai-terminal-runtime";
import { TERMINAL_FONT_FAMILY } from "../terminal-font";
import { sanitizeTerminalTranscriptChunk } from "../terminal-timeline";
import { AnsiText } from "./tool-renderers/ansi-text";

function generateClientId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    try {
      return crypto.randomUUID();
    } catch {
      // Not available in insecure contexts.
    }
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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

function stripPromptPrefixForLiveOutput(line: string): string {
  return line
    .replace(/^.*?\bcursh>\s*=?\s*/iu, "")
    .replace(/^(?:\([^)]*\)\s*)?[^\r\n]{0,80}?\s[»>$#%]\s*=?\s*/u, "")
    .replace(/^=\s*/u, "")
    .trim();
}

function cleanLiveExecutionOutput(execution: AiTerminalStepExecution, rawOutput: string): string {
  const sanitized = sanitizeTerminalTranscriptChunk(rawOutput);
  const expectedCommands = [
    execution.command,
    buildAiTerminalExecutionWrapper({
      command: execution.command,
      cwd: execution.cwd,
    }),
  ]
    .map((command) => command.replace(/\s+/gu, ""))
    .filter((command, index, commands) => command && commands.indexOf(command) === index);
  const lines = sanitized.split("\n");
  const keptLines: string[] = [];
  let sawMeaningfulOutput = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (sawMeaningfulOutput && keptLines[keptLines.length - 1] !== "") {
        keptLines.push("");
      }
      continue;
    }

    const strippedLine = stripPromptPrefixForLiveOutput(line);
    const compactLine = strippedLine.replace(/\s+/gu, "");
    const relaxedCompactLine = compactLine.replace(/^[&X>=-]+/u, "");
    const looksLikePromptLine =
      /\s[»>$#%]\s*$/u.test(trimmed) || /\bcursh>\s*$/iu.test(trimmed);
    const looksLikeMarkerNoise =
      strippedLine.includes("__CODEX_DECK_AI_STEP_ID=") ||
      strippedLine.includes("__CODE") ||
      /^[=&X>%]+$/u.test(strippedLine);
    const looksLikeShellNoisePrefix = /^[&X>=-]/u.test(strippedLine);
    const looksLikeShellSyntaxFragment =
      /['"$;&=]/u.test(strippedLine) ||
      strippedLine.includes("&&") ||
      /^(?:cd|printf|read|find|xargs|sort|head|awk)\b/u.test(strippedLine);
    const matchesExpectedFragment = (value: string) =>
      value.length > 0 &&
      expectedCommands.some((expectedCommand) => expectedCommand.includes(value));
    const looksLikeCommandEcho =
      compactLine.length > 0 &&
      matchesExpectedFragment(compactLine) &&
      looksLikeShellSyntaxFragment;
    const looksLikeBrokenCommandEcho =
      !sawMeaningfulOutput &&
      relaxedCompactLine.length > 0 &&
      matchesExpectedFragment(relaxedCompactLine) &&
      (looksLikeShellSyntaxFragment || looksLikeShellNoisePrefix);
    const looksLikeEarlyCommandFragment =
      !sawMeaningfulOutput &&
      compactLine.length > 0 &&
      matchesExpectedFragment(relaxedCompactLine || compactLine);
    const looksLikePreOutputShellEditingNoise =
      !sawMeaningfulOutput &&
      strippedLine.length <= 240 &&
      (looksLikeShellSyntaxFragment ||
        looksLikeShellNoisePrefix ||
        strippedLine.includes("$user_value") ||
        strippedLine.endsWith(">"));

    if (
      looksLikePromptLine ||
      looksLikeMarkerNoise ||
      looksLikeCommandEcho ||
      looksLikeBrokenCommandEcho ||
      looksLikeEarlyCommandFragment ||
      looksLikePreOutputShellEditingNoise
    ) {
      continue;
    }

    sawMeaningfulOutput = true;
    keptLines.push(trimmed);
  }

  return keptLines.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
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
  const inputBufferRef = useRef("");
  const inputFlushPromiseRef = useRef<Promise<void> | null>(null);
  const isDisposedRef = useRef(false);
  const clientIdRef = useRef(generateClientId());
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
      setDisplayOutput(cleanLiveExecutionOutput(execution, nextRawOutput));
    },
    [execution],
  );

  const flushInputBuffer = useCallback(async () => {
    if (inputFlushPromiseRef.current) {
      return inputFlushPromiseRef.current;
    }

    inputFlushPromiseRef.current = (async () => {
      while (inputBufferRef.current.length > 0 && !isDisposedRef.current) {
        if (writeOwnerIdRef.current !== clientIdRef.current) {
          if (writeOwnerIdRef.current === null) {
            await claimWrite();
          } else {
            break;
          }
        }

        const chunk = inputBufferRef.current;
        inputBufferRef.current = "";
        try {
          await sendTerminalInput(
            execution.terminalId,
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
  }, [claimWrite, execution.terminalId]);

  const queueInput = useCallback(
    (chunk: string) => {
      if (!chunk || isDisposedRef.current) {
      return;
    }
    if (
      writeOwnerIdRef.current !== null &&
      writeOwnerIdRef.current !== clientIdRef.current
      ) {
        return;
      }
      inputBufferRef.current += chunk;
      void flushInputBuffer();
    },
    [flushInputBuffer],
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
      try {
        const snapshot = await getTerminalSnapshot(execution.terminalId);
        if (isDisposedRef.current) {
          return;
        }

        seqRef.current = snapshot.seq;
        writeOwnerIdRef.current = snapshot.writeOwnerId;
        setWriteOwnerId(snapshot.writeOwnerId);
        const initialOutput = snapshot.output.slice(execution.startOffset);
        updateDisplayOutput(initialOutput);

        streamCleanupRef.current = subscribeTerminalStream(
          {
            onEvent: (event) => {
              if (event.seq <= seqRef.current) {
                return;
              }
              seqRef.current = event.seq;
              setConnected(true);
              setError(null);

              if (event.type === "output") {
                updateDisplayOutput(rawOutputRef.current + event.chunk);
                return;
              }

              if (event.type === "reset") {
                const resetOutput = event.output.slice(execution.startOffset);
                updateDisplayOutput(resetOutput);
                return;
              }

              if (event.type === "ownership") {
                writeOwnerIdRef.current = event.writeOwnerId ?? null;
                setWriteOwnerId(event.writeOwnerId ?? null);
              }
            },
            onError: () => {
              setConnected(false);
            },
          },
          {
            terminalId: execution.terminalId,
            fromSeq: snapshot.seq,
            clientId: clientIdRef.current,
          },
        );
        setConnected(true);
      } catch (bootstrapError) {
        if (isDisposedRef.current) {
          return;
        }
        setConnected(false);
        setError(
          bootstrapError instanceof Error
            ? bootstrapError.message
            : String(bootstrapError),
        );
      }
    };

    void bootstrap();

    return () => {
      isDisposedRef.current = true;
      streamCleanupRef.current?.();
      streamCleanupRef.current = null;
      rawOutputRef.current = "";
      seqRef.current = 0;
      setConnected(false);
      setWriteOwnerId(null);
      setDisplayOutput("");
      setError(null);
      void releaseTerminalWrite(
        execution.terminalId,
        clientIdRef.current,
      ).catch(() => {});
    };
  }, [execution.startOffset, execution.terminalId, isRunning, updateDisplayOutput]);

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
        queueInput(value);
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
    [queueInput],
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const text = event.clipboardData.getData("text/plain");
      if (!text) {
        return;
      }
      event.preventDefault();
      queueInput(text);
    },
    [queueInput],
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
            Click to focus. Typing, paste, arrows, and Ctrl+C are forwarded to the shared terminal.
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

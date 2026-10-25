import { useEffect, useRef, useState } from "react";
import type { CodexBackgroundTerminal } from "@codex-deck/api";
import {
  cleanSessionBackgroundTerminalRuns,
  getCodexBackgroundTerminals,
  terminateCodexBackgroundTerminal,
} from "../api";
import { subscribeCodexRuntimeEvents } from "../codex-runtime-events";

export default function BackgroundTerminals({
  threadId,
  onChange,
}: {
  threadId: string;
  onChange?: () => void;
}) {
  const [terminals, setTerminals] = useState<CodexBackgroundTerminal[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [version, setVersion] = useState(0);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (!active || document.hidden) return;
      try {
        const result = await getCodexBackgroundTerminals(threadId);
        if (active) {
          setTerminals(result.terminals);
          setError("");
        }
      } catch (error) {
        if (active) setError(String((error as Error).message || error));
      } finally {
        if (active) {
          setLoading(false);
          timer = setTimeout(refresh, 5000);
        }
      }
    };
    const wake = () => {
      if (!document.hidden) setVersion((value) => value + 1);
    };
    const unsubscribe = subscribeCodexRuntimeEvents((event) => {
      if (
        !event ||
        (event.threadId === threadId &&
          event.type === "background_terminals_changed")
      )
        wake();
    });
    document.addEventListener("visibilitychange", wake);
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
      unsubscribe();
      document.removeEventListener("visibilitychange", wake);
    };
  }, [threadId, version]);
  const stop = async (processId?: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(processId || "all");
    setError("");
    setNotice("");
    try {
      if (processId) {
        const result = await terminateCodexBackgroundTerminal(
          threadId,
          processId,
        );
        if (mounted.current)
          setNotice(
            result.terminated
              ? "Command stopped."
              : "Command has already exited or is no longer available.",
          );
      } else await cleanSessionBackgroundTerminalRuns(threadId);
      if (mounted.current) {
        setVersion((value) => value + 1);
        onChange?.();
      }
    } catch (error) {
      if (mounted.current) setError(String((error as Error).message || error));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy("");
    }
  };
  return (
    <section
      aria-label="Codex background commands"
      className="max-h-[45%] shrink-0 overflow-auto border-b border-zinc-800 p-3 text-xs text-zinc-300"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto font-medium text-zinc-100">
          Codex background commands ({terminals.length})
        </h3>
        <button
          type="button"
          onClick={() => setVersion((value) => value + 1)}
          className="rounded border border-zinc-700 px-2 py-1"
        >
          Refresh commands
        </button>
        <button
          type="button"
          disabled={!terminals.length || !!busy}
          onClick={() => void stop()}
          className="rounded border border-zinc-700 px-2 py-1 disabled:opacity-50"
        >
          Stop all
        </button>
      </div>
      {loading && <p className="mt-2">Loading active commands…</p>}
      {error && (
        <p role="status" className="mt-2 break-words text-amber-500">
          Active commands unavailable: {error}. Saved terminal history remains
          available below.
        </p>
      )}
      {notice && (
        <p role="status" className="mt-2">
          {notice}
        </p>
      )}
      {!loading && !error && !terminals.length && (
        <p className="mt-2 text-zinc-500">
          No active Codex background commands.
        </p>
      )}
      {terminals.map((terminal) => (
        <div
          key={terminal.processId}
          className="mt-2 rounded border border-zinc-700 p-2"
        >
          <div className="flex items-start gap-2">
            <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all">
              {terminal.command}
            </pre>
            <button
              type="button"
              disabled={!!busy}
              aria-label={`Stop command ${terminal.processId}`}
              onClick={() => void stop(terminal.processId)}
              className="shrink-0 rounded border border-zinc-700 px-2 py-1 disabled:opacity-50"
            >
              {busy === terminal.processId ? "Stopping…" : "Stop"}
            </button>
          </div>
          <p className="mt-1 break-all text-zinc-500">
            Process {terminal.processId} · {terminal.cwd}
          </p>
          {(terminal.osPid !== null ||
            terminal.cpuPercent !== null ||
            terminal.rssKb !== null) && (
            <p className="mt-1 text-zinc-500">
              {terminal.osPid !== null ? `OS PID ${terminal.osPid} ` : ""}
              {terminal.cpuPercent !== null
                ? `CPU ${terminal.cpuPercent}% `
                : ""}
              {terminal.rssKb !== null ? `RSS ${terminal.rssKb} KB` : ""}
            </p>
          )}
        </div>
      ))}
    </section>
  );
}

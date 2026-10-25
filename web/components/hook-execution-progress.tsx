import { useEffect, useState } from "react";
import type { CodexHookRun } from "@codex-deck/api";
import { getCodexHookRuns } from "../api";
import { subscribeCodexRuntimeEvents } from "../codex-runtime-events";

function merge(runs: CodexHookRun[], updates: CodexHookRun[]) {
  const byId = new Map(runs.map((entry) => [entry.run.id, entry]));
  for (const entry of updates) {
    const old = byId.get(entry.run.id);
    if (!old || old.run.status === "running" || entry.run.status !== "running")
      byId.set(entry.run.id, entry);
  }
  return [...byId.values()]
    .sort(
      (a, b) =>
        b.run.startedAt - a.run.startedAt ||
        a.run.displayOrder - b.run.displayOrder,
    )
    .slice(0, 100);
}
export default function HookExecutionProgress({
  threadId,
}: {
  threadId: string;
}) {
  const [runs, setRuns] = useState<CodexHookRun[]>([]);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    // Buffer only until the snapshot settles, with the same bound as the UI.
    let updates: CodexHookRun[] | null = [];
    const unsubscribe = subscribeCodexRuntimeEvents((event) => {
      if (!event) {
        setVersion((v) => v + 1);
        return;
      }
      if (event.type !== "hook_run" || event.threadId !== threadId) return;
      if (updates) updates = merge(updates, [event]);
      setRuns((current) => merge(current, [event]));
    });
    void getCodexHookRuns(threadId).then(
      ({ runs }) => {
        if (active) {
          setRuns(merge(runs, updates ?? []));
          setError("");
          updates = null;
        }
      },
      (error) => {
        updates = null;
        if (active) setError(String(error.message || error));
      },
    );
    return () => {
      active = false;
      updates = null;
      unsubscribe();
    };
  }, [threadId, version]);
  return (
    <section
      aria-label="Hook executions"
      className="max-h-[45%] shrink-0 overflow-auto border-b border-zinc-800 p-3 text-xs text-zinc-300"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium text-zinc-100">Recent hook executions</h3>
        <button
          type="button"
          className="rounded border border-zinc-700 px-2 py-1"
          onClick={() => setVersion((v) => v + 1)}
        >
          Refresh executions
        </button>
      </div>
      <p className="mt-1 text-[11px] text-zinc-500">
        Received by this Deck process.
      </p>
      {error && (
        <p role="status" className="mt-2 text-amber-500">
          {error}
        </p>
      )}
      {!runs.length && (
        <p className="mt-2 text-zinc-500">
          No executions received for this thread.
        </p>
      )}
      {runs.map(({ run, turnId }) => (
        <details
          key={run.id}
          className="mt-2 rounded border border-zinc-700 p-2"
        >
          <summary className="cursor-pointer break-words">
            {run.eventName} · {run.status}
            {run.durationMs !== null ? ` · ${run.durationMs} ms` : ""}
          </summary>
          <div className="mt-2 space-y-1 break-words">
            <p>
              {run.handlerType} · {run.executionMode} · {run.scope} ·{" "}
              {run.source}
            </p>
            <p className="break-all">{run.sourcePath}</p>
            {turnId && <p>Turn: {turnId}</p>}
            {run.statusMessage && <p>{run.statusMessage}</p>}
            {run.entries.map((entry, i) => (
              <div key={i} className="rounded border border-zinc-800 p-2">
                <span className="font-medium">{entry.kind}</span>
                <pre className="whitespace-pre-wrap break-words font-sans">
                  {entry.text}
                </pre>
              </div>
            ))}
            {!run.entries.length && <p className="text-zinc-500">No output.</p>}
          </div>
        </details>
      ))}
    </section>
  );
}

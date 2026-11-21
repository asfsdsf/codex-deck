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
      className="right-pane-catalog__executions"
    >
      <div className="right-pane-catalog__execution-heading">
        <h3>Recent hook executions</h3>
        <button
          type="button"
          className="right-pane-catalog__button"
          onClick={() => setVersion((v) => v + 1)}
        >
          Refresh executions
        </button>
      </div>
      <p>Recent activity for this session.</p>
      {error && (
        <p role="status" className="right-pane-catalog__notice">
          {error}
        </p>
      )}
      {!runs.length && (
        <p className="mt-2 text-zinc-500">
          No executions received for this thread.
        </p>
      )}
      {runs.map(({ run, turnId }) => (
        <details key={run.id} className="right-pane-catalog__execution">
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

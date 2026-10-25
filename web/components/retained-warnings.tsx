import { useCallback } from "react";
import { getCodexWarnings } from "../api";
import { useNativeSnapshot } from "../hooks/use-native-snapshot";

export default function RetainedWarnings({
  threadId,
}: {
  threadId: string | null;
}) {
  const load = useCallback(() => getCodexWarnings(threadId), [threadId]);
  const { data, error, loading, refresh } = useNativeSnapshot(
    "diagnostics",
    threadId,
    load,
  );
  const labels = {
    warning: "Warning",
    configWarning: "Configuration",
    deprecationNotice: "Deprecation",
  };
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-zinc-400">
          Recent warnings for this conversation and the host. Deck retains up to
          256 warnings received by this process, separately from tool progress.
        </p>
        <button
          onClick={refresh}
          disabled={loading}
          className="rounded border border-zinc-700 px-3 py-2 disabled:opacity-50"
        >
          Refresh warnings
        </button>
      </div>
      {loading && <p role="status">Loading retained warnings…</p>}
      {error && (
        <p role="alert" className="break-words text-red-400">
          {error}
        </p>
      )}
      {data && (
        <>
          <p className="text-xs text-zinc-500">
            {data.warnings.length} retained{" "}
            {data.warnings.length === 1 ? "warning" : "warnings"}
          </p>
          {!data.warnings.length && (
            <div className="rounded-lg border border-zinc-700 bg-zinc-950/40 p-4 text-zinc-400">
              No warnings received for this scope.
            </div>
          )}
          {[...data.warnings].reverse().map((warning) => (
            <article
              key={warning.id}
              className="space-y-2 rounded-lg border border-zinc-700 bg-zinc-950/40 p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-400">
                <span className="rounded border border-amber-700/40 bg-amber-950/20 px-2 py-0.5 text-amber-300">
                  {labels[warning.method as keyof typeof labels] ||
                    warning.method}
                </span>
                <time dateTime={new Date(warning.timestamp).toISOString()}>
                  {new Date(warning.timestamp).toLocaleString()}
                </time>
              </div>
              <p className="whitespace-pre-wrap break-words">
                {warning.summary}
              </p>
              <p className="text-xs text-zinc-500">
                {warning.threadId ? "Conversation warning" : "Host warning"}
              </p>
              <details>
                <summary className="cursor-pointer text-xs text-zinc-400">
                  Warning details
                </summary>
                <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs text-zinc-300">
                  {JSON.stringify(warning.details, null, 2)}
                </pre>
              </details>
            </article>
          ))}
        </>
      )}
    </div>
  );
}

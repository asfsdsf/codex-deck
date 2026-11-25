import { useEffect, useState } from "react";
import type { DeckPluginContributionsSnapshot } from "../../api/deck-plugin-manifest";

type Plugin = DeckPluginContributionsSnapshot["plugins"][number];
export function DeckPluginSessionToggles({
  plugins,
  threadId,
  onToggle,
}: {
  plugins: Plugin[];
  threadId: string;
  onToggle: (
    pluginId: string,
    threadId: string,
    enabled: boolean,
  ) => Promise<void>;
}) {
  const [pending, setPending] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap gap-1 px-2.5 pb-1.5">
      {plugins
        .filter((plugin) => plugin.contributions.sessionToggle)
        .map((plugin) => (
          <button
            key={plugin.id}
            type="button"
            role="switch"
            aria-checked={plugin.sessions[threadId] === true}
            aria-label={`${plugin.contributions.sessionToggle!.label} ${threadId}`}
            disabled={pending === plugin.id}
            title={plugin.contributions.sessionToggle!.label}
            className="inline-flex min-h-7 items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-[11px] text-zinc-400 hover:bg-zinc-800 aria-checked:border-cyan-500 aria-checked:text-cyan-400 disabled:opacity-50"
            onClick={(event) => {
              event.stopPropagation();
              setPending(plugin.id);
              void onToggle(
                plugin.id,
                threadId,
                !plugin.sessions[threadId],
              ).finally(() => setPending(null));
            }}
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${plugin.sessions[threadId] ? "bg-cyan-500" : "bg-zinc-400"}`}
            />
            {plugin.contributions.sessionToggle!.label}
          </button>
        ))}
    </div>
  );
}

export function DeckPluginSessionTips({
  plugins,
  threadId,
  serverOffset,
  error,
}: {
  plugins: Plugin[];
  threadId: string | null;
  serverOffset: number;
  error?: string;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const visible = plugins.filter(
    (p) =>
      p.contributions.sessionTip &&
      threadId &&
      p.sessions[threadId] &&
      (p.statuses[threadId] || p.workerError),
  );
  if (!visible.length && !error) return null;
  return (
    <aside
      aria-label="Session plugin status"
      className="pointer-events-none fixed right-3 bottom-[calc(env(safe-area-inset-bottom)+7rem)] z-30 max-h-[35dvh] w-72 max-w-[calc(100vw-1.5rem)] space-y-2 overflow-y-auto sm:right-5"
    >
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-rose-500/40 bg-zinc-900 p-3 text-xs text-rose-400 shadow"
        >
          {error}
        </p>
      )}
      {visible.map((plugin) => {
        const status = plugin.statuses[threadId!];
        const seconds = status?.nextAt
          ? Math.max(0, Math.ceil((status.nextAt - now - serverOffset) / 1000))
          : null;
        const countdown =
          seconds === null
            ? ""
            : seconds >= 60
              ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
              : `${seconds}s`;
        return (
          <div
            key={plugin.id}
            className="rounded-lg border border-zinc-700 bg-zinc-900/95 p-3 text-xs text-zinc-300 shadow-sm"
          >
            <p className="flex justify-between gap-2 font-medium">
              <span>{plugin.name}</span>
              <span>{countdown}</span>
            </p>
            <p className="mt-1 capitalize">
              {plugin.workerError
                ? "Worker unavailable"
                : status?.phase.replaceAll("_", " ")}
            </p>
            <p className="mt-1 break-words text-zinc-400">
              {plugin.workerError ?? status?.reason}
            </p>
          </div>
        );
      })}
    </aside>
  );
}

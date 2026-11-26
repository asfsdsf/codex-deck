import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import type { DeckPluginContributionsSnapshot } from "../../api/deck-plugin-manifest";

type Plugin = DeckPluginContributionsSnapshot["plugins"][number];
export function DeckPluginSessionToggles({
  plugins,
  placement,
  threadId,
  onToggle,
}: {
  plugins: Plugin[];
  placement: "actions" | "below";
  threadId: string;
  onToggle: (
    pluginId: string,
    threadId: string,
    enabled: boolean,
  ) => Promise<void>;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const compact = placement === "actions";
  const buttons = plugins.flatMap((plugin) => {
    const toggle = plugin.contributions.sessionToggle;
    if (!toggle || (plugin.id === "auto-recovery") !== compact) return [];
    const enabled = plugin.sessions[threadId] === true;
    return (
      <button
        key={plugin.id}
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={`${toggle.label} ${threadId}`}
        disabled={pending === plugin.id}
        title={
          compact ? `${toggle.label} (${enabled ? "on" : "off"})` : toggle.label
        }
        className={
          compact
            ? "inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 hover:bg-zinc-700/60 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 aria-checked:bg-cyan-500/10 aria-checked:text-cyan-400 aria-checked:opacity-100 disabled:cursor-wait"
            : "inline-flex min-h-7 items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-[11px] text-zinc-400 hover:bg-zinc-800 aria-checked:border-cyan-500 aria-checked:text-cyan-400 disabled:opacity-50"
        }
        onClick={(event) => {
          event.stopPropagation();
          setPending(plugin.id);
          void onToggle(plugin.id, threadId, !enabled).finally(() =>
            setPending(null),
          );
        }}
      >
        {compact ? (
          <RotateCcw
            className="h-4 w-4"
            strokeWidth={1.75}
            aria-hidden="true"
          />
        ) : (
          <>
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${enabled ? "bg-cyan-500" : "bg-zinc-400"}`}
            />
            {toggle.label}
          </>
        )}
      </button>
    );
  });
  if (compact || !buttons.length) return <>{buttons}</>;
  return (
    <div className="col-span-full flex flex-wrap gap-1 px-2.5 pb-1.5">
      {buttons}
    </div>
  );
}

export function DeckPluginSessionTips({
  plugins,
  threadId,
  serverOffset,
  error,
  onAction,
}: {
  plugins: Plugin[];
  threadId: string | null;
  serverOffset: number;
  error?: string;
  onAction: (
    pluginId: string,
    threadId: string,
    actionId: string,
  ) => Promise<void>;
}) {
  const [now, setNow] = useState(Date.now());
  const [pending, setPending] = useState<Record<string, boolean>>({});
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
        const pendingKey = `${plugin.id}:${threadId}`;
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
            className="pointer-events-auto rounded-lg border border-zinc-700/55 bg-zinc-900/72 p-3 text-xs text-zinc-300 shadow-sm"
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
            {!!status?.actions?.length && !plugin.workerError && (
              <div className="mt-2 flex flex-wrap justify-end gap-2">
                {status.actions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    disabled={pending[pendingKey]}
                    className="min-h-8 rounded-md border border-zinc-700/55 px-2.5 py-1 text-xs text-zinc-200 transition-colors hover:bg-zinc-800/70 focus-visible:outline-2 focus-visible:outline-cyan-500 disabled:opacity-50"
                    onClick={() => {
                      setPending((value) => ({ ...value, [pendingKey]: true }));
                      void onAction(plugin.id, threadId!, action.id).finally(
                        () =>
                          setPending((value) => ({
                            ...value,
                            [pendingKey]: false,
                          })),
                      );
                    }}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </aside>
  );
}

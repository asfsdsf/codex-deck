import { useEffect, useState } from "react";
import { Loader2, Redo2, Sparkles, SkipForward, X } from "lucide-react";
import type { DeckPluginContributionsSnapshot } from "../../api/deck-plugin-manifest";

export interface PluginHookWaitBannerProps {
  pluginName: string;
  waitingLabel: string;
  detail?: string;
  startedAt: number;
  plugins?: Array<{ id: string; name: string; waitingLabel: string }>;
  completedCount?: number;
  variant?: "inline" | "composer";
  onSkip?: () => void;
  onCancel?: () => void;
}

function formatElapsedSeconds(startedAt: number, now: number): string {
  const elapsed = Math.max(0, (now - startedAt) / 1000);
  if (elapsed < 60) return `${elapsed.toFixed(1)}s`;
  const mins = Math.floor(elapsed / 60);
  const secs = Math.floor(elapsed % 60);
  return `${mins}m ${secs}s`;
}

export function PluginHookWaitingBanner({
  pluginName,
  waitingLabel,
  detail,
  startedAt,
  plugins = [],
  completedCount = 0,
  variant = "inline",
  onSkip,
  onCancel,
}: PluginHookWaitBannerProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, []);
  const elapsed = formatElapsedSeconds(startedAt, now);
  const total = plugins.length;
  const stepText =
    total > 1 ? `Step ${Math.min(completedCount + 1, total)}/${total}` : null;

  if (variant === "composer") {
    return (
      <div
        role="status"
        aria-live="polite"
        data-plugin-hook-waiting="composer"
        className="mx-3 mt-2 flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-cyan-500/35 bg-cyan-500/10 px-2.5 py-1.5 text-xs text-cyan-200"
      >
        <Loader2
          className="h-3.5 w-3.5 shrink-0 animate-spin text-cyan-400"
          aria-hidden="true"
        />
        <span className="shrink-0 font-medium">{pluginName}</span>
        <span className="min-w-0 flex-1 truncate text-cyan-100/85">
          {detail || waitingLabel}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-cyan-300/80 tabular-nums">
          {elapsed}
        </span>
        {onSkip ? (
          <button
            type="button"
            onClick={onSkip}
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded border border-cyan-500/40 bg-cyan-500/15 px-2 text-[11px] font-medium text-cyan-100 transition-colors hover:bg-cyan-500/25 cursor-pointer"
            title="Skip plugin processing and send original message now"
          >
            <SkipForward className="h-3 w-3" aria-hidden="true" />
            <span>Skip</span>
          </button>
        ) : null}
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-cyan-200 transition-colors hover:bg-cyan-500/20 cursor-pointer"
            title="Cancel sending and restore draft"
            aria-label="Cancel sending and restore draft"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-plugin-hook-waiting="inline"
      className="relative mx-auto my-3 w-full max-w-4xl overflow-hidden rounded-xl border border-cyan-500/35 bg-zinc-900/85 shadow-sm"
    >
      <div className="plugin-hook-shimmer-bar" aria-hidden="true" />
      <div className="flex flex-wrap items-start gap-3 px-4 py-3.5">
        <div className="relative mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-cyan-500/30 bg-cyan-500/12 text-cyan-400">
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          <span
            aria-hidden="true"
            className="plugin-hook-ping absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-cyan-400"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-zinc-100">
              Waiting for {pluginName}
            </span>
            {stepText ? (
              <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-medium text-cyan-300">
                {stepText}
              </span>
            ) : null}
            <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-[11px] text-zinc-400 tabular-nums">
              <Loader2
                className="h-3 w-3 animate-spin text-cyan-400"
                aria-hidden="true"
              />
              {elapsed}
            </span>
          </div>
          <p className="mt-1 text-xs font-medium text-zinc-200">
            {waitingLabel}
          </p>
          {detail && detail !== waitingLabel ? (
            <p className="mt-0.5 break-words text-xs text-zinc-400">{detail}</p>
          ) : null}
          <p className="mt-1.5 text-[11px] text-zinc-500">
            Your first message will be sent to Codex as soon as prompt
            allocation finishes.
          </p>
          {onSkip || onCancel ? (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {onSkip ? (
                <button
                  type="button"
                  onClick={onSkip}
                  className="inline-flex min-h-7 items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800/70 px-2.5 py-1 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-800 cursor-pointer"
                >
                  <SkipForward className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Skip &amp; send original</span>
                </button>
              ) : null}
              {onCancel ? (
                <button
                  type="button"
                  onClick={onCancel}
                  className="inline-flex min-h-7 items-center gap-1 rounded-md px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-zinc-800/60 hover:text-zinc-200 cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Cancel</span>
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

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
          <Redo2 className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
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
      (!p.contributions.sessionToggle || p.sessions[threadId]) &&
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

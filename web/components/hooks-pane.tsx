import HookExecutionProgress from "./hook-execution-progress";
import { RefreshCw } from "lucide-react";
import type { CodexHookMetadata, SessionHooksResponse } from "@codex-deck/api";

function EmptyState(props: { text: string }) {
  return (
    <div className="h-full flex items-center justify-center px-4 text-center text-xs text-zinc-500">
      {props.text}
    </div>
  );
}

function hookNeedsReview(hook: CodexHookMetadata): boolean {
  return hook.trustStatus === "untrusted" || hook.trustStatus === "modified";
}

function hookIsRunnable(hook: CodexHookMetadata): boolean {
  if (hook.isManaged) {
    return true;
  }
  return hook.enabled && !hookNeedsReview(hook);
}

function formatHookEventName(
  eventName: CodexHookMetadata["eventName"],
): string {
  switch (eventName) {
    case "preToolUse":
      return "PreToolUse";
    case "permissionRequest":
      return "PermissionRequest";
    case "postToolUse":
      return "PostToolUse";
    case "preCompact":
      return "PreCompact";
    case "postCompact":
      return "PostCompact";
    case "sessionStart":
      return "SessionStart";
    case "userPromptSubmit":
      return "UserPromptSubmit";
    case "subagentStart":
      return "SubagentStart";
    case "subagentStop":
      return "SubagentStop";
    case "stop":
      return "Stop";
    default:
      return eventName;
  }
}

function formatHookSource(source: CodexHookMetadata["source"]): string {
  switch (source) {
    case "cloudManagedConfig":
      return "Cloud managed config";
    case "cloudRequirements":
      return "Cloud requirements";
    case "legacyManagedConfigFile":
      return "Legacy managed file";
    case "legacyManagedConfigMdm":
      return "Legacy managed MDM";
    case "sessionFlags":
      return "Session flags";
    default:
      return source
        .replace(/([A-Z])/g, " $1")
        .replace(/^./, (c) => c.toUpperCase());
  }
}

function hookTrustLabel(status: CodexHookMetadata["trustStatus"]): string {
  switch (status) {
    case "managed":
      return "Managed";
    case "trusted":
      return "Trusted";
    case "untrusted":
      return "New hook - review required";
    case "modified":
      return "Modified - review required";
    default:
      return status;
  }
}

function HookDetails(props: {
  hook: CodexHookMetadata | null;
  updatingHookKey: string | null;
  onToggleHookEnabled: (hook: CodexHookMetadata, enabled: boolean) => void;
  onTrustHook: (hook: CodexHookMetadata) => void;
}) {
  const { hook, updatingHookKey, onToggleHookEnabled, onTrustHook } = props;
  if (!hook) {
    return <EmptyState text="Select a hook to inspect its details." />;
  }

  const isUpdating =
    updatingHookKey === hook.key || updatingHookKey === "__all__";
  const needsReview = hookNeedsReview(hook);
  const canToggle = !hook.isManaged;
  const canTrust = !hook.isManaged && needsReview;

  return (
    <div className="h-full overflow-auto p-4 sm:p-5">
      <div className="mx-auto max-w-2xl space-y-4">
        <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {formatHookEventName(hook.eventName)}
              </h2>
              <p className="mt-1 break-all text-xs text-zinc-500">{hook.key}</p>
            </div>
            <span
              className={`rounded-full border px-2.5 py-1 text-[10px] font-medium ${
                hookIsRunnable(hook)
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200"
              }`}
            >
              {hookIsRunnable(hook) ? "Active" : "Inactive"}
            </span>
          </div>
          <div className="mt-4 flex flex-wrap gap-2 text-[10px]">
            <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/70 dark:text-zinc-300">
              {hook.handlerType}
            </span>
            <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/70 dark:text-zinc-300">
              {hookTrustLabel(hook.trustStatus)}
            </span>
          </div>
        </section>
        <section className="grid gap-x-5 gap-y-3 rounded-2xl border border-zinc-200 bg-white p-4 text-[11px] text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 sm:grid-cols-2">
          <div>
            <span className="text-zinc-500">Source</span>
            <div className="mt-1">{formatHookSource(hook.source)}</div>
          </div>
          <div>
            <span className="text-zinc-500">Timeout</span>
            <div className="mt-1">{hook.timeoutSec}s</div>
          </div>
          <div>
            <span className="text-zinc-500">Enabled</span>
            <div className="mt-1">{hook.enabled ? "Yes" : "No"}</div>
          </div>
          <div>
            <span className="text-zinc-500">Managed</span>
            <div className="mt-1">{hook.isManaged ? "Yes" : "No"}</div>
          </div>
          <div className="min-w-0 sm:col-span-2">
            <span className="text-zinc-500">Source path</span>
            <div className="mt-1 break-all">{hook.sourcePath}</div>
          </div>
          {hook.matcher ? (
            <div className="min-w-0">
              <span className="text-zinc-500">Matcher</span>
              <div className="mt-1 break-all">{hook.matcher}</div>
            </div>
          ) : null}
          {hook.pluginId ? (
            <div className="min-w-0">
              <span className="text-zinc-500">Plugin</span>
              <div className="mt-1 break-all">{hook.pluginId}</div>
            </div>
          ) : null}
          {hook.statusMessage ? (
            <div className="min-w-0 sm:col-span-2">
              <span className="text-zinc-500">Status</span>
              <div className="mt-1 break-words">{hook.statusMessage}</div>
            </div>
          ) : null}
        </section>
        {hook.command ? (
          <section className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h3 className="mb-2 text-[11px] font-medium text-zinc-500">
              Command
            </h3>
            <pre className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-[11px] leading-5 text-zinc-700 whitespace-pre-wrap break-words font-mono dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
              {hook.command}
            </pre>
          </section>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {canTrust ? (
            <button
              type="button"
              onClick={() => onTrustHook(hook)}
              disabled={isUpdating}
              className="h-9 rounded-xl border border-sky-600/35 bg-sky-500/10 px-3.5 text-xs font-medium text-sky-700 transition-colors hover:bg-sky-500/15 disabled:opacity-60 disabled:cursor-not-allowed dark:text-sky-200"
            >
              {isUpdating ? "Saving..." : "Trust hook"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => onToggleHookEnabled(hook, !hook.enabled)}
            disabled={isUpdating || !canToggle}
            className={`h-9 rounded-xl border px-3.5 text-xs font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
              canToggle
                ? hook.enabled
                  ? "border-rose-600/60 bg-rose-700/20 text-rose-200 hover:bg-rose-700/30"
                  : "border-emerald-600/60 bg-emerald-700/20 text-emerald-200 hover:bg-emerald-700/30"
                : "border-zinc-700 bg-zinc-900/70 text-zinc-500"
            }`}
          >
            {!canToggle
              ? "Managed hooks are always on"
              : isUpdating
                ? "Saving..."
                : hook.enabled
                  ? "Disable hook"
                  : "Enable hook"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface HooksPaneProps {
  threadId?: string | null;
  hooksData: SessionHooksResponse | null;
  hooksLoading: boolean;
  hooksError: string | null;
  selectedHookKey: string | null;
  updatingHookKey: string | null;
  isFileListVisible: boolean;
  selectedFileLabel: string;
  onRefreshHooks: () => void;
  onSelectHookKey: (key: string) => void;
  onToggleHookEnabled: (hook: CodexHookMetadata, enabled: boolean) => void;
  onTrustHook: (hook: CodexHookMetadata) => void;
  onTrustAllHooks: () => void;
}

function HooksConfigurationPane(props: HooksPaneProps) {
  const {
    hooksData,
    hooksLoading,
    hooksError,
    selectedHookKey,
    updatingHookKey,
    isFileListVisible,
    selectedFileLabel,
    onRefreshHooks,
    onSelectHookKey,
    onToggleHookEnabled,
    onTrustHook,
    onTrustAllHooks,
  } = props;

  const hooks = hooksData?.hooks ?? [];
  const selectedHook =
    hooks.find((hook) => hook.key === selectedHookKey) ?? null;
  const reviewNeededCount = hooks.filter(hookNeedsReview).length;

  if (hooksLoading) {
    return <EmptyState text="Loading hooks..." />;
  }

  if (hooksError) {
    return <EmptyState text={hooksError} />;
  }

  return (
    <div className="flex min-h-0 flex-1">
      {isFileListVisible ? (
        <div className="w-56 shrink-0 overflow-y-auto border-r border-zinc-800/60 bg-zinc-50/70 py-2 dark:bg-zinc-950/50">
          <div className="flex items-center justify-between gap-2 px-4 pb-3 pt-2 text-[11px] text-zinc-500">
            <span>{`${hooks.length} ${hooks.length === 1 ? "hook" : "hooks"}`}</span>
            <button
              type="button"
              onClick={onRefreshHooks}
              className="h-7 w-7 shrink-0 rounded-lg text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              aria-label="Refresh hooks"
              title="Refresh hooks"
            >
              <RefreshCw className="h-3.5 w-3.5 mx-auto" />
            </button>
          </div>
          {hooksData?.warnings.length ? (
            <div className="mx-2 mb-2 rounded-lg bg-amber-500/10 px-2.5 py-2 text-[10px] text-amber-800 dark:text-amber-200">
              {hooksData.warnings.join(" ")}
            </div>
          ) : null}
          {hooksData?.errors.length ? (
            <div className="mx-2 mb-2 rounded-lg bg-rose-500/10 px-2.5 py-2 text-[10px] text-rose-800 dark:text-rose-200">
              {hooksData.errors.length} hook config error
              {hooksData.errors.length === 1 ? "" : "s"}
            </div>
          ) : null}
          {reviewNeededCount > 0 ? (
            <div className="mx-2 mb-2 flex items-center justify-between gap-2 rounded-lg bg-amber-500/10 px-2.5 py-2 text-[10px] text-amber-800 dark:text-amber-200">
              <span>{reviewNeededCount} need review</span>
              <button
                type="button"
                onClick={onTrustAllHooks}
                disabled={updatingHookKey === "__all__"}
                className="rounded-lg border border-sky-600/30 bg-sky-500/10 px-2.5 py-1.5 text-[10px] font-medium text-sky-700 transition-colors hover:bg-sky-500/15 disabled:opacity-60 disabled:cursor-not-allowed dark:text-sky-200"
              >
                {updatingHookKey === "__all__" ? "Saving..." : "Trust all"}
              </button>
            </div>
          ) : null}
          {hooks.length === 0 ? (
            <div className="px-4 py-3 text-xs text-zinc-500">
              No hooks available.
            </div>
          ) : (
            hooks.map((hook) => {
              const active = hook.key === selectedHookKey;
              const needsReview = hookNeedsReview(hook);
              return (
                <button
                  key={hook.key}
                  type="button"
                  onClick={() => onSelectHookKey(hook.key)}
                  className={`mx-2 mb-0.5 w-[calc(100%-1rem)] rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-zinc-200/70 dark:hover:bg-zinc-800/70 ${
                    active ? "bg-zinc-200/80 dark:bg-zinc-800" : ""
                  }`}
                  title={hook.key}
                >
                  <div className="truncate text-[11px] font-medium leading-4 text-zinc-800 dark:text-zinc-200">
                    {formatHookEventName(hook.eventName)}
                  </div>
                  <div className="mt-1 flex items-center gap-1 text-[10px] text-zinc-500">
                    <span
                      className={
                        hookIsRunnable(hook)
                          ? "text-emerald-700 dark:text-emerald-300"
                          : "text-amber-700 dark:text-amber-300"
                      }
                    >
                      {hookIsRunnable(hook) ? "active" : "inactive"}
                    </span>
                    <span>•</span>
                    <span>{hook.handlerType}</span>
                    {needsReview ? (
                      <>
                        <span>•</span>
                        <span className="text-amber-300">review</span>
                      </>
                    ) : null}
                  </div>
                </button>
              );
            })
          )}
        </div>
      ) : null}

      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex h-10 items-center gap-2 border-b border-zinc-800/60 px-4">
          <span className="text-xs text-zinc-300 truncate">
            {selectedFileLabel}
          </span>
        </div>
        <div className="flex-1 min-h-0">
          <HookDetails
            hook={selectedHook}
            updatingHookKey={updatingHookKey}
            onToggleHookEnabled={onToggleHookEnabled}
            onTrustHook={onTrustHook}
          />
        </div>
      </div>
    </div>
  );
}

export default function HooksPane(props: HooksPaneProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {props.threadId && <HookExecutionProgress threadId={props.threadId} />}
      <HooksConfigurationPane {...props} />
    </div>
  );
}

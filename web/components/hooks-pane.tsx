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

function formatHookEventName(eventName: CodexHookMetadata["eventName"]): string {
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
      return source.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
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

  const isUpdating = updatingHookKey === hook.key || updatingHookKey === "__all__";
  const needsReview = hookNeedsReview(hook);
  const canToggle = !hook.isManaged;
  const canTrust = !hook.isManaged && needsReview;

  return (
    <div className="h-full overflow-auto p-3">
      <div className="space-y-3">
        <div>
          <div className="text-sm text-zinc-100">
            {formatHookEventName(hook.eventName)}
          </div>
          <div className="mt-1 text-xs text-zinc-500 break-all">{hook.key}</div>
        </div>
        <div className="flex flex-wrap gap-2 text-[10px]">
          <span
            className={`rounded-full border px-2 py-1 ${
              hookIsRunnable(hook)
                ? "border-emerald-500/40 bg-emerald-500/12 text-emerald-200"
                : "border-amber-500/40 bg-amber-500/12 text-amber-200"
            }`}
          >
            {hookIsRunnable(hook) ? "active" : "inactive"}
          </span>
          <span className="rounded-full border border-zinc-700 bg-zinc-900/70 px-2 py-1 text-zinc-300">
            {hook.handlerType}
          </span>
          <span className="rounded-full border border-zinc-700 bg-zinc-900/70 px-2 py-1 text-zinc-300">
            {hookTrustLabel(hook.trustStatus)}
          </span>
        </div>
        <div className="text-[11px] text-zinc-400 space-y-1">
          <div>
            <span className="text-zinc-500">Source:</span>{" "}
            {formatHookSource(hook.source)}
          </div>
          <div>
            <span className="text-zinc-500">Source path:</span>{" "}
            <span className="break-all">{hook.sourcePath}</span>
          </div>
          <div>
            <span className="text-zinc-500">Timeout:</span> {hook.timeoutSec}s
          </div>
          <div>
            <span className="text-zinc-500">Enabled:</span>{" "}
            {hook.enabled ? "true" : "false"}
          </div>
          <div>
            <span className="text-zinc-500">Managed:</span>{" "}
            {hook.isManaged ? "true" : "false"}
          </div>
          {hook.matcher ? (
            <div>
              <span className="text-zinc-500">Matcher:</span> {hook.matcher}
            </div>
          ) : null}
          {hook.pluginId ? (
            <div>
              <span className="text-zinc-500">Plugin:</span> {hook.pluginId}
            </div>
          ) : null}
          {hook.statusMessage ? (
            <div>
              <span className="text-zinc-500">Status:</span>{" "}
              {hook.statusMessage}
            </div>
          ) : null}
        </div>
        {hook.command ? (
          <div>
            <div className="text-[11px] text-zinc-500 mb-1">Command</div>
            <pre className="rounded border border-zinc-800 bg-zinc-900/60 p-2 text-[11px] leading-5 text-zinc-300 whitespace-pre-wrap break-words font-mono">
              {hook.command}
            </pre>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {canTrust ? (
            <button
              type="button"
              onClick={() => onTrustHook(hook)}
              disabled={isUpdating}
              className="h-8 rounded border border-sky-600/60 bg-sky-700/20 px-3 text-xs text-sky-200 transition-colors hover:bg-sky-700/30 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isUpdating ? "Saving..." : "Trust hook"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => onToggleHookEnabled(hook, !hook.enabled)}
            disabled={isUpdating || !canToggle}
            className={`h-8 rounded border px-3 text-xs transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
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

export default function HooksPane(props: HooksPaneProps) {
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
    <div className="flex-1 min-h-0 flex">
      {isFileListVisible ? (
        <div className="w-56 border-r border-zinc-800/60 overflow-y-auto">
          <div className="px-3 py-2 border-b border-zinc-800/60 text-[11px] text-zinc-500 flex items-center justify-between gap-2">
            <span>{`${hooks.length} hooks`}</span>
            <button
              type="button"
              onClick={onRefreshHooks}
              className="h-6 w-6 shrink-0 rounded border border-zinc-700 bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800/80 transition-colors"
              aria-label="Refresh hooks"
              title="Refresh hooks"
            >
              <RefreshCw className="h-3.5 w-3.5 mx-auto" />
            </button>
          </div>
          {hooksData?.warnings.length ? (
            <div className="px-3 py-2 border-b border-zinc-900 text-[10px] text-amber-300">
              {hooksData.warnings.join(" ")}
            </div>
          ) : null}
          {hooksData?.errors.length ? (
            <div className="px-3 py-2 border-b border-zinc-900 text-[10px] text-rose-300">
              {hooksData.errors.length} hook config error
              {hooksData.errors.length === 1 ? "" : "s"}
            </div>
          ) : null}
          {reviewNeededCount > 0 ? (
            <div className="px-3 py-2 border-b border-zinc-900 text-[10px] text-amber-300 flex items-center justify-between gap-2">
              <span>{reviewNeededCount} need review</span>
              <button
                type="button"
                onClick={onTrustAllHooks}
                disabled={updatingHookKey === "__all__"}
                className="rounded border border-sky-600/60 bg-sky-700/20 px-2 py-1 text-[10px] text-sky-200 transition-colors hover:bg-sky-700/30 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {updatingHookKey === "__all__" ? "Saving..." : "Trust all"}
              </button>
            </div>
          ) : null}
          {hooks.length === 0 ? (
            <div className="px-3 py-3 text-xs text-zinc-500">
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
                  className={`w-full text-left px-3 py-2 border-b border-zinc-900 hover:bg-zinc-900/50 transition-colors ${
                    active ? "bg-zinc-900/60" : ""
                  }`}
                  title={hook.key}
                >
                  <div className="text-[11px] leading-4 text-zinc-200 truncate">
                    {formatHookEventName(hook.eventName)}
                  </div>
                  <div className="mt-1 flex items-center gap-1 text-[10px] text-zinc-500">
                    <span
                      className={
                        hookIsRunnable(hook)
                          ? "text-emerald-300"
                          : "text-amber-300"
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
        <div className="h-9 px-3 border-b border-zinc-800/60 flex items-center gap-2">
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

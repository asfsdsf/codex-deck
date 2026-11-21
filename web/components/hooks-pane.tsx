import HookExecutionProgress from "./hook-execution-progress";
import { useState } from "react";
import { Zap } from "lucide-react";
import type { CodexHookMetadata, SessionHooksResponse } from "@codex-deck/api";
import RightPaneCatalog from "./right-pane-catalog";

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

interface HooksPaneProps {
  threadId?: string | null;
  hooksData: SessionHooksResponse | null;
  hooksLoading: boolean;
  hooksError: string | null;
  updatingHookKey: string | null;
  onRefreshHooks: () => void;
  onSelectHookKey: (key: string) => void;
  onToggleHookEnabled: (hook: CodexHookMetadata, enabled: boolean) => void;
  onTrustHook: (hook: CodexHookMetadata) => void;
  onTrustAllHooks: () => void;
}

export default function HooksPane(props: HooksPaneProps) {
  const [view, setView] = useState<"configuration" | "executions">(
    "configuration",
  );
  const hooks = props.hooksData?.hooks ?? [];
  const reviewCount = hooks.filter(
    (hook) => !hook.isManaged && hookNeedsReview(hook),
  ).length;
  return (
    <div className="right-pane-catalog">
      {props.threadId ? (
        <div
          className="right-pane-catalog__views"
          role="group"
          aria-label="Hooks view"
        >
          <button
            type="button"
            aria-pressed={view === "configuration"}
            onClick={() => setView("configuration")}
          >
            Configuration
          </button>
          <button
            type="button"
            aria-pressed={view === "executions"}
            onClick={() => setView("executions")}
          >
            Executions
          </button>
        </div>
      ) : null}
      {view === "executions" && props.threadId ? (
        <HookExecutionProgress threadId={props.threadId} />
      ) : (
        <RightPaneCatalog
          label="Hooks"
          icon={<Zap size={18} aria-hidden="true" />}
          loading={props.hooksLoading}
          error={props.hooksError}
          onRefresh={props.onRefreshHooks}
          onSelect={props.onSelectHookKey}
          filters={[
            { value: "all", label: "All", matches: () => true },
            {
              value: "active",
              label: "Active",
              matches: (item) => item.tone === "active",
            },
            {
              value: "review",
              label: "Needs review",
              matches: (item) => item.tone === "review",
            },
          ]}
          notices={
            <>
              {props.hooksData?.warnings.map((warning, index) => (
                <div
                  key={index}
                  className="right-pane-catalog__notice"
                  role="status"
                >
                  {warning}
                </div>
              ))}
              {props.hooksData?.errors.map((error, index) => (
                <div
                  key={index}
                  className="right-pane-catalog__notice"
                  role="alert"
                >
                  <strong>{error.path}</strong>
                  <br />
                  {error.message}
                </div>
              ))}
              {reviewCount > 0 ? (
                <div className="right-pane-catalog__notice right-pane-catalog__review">
                  <span>
                    {reviewCount}{" "}
                    {reviewCount === 1 ? "hook needs" : "hooks need"} review
                  </span>
                  <button
                    type="button"
                    className="right-pane-catalog__button"
                    disabled={props.updatingHookKey !== null}
                    onClick={props.onTrustAllHooks}
                  >
                    {props.updatingHookKey === "__all__"
                      ? "Saving…"
                      : "Trust all"}
                  </button>
                </div>
              ) : null}
            </>
          }
          items={hooks.map((hook) => ({
            key: hook.key,
            title: formatHookEventName(hook.eventName),
            description:
              hook.command ||
              hook.statusMessage ||
              `${hook.handlerType} handler`,
            meta: [hook.handlerType, formatHookSource(hook.source)].join(" · "),
            status:
              hookNeedsReview(hook) && !hook.isManaged
                ? "Needs review"
                : hookIsRunnable(hook)
                  ? "Active"
                  : "Inactive",
            tone:
              hookNeedsReview(hook) && !hook.isManaged
                ? "review"
                : hookIsRunnable(hook)
                  ? "active"
                  : "muted",
            searchText: [
              hook.key,
              hook.eventName,
              hook.command,
              hook.matcher,
              hook.sourcePath,
              hook.source,
              formatHookSource(hook.source),
              hook.handlerType,
              hook.pluginId,
            ].join(" "),
          }))}
          renderDetails={(key) => {
            const hook = hooks.find((entry) => entry.key === key)!;
            const needsReview = hookNeedsReview(hook) && !hook.isManaged;
            const saving =
              props.updatingHookKey === key ||
              props.updatingHookKey === "__all__";
            return (
              <>
                <div className="right-pane-catalog__identity">
                  <span className="right-pane-catalog__hero right-pane-catalog__icon--hooks">
                    <Zap size={24} aria-hidden="true" />
                  </span>
                  <div>
                    <h2>{formatHookEventName(hook.eventName)}</h2>
                    <span className="right-pane-catalog__subtitle">
                      {hook.handlerType} · {formatHookSource(hook.source)}
                    </span>
                  </div>
                </div>
                <div className="right-pane-catalog__enable-row">
                  <span
                    className="right-pane-catalog__status"
                    data-tone={hookIsRunnable(hook) ? "active" : "muted"}
                  >
                    {hookIsRunnable(hook) ? "Active" : "Inactive"}
                  </span>
                  <button
                    type="button"
                    className="right-pane-catalog__button"
                    disabled={props.updatingHookKey !== null || hook.isManaged}
                    onClick={() =>
                      props.onToggleHookEnabled(hook, !hook.enabled)
                    }
                  >
                    {hook.isManaged
                      ? "Always on"
                      : saving
                        ? "Saving…"
                        : hook.enabled
                          ? "Disable hook"
                          : "Enable hook"}
                  </button>
                </div>
                {needsReview ? (
                  <div className="right-pane-catalog__notice">
                    <p>
                      {hook.trustStatus === "modified"
                        ? "This hook has changed since you trusted it."
                        : "This hook needs your review before it can run."}{" "}
                      Review the command and source below.
                    </p>
                    <button
                      type="button"
                      className="right-pane-catalog__button"
                      disabled={props.updatingHookKey !== null}
                      onClick={() => props.onTrustHook(hook)}
                    >
                      {saving ? "Saving…" : "Trust hook"}
                    </button>
                  </div>
                ) : null}
                <dl className="right-pane-catalog__properties">
                  <div>
                    <dt>Trust</dt>
                    <dd>{hookTrustLabel(hook.trustStatus)}</dd>
                  </div>
                  <div>
                    <dt>Timeout</dt>
                    <dd>{hook.timeoutSec}s</dd>
                  </div>
                  <div>
                    <dt>Enabled</dt>
                    <dd>{hook.enabled ? "Yes" : "No"}</dd>
                  </div>
                  <div>
                    <dt>Managed</dt>
                    <dd>{hook.isManaged ? "Yes" : "No"}</dd>
                  </div>
                  {hook.matcher ? (
                    <div>
                      <dt>Matcher</dt>
                      <dd>{hook.matcher}</dd>
                    </div>
                  ) : null}
                  {hook.pluginId ? (
                    <div>
                      <dt>Plugin</dt>
                      <dd>{hook.pluginId}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>Source path</dt>
                    <dd>{hook.sourcePath}</dd>
                  </div>
                  <div>
                    <dt>Key</dt>
                    <dd>{hook.key}</dd>
                  </div>
                </dl>
                {hook.statusMessage ? (
                  <p className="right-pane-catalog__prose">
                    {hook.statusMessage}
                  </p>
                ) : null}
                {hook.command ? (
                  <section className="right-pane-catalog__section">
                    <h3>Command</h3>
                    <pre>{hook.command}</pre>
                  </section>
                ) : null}
              </>
            );
          }}
        />
      )}
    </div>
  );
}

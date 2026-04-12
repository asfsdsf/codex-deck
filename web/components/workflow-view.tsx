import { useMemo, useState, type ReactNode } from "react";
import type {
  ConversationMessage,
  WorkflowControlMessage,
  WorkflowDaemonStatusResponse,
  WorkflowDetailResponse,
  WorkflowHistoryEntry,
  WorkflowLogResponse,
  WorkflowSchedulerState,
  WorkflowTaskSummary,
} from "@codex-deck/api";
import { sanitizeText } from "../utils";
import LatestSessionMessageBox from "./latest-session-message-box";
import { MarkdownRenderer } from "./markdown-renderer";
import { AnsiText } from "./tool-renderers/ansi-text";
import { useHighlightedJsonCode } from "./tool-renderers/shell-highlight";

type WorkflowTab =
  | "overview"
  | "tasks"
  | "history"
  | "logs"
  | "control"
  | "raw";

interface WorkflowViewProps {
  workflow: WorkflowDetailResponse | null;
  daemonStatus: WorkflowDaemonStatusResponse | null;
  selectedTaskId: string | null;
  latestBoundSessionMessage: ConversationMessage | null;
  latestBoundSessionMessageLoading: boolean;
  loading: boolean;
  error: string | null;
  logData: WorkflowLogResponse | null;
  logLoading: boolean;
  logError: string | null;
  actionBusy: boolean;
  actionLabel: string | null;
  actionResultLabel: string | null;
  actionResultOutput: string | null;
  stopAllHint: string | null;
  onChatInSession: () => void;
  onStopAllWorkflowProcesses: () => void;
  onOpenSession: (sessionId: string) => void;
  onSelectTask: (taskId: string) => void;
  onLaunchTask: (taskId: string) => void;
  onLoadLog: (
    scope: "scheduler" | "task" | "daemon",
    taskId?: string | null,
  ) => void;
  onStartDaemon: () => void;
  onStopDaemon: () => void;
  onSendControlMessage: (input: {
    type: string;
    reason?: string | null;
    payload?: Record<string, unknown> | null;
  }) => void;
  onFilePathLinkClick?: (href: string) => boolean;
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  return new Date(timestamp).toLocaleString();
}

function statusClassName(status: string): string {
  switch (status) {
    case "running":
      return "border-sky-500/40 bg-sky-500/15 text-sky-100";
    case "completed":
    case "success":
      return "border-emerald-500/40 bg-emerald-500/15 text-emerald-100";
    case "failed":
      return "border-red-500/40 bg-red-500/15 text-red-100";
    case "cancelled":
      return "border-zinc-600/60 bg-zinc-700/30 text-zinc-200";
    default:
      return "border-amber-500/40 bg-amber-500/15 text-amber-100";
  }
}

function statusBadge(status: string) {
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusClassName(
        status,
      )}`}
    >
      {status}
    </span>
  );
}

function schedulerStateLabel(scheduler: WorkflowSchedulerState): string {
  if (scheduler.running) {
    return "running";
  }
  if (scheduler.pendingTrigger) {
    return "pending";
  }
  if (scheduler.lastTurnStatus) {
    return scheduler.lastTurnStatus;
  }
  return "idle";
}

function formatControlMessageSummary(
  message: WorkflowControlMessage | null,
): string {
  if (!message) {
    return "-";
  }
  const payloadReason =
    typeof message.payload?.reason === "string" ? message.payload.reason : null;
  const parts = [message.type, payloadReason].filter((value): value is string =>
    Boolean(value && value.trim()),
  );
  return parts.length > 0 ? parts.join(" · ") : "control message";
}

function humanizeKey(value: string): string {
  const normalized = value.trim().replace(/[_-]+/g, " ");
  if (!normalized) {
    return "-";
  }
  return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => asNonEmptyString(item))
    .filter((item): item is string => Boolean(item));
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function serializeJsonValue(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "";
}

function countLines(value: string): number {
  if (!value) {
    return 0;
  }
  return value.split("\n").length;
}

function hasOwn(
  record: Record<string, unknown>,
  key: string,
): key is keyof typeof record {
  return Object.prototype.hasOwnProperty.call(record, key);
}

const SCROLLABLE_TEXT_BOX_CLASS =
  "max-h-40 overflow-auto overscroll-contain whitespace-pre-wrap break-words";
const SCROLLABLE_MARKDOWN_CLASS =
  "[&_p]:my-0 [&_p]:text-xs [&_p]:leading-relaxed [&_ul]:my-1 [&_ol]:my-1 [&_li]:text-xs";
const SCROLLABLE_MARKDOWN_ERROR_CLASS = `${SCROLLABLE_MARKDOWN_CLASS} [&_p]:text-red-200 [&_li]:text-red-200 [&_strong]:text-red-100 [&_em]:text-red-100`;

function ScrollableMarkdownText(props: {
  content: string;
  markdownClassName?: string;
  onFilePathLinkClick?: (href: string) => boolean;
}) {
  const sanitizedContent = sanitizeText(props.content);
  if (!sanitizedContent) {
    return null;
  }

  return (
    <MarkdownRenderer
      content={sanitizedContent}
      className={props.markdownClassName ?? SCROLLABLE_MARKDOWN_CLASS}
      onFilePathLinkClick={props.onFilePathLinkClick}
    />
  );
}

type HistoryBadgeTone = "neutral" | "info" | "success" | "warning" | "danger";

function historyBadgeClassName(tone: HistoryBadgeTone): string {
  switch (tone) {
    case "info":
      return "border-sky-500/40 bg-sky-500/15 text-sky-100";
    case "success":
      return "border-emerald-500/40 bg-emerald-500/15 text-emerald-100";
    case "warning":
      return "border-amber-500/40 bg-amber-500/15 text-amber-100";
    case "danger":
      return "border-red-500/40 bg-red-500/15 text-red-100";
    default:
      return "border-zinc-700 bg-zinc-800/70 text-zinc-200";
  }
}

function HistoryBadge(props: {
  label: string;
  tone?: HistoryBadgeTone;
  monospace?: boolean;
}) {
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${historyBadgeClassName(
        props.tone ?? "neutral",
      )} ${props.monospace ? "font-mono" : ""}`}
    >
      {props.label}
    </span>
  );
}

function HistoryField(props: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-zinc-800/80 bg-zinc-950/50 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">
        {props.label}
      </div>
      <div className="mt-1 text-sm text-zinc-100 break-words">
        {props.value}
      </div>
    </div>
  );
}

function JsonSyntaxView(props: {
  value: unknown;
  maxHeightClassName?: string;
  preClassName?: string;
}) {
  const jsonText = useMemo(
    () => serializeJsonValue(props.value),
    [props.value],
  );
  const highlightedJson = useHighlightedJsonCode(jsonText);

  return (
    <div
      className={`overflow-auto overscroll-contain ${props.maxHeightClassName ?? ""}`}
    >
      <pre
        className={`min-w-full p-3 font-mono text-xs leading-6 text-zinc-200 whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${props.preClassName ?? ""}`}
      >
        <code
          className="command-syntax block whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
          dangerouslySetInnerHTML={{ __html: highlightedJson }}
        />
      </pre>
    </div>
  );
}

function HistoryJsonBlock(props: { label: string; value: unknown }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-3">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">
        {props.label}
      </div>
      <div className="mt-2 rounded border border-zinc-800/80 bg-zinc-900/60">
        <JsonSyntaxView value={props.value} maxHeightClassName="max-h-64" />
      </div>
    </div>
  );
}

function HistoryReferenceButton(props: {
  kind: "task" | "session";
  value: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="inline-flex max-w-full items-center rounded border border-zinc-700 bg-zinc-800/70 px-2 py-1 font-mono text-xs text-zinc-100 transition-colors hover:bg-zinc-700/80"
    >
      <span className="truncate">{props.value}</span>
      <span className="ml-2 shrink-0 text-[10px] uppercase tracking-wide text-zinc-400">
        {props.kind === "task" ? "task" : "session"}
      </span>
    </button>
  );
}

function formatHistoryPayloadSummary(payload: Record<string, unknown> | null) {
  if (!payload) {
    return null;
  }
  const payloadType = asNonEmptyString(payload.type);
  const payloadReason = asNonEmptyString(payload.reason);
  const parts = [payloadType, payloadReason].filter((value): value is string =>
    Boolean(value),
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function WorkflowHistoryEntryCard(props: {
  entry: WorkflowHistoryEntry;
  onOpenSession: (sessionId: string) => void;
  onSelectTask: (taskId: string) => void;
}) {
  const details = props.entry.details;
  const consumed = new Set<string>();
  const fields: Array<{ label: string; value: ReactNode }> = [];
  const badges: Array<{
    label: string;
    tone?: HistoryBadgeTone;
    monospace?: boolean;
  }> = [];
  const blocks: Array<{ label: string; value: unknown }> = [];
  let title = humanizeKey(props.entry.type);
  let summary: string | null = null;

  const takeString = (key: string): string | null => {
    if (!hasOwn(details, key)) {
      return null;
    }
    consumed.add(key);
    return asNonEmptyString(details[key]);
  };

  const takeBoolean = (key: string): boolean | null => {
    if (!hasOwn(details, key)) {
      return null;
    }
    consumed.add(key);
    return asBoolean(details[key]);
  };

  const takeStringArray = (key: string): string[] => {
    if (!hasOwn(details, key)) {
      return [];
    }
    consumed.add(key);
    return asStringArray(details[key]);
  };

  const takeRecord = (key: string): Record<string, unknown> | null => {
    if (!hasOwn(details, key)) {
      return null;
    }
    consumed.add(key);
    return asObjectRecord(details[key]);
  };

  const addTaskField = (label: string, taskId: string | null) => {
    if (!taskId) {
      return;
    }
    fields.push({
      label,
      value: (
        <HistoryReferenceButton
          kind="task"
          value={taskId}
          onClick={() => props.onSelectTask(taskId)}
        />
      ),
    });
  };

  const addTaskListField = (label: string, taskIds: string[]) => {
    if (taskIds.length === 0) {
      return;
    }
    fields.push({
      label,
      value: (
        <div className="flex flex-wrap gap-1.5">
          {taskIds.map((taskId) => (
            <HistoryReferenceButton
              key={taskId}
              kind="task"
              value={taskId}
              onClick={() => props.onSelectTask(taskId)}
            />
          ))}
        </div>
      ),
    });
  };

  const addSessionField = (label: string, sessionId: string | null) => {
    if (!sessionId) {
      return;
    }
    fields.push({
      label,
      value: (
        <HistoryReferenceButton
          kind="session"
          value={sessionId}
          onClick={() => props.onOpenSession(sessionId)}
        />
      ),
    });
  };

  const addTextField = (
    label: string,
    value: string | null,
    options?: { monospace?: boolean },
  ) => {
    if (!value) {
      return;
    }
    fields.push({
      label,
      value: options?.monospace ? (
        <code className="text-xs text-zinc-100">{value}</code>
      ) : (
        value
      ),
    });
  };

  switch (props.entry.type) {
    case "workflow_created": {
      title = "Workflow created";
      const taskCount = takeString("taskCount");
      summary = taskCount ? `Initialized ${taskCount} task(s).` : null;
      addTextField("Task count", taskCount);
      badges.push({ label: "created", tone: "success" });
      break;
    }
    case "tasks_started": {
      title = "Tasks started";
      const taskIds = takeStringArray("taskIds");
      summary =
        taskIds.length > 0 ? `Started ${taskIds.join(", ")}.` : "Started task.";
      addTaskListField("Tasks", taskIds);
      badges.push({ label: "running", tone: "info" });
      break;
    }
    case "task_session_attached": {
      title = "Task session attached";
      const taskId = takeString("taskId");
      const sessionId = takeString("sessionId");
      summary =
        taskId && sessionId
          ? `Attached session ${sessionId} to ${taskId}.`
          : null;
      addTaskField("Task", taskId);
      addSessionField("Session", sessionId);
      break;
    }
    case "task_finished": {
      title = "Task finished";
      const taskId = takeString("taskId");
      const success = takeBoolean("success");
      const noOp = takeBoolean("noOp");
      const stopPending = takeBoolean("stopPending");
      summary =
        taskId && success !== null
          ? `${taskId} ${success ? "finished successfully" : "finished with failure"}.`
          : taskId
            ? `${taskId} finished.`
            : null;
      addTaskField("Task", taskId);
      if (success !== null) {
        badges.push({
          label: success ? "success" : "failed",
          tone: success ? "success" : "danger",
        });
      }
      if (noOp) {
        badges.push({ label: "no-op", tone: "neutral" });
      }
      if (stopPending) {
        badges.push({ label: "stop pending", tone: "warning" });
      }
      break;
    }
    case "task_failed": {
      title = "Task failed";
      const taskId = takeString("taskId");
      const reason = takeString("reason");
      summary = reason || null;
      addTaskField("Task", taskId);
      addTextField("Reason", reason);
      badges.push({ label: "failed", tone: "danger" });
      break;
    }
    case "task_runner_reconciled": {
      title = "Task runner reconciled";
      const taskId = takeString("taskId");
      const runnerPid = takeString("runnerPid");
      summary =
        taskId && runnerPid
          ? `Recovered ${taskId} after runner ${runnerPid} stopped.`
          : null;
      addTaskField("Task", taskId);
      addTextField("Runner PID", runnerPid, { monospace: true });
      badges.push({ label: "reconciled", tone: "warning" });
      break;
    }
    case "workflow_pruned_stop_signal": {
      title = "Pending work pruned";
      const stopSignal = takeString("stopSignal");
      summary = stopSignal
        ? `Pending tasks were cancelled after stop signal "${stopSignal}".`
        : "Pending tasks were cancelled after a stop signal.";
      addTextField("Stop signal", stopSignal, { monospace: true });
      badges.push({ label: "cancelled", tone: "warning" });
      break;
    }
    case "workflow_reconciled": {
      title = "Workflow reconciled";
      const reason = takeString("reason");
      summary = reason ? `State refreshed for ${reason}.` : null;
      addTextField("Reason", reason);
      badges.push({ label: "reconciled", tone: "info" });
      break;
    }
    case "workflow_mutation_applied": {
      title = "Workflow mutation applied";
      const requestId = takeString("requestId");
      const mutationType = takeString("type");
      const taskId = takeString("taskId");
      const alreadyPresent = takeBoolean("alreadyPresent");
      summary = [mutationType, taskId].filter(Boolean).join(" · ") || null;
      addTextField("Request", requestId, { monospace: true });
      addTextField("Mutation", mutationType);
      addTaskField("Task", taskId);
      badges.push({ label: "applied", tone: "success" });
      if (alreadyPresent) {
        badges.push({ label: "already present", tone: "warning" });
      }
      break;
    }
    case "workflow_control_message": {
      const requestId = takeString("requestId");
      const payload = takeRecord("payload");
      const applied = takeBoolean("applied");
      title = applied ? "Control message applied" : "Control message queued";
      summary = formatHistoryPayloadSummary(payload);
      addTextField("Request", requestId, { monospace: true });
      if (payload) {
        blocks.push({ label: "Payload", value: payload });
      }
      badges.push({
        label: applied ? "applied" : "queued",
        tone: applied ? "success" : "info",
      });
      break;
    }
    case "daemon_command_executed": {
      title = "Daemon command executed";
      const source = takeString("source");
      const taskId = takeString("taskId");
      const cwd = takeString("cwd");
      const commandType = takeString("commandType");
      const commandSummary = takeString("commandSummary");
      summary = [source, taskId].filter(Boolean).join(" · ") || null;
      addTextField("Source", source);
      addTaskField("Task", taskId);
      addTextField("Type", commandType, { monospace: true });
      addTextField("CWD", cwd, { monospace: true });
      addTextField("Command", commandSummary, { monospace: true });
      badges.push({ label: "daemon", tone: "neutral" });
      break;
    }
    case "daemon_task_event": {
      title = "Daemon task event";
      const requestId = takeString("requestId");
      const daemonType = takeString("type");
      const taskId = takeString("taskId");
      summary = [daemonType, taskId].filter(Boolean).join(" · ") || null;
      addTextField("Request", requestId, { monospace: true });
      addTextField("Event", daemonType);
      addTaskField("Task", taskId);
      badges.push({ label: "daemon", tone: "neutral" });
      break;
    }
    case "scheduler_trigger_started":
    case "scheduler_trigger_pending":
    case "scheduler_trigger_stale_recovered":
    case "scheduler_trigger_failed":
    case "scheduler_trigger_finished":
    case "scheduler_trigger_restarted":
    case "scheduler_trigger_validation_failed": {
      const reason = takeString("reason");
      const requestId = takeString("requestId");
      const exitCode = takeString("exitCode");
      const rerun = takeBoolean("rerun");
      const usedResume = takeBoolean("usedResume");
      const errors = takeStringArray("errors");
      const titleByType: Record<string, string> = {
        scheduler_trigger_started: "Scheduler trigger started",
        scheduler_trigger_pending: "Scheduler trigger queued",
        scheduler_trigger_stale_recovered: "Stale scheduler recovered",
        scheduler_trigger_failed: "Scheduler trigger failed",
        scheduler_trigger_finished: "Scheduler trigger finished",
        scheduler_trigger_restarted: "Scheduler trigger restarted",
        scheduler_trigger_validation_failed: "Scheduler validation failed",
      };
      title = titleByType[props.entry.type] || humanizeKey(props.entry.type);
      summary = reason || null;
      addTextField("Reason", reason);
      addTextField("Request", requestId, { monospace: true });
      addTextField("Exit code", exitCode, { monospace: true });
      if (errors.length > 0) {
        blocks.push({ label: "Errors", value: errors });
      }
      if (props.entry.type === "scheduler_trigger_failed") {
        badges.push({ label: "failed", tone: "danger" });
      } else if (props.entry.type === "scheduler_trigger_pending") {
        badges.push({ label: "queued", tone: "warning" });
      } else if (props.entry.type === "scheduler_trigger_started") {
        badges.push({ label: "running", tone: "info" });
      } else if (props.entry.type === "scheduler_trigger_validation_failed") {
        badges.push({ label: "invalid", tone: "danger" });
      } else {
        badges.push({ label: "scheduler", tone: "neutral" });
      }
      if (rerun) {
        badges.push({ label: "rerun", tone: "warning" });
      }
      if (usedResume) {
        badges.push({ label: "resumed", tone: "info" });
      }
      break;
    }
    default:
      break;
  }

  if (!consumed.has("taskId")) {
    addTaskField("Task", takeString("taskId"));
  }
  if (!consumed.has("taskIds")) {
    addTaskListField("Tasks", takeStringArray("taskIds"));
  }
  if (!consumed.has("sessionId")) {
    addSessionField("Session", takeString("sessionId"));
  }
  if (!consumed.has("requestId")) {
    addTextField("Request", takeString("requestId"), { monospace: true });
  }
  if (!consumed.has("reason")) {
    addTextField("Reason", takeString("reason"));
  }
  if (!consumed.has("type")) {
    addTextField("Type", takeString("type"));
  }
  if (!consumed.has("runnerPid")) {
    addTextField("Runner PID", takeString("runnerPid"), { monospace: true });
  }
  if (!consumed.has("stopSignal")) {
    addTextField("Stop signal", takeString("stopSignal"), { monospace: true });
  }
  if (!consumed.has("payload")) {
    const payload = takeRecord("payload");
    if (payload) {
      blocks.push({ label: "Payload", value: payload });
    }
  }
  if (!consumed.has("errors")) {
    const errors = takeStringArray("errors");
    if (errors.length > 0) {
      blocks.push({ label: "Errors", value: errors });
    }
  }
  if (!consumed.has("success")) {
    const success = takeBoolean("success");
    if (success !== null) {
      badges.push({
        label: success ? "success" : "failed",
        tone: success ? "success" : "danger",
      });
    }
  }
  if (!consumed.has("applied")) {
    const applied = takeBoolean("applied");
    if (applied !== null) {
      badges.push({
        label: applied ? "applied" : "queued",
        tone: applied ? "success" : "info",
      });
    }
  }
  if (!consumed.has("noOp") && takeBoolean("noOp")) {
    badges.push({ label: "no-op", tone: "neutral" });
  }
  if (!consumed.has("stopPending") && takeBoolean("stopPending")) {
    badges.push({ label: "stop pending", tone: "warning" });
  }
  if (!consumed.has("alreadyPresent") && takeBoolean("alreadyPresent")) {
    badges.push({ label: "already present", tone: "warning" });
  }
  if (!consumed.has("rerun") && takeBoolean("rerun")) {
    badges.push({ label: "rerun", tone: "warning" });
  }
  if (!consumed.has("usedResume") && takeBoolean("usedResume")) {
    badges.push({ label: "resumed", tone: "info" });
  }
  if (!consumed.has("taskCount")) {
    addTextField("Task count", takeString("taskCount"));
  }
  if (!consumed.has("exitCode")) {
    addTextField("Exit code", takeString("exitCode"), { monospace: true });
  }

  const remainingDetails = Object.fromEntries(
    Object.entries(details).filter(([key]) => !consumed.has(key)),
  );

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 py-3 sm:px-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-zinc-100">{title}</span>
            <HistoryBadge label={props.entry.type} monospace />
            {badges.map((badge, index) => (
              <HistoryBadge
                key={`${badge.label}-${index}`}
                label={badge.label}
                tone={badge.tone}
                monospace={badge.monospace}
              />
            ))}
          </div>
          {summary ? (
            <div className="mt-1 text-sm text-zinc-300 break-words">
              {summary}
            </div>
          ) : null}
        </div>
        <div className="shrink-0 text-xs text-zinc-500">
          Recorded {formatTimestamp(props.entry.at)}
        </div>
      </div>

      {fields.length > 0 ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {fields.map((field, index) => (
            <HistoryField
              key={`${field.label}-${index}`}
              label={field.label}
              value={field.value}
            />
          ))}
        </div>
      ) : null}

      {blocks.length > 0 ? (
        <div className="mt-3 space-y-2">
          {blocks.map((block, index) => (
            <HistoryJsonBlock
              key={`${block.label}-${index}`}
              label={block.label}
              value={block.value}
            />
          ))}
        </div>
      ) : null}

      {Object.keys(remainingDetails).length > 0 ? (
        <details className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-zinc-300">
            Other details
          </summary>
          <div className="mt-2 rounded border border-zinc-800/80 bg-zinc-900/60">
            <JsonSyntaxView
              value={remainingDetails}
              maxHeightClassName="max-h-72"
            />
          </div>
        </details>
      ) : null}
    </div>
  );
}

function StatCard(props: {
  label: string;
  value: string;
  hint?: string | null;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">
        {props.label}
      </div>
      <div className="mt-1 text-sm text-zinc-100 break-words">
        {props.value}
      </div>
      {props.hint ? (
        <div className="mt-1 text-[11px] text-zinc-500">{props.hint}</div>
      ) : null}
    </div>
  );
}

function SchedulerCard(props: {
  scheduler: WorkflowSchedulerState;
  actionBusy: boolean;
  onOpenSession: (sessionId: string) => void;
  onFilePathLinkClick?: (href: string) => boolean;
}) {
  const promptPreview =
    props.scheduler.lastComposedPrompt || props.scheduler.builtInPrompt;
  const promptLabel = props.scheduler.lastComposedPrompt
    ? "Last composed prompt"
    : props.scheduler.builtInPrompt
      ? "Built-in prompt"
      : null;
  const latestControlMessage =
    props.scheduler.controlMessages[
      props.scheduler.controlMessages.length - 1
    ] ?? null;
  const stateLabel = schedulerStateLabel(props.scheduler);
  const latestControlMessageSummary =
    formatControlMessageSummary(latestControlMessage);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 text-left">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-zinc-100">Scheduler</span>
            {statusBadge(stateLabel)}
            {props.scheduler.pendingTrigger ? (
              <span className="inline-flex rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-100">
                trigger queued
              </span>
            ) : null}
          </div>
          <div className="mt-1 text-[11px] text-zinc-500">
            Workflow controller
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {props.scheduler.lastSessionId ? (
            <button
              type="button"
              onClick={() => props.onOpenSession(props.scheduler.lastSessionId)}
              disabled={props.actionBusy}
              className="h-8 rounded border border-zinc-700 bg-zinc-800/70 px-3 text-xs text-zinc-200 transition-colors hover:bg-zinc-700/80 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Open session
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-3 grid gap-2 text-xs text-zinc-300 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <span className="text-zinc-500">Role:</span> Workflow controller
        </div>
        <div>
          <span className="text-zinc-500">Thread:</span>{" "}
          {props.scheduler.threadId || "-"}
        </div>
        <div>
          <span className="text-zinc-500">Session:</span>{" "}
          {props.scheduler.lastSessionId || "-"}
        </div>
        <div>
          <span className="text-zinc-500">Controller mode:</span>{" "}
          {props.scheduler.controllerMode || "-"}
        </div>
        <div>
          <span className="text-zinc-500">Last run:</span>{" "}
          {formatTimestamp(props.scheduler.lastRunAt)}
        </div>
        <div>
          <span className="text-zinc-500">Last turn:</span>{" "}
          {props.scheduler.lastTurnId || "-"}
        </div>
        <div>
          <span className="text-zinc-500">Turn status:</span>{" "}
          {props.scheduler.lastTurnStatus || "-"}
        </div>
        <div>
          <span className="text-zinc-500">Control queue:</span>{" "}
          {props.scheduler.controlMessages.length}
        </div>
        <div>
          <span className="text-zinc-500">Latest control:</span>{" "}
          {latestControlMessageSummary}
        </div>
        <div>
          <span className="text-zinc-500">Control updated:</span>{" "}
          {formatTimestamp(latestControlMessage?.createdAt)}
        </div>
      </div>

      {props.scheduler.lastReason ? (
        <div
          className={`mt-3 rounded border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-xs text-zinc-300 ${SCROLLABLE_TEXT_BOX_CLASS}`}
        >
          <div className="mb-1 text-zinc-500">Last reason:</div>
          <ScrollableMarkdownText
            content={props.scheduler.lastReason}
            onFilePathLinkClick={props.onFilePathLinkClick}
          />
        </div>
      ) : null}

      {promptPreview && promptLabel ? (
        <div
          className={`mt-2 rounded border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-xs text-zinc-300 ${SCROLLABLE_TEXT_BOX_CLASS}`}
        >
          <div className="mb-1 text-zinc-500">{promptLabel}:</div>
          <ScrollableMarkdownText
            content={promptPreview}
            onFilePathLinkClick={props.onFilePathLinkClick}
          />
        </div>
      ) : null}

      {latestControlMessage?.payload ? (
        <div className="mt-2 rounded border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-xs text-zinc-300 whitespace-pre-wrap break-words">
          <span className="text-zinc-500">Latest control payload:</span>
          <div className="mt-2 rounded border border-zinc-800/80 bg-zinc-900/60">
            <JsonSyntaxView
              value={latestControlMessage.payload}
              maxHeightClassName="max-h-64"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TaskCard(props: {
  task: WorkflowTaskSummary;
  selected: boolean;
  actionBusy: boolean;
  onSelect: () => void;
  onOpenSession: (sessionId: string) => void;
  onLaunch: (taskId: string) => void;
  onFilePathLinkClick?: (href: string) => boolean;
}) {
  const { task } = props;
  return (
    <div
      className={`rounded-lg border p-3 ${
        props.selected
          ? "border-cyan-500/40 bg-cyan-500/8"
          : "border-zinc-800 bg-zinc-900/70"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <button
          type="button"
          onClick={props.onSelect}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-zinc-100">
              {task.name}
            </span>
            {statusBadge(task.status)}
            {task.ready ? (
              <span className="inline-flex rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-[11px] text-cyan-100">
                ready
              </span>
            ) : null}
          </div>
          <div className="mt-1 text-[11px] text-zinc-500">{task.id}</div>
        </button>
        <div className="flex flex-wrap items-center gap-2">
          {task.ready ? (
            <button
              type="button"
              onClick={() => props.onLaunch(task.id)}
              disabled={props.actionBusy}
              className="h-8 rounded border border-cyan-600/70 bg-cyan-600/20 px-3 text-xs text-cyan-100 transition-colors hover:bg-cyan-600/30 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Launch task
            </button>
          ) : null}
          {task.sessionId ? (
            <button
              type="button"
              onClick={() => props.onOpenSession(task.sessionId as string)}
              className="h-8 rounded border border-zinc-700 bg-zinc-800/70 px-3 text-xs text-zinc-200 transition-colors hover:bg-zinc-700/80"
            >
              Open session
            </button>
          ) : null}
        </div>
      </div>
      <div className="mt-3 grid gap-2 text-xs text-zinc-300 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <span className="text-zinc-500">Depends on:</span>{" "}
          {task.dependsOn.length > 0 ? task.dependsOn.join(", ") : "-"}
        </div>
        <div>
          <span className="text-zinc-500">Branch:</span>{" "}
          {task.branchName || "-"}
        </div>
        <div>
          <span className="text-zinc-500">Worktree:</span>{" "}
          {task.worktreePath || "-"}
        </div>
        <div>
          <span className="text-zinc-500">Started:</span>{" "}
          {formatTimestamp(task.startedAt)}
        </div>
        <div>
          <span className="text-zinc-500">Finished:</span>{" "}
          {formatTimestamp(task.finishedAt)}
        </div>
        <div>
          <span className="text-zinc-500">Result commit:</span>{" "}
          {task.resultCommit || "-"}
        </div>
      </div>
      {task.summary ? (
        <div
          className={`mt-3 rounded border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-xs text-zinc-300 ${SCROLLABLE_TEXT_BOX_CLASS}`}
        >
          <ScrollableMarkdownText
            content={task.summary}
            onFilePathLinkClick={props.onFilePathLinkClick}
          />
        </div>
      ) : null}
      {task.failureReason ? (
        <div
          className={`mt-2 rounded border border-red-800/70 bg-red-950/30 px-3 py-2 text-xs text-red-200 ${SCROLLABLE_TEXT_BOX_CLASS}`}
        >
          <ScrollableMarkdownText
            content={task.failureReason}
            markdownClassName={SCROLLABLE_MARKDOWN_ERROR_CLASS}
            onFilePathLinkClick={props.onFilePathLinkClick}
          />
        </div>
      ) : null}
    </div>
  );
}

export default function WorkflowView(props: WorkflowViewProps) {
  const [activeTab, setActiveTab] = useState<WorkflowTab>("overview");
  const [controlType, setControlType] = useState("enqueue-trigger");
  const [controlReason, setControlReason] = useState("manual");
  const [controlPayload, setControlPayload] = useState("{}");
  const [controlError, setControlError] = useState<string | null>(null);
  const rawWorkflow = props.workflow?.raw ?? null;

  const selectedTask = useMemo(
    () =>
      props.workflow?.tasks.find((task) => task.id === props.selectedTaskId) ??
      null,
    [props.selectedTaskId, props.workflow],
  );
  const rawJsonText = useMemo(
    () => serializeJsonValue(rawWorkflow),
    [rawWorkflow],
  );
  const rawJsonLineCount = useMemo(
    () => countLines(rawJsonText),
    [rawJsonText],
  );
  const rawJsonStructureSummary = useMemo(() => {
    if (Array.isArray(rawWorkflow)) {
      return `${rawWorkflow.length} top-level item${
        rawWorkflow.length === 1 ? "" : "s"
      }`;
    }
    const record = asObjectRecord(rawWorkflow);
    if (record) {
      const keyCount = Object.keys(record).length;
      return `${keyCount} top-level field${keyCount === 1 ? "" : "s"}`;
    }
    return null;
  }, [rawWorkflow]);

  if (props.loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-400">
        Loading workflow...
      </div>
    );
  }

  if (props.error) {
    return (
      <div className="m-4 rounded-lg border border-red-800/60 bg-red-950/30 px-4 py-3 text-sm text-red-200">
        {props.error}
      </div>
    );
  }

  if (!props.workflow) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">
        Select a workflow to inspect it.
      </div>
    );
  }

  const { workflow, daemonStatus } = props;
  const summary = workflow.summary;
  const actionBusyLabel = props.actionLabel || "Working...";
  const tabs: Array<{ id: WorkflowTab; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "tasks", label: "Tasks" },
    { id: "history", label: "History" },
    { id: "logs", label: "Logs" },
    { id: "control", label: "Control" },
    { id: "raw", label: "Raw JSON" },
  ];

  const submitControlMessage = () => {
    try {
      const trimmedPayload = controlPayload.trim();
      const payload = trimmedPayload
        ? (JSON.parse(trimmedPayload) as unknown)
        : {};
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("Payload must be a JSON object.");
      }
      setControlError(null);
      props.onSendControlMessage({
        type: controlType,
        reason: controlReason || null,
        payload: payload as Record<string, unknown>,
      });
    } catch (error) {
      setControlError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-zinc-950">
      <div className="border-b border-zinc-800/60 px-4 py-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-zinc-100 break-words">
                {summary.title}
              </h2>
              {statusBadge(summary.status)}
              {summary.schedulerRunning ? (
                <span className="inline-flex rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-100">
                  scheduler active
                </span>
              ) : null}
              {summary.schedulerPendingTrigger ? (
                <span className="inline-flex rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-100">
                  pending trigger
                </span>
              ) : null}
            </div>
            <div className="grid gap-2 text-xs text-zinc-400 sm:grid-cols-2 xl:grid-cols-4">
              <div>
                <span className="text-zinc-500">Workflow ID:</span> {summary.id}
              </div>
              <div>
                <span className="text-zinc-500">Project:</span>{" "}
                {summary.projectRoot}
              </div>
              <div>
                <span className="text-zinc-500">Target branch:</span>{" "}
                {summary.targetBranch || "-"}
              </div>
              <div>
                <span className="text-zinc-500">Updated:</span>{" "}
                {formatTimestamp(summary.updatedAt)}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 lg:max-w-[26rem] lg:justify-end">
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                props.onChatInSession();
              }}
              disabled={props.actionBusy}
              className="h-8 rounded border border-cyan-600/70 bg-cyan-600/20 px-3 text-xs text-cyan-100 transition-colors hover:bg-cyan-600/30 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Chat in session
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                props.onStopAllWorkflowProcesses();
              }}
              disabled={props.actionBusy}
              className="h-8 rounded border border-red-600/70 bg-red-700/25 px-3 text-xs text-red-100 transition-colors hover:bg-red-700/35 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Stop All
            </button>
            {props.stopAllHint ? (
              <div className="w-full text-right text-[11px] text-red-200">
                {props.stopAllHint}
              </div>
            ) : null}
          </div>
        </div>
        {props.actionBusy ? (
          <div className="mt-3 text-xs text-cyan-200">{actionBusyLabel}</div>
        ) : null}
        {!props.actionBusy && props.actionResultLabel ? (
          <div className="mt-3 rounded-lg border border-emerald-700/40 bg-emerald-950/20 px-3 py-2">
            <div className="text-xs font-medium text-emerald-200">
              {props.actionResultLabel}
            </div>
            <div className="mt-1 text-xs text-zinc-300 whitespace-pre-wrap break-words">
              {props.actionResultOutput?.trim() || "Done."}
            </div>
          </div>
        ) : null}
      </div>

      <div className="border-b border-zinc-800/60 px-4 py-3">
        <LatestSessionMessageBox
          message={props.latestBoundSessionMessage}
          sessionId={workflow.boundSessionId}
          emptyText={
            props.latestBoundSessionMessageLoading
              ? "Loading latest session message..."
              : workflow.boundSessionId
                ? "No important session messages yet."
                : "No bound session yet."
          }
          onFilePathLinkClick={props.onFilePathLinkClick}
          containerClassName="flex h-64 min-h-0 flex-col space-y-1 text-xs text-zinc-400"
        />
      </div>

      <div className="border-b border-zinc-800/60 px-4 py-3">
        <div className="flex flex-wrap gap-2">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`rounded border px-3 py-1.5 text-xs transition-colors ${
                activeTab === tab.id
                  ? "border-cyan-500/50 bg-cyan-700/25 text-cyan-100"
                  : "border-zinc-800 bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800/80"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="p-4">
        {activeTab === "overview" ? (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              <StatCard
                label="Tasks"
                value={`${summary.taskCounts.success}/${summary.taskCounts.total}`}
                hint="successful / total"
              />
              <StatCard
                label="Daemon"
                value={daemonStatus?.state || "unknown"}
                hint={daemonStatus?.daemonId || null}
              />
              <StatCard
                label="Max parallel"
                value={workflow.settings.maxParallel?.toString() || "-"}
                hint={workflow.settings.mergePolicy || null}
              />
              <StatCard
                label="Scheduler session"
                value={workflow.scheduler.lastSessionId || "-"}
                hint={workflow.scheduler.threadId || null}
              />
              <StatCard
                label="Bound session"
                value={workflow.boundSessionId || "-"}
                hint={
                  workflow.boundSessionId
                    ? "Used by Chat in session"
                    : "Created on demand"
                }
              />
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
                <div className="text-sm font-medium text-zinc-100">
                  Task counts
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2 text-sm text-zinc-300">
                  <div>Pending: {summary.taskCounts.pending}</div>
                  <div>Running: {summary.taskCounts.running}</div>
                  <div>Success: {summary.taskCounts.success}</div>
                  <div>Failed: {summary.taskCounts.failed}</div>
                  <div>Cancelled: {summary.taskCounts.cancelled}</div>
                  <div>Total: {summary.taskCounts.total}</div>
                </div>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
                <div className="text-sm font-medium text-zinc-100">
                  Recent outcomes
                </div>
                {summary.recentOutcomes.length === 0 ? (
                  <div className="mt-3 text-sm text-zinc-500">
                    No recent task outcomes.
                  </div>
                ) : (
                  <div className="mt-3 space-y-2">
                    {summary.recentOutcomes.map((outcome) => (
                      <div
                        key={`${outcome.taskId}-${outcome.finishedAt || "pending"}`}
                        className="rounded border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-300"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-zinc-100">
                            {outcome.taskId}
                          </span>
                          {statusBadge(outcome.status)}
                          <span className="text-zinc-500">
                            {formatTimestamp(outcome.finishedAt)}
                          </span>
                        </div>
                        {outcome.summary ? (
                          <div className="mt-1 break-words text-zinc-400">
                            {outcome.summary}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : null}

        {activeTab === "tasks" ? (
          <div className="space-y-3">
            <SchedulerCard
              scheduler={workflow.scheduler}
              actionBusy={props.actionBusy}
              onOpenSession={props.onOpenSession}
              onFilePathLinkClick={props.onFilePathLinkClick}
            />
            {workflow.tasks.length === 0 ? (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-4 py-3 text-sm text-zinc-500">
                No tasks are defined for this workflow.
              </div>
            ) : (
              workflow.tasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  selected={selectedTask?.id === task.id}
                  actionBusy={props.actionBusy}
                  onSelect={() => props.onSelectTask(task.id)}
                  onOpenSession={props.onOpenSession}
                  onLaunch={props.onLaunchTask}
                  onFilePathLinkClick={props.onFilePathLinkClick}
                />
              ))
            )}
          </div>
        ) : null}

        {activeTab === "history" ? (
          <div className="space-y-2">
            {workflow.history.length === 0 ? (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-4 py-3 text-sm text-zinc-500">
                No workflow history yet.
              </div>
            ) : (
              workflow.history.map((entry, index) => (
                <WorkflowHistoryEntryCard
                  key={`${entry.type}-${entry.at || index}`}
                  entry={entry}
                  onOpenSession={props.onOpenSession}
                  onSelectTask={props.onSelectTask}
                />
              ))
            )}
          </div>
        ) : null}

        {activeTab === "logs" ? (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => props.onLoadLog("scheduler")}
                className="h-8 rounded border border-zinc-700 bg-zinc-800/80 px-3 text-xs text-zinc-200 transition-colors hover:bg-zinc-700/80"
              >
                Scheduler log
              </button>
              <button
                type="button"
                onClick={() => props.onLoadLog("daemon")}
                className="h-8 rounded border border-zinc-700 bg-zinc-800/80 px-3 text-xs text-zinc-200 transition-colors hover:bg-zinc-700/80"
              >
                Daemon log
              </button>
            </div>
            {props.logLoading ? (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-4 py-3 text-sm text-zinc-400">
                Loading log...
              </div>
            ) : null}
            {props.logError ? (
              <div className="rounded-lg border border-red-800/60 bg-red-950/30 px-4 py-3 text-sm text-red-200">
                {props.logError}
              </div>
            ) : null}
            {props.logData ? (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/70">
                <div className="border-b border-zinc-800 px-3 py-2 text-xs text-zinc-400 break-all">
                  {props.logData.path ||
                    props.logData.unavailableReason ||
                    "No log file selected."}
                </div>
                <div className="max-h-[32rem] overflow-auto p-3 text-sm text-zinc-200">
                  {props.logData.unavailableReason ? (
                    <div className="text-zinc-500">
                      {props.logData.unavailableReason}
                    </div>
                  ) : props.logData.content ? (
                    <AnsiText text={props.logData.content} />
                  ) : (
                    <div className="text-zinc-500">
                      The selected log is empty.
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-4 py-3 text-sm text-zinc-500">
                Choose a log source to load it.
              </div>
            )}
          </div>
        ) : null}

        {activeTab === "control" ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-zinc-100">
                    Daemon
                  </div>
                  <div className="mt-1 text-xs text-zinc-400">
                    State: {daemonStatus?.state || "unknown"} · Queue depth:{" "}
                    {daemonStatus?.queueDepth ?? 0}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.preventDefault();
                      props.onStartDaemon();
                    }}
                    disabled={props.actionBusy}
                    className="h-8 rounded border border-zinc-700 bg-zinc-800/80 px-3 text-xs text-zinc-200 transition-colors hover:bg-zinc-700/80 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Start daemon
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.preventDefault();
                      props.onStopDaemon();
                    }}
                    disabled={props.actionBusy}
                    className="h-8 rounded border border-red-600/70 bg-red-600/15 px-3 text-xs text-red-100 transition-colors hover:bg-red-600/25 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Stop daemon
                  </button>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3 space-y-3">
              <div className="text-sm font-medium text-zinc-100">
                Send control message
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                <label className="space-y-1 text-xs text-zinc-400">
                  <span>Type</span>
                  <input
                    value={controlType}
                    onChange={(event) => setControlType(event.target.value)}
                    className="w-full rounded border border-zinc-700 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-100 focus:outline-none"
                  />
                </label>
                <label className="space-y-1 text-xs text-zinc-400">
                  <span>Reason</span>
                  <input
                    value={controlReason}
                    onChange={(event) => setControlReason(event.target.value)}
                    className="w-full rounded border border-zinc-700 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-100 focus:outline-none"
                  />
                </label>
              </div>
              <label className="block space-y-1 text-xs text-zinc-400">
                <span>Payload JSON</span>
                <textarea
                  value={controlPayload}
                  onChange={(event) => setControlPayload(event.target.value)}
                  spellCheck={false}
                  rows={10}
                  className="w-full rounded border border-zinc-700 bg-zinc-950/70 px-3 py-2 font-mono text-xs text-zinc-100 focus:outline-none"
                />
              </label>
              {controlError ? (
                <div className="rounded border border-red-800/60 bg-red-950/30 px-3 py-2 text-xs text-red-200">
                  {controlError}
                </div>
              ) : null}
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    submitControlMessage();
                  }}
                  disabled={props.actionBusy || !controlType.trim()}
                  className="h-8 rounded border border-cyan-600/70 bg-cyan-600/20 px-3 text-xs text-cyan-100 transition-colors hover:bg-cyan-600/30 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Send control message
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {activeTab === "raw" ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/70">
            <div className="border-b border-zinc-800/80 px-3 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-zinc-100">
                  Workflow JSON
                </span>
                <HistoryBadge label="syntax highlighted" tone="info" />
                <HistoryBadge label="exact content" />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
                <span>{rawJsonLineCount} line(s)</span>
                {rawJsonStructureSummary ? (
                  <span>{rawJsonStructureSummary}</span>
                ) : null}
                <span>
                  Long lines wrap visually and still scroll on demand.
                </span>
              </div>
            </div>
            <JsonSyntaxView
              value={workflow.raw}
              maxHeightClassName="max-h-[70vh] lg:max-h-[40rem]"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

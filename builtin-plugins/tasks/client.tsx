import { useState, useEffect } from "react";
import { Files, Terminal } from "lucide-react";
import BackgroundTerminals from "../../web/components/background-terminals";
import { AnsiText } from "../../web/components/tool-renderers/ansi-text";
import { RightPaneIcon } from "../../web/components/deepseek/right-pane-icons";
import EmptyState from "../right-pane/empty-state";
import type { RightPaneToolProps } from "../right-pane/types";
const EMPTY_REFRESH = () => {};
function getTailTruncatedPath(path: string, maxChars = 84): string {
  if (path.length <= maxChars) {
    return path;
  }

  return `...${path.slice(-(maxChars - 3))}`;
}
function renderTerminalOutput(
  selectedTerminalRunId: string | null,
  output: string,
  loading: boolean,
  error: string | null,
) {
  if (!selectedTerminalRunId) {
    return <EmptyState text="Select a task to inspect its output." />;
  }

  if (loading) {
    return <EmptyState text="Loading task output..." />;
  }

  if (error) {
    return <EmptyState text={error} />;
  }

  if (!output.trim()) {
    return <EmptyState text="No task output captured yet." />;
  }

  return (
    <div className="h-full overflow-auto p-3">
      <pre className="text-[11px] leading-5 text-zinc-200 whitespace-pre-wrap break-words font-mono">
        <AnsiText text={output} />
      </pre>
    </div>
  );
}
export default function TasksView(props: RightPaneToolProps) {
  const {
    sessionId,
    fileTreeNodesData,
    terminalRuns,
    terminalRunsLoading,
    terminalRunsError,
    selectedTerminalRunId,
    terminalRunOutput,
    terminalRunOutputLoading,
    terminalRunOutputError,
    onSelectTerminalRun,
    onRefreshTerminalRuns,
    agentThreads = [],
    agentThreadsLoading = false,
    agentThreadsError = null,
    onRefreshAgentThreads = EMPTY_REFRESH,
    onOpenAgentThread = EMPTY_REFRESH,
  } = props;
  const [isBackgroundCommandsOpen, setIsBackgroundCommandsOpen] =
    useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  useEffect(() => {
    if (!props.threadId || props.threadId !== sessionId) {
      return;
    }
    onRefreshAgentThreads();
  }, [onRefreshAgentThreads, props.threadId, sessionId]);
  const selectedTerminalRun =
    terminalRuns.find((run) => run.processId === selectedTerminalRunId) ?? null;
  const directAgentThreads = agentThreads
    .filter((thread) => thread.parentThreadId === sessionId)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const selectedTask =
    directAgentThreads.find((thread) => thread.threadId === selectedTaskId) ??
    null;
  const workspaceLabel =
    fileTreeNodesData?.projectPath?.split(/[\\/]/).filter(Boolean).at(-1) ??
    props.workspacePath?.split(/[\\/]/).filter(Boolean).at(-1) ??
    "Workspace";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="right-pane__page-row">
        <strong>Tasks</strong>
        <span>·</span>
        <span>{workspaceLabel}</span>
        <span className="right-pane__fill" />
        <button
          type="button"
          className="right-pane__icon-button"
          aria-label="Refresh"
          title="Refresh"
          onClick={onRefreshAgentThreads}
        >
          <RightPaneIcon name="refresh" />
        </button>
      </div>
      {agentThreadsError ? (
        <div className="right-pane__task-empty">
          <span>{agentThreadsError}</span>
        </div>
      ) : !props.threadId && terminalRunsError ? (
        <div className="right-pane__task-empty">
          <span>{terminalRunsError}</span>
        </div>
      ) : agentThreadsLoading ? (
        <div className="right-pane__task-empty">
          <span>Loading subagents…</span>
        </div>
      ) : directAgentThreads.length === 0 ? (
        <div className="right-pane__task-empty">
          <span>No subagents</span>
          <span>Subagents spawned under the main agent will appear here</span>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="right-pane__task-list" role="list">
            {directAgentThreads.map((thread) => (
              <button
                key={thread.threadId}
                type="button"
                className="right-pane__task-row"
                role="listitem"
                aria-current={selectedTaskId === thread.threadId}
                onClick={() => setSelectedTaskId(thread.threadId)}
              >
                <span
                  className="right-pane__task-status"
                  data-running={thread.status === "active"}
                  aria-hidden="true"
                />
                <span className="right-pane__task-name">
                  {thread.name ||
                    thread.agentNickname ||
                    thread.agentRole ||
                    thread.preview ||
                    "Subagent"}
                </span>
                <span className="right-pane__count">
                  {thread.status === "active" ? "running" : thread.status}
                </span>
              </button>
            ))}
          </div>
          <div className="right-pane__task-list">
            {selectedTask ? (
              <article className="space-y-3 p-4">
                <div className="flex items-start gap-3">
                  <span
                    className="right-pane__task-status mt-1.5"
                    data-running={selectedTask.status === "active"}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-medium">
                      {selectedTask.name ||
                        selectedTask.agentNickname ||
                        selectedTask.agentRole ||
                        "Subagent"}
                    </h2>
                    <p className="mt-1 text-xs text-zinc-500">
                      {selectedTask.agentRole || "Subagent"} ·{" "}
                      {selectedTask.status}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="right-pane__icon-button"
                    onClick={() => onOpenAgentThread(selectedTask.threadId)}
                    aria-label="Open subagent conversation"
                    title="Open conversation"
                  >
                    <Files aria-hidden="true" />
                  </button>
                </div>
                <p className="whitespace-pre-wrap break-words text-xs leading-5 text-zinc-500">
                  {selectedTask.preview ||
                    "This subagent has not sent a message yet."}
                </p>
              </article>
            ) : (
              <EmptyState text="Select a subagent to view its details." />
            )}
          </div>
        </div>
      )}
      {props.threadId ? (
        <details
          hidden={!isBackgroundCommandsOpen}
          className="right-pane__background-commands"
          open={isBackgroundCommandsOpen}
          onToggle={(event) =>
            setIsBackgroundCommandsOpen(event.currentTarget.open)
          }
        >
          <summary>Background commands ({terminalRuns.length})</summary>
          <BackgroundTerminals
            key={props.runtimeScopeKey + ":" + props.threadId}
            threadId={props.threadId}
            onChange={onRefreshTerminalRuns}
          />
          <button
            type="button"
            onClick={() => setIsBackgroundCommandsOpen(false)}
          >
            Back to tasks
          </button>
          {terminalRunsLoading ? (
            <EmptyState text="Loading commands…" />
          ) : terminalRunsError ? (
            <EmptyState text={terminalRunsError} />
          ) : (
            terminalRuns.map((run) => (
              <button
                key={run.processId}
                type="button"
                className="right-pane__task-row"
                onClick={() => onSelectTerminalRun(run.processId)}
              >
                <Terminal aria-hidden="true" />
                <span className="right-pane__task-name">
                  {getTailTruncatedPath(run.command)}
                </span>
                <span className="right-pane__count">
                  {run.isRunning ? "running" : "done"}
                </span>
              </button>
            ))
          )}
          {selectedTerminalRun
            ? renderTerminalOutput(
                selectedTerminalRunId,
                terminalRunOutput,
                terminalRunOutputLoading,
                terminalRunOutputError,
              )
            : null}
        </details>
      ) : null}
    </div>
  );
}

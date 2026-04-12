import test from "node:test";
import assert from "node:assert/strict";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ConversationMessage,
  WorkflowDaemonStatusResponse,
  WorkflowDetailResponse,
  WorkflowHistoryEntry,
  WorkflowLogResponse,
} from "../../api/storage";
import WorkflowView, {
  WorkflowHistoryEntryCard,
} from "../../web/components/workflow-view";

(globalThis as { React?: typeof React }).React = React;

function renderHistoryEntry(entry: WorkflowHistoryEntry): string {
  return renderToStaticMarkup(
    createElement(WorkflowHistoryEntryCard, {
      entry,
      onOpenSession: () => undefined,
      onSelectTask: () => undefined,
    }),
  );
}

function createWorkflowDetail(): WorkflowDetailResponse {
  return {
    summary: {
      key: "workflow-key",
      workflowPath: "/repo/.codex-deck/workflow-key.json",
      id: "workflow-key",
      title: "Workflow Key",
      status: "running",
      projectRoot: "/repo",
      projectName: "repo",
      targetBranch: "feature/current-default",
      updatedAt: "2026-03-28T12:00:00Z",
      createdAt: "2026-03-28T11:00:00Z",
      request: "Ship the workflow UI",
      boundSessionId: null,
      schedulerRunning: false,
      schedulerPendingTrigger: false,
      schedulerLastSessionId: "scheduler-session",
      schedulerThreadId: "scheduler-thread",
      schedulerLastReason: null,
      schedulerLastRunAt: null,
      schedulerLastTurnStatus: null,
      maxParallel: 2,
      mergePolicy: "integration-branch",
      taskCounts: {
        total: 1,
        cancelled: 0,
        failed: 0,
        pending: 0,
        running: 1,
        success: 0,
      },
      recentOutcomes: [],
    },
    boundSessionId: null,
    settings: {
      codexHome: null,
      codexCliPath: "codex",
      maxParallel: 2,
      mergePolicy: "integration-branch",
      stopSignal: "[codex-deck:stop-pending]",
    },
    scheduler: {
      running: false,
      pendingTrigger: false,
      lastRunAt: null,
      lastSessionId: "scheduler-session",
      threadId: "scheduler-thread",
      lastTurnId: null,
      lastTurnStatus: null,
      lastReason: null,
      controllerMode: null,
      controller: {},
      builtInPrompt: null,
      lastComposedPrompt: null,
      controlMessages: [],
    },
    tasks: [
      {
        id: "task-1",
        name: "Task 1",
        prompt: "Do the thing",
        dependsOn: [],
        status: "running",
        sessionId: null,
        branchName: "flow/workflow-key/task-1",
        worktreePath: null,
        baseCommit: null,
        resultCommit: null,
        startedAt: "2026-03-28T11:30:00Z",
        finishedAt: null,
        summary: null,
        failureReason: null,
        noOp: false,
        stopPending: false,
        runnerPid: 1234,
        ready: true,
      },
    ],
    history: [],
    raw: {
      workflow: {
        id: "workflow-key",
      },
      tasks: [],
    },
  };
}

function renderWorkflowView(
  workflow: WorkflowDetailResponse | null,
  options?: {
    daemonStatus?: WorkflowDaemonStatusResponse | null;
    logData?: WorkflowLogResponse | null;
    latestBoundSessionMessage?: ConversationMessage | null;
    latestBoundSessionMessageLoading?: boolean;
    loading?: boolean;
    error?: string | null;
  },
): string {
  return renderToStaticMarkup(
    createElement(WorkflowView, {
      workflow,
      daemonStatus: options?.daemonStatus ?? null,
      selectedTaskId: workflow?.tasks[0]?.id ?? null,
      latestBoundSessionMessage: options?.latestBoundSessionMessage ?? null,
      latestBoundSessionMessageLoading:
        options?.latestBoundSessionMessageLoading ?? false,
      loading: options?.loading ?? false,
      error: options?.error ?? null,
      logData: options?.logData ?? null,
      logLoading: false,
      logError: null,
      actionBusy: false,
      actionLabel: null,
      actionResultLabel: null,
      actionResultOutput: null,
      onChatInSession: () => undefined,
      onOpenSession: () => undefined,
      onSelectTask: () => undefined,
      onLaunchTask: () => undefined,
      onLoadLog: () => undefined,
      onStartDaemon: () => undefined,
      onStopDaemon: () => undefined,
      onSendControlMessage: () => undefined,
      onFilePathLinkClick: () => false,
    }),
  );
}

test("WorkflowHistoryEntryCard renders task and session references without dumping raw JSON", () => {
  const html = renderHistoryEntry({
    at: "2026-03-28T12:00:00Z",
    type: "task_session_attached",
    details: {
      taskId: "task-a",
      sessionId: "session-123",
    },
  });

  assert.match(html, /Task session attached/);
  assert.match(html, /task-a/);
  assert.match(html, /session-123/);
  assert.doesNotMatch(html, /&quot;taskId&quot;/);
  assert.doesNotMatch(html, /Other details/);
});

test("WorkflowHistoryEntryCard preserves unrecognized fields in fallback details", () => {
  const html = renderHistoryEntry({
    at: "2026-03-28T12:05:00Z",
    type: "workflow_control_message",
    details: {
      requestId: "req-7",
      applied: false,
      payload: {
        type: "add-task",
        reason: "operator request",
        task: {
          id: "task-b",
        },
      },
      retainedMetadata: {
        source: "manual",
        priority: 2,
      },
    },
  });

  assert.match(html, /Control message queued/);
  assert.match(html, /req-7/);
  assert.match(html, /Payload/);
  assert.match(html, /add-task/);
  assert.match(html, /operator request/);
  assert.match(html, /Other details/);
  assert.match(html, /retainedMetadata/);
  assert.match(html, /manual/);
});

test("WorkflowHistoryEntryCard renders daemon command history entries", () => {
  const html = renderHistoryEntry({
    at: "2026-03-28T12:10:00Z",
    type: "daemon_command_executed",
    details: {
      source: "task-runner",
      taskId: "task-c",
      cwd: "/repo/.codex-deck/worktrees/task-c",
      commandType: "exec",
      commandSummary: "codex exec --sandbox danger-full-access <prompt>",
    },
  });

  assert.match(html, /Daemon command executed/);
  assert.match(html, /task-runner/);
  assert.match(html, /task-c/);
  assert.match(html, /exec/);
  assert.match(html, /danger-full-access/);
});

test("WorkflowView renders both empty and populated workflow states", () => {
  const emptyHtml = renderWorkflowView(null);
  const populatedHtml = renderWorkflowView(createWorkflowDetail());

  assert.match(emptyHtml, /Select a workflow to inspect it/);
  assert.match(populatedHtml, /Workflow Key/);
  assert.match(populatedHtml, /Target branch:/);
  assert.match(populatedHtml, /feature\/current-default/);
});

test("WorkflowView renders the latest bound session message above the tab buttons", () => {
  const workflow = createWorkflowDetail();
  workflow.boundSessionId = "bound-session";
  workflow.summary.boundSessionId = "bound-session";

  const html = renderWorkflowView(workflow, {
    latestBoundSessionMessage: {
      type: "assistant",
      message: {
        role: "assistant",
        content: "Latest workflow reply",
      },
    },
  });

  const latestMessageIndex = html.indexOf("Latest session message");
  const overviewTabIndex = html.indexOf("Overview");

  assert.notEqual(latestMessageIndex, -1);
  assert.notEqual(overviewTabIndex, -1);
  assert.ok(latestMessageIndex < overviewTabIndex);
  assert.match(html, /Session bound-session/);
  assert.match(html, /Latest workflow reply/);
});

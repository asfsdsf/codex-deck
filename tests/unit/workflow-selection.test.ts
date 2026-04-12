import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowDetailResponse, WorkflowSummary } from "@codex-deck/api";
import {
  resolveSelectedWorkflowSummary,
  resolveWorkflowSelection,
} from "../../web/workflow-selection";

function createWorkflowSummary(key: string): WorkflowSummary {
  return {
    key,
    workflowPath: `/repo/.codex-deck/${key}.json`,
    id: key,
    title: `Workflow ${key}`,
    status: "running",
    projectRoot: "/repo/project-a",
    projectName: "project-a",
    targetBranch: "main",
    updatedAt: "2026-03-25T00:00:00.000Z",
    createdAt: "2026-03-25T00:00:00.000Z",
    request: "Do the work",
    boundSessionId: null,
    schedulerRunning: false,
    schedulerPendingTrigger: false,
    schedulerLastSessionId: "scheduler-session",
    schedulerThreadId: "scheduler-thread",
    schedulerLastReason: null,
    schedulerLastRunAt: null,
    schedulerLastTurnStatus: null,
    maxParallel: 1,
    mergePolicy: "integration-branch",
    taskCounts: {
      total: 1,
      pending: 1,
      running: 0,
      success: 0,
      failed: 0,
      cancelled: 0,
    },
    recentOutcomes: [],
  };
}

function createWorkflowDetail(key: string): WorkflowDetailResponse {
  const summary = createWorkflowSummary(key);
  return {
    summary,
    boundSessionId: null,
    settings: {
      codexHome: null,
      codexCliPath: "codex",
      maxParallel: 1,
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
    tasks: [],
    history: [],
    raw: {},
  };
}

test("workflow selection preserves the current workflow during an in-flight refresh gap", () => {
  const detail = createWorkflowDetail("workflow-a");

  assert.deepEqual(
    resolveWorkflowSelection({
      workflows: [],
      selectedWorkflowKey: "workflow-a",
      workflowDetail: detail,
      actionBusy: true,
    }),
    {
      nextSelectedWorkflowKey: "workflow-a",
      shouldClearWorkflowDetail: false,
    },
  );
});

test("workflow selection clears the workflow once an empty result is confirmed after the action completes", () => {
  const detail = createWorkflowDetail("workflow-a");

  assert.deepEqual(
    resolveWorkflowSelection({
      workflows: [],
      selectedWorkflowKey: "workflow-a",
      workflowDetail: detail,
      actionBusy: false,
    }),
    {
      nextSelectedWorkflowKey: null,
      shouldClearWorkflowDetail: true,
    },
  );
});

test("workflow summary falls back to the current detail while the list catches up", () => {
  const detail = createWorkflowDetail("workflow-a");

  assert.equal(
    resolveSelectedWorkflowSummary([], "workflow-a", detail)?.title,
    "Workflow workflow-a",
  );
});

test("workflow summary prefers fresher workflow-list state for the selected workflow", () => {
  const detail = createWorkflowDetail("workflow-a");
  const fresherListSummary = {
    ...createWorkflowSummary("workflow-a"),
    updatedAt: "2026-03-25T00:05:00.000Z",
    schedulerRunning: true,
    schedulerLastSessionId: "scheduler-session-2",
    schedulerThreadId: "scheduler-thread-2",
  };

  const resolved = resolveSelectedWorkflowSummary(
    [fresherListSummary],
    "workflow-a",
    detail,
  );

  assert.equal(resolved?.schedulerRunning, true);
  assert.equal(resolved?.schedulerLastSessionId, "scheduler-session-2");
  assert.equal(resolved?.schedulerThreadId, "scheduler-thread-2");
});

test("workflow selection switches to the first available workflow when the current one is actually gone", () => {
  const detail = createWorkflowDetail("workflow-a");

  assert.deepEqual(
    resolveWorkflowSelection({
      workflows: [createWorkflowSummary("workflow-b")],
      selectedWorkflowKey: "workflow-a",
      workflowDetail: detail,
      actionBusy: false,
    }),
    {
      nextSelectedWorkflowKey: "workflow-b",
      shouldClearWorkflowDetail: false,
    },
  );
});

test("workflow selection preserves a newly created workflow until the list catches up", () => {
  const previousDetail = createWorkflowDetail("workflow-a");

  assert.deepEqual(
    resolveWorkflowSelection({
      workflows: [createWorkflowSummary("workflow-a")],
      selectedWorkflowKey: "workflow-new",
      pendingWorkflowKey: "workflow-new",
      workflowDetail: previousDetail,
      actionBusy: false,
    }),
    {
      nextSelectedWorkflowKey: "workflow-new",
      shouldClearWorkflowDetail: false,
    },
  );
});

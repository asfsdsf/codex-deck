import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowSummary } from "@codex-deck/api";
import { areWorkflowCollectionsVisiblyEquivalent } from "../../web/workflow-list";

function createWorkflowSummary(
  overrides: Partial<WorkflowSummary> = {},
): WorkflowSummary {
  return {
    key: "workflow-a",
    workflowPath: "/repo/.codex-deck/workflow-a.json",
    id: "workflow-a",
    title: "Workflow A",
    status: "running",
    projectRoot: "/repo",
    projectName: "repo",
    targetBranch: "main",
    updatedAt: "2026-03-26T00:00:10.000Z",
    createdAt: "2026-03-25T00:00:00.000Z",
    request: "Ship it",
    boundSessionId: null,
    schedulerRunning: true,
    schedulerPendingTrigger: false,
    schedulerLastSessionId: "session-a",
    schedulerThreadId: "thread-a",
    schedulerLastReason: "manual",
    schedulerLastRunAt: "2026-03-26T00:00:10.000Z",
    schedulerLastTurnStatus: "running",
    maxParallel: 2,
    mergePolicy: "squash",
    taskCounts: {
      total: 3,
      cancelled: 0,
      failed: 0,
      pending: 1,
      running: 1,
      success: 1,
    },
    recentOutcomes: [],
    ...overrides,
  };
}

test("workflow list equivalence ignores updatedAt churn within the same visible time bucket", () => {
  const current = [createWorkflowSummary()];
  const next = [
    createWorkflowSummary({
      updatedAt: "2026-03-26T00:00:40.000Z",
      schedulerLastRunAt: "2026-03-26T00:00:40.000Z",
      request: "Changed internal metadata only",
    }),
  ];

  assert.equal(
    areWorkflowCollectionsVisiblyEquivalent(
      current,
      next,
      Date.parse("2026-03-26T00:00:50.000Z"),
    ),
    true,
  );
});

test("workflow list equivalence detects visible sidebar changes", () => {
  const current = [createWorkflowSummary()];
  const next = [
    createWorkflowSummary({
      taskCounts: {
        total: 3,
        cancelled: 0,
        failed: 1,
        pending: 0,
        running: 0,
        success: 2,
      },
    }),
  ];

  assert.equal(
    areWorkflowCollectionsVisiblyEquivalent(
      current,
      next,
      Date.parse("2026-03-26T00:00:50.000Z"),
    ),
    false,
  );
});

test("workflow list equivalence detects visible relative-time bucket changes", () => {
  const current = [createWorkflowSummary()];
  const next = [createWorkflowSummary()];

  assert.equal(
    areWorkflowCollectionsVisiblyEquivalent(
      current,
      next,
      Date.parse("2026-03-26T01:10:00.000Z"),
    ),
    true,
  );

  assert.equal(
    areWorkflowCollectionsVisiblyEquivalent(
      current,
      [
        createWorkflowSummary({
          updatedAt: "2026-03-26T01:09:30.000Z",
        }),
      ],
      Date.parse("2026-03-26T01:10:00.000Z"),
    ),
    false,
  );
});

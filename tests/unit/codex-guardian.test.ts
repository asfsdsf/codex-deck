import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import {
  GuardianReviewStore,
  guardianActionSummary,
  toGuardianAssessmentEvent,
} from "../../api/codex-guardian";
import { OperationalNotificationStore } from "../../api/operational-notifications";
import { registerWorkspaceRoutes } from "../../api/server/workspace-routes";

function started(reviewId: string, action: Record<string, unknown>) {
  return {
    threadId: "t",
    turnId: "turn-1",
    startedAtMs: 10,
    reviewId,
    targetItemId: "item-1",
    review: {
      status: "inProgress",
      riskLevel: null,
      userAuthorization: null,
      rationale: null,
    },
    action,
  };
}

function completed(
  reviewId: string,
  action: Record<string, unknown>,
  status = "denied",
) {
  return {
    ...started(reviewId, action),
    completedAtMs: 30,
    decisionSource: "agent",
    review: {
      status,
      riskLevel: "high",
      userAuthorization: "low",
      rationale: "Deletes files outside the workspace",
    },
  };
}

const command = {
  type: "command",
  source: "unifiedExec",
  command: "rm -rf /tmp/x",
  cwd: "/repo",
};

test("auto-review summaries follow upstream wording", () => {
  assert.equal(guardianActionSummary(command), "rm -rf /tmp/x");
  assert.equal(
    guardianActionSummary({
      type: "execve",
      program: "git",
      argv: ["git", "commit", "-m", "two words"],
    }),
    "git commit -m 'two words'",
  );
  assert.equal(
    guardianActionSummary({ type: "applyPatch", files: ["a", "b"] }),
    "apply_patch touching 2 files",
  );
  assert.equal(
    guardianActionSummary({
      type: "mcpToolCall",
      server: "srv",
      toolName: "run",
      connectorName: null,
    }),
    "MCP run on srv",
  );
  assert.equal(
    guardianActionSummary({ type: "networkAccess", target: "example.com" }),
    "network access to example.com",
  );
});

test("guardian store retains progress, decisions, strict review, and serializes retries", async () => {
  const notified: string[] = [];
  const calls: Array<[string, Record<string, unknown>]> = [];
  let release: (() => void) | null = null;
  const store = new GuardianReviewStore(
    async (method, params) => {
      calls.push([method, params]);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {};
    },
    (id) => notified.push(id),
  );
  assert.equal(
    store.handleNotification(
      "item/autoApprovalReview/started",
      started("r1", command),
    ),
    true,
  );
  assert.equal(store.snapshot("t").reviews[0].status, "inProgress");
  store.handleNotification(
    "item/autoApprovalReview/completed",
    completed("r1", command),
  );
  // A late in-progress event never regresses a completed review.
  store.handleNotification(
    "item/autoApprovalReview/started",
    started("r1", command),
  );
  store.handleNotification("autoApprovalReview/strictReviewRequired", {
    threadId: "t",
    turnId: "turn-1",
    startedAtMs: 5,
  });
  let snapshot = store.snapshot("t");
  assert.equal(snapshot.reviews.length, 1);
  assert.equal(snapshot.reviews[0].status, "denied");
  assert.equal(snapshot.denials.length, 1);
  assert.deepEqual(snapshot.strictReview, { turnId: "turn-1", startedAtMs: 5 });
  assert.equal(
    store.handleNotification("turn/completed", { threadId: "t" }),
    false,
  );
  assert.equal(store.snapshot("t").strictReview, null);

  const first = store.approveDenial("t", "r1");
  await assert.rejects(store.approveDenial("t", "r1"), /no longer available/);
  release!();
  snapshot = await first;
  assert.equal(snapshot.denials.length, 0);
  assert.ok(snapshot.reviews[0].retryApprovedAt);
  await assert.rejects(store.approveDenial("t", "r1"), /no longer available/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "thread/approveGuardianDeniedAction");
  assert.deepEqual(calls[0][1].event, {
    id: "r1",
    target_item_id: "item-1",
    turn_id: "turn-1",
    started_at_ms: 10,
    completed_at_ms: 30,
    status: "denied",
    risk_level: "high",
    user_authorization: "low",
    rationale: "Deletes files outside the workspace",
    decision_source: "agent",
    action: {
      type: "command",
      source: "unified_exec",
      command: "rm -rf /tmp/x",
      cwd: "/repo",
    },
  });
  assert.ok(notified.every((id) => id === "t"));
});

test("guardian events convert nested actions to core snake_case", () => {
  const event = toGuardianAssessmentEvent({
    reviewId: "r",
    threadId: "t",
    turnId: "u",
    targetItemId: null,
    status: "denied",
    riskLevel: null,
    userAuthorization: null,
    rationale: null,
    decisionSource: null,
    startedAtMs: 1,
    completedAtMs: null,
    action: {
      type: "writeStdin",
      approvalId: "a",
      processId: "p",
      stdin: "y",
      cwd: "/repo",
    },
    summary: "",
    retryApprovedAt: null,
  });
  assert.deepEqual(event.action, {
    type: "write_stdin",
    approval_id: "a",
    process_id: "p",
    stdin: "y",
    cwd: "file:///repo",
  });
});

test("guardian warnings join operational notices but approvals stay hidden", () => {
  const store = new OperationalNotificationStore();
  assert.ok(
    store.record("guardianWarning", { threadId: "t", message: "Careful" }),
  );
  assert.equal(
    store.record("guardianWarning", {
      threadId: "t",
      message: "Automatic approval review approved (low risk)",
    }),
    null,
  );
});

test("auto-review routes expose snapshots and map stale retries to 409", async () => {
  const store = new GuardianReviewStore(
    async () => ({}),
    () => {},
  );
  const app = new Hono();
  registerWorkspaceRoutes(app, {
    getClient: () => ({
      readGuardianReviews: (id) => store.snapshot(id),
      approveGuardianDenial: (id, reviewId) =>
        store.approveDenial(id, reviewId),
    }),
  });
  const read = await app.request("/api/codex/threads/t/auto-review");
  assert.equal(read.status, 200);
  const stale = await app.request(
    "/api/codex/threads/t/auto-review/x/approve",
    {
      method: "POST",
    },
  );
  assert.equal(stale.status, 409);
});

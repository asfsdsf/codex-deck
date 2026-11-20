import assert from "node:assert/strict";
import test from "node:test";
import { __TEST_ONLY__ } from "../../api/codex-app-server";

test("concurrent answers to the same approval send only one response", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const internals = client as unknown as {
    pendingApprovalRequests: Map<string, Record<string, unknown>>;
    respondToServerRequest: (
      id: string | number,
      value: unknown,
    ) => Promise<void>;
  };
  internals.pendingApprovalRequests.set("7", {
    requestId: "7",
    rawRequestId: 7,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    kind: "commandExecution",
    reason: null,
    command: "ls",
    cwd: "/tmp",
    permissions: null,
    availableDecisions: [
      { id: "accept", label: "Allow once", decision: "accept" },
      { id: "decline", label: "Deny", decision: "decline" },
    ],
  });

  const responses: unknown[] = [];
  let completeWrite!: () => void;
  internals.respondToServerRequest = async (id, value) => {
    responses.push({ id, value });
    await new Promise<void>((resolve) => {
      completeWrite = resolve;
    });
  };

  try {
    const first = client.submitApproval("thread-1", "7", {
      decisionId: "accept",
    });
    await assert.rejects(
      client.submitApproval("thread-1", "7", { decisionId: "decline" }),
      /already in progress/,
    );
    completeWrite();
    await first;
    assert.deepEqual(responses, [{ id: 7, value: { decision: "accept" } }]);
    assert.equal(internals.pendingApprovalRequests.has("7"), false);
    await assert.rejects(
      client.submitApproval("thread-1", "7", { decisionId: "accept" }),
      /request not found/,
    );
  } finally {
    await client.close();
  }
});

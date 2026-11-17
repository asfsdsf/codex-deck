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

test("human checkpoints preserve their kind, restrict decisions, and broadcast their lifecycle", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const internal = client as any;
  const events: any[] = [];
  const responses: unknown[] = [];
  client.subscribeAppServerEvents((event) => events.push(event));
  internal.respondToServerRequest = async (id: unknown, result: unknown) => {
    responses.push({ id, result });
  };
  const receive = (id: number, decisions?: unknown[]) =>
    internal.handleApprovalRequest(
      id,
      "item/commandExecution/requestApproval",
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "no-execution-item",
        kind: "humanCommand",
        command: "echo checkpoint",
        availableDecisions: decisions,
      },
    );
  try {
    receive(1, [
      "accept",
      "acceptForSession",
      { acceptWithExecpolicyAmendment: {} },
      "decline",
      "cancel",
    ]);
    const request = client.listPendingApprovalRequests("thread-1")[0];
    assert.equal(request.kind, "humanCommand");
    assert.deepEqual(
      request.availableDecisions.map((option) => option.id),
      ["accept", "decline", "cancel"],
    );
    await assert.rejects(
      client.submitApproval("thread-1", "1", {
        decisionId: "acceptForSession",
      }),
      /one-time/,
    );
    await client.submitApproval("thread-1", "1", { decisionId: "accept" });
    assert.deepEqual(responses, [{ id: 1, result: { decision: "accept" } }]);
    receive(2);
    assert.deepEqual(
      client
        .listPendingApprovalRequests("thread-1")[0]
        .availableDecisions.map((option) => option.id),
      ["accept", "decline", "cancel"],
    );
    internal.handleServerNotification("serverRequest/resolved", {
      requestId: 2,
    });
    assert.deepEqual(client.listPendingApprovalRequests("thread-1"), []);
    receive(3);
    internal.handleProcessExit("disconnected");
    assert.deepEqual(client.listPendingApprovalRequests("thread-1"), []);
    assert.deepEqual(
      events
        .filter((event) => event.type === "approval_requests_changed")
        .map((event) => [event.requestId, event.pending]),
      [
        ["1", true],
        ["1", false],
        ["2", true],
        ["2", false],
        ["3", true],
        ["3", false],
      ],
    );
    // A replay after reconnect is actionable again with its original callback ID.
    receive(2);
    await client.submitApproval("thread-1", "2", { decisionId: "decline" });
    assert.deepEqual(responses.at(-1), {
      id: 2,
      result: { decision: "decline" },
    });
  } finally {
    await client.close();
  }
});

test("initialize advertises support for managed human approval", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const internal = client as any;
  let capabilities: any;
  internal.requestRaw = async (_method: string, params: any) => {
    capabilities = params.capabilities;
    return {};
  };
  internal.writeMessage = async () => {};
  try {
    await internal.ensureInitialized();
    assert.equal(capabilities.experimentalApi, true);
    assert.equal(capabilities.requiredHumanApproval, true);
  } finally {
    await client.close();
  }
});

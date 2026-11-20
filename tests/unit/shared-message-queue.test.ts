import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import {
  CodexAppServerRpcError,
  __TEST_ONLY__,
} from "../../api/codex-app-server";
import {
  addThreadQueueMessage,
  isUnsupportedThreadQueueError,
  listThreadQueue,
  moveQueueItemId,
  moveThreadQueueMessage,
  parseQueueInputItems,
  parseQueuedSubmission,
  rebuildQueuedInput,
  startThreadQueueMessage,
  updateThreadQueueMessage,
} from "../../api/codex-thread-queue";
import { registerThreadQueueRoutes } from "../../api/server/thread-queue-routes";
import {
  mergeSharedQueueIntoPending,
  sharedQueueCaption,
  sharedQueueItemIdFromPendingId,
  sharedQueuePendingId,
  shouldUseSharedQueue,
} from "../../web/shared-message-queue";

const item = (id: string, text = id) => ({
  id,
  input: [{ type: "text", text, text_elements: [] }],
  clientUserMessageId: `client-${id}`,
});

test("queued submissions parse text, images and labelled non-text input", () => {
  assert.deepEqual(
    parseQueuedSubmission({
      id: "q1",
      clientUserMessageId: "c1",
      input: [
        { type: "text", text: "hello" },
        { type: "image", url: "data:image/png;base64,AA" },
        { type: "skill", name: "deploy", path: "/s" },
      ],
    }),
    {
      id: "q1",
      text: "hello\n$deploy",
      images: ["data:image/png;base64,AA"],
      clientUserMessageId: "c1",
    },
  );
  assert.equal(parseQueuedSubmission({ id: "", input: [] }), null);
  assert.equal(parseQueuedSubmission({ id: "x" }), null);
});

test("queue input validation and edits keep non-text items", () => {
  assert.equal(parseQueueInputItems([]), null);
  assert.equal(parseQueueInputItems([{ type: "audio", url: "x" }]), null);
  assert.deepEqual(parseQueueInputItems([{ type: "text", text: "hi" }]), [
    { type: "text", text: "hi" },
  ]);
  assert.deepEqual(
    rebuildQueuedInput(
      [
        { type: "text", text: "old" },
        { type: "image", url: "u" },
      ],
      " new ",
    ),
    [
      { type: "text", text: "new", text_elements: [] },
      { type: "image", url: "u" },
    ],
  );
  assert.throws(() => rebuildQueuedInput([], "  "), /text is required/);
});

test("older app-servers are detected as lacking the shared queue", async () => {
  assert.equal(
    isUnsupportedThreadQueueError(new CodexAppServerRpcError(-32601, "nope")),
    true,
  );
  assert.equal(
    isUnsupportedThreadQueueError(
      new CodexAppServerRpcError(
        -32600,
        "Invalid request: unknown variant `thread/queue/list`, expected one of",
      ),
    ),
    true,
  );
  assert.equal(
    isUnsupportedThreadQueueError(
      new CodexAppServerRpcError(-32600, "user message queue is unavailable"),
    ),
    true,
  );
  assert.equal(
    isUnsupportedThreadQueueError(
      new CodexAppServerRpcError(-32600, "thread not found"),
    ),
    false,
  );
  assert.deepEqual(
    await listThreadQueue(async () => {
      throw new CodexAppServerRpcError(-32601, "Method not found");
    }, "t"),
    { supported: false, items: [] },
  );
});

test("queue listing paginates and mutations send upstream shapes", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const rpc = async (method: string, params: Record<string, unknown>) => {
    calls.push([method, params]);
    if (method === "thread/queue/list") {
      return params.cursor
        ? { data: [item("b")], nextCursor: null }
        : { data: [item("a")], nextCursor: "1" };
    }
    if (method === "thread/queue/add" || method === "thread/queue/update") {
      return { queuedSubmission: { id: "a", input: params.input } };
    }
    if (method === "thread/queue/start") {
      return { turn: { id: "turn-9", status: "inProgress" } };
    }
    return {};
  };
  const snapshot = await listThreadQueue(rpc, "t");
  assert.deepEqual(
    snapshot.items.map((entry) => entry.id),
    ["a", "b"],
  );

  calls.length = 0;
  await addThreadQueueMessage(rpc, "t", [{ type: "text", text: " x " }], "c");
  assert.deepEqual(calls[0], [
    "thread/queue/add",
    {
      threadId: "t",
      input: [{ type: "text", text: "x", text_elements: [] }],
      clientUserMessageId: "c",
    },
  ]);

  calls.length = 0;
  const updated = await updateThreadQueueMessage(rpc, "t", "a", "edited");
  assert.equal(updated.text, "edited");
  assert.equal(calls.at(-1)?.[0], "thread/queue/update");
  await assert.rejects(
    updateThreadQueueMessage(rpc, "t", "missing", "x"),
    /not found/,
  );

  // Moves use a fresh listing and send every id exactly once.
  calls.length = 0;
  assert.equal(await moveThreadQueueMessage(rpc, "t", "b", "up"), true);
  assert.deepEqual(calls.at(-1), [
    "thread/queue/reorder",
    { threadId: "t", queuedSubmissionIds: ["b", "a"] },
  ]);
  assert.equal(await moveThreadQueueMessage(rpc, "t", "a", "up"), false);
  assert.deepEqual(moveQueueItemId(["a", "b", "c"], "b", "down"), [
    "a",
    "c",
    "b",
  ]);

  assert.deepEqual(await startThreadQueueMessage(rpc, "t", "a"), {
    turnId: "turn-9",
  });
});

test("queue changes broadcast to every client and mutations refresh peers", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const internal = client as unknown as {
    request: (m: string, p: Record<string, unknown>) => Promise<unknown>;
    ensureConnected: () => Promise<void>;
    ensureInitialized: () => Promise<void>;
    handleServerNotification: (method: string, params: unknown) => void;
    resumeThread: (id: string) => Promise<void>;
  };
  const resumed: string[] = [];
  let loaded = false;
  internal.ensureConnected = async () => {};
  internal.ensureInitialized = async () => {};
  internal.resumeThread = async (id) => {
    resumed.push(id);
    loaded = true;
  };
  internal.request = async (method) => {
    if (method === "thread/queue/start" && !loaded) {
      throw new CodexAppServerRpcError(
        -32600,
        "resume the thread before starting a queued message",
      );
    }
    return { turn: { id: "turn-1" } };
  };
  const events: Array<Record<string, unknown>> = [];
  client.subscribeAppServerEvents((event) =>
    events.push(event as unknown as Record<string, unknown>),
  );
  internal.handleServerNotification("thread/queue/changed", {
    threadId: "t",
  });
  assert.equal(events[0]?.type, "native_state_changed");
  assert.equal(events[0]?.scope, "queue");
  assert.equal(events[0]?.threadId, "t");

  const result = await client.mutateThreadQueue("t", (rpc) =>
    startThreadQueueMessage(rpc, "t", "q1"),
  );
  assert.deepEqual(result, { turnId: "turn-1" });
  assert.deepEqual(resumed, ["t"]);
  assert.equal(events.at(-1)?.scope, "queue");
  await client.close();
});

test("queue routes validate bodies and report unsupported servers for fallback", async () => {
  const woke: string[] = [];
  const calls: string[] = [];
  const app = new Hono();
  registerThreadQueueRoutes(app, {
    wake: (id) => woke.push(id),
    getClient: () => ({
      listThreadQueue: async () => ({ supported: true, items: [] }),
      addThreadQueueMessage: async () => {
        throw new CodexAppServerRpcError(-32601, "Method not found");
      },
      moveThreadQueueMessage: async (_t, id, direction) => {
        calls.push(`${id}:${direction}`);
        return true;
      },
      startThreadQueueMessage: async () => ({ turnId: "turn-2" }),
    }),
  });
  const json = (body: unknown, method = "POST") => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const added = await app.request(
    "/api/codex/threads/t/queue",
    json({ input: [{ type: "text", text: "hi" }] }),
  );
  assert.equal(added.status, 200);
  assert.deepEqual(await added.json(), { supported: false });

  const invalid = await app.request(
    "/api/codex/threads/t/queue",
    json({ input: "hi" }),
  );
  assert.equal(invalid.status, 400);

  const badMove = await app.request(
    "/api/codex/threads/t/queue/q1/move",
    json({ direction: "left" }),
  );
  assert.equal(badMove.status, 400);
  const move = await app.request(
    "/api/codex/threads/t/queue/q1/move",
    json({ direction: "down" }),
  );
  assert.deepEqual(await move.json(), { moved: true });
  assert.deepEqual(calls, ["q1:down"]);

  const noText = await app.request(
    "/api/codex/threads/t/queue/q1",
    json({ text: " " }, "PATCH"),
  );
  assert.equal(noText.status, 400);

  const reorder = await app.request(
    "/api/codex/threads/t/queue/reorder",
    json({ ids: ["a", "a"] }),
  );
  assert.equal(reorder.status, 400);

  const start = await app.request("/api/codex/threads/t/queue/q1/start", {
    method: "POST",
  });
  assert.deepEqual(await start.json(), { ok: true, turnId: "turn-2" });
  assert.deepEqual(woke, ["t"]);
});

test("browser merges the server queue after local pending messages", () => {
  const local = [
    {
      pendingId: "l1",
      text: "sending",
      images: [],
      status: "awaiting_confirmation" as const,
    },
  ];
  const merged = mergeSharedQueueIntoPending(local, [
    { id: "q1", text: "queued", images: [], clientUserMessageId: null },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].pendingId, sharedQueuePendingId("q1"));
  assert.equal(merged[1].status, "queued");
  assert.equal(merged[1].sharedQueueId, "q1");
  assert.equal(sharedQueueItemIdFromPendingId(merged[1].pendingId), "q1");
  assert.equal(sharedQueueItemIdFromPendingId("l1"), null);
  assert.equal(mergeSharedQueueIntoPending(local, []), local);

  assert.equal(
    shouldUseSharedQueue({ supported: null, hasSendOverrides: false }),
    true,
  );
  assert.equal(
    shouldUseSharedQueue({ supported: false, hasSendOverrides: false }),
    false,
  );
  assert.equal(
    shouldUseSharedQueue({ supported: true, hasSendOverrides: true }),
    false,
  );
  assert.match(sharedQueueCaption({ turnActive: true }), /current turn/);
  assert.match(sharedQueueCaption({ turnActive: false }), /Send now/);
});

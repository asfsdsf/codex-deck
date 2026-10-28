import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import {
  __TEST_ONLY__,
  CodexAppServerRpcError,
} from "../../api/codex-app-server";
import {
  ThreadReadStateService,
  parseThreadReadState,
} from "../../api/codex-read-state";
import { registerOrganizationRoutes } from "../../api/server/organization-routes";
import {
  applyReadStateResult,
  getReadReceipt,
  resolveSessionReadStatus,
  shouldAutoMarkRead,
} from "../../web/thread-read-state";

const unread = (revision: string) => ({
  firstUnread: { type: "turn" as const, turnId: "turn-1" },
  revision,
});

test("read-state parsing accepts upstream positions and rejects malformed rows", () => {
  assert.deepEqual(parseThreadReadState({ firstUnread: null, revision: "r" }), {
    firstUnread: null,
    revision: "r",
  });
  assert.deepEqual(
    parseThreadReadState({
      firstUnread: { type: "threadStart" },
      revision: "r",
    })?.firstUnread,
    { type: "threadStart" },
  );
  assert.equal(parseThreadReadState({ firstUnread: null }), null);
  assert.equal(
    parseThreadReadState({ firstUnread: { type: "turn" }, revision: "r" }),
    null,
  );
});

test("read-state listing paginates state-DB rows, caches briefly, and reports unsupported servers", async () => {
  const calls: Record<string, unknown>[] = [];
  let now = 0;
  const service = new ThreadReadStateService(
    async (method, params) => {
      assert.equal(method, "thread/list");
      calls.push(params);
      return params.cursor
        ? { data: [], readStates: { b: unread("rb") }, nextCursor: null }
        : {
            data: [],
            readStates: { a: { firstUnread: null, revision: "ra" }, bad: {} },
            nextCursor: "page2",
          };
    },
    () => undefined,
    () => now,
  );
  const snapshot = await service.list();
  assert.equal(snapshot.available, true);
  assert.deepEqual(Object.keys(snapshot.states).sort(), ["a", "b"]);
  assert.equal(calls[0].useStateDbOnly, true);
  assert.equal(calls[1].cursor, "page2");
  await service.list();
  assert.equal(calls.length, 2, "cached within the TTL");
  now = 5_000;
  await service.list();
  assert.equal(calls.length, 4);

  const legacy = new ThreadReadStateService(
    async () => ({ data: [], nextCursor: null }),
    () => undefined,
  );
  assert.deepEqual(await legacy.list(), { available: false, states: {} });
  const missing = new ThreadReadStateService(
    async () => {
      throw new CodexAppServerRpcError(-32601, "method not found");
    },
    () => undefined,
  );
  assert.equal((await missing.list()).available, false);
});

test("read-state updates send the seen revision and accept conflicts without retrying", async () => {
  const sent: Record<string, unknown>[] = [];
  const notified: (string | null)[] = [];
  let mode: "ok" | "conflict" | "unsupported" = "ok";
  const service = new ThreadReadStateService(
    async (method, params) => {
      assert.equal(method, "thread/readState/update");
      sent.push(params);
      if (mode === "conflict")
        throw new CodexAppServerRpcError(-32600, "read state changed", {
          reason: "readStateConflict",
          readState: unread("newer"),
        });
      if (mode === "unsupported")
        throw new CodexAppServerRpcError(
          -32600,
          "thread read state unavailable",
        );
      return { readState: { firstUnread: null, revision: "r2" } };
    },
    (id) => notified.push(id),
  );
  assert.deepEqual(await service.update("t", "read", "r1"), {
    status: "applied",
    readState: { firstUnread: null, revision: "r2" },
  });
  assert.deepEqual(sent[0], {
    threadId: "t",
    operation: { type: "read" },
    expectedRevision: "r1",
  });
  mode = "conflict";
  const conflict = await service.update("t", "unread", "r2");
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.readState?.revision, "newer");
  assert.equal(sent.length, 2, "conflicts are never retried automatically");
  mode = "unsupported";
  assert.equal((await service.update("t", "read", "x")).status, "unavailable");
  assert.deepEqual(notified, ["t", "t"]);
  assert.equal(
    service.handleNotification("thread/readState/changed", { threadId: "t" }),
    true,
  );
  assert.equal(service.handleNotification("thread/started", {}), false);
  assert.deepEqual(notified, ["t", "t", "t"]);
});

test("read-state notifications broadcast native state changes to every client", () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const events: unknown[] = [];
  client.subscribeAppServerEvents((event) => events.push(event));
  (
    client as unknown as {
      handleServerNotification: (method: string, params: unknown) => void;
    }
  ).handleServerNotification("thread/readState/changed", {
    threadId: "thread-1",
    readState: unread("r"),
  });
  assert.equal(events.length, 1);
  assert.deepEqual(
    {
      ...(events[0] as Record<string, unknown>),
      revision: undefined,
    },
    {
      type: "native_state_changed",
      scope: "readState",
      threadId: "thread-1",
      revision: undefined,
    },
  );
});

test("read-state routes validate operations and revisions", async () => {
  const updates: unknown[] = [];
  const app = new Hono();
  registerOrganizationRoutes(app, {
    getService: () =>
      ({
        readState: {
          list: async () => ({ available: true, states: {} }),
          update: async (...args: unknown[]) => {
            updates.push(args);
            return { status: "applied", readState: unread("r") };
          },
        },
      }) as never,
  });
  assert.equal((await app.request("/api/codex/read-states")).status, 200);
  const post = (body: unknown) =>
    app.request("/api/codex/threads/t1/read-state", {
      method: "POST",
      body: JSON.stringify(body),
    });
  assert.equal((await post({ operation: "toggle" })).status, 400);
  assert.equal((await post({ operation: "read" })).status, 400);
  assert.equal(
    (await post({ operation: "unread", expectedRevision: "r" })).status,
    200,
  );
  assert.deepEqual(updates, [["t1", "unread", "r"]]);
  const unavailable = new Hono();
  registerOrganizationRoutes(unavailable, { getService: () => null });
  assert.equal(
    (await unavailable.request("/api/codex/read-states")).status,
    501,
  );
});

test("session status prefers running turns, then shared receipts, then local markers", () => {
  const snapshot = {
    available: true,
    states: { a: unread("r"), b: { firstUnread: null, revision: "r" } },
  };
  assert.equal(getReadReceipt(snapshot, "a"), "unread");
  assert.equal(getReadReceipt(snapshot, "b"), "read");
  assert.equal(getReadReceipt(snapshot, "c"), null);
  assert.equal(getReadReceipt({ ...snapshot, available: false }, "a"), null);
  assert.equal(resolveSessionReadStatus("running", "unread"), "running");
  assert.equal(resolveSessionReadStatus("completed", "unread"), "unreviewed");
  assert.equal(resolveSessionReadStatus("unreviewed", "read"), "completed");
  assert.equal(resolveSessionReadStatus("unreviewed", null), "unreviewed");
  assert.equal(shouldAutoMarkRead(unread("r"), undefined, false), true);
  assert.equal(shouldAutoMarkRead(unread("r"), "r", false), false);
  assert.equal(shouldAutoMarkRead(unread("r"), undefined, true), false);
  assert.equal(
    shouldAutoMarkRead({ firstUnread: null, revision: "r" }, undefined, false),
    false,
  );
  assert.deepEqual(
    applyReadStateResult(snapshot, "a", {
      status: "unavailable",
      readState: null,
      message: "x",
    }),
    { available: false, states: {} },
  );
  assert.equal(
    applyReadStateResult(snapshot, "a", {
      status: "conflict",
      readState: unread("z"),
    }).states.a.revision,
    "z",
  );
});

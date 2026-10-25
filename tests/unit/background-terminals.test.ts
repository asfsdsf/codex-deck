import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import {
  __TEST_ONLY__,
  CodexAppServerRpcError,
} from "../../api/codex-app-server";
import { registerBackgroundTerminalRoutes } from "../../api/server/background-terminal-routes";
const terminal = (id: string) => ({
  itemId: `item-${id}`,
  processId: id,
  command: "sleep 100",
  cwd: "/repo",
  osPid: null,
  cpuPercent: null,
  rssKb: null,
});

test("background lists paginate, resume unloaded threads, and reject repeating cursors", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const calls: unknown[] = [];
  let loaded = false,
    resumed = 0;
  const internal = client as unknown as {
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
    resumeThread(id: string): Promise<void>;
  };
  internal.resumeThread = async (id) => {
    assert.equal(id, "thread");
    loaded = true;
    resumed++;
  };
  internal.request = async (method, params) => {
    assert.equal(method, "thread/backgroundTerminals/list");
    assert.equal(params.threadId, "thread");
    assert.equal(params.limit, 100);
    calls.push(params);
    if (!loaded) throw new CodexAppServerRpcError(-32000, "thread not loaded");
    return params.cursor
      ? { data: [terminal("2")], nextCursor: null }
      : { data: [terminal("1")], nextCursor: "page2" };
  };
  try {
    assert.deepEqual(await client.listBackgroundTerminals(" thread "), [
      terminal("1"),
      terminal("2"),
    ]);
    assert.equal(resumed, 1);
    assert.equal(calls.length, 3);
    internal.request = async () => ({ data: [], nextCursor: "again" });
    await assert.rejects(
      client.listBackgroundTerminals("thread"),
      /Repeated.*cursor/,
    );
    internal.request = async () => ({
      data: [{ processId: 3 }],
      nextCursor: null,
    });
    await assert.rejects(
      client.listBackgroundTerminals("thread"),
      /Invalid background terminal/,
    );
    internal.request = async () => {
      throw new CodexAppServerRpcError(-32601, "method not found");
    };
    await assert.rejects(
      client.listBackgroundTerminals("thread"),
      /method not found/,
    );
    assert.equal(resumed, 1);
  } finally {
    await client.close();
  }
});
test("individual termination forwards process IDs, handles exited commands, and broadcasts changes", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const events: unknown[] = [],
    second: unknown[] = [];
  client.subscribeAppServerEvents((event) => events.push(event));
  client.subscribeAppServerEvents((event) => second.push(event));
  let terminated = true;
  (
    client as unknown as {
      request(method: string, params: unknown): Promise<unknown>;
    }
  ).request = async (method, params) => {
    if (method === "thread/backgroundTerminals/clean") {
      assert.deepEqual(params, { threadId: "thread" });
      return {};
    }
    assert.equal(method, "thread/backgroundTerminals/terminate");
    assert.deepEqual(params, { threadId: "thread", processId: "42" });
    return { terminated };
  };
  try {
    assert.equal(
      await client.terminateBackgroundTerminal("thread", "42"),
      true,
    );
    terminated = false;
    assert.equal(
      await client.terminateBackgroundTerminal("thread", "42"),
      false,
    );
    await client.cleanBackgroundTerminals("thread");
    assert.deepEqual(second, events);
    assert.deepEqual(
      events,
      [1, 2, 3].map((changeId) => ({
        type: "background_terminals_changed",
        threadId: "thread",
        changeId,
      })),
    );
    const app = new Hono();
    let subscriptions = 0;
    registerBackgroundTerminalRoutes(app, {
      subscribe: () => {
        subscriptions++;
      },
      getClient: () => ({
        listBackgroundTerminals: async () => [terminal("42")],
        terminateBackgroundTerminal: async (id, processId) => {
          assert.equal(id, "thread");
          assert.equal(processId, "42");
          return false;
        },
      }),
    });
    assert.deepEqual(
      await (
        await app.request("/api/codex/threads/thread/background-terminals")
      ).json(),
      { terminals: [terminal("42")] },
    );
    assert.deepEqual(
      await (
        await app.request(
          "/api/codex/threads/thread/background-terminals/42/terminate",
          { method: "POST" },
        )
      ).json(),
      { terminated: false },
    );
    assert.equal(subscriptions, 2);
    const old = new Hono();
    registerBackgroundTerminalRoutes(old, { getClient: () => ({}) });
    assert.equal(
      (await old.request("/api/codex/threads/thread/background-terminals"))
        .status,
      501,
    );
  } finally {
    await client.close();
  }
});

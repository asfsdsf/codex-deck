import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import {
  __TEST_ONLY__,
  CodexAppServerRpcError,
} from "../../api/codex-app-server";
import { registerMemoryInsightRoutes } from "../../api/server/memory-insight-routes";

test("memory reads use the selected thread pipeline and resume only unloaded threads", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const calls: string[] = [];
  let loaded = false;
  const internal = client as unknown as {
    request(method: string, params: unknown): Promise<unknown>;
    resumeThread(id: string): Promise<void>;
  };
  internal.request = async (method, params) => {
    calls.push(method);
    if (method === "memory/status")
      return { v2ConsolidatedThreads: 21, v2Ready: true };
    assert.deepEqual(params, { threadId: "thread" });
    if (!loaded) throw new CodexAppServerRpcError(-32000, "thread not loaded");
    return { summary: "Thread pipeline summary" };
  };
  internal.resumeThread = async (id) => {
    assert.equal(id, "thread");
    loaded = true;
    calls.push("resume");
  };
  try {
    assert.deepEqual(await client.readThreadMemory(" thread "), {
      summary: "Thread pipeline summary",
    });
    assert.deepEqual(calls, [
      "thread/memory/read",
      "resume",
      "thread/memory/read",
    ]);
    assert.deepEqual(await client.readMemoryStatus(), {
      v2ConsolidatedThreads: 21,
      v2Ready: true,
    });
    internal.request = async () => ({ summary: null });
    assert.deepEqual(await client.readThreadMemory("thread"), {
      summary: null,
    });
    await assert.rejects(client.readMemoryStatus(), /Invalid memory\/status/);
    internal.request = async () => ({});
    await assert.rejects(
      client.readThreadMemory("thread"),
      /Invalid thread\/memory/,
    );
    internal.request = async () => {
      throw new CodexAppServerRpcError(-32601, "method not found");
    };
    await assert.rejects(client.readThreadMemory("thread"), /method not found/);
    assert.equal(calls.filter((value) => value === "resume").length, 1);
  } finally {
    await client.close();
  }
});

test("memory insight endpoints keep readiness and summary independently available", async () => {
  const app = new Hono();
  registerMemoryInsightRoutes(app, () => ({
    readMemoryStatus: async () => ({
      v2ConsolidatedThreads: 3,
      v2Ready: false,
    }),
    readThreadMemory: async (id) => ({ summary: id }),
  }));
  assert.deepEqual(
    await (await app.request("/api/codex/memories/status")).json(),
    { v2ConsolidatedThreads: 3, v2Ready: false },
  );
  assert.deepEqual(
    await (await app.request("/api/codex/threads/test/memory")).json(),
    { summary: "test" },
  );
  const old = new Hono();
  registerMemoryInsightRoutes(old, () => ({}));
  assert.equal((await old.request("/api/codex/memories/status")).status, 501);
  assert.equal(
    (await old.request("/api/codex/threads/test/memory")).status,
    501,
  );
});

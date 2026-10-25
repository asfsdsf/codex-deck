import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { HookRunStore, parseHookRun } from "../../api/hook-runs";
import { __TEST_ONLY__ } from "../../api/codex-app-server";
import { registerHookRunRoutes } from "../../api/server/hook-run-routes";
const params = (status = "running", id = "run") => ({
  threadId: "thread",
  turnId: "turn",
  run: {
    id,
    eventName: "preToolUse",
    status,
    handlerType: "command",
    executionMode: "async",
    scope: "turn",
    sourcePath: "/hooks",
    source: "project",
    displayOrder: 1,
    startedAt: 10,
    completedAt: status === "running" ? null : 20,
    durationMs: status === "running" ? null : 10,
    statusMessage: "Details",
    entries: [{ kind: "feedback", text: "Keep this output" }],
  },
});
test("hook lifecycle is retained and fanned out to concurrent subscribers", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const first: unknown[] = [],
    second: unknown[] = [];
  client.subscribeAppServerEvents((event) => first.push(event));
  client.subscribeAppServerEvents((event) => second.push(event));
  const notify = client as unknown as {
    handleServerNotification(method: string, params: unknown): void;
  };
  try {
    notify.handleServerNotification("hook/started", params());
    notify.handleServerNotification("hook/completed", params("blocked"));
    assert.deepEqual(first, second);
    assert.equal(first.length, 2);
    assert.deepEqual(client.listHookRuns("thread"), [
      parseHookRun(params("blocked")),
    ]);
    assert.deepEqual(client.listHookRuns("other"), []);
    const app = new Hono();
    registerHookRunRoutes(app, () => client);
    assert.deepEqual(
      await (await app.request("/api/codex/threads/thread/hook-runs")).json(),
      { runs: client.listHookRuns("thread") },
    );
  } finally {
    await client.close();
  }
});
test("hook retention is bounded, preserves output, and ignores late started events", () => {
  assert.equal(parseHookRun(null), null);
  assert.equal(parseHookRun({ threadId: "x", run: {} }), null);
  const store = new HookRunStore();
  store.record(parseHookRun(params("completed"))!);
  store.record(parseHookRun(params())!);
  assert.equal(store.list("thread")[0].run.status, "completed");
  for (let i = 0; i < 110; i++)
    store.record(parseHookRun(params("failed", String(i)))!);
  assert.equal(store.list("thread").length, 100);
  assert.equal(store.list("thread")[0].run.entries[0].text, "Keep this output");
  for (let i = 0; i < 140; i++)
    store.record({ ...parseHookRun(params())!, threadId: String(i) });
  assert.deepEqual(store.list("thread"), []);
});

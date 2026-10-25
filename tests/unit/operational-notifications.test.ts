import assert from "node:assert/strict";
import test from "node:test";
import {
  OperationalNotificationStore,
  OPERATIONAL_METHODS,
} from "../../api/operational-notifications";
import {
  __TEST_ONLY__,
  setCodexAppServerClientForTests,
} from "../../api/codex-app-server";
import { createServer } from "../../api/server";
import { createTempCodexDir } from "./test-utils";

test("operational notices preserve every payload and distinguish global from thread notices", () => {
  const store = new OperationalNotificationStore();
  const details = {
    threadId: "thread",
    turnId: "turn",
    itemId: "item",
    fromModel: "large",
    toModel: "small",
    reason: "quota",
    verifications: ["verified"],
    provider: "provider",
    message: "Checking",
    summary: "Warning",
    details: "Migration instructions",
    path: "/config",
    range: { start: { line: 1, character: 2 }, end: { line: 1, character: 3 } },
  };
  for (const method of OPERATIONAL_METHODS) {
    const value = store.record(
      method,
      method === "configWarning" || method === "deprecationNotice"
        ? { ...details, threadId: null }
        : details,
    )!;
    assert.ok(value);
    assert.deepEqual(value.details.range, details.range);
    assert.equal(typeof value.summary, "string");
  }
  assert.equal(store.list("other").length, 2);
  assert.equal(store.list("thread").length, OPERATIONAL_METHODS.length);
  for (let i = 0; i < 300; i++)
    store.record("item/mcpToolCall/progress", {
      ...details,
      message: String(i),
    });
  assert.equal(
    store
      .list("thread")
      .filter((value) => value.method === "item/mcpToolCall/progress").length,
    1,
  );
  for (let i = 0; i < 300; i++)
    store.record("deprecationNotice", { summary: String(i) });
  assert.equal(store.list("thread").length, 256);
  assert.equal(store.record("model/rerouted", {}), null);
  assert.equal(store.record("unknown", details), null);
});

test("global and scoped notices fan out and survive remote delta delivery and page refresh", async () => {
  const { rootDir, cleanup } = await createTempCodexDir("operational-notices");
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const seen: unknown[] = [];
  client.subscribeAppServerEvents((event) => seen.push(event));
  setCodexAppServerClientForTests(client);
  const server = createServer({ port: 0, codexDir: rootDir, open: false });
  const notify = client as unknown as {
    handleServerNotification(method: string, params: unknown): void;
  };
  try {
    const initial = (await (
      await server.app.request("/api/sessions/delta?sinceVersion=0&waitMs=0")
    ).json()) as { version: number };
    notify.handleServerNotification("configWarning", {
      summary: "Invalid config",
      details: "Use new field",
      path: "/config",
    });
    notify.handleServerNotification("modelProvider/authRecoveryStarted", {
      threadId: "thread",
      turnId: "turn",
      provider: "provider",
      message: "Refreshing token",
    });
    const delta = (await (
      await server.app.request(
        `/api/sessions/delta?sinceVersion=${initial.version}&waitMs=0`,
      )
    ).json()) as { codexAppServerEvents: unknown[] };
    assert.deepEqual(delta.codexAppServerEvents, seen);
    const global = (await (
      await server.app.request("/api/codex/notifications")
    ).json()) as { notifications: unknown[] };
    assert.equal(global.notifications.length, 1);
    const scoped = (await (
      await server.app.request("/api/codex/notifications?threadId=thread")
    ).json()) as { notifications: unknown[] };
    assert.equal(scoped.notifications.length, 2);
    const other = (await (
      await server.app.request("/api/codex/notifications?threadId=other")
    ).json()) as { notifications: unknown[] };
    assert.deepEqual(other, global);
  } finally {
    server.stop();
    setCodexAppServerClientForTests(null);
    await client.close();
    await cleanup();
  }
});

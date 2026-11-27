import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __TEST_ONLY__,
  CodexAppServerRpcError,
} from "../../api/codex-app-server";
import {
  normalizeThreadContext,
  ThreadContextStore,
} from "../../api/codex-thread-context";

type Rpc = {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  handleServerNotification(method: string, params: unknown): void;
};

function fixture(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), "codex-thread-context-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const client = new __TEST_ONLY__.CodexAppServerClient({
    env: { CODEX_HOME: home },
  });
  t.after(() => client.close());
  const rpc = client as unknown as Rpc;
  const turnStarts: Array<Record<string, unknown>> = [];
  const turns: string[] = [];
  let failNextTurn = false;
  rpc.request = async (method, params) => {
    if (method === "config/read") return { config: {} };
    if (method === "thread/settings/update") return {};
    if (method === "turn/start") {
      if (failNextTurn) {
        failNextTurn = false;
        throw new Error("provider offline");
      }
      turnStarts.push(params);
      const id = `turn-${turnStarts.length}`;
      turns.push(id);
      return { turn: { id } };
    }
    if (method === "thread/read")
      return {
        thread: {
          status: { type: "idle" },
          turns: turns.map((id) => ({ id })),
        },
      };
    if (method === "thread/fork") return { thread: { id: "forked" } };
    throw new Error(`Unexpected ${method}`);
  };
  const store = new ThreadContextStore(() =>
    join(home, "codex-deck", "thread-context"),
  );
  const waitFor = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("condition not reached");
  };
  return {
    client,
    rpc,
    store,
    turnStarts,
    turns,
    waitFor,
    failNextTurn: () => {
      failNextTurn = true;
    },
  };
}

test("context is attached once as application additionalContext, then again after compaction", async (t) => {
  const f = fixture(t);
  await f.client.sendMessage({
    threadId: "t1",
    text: "Build feature X",
    additionalContext: { "prompt-allocator": "  Follow rule A.  " },
  });
  assert.deepEqual(f.turnStarts[0].input, [
    { type: "text", text: "Build feature X" },
  ]);
  assert.deepEqual(f.turnStarts[0].additionalContext, {
    "prompt-allocator": { value: "Follow rule A.", kind: "application" },
  });

  await f.client.sendMessage({ threadId: "t1", text: "next" });
  assert.equal(
    f.turnStarts[1].additionalContext,
    undefined,
    "history already holds it",
  );

  f.rpc.handleServerNotification("item/completed", {
    threadId: "t1",
    turnId: "turn-2",
    item: { type: "contextCompaction", id: "c1" },
    completedAtMs: 1,
  });
  await f.waitFor(async () => (await f.store.read("t1"))?.pending === true);
  await f.client.sendMessage({ threadId: "t1", text: "after compaction" });
  assert.deepEqual(f.turnStarts[2].additionalContext, {
    "prompt-allocator": { value: "Follow rule A.", kind: "application" },
  });
  const record = await f.store.read("t1");
  assert.equal(record?.pending, false);
  assert.equal(record?.injections, 2);
  assert.equal(record?.reinjections, 1);
  assert.equal(record?.injectedTurnId, "turn-3");

  // The deprecated notification is handled too.
  f.rpc.handleServerNotification("thread/compacted", {
    threadId: "t1",
    turnId: "turn-3",
  });
  await f.waitFor(async () => (await f.store.read("t1"))?.pending === true);
});

test("a failed send keeps the context for the next turn on the thread", async (t) => {
  const f = fixture(t);
  f.failNextTurn();
  await assert.rejects(
    f.client.sendMessage({
      threadId: "t2",
      text: "first",
      additionalContext: { rules: "Rule B." },
    }),
    /provider offline/,
  );
  await f.client.sendMessage({ threadId: "t2", text: "retry" });
  assert.deepEqual(f.turnStarts[0].additionalContext, {
    rules: { value: "Rule B.", kind: "application" },
  });
});

test("rollback re-attaches only when the carrying turn is gone", async (t) => {
  const f = fixture(t);
  await f.client.sendMessage({
    threadId: "t3",
    text: "first",
    additionalContext: { rules: "Rule C." },
  });
  await f.client.sendMessage({ threadId: "t3", text: "second" });
  f.turns.splice(1); // Rollback keeps turn-1, which carried the context.
  f.rpc.handleServerNotification("thread/reverted", { threadId: "t3" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await f.store.read("t3"))?.pending, false);
  f.turns.splice(0); // Rollback removes turn-1.
  f.rpc.handleServerNotification("thread/reverted", { threadId: "t3" });
  await f.waitFor(async () => (await f.store.read("t3"))?.pending === true);
});

test("forks inherit context and re-attach it when their history may lack it", async (t) => {
  const f = fixture(t);
  await f.client.sendMessage({
    threadId: "t4",
    text: "first",
    additionalContext: { rules: "Rule D." },
  });
  await f.client.forkThread("t4");
  assert.equal((await f.store.read("forked"))?.pending, false);
  await f.client.forkThread("t4", { beforeTurnId: "turn-1" });
  assert.equal((await f.store.read("forked"))?.pending, true);
  assert.equal((await f.store.read("forked"))?.entries.rules.value, "Rule D.");
});

test("threads without context are unaffected and invalid context is rejected before sending", async (t) => {
  const f = fixture(t);
  await f.client.sendMessage({ threadId: "t5", text: "plain" });
  assert.equal(f.turnStarts[0].additionalContext, undefined);
  assert.equal(await f.store.read("t5"), null);
  await assert.rejects(
    f.client.sendMessage({
      threadId: "t5",
      text: "x",
      additionalContext: { "Bad Key!": "x" },
    }),
    /Invalid thread context key/,
  );
  assert.equal(f.turnStarts.length, 1);
  assert.throws(
    () => normalizeThreadContext({ big: "x".repeat(70 * 1024) }),
    /64 KiB/,
  );
  assert.deepEqual(normalizeThreadContext({ empty: "   " }), {});
});

test("an empty session is replaced by a thread started with the hook's system prompt", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "codex-replace-thread-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const client = new __TEST_ONLY__.CodexAppServerClient({
    env: { CODEX_HOME: home },
  });
  t.after(() => client.close());
  const rpc = client as unknown as Rpc;
  const starts: Array<Record<string, unknown>> = [];
  const turnsByThread: Record<string, string[]> = { empty: [], used: ["t1"] };
  rpc.request = async (method, params) => {
    if (method === "config/read") return { config: {} };
    if (method === "thread/start") {
      starts.push(params);
      return { thread: { id: `new-${starts.length}` } };
    }
    if (method === "thread/resume")
      // As the real app-server answers for a thread with no rollout yet.
      throw new CodexAppServerRpcError(
        -32600,
        `no rollout found for thread id ${String(params.threadId)}`,
      );
    if (method === "thread/read") {
      const id = String(params.threadId);
      if (id === "unwritten")
        throw new CodexAppServerRpcError(-32600, "thread not materialized yet");
      return {
        thread: {
          status: { type: "idle" },
          turns: (turnsByThread[id] ?? []).map((turnId) => ({ id: turnId })),
        },
      };
    }
    throw new Error(`Unexpected ${method}`);
  };

  for (const source of ["unwritten", "empty"]) {
    const id = await client.replaceEmptyThread(source, {
      cwd: "/repo",
      model: "gpt-x",
      baseInstructions: "You are Codex. Explain each decision.",
    });
    assert.match(id, /^new-\d$/);
  }
  assert.equal(starts.length, 2);
  assert.equal(
    starts[0].baseInstructions,
    "You are Codex. Explain each decision.",
  );
  assert.equal(starts[0].cwd, "/repo");
  assert.equal(starts[0].model, "gpt-x");

  await assert.rejects(
    client.replaceEmptyThread("used", { cwd: "/repo", baseInstructions: "x" }),
    /only be set before its first message/,
  );
  await assert.rejects(
    client.replaceEmptyThread("empty", {
      cwd: "/repo",
      baseInstructions: "  ",
    }),
    /baseInstructions is required/,
  );
  assert.equal(starts.length, 2);

  await client.createThread({ cwd: "/repo" });
  assert.equal(starts[2].baseInstructions, undefined);
});

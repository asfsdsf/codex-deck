import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { parseReviewTarget } from "../../api/codex-review";
import {
  __TEST_ONLY__,
  CodexAppServerRpcError,
} from "../../api/codex-app-server";
import { registerReviewRoutes } from "../../api/server/review-routes";
import { initStorage } from "../../api/storage";
import { createTempCodexDir } from "./test-utils";

test("native review validates all targets and runs inline like Codex CLI", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const connection = client as unknown as {
    ensureConnected(): Promise<void>;
    ensureInitialized(): Promise<void>;
  };
  connection.ensureConnected = async () => {};
  connection.ensureInitialized = async () => {};
  const calls: unknown[] = [];
  (
    client as unknown as {
      request(method: string, params: unknown): Promise<unknown>;
    }
  ).request = async (method, params) => {
    calls.push({ method, params });
    return { reviewThreadId: "thread", turn: { id: "review-turn" } };
  };
  try {
    for (const target of [
      { type: "uncommittedChanges" },
      { type: "baseBranch", branch: " main " },
      { type: "commit", sha: "abc123", title: "Fix" },
      { type: "custom", instructions: "Check errors" },
    ]) {
      const parsed = parseReviewTarget(target);
      const callCount = calls.length;
      assert.deepEqual(await client.startReview(" thread ", parsed), {
        threadId: "thread",
        turnId: "review-turn",
      });
      assert.equal(calls.length, callCount + 1);
      assert.deepEqual(calls.at(-1), {
        method: "review/start",
        params: { threadId: "thread", target: parsed, delivery: "inline" },
      });
    }
    for (const target of [
      null,
      {},
      { type: "commit", sha: " " },
      { type: "baseBranch" },
      { type: "custom", instructions: 1 },
    ]) {
      assert.throws(() => parseReviewTarget(target), /Invalid review target/);
    }
  } finally {
    await client.close();
  }
});

for (const needsResume of [false, true]) {
  test(`inline review stays in the source conversation${needsResume ? " after resuming" : ""}`, async () => {
    const client = new __TEST_ONLY__.CodexAppServerClient();
    const internal = client as unknown as {
      ensureConnected(): Promise<void>;
      ensureInitialized(): Promise<void>;
      resumeThread(id: string): Promise<void>;
      request(
        method: string,
        params: Record<string, unknown>,
      ): Promise<unknown>;
    };
    internal.ensureConnected = async () => {};
    internal.ensureInitialized = async () => {};
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    internal.resumeThread = async (id) => {
      calls.push({ method: "thread/resume", params: { threadId: id } });
    };
    let attempts = 0;
    internal.request = async (method, params) => {
      calls.push({ method, params });
      assert.equal(
        method,
        "review/start",
        "review must not create or fork a thread",
      );
      assert.equal(params.threadId, "source");
      assert.equal(params.delivery, "inline");
      if (needsResume && attempts++ === 0)
        throw new CodexAppServerRpcError(-32600, "thread not loaded");
      // Older servers may omit reviewThreadId; keep the source conversation.
      return { turn: { id: "review-turn" } };
    };
    try {
      for (const target of [
        { type: "uncommittedChanges" },
        { type: "baseBranch", branch: "main" },
        { type: "commit", sha: "abc123", title: "Fix" },
        { type: "custom", instructions: "Check errors" },
      ]) {
        calls.length = 0;
        attempts = 0;
        const parsed = parseReviewTarget(target);
        assert.deepEqual(await client.startReview(" source ", parsed), {
          threadId: "source",
          turnId: "review-turn",
        });
        assert.deepEqual(
          calls.map((call) => call.method),
          [
            "review/start",
            ...(needsResume ? ["thread/resume", "review/start"] : []),
          ],
        );
        assert.deepEqual(calls.at(-1)?.params, {
          threadId: "source",
          target: parsed,
          delivery: "inline",
        });
      }
    } finally {
      await client.close();
    }
  });
}

test("review propagates RPC and transport failures without creating sessions", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const internal = client as unknown as {
    ensureConnected(): Promise<void>;
    ensureInitialized(): Promise<void>;
    request(method: string): Promise<unknown>;
  };
  internal.ensureConnected = async () => {};
  internal.ensureInitialized = async () => {};
  try {
    for (const error of [
      new CodexAppServerRpcError(-32601, "method not found"),
      new CodexAppServerRpcError(-32600, "review already running"),
      new CodexAppServerRpcError(
        -32600,
        "paginated threads do not support detached review",
      ),
      new Error("paginated threads do not support detached review"),
    ]) {
      const calls: string[] = [];
      internal.request = async (method) => {
        calls.push(method);
        throw error;
      };
      await assert.rejects(
        client.startReview("source", { type: "uncommittedChanges" }),
        (reason) => reason === error,
      );
      assert.deepEqual(calls, ["review/start"]);
    }
  } finally {
    await client.close();
  }
});

test("inline review routes forward the native result without writing Deck metadata", async () => {
  const { rootDir, cleanup } = await createTempCodexDir("review-origins");
  // A review must work even when Deck-specific metadata cannot be stored.
  const deckPath = join(rootDir, "codex-deck");
  await writeFile(deckPath, "No Deck metadata storage");
  const filesBefore = await readdir(rootDir, { recursive: true });
  initStorage(rootDir);
  const app = new Hono();
  const wakes: string[] = [];
  registerReviewRoutes(app, {
    getClient: () => ({
      startReview: async () => ({ threadId: "source-thread", turnId: "turn" }),
    }),
    wake: (id) => wakes.push(id),
  });
  try {
    const response = await app.request(
      "/api/codex/threads/source-thread/review",
      {
        method: "POST",
        body: JSON.stringify({ target: { type: "uncommittedChanges" } }),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      threadId: "source-thread",
      turnId: "turn",
    });
    assert.deepEqual(await readdir(rootDir, { recursive: true }), filesBefore);
    assert.equal(await readFile(deckPath, "utf8"), "No Deck metadata storage");
    assert.deepEqual(wakes, ["source-thread"]);
  } finally {
    await cleanup();
  }
});

test("shared app-server review subscribes to the current conversation", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const internal = client as unknown as {
    sharedSocket: unknown;
    ensureConnected(): Promise<void>;
    ensureInitialized(): Promise<void>;
    resumeThread(threadId: string): Promise<void>;
    request(method: string, params: unknown): Promise<unknown>;
  };
  internal.ensureConnected = async () => {};
  internal.ensureInitialized = async () => {};
  internal.sharedSocket = {};
  const calls: string[] = [];
  internal.resumeThread = async (id) => {
    calls.push(`resume:${id}`);
  };
  internal.request = async (method) => {
    calls.push(method);
    return { reviewThreadId: "source", turn: { id: "turn" } };
  };
  try {
    assert.deepEqual(
      await client.startReview("source", { type: "uncommittedChanges" }),
      {
        threadId: "source",
        turnId: "turn",
      },
    );
    assert.deepEqual(calls, ["resume:source", "review/start"]);
  } finally {
    internal.sharedSocket = null;
    await client.close();
  }
});

test("review routes reject malformed targets, wake subscribers, and report unsupported servers", async () => {
  const app = new Hono();
  const wakes: string[] = [];
  let calls = 0;
  registerReviewRoutes(app, {
    wake: (id) => wakes.push(id),
    getClient: () => ({
      startReview: async (id, target) => {
        calls++;
        assert.equal(target.type, "uncommittedChanges");
        return { threadId: id, turnId: "turn" };
      },
    }),
  });
  const post = (body: unknown) =>
    app.request("/api/codex/threads/thread/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await post({ target: { type: "commit" } })).status, 400);
  assert.equal((await post(null)).status, 400);
  const response = await post({ target: { type: "uncommittedChanges" } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    threadId: "thread",
    turnId: "turn",
  });
  assert.deepEqual(wakes, ["thread"]);
  assert.equal(calls, 1);
  const old = new Hono();
  registerReviewRoutes(old, { getClient: () => ({}) });
  assert.equal(
    (
      await old.request("/api/codex/threads/thread/review", {
        method: "POST",
        body: JSON.stringify({ target: { type: "uncommittedChanges" } }),
      })
    ).status,
    501,
  );
});

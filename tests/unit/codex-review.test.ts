import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { parseReviewTarget } from "../../api/codex-review";
import {
  __TEST_ONLY__,
  CodexAppServerRpcError,
} from "../../api/codex-app-server";
import { registerReviewRoutes } from "../../api/server/review-routes";

test("native review validates all targets and sends inline review RPCs", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
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
      assert.deepEqual(await client.startReview(" thread ", parsed), {
        threadId: "thread",
        turnId: "review-turn",
      });
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

import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { ConversationMessage } from "../../api/storage";
import { __TEST_ONLY__ } from "../../api/codex-app-server";
import {
  parseForkBoundary,
  promptFromUserInputs,
  revertThreadBeforeTurn,
  ThreadHistoryRequestError,
} from "../../api/codex-thread-history";
import { registerThreadHistoryRoutes } from "../../api/server/thread-history-routes";
import {
  collectTurnPrompts,
  getMessageTurnRole,
  getTurnActionItems,
  latestTurnId,
} from "../../web/conversation-turn-actions";

function mockClient(
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>,
) {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const internal = client as unknown as {
    request: typeof rpc;
    ensureConnected: () => Promise<void>;
    ensureInitialized: () => Promise<void>;
    handleServerNotification: (method: string, params: unknown) => void;
    sharedSocket: unknown;
    resumeThread: (id: string) => Promise<void>;
  };
  internal.request = rpc;
  internal.ensureConnected = async () => {};
  internal.ensureInitialized = async () => {};
  return { client, internal };
}

const threadSummary = (id: string) => ({
  threadId: id,
  name: null,
  preview: "",
  cwd: "/repo",
  agentNickname: null,
  agentRole: null,
  parentThreadId: null,
  canAcceptDirectInput: null,
  agentPath: null,
  source: null,
  status: "idle" as const,
  updatedAt: null,
});

function message(
  type: ConversationMessage["type"],
  text: string,
  turnId?: string,
): ConversationMessage {
  return {
    type,
    turnId,
    message: { role: type, content: [{ type: "text", text }] },
  };
}

test("fork boundaries are exclusive, trimmed turn IDs", () => {
  assert.equal(parseForkBoundary(undefined), null);
  assert.equal(parseForkBoundary({}), null);
  assert.deepEqual(parseForkBoundary({ lastTurnId: " turn-1 " }), {
    lastTurnId: "turn-1",
  });
  assert.deepEqual(parseForkBoundary({ beforeTurnId: "turn-2" }), {
    beforeTurnId: "turn-2",
  });
  assert.throws(
    () => parseForkBoundary({ lastTurnId: "a", beforeTurnId: "b" }),
    /cannot be combined/,
  );
  assert.throws(() => parseForkBoundary({ lastTurnId: 4 }), /turn ID/);
  assert.throws(() => parseForkBoundary([]), /object/);
});

test("forkThread forwards one turn boundary to thread/fork", async () => {
  const calls: Record<string, unknown>[] = [];
  const { client } = mockClient(async (method, params) => {
    assert.equal(method, "thread/fork");
    calls.push(params);
    return { thread: { id: "fork", cwd: "/repo", status: { type: "idle" } } };
  });
  await client.forkThread("source", { lastTurnId: "turn-1" });
  await client.forkThread("source", { beforeTurnId: "turn-2" });
  await client.forkThread("source");
  assert.equal(calls[0].lastTurnId, "turn-1");
  assert.equal("beforeTurnId" in calls[0], false);
  assert.equal(calls[1].beforeTurnId, "turn-2");
  assert.equal("lastTurnId" in calls[1], false);
  assert.equal("lastTurnId" in calls[2] || "beforeTurnId" in calls[2], false);
});

test("fork-at route validates boundaries before forking", async () => {
  const forks: unknown[] = [];
  const app = new Hono();
  registerThreadHistoryRoutes(app, {
    getClient: () => ({
      forkThread: async (threadId, boundary) => {
        forks.push([threadId, boundary]);
        return threadSummary("fork");
      },
    }),
  });
  const post = (body: string) =>
    app.request("/api/codex/threads/source/fork-at", {
      method: "POST",
      body,
    });
  assert.equal((await post("{}")).status, 400);
  assert.equal(
    (await post('{"lastTurnId":"a","beforeTurnId":"b"}')).status,
    400,
  );
  assert.equal((await post("not json")).status, 400);
  const response = await post('{"beforeTurnId":"turn-2"}');
  assert.equal(response.status, 200);
  assert.equal(
    ((await response.json()) as { thread: { threadId: string } }).thread
      .threadId,
    "fork",
  );
  assert.deepEqual(forks, [["source", { beforeTurnId: "turn-2" }]]);
});

test("turn actions resolve opening prompts and hide unknown turns", () => {
  const agents = message("user", "# AGENTS.md instructions for /repo", "t1");
  const prompt = message("user", "Fix the bug", "t1");
  const steer = message("user", "Also add a test", "t1");
  const answer = message("assistant", "Done", "t1");
  const legacy = message("user", "Old history");
  const environment = message(
    "user",
    "<environment_context>\n</environment_context>",
    "t2",
  );
  const second = message("user", "Next", "t2");
  const messages = [agents, prompt, steer, answer, legacy, environment, second];
  const prompts = collectTurnPrompts(messages, agents);
  assert.equal(prompts.get("t1"), prompt);
  assert.equal(prompts.get("t2"), second);
  assert.equal(getMessageTurnRole(prompt, prompts), "prompt");
  assert.equal(getMessageTurnRole(steer, prompts), "steer");
  assert.equal(getMessageTurnRole(answer, prompts), "response");
  assert.equal(getMessageTurnRole(legacy, prompts), null);
  assert.equal(getMessageTurnRole(environment, prompts), null);
  assert.equal(latestTurnId(messages), "t2");

  assert.deepEqual(
    getTurnActionItems("prompt", "idle").map((item) => item.action),
    ["fork-through", "fork-before", "rewind"],
  );
  assert.deepEqual(
    getTurnActionItems("response", "idle").map((item) => item.action),
    ["fork-through"],
  );
  assert.deepEqual(
    getTurnActionItems("steer", "idle").map((item) => item.action),
    ["fork-through"],
  );
  const running = getTurnActionItems("prompt", "turn");
  assert.match(running[0].disabledReason ?? "", /still running/);
  assert.equal(running[1].disabledReason, null);
  assert.match(running[2].disabledReason ?? "", /Stop the running turn/);
  assert.match(
    getTurnActionItems("prompt", "thread")[2].disabledReason ?? "",
    /Stop the running turn/,
  );
});

test("revert restores the turn's opening prompt and rejects unsafe threads", async () => {
  const calls: string[] = [];
  let thread: Record<string, unknown> = {
    historyMode: "paginated",
    status: { type: "idle" },
  };
  const rpc = async (method: string, params: Record<string, unknown>) => {
    calls.push(method);
    if (method === "thread/read") return { thread };
    if (method === "thread/items/list") {
      assert.equal(params.turnId, "turn-2");
      return {
        data: [
          { turnId: "turn-2", item: { type: "reasoning", id: "r" } },
          {
            turnId: "turn-2",
            item: {
              type: "userMessage",
              id: "u1",
              content: [
                { type: "text", text: "Fix $skill", text_elements: [] },
                { type: "skill", name: "skill", path: "/s" },
                { type: "localImage", path: "/tmp/a.png" },
              ],
            },
          },
          {
            turnId: "turn-2",
            item: {
              type: "userMessage",
              id: "u2",
              content: [{ type: "text", text: "steer" }],
            },
          },
        ],
        nextCursor: null,
      };
    }
    if (method === "thread/revert") {
      assert.deepEqual(params, { threadId: "t", beforeTurnId: "turn-2" });
      return { thread: {}, turnsBackwardsCursor: null };
    }
    throw new Error(method);
  };
  assert.deepEqual(await revertThreadBeforeTurn(rpc, rpc, "t", "turn-2"), {
    threadId: "t",
    beforeTurnId: "turn-2",
    prompt: { text: "Fix $skill", omittedInputCount: 1 },
  });
  assert.deepEqual(calls, [
    "thread/read",
    "thread/items/list",
    "thread/revert",
  ]);

  thread = { historyMode: "legacy", status: { type: "idle" } };
  await assert.rejects(
    revertThreadBeforeTurn(rpc, rpc, "t", "turn-2"),
    (error) =>
      error instanceof ThreadHistoryRequestError &&
      error.status === 409 &&
      /paginated/.test(error.message),
  );
  thread = { historyMode: "paginated", status: { type: "active" } };
  await assert.rejects(
    revertThreadBeforeTurn(rpc, rpc, "t", "turn-2"),
    /Stop the running turn/,
  );
  assert.equal(calls.filter((call) => call === "thread/revert").length, 1);
  assert.deepEqual(promptFromUserInputs(null), {
    text: "",
    omittedInputCount: 0,
  });
});

test("reverts broadcast history changes from this and other clients", async () => {
  const events: unknown[] = [];
  const { client, internal } = mockClient(async (method) => {
    if (method === "thread/read")
      return { thread: { historyMode: "paginated", status: "idle" } };
    if (method === "thread/items/list") return { data: [], nextCursor: null };
    return {};
  });
  client.subscribeAppServerEvents((event) => events.push(event));
  const result = await client.revertThread("t", "turn-1");
  assert.equal(result.prompt, null);
  internal.handleServerNotification("thread/reverted", { threadId: "other" });
  assert.deepEqual(
    events.map((event) => {
      const { scope, threadId } = event as { scope: string; threadId: string };
      return [scope, threadId];
    }),
    [
      ["history", "t"],
      ["history", "other"],
    ],
  );
});

test("revert route refreshes the rollout and wakes every conversation stream", async () => {
  const order: string[] = [];
  const app = new Hono();
  registerThreadHistoryRoutes(app, {
    wake: (id) => order.push(`wake:${id}`),
    refreshRollout: async (id) => {
      order.push(`refresh:${id}`);
    },
    getClient: () => ({
      revertThread: async (threadId, beforeTurnId) => {
        order.push(`revert:${threadId}:${beforeTurnId}`);
        if (beforeTurnId === "busy")
          throw new ThreadHistoryRequestError("Stop the running turn", 409);
        return { threadId, beforeTurnId, prompt: null };
      },
    }),
  });
  const post = (body: string) =>
    app.request("/api/codex/threads/t/revert", { method: "POST", body });
  assert.equal((await post("{}")).status, 400);
  assert.equal((await post('{"beforeTurnId":"busy"}')).status, 409);
  const response = await post('{"beforeTurnId":"turn-1"}');
  assert.equal(response.status, 200);
  assert.deepEqual(order, [
    "revert:t:busy",
    "revert:t:turn-1",
    "refresh:t",
    "wake:t",
  ]);
});

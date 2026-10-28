import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { ConversationMessage } from "../../api/storage";
import { __TEST_ONLY__ } from "../../api/codex-app-server";
import { parseForkBoundary } from "../../api/codex-thread-history";
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
    ["fork-through", "fork-before"],
  );
  assert.deepEqual(
    getTurnActionItems("response", "idle").map((item) => item.action),
    ["fork-through"],
  );
  const running = getTurnActionItems("prompt", "turn");
  assert.match(running[0].disabledReason ?? "", /still running/);
  assert.equal(running[1].disabledReason, null);
});

import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { __TEST_ONLY__ } from "../../api/codex-app-server";
import { nativePages } from "../../api/codex-native";
import { registerNativeWorkflowRoutes } from "../../api/server/native-workflow-routes";

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

test("native inventory pagination rejects malformed pages and repeated cursors", async () => {
  await assert.rejects(
    nativePages(async () => ({ data: [], nextCursor: "repeat" }), "list", {}),
    /repeated/,
  );
  await assert.rejects(
    nativePages(async () => ({ data: null }), "list", {}),
    /inventory/,
  );
});

test("MCP inventory subscribes shared threads, paginates, retains startup and OAuth, and broadcasts changes", async () => {
  const calls: string[] = [];
  const events: unknown[] = [],
    second: unknown[] = [];
  const { client, internal } = mockClient(async (method, params) => {
    calls.push(method);
    if (method === "mcpServerStatus/list")
      return {
        data: [
          {
            name: params.cursor ? "second" : "first",
            tools: {},
            resources: [],
            resourceTemplates: [],
            authStatus: "oAuth",
          },
        ],
        nextCursor: params.cursor ? null : "page2",
      };
    if (method === "mcpServer/oauth/login")
      return {
        authorizationUrl: "https://auth.example/login",
        loginId: "attempt",
      };
    return {};
  });
  internal.sharedSocket = {};
  internal.resumeThread = async (id) => {
    calls.push(`resume:${id}`);
  };
  client.subscribeAppServerEvents((event) => events.push(event));
  client.subscribeAppServerEvents((event) => second.push(event));
  internal.handleServerNotification("mcpServer/startupStatus/updated", {
    name: "first",
    threadId: "thread",
    status: "failed",
    error: "offline",
  });
  internal.handleServerNotification("mcpServer/oauthLogin/completed", {
    name: "first",
    threadId: "thread",
    success: true,
    loginId: "attempt",
  });
  const snapshot = await client.listMcpServers("thread");
  assert.equal(calls[0], "resume:thread");
  assert.equal(snapshot.servers.length, 2);
  assert.equal(snapshot.updates.length, 2);
  assert.equal((await client.listMcpServers("other")).updates.length, 0);
  assert.equal(
    (await client.loginMcpServer("first", "thread")).loginId,
    "attempt",
  );
  await client.reloadMcpServers();
  assert.equal((await client.listMcpServers()).updates.length, 0);
  assert.deepEqual(events, second);
  assert.equal(events.length, 4);
  internal.sharedSocket = null;
  await client.close();
});

test("MCP administration routes validate input and preserve transport-neutral payloads", async () => {
  const app = new Hono();
  let subscriptions = 0;
  registerNativeWorkflowRoutes(app, {
    subscribe: () => {
      subscriptions++;
    },
    getClient: () => ({
      listMcpServers: async (threadId) => ({
        servers: [],
        updates: [
          { name: "server", threadId: threadId || null, status: "starting" },
        ],
      }),
      loginMcpServer: async (name, threadId) => {
        assert.equal(name, "server");
        assert.equal(threadId, "thread");
        return { authorizationUrl: "https://auth.example", loginId: "id" };
      },
      reloadMcpServers: async () => {},
    }),
  });
  assert.equal(
    (await app.request("/api/codex/mcp?threadId=thread")).status,
    200,
  );
  assert.equal(
    (
      await app.request("/api/codex/mcp/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "server", threadId: "thread" }),
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await app.request("/api/codex/mcp/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    400,
  );
  assert.equal(
    (await app.request("/api/codex/mcp/reload", { method: "POST" })).status,
    200,
  );
  assert.equal(subscriptions, 4);
});

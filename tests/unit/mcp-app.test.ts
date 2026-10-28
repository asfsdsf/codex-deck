import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { ConversationMessage } from "../../api/storage";
import {
  extractMcpAppResource,
  findMcpAppBlock,
  isToolCallableFromApp,
  McpAppRateLimiter,
  parseMcpAppToolCall,
} from "../../api/codex-mcp-apps";
import { parseConversationTextChunk } from "../../api/conversation-parser";
import { registerMcpAppRoutes } from "../../api/server/mcp-app-routes";
import {
  buildMcpAppCsp,
  buildMcpAppSrcdoc,
  McpAppBridge,
  MCP_APP_PROTOCOL_VERSION,
  sanitizeCspDomains,
  type McpAppHostContext,
} from "../../web/mcp-app";

const toolResult = {
  content: [{ type: "text", text: "3 results" }],
  structuredContent: { items: [1, 2, 3] },
};

const paginatedItem = {
  type: "item_completed",
  thread_id: "thread-1",
  turn_id: "turn-1",
  item: {
    type: "McpToolCall",
    id: "call-1",
    server: "shop",
    tool: "search",
    arguments: { query: "socks" },
    mcpAppResourceUri: "ui://widget/legacy.html",
    mcpAppUi: {
      resourceUri: "ui://widget/search.html",
      preferredModelDisplayMode: "fullscreen",
    },
    status: "completed",
    result: toolResult,
  },
};

test("parses MCP App tool calls from paginated and legacy rollout records", () => {
  assert.deepEqual(parseMcpAppToolCall(paginatedItem), {
    callId: "call-1",
    server: "shop",
    tool: "search",
    resourceUri: "ui://widget/search.html",
    displayMode: "fullscreen",
    arguments: { query: "socks" },
    result: toolResult,
    error: null,
    status: "completed",
  });

  const legacy = parseMcpAppToolCall({
    type: "mcp_tool_call_end",
    call_id: "call-2",
    invocation: { server: "shop", tool: "cart", arguments: '{"id":7}' },
    mcp_app_resource_uri: "ui://widget/cart.html",
    result: { Ok: toolResult },
  });
  assert.equal(legacy?.resourceUri, "ui://widget/cart.html");
  assert.equal(legacy?.displayMode, null);
  assert.deepEqual(legacy?.arguments, { id: 7 });
  assert.equal(legacy?.status, "completed");

  const failed = parseMcpAppToolCall({
    type: "mcp_tool_call_end",
    call_id: "call-3",
    invocation: { server: "shop", tool: "cart" },
    mcp_app_ui: {
      resource_uri: "ui://widget/cart.html",
      preferred_model_display_mode: "inline",
    },
    result: { Err: "boom" },
  });
  assert.equal(failed?.error, "boom");
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.displayMode, "inline");

  // No UI, or a non-ui:// resource, is not a widget.
  assert.equal(
    parseMcpAppToolCall({
      ...paginatedItem,
      item: {
        ...paginatedItem.item,
        mcpAppUi: null,
        mcpAppResourceUri: undefined,
      },
    }),
    null,
  );
  assert.equal(
    parseMcpAppToolCall({
      ...paginatedItem,
      item: {
        ...paginatedItem.item,
        mcpAppUi: { resourceUri: "https://evil.example/x.html" },
        mcpAppResourceUri: undefined,
      },
    }),
    null,
  );
});

test("conversation parser emits an mcp_app block that survives reload", () => {
  const lines = [
    {
      timestamp: "2026-10-28T00:00:00Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "search",
        namespace: "mcp__shop",
        arguments: '{"query":"socks"}',
        call_id: "call-1",
      },
    },
    {
      timestamp: "2026-10-28T00:00:01Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-1",
        output: "3 results",
      },
    },
    {
      timestamp: "2026-10-28T00:00:01Z",
      type: "event_msg",
      payload: paginatedItem,
    },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n");
  const { messages } = parseConversationTextChunk(`${lines}\n`);
  const block = findMcpAppBlock(messages, "call-1");
  assert.equal(block?.resourceUri, "ui://widget/search.html");
  const widgetMessage = messages.find((message) =>
    Array.isArray(message.message?.content)
      ? message.message.content.some((entry) => entry.type === "mcp_app")
      : false,
  );
  assert.equal(widgetMessage?.type, "assistant");
  assert.equal(widgetMessage?.turnId, "turn-1");
});

test("extracts widget HTML and CSP metadata from resource reads", () => {
  const resource = extractMcpAppResource(
    {
      contents: [
        {
          uri: "ui://widget/search.html",
          mimeType: "text/html;profile=mcp-app",
          text: "<!doctype html><p>hi</p>",
          _meta: {
            ui: {
              csp: { connectDomains: ["https://api.shop.example"] },
              prefersBorder: false,
            },
          },
        },
      ],
      originCallId: "call-1",
    },
    "ui://widget/search.html",
  );
  assert.equal(resource.html, "<!doctype html><p>hi</p>");
  assert.deepEqual(resource.csp.connectDomains, ["https://api.shop.example"]);
  assert.equal(resource.prefersBorder, false);

  const blob = extractMcpAppResource(
    {
      contents: [
        {
          uri: "ui://w",
          mimeType: "text/html",
          blob: Buffer.from("<b>x</b>").toString("base64"),
        },
      ],
    },
    "ui://w",
  );
  assert.equal(blob.html, "<b>x</b>");
  assert.throws(
    () =>
      extractMcpAppResource(
        {
          contents: [
            { uri: "ui://w", mimeType: "image/svg+xml", text: "<svg/>" },
          ],
        },
        "ui://w",
      ),
    /Unsupported MCP App resource type/,
  );
  assert.throws(() => extractMcpAppResource({}, "ui://w"), /Invalid/);
});

test("app tool visibility and rate limiting", () => {
  const server = {
    name: "shop",
    runtimeStatus: null,
    authStatus: "none",
    resources: [],
    resourceTemplates: [],
    tools: {
      search: { name: "search" },
      refresh: { name: "refresh", _meta: { ui: { visibility: ["app"] } } },
      secret: { name: "secret", _meta: { ui: { visibility: ["model"] } } },
    } as never,
  };
  assert.equal(isToolCallableFromApp(server, "search"), true);
  assert.equal(isToolCallableFromApp(server, "refresh"), true);
  assert.equal(isToolCallableFromApp(server, "secret"), false);
  assert.equal(isToolCallableFromApp(server, "missing"), false);
  assert.equal(isToolCallableFromApp(undefined, "search"), false);

  let now = 0;
  const limiter = new McpAppRateLimiter(2, 1000, () => now);
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), false);
  assert.equal(limiter.allow("b"), true);
  now = 1500;
  assert.equal(limiter.allow("a"), true);
});

function widgetConversation(): ConversationMessage[] {
  return [
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "mcp_app",
            id: "call-1",
            mcpApp: parseMcpAppToolCall(paginatedItem)!,
          },
        ],
      },
    },
  ];
}

test("MCP App routes only act for the originating server and app-visible tools", async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const app = new Hono();
  registerMcpAppRoutes(app, {
    readConversation: async () => widgetConversation(),
    rateLimiter: new McpAppRateLimiter(1),
    getClient: () => ({
      readMcpAppResource: async (input) => {
        calls.push({ method: "read", input });
        return {
          contents: [
            {
              uri: input.uri,
              mimeType: "text/html;profile=mcp-app",
              text: "<p>w</p>",
            },
          ],
        };
      },
      callMcpServerTool: async (input) => {
        calls.push({ method: "call", input });
        return { content: [{ type: "text", text: "ok" }], isError: false };
      },
      listMcpServers: async () => ({
        servers: [
          {
            name: "shop",
            runtimeStatus: null,
            authStatus: "none",
            resources: [],
            resourceTemplates: [],
            tools: {
              refresh: { name: "refresh" },
              secret: {
                name: "secret",
                _meta: { ui: { visibility: ["model"] } },
              },
            } as never,
          },
        ],
        updates: [],
      }),
    }),
  });
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const resource = await post("/api/codex/mcp-apps/resource", {
    threadId: "thread-1",
    callId: "call-1",
  });
  assert.equal(resource.status, 200);
  assert.equal((await resource.json()).html, "<p>w</p>");
  assert.deepEqual(calls[0], {
    method: "read",
    input: {
      threadId: "thread-1",
      server: "shop",
      uri: "ui://widget/search.html",
      originCallId: "call-1",
    },
  });
  assert.equal(
    (
      await post("/api/codex/mcp-apps/resource", {
        threadId: "thread-1",
        callId: "nope",
      })
    ).status,
    404,
  );
  assert.equal((await post("/api/codex/mcp-apps/resource", {})).status, 400);

  const denied = await post("/api/codex/mcp-apps/tool-call", {
    threadId: "thread-1",
    callId: "call-1",
    tool: "secret",
    arguments: {},
  });
  assert.equal(denied.status, 403);
  assert.equal(
    (
      await post("/api/codex/mcp-apps/tool-call", {
        threadId: "thread-1",
        callId: "call-1",
        tool: "refresh",
        arguments: [],
      })
    ).status,
    400,
  );
  const ok = await post("/api/codex/mcp-apps/tool-call", {
    threadId: "thread-1",
    callId: "call-1",
    tool: "refresh",
    // A widget cannot redirect the call to another server.
    server: "other",
    arguments: { page: 2 },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), {
    content: [{ type: "text", text: "ok" }],
    isError: false,
  });
  assert.deepEqual(calls.at(-1), {
    method: "call",
    input: {
      threadId: "thread-1",
      server: "shop",
      tool: "refresh",
      arguments: { page: 2 },
    },
  });
  const limited = await post("/api/codex/mcp-apps/tool-call", {
    threadId: "thread-1",
    callId: "call-1",
    tool: "refresh",
    arguments: {},
  });
  assert.equal(limited.status, 429);
});

test("widget CSP keeps the spec default and rejects injected directives", () => {
  assert.equal(
    buildMcpAppCsp({}),
    "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self' data:; connect-src 'none'; frame-src 'none'; base-uri 'self'; object-src 'none'; form-action 'none'",
  );
  assert.deepEqual(
    sanitizeCspDomains([
      "https://cdn.example.com",
      "https://*.example.com",
      "wss://live.example.com:8443",
      "https://a.com; script-src *",
      "'unsafe-eval'",
      "http://plain.example.com",
      "javascript:alert(1)",
      "*",
      42,
    ]),
    [
      "https://cdn.example.com",
      "https://*.example.com",
      "wss://live.example.com:8443",
    ],
  );
  const csp = buildMcpAppCsp({
    connectDomains: ["wss://live.example.com"],
    resourceDomains: ["https://cdn.example.com", "wss://nope.example.com"],
  });
  assert.match(
    csp,
    /script-src 'self' 'unsafe-inline' https:\/\/cdn\.example\.com;/,
  );
  assert.match(csp, /connect-src wss:\/\/live\.example\.com;/);
  assert.ok(!csp.includes("nope.example.com"));

  const srcdoc = buildMcpAppSrcdoc(
    "<!DOCTYPE html><html><script>x()</script>",
    "default-src 'none'",
  );
  assert.ok(
    srcdoc.startsWith(
      `<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="default-src 'none'">`,
    ),
  );
  assert.ok(
    buildMcpAppSrcdoc("<script>x()</script>", 'a"b').startsWith(
      '<meta http-equiv="Content-Security-Policy" content="a&quot;b">',
    ),
  );
});

function createBridge(
  overrides: Partial<ConstructorParameters<typeof McpAppBridge>[0]> = {},
) {
  const sent: Array<Record<string, unknown>> = [];
  const hostContext: McpAppHostContext = {
    theme: "dark",
    displayMode: "inline",
    availableDisplayModes: ["inline", "fullscreen"],
    platform: "web",
  };
  const bridge = new McpAppBridge({
    post: (message) => sent.push(message),
    hostVersion: "test",
    hostContext: () => hostContext,
    toolInput: { query: "socks" },
    toolResult: toolResult,
    ...overrides,
  });
  return { bridge, sent };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("bridge initializes, delivers tool data and rejects unsupported requests", async () => {
  const { bridge, sent } = createBridge();
  bridge.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "ui/initialize",
    params: {},
  });
  await flush();
  const init = sent[0] as { id: number; result: Record<string, unknown> };
  assert.equal(init.id, 1);
  assert.equal(init.result.protocolVersion, MCP_APP_PROTOCOL_VERSION);
  assert.deepEqual(init.result.hostInfo, {
    name: "codex-deck",
    version: "test",
  });
  assert.equal((init.result.hostContext as McpAppHostContext).theme, "dark");

  bridge.handleMessage({
    jsonrpc: "2.0",
    method: "ui/notifications/initialized",
  });
  assert.deepEqual(sent.slice(1), [
    {
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { arguments: { query: "socks" } },
    },
    {
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: toolResult,
    },
  ]);

  bridge.handleMessage({
    jsonrpc: "2.0",
    id: "m",
    method: "ui/message",
    params: {},
  });
  await flush();
  assert.equal((sent.at(-1)!.error as { code: number }).code, -32601);

  const count = sent.length;
  bridge.handleMessage({ id: 9, method: "ping" });
  bridge.handleMessage("not json-rpc");
  bridge.handleMessage({ jsonrpc: "2.0", id: 10, method: "x".repeat(200) });
  await flush();
  assert.equal(sent.length, count);

  bridge.notifyHostContextChanged({ theme: "light" });
  assert.deepEqual(sent.at(-1), {
    jsonrpc: "2.0",
    method: "ui/notifications/host-context-changed",
    params: { theme: "light" },
  });
  bridge.dispose();
  bridge.handleMessage({ jsonrpc: "2.0", id: 11, method: "ping" });
  await flush();
  assert.equal(sent.at(-1)!.method, "ui/notifications/host-context-changed");
});

test("bridge gates tool calls, links, sizing and display modes", async () => {
  let release: () => void = () => {};
  const toolCalls: string[] = [];
  const sizes: unknown[] = [];
  const links: string[] = [];
  const { bridge, sent } = createBridge({
    now: () => 0,
    onToolCall: (name) =>
      new Promise((resolve) => {
        toolCalls.push(name);
        release = () => resolve({ content: [{ type: "text", text: name }] });
      }),
    onOpenLink: async (url) => {
      links.push(url);
      return url.includes("ok");
    },
    onSizeChanged: (size) => sizes.push(size),
    onRequestDisplayMode: (mode) => mode,
  });
  bridge.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "refresh", arguments: { page: 1 } },
  });
  bridge.handleMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "refresh" },
  });
  await flush();
  assert.deepEqual(toolCalls, ["refresh"]);
  assert.match(
    String((sent.at(-1)!.error as { message: string }).message),
    /still running/,
  );
  release();
  await flush();
  assert.deepEqual(sent.at(-1), {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: "refresh" }] },
  });

  bridge.handleMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "refresh", arguments: "nope" },
  });
  await flush();
  assert.equal((sent.at(-1)!.error as { code: number }).code, -32602);

  bridge.handleMessage({
    jsonrpc: "2.0",
    id: 4,
    method: "ui/open-link",
    params: { url: "javascript:alert(1)" },
  });
  bridge.handleMessage({
    jsonrpc: "2.0",
    id: 5,
    method: "ui/open-link",
    params: { url: "https://ok.example.com" },
  });
  bridge.handleMessage({
    jsonrpc: "2.0",
    id: 6,
    method: "ui/open-link",
    params: { url: "https://declined.example.com" },
  });
  await flush();
  assert.deepEqual(links, [
    "https://ok.example.com",
    "https://declined.example.com",
  ]);
  const byId = (id: number) => sent.find((message) => message.id === id)!;
  assert.equal((byId(4).error as { code: number }).code, -32602);
  assert.deepEqual(byId(5).result, {});
  assert.ok(byId(6).error);

  bridge.handleMessage({
    jsonrpc: "2.0",
    method: "ui/notifications/size-changed",
    params: { width: 300, height: 480, extra: true },
  });
  assert.deepEqual(sizes, [{ width: 300, height: 480 }]);

  bridge.handleMessage({
    jsonrpc: "2.0",
    id: 7,
    method: "ui/request-display-mode",
    params: { mode: "fullscreen" },
  });
  bridge.handleMessage({
    jsonrpc: "2.0",
    id: 8,
    method: "ui/request-display-mode",
    params: { mode: "pip" },
  });
  await flush();
  assert.deepEqual(byId(7).result, { mode: "fullscreen" });
  assert.deepEqual(byId(8).result, { mode: "inline" });
});

test("bridge rate-limits widget tool calls", async () => {
  const { bridge, sent } = createBridge({
    now: () => 0,
    onToolCall: async () => ({ content: [] }),
  });
  for (let id = 0; id < 21; id += 1) {
    bridge.handleMessage({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "refresh" },
    });
    await flush();
  }
  assert.equal(sent.filter((message) => message.result).length, 20);
  assert.match(
    String((sent.at(-1)!.error as { message: string }).message),
    /Too many/,
  );
});

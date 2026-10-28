import assert from "node:assert/strict";
import test from "node:test";
import {
  CODEX_DECK_DELEGATION_TOOLS,
  CODEX_DECK_TOOL_NAMESPACE,
  CodexDeckDynamicToolHost,
  MAX_RESPONSE_BYTES,
  codexDeckNonDelegationToolSpecs,
  codexDeckToolSpecs,
  executeCodexDeckDynamicTool,
  failureResponse,
  isCodexDeckDynamicToolsEnabledByEnv,
  isDynamicToolsUnsupportedError,
  serializeToolResult,
  truncateText,
  type CodexDeckDynamicToolRpc,
  type DynamicToolCallParams,
  type DynamicToolCallResponse,
} from "../../api/codex-dynamic-tools";
import { __TEST_ONLY__ } from "../../api/codex-app-server";
import { parseConversationTextChunk } from "../../api/conversation-parser";
import {
  getCodexDeckToolLabel,
  getCodexDeckToolPreview,
  getCodexDeckToolResultPreview,
  isCodexDeckToolFailureOutput,
  parseCodexDeckToolOutput,
} from "../../web/codex-deck-tools";

const CALLER = "019a0000-0000-7000-8000-000000000001";
const TARGET = "019a0000-0000-7000-8000-000000000002";
const OTHER = "019a0000-0000-7000-8000-000000000003";

class RpcError extends Error {
  public constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

type Handler = (params: Record<string, unknown>) => unknown;

function createRpc(
  handlers: Record<string, Handler>,
  extras: Partial<CodexDeckDynamicToolRpc> = {},
) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const rpc: CodexDeckDynamicToolRpc = {
    request: async (method, params) => {
      const record = (params ?? {}) as Record<string, unknown>;
      calls.push({ method, params: record });
      const handler = handlers[method];
      if (!handler) {
        throw new RpcError(-32601, `method not found: ${method}`);
      }
      return handler(record);
    },
    ...extras,
  };
  return { rpc, calls };
}

function call(
  tool: string,
  args: unknown,
  overrides: Partial<DynamicToolCallParams> = {},
): DynamicToolCallParams {
  return {
    threadId: CALLER,
    turnId: "turn-1",
    callId: "call-1",
    namespace: CODEX_DECK_TOOL_NAMESPACE,
    tool,
    arguments: args,
    ...overrides,
  };
}

function text(response: DynamicToolCallResponse): string {
  assert.equal(response.contentItems.length, 1);
  const item = response.contentItems[0];
  assert.equal(item.type, "inputText");
  return item.type === "inputText" ? item.text : "";
}

function json(response: DynamicToolCallResponse): Record<string, unknown> {
  assert.equal(response.success, true, text(response));
  return JSON.parse(text(response)) as Record<string, unknown>;
}

function thread(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Task ${id.slice(-1)}`,
    preview: "preview text",
    status: { type: "idle" },
    cwd: "/repo",
    projectId: null,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

test("tool specs mirror upstream and the dynamic transport omits delegation tools", () => {
  const [all] = codexDeckToolSpecs();
  assert.equal(all.type, "namespace");
  if (all.type !== "namespace") return;
  assert.equal(all.name, "codex_deck");
  assert.equal(all.tools.length, 9);
  for (const tool of all.tools) {
    assert.equal(tool.type, "function");
    assert.equal(tool.deferLoading, true);
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
  }

  const [registered] = codexDeckNonDelegationToolSpecs();
  assert.equal(registered.type, "namespace");
  if (registered.type !== "namespace") return;
  assert.deepEqual(
    registered.tools.map((tool) => tool.name),
    [
      "list_threads",
      "list_archived_threads",
      "read_thread",
      "wait_threads",
      "set_thread_title",
      "set_thread_archived",
    ],
  );
  for (const name of CODEX_DECK_DELEGATION_TOOLS) {
    assert.ok(!registered.tools.some((tool) => tool.name === name));
  }
  const descriptions = registered.tools
    .filter((tool) =>
      [
        "list_threads",
        "list_archived_threads",
        "read_thread",
        "wait_threads",
      ].includes(tool.name),
    )
    .map((tool) => tool.description);
  assert.ok(
    descriptions.every((description) => description.includes("untrusted data")),
  );
});

test("failure responses are truncated to the upstream error budget", () => {
  const response = failureResponse("x".repeat(500));
  assert.equal(response.success, false);
  const message = text(response);
  assert.equal([...message].length, 248);
  assert.ok(message.endsWith("…"));
  assert.equal(truncateText("🦀🦀🦀", 2), "🦀…");
  assert.equal(truncateText("abc", 0), "");
});

test("unknown namespaces, unknown tools and delegation tools fail without RPCs", async () => {
  const { rpc, calls } = createRpc({});
  const foreign = await executeCodexDeckDynamicTool(
    rpc,
    call("list_threads", {}, { namespace: "other_app" }),
  );
  assert.equal(foreign.success, false);
  assert.match(text(foreign), /Unsupported dynamic tool namespace: other_app/);

  const none = await executeCodexDeckDynamicTool(
    rpc,
    call("list_threads", {}, { namespace: null }),
  );
  assert.equal(none.success, false);

  const unknown = await executeCodexDeckDynamicTool(
    rpc,
    call("delete_everything", {}),
  );
  assert.equal(unknown.success, false);
  assert.match(
    text(unknown),
    /Unsupported codex-deck dynamic tool: delete_everything/,
  );

  for (const tool of CODEX_DECK_DELEGATION_TOOLS) {
    const response = await executeCodexDeckDynamicTool(
      rpc,
      call(tool, { prompt: "hi", threadId: TARGET }),
    );
    assert.equal(response.success, false);
    assert.match(text(response), /delegation tools are unavailable/);
  }
  assert.equal(calls.length, 0);
});

test("arguments are strictly validated like serde deny_unknown_fields", async () => {
  const { rpc, calls } = createRpc({});
  const cases: Array<[string, unknown, RegExp]> = [
    ["list_threads", { limit: 5, extra: true }, /unknown field `extra`/],
    ["list_threads", { limit: 0 }, /limit must be between 1 and 50/],
    ["list_threads", { limit: 51 }, /limit must be between 1 and 50/],
    ["list_threads", { limit: -1 }, /invalid value for `limit`/],
    ["list_threads", { limit: 2.5 }, /invalid type for `limit`/],
    ["list_threads", { cursor: "abc" }, /does not accept a cursor/],
    ["list_threads", "nope", /expected an object/],
    ["read_thread", {}, /missing field `threadId`/],
    ["read_thread", { threadId: 7 }, /invalid type for `threadId`/],
    [
      "read_thread",
      { threadId: TARGET, turnLimit: 11 },
      /turnLimit must be between 1 and 10/,
    ],
    [
      "read_thread",
      { threadId: TARGET, maxOutputCharsPerItem: 20_001 },
      /maxOutputCharsPerItem must not exceed 20000/,
    ],
    ["set_thread_title", { title: "   " }, /title must not be empty/],
    ["set_thread_title", {}, /missing field `title`/],
    ["set_thread_archived", { threadId: TARGET }, /missing field `archived`/],
    ["set_thread_archived", { archived: "yes" }, /invalid type for `archived`/],
    ["wait_threads", { targets: [] }, /between 1 and 8 tasks/],
    [
      "wait_threads",
      { targets: [{ threadId: TARGET, bogus: 1 }] },
      /unknown field `bogus`/,
    ],
    [
      "wait_threads",
      { targets: [{ threadId: TARGET }], timeoutMs: 120_001 },
      /must not exceed 120000/,
    ],
  ];
  for (const [tool, args, pattern] of cases) {
    const response = await executeCodexDeckDynamicTool(rpc, call(tool, args));
    assert.equal(response.success, false, `${tool} ${JSON.stringify(args)}`);
    assert.match(text(response), pattern);
  }
  assert.equal(calls.length, 0);

  const nineTargets = Array.from({ length: 9 }, (_, index) => ({
    threadId: `019a0000-0000-7000-8000-00000000010${index}`,
  }));
  const tooMany = await executeCodexDeckDynamicTool(
    rpc,
    call("wait_threads", { targets: nineTargets }),
  );
  assert.match(text(tooMany), /between 1 and 8 tasks/);
});

test("list_threads reads the state DB and marks summaries as untrusted", async () => {
  const { rpc, calls } = createRpc({
    "thread/list": () => ({
      data: [thread(TARGET, { preview: "p".repeat(400), name: null })],
      nextCursor: "next",
    }),
  });
  const listed = json(
    await executeCodexDeckDynamicTool(rpc, call("list_threads", { limit: 3 })),
  );
  assert.deepEqual(calls[0], {
    method: "thread/list",
    params: {
      cursor: null,
      limit: 3,
      sortKey: "updated_at",
      sortDirection: "desc",
      modelProviders: [],
      archived: false,
      useStateDbOnly: true,
    },
  });
  assert.equal(listed.schemaVersion, 4);
  assert.match(String(listed.untrustedDataNotice), /untrusted data/);
  const [entry] = listed.threads as Array<Record<string, unknown>>;
  assert.equal(entry.id, TARGET);
  assert.equal(entry.title, null);
  assert.equal(entry.status, "idle");
  assert.equal([...String(entry.summary)].length, 300);

  const archived = json(
    await executeCodexDeckDynamicTool(
      rpc,
      call("list_archived_threads", { cursor: "page-2", limit: null }),
    ),
  );
  assert.equal(calls[1]?.params.archived, true);
  assert.equal(calls[1]?.params.cursor, "page-2");
  assert.equal(calls[1]?.params.limit, 10);
  assert.equal(archived.nextCursor, "next");
});

test("read_thread pages turns newest first and falls back to thread/read", async () => {
  const turn = (id: string, items: unknown[]) => ({
    id,
    status: "completed",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1000,
    items,
  });
  const items = [
    {
      type: "userMessage",
      id: "u1",
      content: [{ type: "text", text: "hello" }],
    },
    {
      type: "commandExecution",
      id: "c1",
      command: "ls",
      cwd: "/repo",
      aggregatedOutput: "a".repeat(50),
      exitCode: 0,
      status: "completed",
      durationMs: 3,
    },
    { type: "agentMessage", id: "a1", text: "done", phase: "final_answer" },
  ];
  const paged = createRpc({
    "thread/read": () => ({ thread: thread(TARGET) }),
    "thread/turns/list": () => ({
      data: [turn("t2", items)],
      nextCursor: "t1",
    }),
  });
  const read = json(
    await executeCodexDeckDynamicTool(
      paged.rpc,
      call("read_thread", {
        threadId: TARGET,
        includeOutputs: true,
        maxOutputCharsPerItem: 10,
      }),
    ),
  );
  assert.deepEqual(paged.calls[1]?.params, {
    threadId: TARGET,
    cursor: null,
    limit: 1,
    sortDirection: "desc",
    itemsView: "full",
  });
  assert.equal((read.page as Record<string, unknown>).order, "newest_first");
  assert.equal((read.page as Record<string, unknown>).hasMore, true);
  const [summary] = read.turns as Array<{
    items: Array<Record<string, unknown>>;
  }>;
  assert.deepEqual(
    summary.items.map((item) => item.type),
    ["userMessage", "commandExecution", "agentMessage"],
  );
  assert.deepEqual(summary.items[1]?.output, {
    text: "aaaaaaaaaa",
    truncated: true,
    originalChars: 50,
  });

  const legacy = createRpc({
    "thread/read": (params) =>
      params.includeTurns
        ? {
            thread: {
              ...thread(TARGET),
              turns: [turn("t1", []), turn("t2", []), turn("t3", [])],
            },
          }
        : { thread: thread(TARGET) },
  });
  const fallback = json(
    await executeCodexDeckDynamicTool(
      legacy.rpc,
      call("read_thread", { threadId: TARGET, cursor: "t3", turnLimit: 1 }),
    ),
  );
  assert.deepEqual(
    (fallback.turns as Array<Record<string, unknown>>).map((entry) => entry.id),
    ["t2"],
  );
  assert.equal((fallback.page as Record<string, unknown>).nextCursor, "t2");

  const unknownCursor = await executeCodexDeckDynamicTool(
    legacy.rpc,
    call("read_thread", { threadId: TARGET, cursor: "missing" }),
  );
  assert.match(text(unknownCursor), /Unknown cursor: missing/);
});

test("rename and archive reuse Deck client helpers and protect the caller", async () => {
  const renamed: string[] = [];
  const archived: string[] = [];
  const { rpc, calls } = createRpc(
    { "thread/unarchive": () => ({}) },
    {
      setThreadName: async (threadId, name) => {
        renamed.push(`${threadId}:${name}`);
      },
      archiveThread: async (threadId) => {
        archived.push(threadId);
      },
    },
  );

  assert.deepEqual(
    json(
      await executeCodexDeckDynamicTool(
        rpc,
        call("set_thread_title", { title: "New" }),
      ),
    ),
    { threadId: CALLER, title: "New" },
  );
  assert.deepEqual(renamed, [`${CALLER}:New`]);

  const self = await executeCodexDeckDynamicTool(
    rpc,
    call("set_thread_archived", {
      archived: true,
      threadId: CALLER.toUpperCase(),
    }),
  );
  assert.equal(self.success, false);
  assert.match(text(self), /cannot archive the calling task/);

  assert.deepEqual(
    json(
      await executeCodexDeckDynamicTool(
        rpc,
        call("set_thread_archived", { threadId: TARGET, archived: true }),
      ),
    ),
    { threadId: TARGET, archived: true },
  );
  assert.deepEqual(archived, [TARGET]);

  assert.deepEqual(
    json(
      await executeCodexDeckDynamicTool(
        rpc,
        call("set_thread_archived", { archived: false }),
      ),
    ),
    { threadId: CALLER, archived: false },
  );
  assert.deepEqual(calls, [
    { method: "thread/unarchive", params: { threadId: CALLER } },
  ]);
});

function waitRpc(state: {
  status: Record<string, unknown>;
  turnStatus: string;
  updatedAt: number;
}) {
  return createRpc({
    "thread/read": (params) => ({
      thread: thread(String(params.threadId), {
        status: state.status,
        updatedAt: state.updatedAt,
      }),
    }),
    "thread/turns/list": () => ({
      data: [
        {
          id: "turn-9",
          status: state.turnStatus,
          error: null,
          items: [
            {
              type: "agentMessage",
              id: "msg-1",
              text: "finished",
              phase: "final_answer",
            },
          ],
        },
      ],
    }),
    "thread/items/list": () => ({
      data: [
        {
          turnId: "turn-9",
          item: { type: "commandExecution", id: "tool-1", status: "completed" },
        },
      ],
    }),
  });
}

test("wait_threads snapshots, wakes on completion and rejects self or duplicate waits", async () => {
  const state = {
    status: { type: "idle" },
    turnStatus: "completed",
    updatedAt: 5,
  };
  const { rpc } = waitRpc(state);

  const snapshot = json(
    await executeCodexDeckDynamicTool(
      rpc,
      call("wait_threads", { targets: [{ threadId: TARGET }], timeoutMs: 0 }),
    ),
  );
  assert.equal(snapshot.timedOut, false);
  assert.deepEqual(snapshot.wake, {
    threadId: TARGET,
    reason: "turnCompleted",
    turnId: "turn-9",
  });
  assert.equal(snapshot.errors, undefined);
  const [poll] = snapshot.polls as Array<Record<string, unknown>>;
  assert.equal(
    (poll.latestAssistantMessage as Record<string, unknown>).text,
    "finished",
  );
  assert.equal((poll.latestToolMarker as Record<string, unknown>).id, "tool-1");
  assert.equal(JSON.parse(String(poll.cursor)).latestItemId, "tool-1");

  const unchanged = json(
    await executeCodexDeckDynamicTool(
      rpc,
      call("wait_threads", {
        targets: [{ threadId: TARGET, afterCursor: poll.cursor }],
        timeoutMs: 0,
      }),
    ),
  );
  assert.equal(unchanged.timedOut, true);
  assert.equal(unchanged.wake, null);
  const [unchangedPoll] = unchanged.polls as Array<Record<string, unknown>>;
  assert.equal(unchangedPoll.changed, false);
  assert.equal(unchangedPoll.latestAssistantMessage, null);

  const selfWait = await executeCodexDeckDynamicTool(
    rpc,
    call("wait_threads", { targets: [{ threadId: CALLER }] }),
  );
  assert.match(text(selfWait), /cannot wait on the calling task/);

  const duplicate = await executeCodexDeckDynamicTool(
    rpc,
    call("wait_threads", {
      targets: [{ threadId: TARGET }, { threadId: TARGET.toUpperCase() }],
    }),
  );
  assert.match(text(duplicate), /duplicate target tasks/);
});

test("wait_threads re-polls on thread/status/changed and reports per-target errors", async () => {
  const state = {
    status: { type: "active", activeFlags: [] as string[] },
    turnStatus: "inProgress",
    updatedAt: 5,
  };
  const { rpc } = waitRpc(state);
  const listeners = new Set<(threadId: string | null) => void>();
  const started = Date.now();
  const pending = executeCodexDeckDynamicTool(
    rpc,
    call("wait_threads", {
      targets: [{ threadId: TARGET }],
      timeoutMs: 10_000,
    }),
    {
      subscribeThreadStatus: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  state.status = { type: "active", activeFlags: ["waitingOnApproval"] };
  for (const listener of listeners) listener(OTHER); // ignored: not a target
  for (const listener of listeners) listener(TARGET);
  const woke = json(await pending);
  assert.ok(
    Date.now() - started < 900,
    "status change should wake before the 1s refresh",
  );
  assert.deepEqual(woke.wake, { threadId: TARGET, reason: "actionableStatus" });
  assert.equal(listeners.size, 0, "listener is unsubscribed after the call");

  const failing = createRpc({
    "thread/read": () => {
      throw new RpcError(-32600, "thread not found");
    },
  });
  const errors = json(
    await executeCodexDeckDynamicTool(
      failing.rpc,
      call("wait_threads", { targets: [{ threadId: TARGET }], timeoutMs: 0 }),
    ),
  );
  assert.equal(errors.timedOut, false);
  assert.deepEqual(errors.errors, [
    { threadId: TARGET, message: "thread not found" },
  ]);
});

test("serializeToolResult bounds output without dropping pagination or targets", () => {
  const entries = Array.from({ length: 50 }, (_, index) => ({
    id: `thread-${index}`,
    kind: "codex",
    title: "Title".repeat(400),
    summary: "Summary".repeat(100),
    status: "idle",
    cwd: "/large/path".repeat(100),
  }));
  const listText = serializeToolResult({
    threads: entries,
    nextCursor: "next-page",
  });
  assert.ok(Buffer.byteLength(listText) <= MAX_RESPONSE_BYTES);
  const list = JSON.parse(listText) as {
    threads: Array<{ id: string }>;
    nextCursor: string;
    truncated: boolean;
  };
  assert.equal(list.nextCursor, "next-page");
  assert.equal(list.truncated, true);
  assert.deepEqual(
    list.threads.map((entry) => entry.id),
    entries.map((entry) => entry.id),
  );

  const answer = '"\\\n🦀'.repeat(10_000);
  const polls = Array.from({ length: 8 }, (_, index) => ({
    schemaVersion: 1,
    thread: { id: `thread-${index}`, status: { type: "idle" } },
    cursor: `cursor-${index}`,
    changed: true,
    latestTurn: {
      id: `turn-${index}`,
      status: "failed",
      error: { message: "Execution failed" },
    },
    latestAssistantMessage: {
      id: `answer-${index}`,
      text: answer,
      phase: "final_answer",
    },
  }));
  const waitText = serializeToolResult({
    timedOut: false,
    wake: { threadId: "thread-0" },
    polls,
    errors: [],
  });
  assert.ok(Buffer.byteLength(waitText) <= MAX_RESPONSE_BYTES);
  const wait = JSON.parse(waitText) as { polls: Array<Record<string, any>> };
  assert.equal(wait.polls.length, 8);
  for (const poll of wait.polls) {
    assert.equal(poll.truncated, true);
    assert.equal(poll.latestAssistantMessage.truncated, true);
    assert.ok(poll.latestAssistantMessage.text.length > 0);
    assert.ok(answer.startsWith(poll.latestAssistantMessage.text));
    assert.equal(poll.latestTurn.error.message, "Execution failed");
  }

  const small = { threadId: "a", title: "b" };
  assert.equal(serializeToolResult(small), JSON.stringify(small));
});

test("host answers each item/tool/call exactly once, including failures", async () => {
  const { rpc } = createRpc({ "thread/list": () => ({ data: [] }) });
  const host = new CodexDeckDynamicToolHost(rpc, {
    enabled: true,
    warn: () => {},
  });
  const replies: Array<{
    id: string | number;
    response: DynamicToolCallResponse;
  }> = [];
  const respond =
    (id: string | number) => async (response: DynamicToolCallResponse) => {
      replies.push({ id, response });
    };
  const params = call("list_threads", {});

  await Promise.all([
    host.handleToolCallRequest(7, params, respond(7)),
    host.handleToolCallRequest(7, params, respond(7)),
  ]);
  await host.handleToolCallRequest(7, params, respond(7));
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.response.success, true);

  // Same numeric value as a string id is a different JSON-RPC id.
  await host.handleToolCallRequest("7", call("nope", {}), respond("7"));
  await host.handleToolCallRequest(8, { tool: 5 }, respond(8));
  await host.handleToolCallRequest(
    9,
    call("list_threads", {}, { namespace: "x" }),
    respond(9),
  );
  assert.deepEqual(
    replies.slice(1).map((reply) => [reply.id, reply.response.success]),
    [
      ["7", false],
      [8, false],
      [9, false],
    ],
  );
  assert.match(text(replies[2]!.response), /Invalid item\/tool\/call params/);
});

test("host drops replies owned by a previous app-server process", async () => {
  let release: () => void = () => {};
  const { rpc } = createRpc({
    "thread/list": () =>
      new Promise((resolve) => {
        release = () => resolve({ data: [] });
      }),
  });
  const host = new CodexDeckDynamicToolHost(rpc, {
    enabled: true,
    warn: () => {},
  });
  const replies: DynamicToolCallResponse[] = [];
  const pending = host.handleToolCallRequest(
    1,
    call("list_threads", {}),
    async (response) => {
      replies.push(response);
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  host.reset();
  release();
  await pending;
  assert.equal(replies.length, 0);

  // After a restart, the same id belongs to the new process and is answered.
  await host.handleToolCallRequest(1, call("bogus", {}), async (response) => {
    replies.push(response);
  });
  assert.equal(replies.length, 1);
});

test("disabled hosts register nothing and fail Deck calls instead of hanging", async () => {
  const { rpc, calls } = createRpc({});
  const host = new CodexDeckDynamicToolHost(rpc, {
    enabled: false,
    warn: () => {},
  });
  const params: Record<string, unknown> = { cwd: "/repo", dynamicTools: [] };
  assert.equal(await host.configureThreadStart(params, "/repo"), false);
  assert.equal("dynamicTools" in params, false);
  const replies: DynamicToolCallResponse[] = [];
  await host.handleToolCallRequest(
    1,
    call("list_threads", {}),
    async (response) => {
      replies.push(response);
    },
  );
  assert.equal(replies[0]?.success, false);
  assert.match(text(replies[0]!), /disabled/);
  assert.equal(calls.length, 0);

  assert.equal(isCodexDeckDynamicToolsEnabledByEnv({}), true);
  assert.equal(
    isCodexDeckDynamicToolsEnabledByEnv({ CODEX_DECK_DYNAMIC_TOOLS: "0" }),
    false,
  );
  assert.equal(
    isCodexDeckDynamicToolsEnabledByEnv({ CODEX_DECK_DYNAMIC_TOOLS: "off" }),
    false,
  );
  assert.equal(
    isCodexDeckDynamicToolsEnabledByEnv({ CODEX_DECK_DYNAMIC_TOOLS: "1" }),
    true,
  );
});

test("thread/start registers tools, skips on MCP namespace collision, and falls back", async () => {
  let mcpServers: Record<string, unknown> = { docs: {} };
  const starts: Array<Record<string, unknown>> = [];
  let rejectDynamicTools = false;
  const { rpc } = createRpc({
    "config/read": () => ({ config: { mcp_servers: mcpServers } }),
  });
  const host = new CodexDeckDynamicToolHost(rpc, {
    enabled: true,
    warn: () => {},
  });
  const send = async (params: Record<string, unknown>) => {
    starts.push({ ...params });
    if (rejectDynamicTools && params.dynamicTools) {
      throw new RpcError(
        -32600,
        "thread/start.dynamicTools requires experimentalApi capability",
      );
    }
    return { thread: { id: "t" } };
  };

  await host.requestThreadStart({ cwd: "/repo" }, "/repo", send);
  assert.deepEqual(starts[0]?.dynamicTools, codexDeckNonDelegationToolSpecs());

  mcpServers = { codex_deck: { command: "x" } };
  await host.requestThreadStart({ cwd: "/repo" }, "/repo", send);
  assert.equal("dynamicTools" in starts[1]!, false);

  mcpServers = {};
  rejectDynamicTools = true;
  const result = await host.requestThreadStart({ cwd: "/repo" }, "/repo", send);
  assert.deepEqual(result, { thread: { id: "t" } });
  assert.equal(starts.length, 4);
  assert.ok(starts[2]?.dynamicTools);
  assert.equal("dynamicTools" in starts[3]!, false);

  await assert.rejects(
    host.requestThreadStart({ cwd: "/repo" }, "/repo", async () => {
      throw new RpcError(-32603, "internal error");
    }),
    /internal error/,
  );
  assert.equal(
    isDynamicToolsUnsupportedError(new RpcError(-32602, "invalid inputSchema")),
    true,
  );
  assert.equal(
    isDynamicToolsUnsupportedError(new RpcError(-32603, "dynamicTools")),
    false,
  );

  // Precomputed MCP server names skip the extra config/read round trip.
  const precomputed = createRpc({});
  const fastHost = new CodexDeckDynamicToolHost(precomputed.rpc, {
    enabled: true,
    warn: () => {},
  });
  const owned: Record<string, unknown> = {};
  assert.equal(
    await fastHost.configureThreadStart(owned, {
      cwd: "/repo",
      mcpServerNames: ["codex_deck"],
    }),
    false,
  );
  const free: Record<string, unknown> = {};
  assert.equal(
    await fastHost.configureThreadStart(free, {
      cwd: "/repo",
      mcpServerNames: ["docs"],
    }),
    true,
  );
  assert.ok(free.dynamicTools);
  assert.equal(precomputed.calls.length, 0);
});

test("app-server client answers item/tool/call over stdin exactly once", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient({
    executablePath: "codex",
    requestTimeoutMs: 100,
  });
  const writes: string[] = [];
  (client as unknown as { process: unknown }).process = {
    stdin: {
      write: (data: string, callback: (error?: Error | null) => void) => {
        writes.push(data);
        callback(null);
        return true;
      },
    },
  };
  const handle = (
    client as unknown as {
      handleStdoutMessage: (message: Record<string, unknown>) => void;
    }
  ).handleStdoutMessage.bind(client);
  const message = {
    jsonrpc: "2.0",
    id: 42,
    method: "item/tool/call",
    params: call("list_threads", {}, { namespace: "someone_else" }),
  };
  handle(message);
  handle(message);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(writes.length, 1);
  const reply = JSON.parse(writes[0]!) as {
    id: number;
    result: DynamicToolCallResponse;
    error?: unknown;
  };
  assert.equal(reply.id, 42);
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.success, false);
  assert.match(text(reply.result), /Unsupported dynamic tool namespace/);
  (client as unknown as { process: unknown }).process = null;
});

test("conversation parser qualifies codex_deck tool calls only", () => {
  const lines = [
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "list_threads",
        namespace: "codex_deck",
        arguments: '{"limit":2}',
        call_id: "call_deck",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_deck",
        output: '{"threads":[]}',
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "sleep",
        namespace: "clock",
        arguments: '{"duration_ms":1}',
        call_id: "call_clock",
      },
    },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n");
  const { messages } = parseConversationTextChunk(`${lines}\n`, 0);
  const blocks = messages.flatMap((message) =>
    Array.isArray(message.message?.content) ? message.message.content : [],
  );
  const deckUse = blocks.find(
    (block) => block.type === "tool_use" && block.id === "call_deck",
  );
  const deckResult = blocks.find(
    (block) =>
      block.type === "tool_result" && block.tool_use_id === "call_deck",
  );
  const clockUse = blocks.find(
    (block) => block.type === "tool_use" && block.id === "call_clock",
  );
  assert.equal(deckUse?.name, "codex_deck.list_threads");
  assert.deepEqual(deckUse?.input, { limit: 2 });
  assert.equal(deckResult?.name, "codex_deck.list_threads");
  assert.equal(clockUse?.name, "sleep");
});

test("web helpers label Deck task tools and detect failures", () => {
  assert.equal(getCodexDeckToolLabel("codex_deck.read_thread"), "Read task");
  assert.equal(
    getCodexDeckToolLabel("codex_deck.set_thread_archived", {
      archived: false,
    }),
    "Restore task",
  );
  assert.equal(getCodexDeckToolLabel("read_thread"), null);
  assert.equal(
    getCodexDeckToolPreview("codex_deck.wait_threads", {
      targets: [{}, {}],
      timeoutMs: 0,
    }),
    "2 tasks · snapshot",
  );
  assert.equal(
    getCodexDeckToolPreview("codex_deck.read_thread", { threadId: TARGET }),
    "019a0000…",
  );

  const items = JSON.stringify([
    { type: "input_text", text: '{"threads":[{"id":"a"}]}' },
  ]);
  assert.deepEqual(parseCodexDeckToolOutput(items).value, {
    threads: [{ id: "a" }],
  });
  assert.equal(
    getCodexDeckToolResultPreview("codex_deck.list_threads", items),
    "1 task",
  );
  assert.equal(
    getCodexDeckToolResultPreview(
      "codex_deck.wait_threads",
      '{"timedOut":false,"wake":{"threadId":"abc","reason":"turnCompleted"},"polls":[]}',
    ),
    "turnCompleted · abc",
  );
  assert.equal(
    isCodexDeckToolFailureOutput(
      "codex_deck.list_threads",
      "limit must be between 1 and 50",
    ),
    true,
  );
  assert.equal(
    isCodexDeckToolFailureOutput("codex_deck.list_threads", '{"threads":[]}'),
    false,
  );
  assert.equal(isCodexDeckToolFailureOutput("exec_command", "plain"), false);
});

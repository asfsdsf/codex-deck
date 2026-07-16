import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  __TEST_ONLY__,
  CodexAppServerRpcError,
  CodexAppServerTransportError,
  closeCodexAppServerClient,
  getCodexAppServerClient,
  isCodexReasoningEffort,
} from "../../api/codex-app-server";

test("isCodexReasoningEffort validates supported values", () => {
  assert.equal(isCodexReasoningEffort("none"), true);
  assert.equal(isCodexReasoningEffort("minimal"), true);
  assert.equal(isCodexReasoningEffort("low"), true);
  assert.equal(isCodexReasoningEffort("medium"), true);
  assert.equal(isCodexReasoningEffort("high"), true);
  assert.equal(isCodexReasoningEffort("xhigh"), true);

  assert.equal(isCodexReasoningEffort(""), false);
  assert.equal(isCodexReasoningEffort("ultra"), false);
  assert.equal(isCodexReasoningEffort(null), false);
  assert.equal(isCodexReasoningEffort(undefined), false);
});

test("Codex app-server error classes preserve structured fields", () => {
  const rpc = new CodexAppServerRpcError(-32000, "rpc failed", {
    requestId: 42,
  });
  const transport = new CodexAppServerTransportError("offline");

  assert.equal(rpc.name, "CodexAppServerRpcError");
  assert.equal(rpc.code, -32000);
  assert.deepEqual(rpc.data, { requestId: 42 });
  assert.equal(rpc.message, "rpc failed");

  assert.equal(transport.name, "CodexAppServerTransportError");
  assert.equal(transport.message, "offline");
});

test("API key masking preserves prefix and trailing characters for status display", () => {
  assert.equal(__TEST_ONLY__.maskApiKey("sk-2h123456jf8a7"), "sk-2h****jf8a7");
  assert.equal(__TEST_ONLY__.maskApiKey(""), null);
  assert.equal(__TEST_ONLY__.maskApiKey(null), null);
});

test("runtime provider API key resolution falls back to live OpenAI env vars", () => {
  const previousCodexApiKey = process.env.CODEX_API_KEY;
  const previousOpenAiApiKey = process.env.OPENAI_API_KEY;

  process.env.CODEX_API_KEY = "sk-2h123456jf8a7";
  delete process.env.OPENAI_API_KEY;

  try {
    assert.equal(
      __TEST_ONLY__.resolveRuntimeProviderApiKey("openai", null, null),
      "sk-2h123456jf8a7",
    );
    assert.equal(
      __TEST_ONLY__.maskApiKey(
        __TEST_ONLY__.resolveRuntimeProviderApiKey("openai", null, null),
      ),
      "sk-2h****jf8a7",
    );
  } finally {
    if (previousCodexApiKey === undefined) {
      delete process.env.CODEX_API_KEY;
    } else {
      process.env.CODEX_API_KEY = previousCodexApiKey;
    }

    if (previousOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAiApiKey;
    }
  }
});

test("client lifecycle helpers are callable and close idempotently", async () => {
  const clientA = getCodexAppServerClient();
  const clientB = getCodexAppServerClient();

  assert.equal(typeof clientA.listModels, "function");
  assert.equal(typeof clientA.createThread, "function");
  assert.equal(typeof clientA.sendMessage, "function");
  assert.equal(typeof clientA.getThreadState, "function");
  assert.equal(typeof clientA.listPendingUserInputRequests, "function");
  assert.equal(typeof clientA.listPendingApprovalRequests, "function");

  // Wrapper objects can differ while sharing the same underlying client.
  assert.notEqual(clientA, clientB);

  await closeCodexAppServerClient();
  await closeCodexAppServerClient();
});

test("stdout parser reconstructs multi-line app-server responses with utf-8 content", () => {
  const parser = new __TEST_ONLY__.AppServerStdoutMessageParser();
  const fixtureDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "fixtures",
    "stdout-parser",
    "多语言-fixture",
  );
  const rawResponse = JSON.stringify({
    id: 3,
    result: {
      thread: {
        id: "thread-demo-001",
        turns: [
          {
            id: "turn-a",
            status: "completed",
            items: [
              {
                type: "commandExecution",
                id: "call-a",
                command: "cat report.txt",
                cwd: fixtureDir,
                processId: "123",
                status: "completed",
                commandActions: [],
                aggregatedOutput: "alpha\n示例二\nomega",
                exitCode: 0,
                durationMs: 5,
              },
            ],
          },
        ],
      },
    },
  }).replace("alpha\\n示例二\\nomega", "alpha\n示例二\nomega");
  const bytes = Buffer.from(rawResponse, "utf8");
  const chunks = [
    bytes.subarray(0, 17),
    bytes.subarray(17, 33),
    bytes.subarray(33, 34),
    bytes.subarray(34, 61),
    bytes.subarray(61),
  ];

  const parsedMessages = chunks.flatMap((chunk) => parser.push(chunk));

  assert.equal(parsedMessages.length, 1);
  assert.equal(parsedMessages[0]?.id, 3);

  const aggregatedOutput =
    (
      (
        (parsedMessages[0]?.result as Record<string, unknown>)?.thread as {
          turns?: Array<{
            items?: Array<{ aggregatedOutput?: unknown }>;
          }>;
        }
      )?.turns?.[0]?.items?.[0] as { aggregatedOutput?: unknown }
    )?.aggregatedOutput ?? null;
  const cwd =
    (
      (
        (parsedMessages[0]?.result as Record<string, unknown>)?.thread as {
          turns?: Array<{
            items?: Array<{ cwd?: unknown }>;
          }>;
        }
      )?.turns?.[0]?.items?.[0] as { cwd?: unknown }
    )?.cwd ?? null;

  assert.equal(aggregatedOutput, "alpha\n示例二\nomega");
  assert.equal(cwd, fixtureDir);
});

test("Windows command resolution prefers spawnable codex wrappers", () => {
  const resolved = __TEST_ONLY__.resolveWindowsCommandPath("codex", {
    lookupCommand: () => [
      "C:\\Users\\example\\AppData\\Roaming\\npm\\codex",
      "C:\\Users\\example\\AppData\\Roaming\\npm\\codex.cmd",
      "C:\\Users\\example\\AppData\\Roaming\\npm\\codex.ps1",
    ],
  });

  assert.equal(
    resolved,
    "C:\\Users\\example\\AppData\\Roaming\\npm\\codex.cmd",
  );
});

test("Windows path resolution upgrades extensionless codex shims to .cmd", () => {
  const resolved = __TEST_ONLY__.resolveWindowsCommandPath(
    "C:\\Users\\example\\AppData\\Roaming\\npm\\codex",
    {
      pathExists: (path) =>
        path === "C:\\Users\\example\\AppData\\Roaming\\npm\\codex.cmd",
    },
  );

  assert.equal(
    resolved,
    "C:\\Users\\example\\AppData\\Roaming\\npm\\codex.cmd",
  );
});

test("Windows spawn spec uses the shell for .cmd wrappers only", () => {
  const cmdSpec = __TEST_ONLY__.createCodexAppServerSpawnSpec(
    "C:\\Users\\example\\AppData\\Roaming\\npm\\codex.cmd",
    "win32",
  );
  assert.deepEqual(cmdSpec, {
    command:
      '"C:\\Users\\example\\AppData\\Roaming\\npm\\codex.cmd" app-server',
    args: [],
    shell: true,
  });

  const exeSpec = __TEST_ONLY__.createCodexAppServerSpawnSpec(
    "C:\\Program Files\\Codex\\codex.exe",
    "win32",
  );
  assert.deepEqual(exeSpec, {
    command: "C:\\Program Files\\Codex\\codex.exe",
    args: ["app-server"],
  });
});

test("read coalescer reuses one in-flight load and short-lived cached value", async () => {
  const coalescer = __TEST_ONLY__.createReadCoalescer();
  let callCount = 0;

  const [first, second] = await Promise.all([
    coalescer.getOrLoad("models:200", 1_000, async () => {
      callCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { value: callCount };
    }),
    coalescer.getOrLoad("models:200", 1_000, async () => {
      callCount += 1;
      return { value: callCount };
    }),
  ]);

  assert.deepEqual(first, { value: 1 });
  assert.deepEqual(second, { value: 1 });
  assert.equal(callCount, 1);

  const cached = await coalescer.getOrLoad("models:200", 1_000, async () => {
    callCount += 1;
    return { value: callCount };
  });

  assert.deepEqual(cached, { value: 1 });
  assert.equal(callCount, 1);
});

test("read coalescer can clear matching cached keys", async () => {
  const coalescer = __TEST_ONLY__.createReadCoalescer();
  let callCount = 0;

  const load = async () => {
    callCount += 1;
    return callCount;
  };

  assert.equal(await coalescer.getOrLoad("thread-state:a:", 1_000, load), 1);
  assert.equal(await coalescer.getOrLoad("thread-state:a:", 1_000, load), 1);

  coalescer.clearMatching((key) => key.startsWith("thread-state:a:"));

  assert.equal(await coalescer.getOrLoad("thread-state:a:", 1_000, load), 2);
  assert.equal(callCount, 2);
});

test("app-server client updates loaded thread settings before starting a turn", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const requests: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  (
    client as unknown as {
      request: (
        method: string,
        params: Record<string, unknown>,
      ) => Promise<unknown>;
    }
  ).request = async (method, params) => {
    requests.push({ method, params });
    if (method === "config/read") {
      return {
        config: {
          model: "gpt-5.5",
          model_provider: "aijws",
          model_reasoning_effort: "medium",
        },
      };
    }
    if (method === "thread/resume") {
      return {
        modelProvider: "aijws",
        thread: {
          id: "thread-1",
          modelProvider: "aijws",
        },
      };
    }
    if (method === "thread/settings/update") {
      return {};
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-1" } };
    }
    throw new Error(`unexpected method: ${method}`);
  };

  try {
    const result = await client.sendMessage({
      threadId: "thread-1",
      input: [{ type: "text", text: "hello" }],
      model: "gpt-5.1-codex-mini",
      effort: "high",
      serviceTier: "fast",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.1-codex-mini",
          reasoningEffort: "high",
        },
      },
    });

    assert.deepEqual(result, { turnId: "turn-1" });
    assert.equal(requests[0]?.method, "config/read");
    assert.equal(requests[1]?.method, "thread/resume");
    assert.deepEqual(requests[1]?.params, {
      threadId: "thread-1",
      persistExtendedHistory: true,
      model: "gpt-5.5",
      modelProvider: "aijws",
      config: {
        model_reasoning_effort: "medium",
      },
    });
    assert.equal(requests[2]?.method, "thread/settings/update");
    assert.deepEqual(requests[2]?.params, {
      threadId: "thread-1",
      model: "gpt-5.1-codex-mini",
      serviceTier: "fast",
      effort: "high",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.1-codex-mini",
          reasoning_effort: "high",
        },
      },
    });
    assert.equal(requests[3]?.method, "turn/start");
  } finally {
    await client.close();
  }
});

test("app-server client starts first turn for new thread without pre-resume", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const requests: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  (
    client as unknown as {
      request: (
        method: string,
        params: Record<string, unknown>,
      ) => Promise<unknown>;
    }
  ).request = async (method, params) => {
    requests.push({ method, params });
    if (method === "config/read") {
      return {
        config: {
          model: "gpt-5.5",
          model_provider: "aijws",
          model_reasoning_effort: "high",
        },
      };
    }
    if (method === "thread/start") {
      return {
        thread: {
          id: "new-thread-1",
        },
      };
    }
    if (method === "thread/settings/update") {
      return {};
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-1" } };
    }
    throw new Error(`unexpected method: ${method}`);
  };

  try {
    const threadId = await client.createThread({
      cwd: "/repo",
    });
    const result = await client.sendMessage({
      threadId,
      input: [{ type: "text", text: "hello" }],
      cwd: "/repo",
    });

    assert.deepEqual(result, { turnId: "turn-1" });
    assert.deepEqual(
      requests.map((request) => request.method),
      [
        "config/read",
        "thread/start",
        "config/read",
        "thread/settings/update",
        "turn/start",
      ],
    );
  } finally {
    await client.close();
  }
});

test("app-server client reloads stale loaded thread provider before starting a turn", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const requests: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  let resumeCount = 0;
  (
    client as unknown as {
      request: (
        method: string,
        params: Record<string, unknown>,
      ) => Promise<unknown>;
    }
  ).request = async (method, params) => {
    requests.push({ method, params });
    if (method === "config/read") {
      return {
        config: {
          model: "gpt-5.5",
          model_provider: "aijws",
          model_reasoning_effort: "high",
        },
      };
    }
    if (method === "thread/resume") {
      resumeCount += 1;
      return {
        modelProvider: resumeCount === 1 ? "freemodel" : "aijws",
        thread: {
          id: "thread-1",
          modelProvider: resumeCount === 1 ? "freemodel" : "aijws",
        },
      };
    }
    if (method === "thread/unsubscribe") {
      return { status: "unsubscribed" };
    }
    if (method === "thread/settings/update") {
      return {};
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-1" } };
    }
    throw new Error(`unexpected method: ${method}`);
  };

  try {
    const result = await client.sendMessage({
      threadId: "thread-1",
      input: [{ type: "text", text: "hello" }],
    });

    assert.deepEqual(result, { turnId: "turn-1" });
    assert.deepEqual(
      requests.map((request) => request.method),
      [
        "config/read",
        "thread/resume",
        "thread/unsubscribe",
        "thread/resume",
        "thread/settings/update",
        "turn/start",
      ],
    );
    assert.deepEqual(requests[1]?.params, {
      threadId: "thread-1",
      persistExtendedHistory: true,
      model: "gpt-5.5",
      modelProvider: "aijws",
      config: {
        model_reasoning_effort: "high",
      },
    });
    assert.deepEqual(requests[5]?.params, {
      threadId: "thread-1",
      input: [{ type: "text", text: "hello" }],
      attachments: [],
      model: "gpt-5.5",
      effort: "high",
    });
  } finally {
    await client.close();
  }
});

test("app-server client unsubscribes after each stale provider resume", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const requests: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  let resumeCount = 0;
  (
    client as unknown as {
      request: (
        method: string,
        params: Record<string, unknown>,
      ) => Promise<unknown>;
    }
  ).request = async (method, params) => {
    requests.push({ method, params });
    if (method === "config/read") {
      return {
        config: {
          model: "gpt-5.5",
          model_provider: "aijws",
        },
      };
    }
    if (method === "thread/resume") {
      resumeCount += 1;
      const modelProvider = resumeCount < 3 ? "freemodel" : "aijws";
      return {
        modelProvider,
        thread: {
          id: "thread-1",
          modelProvider,
        },
      };
    }
    if (method === "thread/unsubscribe") {
      return { status: "unsubscribed" };
    }
    if (method === "thread/settings/update") {
      return {};
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-1" } };
    }
    throw new Error(`unexpected method: ${method}`);
  };

  try {
    const result = await client.sendMessage({
      threadId: "thread-1",
      input: [{ type: "text", text: "hello" }],
    });

    assert.deepEqual(result, { turnId: "turn-1" });
    assert.deepEqual(
      requests.map((request) => request.method),
      [
        "config/read",
        "thread/resume",
        "thread/unsubscribe",
        "thread/resume",
        "thread/unsubscribe",
        "thread/resume",
        "thread/settings/update",
        "turn/start",
      ],
    );
  } finally {
    await client.close();
  }
});

test("app-server client force-reloads a system-error thread to switch provider", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  (
    client as unknown as { providerRefreshRetryDelaysMs: number[] }
  ).providerRefreshRetryDelaysMs = [0];
  const requests: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  let archived = false;
  const emitServerNotification = (method: string, params: unknown) => {
    (
      client as unknown as {
        handleServerNotification: (method: string, params: unknown) => void;
      }
    ).handleServerNotification(method, params);
  };
  (
    client as unknown as {
      request: (
        method: string,
        params: Record<string, unknown>,
      ) => Promise<unknown>;
    }
  ).request = async (method, params) => {
    requests.push({ method, params });
    if (method === "config/read") {
      return {
        config: {
          model: "gpt-5.5",
          model_provider: "aijws",
        },
      };
    }
    if (method === "thread/resume") {
      const modelProvider = archived ? "aijws" : "freemodel";
      return {
        modelProvider,
        thread: {
          id: "thread-1",
          modelProvider,
          status: archived ? { type: "idle" } : { type: "systemError" },
        },
      };
    }
    if (method === "thread/unsubscribe") {
      return { status: "unsubscribed" };
    }
    if (method === "thread/read") {
      return {
        thread: {
          id: "thread-1",
          status: { type: "systemError" },
          turns: [],
        },
      };
    }
    if (method === "thread/archive") {
      archived = true;
      emitServerNotification("thread/archived", { threadId: "thread-1" });
      emitServerNotification("thread/archived", { threadId: "child-1" });
      return {};
    }
    if (method === "thread/unarchive") {
      return { thread: { id: params.threadId } };
    }
    if (method === "thread/settings/update") {
      return {};
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-1" } };
    }
    throw new Error(`unexpected method: ${method}`);
  };

  try {
    const result = await client.sendMessage({
      threadId: "thread-1",
      input: [{ type: "text", text: "hello" }],
    });

    assert.deepEqual(result, { turnId: "turn-1" });
    assert.deepEqual(
      requests.map((request) => request.method),
      [
        "config/read",
        "thread/resume",
        "thread/unsubscribe",
        "thread/resume",
        "thread/unsubscribe",
        "thread/read",
        "thread/archive",
        "thread/unarchive",
        "thread/unarchive",
        "thread/resume",
        "thread/settings/update",
        "turn/start",
      ],
    );
    const unarchivedThreadIds = requests
      .filter((request) => request.method === "thread/unarchive")
      .map((request) => request.params.threadId);
    assert.deepEqual(unarchivedThreadIds, ["thread-1", "child-1"]);
  } finally {
    await client.close();
  }
});

test("app-server client does not force-reload an active thread on provider switch", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  (
    client as unknown as { providerRefreshRetryDelaysMs: number[] }
  ).providerRefreshRetryDelaysMs = [0];
  const requests: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  (
    client as unknown as {
      request: (
        method: string,
        params: Record<string, unknown>,
      ) => Promise<unknown>;
    }
  ).request = async (method, params) => {
    requests.push({ method, params });
    if (method === "config/read") {
      return {
        config: {
          model: "gpt-5.5",
          model_provider: "aijws",
        },
      };
    }
    if (method === "thread/resume") {
      return {
        modelProvider: "freemodel",
        thread: {
          id: "thread-1",
          modelProvider: "freemodel",
          status: { type: "active", activeFlags: [] },
        },
      };
    }
    if (method === "thread/unsubscribe") {
      return { status: "unsubscribed" };
    }
    if (method === "thread/read") {
      return {
        thread: {
          id: "thread-1",
          status: { type: "active", activeFlags: [] },
          turns: [],
        },
      };
    }
    throw new Error(`unexpected method: ${method}`);
  };

  try {
    await assert.rejects(
      client.sendMessage({
        threadId: "thread-1",
        input: [{ type: "text", text: "hello" }],
      }),
      /Unable to switch loaded thread thread-1/,
    );
    assert.equal(
      requests.some((request) => request.method === "thread/archive"),
      false,
    );
  } finally {
    await client.close();
  }
});

test("app-server client does not fail send when provider preflight sees an unmaterialized rollout", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const requests: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  (
    client as unknown as {
      request: (
        method: string,
        params: Record<string, unknown>,
      ) => Promise<unknown>;
    }
  ).request = async (method, params) => {
    requests.push({ method, params });
    if (method === "config/read") {
      return {
        config: {
          model: "gpt-5.5",
          model_provider: "aijws",
        },
      };
    }
    if (method === "thread/resume") {
      throw new CodexAppServerRpcError(
        -32602,
        "No rollout found for thread id thread-1",
      );
    }
    if (method === "thread/settings/update") {
      return {};
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-1" } };
    }
    throw new Error(`unexpected method: ${method}`);
  };

  try {
    const result = await client.sendMessage({
      threadId: "thread-1",
      input: [{ type: "text", text: "hello" }],
    });

    assert.deepEqual(result, { turnId: "turn-1" });
    assert.deepEqual(
      requests.map((request) => request.method),
      ["config/read", "thread/resume", "thread/settings/update", "turn/start"],
    );
  } finally {
    await client.close();
  }
});

test("app-server notifications are emitted as live codex events", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient({
    requestTimeoutMs: 100,
  });
  const events: unknown[] = [];
  const unsubscribe = client.subscribeAppServerEvents((event) => {
    events.push(event);
  });
  const handleNotification = (
    client as unknown as {
      handleServerNotification: (method: string, params: unknown) => void;
    }
  ).handleServerNotification.bind(client);

  handleNotification("error", {
    threadId: "thread-1",
    turnId: "turn-1",
    willRetry: true,
    error: {
      message: "Reconnecting... 1/5",
      additionalDetails: "Idle timeout waiting for SSE",
    },
  });

  assert.deepEqual(events, [
    {
      type: "error",
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: true,
      error: {
        message: "Reconnecting... 1/5",
        additionalDetails: "Idle timeout waiting for SSE",
      },
    },
  ]);

  handleNotification("item/agentMessage/delta", {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "message-1",
    delta: "hello",
  });
  handleNotification("item/plan/delta", {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "plan-1",
    delta: "- step\n",
  });
  handleNotification("item/reasoning/summaryTextDelta", {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "reasoning-1",
    delta: "thinking",
    summaryIndex: 2,
  });
  handleNotification("item/reasoning/textDelta", {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "raw-reasoning-1",
    delta: "raw thinking",
    contentIndex: 3,
  });

  assert.deepEqual(events.slice(1), [
    {
      type: "assistant_delta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      delta: "hello",
    },
    {
      type: "plan_delta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "plan-1",
      delta: "- step\n",
    },
    {
      type: "reasoning_summary_delta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "reasoning-1",
      delta: "thinking",
      summaryIndex: 2,
    },
    {
      type: "reasoning_text_delta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "raw-reasoning-1",
      delta: "raw thinking",
      contentIndex: 3,
    },
  ]);

  unsubscribe();
  handleNotification("error", {
    threadId: "thread-1",
    turnId: "turn-2",
    willRetry: true,
    error: {
      message: "Reconnecting... 2/5",
      additionalDetails: null,
    },
  });
  assert.equal(events.length, 5);
});

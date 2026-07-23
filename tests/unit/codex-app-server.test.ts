import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  __TEST_ONLY__,
  CodexAppServerRpcError,
  CodexAppServerTransportError,
  closeCodexAppServerClient,
  getCodexAppServerClient,
  restartCodexAppServerClient,
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
  assert.equal(typeof clientA.restartAppServer, "function");
  assert.equal(typeof clientA.createThread, "function");
  assert.equal(typeof clientA.sendMessage, "function");
  assert.equal(typeof clientA.getThreadState, "function");
  assert.equal(typeof clientA.listPendingUserInputRequests, "function");
  assert.equal(typeof clientA.listPendingApprovalRequests, "function");

  // Wrapper objects can differ while sharing the same underlying client.
  assert.notEqual(clientA, clientB);

  await closeCodexAppServerClient();
  await closeCodexAppServerClient();
  assert.equal(await restartCodexAppServerClient(), false);
});

test("app-server history restart is serialized and initializes a fresh process", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const internals = client as unknown as {
    process: unknown;
    close: () => Promise<void>;
    ensureStarted: () => void;
    ensureInitialized: () => Promise<void>;
  };
  let closeCount = 0;
  let startCount = 0;
  let initializeCount = 0;
  internals.process = { generation: 1 };
  internals.close = async () => {
    closeCount += 1;
    internals.process = null;
  };
  internals.ensureStarted = () => {
    startCount += 1;
    internals.process = { generation: 2 };
  };
  internals.ensureInitialized = async () => {
    initializeCount += 1;
  };

  const [first, second] = await Promise.all([
    client.restartAppServer(),
    client.restartAppServer(),
  ]);

  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(closeCount, 1);
  assert.equal(startCount, 1);
  assert.equal(initializeCount, 1);
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
    assert.equal(requests[1]?.method, "thread/settings/update");
    assert.deepEqual(requests[1]?.params, {
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
    assert.equal(requests[2]?.method, "turn/start");
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

test("app-server client restarts when model provider changes and threads are idle", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const requests: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  let closeCount = 0;
  const internals = client as unknown as {
    process: unknown;
    close: () => Promise<void>;
    request: (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>;
    lastKnownProviderId: string | null;
  };
  internals.process = { stub: true };
  internals.lastKnownProviderId = "openai";
  internals.close = async () => {
    closeCount += 1;
    internals.process = null;
  };
  internals.request = async (method, params) => {
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
    if (method === "thread/loaded/list") {
      return { data: ["thread-1"] };
    }
    if (method === "thread/read") {
      return { thread: { id: "thread-1", status: { type: "idle" } } };
    }
    throw new Error(`unexpected method: ${method}`);
  };

  const activeConfig = {
    model: "gpt-5.5",
    modelProvider: "aijws",
    reasoningEffort: "high" as const,
    serviceTier: null as string | null,
  };
  await internals.reloadProviderIfChanged?.(activeConfig);

  assert.equal(closeCount, 1);
  assert.equal(internals.lastKnownProviderId, null);
  assert.deepEqual(
    requests.map((r) => r.method),
    ["thread/loaded/list", "thread/read"],
  );

  await client.close();
});

test("app-server client defers provider restart while a thread is active", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  let closeCount = 0;
  let threadStatus = "active";
  const internals = client as unknown as {
    process: unknown;
    close: () => Promise<void>;
    request: (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>;
    lastKnownProviderId: string | null;
  };
  internals.process = { stub: true };
  internals.lastKnownProviderId = "openai";
  internals.close = async () => {
    closeCount += 1;
    internals.process = null;
  };
  internals.request = async (method) => {
    if (method === "thread/loaded/list") {
      return { data: ["thread-1"] };
    }
    if (method === "thread/read") {
      return { thread: { id: "thread-1", status: { type: threadStatus } } };
    }
    throw new Error(`unexpected method: ${method}`);
  };

  const oldProvider = {
    model: "gpt-5.5",
    modelProvider: "openai",
    reasoningEffort: "high" as const,
    serviceTier: null as string | null,
  };
  const newProvider = {
    model: "gpt-5.5",
    modelProvider: "aijws",
    reasoningEffort: "high" as const,
    serviceTier: null as string | null,
  };

  // Active thread — restart deferred, baseline preserved
  await internals.reloadProviderIfChanged?.(newProvider);
  assert.equal(closeCount, 0);
  assert.equal(internals.lastKnownProviderId, "openai");

  // Thread goes idle — restart now fires
  threadStatus = "idle";
  await internals.reloadProviderIfChanged?.(newProvider);
  assert.equal(closeCount, 1);
  assert.equal(internals.lastKnownProviderId, null);

  await client.close();
});

test("app-server client skips provider restart when provider is unchanged", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  let closeCount = 0;
  const requests: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  const internals = client as unknown as {
    process: unknown;
    close: () => Promise<void>;
    request: (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>;
    lastKnownProviderId: string | null;
  };
  internals.process = { stub: true };
  internals.lastKnownProviderId = "openai";
  internals.close = async () => {
    closeCount += 1;
    internals.process = null;
  };
  internals.request = async (method, params) => {
    requests.push({ method, params });
    throw new Error(`unexpected method: ${method}`);
  };

  const sameProvider = {
    model: "gpt-5.5",
    modelProvider: "openai",
    reasoningEffort: "high" as const,
    serviceTier: null as string | null,
  };
  await internals.reloadProviderIfChanged?.(sameProvider);

  assert.equal(closeCount, 0);
  assert.equal(requests.length, 0);

  await client.close();
});

test("app-server client lazily baselines provider on first call", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  let closeCount = 0;
  const requests: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  const internals = client as unknown as {
    process: unknown;
    close: () => Promise<void>;
    request: (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>;
    lastKnownProviderId: string | null;
  };
  internals.process = { stub: true };
  internals.lastKnownProviderId = null;
  internals.close = async () => {
    closeCount += 1;
    internals.process = null;
  };
  internals.request = async (method, params) => {
    requests.push({ method, params });
    throw new Error(`unexpected method: ${method}`);
  };

  const initialConfig = {
    model: "gpt-5.5",
    modelProvider: "openai",
    reasoningEffort: "high" as const,
    serviceTier: null as string | null,
  };
  // First call baselines the provider without restarting
  await internals.reloadProviderIfChanged?.(initialConfig);
  assert.equal(closeCount, 0);
  assert.equal(internals.lastKnownProviderId, "openai");
  assert.equal(requests.length, 0);

  await client.close();
});

test("app-server client baselines provider after restart-driven close", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  let closeCount = 0;
  const internals = client as unknown as {
    process: unknown;
    close: () => Promise<void>;
    request: (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>;
    lastKnownProviderId: string | null;
  };
  internals.process = { stub: true };
  internals.lastKnownProviderId = "openai";
  internals.close = async () => {
    closeCount += 1;
    internals.process = null;
  };
  internals.request = async (method) => {
    if (method === "thread/loaded/list") {
      return { data: [] };
    }
    throw new Error(`unexpected method: ${method}`);
  };

  const newProvider = {
    model: "gpt-5.5",
    modelProvider: "aijws",
    reasoningEffort: "high" as const,
    serviceTier: null as string | null,
  };
  // Provider changed — restart fires
  await internals.reloadProviderIfChanged?.(newProvider);
  assert.equal(closeCount, 1);
  assert.equal(internals.lastKnownProviderId, null);

  // Process restarted externally; next call re-baselines
  internals.process = { stub: true };
  await internals.reloadProviderIfChanged?.(newProvider);
  assert.equal(closeCount, 1);
  assert.equal(internals.lastKnownProviderId, "aijws");

  await client.close();
});

test("app-server client does not restart on send when provider is unchanged", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const requests: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  let closeCount = 0;
  const internals = client as unknown as {
    process: unknown;
    close: () => Promise<void>;
    request: (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>;
    lastKnownProviderId: string | null;
    readAuthFileFingerprint: () => string;
    authFileFingerprint: string | null;
    readCoalescer: { clearMatching: (fn: () => boolean) => void };
  };
  internals.process = { stub: true };
  internals.lastKnownProviderId = "openai";
  internals.authFileFingerprint = "stable";
  internals.readAuthFileFingerprint = () => "stable";
  internals.close = async () => {
    closeCount += 1;
    internals.process = null;
  };
  internals.request = async (method, params) => {
    requests.push({ method, params });
    if (method === "config/read") {
      return {
        config: {
          model: "gpt-5.5",
          model_provider: "openai",
          model_reasoning_effort: "high",
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
    });

    assert.deepEqual(result, { turnId: "turn-1" });
    assert.equal(closeCount, 0);
    // Provider unchanged so no thread/loaded/list or thread/read
    assert.equal(
      requests.some((r) => r.method === "thread/loaded/list"),
      false,
    );
  } finally {
    await client.close();
  }
});

test("app-server client restarts before send when provider has changed", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const requests: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  let closeCount = 0;
  const internals = client as unknown as {
    process: unknown;
    close: () => Promise<void>;
    request: (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>;
    lastKnownProviderId: string | null;
    authFileFingerprint: string | null;
    readAuthFileFingerprint: () => string;
    readCoalescer: { clearMatching: (fn: () => boolean) => void };
  };
  internals.process = { stub: true };
  internals.lastKnownProviderId = "openai";
  internals.authFileFingerprint = "stable";
  internals.readAuthFileFingerprint = () => "stable";
  internals.close = async () => {
    closeCount += 1;
    // Simulate process restart: keep a stub process so subsequent requests work
    internals.process = { stub: true };
  };
  internals.request = async (method, params) => {
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
    if (method === "thread/loaded/list") {
      return { data: [] };
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
    assert.equal(closeCount, 1);
    assert.deepEqual(
      requests.map((r) => r.method),
      [
        "config/read",
        "thread/loaded/list",
        "thread/settings/update",
        "turn/start",
      ],
    );
    // After restart the provider baseline is cleared so the next call re-baselines
    assert.equal(internals.lastKnownProviderId, null);
  } finally {
    await client.close();
  }
});

test("app-server client does not fail send when thread resume sees an unmaterialized rollout", async () => {
  // After provider restart, the fresh app-server has no loaded thread.
  // turn/start fails with "thread not found", triggering a resume retry.
  // If resume itself fails (unmaterialized rollout), the error must surface
  // rather than silently succeeding.
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const requests: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  const internals = client as unknown as {
    process: unknown;
    close: () => Promise<void>;
    lastKnownProviderId: string | null;
    authFileFingerprint: string | null;
    readAuthFileFingerprint: () => string;
    readCoalescer: { clearMatching: (fn: () => boolean) => void };
  };
  internals.process = { stub: true };
  internals.lastKnownProviderId = "openai";
  internals.authFileFingerprint = "stable";
  internals.readAuthFileFingerprint = () => "stable";
  internals.close = async () => {
    internals.process = null;
  };
  internals.request = async (method, params) => {
    requests.push({ method, params });
    if (method === "config/read") {
      return {
        config: {
          model: "gpt-5.5",
          model_provider: "openai",
          model_reasoning_effort: "high",
        },
      };
    }
    if (method === "thread/settings/update") {
      return {};
    }
    if (method === "turn/start") {
      throw new CodexAppServerRpcError(-32602, "thread not found: thread-1");
    }
    if (method === "thread/resume") {
      throw new CodexAppServerRpcError(
        -32602,
        "No rollout found for thread id thread-1",
      );
    }
    throw new Error(`unexpected method: ${method}`);
  };

  try {
    await assert.rejects(
      client.sendMessage({
        threadId: "thread-1",
        input: [{ type: "text", text: "hello" }],
      }),
      /No rollout found for thread id thread-1/,
    );
    assert.deepEqual(
      requests.map((r) => r.method),
      ["config/read", "thread/settings/update", "turn/start", "thread/resume"],
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

interface AuthReloadTestClient {
  authFileFingerprint: string | null;
  process: unknown;
  readAuthFileFingerprint: () => string;
  reloadAuthIfChanged: () => Promise<void>;
  handleServerNotification: (method: string, params: unknown) => void;
  close: () => Promise<void>;
  request: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
}

function createAuthReloadTestClient(codexHome: string): {
  client: InstanceType<typeof __TEST_ONLY__.CodexAppServerClient>;
  internals: AuthReloadTestClient;
  requests: Array<{ method: string; params: Record<string, unknown> }>;
  closeCalls: () => number;
} {
  const client = new __TEST_ONLY__.CodexAppServerClient({
    env: { CODEX_HOME: codexHome },
  });
  const internals = client as unknown as AuthReloadTestClient;
  const requests: Array<{ method: string; params: Record<string, unknown> }> =
    [];
  let closeCount = 0;

  internals.process = { stub: true };
  internals.close = async () => {
    closeCount += 1;
    internals.process = null;
  };

  return {
    client,
    internals,
    requests,
    closeCalls: () => closeCount,
  };
}

test("app-server client restarts when auth.json changes and threads are idle", async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-deck-auth-"));
  try {
    writeFileSync(join(codexHome, "auth.json"), '{"token":"new"}');
    const { internals, requests, closeCalls } =
      createAuthReloadTestClient(codexHome);
    internals.authFileFingerprint = "stale-fingerprint";
    internals.request = async (method, params) => {
      requests.push({ method, params });
      if (method === "thread/loaded/list") {
        return { data: ["thread-1"] };
      }
      if (method === "thread/read") {
        return { thread: { id: "thread-1", status: { type: "idle" } } };
      }
      throw new Error(`unexpected method: ${method}`);
    };

    await internals.reloadAuthIfChanged();

    assert.equal(closeCalls(), 1);
    assert.deepEqual(
      requests.map((request) => request.method),
      ["thread/loaded/list", "thread/read"],
    );
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("app-server client defers auth restart while a thread is active", async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-deck-auth-"));
  try {
    writeFileSync(join(codexHome, "auth.json"), '{"token":"new"}');
    const { internals, closeCalls } = createAuthReloadTestClient(codexHome);
    internals.authFileFingerprint = "stale-fingerprint";
    let threadStatus = "active";
    internals.request = async (method) => {
      if (method === "thread/loaded/list") {
        return { data: ["thread-1"] };
      }
      if (method === "thread/read") {
        return { thread: { id: "thread-1", status: { type: threadStatus } } };
      }
      throw new Error(`unexpected method: ${method}`);
    };

    await internals.reloadAuthIfChanged();
    assert.equal(closeCalls(), 0);
    assert.equal(internals.authFileFingerprint, "stale-fingerprint");

    threadStatus = "idle";
    await internals.reloadAuthIfChanged();
    assert.equal(closeCalls(), 1);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("app-server client skips auth restart when auth.json is unchanged", async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-deck-auth-"));
  try {
    writeFileSync(join(codexHome, "auth.json"), '{"token":"same"}');
    const { internals, requests, closeCalls } =
      createAuthReloadTestClient(codexHome);
    internals.authFileFingerprint = internals.readAuthFileFingerprint();
    internals.request = async (method, params) => {
      requests.push({ method, params });
      throw new Error(`unexpected method: ${method}`);
    };

    await internals.reloadAuthIfChanged();

    assert.equal(closeCalls(), 0);
    assert.equal(requests.length, 0);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("app-server client re-baselines auth fingerprint on account/updated", async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-deck-auth-"));
  try {
    writeFileSync(join(codexHome, "auth.json"), '{"token":"rotated"}');
    const { internals, requests, closeCalls } =
      createAuthReloadTestClient(codexHome);
    internals.authFileFingerprint = "stale-fingerprint";
    internals.request = async (method, params) => {
      requests.push({ method, params });
      throw new Error(`unexpected method: ${method}`);
    };

    internals.handleServerNotification("account/updated", {});
    assert.equal(
      internals.authFileFingerprint,
      internals.readAuthFileFingerprint(),
    );

    await internals.reloadAuthIfChanged();

    assert.equal(closeCalls(), 0);
    assert.equal(requests.length, 0);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

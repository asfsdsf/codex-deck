import assert from "node:assert/strict";
import test from "node:test";
import {
  readConfigDiagnostics,
  redactDiagnostics,
  retainedWarnings,
} from "../../api/codex-diagnostics";
import { OperationalNotificationStore } from "../../api/operational-notifications";

const source = { type: "user", file: "/home/user/.codex/config.toml" };
test("configuration diagnostics resolve conversation scope, layers, overrides, and native provenance", async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const result = await readConfigDiagnostics(async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/read") return { thread: { cwd: "/repo" } };
    if (method === "config/read")
      return {
        config: {
          model: "example",
          api_key: "do-not-send",
          mcp_servers: {
            example: {
              env: { CUSTOM_AUTH: "do-not-send" },
              http_headers: { "X-Custom": "do-not-send" },
            },
          },
        },
        origins: { model: { name: source, version: "v1" } },
        layers: [
          { name: source, version: "v1", config: { model: "example" } },
          {
            name: { type: "project", dot_codex_folder: "/repo/.codex" },
            version: "v2",
            config: {},
            disabledReason: "Project is not trusted",
          },
        ],
      };
    return {
      requirements: { allowed_approval_policies: ["never"] },
      supportsIndependentSpeedModes: true,
      origins: {
        allowed_approval_policies: { type: "enterpriseManaged", id: "policy" },
      },
    };
  }, "thread");
  assert.equal(result.cwd, "/repo");
  assert.deepEqual(
    calls.find((call) => call.method === "config/read")?.params,
    { includeLayers: true, cwd: "/repo" },
  );
  assert.equal(result.config?.model, "example");
  assert.equal(JSON.stringify(result).includes("do-not-send"), false);
  assert.deepEqual(result.origins.model, { name: source, version: "v1" });
  assert.equal(result.layers?.[1].disabledReason, "Project is not trusted");
  assert.deepEqual(result.requirementSources, {
    allowed_approval_policies: { type: "enterpriseManaged", id: "policy" },
  });
  assert.deepEqual(result.errors, []);
});

test("diagnostics retain partial results and never infer requirement sources", async () => {
  const result = await readConfigDiagnostics(async (method) => {
    if (method === "thread/read") throw new Error("Thread unavailable");
    if (method === "config/read") throw new Error("Configuration unavailable");
    return { requirements: { model_provider: "openai" } };
  }, "thread");
  assert.equal(result.config, null);
  assert.equal(result.layers, null);
  assert.equal(result.requirementSources, null);
  assert.deepEqual(result.requirements, { model_provider: "openai" });
  assert.equal(result.errors.length, 2);
  const legacy = await readConfigDiagnostics(async (method) => {
    if (method === "config/read")
      return { config: { model: "legacy" }, origins: {} };
    throw new Error("Method not found");
  });
  assert.equal(legacy.config?.model, "legacy");
  assert.match(legacy.errors[0], /Requirements unavailable/);
});

test("diagnostic redaction covers nested credentials, environment, headers, free text and URL authentication", () => {
  const value = redactDiagnostics({
    apiKey: "secret-api",
    access_token: "secret-token",
    password: "secret-pass",
    client_secret: "secret-client",
    nested: [
      {
        env: { CUSTOM: "secret-env" },
        headers: { "X-Custom": "secret-header" },
        authorization: "secret-auth",
      },
    ],
    endpoint:
      "https://user:secret-url@example.test/path?custom=secret-query#secret-fragment",
    warning:
      "Authorization: Bearer secret-bearer api_key=secret-inline sk-1234567890abcdef",
    model: "example",
  });
  assert.equal(JSON.stringify(value).includes("secret-"), false);
  assert.equal(JSON.stringify(value).includes("sk-123"), false);
  assert.match(JSON.stringify(value), /example.test/);
  assert.match(JSON.stringify(value), /redacted/);
});

test("retained warnings survive tool progress, preserve scope, redact payloads, and stay bounded", () => {
  const store = new OperationalNotificationStore();
  store.record("configWarning", {
    summary: "Host policy warning",
    api_key: "secret",
  });
  store.record("warning", {
    threadId: "thread",
    message: "Conversation warning",
  });
  store.record("warning", { threadId: "other", message: "Other warning" });
  for (let i = 0; i < 300; i++)
    store.record("item/mcpToolCall/progress", {
      threadId: "thread",
      itemId: `item-${i}`,
      message: "Working",
    });
  assert.equal(store.list("thread").length, 256);
  const warnings = retainedWarnings(store.listWarnings("thread"));
  assert.deepEqual(
    warnings.map((entry) => entry.summary),
    ["Host policy warning", "Conversation warning"],
  );
  assert.equal(warnings[0].details.api_key, "[redacted]");
  for (let i = 0; i < 300; i++)
    store.record("deprecationNotice", { summary: `Notice ${i}` });
  assert.equal(store.listWarnings("thread").length, 256);
  store.clear();
  assert.equal(store.listWarnings("thread").length, 0);
});

test("diagnostics routes read native data and warning changes fan out to every client", async () => {
  const { Hono } = await import("hono");
  const { __TEST_ONLY__ } = await import("../../api/codex-app-server");
  const { registerNativeWorkflowRoutes } =
    await import("../../api/server/native-workflow-routes");
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const internal = client as unknown as {
    request: (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>;
    handleServerNotification: (method: string, params: unknown) => void;
  };
  internal.request = async (method) => {
    if (method === "thread/read") return { thread: { cwd: "/repo" } };
    if (method === "config/read")
      return {
        config: { model: "example", api_key: "secret-value" },
        origins: {},
        layers: [],
      };
    return { requirements: null };
  };
  const first: unknown[] = [],
    second: unknown[] = [];
  client.subscribeAppServerEvents((event) => first.push(event));
  client.subscribeAppServerEvents((event) => second.push(event));
  const app = new Hono();
  let subscriptions = 0;
  registerNativeWorkflowRoutes(app, {
    getClient: () => client,
    subscribe: () => {
      subscriptions++;
    },
  });
  try {
    internal.handleServerNotification("configWarning", {
      threadId: "thread",
      summary: "Config warning",
      details: { password: "secret-value" },
    });
    internal.handleServerNotification("warning", {
      threadId: "other",
      message: "Other warning",
    });
    assert.deepEqual(first, second);
    assert.equal(
      first.filter(
        (event: any) =>
          event.type === "native_state_changed" &&
          event.scope === "diagnostics",
      ).length,
      2,
    );
    const warnings = await app.request("/api/codex/warnings?threadId=thread");
    const warningSnapshot = await warnings.json();
    assert.equal(warningSnapshot.warnings.length, 1);
    assert.equal(
      JSON.stringify(warningSnapshot).includes("secret-value"),
      false,
    );
    const config = await app.request("/api/codex/debug-config?threadId=thread");
    const configSnapshot = await config.json();
    assert.equal(configSnapshot.cwd, "/repo");
    assert.equal(configSnapshot.config.api_key, "[redacted]");
    assert.equal(configSnapshot.requirementSources, null);
    assert.equal(subscriptions, 2);
  } finally {
    await client.close();
  }
  const unavailable = new Hono();
  registerNativeWorkflowRoutes(unavailable, { getClient: () => ({}) });
  assert.equal((await unavailable.request("/api/codex/warnings")).status, 501);
  assert.equal(
    (await unavailable.request("/api/codex/debug-config")).status,
    501,
  );
});

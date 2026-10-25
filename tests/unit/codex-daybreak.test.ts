import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { __TEST_ONLY__ } from "../../api/codex-app-server";
import { readDaybreak, selectCyberProgram } from "../../api/codex-daybreak";
import { registerNativeWorkflowRoutes } from "../../api/server/native-workflow-routes";

function discovery(
  options: {
    auth?: string;
    provider?: string;
    feature?: boolean;
    apiKeyFeature?: boolean;
    programs?: string[];
    enabled?: boolean;
    ephemeral?: boolean;
  } = {},
) {
  return async (method: string) => {
    if (method === "thread/read")
      return {
        thread: {
          cwd: "/repo",
          daybreakEnabled: options.enabled,
          ephemeral: options.ephemeral,
        },
      };
    if (method === "config/read")
      return {
        config: {
          model: "example",
          model_provider: options.provider || "openai",
        },
      };
    if (method === "account/read")
      return { account: { type: options.auth || "chatgpt" } };
    if (method === "experimentalFeature/list")
      return {
        data: [
          {
            name: "cli_daybreak",
            stage: "stable",
            enabled: options.feature !== false,
          },
          {
            name: "api_key_cyber_access_programs",
            stage: "stable",
            enabled: options.apiKeyFeature !== false,
          },
        ],
      };
    if (method === "model/list")
      return {
        data: [
          {
            model: "example",
            displayName: "Example",
            availableAccessPrograms: {
              cyber: options.programs ?? [
                "standard",
                "daybreakRed",
                "daybreakBlue",
                "future",
              ],
            },
          },
        ],
      };
    throw new Error(`Unexpected ${method}`);
  };
}

test("Daybreak requires discovered provider, sign-in, feature, and model eligibility", async () => {
  const state = await readDaybreak(discovery(), "thread");
  assert.equal(state.eligible, true);
  assert.equal(selectCyberProgram(state, true), "daybreakBlue");
  assert.equal(selectCyberProgram(state, false), "standard");
  assert.equal(
    selectCyberProgram(
      await readDaybreak(discovery({ programs: ["daybreakRed"] }), "thread"),
      true,
    ),
    "daybreakRed",
  );
  for (const options of [
    { provider: "other" },
    { auth: "amazonBedrock" },
    { feature: false },
    { auth: "apiKey", apiKeyFeature: false },
    { ephemeral: true },
  ]) {
    const unavailable = await readDaybreak(discovery(options), "thread");
    assert.equal(unavailable.eligible, false);
    assert.throws(() => selectCyberProgram(unavailable, true));
    assert.equal(selectCyberProgram(unavailable, false), null);
  }
  assert.equal(
    (await readDaybreak(discovery({ auth: "apiKey" }), "thread")).eligible,
    true,
  );
  const missing = await readDaybreak(discovery({ programs: [] }), "thread");
  assert.throws(
    () => selectCyberProgram(missing, true),
    /could not be confirmed/,
  );
  assert.equal(selectCyberProgram(missing, false), null);
  assert.throws(
    () => selectCyberProgram(state, true, "unsupported"),
    /could not be confirmed/,
  );
  const failure = await readDaybreak(async (method) => {
    if (method === "model/list") throw new Error("offline");
    return discovery()(method);
  }, "thread");
  assert.equal(failure.eligible, false);
  assert.match(failure.reason!, /offline/);
});

test("Daybreak uses native preferences, broadcasts changes, and applies the actual turn model", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  let enabled: boolean | undefined;
  let available = true;
  const turns: Record<string, unknown>[] = [];
  const events: unknown[] = [],
    second: unknown[] = [];
  const internal = client as unknown as {
    request: (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>;
    ensureConnected: () => Promise<void>;
    ensureInitialized: () => Promise<void>;
  };
  internal.ensureConnected = async () => {};
  internal.ensureInitialized = async () => {};
  internal.request = async (method, params) => {
    if (method === "thread/metadata/update") {
      enabled = params.daybreakEnabled as boolean;
      return {};
    }
    if (method === "thread/settings/update") return {};
    if (method === "turn/start") {
      turns.push(params);
      return { turn: { id: "turn" } };
    }
    return discovery({ enabled, feature: available })(method);
  };
  client.subscribeAppServerEvents((event) => events.push(event));
  client.subscribeAppServerEvents((event) => second.push(event));
  try {
    await client.setDaybreak("thread", true);
    assert.equal(enabled, true);
    assert.deepEqual(second, events);
    assert.ok(
      events.some(
        (event: any) =>
          event.type === "native_state_changed" && event.scope === "daybreak",
      ),
    );
    await client.sendMessage({ threadId: "thread", text: "hello" });
    assert.equal(turns[0].cyberAccessProgram, "daybreakBlue");
    await assert.rejects(
      client.sendMessage({
        threadId: "thread",
        text: "hello",
        collaborationMode: {
          mode: "default",
          settings: { model: "unsupported" },
        },
      }),
      /could not be confirmed/,
    );
    assert.equal(turns.length, 1);
    available = false;
    await assert.rejects(
      client.sendMessage({ threadId: "thread", text: "hello" }),
      /requires/,
    );
    await client.setDaybreak("thread", false);
    assert.equal(enabled, false);
    available = true;
    await client.sendMessage({ threadId: "thread", text: "hello" });
    assert.equal(turns[1].cyberAccessProgram, "standard");
  } finally {
    await client.close();
  }
});

test("Daybreak routes reject invalid input and preserve explicit off", async () => {
  const app = new Hono();
  let saved: unknown;
  registerNativeWorkflowRoutes(app, {
    getClient: () => ({
      setDaybreak: async (id, enabled, model) => {
        saved = { id, enabled, model };
        return {} as any;
      },
    }),
  });
  for (const body of [{ enabled: "yes" }, { enabled: true, model: 1 }]) {
    assert.equal(
      (
        await app.request("/api/codex/threads/thread/daybreak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
      400,
    );
  }
  assert.equal(
    (
      await app.request("/api/codex/threads/thread/daybreak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false, model: "example" }),
      })
    ).status,
    200,
  );
  assert.deepEqual(saved, { id: "thread", enabled: false, model: "example" });
});

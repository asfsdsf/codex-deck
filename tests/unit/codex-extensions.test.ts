import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { CodexExtensions, type ExtensionRpc } from "../../api/codex-extensions";
import { validatePresetInput } from "../../api/codex-presets";
import { registerExtensionRoutes } from "../../api/server/extension-routes";

function harness(
  handler: (
    method: string,
    params: Record<string, unknown> | undefined,
    options?: { threadId?: string | null; timeoutMs?: number },
  ) => unknown,
) {
  const calls: { method: string; params: unknown; options?: unknown }[] = [];
  const notified: string[] = [];
  const rpc: ExtensionRpc = async (method, params, options) => {
    calls.push({ method, params, options });
    return handler(method, params, options);
  };
  const extensions = new CodexExtensions(rpc, (scope) => notified.push(scope));
  const app = new Hono();
  registerExtensionRoutes(app, { getExtensions: () => extensions });
  return { calls, notified, extensions, app };
}

const userLayer = (presets: Record<string, unknown>, version = "v1") => ({
  name: { type: "user", file: "/home/u/.codex/config.toml", profile: null },
  version,
  config: { tui: { presets } },
  disabledReason: null,
});

test("preset validation mirrors upstream QuickDial rules", () => {
  assert.equal(validatePresetInput("  "), "Preset input cannot be empty.");
  assert.match(validatePresetInput(" !ls") ?? "", /not shell commands/);
  assert.match(validatePresetInput("é".repeat(4001)) ?? "", /8,000 UTF-8/);
  assert.equal(validatePresetInput("/review"), null);
});

test("presets read effective config, mark non-user layers read-only, and write quoted slots", async () => {
  let version = "v1";
  const { calls, notified, app } = harness((method, params) => {
    if (method === "config/read")
      return {
        config: {
          tui: {
            presets: {
              "1": { input: "Summarize the diff", label: "" },
              "2": { input: "/review", label: "Review" },
              x: { input: "ignored" },
            },
          },
        },
        layers: [
          {
            name: { type: "project", dotCodexFolder: "/repo/.codex" },
            version: "p1",
            config: { tui: { presets: { "2": { input: "/review" } } } },
            disabledReason: null,
          },
          userLayer({ "1": { input: "Summarize the diff" } }, version),
        ],
      };
    if (method === "config/value/write") {
      assert.equal((params as Record<string, unknown>).expectedVersion, "v1");
      version = "v2";
      return { status: "ok", version: "v2" };
    }
    throw new Error(`unexpected ${method}`);
  });

  const read = await app.request("/api/codex/presets?cwd=/repo");
  assert.equal(read.status, 200);
  const snapshot = await read.json();
  assert.equal(snapshot.version, "v1");
  assert.deepEqual(
    snapshot.presets.map((p: Record<string, unknown>) => [
      p.slot,
      p.label,
      p.readOnly,
      p.source,
    ]),
    [
      ["1", null, false, "user"],
      ["2", "Review", true, "project"],
    ],
  );
  assert.deepEqual(calls[0].params, { includeLayers: true, cwd: "/repo" });

  const readOnly = await app.request("/api/codex/presets/2", {
    method: "POST",
    body: JSON.stringify({ input: "/diff" }),
  });
  assert.equal(readOnly.status, 400);
  assert.match((await readOnly.json()).error, /outside your user config/);

  const invalid = await app.request("/api/codex/presets/3", {
    method: "POST",
    body: JSON.stringify({ input: "!rm -rf /" }),
  });
  assert.equal(invalid.status, 400);
  const badSlot = await app.request("/api/codex/presets/12", {
    method: "POST",
    body: JSON.stringify({ input: "hi" }),
  });
  assert.equal(badSlot.status, 400);

  const stale = await app.request("/api/codex/presets/3", {
    method: "POST",
    body: JSON.stringify({ input: "hi", expectedVersion: "old" }),
  });
  assert.equal(stale.status, 400);
  assert.match((await stale.json()).error, /another window/);
  assert.deepEqual(notified, []);

  const saved = await app.request("/api/codex/presets/3", {
    method: "POST",
    body: JSON.stringify({ input: "Explain this", label: " Explain " }),
  });
  assert.equal(saved.status, 200);
  const write = calls.find((call) => call.method === "config/value/write");
  assert.deepEqual(write?.params, {
    keyPath: 'tui.presets."3"',
    value: { input: "Explain this", label: "Explain" },
    mergeStrategy: "replace",
    expectedVersion: "v1",
  });
  assert.deepEqual(notified, ["presets"]);

  version = "v1";
  const removed = await app.request("/api/codex/presets/1", {
    method: "DELETE",
  });
  assert.equal(removed.status, 200);
  const deletion = calls.filter((call) => call.method === "config/value/write");
  assert.equal(
    (deletion.at(-1)?.params as Record<string, unknown>).value,
    null,
  );
  assert.deepEqual(notified, ["presets", "presets"]);
});

test("presets fall back to merging layers when the effective config omits tui", async () => {
  const { extensions } = harness(() => ({
    config: {},
    layers: [
      userLayer({ "4": { label: "Top" } }),
      {
        name: { type: "system", file: "/etc/codex/config.toml" },
        version: "s",
        config: { tui: { presets: { "4": { input: "base", label: "Low" } } } },
        disabledReason: null,
      },
    ],
  }));
  const snapshot = await extensions.readPresets();
  assert.deepEqual(snapshot.presets[0], {
    slot: "4",
    input: "base",
    label: "Top",
    source: "user",
    readOnly: false,
    invalidReason: null,
  });
});

test("Codex account login tracks device-code attempts, completion, and cancellation without echoing secrets", async () => {
  const { calls, notified, extensions, app } = harness((method, params) => {
    if (method === "account/read")
      return {
        account: { type: "chatgpt", email: "a@b.c", planType: "pro" },
        requiresOpenaiAuth: true,
      };
    if (method === "account/gatewayOAuth/read")
      return { providerId: "openai", providerName: "OpenAI", required: false };
    if (method === "config/read")
      return { config: { forced_login_method: null, model_provider: null } };
    if (method === "experimentalFeature/list")
      return {
        data: [
          { name: "bedrock_setup_wizard", stage: "stable", enabled: true },
        ],
        nextCursor: null,
      };
    if (method === "account/login/start") {
      const type = (params as Record<string, unknown>).type;
      if (type === "chatgptDeviceCode")
        return {
          type,
          loginId: "login-1",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "ABCD-1234",
        };
      if (type === "apiKey") return { type: "apiKey" };
      if (type === "chatgpt")
        return { type, loginId: "login-2", authUrl: "javascript:alert(1)" };
    }
    if (method === "account/login/cancel") return { status: "canceled" };
    if (method === "account/logout") return {};
    throw new Error(`unexpected ${method}`);
  });

  const snapshot = await (await app.request("/api/codex/account")).json();
  assert.equal(snapshot.account.email, "a@b.c");
  assert.deepEqual(snapshot.methods, {
    chatgpt: true,
    deviceCode: true,
    apiKey: true,
    bedrock: true,
  });

  const started = await app.request("/api/codex/account/login", {
    method: "POST",
    body: JSON.stringify({ type: "chatgptDeviceCode" }),
  });
  const pending = (await started.json()).pendingLogin;
  assert.equal(pending.userCode, "ABCD-1234");
  assert.equal(pending.loginId, "login-1");

  // Completion for another attempt does not clear this one.
  extensions.handleNotification("account/login/completed", {
    loginId: "other",
    success: true,
  });
  assert.ok((await extensions.account.read()).pendingLogin);
  assert.equal(
    extensions.handleNotification("account/login/completed", {
      loginId: "login-1",
      success: false,
      error: "denied",
    }),
    false,
    "account notifications stay visible to the auth fingerprint handler",
  );
  const completed = await extensions.account.read();
  assert.equal(completed.pendingLogin, null);
  assert.deepEqual(
    [completed.lastLogin?.success, completed.lastLogin?.error],
    [false, "denied"],
  );

  const keyLogin = await app.request("/api/codex/account/login", {
    method: "POST",
    body: JSON.stringify({ type: "apiKey", apiKey: "sk-secret" }),
  });
  assert.equal(keyLogin.status, 200);
  assert.doesNotMatch(await keyLogin.text(), /sk-secret/);
  const missingKey = await app.request("/api/codex/account/login", {
    method: "POST",
    body: JSON.stringify({ type: "apiKey", apiKey: " " }),
  });
  assert.equal(missingKey.status, 400);
  const unsafe = await app.request("/api/codex/account/login", {
    method: "POST",
    body: JSON.stringify({ type: "chatgpt" }),
  });
  assert.equal(unsafe.status, 500);
  assert.match((await unsafe.json()).error, /Invalid Codex sign-in URL/);

  // Starting a new device-code login, then logging out, cancels it first.
  await app.request("/api/codex/account/login", {
    method: "POST",
    body: JSON.stringify({ type: "chatgptDeviceCode" }),
  });
  const logout = await app.request("/api/codex/account/logout", {
    method: "POST",
    body: "{}",
  });
  assert.equal(logout.status, 200);
  const order = calls
    .map((call) => call.method)
    .filter((method) => method.startsWith("account/log"));
  assert.deepEqual(order.slice(-2), ["account/login/cancel", "account/logout"]);
  assert.ok(notified.includes("account"));
});

test("gateway OAuth sign-in runs in the background and surfaces the authorization link", async () => {
  let resolveLogin: () => void = () => {};
  const { calls, extensions } = harness((method) => {
    if (method === "account/gatewayOAuth/login")
      return new Promise<void>((resolve) => {
        resolveLogin = resolve;
      }).then(() => ({}));
    if (method === "account/gatewayOAuth/read")
      return {
        providerId: "gw",
        providerName: "Gateway",
        required: true,
        status: "notReady",
        error: null,
      };
    if (method === "account/read") return { account: null };
    return { config: {}, data: [], nextCursor: null };
  });
  const started = await extensions.account.startGatewayLogin();
  assert.equal(started.gateway?.loginInFlight, true);
  const login = calls.find((c) => c.method === "account/gatewayOAuth/login");
  assert.ok(
    (login?.options as { timeoutMs?: number } | undefined)?.timeoutMs,
    "gateway login uses an extended timeout",
  );
  await assert.rejects(extensions.account.startGatewayLogin(), /in progress/);
  assert.equal(
    extensions.handleNotification("account/gatewayOAuth/changed", {
      providerId: "gw",
      status: "started",
      authUrl: "https://gw.example/authorize",
    }),
    true,
  );
  assert.equal(
    (await extensions.account.read()).gateway?.authUrl,
    "https://gw.example/authorize",
  );
  resolveLogin();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const done = await extensions.account.read();
  assert.equal(done.gateway?.loginInFlight, false);
  assert.equal(done.gateway?.status, "succeeded");
  assert.equal(done.gateway?.authUrl, null);
});

const detectedItems = [
  {
    itemType: "CONFIG",
    description: "Migrate /h/.claude/settings.json into /h/.codex/config.toml",
    cwd: null,
    details: null,
  },
  {
    itemType: "AGENTS_MD",
    description: "Migrate /repo/CLAUDE.md to /repo/AGENTS.md",
    cwd: "/repo",
    details: null,
  },
];

test("/import only forwards detected items, guards concurrent runs, and tracks progress for every client", async () => {
  const { calls, notified, extensions, app } = harness((method, params) => {
    if (method === "externalAgentConfig/detect")
      return (params as Record<string, unknown>).migrationSource ===
        "claude-code"
        ? { items: detectedItems, connectors: [] }
        : { items: [], connectors: [] };
    if (method === "externalAgentConfig/import") {
      // Progress can arrive before the import response.
      extensions.handleNotification("externalAgentConfig/import/progress", {
        importId: "imp-1",
        itemTypeResults: [
          {
            itemType: "CONFIG",
            successes: [{ itemType: "CONFIG", cwd: null, target: "x" }],
            failures: [],
          },
        ],
      });
      return { importId: "imp-1" };
    }
    throw new Error(`unexpected ${method}`);
  });

  const detection = await (
    await app.request("/api/codex/import/detect?cwd=/repo")
  ).json();
  assert.deepEqual(
    detection.sources.map((source: { id: string }) => source.id),
    ["claude-code"],
  );
  assert.deepEqual(calls[0].params, {
    includeHome: true,
    cwds: ["/repo"],
    migrationSource: "claude-code",
  });

  const forged = await app.request("/api/codex/import", {
    method: "POST",
    body: JSON.stringify({
      source: "claude-code",
      cwd: "/repo",
      items: [{ ...detectedItems[0], description: "Migrate /etc/passwd" }],
    }),
  });
  assert.equal(forged.status, 400);
  assert.match((await forged.json()).error, /no longer available/);

  const started = await app.request("/api/codex/import", {
    method: "POST",
    body: JSON.stringify({
      source: "claude-code",
      cwd: "/repo",
      items: [detectedItems[1]],
    }),
  });
  const run = (await started.json()).run;
  assert.equal(run.status, "running");
  assert.equal(run.importId, "imp-1");
  assert.equal(run.remainingItemCount, 1);
  assert.equal(run.results[0].successes.length, 1);
  const importCall = calls.find(
    (call) => call.method === "externalAgentConfig/import",
  );
  assert.deepEqual(importCall?.params, {
    migrationItems: [detectedItems[1]],
    source: "codex-deck",
    providerId: "claude-code",
    migrationSource: "claude-code",
  });

  const second = await app.request("/api/codex/import", {
    method: "POST",
    body: JSON.stringify({
      source: "claude-code",
      items: [detectedItems[0]],
    }),
  });
  assert.equal(second.status, 400);
  assert.match((await second.json()).error, /still running/);

  // Completions for other imports (e.g. Codex CLI on a shared daemon) are ignored.
  extensions.handleNotification("externalAgentConfig/import/completed", {
    importId: "other",
    itemTypeResults: [],
  });
  assert.equal(extensions.imports.snapshot().run?.status, "running");
  assert.equal(
    extensions.handleNotification("externalAgentConfig/import/completed", {
      importId: "imp-1",
      itemTypeResults: [
        {
          itemType: "AGENTS_MD",
          successes: [],
          failures: [
            {
              itemType: "AGENTS_MD",
              failureStage: "write",
              message: "exists",
            },
          ],
        },
      ],
    }),
    true,
  );
  const finished = (await (await app.request("/api/codex/import")).json()).run;
  assert.equal(finished.status, "completed");
  assert.equal(finished.results[0].failures[0].message, "exists");
  assert.ok(notified.filter((scope) => scope === "import").length >= 3);

  const dismissed = await app.request("/api/codex/import/dismiss", {
    method: "POST",
    body: JSON.stringify({ id: finished.id }),
  });
  assert.equal((await dismissed.json()).run, null);
});

test("/import display helpers follow upstream grouping and wording", async () => {
  const model = await import("../../web/import-migration-model");
  const items = [
    ...detectedItems,
    {
      itemType: "SESSIONS",
      description: "Migrate recent sessions",
      cwd: null,
      details: {
        sessions: [
          { path: "/a", cwd: "/a", title: "First" },
          { path: "/b", cwd: "/b", title: null },
        ],
      },
    },
  ];
  assert.deepEqual(
    model.importGroups(items).map((group) => [group.label, group.indices]),
    [
      ["Tools & setup", [0]],
      ["Current project", [1]],
      ["Chat sessions (2)", [2]],
    ],
  );
  assert.equal(
    model.importItemDescription(detectedItems[1]),
    "Import CLAUDE.md to AGENTS.md",
  );
  assert.equal(model.importItemDetail(items[2]), "2 chat sessions: First");
  assert.equal(
    model.remainingItemsHandoff(2),
    "2 additional items remain. After it finishes, run /import again to review them.",
  );
});

function pluginSummary(overrides: Record<string, unknown>) {
  return {
    id: "demo@local",
    name: "demo",
    remotePluginId: null,
    source: { type: "local", path: "/m/plugins/demo" },
    installed: false,
    enabled: false,
    installPolicy: "AVAILABLE",
    authPolicy: "ON_INSTALL",
    availability: "AVAILABLE",
    interface: { displayName: "Demo", shortDescription: "Demo plugin" },
    keywords: ["demo"],
    ...overrides,
  };
}

test("/plugins derives install targets server-side, hides CLI-only marketplaces, and guards admin policies", async () => {
  const { calls, notified, app } = harness((method, params) => {
    if (method === "experimentalFeature/list")
      return {
        data: [{ name: "plugins", stage: "stable", enabled: true }],
        nextCursor: null,
      };
    if (method === "config/read")
      return {
        config: {},
        layers: [
          {
            name: { type: "user", file: "/u/config.toml", profile: null },
            config: { marketplaces: { local: { source_type: "git" } } },
          },
        ],
      };
    if (method === "plugin/list")
      return {
        marketplaces: [
          { name: "openai-bundled", path: "/b", plugins: [pluginSummary({})] },
          {
            name: "local",
            path: "/m/marketplace.json",
            interface: { displayName: "Local" },
            plugins: [
              pluginSummary({}),
              pluginSummary({
                id: "admin@local",
                name: "admin",
                installed: true,
                enabled: true,
                installPolicy: "INSTALLED_BY_DEFAULT",
              }),
            ],
          },
          {
            name: "remote-catalog",
            path: null,
            plugins: [
              pluginSummary({
                id: "remote@catalog",
                name: "remote",
                remotePluginId: "plugins~abc",
                source: { type: "remote" },
                installed: true,
                enabled: true,
              }),
            ],
          },
        ],
        marketplaceLoadErrors: [],
        featuredPluginIds: ["demo@local"],
      };
    if (method === "plugin/install")
      return {
        authPolicy: "ON_INSTALL",
        appsNeedingAuth: [
          {
            id: "cal",
            name: "Calendar",
            installUrl: "https://chatgpt.com/apps/cal",
          },
          { id: "bad", name: "Bad", installUrl: "javascript:alert(1)" },
        ],
      };
    if (method === "plugin/uninstall") return {};
    if (method === "config/value/write") return { status: "ok" };
    if (method === "marketplace/remove")
      return { marketplaceName: "local", installedRoot: null };
    throw new Error(`unexpected ${method}`);
  });

  const listed = await (
    await app.request("/api/codex/plugins?cwd=/repo")
  ).json();
  assert.deepEqual(
    listed.marketplaces.map((m: { name: string }) => m.name),
    ["local", "remote-catalog"],
  );
  const [demo, admin] = listed.marketplaces[0].plugins;
  assert.equal(demo.featured, true);
  assert.equal(demo.canInstall, true);
  assert.equal(admin.statusLabel, "Installed by admin");
  assert.equal(admin.canUninstall, false);
  assert.equal(admin.canToggle, false);
  assert.equal(listed.marketplaces[0].removable, true);
  assert.equal(listed.marketplaces[0].upgradable, true);
  assert.equal(listed.marketplaces[1].removable, false);

  const installed = await app.request("/api/codex/plugins/install", {
    method: "POST",
    body: JSON.stringify({
      pluginId: "demo@local",
      marketplaceName: "local",
      cwd: "/repo",
      // Client-supplied paths are ignored.
      marketplacePath: "/evil",
    }),
  });
  const result = await installed.json();
  assert.deepEqual(
    result.appsNeedingAuth.map(
      (a: { installUrl: string | null }) => a.installUrl,
    ),
    ["https://chatgpt.com/apps/cal", null],
  );
  const install = calls.find((call) => call.method === "plugin/install");
  assert.equal(
    (install?.params as Record<string, unknown>).marketplacePath,
    "/m/marketplace.json",
  );
  assert.equal((install?.params as Record<string, unknown>).pluginName, "demo");
  assert.ok((install?.options as { timeoutMs?: number }).timeoutMs);
  assert.ok(notified.includes("plugins") && notified.includes("apps"));

  const blocked = await app.request("/api/codex/plugins/uninstall", {
    method: "POST",
    body: JSON.stringify({ pluginId: "admin@local", marketplaceName: "local" }),
  });
  assert.equal(blocked.status, 400);
  assert.match((await blocked.json()).error, /workspace admin/);

  await app.request("/api/codex/plugins/uninstall", {
    method: "POST",
    body: JSON.stringify({
      pluginId: "remote@catalog",
      marketplaceName: "remote-catalog",
    }),
  });
  assert.deepEqual(
    calls.find((call) => call.method === "plugin/uninstall")?.params,
    { pluginId: "plugins~abc" },
  );

  await app.request("/api/codex/plugins/enabled", {
    method: "POST",
    body: JSON.stringify({
      pluginId: "remote@catalog",
      marketplaceName: "remote-catalog",
      enabled: false,
    }),
  });
  assert.deepEqual(
    calls.find((call) => call.method === "config/value/write")?.params,
    {
      keyPath: 'plugins."remote@catalog"',
      value: { enabled: false },
      mergeStrategy: "upsert",
    },
  );

  const missing = await app.request("/api/codex/plugins/install", {
    method: "POST",
    body: JSON.stringify({ pluginId: "nope", marketplaceName: "local" }),
  });
  assert.equal(missing.status, 400);
  const notConfigured = await app.request("/api/codex/marketplaces/remove", {
    method: "POST",
    body: JSON.stringify({ marketplaceName: "remote-catalog" }),
  });
  assert.equal(notConfigured.status, 400);
  const removed = await app.request("/api/codex/marketplaces/remove", {
    method: "POST",
    body: JSON.stringify({ marketplaceName: "local" }),
  });
  assert.equal(removed.status, 200);
});

test("/apps requires ChatGPT, paginates app/list, and writes upstream enablement keys", async () => {
  let account: unknown = null;
  const { calls, extensions, app } = harness((method, params) => {
    if (method === "experimentalFeature/list")
      return { data: [{ name: "apps", stage: "stable", enabled: true }] };
    if (method === "account/read") return { account };
    if (method === "app/list")
      return (params as Record<string, unknown>).cursor
        ? {
            data: [
              {
                id: "drive",
                name: "Drive",
                isAccessible: true,
                isEnabled: false,
                installUrl: "https://chatgpt.com/apps/drive",
              },
            ],
            nextCursor: null,
          }
        : {
            data: [
              {
                id: "cal",
                name: "Calendar",
                isAccessible: false,
                isEnabled: true,
                installUrl: "ftp://bad",
              },
            ],
            nextCursor: "p2",
          };
    if (method === "config/batchWrite") return { status: "ok" };
    throw new Error(`unexpected ${method}`);
  });
  const signedOut = await (await app.request("/api/codex/apps")).json();
  assert.equal(signedOut.enabled, false);
  assert.match(signedOut.disabledReason, /ChatGPT/);

  account = { type: "chatgpt", email: null, planType: "plus" };
  const listed = await (
    await app.request("/api/codex/apps?threadId=t1&refresh=1")
  ).json();
  assert.deepEqual(
    listed.apps.map((a: Record<string, unknown>) => [
      a.id,
      a.statusLabel,
      a.installUrl,
    ]),
    [
      ["cal", "Can be installed", null],
      ["drive", "Installed · Disabled", "https://chatgpt.com/apps/drive"],
    ],
  );
  const list = calls.find((call) => call.method === "app/list");
  assert.deepEqual(list?.options, { threadId: "t1" });
  assert.equal((list?.params as Record<string, unknown>).forceRefetch, true);

  await app.request("/api/codex/apps/enabled", {
    method: "POST",
    body: JSON.stringify({ appId: "drive", enabled: false }),
  });
  assert.deepEqual(
    (
      calls.find((call) => call.method === "config/batchWrite")?.params as {
        edits: unknown[];
      }
    ).edits,
    [
      {
        keyPath: 'apps."drive".enabled',
        value: false,
        mergeStrategy: "replace",
      },
      {
        keyPath: 'apps."drive".disabled_reason',
        value: "user",
        mergeStrategy: "replace",
      },
    ],
  );
  assert.equal(extensions.handleNotification("app/list/updated", {}), true);
});

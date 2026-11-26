import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Hono } from "hono";
import { DeckPluginStore } from "../../api/deck-plugin-store";
import { DeckPluginServices } from "../../api/deck-plugin-services";
import { DeckBuiltinRuntime } from "../../api/deck-builtin-runtime";
import { DeckPluginWorkers } from "../../api/deck-plugin-workers";
import {
  parseDeckPluginManifest,
  type DeckPluginManifest,
} from "../../api/deck-plugin-manifest";
import { builtinServerModules } from "../../builtin-plugins/server";
import { DECK_BUILTIN_PLUGINS } from "../../builtin-plugins/catalog";
import { registerDeckPluginRoutes } from "../../api/server/deck-plugin-routes";
import { pluginCommands, pluginViews } from "../../web/plugins/contributions";

async function temporary(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "deck-composition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const consumer = (uses = ["example.provider"]) => ({
  id: "example.consumer",
  capabilities: ["services.call"] as DeckPluginManifest["capabilities"],
  services: { uses },
});
function upload(files: Record<string, string>) {
  return Object.entries(files).map(([path, text]) => ({
    path,
    contentBase64: Buffer.from(text).toString("base64"),
  }));
}
async function eventually<T>(
  work: () => Promise<T>,
  accepts: (result: T) => boolean = () => true,
): Promise<T> {
  const deadline = Date.now() + 6000;
  let error: unknown;
  do {
    try {
      const result = await work();
      if (accepts(result)) return result;
    } catch (value) {
      error = value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw error ?? new Error("Condition did not become true.");
}

test("built-ins ship enabled, remain marked built-in, and persist per-home optional enablement", async (t) => {
  const first = await temporary(t),
    second = await temporary(t);
  const store = new DeckPluginStore(first, () => {});
  const snapshot = await store.list();
  assert.equal(snapshot.plugins.length, DECK_BUILTIN_PLUGINS.length);
  assert.ok(
    snapshot.plugins.every(
      (p) => p.source === "builtin" && p.installed && p.enabled,
    ),
  );
  assert.equal(
    snapshot.plugins.find((p) => p.id === "codex-deck.manager")?.canDisable,
    false,
  );
  await assert.rejects(
    store.setEnabled("codex-deck.manager", false),
    /required/,
  );
  await assert.rejects(
    store.uninstall("codex-deck.recap"),
    /cannot be uninstalled/,
  );
  await store.setEnabled("codex-deck.recap", false);
  assert.equal(
    (await new DeckPluginStore(first, () => {}).list()).plugins.find(
      (p) => p.id === "codex-deck.recap",
    )?.enabled,
    false,
  );
  assert.equal(
    (await new DeckPluginStore(second, () => {}).list()).plugins.find(
      (p) => p.id === "codex-deck.recap",
    )?.enabled,
    true,
  );
  await store.setEnabled("codex-deck.recap", true);
  assert.equal((await store.getRuntime("codex-deck.recap")).source, "builtin");
});

test("services enforce declared access and namespaces, cancel on unload, and never cross homes", async () => {
  const services = new DeckPluginServices();
  const dispose = services.register(
    "example.provider",
    "example.provider",
    (method, params, call) => ({ method, params, caller: call.caller }),
  );
  assert.deepEqual(
    await services.call(consumer(), "example.provider", "read", { x: 1 }),
    { method: "read", params: { x: 1 }, caller: "example.consumer" },
  );
  await assert.rejects(
    services.call(
      { ...consumer(), capabilities: [] },
      "example.provider",
      "read",
      {},
    ),
    /not granted/,
  );
  await assert.rejects(
    services.call(consumer([]), "example.provider", "read", {}),
    /not declared/,
  );
  assert.throws(
    () => services.register("intruder", "example.provider", () => {}),
    /namespace/,
  );
  assert.throws(
    () => services.register("example.provider", "example.provider", () => {}),
    /already registered/,
  );
  await assert.rejects(
    new DeckPluginServices().call(consumer(), "example.provider", "read", {}),
    /unavailable/,
  );
  dispose();
  services.register(
    "example.provider",
    "example.provider",
    () => new Promise(() => {}),
  );
  const pending = services.call(consumer(), "example.provider", "wait", {});
  services.unload("example.provider");
  await assert.rejects(pending, /unloaded/);
  assert.deepEqual(services.list(), []);
});

test("real built-in routes and service providers disappear and return with enablement", async (t) => {
  const root = await temporary(t);
  const services = new DeckPluginServices();
  let reads = 0;
  const store = new DeckPluginStore(root, () => {});
  const runtime = new DeckBuiltinRuntime(
    store,
    services,
    builtinServerModules({
      getClient: () =>
        ({
          listRetainedWarnings: () => {
            reads++;
            return [];
          },
        }) as never,
    }),
  );
  t.after(() => runtime.close());
  store.beforePackageChange = (id) => runtime.unload(id);
  const get = () =>
    runtime.fetch(new Request("http://deck/api/codex/warnings"));
  assert.equal((await get())?.status, 200);
  const manifest = consumer(["codex-deck.diagnostics"]);
  assert.deepEqual(
    await services.call(manifest, "codex-deck.diagnostics", "request", {
      path: "/api/codex/warnings",
    }),
    { status: 200, body: { warnings: [] } },
  );
  await assert.rejects(
    services.call(manifest, "codex-deck.diagnostics", "request", {
      path: "/api/codex/warnings?codexHome=other",
    }),
    /scoped/,
  );
  await assert.rejects(
    services.call(manifest, "codex-deck.diagnostics", "request", {
      path: "https://example.com",
    }),
    /API path/,
  );
  await store.setEnabled("codex-deck.diagnostics", false);
  assert.equal(await get(), null);
  assert.equal(reads, 2);
  await assert.rejects(
    services.call(manifest, "codex-deck.diagnostics", "request", {
      path: "/api/codex/warnings",
    }),
    /unavailable/,
  );
  await store.setEnabled("codex-deck.diagnostics", true);
  assert.equal((await get())?.status, 200);
  assert.equal(reads, 3);
});

test("native plugin effects and dependent services are disposed and restarted", async (t) => {
  const root = await temporary(t);
  const services = new DeckPluginServices();
  let started = 0,
    disposed = 0,
    events = 0;
  const definitions = [
    {
      manifest: {
        schemaVersion: 1,
        id: "example.native",
        name: "Native",
        version: "1.0.0",
        description: "Example",
        capabilities: [],
        entrypoints: {},
        services: { uses: ["example.provider"] },
        requires: ["example.provider"],
      } as DeckPluginManifest,
      canDisable: true,
      defaultEnabled: true,
    },
  ];
  const store = new DeckPluginStore(root, () => {}, definitions);
  const runtime = new DeckBuiltinRuntime(store, services, [
    {
      id: "example.native",
      apply(ctx) {
        started++;
        ctx.effect(() => {
          disposed++;
        });
        ctx.onEvent(() => {
          events++;
        });
        ctx.routes.get("/api/example", (c) => c.json({ started }));
      },
    },
  ]);
  t.after(() => runtime.close());
  await runtime.reconcile();
  assert.equal(started, 0);
  const release = services.register(
    "example.provider",
    "example.provider",
    () => null,
  );
  await runtime.reconcile();
  runtime.event({});
  assert.equal(events, 1);
  assert.equal(started, 1);
  release();
  await runtime.reconcile();
  runtime.event({});
  assert.equal(disposed, 1);
  assert.equal(events, 1);
  services.register("example.provider", "example.provider", () => null);
  await runtime.reconcile();
  assert.equal(started, 2);
  await runtime.close();
  assert.equal(disposed, 2);
});

test("manifest validates reusable commands, views, service dependencies and package ownership", () => {
  const manifest = {
    schemaVersion: 1,
    id: "example.consumer",
    name: "Consumer",
    version: "1.0.0",
    description: "Example",
    capabilities: ["services.call"],
    entrypoints: {},
    services: { uses: ["example.provider"] },
    requires: ["example.provider"],
    contributions: {
      views: [
        {
          id: "inspect",
          title: "Inspect",
          slot: "session.footer",
          entrypoint: "view.html",
        },
      ],
      commands: [
        {
          id: "inspect",
          title: "Inspect",
          description: "Inspect current session",
          action: { view: "inspect" },
        },
      ],
    },
  };
  const parsed = parseDeckPluginManifest(manifest);
  assert.equal(parsed.contributions?.views?.[0].slot, "session.footer");
  for (const invalid of [
    { ...manifest, requires: ["undeclared"] },
    { ...manifest, capabilities: [] },
    { ...manifest, services: { provides: ["another.plugin"] } },
    {
      ...manifest,
      contributions: {
        views: [
          {
            id: "inspect",
            title: "Inspect",
            slot: "session.footer",
            entrypoint: "../escape.html",
          },
        ],
      },
    },
    {
      ...manifest,
      contributions: {
        ...manifest.contributions,
        commands: [
          {
            ...manifest.contributions.commands[0],
            action: { view: "missing" },
          },
        ],
      },
    },
  ])
    assert.throws(() => parseDeckPluginManifest(invalid));
  const plugins = [
    {
      id: parsed.id,
      name: parsed.name,
      contributions: parsed.contributions!,
      sessions: {},
      statuses: {},
    },
  ];
  assert.equal(pluginCommands(plugins)[0].name, "/inspect");
  assert.equal(pluginViews(plugins, "session.footer")[0].plugin.id, parsed.id);
  assert.deepEqual(
    pluginCommands([{ ...plugins[0], workerError: "Waiting" }]),
    [],
  );
});

test("SDK workers share services and automatically suspend and restart consumers", async (t) => {
  const root = await temporary(t);
  const sdk = await readFile(
    new URL("../../plugin-sdk/worker.mjs", import.meta.url),
    "utf8",
  );
  const services = new DeckPluginServices();
  let manager: DeckPluginWorkers;
  const store = new DeckPluginStore(root, () => {
    void manager?.reconcile();
  }, []);
  const make = (id: string, source: string, serviceFields: object) =>
    upload({
      "plugin.json": JSON.stringify({
        schemaVersion: 1,
        id,
        name: id,
        description: "Service fixture",
        version: "1.0.0",
        entrypoints: { backend: "worker.mjs" },
        capabilities: [
          "backend.execute",
          "worker.request",
          "services.call",
          "services.provide",
        ],
        ...serviceFields,
      }),
      "sdk.mjs": sdk,
      "worker.mjs": `import { definePlugin } from './sdk.mjs';\ndefinePlugin((ctx) => { ctx.handle('pid', () => process.pid); ${source} });`,
    });
  await store.installPackage(
    make(
      "example.provider",
      `ctx.provide('example.provider', (method, params, call) => ({ method, params, caller: call.caller }));`,
      { services: { provides: ["example.provider"] } },
    ),
    undefined,
  );
  await store.installPackage(
    make(
      "example.consumer",
      `ctx.handle('inspect', (params) => ctx.services.call('example.provider', 'inspect', params));`,
      {
        services: { uses: ["example.provider"] },
        requires: ["example.provider"],
      },
    ),
    undefined,
  );
  manager = new DeckPluginWorkers(store, {
    services,
    changed: () => {},
    readSession: async () => {
      throw new Error("unused");
    },
    sendMessage: async () => {
      throw new Error("unused");
    },
  });
  t.after(() => manager.stop());
  await manager.start();
  const pid = await eventually(() =>
    manager.request("example.consumer", "pid", {}),
  );
  assert.deepEqual(
    await manager.request("example.consumer", "inspect", { threadId: "s" }),
    {
      method: "inspect",
      params: { threadId: "s" },
      caller: "example.consumer",
    },
  );
  await store.setEnabled("example.provider", false);
  await manager.reconcile();
  assert.match(
    (await manager.snapshot()).plugins.find((p) => p.id === "example.consumer")!
      .workerError!,
    /Waiting for services/,
  );
  await assert.rejects(
    manager.request("example.consumer", "inspect", {}),
    /unavailable/,
  );
  assert.equal(services.has("example.provider"), false);
  await store.setEnabled("example.provider", true);
  await manager.reconcile();
  const nextPid = await eventually(() =>
    manager.request("example.consumer", "pid", {}),
  );
  assert.notEqual(nextPid, pid);
  assert.deepEqual(await manager.request("example.consumer", "inspect", {}), {
    method: "inspect",
    params: {},
    caller: "example.consumer",
  });
});

test("browser service jobs use the caller's capabilities and stay scoped to that plugin", async (t) => {
  const root = await temporary(t);
  const services = new DeckPluginServices();
  services.register(
    "example.provider",
    "example.provider",
    (_method, params, call) => ({ params, caller: call.caller }),
  );
  const store = new DeckPluginStore(root, () => {}, []);
  for (const id of ["example.browser", "example.other"])
    await store.installPackage(
      upload({
        "plugin.json": JSON.stringify({
          schemaVersion: 1,
          id,
          name: id,
          description: "Browser fixture",
          version: "1.0.0",
          entrypoints: { panel: "index.html" },
          capabilities: ["services.call"],
          services: { uses: ["example.provider"] },
        }),
        "index.html": "<!doctype html><p>Example</p>",
      }),
      undefined,
    );
  const workers = new DeckPluginWorkers(store, {
    services,
    changed: () => {},
    readSession: async () => {
      throw new Error("unused");
    },
    sendMessage: async () => {
      throw new Error("unused");
    },
  });
  t.after(() => workers.stop());
  const app = new Hono();
  registerDeckPluginRoutes(app, store, workers);
  const response = await app.request(
    "/api/deck/plugins/example.browser/services",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service: "example.provider",
        method: "read",
        params: { threadId: "s" },
      }),
    },
  );
  assert.equal(response.status, 200);
  const { requestId } = await response.json();
  const result = await eventually(
    () => workers.readRequest("example.browser", requestId),
    (job) => job.done,
  );
  assert.deepEqual(result.result, {
    params: { threadId: "s" },
    caller: "example.browser",
  });
  await assert.rejects(
    workers.readRequest("example.other", requestId),
    /not found/,
  );
  await store.setEnabled("example.browser", false);
  assert.equal(
    (
      await app.request("/api/deck/plugins/example.browser/services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "example.provider", method: "read" }),
      })
    ).status,
    404,
  );
});

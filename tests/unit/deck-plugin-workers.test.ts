import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Hono } from "hono";
import {
  DeckPluginWorkers,
  type DeckPluginWorkerHost,
} from "../../api/deck-plugin-workers";
import { DeckPluginStore } from "../../api/deck-plugin-store";
import {
  parseDeckPluginManifest,
  type DeckPluginCapability,
  type DeckPluginSession,
} from "../../api/deck-plugin-manifest";
import { registerDeckPluginRoutes } from "../../api/server/deck-plugin-routes";
import { createServer } from "../../api/server";
import {
  __TEST_ONLY__,
  setCodexAppServerClientForTests,
  type CodexAppServerClientFacade,
} from "../../api/codex-app-server";

const workerSource = `
const pending = new Map(); let count = 0;
function rpc(method, params) { const requestId = String(++count); return new Promise((resolve, reject) => { pending.set(requestId, {resolve,reject}); process.send({ type:'request',requestId,method,params }); }); }
process.on('message', async (msg) => {
  if (msg.type === 'initialize') process.send({type:'ready'});
  if (msg.type === 'response') { const p=pending.get(msg.requestId); if(p) { pending.delete(msg.requestId); if(msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.result); } }
  if (msg.type !== 'request') return;
  try {
    let result;
    if(msg.method === 'pid') result = process.pid;
    else if(msg.method === 'host.shutdown') result = null;
    else result = await rpc(msg.params.method, msg.params.params);
    process.send({ type:'response',requestId:msg.requestId,result });
  } catch(error) { process.send({type:'response',requestId:msg.requestId,error:error.message}); }
});
process.on('disconnect',()=>process.exit(0));
`;
const permissions: DeckPluginCapability[] = [
  "backend.execute",
  "worker.request",
  "sessions.read",
  "sessions.events",
  "sessions.submit",
  "data.read",
  "data.write",
  "secrets.read",
  "secrets.write",
  "status.write",
];
function packageFiles(version = "1.0.0", capabilities = permissions) {
  return Object.entries({
    "plugin.json": JSON.stringify({
      schemaVersion: 1,
      id: "example.worker",
      name: "Worker",
      version,
      description: "Worker fixture",
      capabilities,
      entrypoints: { backend: "worker.mjs", settings: "settings.html" },
      contributions: {
        settings: { title: "Worker settings" },
        sessionToggle: { label: "Automate" },
        sessionTip: true,
      },
    }),
    "worker.mjs": workerSource,
    "settings.html": "<!doctype html><title>Worker settings</title>",
  }).map(([path, content]) => ({
    path,
    contentBase64: Buffer.from(content).toString("base64"),
  }));
}
function session(): DeckPluginSession {
  return {
    threadId: "s",
    interactive: true,
    activeTurnId: null,
    pendingInteraction: false,
    queuedMessages: false,
    revision: "",
    turns: [
      {
        id: "failed",
        status: "failed",
        userText: "work",
        error: { message: "temporary", additionalDetails: null },
        completedAt: Date.now(),
      },
    ],
  };
}
async function fixture(
  t: test.TestContext,
  capabilities = permissions,
  override: Partial<DeckPluginWorkerHost> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "deck-plugin-worker-"));
  let changes = 0;
  let sends = 0;
  let manager: DeckPluginWorkers;
  const store = new DeckPluginStore(root, () => {
    changes++;
    void manager?.reconcile();
  }, []);
  await store.installPackage(packageFiles("1.0.0", capabilities), undefined);
  const state = session();
  const host: DeckPluginWorkerHost = {
    readSession: async () => structuredClone(state),
    sendMessage: async (_id, text, validate) => {
      validate();
      assert.equal(text, "continue");
      sends++;
      return { turnId: "auto" };
    },
    changed: () => {
      changes++;
    },
    ...override,
  };
  manager = new DeckPluginWorkers(store, host);
  await manager.start();
  t.after(async () => {
    await manager.stop();
    await rm(root, { recursive: true, force: true });
  });
  const app = new Hono();
  registerDeckPluginRoutes(app, store, manager);
  return {
    root,
    manager,
    store,
    app,
    state,
    host,
    changes: () => changes,
    sends: () => sends,
    rpc: (method: string, params = {}) =>
      manager.request("example.worker", "rpc", { method, params }),
  };
}

test("manifest directly supports backend and UI contributions without API versions", () => {
  const source = JSON.parse(
    Buffer.from(packageFiles()[0].contentBase64, "base64").toString(),
  );
  assert.equal(
    parseDeckPluginManifest(source).entrypoints.backend,
    "worker.mjs",
  );
  assert.ok(!("apiVersion" in parseDeckPluginManifest(source)));
  assert.throws(
    () => parseDeckPluginManifest({ ...source, capabilities: [] }),
    /backend.execute/,
  );
  assert.throws(
    () =>
      parseDeckPluginManifest({
        ...source,
        entrypoints: {},
        contributions: undefined,
      }),
    /at least one/,
  );
});

test("workers have separate processes and reconcile enablement, updates and uninstall", async (t) => {
  const f = await fixture(t);
  const pid = await f.manager.request("example.worker", "pid", {});
  assert.notEqual(pid, process.pid);
  await f.store.setEnabled("example.worker", false);
  assert.deepEqual((await f.manager.snapshot()).plugins, []);
  await assert.rejects(f.manager.request("example.worker", "pid", {}));
  await f.store.setEnabled("example.worker", true);
  await f.manager.reconcile();
  const nextPid = await f.manager.request("example.worker", "pid", {});
  assert.notEqual(nextPid, pid);
  await f.store.installPackage(packageFiles("1.0.1"), "1.0.0");
  await f.manager.reconcile();
  assert.notEqual(
    await f.manager.request("example.worker", "pid", {}),
    nextPid,
  );
  await f.store.uninstall("example.worker");
  await f.manager.reconcile();
  assert.deepEqual((await f.store.list()).plugins, []);
});

test("capabilities are enforced for worker RPCs and browser secret routes", async (t) => {
  const f = await fixture(t, ["backend.execute", "worker.request"]);
  await assert.rejects(
    f.rpc("sessions.get", { threadId: "s" }),
    /sessions.read is not granted/,
  );
  await assert.rejects(
    f.rpc("data.set", { data: { test: 1 } }),
    /data.write is not granted/,
  );
  await assert.rejects(
    f.rpc("codex.homes.list"),
    /codex.homes.read is not granted/,
  );
  for (const method of ["ensure", "get", "submit", "interrupt"]) {
    await assert.rejects(
      f.rpc(`codex.sessions.${method}`, {}),
      /codex.sessions.manage is not granted/,
    );
  }
  assert.equal(
    (await f.app.request("/api/deck/plugins/example.worker/secrets")).status,
    400,
  );
  assert.equal(
    (
      await f.app.request("/api/deck/plugins/example.worker/secrets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "never-saved" }),
      })
    ).status,
    400,
  );
});

test("private data survives worker restart while browser responses redact secrets", async (t) => {
  const f = await fixture(t);
  await f.rpc("data.set", { data: { episode: { pending: true } } });
  await f.manager.setSecrets("example.worker", { apiKey: "mock-secret-only" });
  const response = await f.app.request(
    "/api/deck/plugins/example.worker/secrets",
  );
  assert.deepEqual(await response.json(), { apiKey: true });
  for (const suffix of ["runtime", "source"]) {
    assert.doesNotMatch(
      await (
        await f.app.request(`/api/deck/plugins/example.worker/${suffix}`)
      ).text(),
      /mock-secret-only/,
    );
  }
  assert.doesNotMatch(
    JSON.stringify(await f.manager.snapshot()),
    /mock-secret-only/,
  );
  assert.deepEqual(await f.rpc("secrets.get"), { apiKey: "mock-secret-only" });
  const path = join(
    f.root,
    "codex-deck/plugin-backend/example.worker/secrets.json",
  );
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.match(await readFile(path, "utf8"), /mock-secret-only/);
  await f.store.setEnabled("example.worker", false);
  await f.store.setEnabled("example.worker", true);
  await f.manager.reconcile();
  assert.deepEqual(await f.rpc("data.get"), { episode: { pending: true } });
  assert.deepEqual(
    await f.manager.setSecrets("example.worker", { apiKey: null }),
    {},
  );
});

test("concurrent clients cannot duplicate a guarded continuation, including with different request IDs", async (t) => {
  const f = await fixture(t);
  await f.manager.setSessionEnabled("example.worker", "s", true);
  const state = (await f.rpc("sessions.get", {
    threadId: "s",
  })) as DeckPluginSession;
  const params = {
    threadId: "s",
    text: "continue",
    expectedTurnId: "failed",
    expiresAt: Date.now() + 60_000,
    revision: state.revision,
  };
  const results = await Promise.all([
    f.rpc("sessions.submit", { ...params, requestId: "first" }),
    f.rpc("sessions.submit", { ...params, requestId: "second" }),
  ]);
  assert.equal(f.sends(), 1);
  assert.deepEqual(results[0], results[1]);
});

test("guarded submissions through the server preserve the target model and effort", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "deck-plugin-model-"));
  await new DeckPluginStore(root, () => {}).installPackage(
    packageFiles(),
    undefined,
  );
  const server = createServer({ port: 0, codexDir: root, open: false });
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const settings = { model: "gpt-6.2-astra", effort: "xhigh" };
  const submitted: (typeof settings)[] = [];
  client.readPluginSession = async () => session();
  const rpc = client as unknown as {
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
  };
  rpc.request = async (method, params) => {
    if (method === "config/read")
      return {
        config: {
          model: "gpt-6.1-sol",
          model_reasoning_effort: "low",
          model_provider: "provider",
        },
      };
    if (method === "thread/read") return { thread: { model: settings.model } };
    if (method === "thread/resume") {
      if (params.modelProvider) {
        settings.model = "gpt-6.1-sol";
        settings.effort = "low";
      }
      if (typeof params.model === "string") settings.model = params.model;
      const config = params.config as Record<string, unknown> | undefined;
      if (typeof config?.model_reasoning_effort === "string")
        settings.effort = config.model_reasoning_effort;
      return { thread: { id: "s" } };
    }
    assert.ok(method === "thread/settings/update" || method === "turn/start");
    if (typeof params.model === "string") settings.model = params.model;
    if (typeof params.effort === "string") settings.effort = params.effort;
    if (method === "thread/settings/update") return {};
    submitted.push({ ...settings });
    return { turn: { id: "auto" } };
  };
  setCodexAppServerClientForTests(
    client as unknown as CodexAppServerClientFacade,
  );
  t.after(async () => {
    await server.stop();
    setCodexAppServerClientForTests(null);
    await rm(root, { recursive: true, force: true });
  });
  await server.initialize();
  const base = "/api/deck/plugins/example.worker";
  assert.equal(
    (
      await server.app.request(`${base}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: "s", enabled: true }),
      })
    ).status,
    200,
  );
  const request = async (method: string, params: Record<string, unknown>) => {
    const response = await server.app.request(`${base}/worker`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "rpc", params: { method, params } }),
    });
    assert.equal(response.status, 200);
    const { requestId } = await response.json();
    for (let tries = 0; tries < 100; tries++) {
      const job = await (
        await server.app.request(`${base}/worker/${requestId}`)
      ).json();
      if (job.done) {
        assert.equal(job.error, undefined);
        return job.result;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Worker request did not finish");
  };
  const state = await request("sessions.get", { threadId: "s" });
  const result = await request("sessions.submit", {
    threadId: "s",
    text: "continue",
    expectedTurnId: "failed",
    expiresAt: Date.now() + 60_000,
    revision: state.revision,
    requestId: "retry",
  });
  assert.equal(result.phase, "accepted");
  assert.deepEqual(submitted, [{ model: "gpt-6.2-astra", effort: "xhigh" }]);
});

test("guard rejects disabled recovery, newer manual actions, waits and queued messages", async (t) => {
  const f = await fixture(t);
  const attempt = async (name: string) => {
    const state = (await f.rpc("sessions.get", {
      threadId: "s",
    })) as DeckPluginSession;
    return f.rpc("sessions.submit", {
      threadId: "s",
      text: "continue",
      expectedTurnId: "failed",
      expiresAt: Date.now() + 60_000,
      revision: state.revision,
      requestId: name,
    });
  };
  await assert.rejects(attempt("disabled"), /no longer permits/);
  await f.manager.setSessionEnabled("example.worker", "s", true);
  for (const field of [
    "pendingInteraction",
    "queuedMessages",
    "activeTurnId",
  ] as const) {
    Object.assign(f.state, {
      [field]: field === "activeTurnId" ? "active" : true,
    });
    await assert.rejects(attempt(field), /no longer permits/);
    Object.assign(f.state, {
      [field]: field === "activeTurnId" ? null : false,
    });
  }
  const stale = (await f.rpc("sessions.get", {
    threadId: "s",
  })) as DeckPluginSession;
  await f.manager.manualAction("s", "interrupt");
  await assert.rejects(
    f.rpc("sessions.submit", {
      threadId: "s",
      text: "continue",
      expectedTurnId: "failed",
      expiresAt: Date.now() + 60_000,
      revision: stale.revision,
      requestId: "stale",
    }),
    /no longer permits/,
  );
  assert.equal(f.sends(), 0);
});

test("ambiguous submissions persist and reconcile actual history across manager restart", async (t) => {
  let sends = 0;
  const f = await fixture(t, permissions, {
    sendMessage: async () => {
      sends++;
      throw new Error("connection lost after acceptance");
    },
  });
  await f.manager.setSessionEnabled("example.worker", "s", true);
  const current = (await f.rpc("sessions.get", {
    threadId: "s",
  })) as DeckPluginSession;
  const params = {
    threadId: "s",
    text: "continue",
    expectedTurnId: "failed",
    expiresAt: Date.now() + 60_000,
    revision: current.revision,
    requestId: "unknown",
  };
  assert.equal(
    ((await f.rpc("sessions.submit", params)) as { phase: string }).phase,
    "ambiguous",
  );
  await f.manager.stop();
  const reopened = new DeckPluginWorkers(f.store, f.host);
  t.after(() => reopened.stop());
  await reopened.start();
  assert.equal(
    (
      (await reopened.request("example.worker", "rpc", {
        method: "sessions.submit",
        params,
      })) as { phase: string }
    ).phase,
    "ambiguous",
  );
  assert.equal(sends, 1);
  f.state.turns.push({
    id: "actual",
    status: "completed",
    userText: "continue",
    error: null,
    completedAt: Date.now(),
  });
  const reconciled = (await reopened.request("example.worker", "rpc", {
    method: "sessions.submission",
    params: { requestId: "unknown" },
  })) as { phase: string; turnId: string };
  assert.equal(reconciled.phase, "accepted");
  assert.equal(reconciled.turnId, "actual");
  assert.equal(sends, 1);
});

test("status contributions use server timestamps, broadcast changes, and stay isolated by home", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  const before = first.changes();
  await first.manager.setSessionEnabled("example.worker", "s", true);
  await first.rpc("status.set", {
    threadId: "s",
    status: {
      phase: "waiting",
      reason: "Transient",
      nextAt: Date.now() + 30_000,
      actions: [{ id: "cancel:episode", label: "Cancel retry" }],
    },
  });
  const snapshot = await (
    await first.app.request("/api/deck/plugins/contributions")
  ).json();
  assert.equal(snapshot.plugins[0].sessions.s, true);
  assert.equal(snapshot.plugins[0].statuses.s.phase, "waiting");
  assert.deepEqual(snapshot.plugins[0].statuses.s.actions, [
    { id: "cancel:episode", label: "Cancel retry" },
  ]);
  assert.ok(snapshot.plugins[0].statuses.s.updatedAt <= snapshot.serverTime);
  assert.ok(first.changes() > before);
  for (const actions of [
    [
      { id: "cancel", label: "Cancel" },
      { id: "cancel", label: "Duplicate" },
    ],
    [{ id: "cancel", label: "x".repeat(81) }],
    [{ id: "", label: "Cancel" }],
    Array.from({ length: 5 }, (_, i) => ({
      id: `action-${i}`,
      label: "Action",
    })),
  ]) {
    await assert.rejects(
      first.rpc("status.set", {
        threadId: "s",
        status: { phase: "waiting", reason: "Transient", actions },
      }),
    );
  }
  assert.deepEqual((await second.manager.snapshot()).plugins[0].sessions, {});
  await first.manager.setSessionEnabled("example.worker", "s", false);
  assert.equal(
    (await first.manager.snapshot()).plugins[0].statuses.s,
    undefined,
  );
});

test("worker UI jobs return immediately and expose only their own completed result", async (t) => {
  const f = await fixture(t);
  const response = await f.app.request(
    "/api/deck/plugins/example.worker/worker",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "pid", params: {} }),
    },
  );
  assert.equal(response.status, 200);
  const { requestId } = (await response.json()) as { requestId: string };
  let job: { done: boolean; result?: unknown } = { done: false };
  for (let tries = 0; tries < 100 && !job.done; tries++) {
    job = await (
      await f.app.request(
        `/api/deck/plugins/example.worker/worker/${requestId}`,
      )
    ).json();
    if (!job.done) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(job.done, true);
  assert.equal(typeof job.result, "number");
  assert.notEqual(job.result, process.pid);
  assert.equal(
    (await f.app.request("/api/deck/plugins/example.worker/worker/unknown"))
      .status,
    404,
  );
});

test("beforeFirstMessage hooks validate manifest, transform messages sequentially, surface live detail, and support cancel", async (t) => {
  assert.throws(
    () =>
      parseDeckPluginManifest({
        schemaVersion: 1,
        id: "example.hook-invalid",
        name: "Invalid Hook",
        version: "1.0.0",
        description: "Missing capability",
        capabilities: ["backend.execute"],
        entrypoints: { backend: "worker.mjs" },
        contributions: {
          beforeFirstMessage: { method: "transform" },
        },
      }),
    /sessions\.transform/,
  );

  const root = await mkdtemp(join(tmpdir(), "deck-plugin-hook-"));
  let manager: DeckPluginWorkers;
  const store = new DeckPluginStore(root, () => {
    void manager?.reconcile();
  }, []);
  const makeHookPkg = (id: string, order: number, source: string) =>
    Object.entries({
      "plugin.json": JSON.stringify({
        schemaVersion: 1,
        id,
        name: id,
        version: "1.0.0",
        description: "Hook fixture",
        capabilities: [
          "backend.execute",
          "sessions.transform",
          "status.write",
          "sessions.events",
        ],
        entrypoints: { backend: "worker.mjs" },
        contributions: {
          sessionTip: true,
          beforeFirstMessage: {
            method: "hook.run",
            waitingLabel: `Running ${id}…`,
            order,
          },
        },
      }),
      "worker.mjs": source,
    }).map(([path, content]) => ({
      path,
      contentBase64: Buffer.from(content).toString("base64"),
    }));

  const firstWorker = `
    let n = 0;
    const pending = new Map();
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const requestId = String(++n);
      pending.set(requestId, { resolve, reject });
      process.send({ type: 'request', requestId, method, params });
    });
    process.on('message', async (msg) => {
      if (msg.type === 'initialize') process.send({ type: 'ready' });
      if (msg.type === 'response') { const p = pending.get(msg.requestId); if (p) { pending.delete(msg.requestId); msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result); } }
      if (msg.type === 'request' && msg.method === 'host.shutdown') { process.send({ type: 'response', requestId: msg.requestId, result: null }); return; }
      if (msg.type === 'request' && msg.method === 'hook.run') {
        await rpc('status.set', { threadId: msg.params.threadId, status: { phase: 'evaluating', reason: 'Checking rules' } });
        if (msg.params.text === 'SLOW') {
          await new Promise((r) => setTimeout(r, 3000));
        }
        process.send({
          type: 'response',
          requestId: msg.requestId,
          result: {
            text: '[PRE] ' + msg.params.text,
            changed: true,
            summary: 'Prepended tag',
            appliedItems: [{ id: 'r1', name: 'Prefix', mode: 'prepend', reason: 'matched' }],
          },
        });
      }
    });
    process.on('disconnect', () => process.exit(0));
  `;
  const secondWorker = `
    process.on('message', (msg) => {
      if (msg.type === 'initialize') process.send({ type: 'ready' });
      if (msg.type === 'request' && msg.method === 'host.shutdown') { process.send({ type: 'response', requestId: msg.requestId, result: null }); return; }
      if (msg.type === 'request' && msg.method === 'hook.run') {
        process.send({
          type: 'response',
          requestId: msg.requestId,
          result: { text: msg.params.text + ' [POST]', changed: true, summary: 'Appended tag' },
        });
      }
    });
    process.on('disconnect', () => process.exit(0));
  `;

  await store.installPackage(
    makeHookPkg("hook.first", 1, firstWorker),
    undefined,
  );
  await store.installPackage(
    makeHookPkg("hook.second", 2, secondWorker),
    undefined,
  );

  manager = new DeckPluginWorkers(store, {
    readSession: async () => session(),
    sendMessage: async () => ({ turnId: "t" }),
    changed: () => {},
  });
  await manager.start();
  t.after(async () => {
    await manager.stop();
    await rm(root, { recursive: true, force: true });
  });
  const app = new Hono();
  registerDeckPluginRoutes(app, store, manager);

  const started = await (
    await app.request("/api/deck/plugins/hooks/before-first-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: "new-thread-1",
        cwd: "/tmp/demo",
        text: "Build feature X",
      }),
    })
  ).json();
  assert.ok(started.jobId);
  assert.equal(started.plugins.length, 2);

  let state = started;
  for (let i = 0; i < 100 && !state.done; i++) {
    state = await (
      await app.request(
        `/api/deck/plugins/hooks/before-first-message/${started.jobId}`,
      )
    ).json();
    if (!state.done) await new Promise((r) => setTimeout(r, 15));
  }
  assert.equal(state.done, true);
  assert.equal(state.changed, true);
  assert.equal(state.text, "[PRE] Build feature X [POST]");
  assert.equal(state.completedPlugins.length, 2);
  assert.equal(state.completedPlugins[0].appliedItems[0].mode, "prepend");

  // Cancellation aborts an in-flight slow hook immediately.
  const slow = await (
    await app.request("/api/deck/plugins/hooks/before-first-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: "new-thread-2", text: "SLOW" }),
    })
  ).json();
  assert.ok(slow.jobId);
  const canceled = await (
    await app.request(
      `/api/deck/plugins/hooks/before-first-message/${slow.jobId}/cancel`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    )
  ).json();
  assert.equal(canceled.done, true);
  assert.equal(canceled.canceled, true);
});

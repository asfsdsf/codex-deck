import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeckPluginCodexSessions } from "../../api/deck-plugin-codex-sessions";
import { DeckPluginBackendStorage } from "../../api/deck-plugin-backend-storage";
import {
  CodexAppServerClient,
  CodexAppServerRpcError,
} from "../../api/codex-app-server";
import type { DeckPluginSession } from "../../api/deck-plugin-manifest";
import type { ResolvedCodexHome } from "../../api/codex-home-registry";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "plugin-codex-sessions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new DeckPluginBackendStorage(root);
  const homes: ResolvedCodexHome[] = ["main", "diagnostic"].map((id) => ({
    id,
    label: id,
    path: join(root, id),
    isMain: id === "main",
    available: true,
    unavailableReason: null,
  }));
  const states = new Map<string, DeckPluginSession>();
  const created: string[] = [],
    sent: string[] = [],
    interrupted: string[] = [];
  let ambiguous: "before" | "after" | null = null;
  let readFailure: Error | null = null;
  const make = () =>
    new DeckPluginCodexSessions(
      storage,
      () => homes,
      (home) => ({
        createThread: async (input) => {
          assert.equal(input.readOnly, true);
          const id = `thread-${created.length}`;
          created.push(home.path);
          states.set(id, {
            threadId: id,
            cwd: input.cwd,
            codexHome: home.path,
            activeTurnId: null,
            pendingInteraction: false,
            queuedMessages: false,
            interactive: true,
            revision: "",
            turns: [],
          });
          return id;
        },
        readPluginSession: async (id) => {
          if (readFailure) throw readFailure;
          const state = states.get(id);
          if (!state)
            throw new CodexAppServerRpcError(
              -32600,
              `no rollout found for thread id ${id}`,
            );
          return structuredClone(state);
        },
        sendMessage: async (input) => {
          input.beforeSubmit?.();
          assert.equal(input.readOnly, true);
          sent.push(input.threadId);
          if (ambiguous === "before") throw new Error("transport lost");
          const state = states.get(input.threadId)!;
          const id = `turn-${sent.length}`;
          state.turns.push({
            id,
            status: "inProgress",
            error: null,
            userText: input.text!,
            assistantText: "",
            completedAt: null,
          });
          state.activeTurnId = id;
          if (ambiguous === "after") throw new Error("transport lost");
          return { turnId: id };
        },
        interruptThread: async (id, expected) => {
          assert.equal(states.get(id)!.activeTurnId, expected);
          interrupted.push(id);
        },
        close: async () => {},
      }),
    );
  const service = make();
  t.after(() => service.close());
  const ensure = (key = "target", homeId = "diagnostic") =>
    service.ensure("example.plugin", { key, homeId, cwd: root }, () => {});
  return {
    service,
    make,
    ensure,
    root,
    homes,
    states,
    created,
    sent,
    interrupted,
    ambiguous: (value: typeof ambiguous) => {
      ambiguous = value;
    },
    readFailure: (value: Error) => {
      readFailure = value;
    },
  };
}

test("plugin sessions reuse one thread per target and home across concurrent calls and restarts", async (t) => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([f.ensure(), f.ensure()]);
  assert.deepEqual(second, first);
  assert.deepEqual(f.created, [f.homes[1].path]);
  const reopened = f.make();
  t.after(() => reopened.close());
  assert.deepEqual(
    await reopened.ensure(
      "example.plugin",
      { key: "target", homeId: "diagnostic", cwd: f.root },
      () => {},
    ),
    first,
  );
  assert.notEqual((await f.ensure("another-target")).threadId, first.threadId);
  assert.notEqual((await f.ensure("target", "main")).threadId, first.threadId);
});

test("ensure repairs an unused thread lost on restart while preserving its session reference", async (t) => {
  const f = await fixture(t);
  const ref = await f.ensure();
  f.states.delete(ref.threadId);
  const reopened = f.make();
  t.after(() => reopened.close());
  const ensure = () =>
    reopened.ensure(
      "example.plugin",
      { key: "target", homeId: "diagnostic", cwd: f.root },
      () => {},
    );
  const [repaired, concurrent] = await Promise.all([ensure(), ensure()]);
  assert.equal(repaired.sessionId, ref.sessionId);
  assert.notEqual(repaired.threadId, ref.threadId);
  assert.deepEqual(concurrent, repaired);
  assert.equal(f.created.length, 2);
  assert.equal(
    (
      await reopened.submit(
        "example.plugin",
        { ...ref, requestId: "first", text: "diagnose" },
        () => {},
      )
    )?.phase,
    "accepted",
  );
  assert.deepEqual(f.sent, [repaired.threadId]);
});

test("ensure never replaces missing threads after accepted or uncertain submissions", async (t) => {
  for (const phase of [null, "before"] as const) {
    const f = await fixture(t);
    const ref = await f.ensure();
    f.ambiguous(phase);
    const params = { ...ref, requestId: "first", text: "diagnose" };
    await f.service.submit("example.plugin", params, () => {});
    f.states.delete(ref.threadId);
    assert.deepEqual(await f.ensure(), ref);
    await assert.rejects(
      f.service.get("example.plugin", ref),
      /no rollout found/,
    );
    await assert.rejects(
      f.service.submit("example.plugin", params, () => {}),
      /no rollout found/,
    );
    assert.equal(f.created.length, 1);
    assert.equal(f.sent.length, 1);
  }
});

test("ensure preserves unused sessions on storage or transport failures", async (t) => {
  for (const error of [
    new CodexAppServerRpcError(-32000, "storage unavailable"),
    new Error("connection lost"),
  ]) {
    const f = await fixture(t);
    await f.ensure();
    f.readFailure(error);
    await assert.rejects(f.ensure(), error);
    assert.equal(f.created.length, 1);
  }
});

test("a new paginated plugin session accepts its first message before history is materialized", async (t) => {
  const f = await fixture(t);
  const client = new CodexAppServerClient({
    readOnly: true,
    env: { CODEX_HOME: f.homes[1].path },
  });
  const rpc = client as unknown as {
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
  };
  let starts = 0;
  let sentText = "";
  rpc.request = async (method, params) => {
    if (method === "config/read") return { config: {} };
    if (method === "thread/start") return { thread: { id: "diagnostic" } };
    if (method === "thread/settings/update") return {};
    if (method === "thread/read") {
      assert.equal(params.includeTurns, false);
      return {
        thread: {
          id: "diagnostic",
          cwd: f.root,
          historyMode: "paginated",
          status: { type: "idle" },
        },
      };
    }
    if (method === "thread/queue/list") return { data: [], nextCursor: null };
    if (method === "thread/turns/list") {
      if (!starts)
        throw new CodexAppServerRpcError(
          -32600,
          "thread diagnostic is not materialized yet; thread/turns/list is unavailable before first user message",
        );
      return {
        data: [{ id: "first-turn", status: "completed" }],
        nextCursor: null,
      };
    }
    if (method === "thread/items/list") {
      assert.equal(starts, 1, "empty threads must not request item history");
      return {
        data: [
          {
            turnId: "first-turn",
            item: {
              id: "prompt",
              type: "userMessage",
              content: [{ type: "text", text: sentText }],
            },
          },
          {
            turnId: "first-turn",
            item: {
              id: "answer",
              type: "agentMessage",
              phase: "final_answer",
              text: '{"decision":"wait","reason":"Temporary outage"}',
            },
          },
        ],
        nextCursor: null,
      };
    }
    if (method === "turn/start") {
      starts++;
      assert.deepEqual(params.sandboxPolicy, { type: "readOnly" });
      sentText = (params.input as Array<{ text: string }>)[0].text;
      return { turn: { id: "first-turn", status: "completed" } };
    }
    throw new Error(`Unexpected RPC: ${method}`);
  };
  const service = new DeckPluginCodexSessions(
    new DeckPluginBackendStorage(f.root),
    () => f.homes,
    () => client,
  );
  t.after(() => service.close());
  const ref = await service.ensure(
    "example.plugin",
    { key: "target", homeId: "diagnostic", cwd: f.root },
    () => {},
  );
  const empty = await service.get("example.plugin", ref);
  assert.deepEqual(empty.session.turns, []);
  assert.equal(empty.session.interactive, true);
  assert.equal(empty.session.queuedMessages, false);
  const params = { ...ref, requestId: "first", text: "Diagnose the failure" };
  assert.equal(
    (await service.submit("example.plugin", params, () => {}))?.phase,
    "accepted",
  );
  const result = await service.get("example.plugin", params);
  assert.equal(
    result.session.turns[0].assistantText,
    '{"decision":"wait","reason":"Temporary outage"}',
  );
  assert.equal(result.submission?.turnId, "first-turn");
  await service.submit("example.plugin", params, () => {});
  assert.equal(starts, 1, "reconciliation must not send the prompt again");
});

test("Codex host rejects unowned sessions, unavailable homes and changed home paths", async (t) => {
  const f = await fixture(t);
  const ref = await f.ensure();
  await assert.rejects(f.service.get("other.plugin", ref), /not found/);
  f.homes[1].path += "-changed";
  await assert.rejects(
    f.service.get("example.plugin", ref),
    /unavailable|path changed/,
  );
  f.homes[1].available = false;
  await assert.rejects(f.ensure(), /unavailable/);
  assert.equal(f.sent.length, 0);
});

test("diagnostic message intents reconcile acceptance without resending after restart", async (t) => {
  const f = await fixture(t);
  const ref = await f.ensure();
  const params = {
    ...ref,
    requestId: "request",
    text: "diagnose target",
    outputSchema: { type: "object" },
  };
  f.ambiguous("after");
  assert.equal(
    (await f.service.submit("example.plugin", params, () => {}))?.phase,
    "ambiguous",
  );
  const reopened = f.make();
  t.after(() => reopened.close());
  assert.equal(
    (await reopened.submit("example.plugin", params, () => {}))?.phase,
    "accepted",
  );
  assert.equal(f.sent.length, 1);
  const result = await reopened.get("example.plugin", params);
  assert.equal(result.submission?.turnId, result.session.activeTurnId);
  await reopened.interrupt("example.plugin", params);
  assert.deepEqual(f.interrupted, [ref.threadId]);
});

test("uncertain diagnostic submissions cannot be bypassed with new request IDs", async (t) => {
  const f = await fixture(t),
    ref = await f.ensure();
  f.ambiguous("before");
  const params = { ...ref, requestId: "first", text: "diagnose" };
  await f.service.submit("example.plugin", params, () => {});
  await f.service.submit("example.plugin", params, () => {});
  await assert.rejects(
    f.service.submit(
      "example.plugin",
      { ...params, requestId: "second" },
      () => {},
    ),
    /ambiguous/,
  );
  await assert.rejects(
    f.service.submit(
      "example.plugin",
      { ...params, text: "different" },
      () => {},
    ),
    /different message/,
  );
  assert.equal(f.sent.length, 1);
});

test("diagnostic sends respect waits, active turns, queues and revoked permission", async (t) => {
  const f = await fixture(t),
    ref = await f.ensure();
  const state = f.states.get(ref.threadId)!;
  for (const field of [
    "pendingInteraction",
    "queuedMessages",
    "activeTurnId",
  ] as const) {
    Object.assign(state, { [field]: field === "activeTurnId" ? "busy" : true });
    await assert.rejects(
      f.service.submit(
        "example.plugin",
        { ...ref, requestId: field, text: "diagnose" },
        () => {},
      ),
      /busy|interaction/,
    );
    Object.assign(state, { [field]: field === "activeTurnId" ? null : false });
  }
  await assert.rejects(
    f.service.submit(
      "example.plugin",
      { ...ref, requestId: "revoked", text: "diagnose" },
      () => {
        throw new Error("revoked");
      },
    ),
    /revoked/,
  );
  assert.equal(f.sent.length, 0);
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeckPluginCodexSessions } from "../../api/deck-plugin-codex-sessions";
import { DeckPluginBackendStorage } from "../../api/deck-plugin-backend-storage";
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
        readPluginSession: async (id) => structuredClone(states.get(id)!),
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

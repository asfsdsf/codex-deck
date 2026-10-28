import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { __TEST_ONLY__ } from "../../api/codex-app-server";
import {
  parseRealtimeVoices,
  RealtimeVoiceManager,
  validateRealtimeOfferSdp,
} from "../../api/codex-realtime";
import { registerRealtimeVoiceRoutes } from "../../api/server/realtime-voice-routes";

const OFFER = [
  "v=0",
  "o=- 1 2 IN IP4 127.0.0.1",
  "s=-",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=sendrecv",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "",
].join("\r\n");

function createManager(
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  options: Partial<ConstructorParameters<typeof RealtimeVoiceManager>[0]> = {},
) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const notified: string[] = [];
  const manager = new RealtimeVoiceManager({
    rpc: async (method, params) => {
      calls.push({ method, params });
      return rpc(method, params);
    },
    threadRpc: async (method, params) => {
      calls.push({ method, params });
      return rpc(method, params);
    },
    notify: (threadId) => notified.push(threadId),
    notifyThrottleMs: 0,
    answerTimeoutMs: 50,
    ...options,
  });
  return { manager, calls, notified };
}

test("SDP offers must carry audio and the realtime data channel", () => {
  assert.equal(validateRealtimeOfferSdp(OFFER), OFFER);
  assert.throws(() => validateRealtimeOfferSdp(""), /required/);
  assert.throws(() => validateRealtimeOfferSdp("hello"), /malformed/);
  assert.throws(
    () => validateRealtimeOfferSdp("v=0\r\nm=audio 9 x 1\r\n"),
    /data channel/,
  );
});

test("voice catalog prefers V3 voices and validates the default", () => {
  assert.deepEqual(
    parseRealtimeVoices({
      voices: {
        v1: ["cove", "maple"],
        v2: ["marin"],
        v3: ["cove", "maple", "aube"],
        defaultV1: "cove",
        defaultV2: "marin",
      },
    }),
    { voices: ["cove", "maple", "aube"], defaultVoice: "cove" },
  );
  assert.deepEqual(
    parseRealtimeVoices({
      voices: { v1: ["cove"], v2: [], defaultV1: "nope" },
    }),
    { voices: ["cove"], defaultVoice: null },
  );
  assert.throws(() => parseRealtimeVoices({ voices: { v1: [] } }));
});

test("start relays the WebRTC offer and returns the SDP answer only to the owner", async () => {
  let manager!: RealtimeVoiceManager;
  const created = createManager(async (method) => {
    if (method === "thread/realtime/start") {
      // The answer can arrive before the start response resolves.
      manager.handleNotification("thread/realtime/sdp", {
        threadId: "t1",
        sdp: "v=0\r\nanswer",
      });
      return {};
    }
    return {};
  });
  manager = created.manager;
  const result = await manager.start("t1", {
    clientId: "page-a",
    sdp: OFFER,
    voice: "maple",
  });
  assert.equal(result.answerSdp, "v=0\r\nanswer");
  assert.equal(result.session?.phase, "starting");
  assert.equal(result.session?.ownerClientId, "page-a");
  const start = created.calls.find(
    (call) => call.method === "thread/realtime/start",
  );
  assert.deepEqual(start?.params.transport, { type: "webrtc", sdp: OFFER });
  assert.equal(start?.params.outputModality, "audio");
  assert.equal(start?.params.version, "v3");
  assert.equal(start?.params.voice, "maple");
  assert.equal(manager.snapshot("t1", "page-b").answerSdp, null);
  assert.equal(manager.snapshot("t1", "page-a").answerSdp, "v=0\r\nanswer");

  manager.handleNotification("thread/realtime/started", {
    threadId: "t1",
    realtimeSessionId: "rt_1",
    version: "v3",
  });
  assert.equal(manager.snapshot("t1").session?.phase, "active");
  assert.equal(manager.snapshot("t1").session?.realtimeSessionId, "rt_1");
  assert.ok(created.notified.length >= 3);
  assert.ok(created.notified.every((id) => id === "t1"));
});

test("a second page cannot start voice while another device owns it, but may stop it", async () => {
  const { manager, calls } = createManager(async () => ({}));
  await manager.start("t1", { clientId: "page-a", sdp: OFFER });
  await assert.rejects(
    manager.start("t1", { clientId: "page-b", sdp: OFFER }),
    (error: Error & { status?: number }) =>
      error.status === 409 && /another device/.test(error.message),
  );
  await assert.rejects(
    manager.start("t2", { clientId: "page-a", sdp: OFFER }),
    (error: Error & { status?: number }) => error.status === 409,
  );
  assert.throws(
    () => manager.heartbeat("t1", "page-b"),
    (error: Error & { status?: number }) => error.status === 403,
  );

  const stopped = await manager.stop("t1", "page-b");
  assert.equal(stopped.session?.phase, "stopping");
  assert.equal(stopped.session?.stoppedByClientId, "page-b");
  assert.ok(calls.some((call) => call.method === "thread/realtime/stop"));
  manager.handleNotification("thread/realtime/closed", {
    threadId: "t1",
    reason: "requested",
  });
  const ended = manager.snapshot("t1", "page-a");
  assert.equal(ended.session?.phase, "ended");
  assert.equal(ended.session?.error, null);
  assert.equal(ended.answerSdp, null);

  // Once ended, any page may start a new session.
  const restarted = await manager.start("t1", {
    clientId: "page-b",
    sdp: OFFER,
  });
  assert.equal(restarted.session?.ownerClientId, "page-b");
});

test("transcript deltas accumulate per role and finalize on done", async () => {
  const { manager } = createManager(async () => ({}));
  await manager.start("t1", { clientId: "page-a", sdp: OFFER });
  manager.handleNotification("thread/realtime/transcript/delta", {
    threadId: "t1",
    role: "user",
    delta: "What is ",
  });
  manager.handleNotification("thread/realtime/transcript/delta", {
    threadId: "t1",
    role: "assistant",
    delta: "Let me",
  });
  manager.handleNotification("thread/realtime/transcript/delta", {
    threadId: "t1",
    role: "user",
    delta: "this repo?",
  });
  manager.handleNotification("thread/realtime/transcript/done", {
    threadId: "t1",
    role: "user",
    text: "What is this repo?",
  });
  let transcript = manager.snapshot("t1").session!.transcript;
  assert.deepEqual(
    transcript.map(({ role, text, final }) => ({ role, text, final })),
    [
      { role: "user", text: "What is this repo?", final: true },
      { role: "assistant", text: "Let me", final: false },
    ],
  );
  manager.handleNotification("thread/realtime/transcript/done", {
    threadId: "t1",
    role: "assistant",
    text: "",
  });
  transcript = manager.snapshot("t1").session!.transcript;
  assert.equal(transcript[1].text, "Let me");
  assert.equal(transcript[1].final, true);
});

test("realtime errors fail the session, stop the backend, and reject a pending start", async () => {
  let manager!: RealtimeVoiceManager;
  const created = createManager(
    async (method) => {
      if (method === "thread/realtime/start") {
        queueMicrotask(() =>
          manager.handleNotification("thread/realtime/error", {
            threadId: "t1",
            message: "Realtime is not available for this account",
          }),
        );
      }
      return {};
    },
    { answerTimeoutMs: 5_000 },
  );
  manager = created.manager;
  await assert.rejects(
    manager.start("t1", { clientId: "page-a", sdp: OFFER }),
    /not available for this account/,
  );
  const snapshot = manager.snapshot("t1");
  assert.equal(snapshot.session?.phase, "failed");
  assert.match(snapshot.session?.error ?? "", /not available/);
  assert.ok(
    created.calls.some((call) => call.method === "thread/realtime/stop"),
  );
});

test("missing app-server support and owner timeouts are reported clearly", async () => {
  const unsupported = createManager(async (method) => {
    if (method.startsWith("thread/realtime/"))
      throw Object.assign(new Error("method not found"), { code: -32601 });
    return {};
  });
  await assert.rejects(
    unsupported.manager.start("t1", { clientId: "a", sdp: OFFER }),
    (error: Error & { status?: number }) =>
      error.status === 501 &&
      /does not support realtime voice/.test(error.message),
  );
  await assert.rejects(unsupported.manager.listVoices(), /does not support/);

  const timed = createManager(async () => ({}), {
    ownerTimeoutMs: 20,
    stopTimeoutMs: 20,
    answerTimeoutMs: 5,
  });
  await timed.manager.start("t1", { clientId: "a", sdp: OFFER });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const snapshot = timed.manager.snapshot("t1");
  assert.equal(snapshot.session?.phase, "failed");
  assert.match(snapshot.session?.error ?? "", /stopped responding/);
  assert.ok(timed.calls.some((call) => call.method === "thread/realtime/stop"));
});

test("app-server notifications route through the client and broadcast voice state", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const internal = client as unknown as {
    request: (method: string, params: unknown) => Promise<unknown>;
    ensureConnected: () => Promise<void>;
    ensureInitialized: () => Promise<void>;
    handleServerNotification: (method: string, params: unknown) => void;
  };
  internal.request = async () => ({});
  internal.ensureConnected = async () => {};
  internal.ensureInitialized = async () => {};
  const first: unknown[] = [];
  const second: unknown[] = [];
  client.subscribeAppServerEvents((event) => first.push(event));
  client.subscribeAppServerEvents((event) => second.push(event));
  internal.handleServerNotification("thread/realtime/started", {
    threadId: "external",
    realtimeSessionId: null,
    version: "v3",
  });
  const voice = client.getRealtimeVoice();
  assert.equal(voice.snapshot("external").session?.ownerClientId, null);
  assert.equal(voice.snapshot("external").session?.phase, "active");
  for (const events of [first, second]) {
    assert.ok(
      events.some(
        (event) =>
          (event as { type?: string; scope?: string; threadId?: string })
            .type === "native_state_changed" &&
          (event as { scope?: string }).scope === "voice" &&
          (event as { threadId?: string }).threadId === "external",
      ),
    );
  }
  internal.handleServerNotification("thread/archived", {
    threadId: "external",
  });
  assert.equal(voice.snapshot("external").session?.phase, "ended");
});

test("voice routes validate input and map ownership conflicts to HTTP status", async () => {
  let manager!: RealtimeVoiceManager;
  const created = createManager(async (method) => {
    if (method === "thread/realtime/listVoices")
      return {
        voices: { v1: ["cove", "maple"], v2: [], defaultV1: "cove" },
      };
    if (method === "config/read")
      return { config: { realtime: { voice: "maple" } } };
    if (method === "config/batchWrite") return { status: "ok" };
    if (method === "thread/realtime/start") {
      manager.handleNotification("thread/realtime/sdp", {
        threadId: "t1",
        sdp: "v=0\r\nanswer",
      });
    }
    return {};
  });
  manager = created.manager;
  const app = new Hono();
  registerRealtimeVoiceRoutes(app, {
    getClient: () => ({ getRealtimeVoice: () => manager }),
  });
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const voices = await (await app.request("/api/codex/realtime/voices")).json();
  assert.deepEqual(voices, {
    voices: ["cove", "maple"],
    defaultVoice: "cove",
    configuredVoice: "maple",
  });
  assert.equal(
    (await post("/api/codex/realtime/voice", { voice: "Bad Voice" })).status,
    400,
  );
  assert.equal(
    (await post("/api/codex/realtime/voice", { voice: "unknown" })).status,
    400,
  );
  const saved = await post("/api/codex/realtime/voice", { voice: "cove" });
  assert.equal(saved.status, 200);
  const write = created.calls.find(
    (call) => call.method === "config/batchWrite",
  );
  assert.deepEqual(write?.params.edits, [
    { keyPath: "realtime.voice", value: "cove", mergeStrategy: "replace" },
  ]);

  assert.equal(
    (await post("/api/codex/threads/t1/realtime/start", { sdp: OFFER })).status,
    400,
  );
  assert.equal(
    (
      await post("/api/codex/threads/t1/realtime/start", {
        clientId: "a",
        sdp: "bogus",
      })
    ).status,
    400,
  );
  const started = await post("/api/codex/threads/t1/realtime/start", {
    clientId: "a",
    sdp: OFFER,
  });
  assert.equal(started.status, 200);
  assert.equal((await started.json()).answerSdp, "v=0\r\nanswer");
  assert.equal(
    (
      await post("/api/codex/threads/t1/realtime/start", {
        clientId: "b",
        sdp: OFFER,
      })
    ).status,
    409,
  );
  assert.equal(
    (await post("/api/codex/threads/t1/realtime/heartbeat", { clientId: "b" }))
      .status,
    403,
  );
  const observer = await (
    await app.request("/api/codex/threads/t1/realtime?clientId=b")
  ).json();
  assert.equal(observer.answerSdp, null);
  assert.equal(observer.session.ownerClientId, "a");
  const stopped = await post("/api/codex/threads/t1/realtime/stop", {
    clientId: "b",
  });
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).session.phase, "stopping");
});

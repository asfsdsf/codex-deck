import assert from "node:assert/strict";
import test from "node:test";
import type {
  RealtimeVoiceSessionView,
  RealtimeVoiceSnapshot,
} from "../../api/storage";
import { VoiceController } from "../../web/voice/voice-controller";
import type {
  VoiceMediaCallbacks,
  VoiceMediaFactory,
} from "../../web/voice/voice-media";
import {
  audioAttachmentMimeType,
  audioAttachmentUnavailableReason,
  describeEndedVoiceSession,
  describeVoiceToggle,
  describeMicrophoneError,
  getRealtimeDelegationDisplayText,
  isAudioDataUrl,
  parseVoiceCommandArgs,
  voiceSessionRelation,
  voiceUnavailableReason,
  withAudioMimeType,
} from "../../web/voice/voice-support";
import { sanitizeText } from "../../web/utils";

function view(
  patch: Partial<RealtimeVoiceSessionView> = {},
): RealtimeVoiceSessionView {
  return {
    threadId: "t1",
    voiceSessionId: "vs1",
    ownerClientId: "page-a",
    phase: "starting",
    voice: null,
    realtimeSessionId: null,
    version: null,
    startedAt: 1,
    updatedAt: 1,
    error: null,
    closedReason: null,
    stoppedByClientId: null,
    transcript: [],
    revision: 1,
    ...patch,
  };
}

function harness(
  options: {
    start?: () => Promise<RealtimeVoiceSnapshot>;
    snapshot?: () => Promise<RealtimeVoiceSnapshot>;
    mediaError?: Error;
    env?: Partial<Parameters<typeof voiceUnavailableReason>[0]>;
  } = {},
) {
  const calls: string[] = [];
  let callbacks: VoiceMediaCallbacks | null = null;
  const media = {
    answers: [] as string[],
    muted: false,
    closed: false,
  };
  const factory: VoiceMediaFactory = {
    async create(_options, cb) {
      calls.push("media:create");
      if (options.mediaError) throw options.mediaError;
      callbacks = cb;
      return {
        offerSdp: "v=0 offer",
        async applyAnswer(sdp) {
          media.answers.push(sdp);
        },
        setMuted(muted) {
          media.muted = muted;
        },
        async resumePlayback() {
          return true;
        },
        close() {
          media.closed = true;
        },
      };
    },
  };
  const controller = new VoiceController({
    clientId: "page-a",
    api: {
      start: async (threadId, input) => {
        calls.push(`start:${threadId}:${input.sdp}`);
        return options.start
          ? options.start()
          : { session: view(), answerSdp: "v=0 answer" };
      },
      stop: async (threadId, _clientId, error) => {
        calls.push(`stop:${threadId}${error ? `:${error}` : ""}`);
        return { session: view({ phase: "stopping" }), answerSdp: null };
      },
      heartbeat: async () => ({ session: view(), answerSdp: null }),
      snapshot: async () =>
        options.snapshot
          ? options.snapshot()
          : { session: view(), answerSdp: null },
    },
    media: factory,
    environment: () => ({
      isSecureContext: true,
      hasGetUserMedia: true,
      hasPeerConnection: true,
      ...options.env,
    }),
    microphone: () => null,
    heartbeatMs: 60_000,
    answerPollMs: 1,
    answerTimeoutMs: 50,
    sleep: async () => {},
  });
  return {
    controller,
    calls,
    media,
    connect: () => callbacks?.onConnectionState("connected"),
    fail: () => callbacks?.onConnectionState("failed"),
  };
}

test("/voice arguments follow the TUI usage", () => {
  assert.equal(parseVoiceCommandArgs(""), "toggle");
  assert.equal(parseVoiceCommandArgs(" Settings "), "settings");
  assert.equal(parseVoiceCommandArgs("mute"), "mute");
  assert.equal(parseVoiceCommandArgs("stop"), "stop");
  assert.equal(parseVoiceCommandArgs("loud"), null);
});

test("insecure contexts and missing browser APIs explain why voice is unavailable", () => {
  assert.match(
    voiceUnavailableReason({
      isSecureContext: false,
      hasGetUserMedia: false,
      hasPeerConnection: true,
      origin: "http://192.168.1.5:12001",
    }) ?? "",
    /HTTPS.*localhost[\s\S]*192\.168\.1\.5/,
  );
  assert.match(
    voiceUnavailableReason({
      isSecureContext: true,
      hasGetUserMedia: true,
      hasPeerConnection: false,
    }) ?? "",
    /WebRTC/,
  );
  assert.equal(
    voiceUnavailableReason({
      isSecureContext: true,
      hasGetUserMedia: true,
      hasPeerConnection: true,
    }),
    null,
  );
  assert.match(
    describeMicrophoneError(
      Object.assign(new Error("x"), { name: "NotAllowedError" }),
    ),
    /denied/,
  );
  assert.match(
    describeMicrophoneError(
      Object.assign(new Error("x"), { name: "NotFoundError" }),
    ),
    /No usable microphone/,
  );
});

test("controller negotiates, mutes, and stops the owned session", async () => {
  const { controller, calls, media, connect } = harness();
  await controller.start("t1");
  assert.deepEqual(calls, ["media:create", "start:t1:v=0 offer"]);
  assert.deepEqual(media.answers, ["v=0 answer"]);
  assert.equal(controller.getState().status, "negotiating");
  connect();
  assert.equal(controller.getState().status, "connected");
  assert.equal(controller.toggleMute(), true);
  assert.equal(media.muted, true);
  assert.equal(controller.getState().muted, true);
  await controller.toggle("t1");
  assert.ok(calls.includes("stop:t1"));
  assert.equal(media.closed, true);
  assert.equal(controller.getState().status, "idle");
  assert.equal(controller.toggleMute(), false);
});

test("controller polls for a late SDP answer", async () => {
  let polls = 0;
  const { controller, media } = harness({
    start: async () => ({ session: view(), answerSdp: null }),
    snapshot: async () => ({
      session: view(),
      answerSdp: ++polls >= 2 ? "v=0 late" : null,
    }),
  });
  await controller.start("t1");
  assert.deepEqual(media.answers, ["v=0 late"]);
});

test("microphone denial and unavailable environments surface errors without a backend call", async () => {
  const denied = harness({
    mediaError: Object.assign(new Error("denied"), { name: "NotAllowedError" }),
  });
  await denied.controller.start("t1");
  assert.equal(denied.controller.getState().status, "idle");
  assert.match(denied.controller.getState().error ?? "", /denied/);
  assert.equal(denied.controller.getState().errorThreadId, "t1");
  assert.ok(!denied.calls.some((call) => call.startsWith("start:")));

  const insecure = harness({ env: { isSecureContext: false } });
  await insecure.controller.start("t1");
  assert.match(insecure.controller.getState().error ?? "", /HTTPS/);
  assert.deepEqual(insecure.calls, []);
});

test("a stop from another device or a lost connection tears media down", async () => {
  const stoppedElsewhere = harness();
  await stoppedElsewhere.controller.start("t1");
  stoppedElsewhere.connect();
  // A stale snapshot for an older session is ignored.
  stoppedElsewhere.controller.observe(
    "t1",
    view({ voiceSessionId: "old", phase: "ended" }),
  );
  assert.equal(stoppedElsewhere.controller.getState().status, "connected");
  stoppedElsewhere.controller.observe(
    "t1",
    view({ phase: "ended", stoppedByClientId: "page-b" }),
  );
  assert.equal(stoppedElsewhere.controller.getState().status, "idle");
  assert.equal(stoppedElsewhere.media.closed, true);
  assert.match(
    stoppedElsewhere.controller.getState().error ?? "",
    /another device/,
  );

  const lost = harness();
  await lost.controller.start("t1");
  lost.fail();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lost.controller.getState().status, "idle");
  assert.ok(lost.calls.some((call) => call.startsWith("stop:t1:")));
});

test("only one voice call runs per page", async () => {
  const { controller, calls } = harness();
  await controller.start("t1");
  await controller.start("t2");
  assert.match(controller.getState().error ?? "", /another conversation/);
  assert.equal(controller.getState().threadId, "t1");
  assert.equal(calls.filter((call) => call.startsWith("start:")).length, 1);
});

test("voice session relation and ended descriptions", () => {
  assert.equal(voiceSessionRelation(null, "a"), "none");
  assert.equal(
    voiceSessionRelation(view({ ownerClientId: "a" }), "a"),
    "owned",
  );
  assert.equal(voiceSessionRelation(view(), "b"), "other-device");
  assert.equal(voiceSessionRelation(view({ phase: "ended" }), "a"), "ended");
  assert.equal(
    describeEndedVoiceSession(view({ phase: "failed", error: "boom" }), "a"),
    "boom",
  );
  assert.equal(
    describeEndedVoiceSession(
      view({ phase: "ended", closedReason: "transport_closed" }),
      "a",
    ),
    "Voice conversation ended: transport closed.",
  );
});

test("voice delegations render as their spoken input", () => {
  const text =
    "<realtime_delegation><context>x</context><input>fix the &lt;b&gt; tag &amp; tests</input></realtime_delegation>";
  assert.equal(
    getRealtimeDelegationDisplayText(text),
    "fix the <b> tag & tests",
  );
  assert.equal(sanitizeText(text), "fix the <b> tag & tests");
  assert.equal(getRealtimeDelegationDisplayText("plain"), null);
});

test("audio attachments accept upstream formats and require an audio-capable model", () => {
  assert.equal(
    audioAttachmentMimeType({ name: "a.m4a", type: "audio/x-m4a" }),
    "audio/mp4",
  );
  assert.equal(
    audioAttachmentMimeType({ name: "clip.webm", type: "" }),
    "audio/webm",
  );
  assert.equal(
    audioAttachmentMimeType({
      name: "rec.webm",
      type: "audio/webm;codecs=opus",
    }),
    "audio/webm",
  );
  assert.equal(
    audioAttachmentMimeType({ name: "a.flac", type: "audio/flac" }),
    null,
  );
  assert.equal(isAudioDataUrl("data:audio/webm;base64,AAA"), true);
  assert.equal(isAudioDataUrl("data:image/png;base64,AAA"), false);
  assert.equal(
    withAudioMimeType("data:audio/x-m4a;base64,AAA", "audio/mp4"),
    "data:audio/mp4;base64,AAA",
  );
  assert.equal(
    audioAttachmentUnavailableReason({
      id: "gpt",
      inputModalities: ["text", "audio"],
    }),
    null,
  );
  assert.match(
    audioAttachmentUnavailableReason({
      id: "gpt",
      displayName: "GPT",
      inputModalities: ["text", "image"],
    }) ?? "",
    /GPT does not accept audio input/,
  );
  assert.match(audioAttachmentUnavailableReason(null) ?? "", /Select a model/);
});

test("the composer voice button toggles like /voice for any model", () => {
  assert.deepEqual(describeVoiceToggle("idle"), {
    active: false,
    label: "Start voice conversation",
  });
  for (const status of ["preparing", "negotiating", "connected", "stopping"])
    assert.deepEqual(describeVoiceToggle(status), {
      active: true,
      label: "Stop voice conversation",
    });
});

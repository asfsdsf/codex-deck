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
  classifyMicrophoneError,
  classifyVoiceServiceError,
  deriveVoiceActivity,
  describeEndedVoiceSession,
  describeVoiceActivity,
  describeVoiceError,
  describeVoiceToggle,
  describeMicrophoneError,
  formatVoiceDuration,
  getRealtimeDelegationDisplayText,
  isAudioDataUrl,
  isVoiceMuteShortcut,
  parseVoiceCommandArgs,
  voiceMuteShortcutLabel,
  voiceSessionRelation,
  voiceUnavailableReason,
  withAudioMimeType,
  type VoiceActivityInput,
} from "../../web/voice/voice-support";
import {
  VOICE_SPEAKER_HOLD_MS,
  VoiceImpulseHistory,
  voiceMeterIntensity,
  voiceMeterLevel,
} from "../../web/voice/voice-impulse";
import { mergeVoiceHistory } from "../../web/voice/voice-history";
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
        levels() {
          return { input: 0.2, output: 0 };
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
  assert.equal(typeof controller.getState().connectedAt, "number");
  assert.deepEqual(controller.levels(), { input: 0.2, output: 0 });
  assert.equal(controller.toggleMute(), true);
  assert.equal(media.muted, true);
  assert.equal(controller.getState().muted, true);
  await controller.toggle("t1");
  assert.ok(calls.includes("stop:t1"));
  assert.equal(media.closed, true);
  assert.equal(controller.getState().status, "idle");
  assert.equal(controller.getState().connectedAt, null);
  assert.deepEqual(controller.levels(), { input: 0, output: 0 });
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
  assert.equal(denied.controller.getState().errorKind, "permission");
  assert.equal(denied.controller.getState().errorThreadId, "t1");
  assert.ok(!denied.calls.some((call) => call.startsWith("start:")));

  const insecure = harness({ env: { isSecureContext: false } });
  await insecure.controller.start("t1");
  assert.match(insecure.controller.getState().error ?? "", /HTTPS/);
  assert.equal(insecure.controller.getState().errorKind, "unsupported");
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
  assert.equal(lost.controller.getState().errorKind, "connection");
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
  assert.deepEqual(
    describeVoiceToggle({ status: "idle", threadId: null }, "t1"),
    {
      active: false,
      busy: false,
      elsewhere: false,
      label: "Start voice conversation",
    },
  );
  assert.deepEqual(
    describeVoiceToggle({ status: "connected", threadId: "t1" }, "t1"),
    {
      active: true,
      busy: false,
      elsewhere: false,
      label: "End voice conversation",
    },
  );
  for (const status of ["preparing", "negotiating"])
    assert.equal(
      describeVoiceToggle({ status, threadId: "t1" }, "t1").label,
      "Cancel voice connection",
    );
  assert.equal(
    describeVoiceToggle({ status: "stopping", threadId: "t1" }, "t1").busy,
    true,
  );
  // Like /voice, pressing it in another conversation ends this page's call,
  // so it says so.
  assert.deepEqual(
    describeVoiceToggle({ status: "connected", threadId: "t1" }, "t2"),
    {
      active: true,
      busy: false,
      elsewhere: true,
      label: "End voice in the other conversation",
    },
  );
});

test("voice impulse uses the TUI meter calibration", () => {
  // i16 peaks: 512 is the noise floor, 8192 is full scale.
  assert.equal(voiceMeterIntensity(0), 0);
  assert.equal(voiceMeterIntensity(512 / 32768), 0);
  assert.equal(voiceMeterIntensity(8192 / 32768), 1);
  assert.equal(voiceMeterIntensity(1), 1);
  assert.equal(voiceMeterLevel(600 / 32768), 1);
  assert.equal(voiceMeterLevel(8192 / 32768), 5);

  const history = new VoiceImpulseHistory(4);
  let activity = history.push(0.1, 0, false, 1_000);
  assert.equal(activity.userSpeaking, true);
  assert.equal(activity.codexSpeaking, false);
  activity = history.push(0, 0.2, false, 1_100);
  // Speech is held briefly so the headline does not flicker between words.
  assert.equal(activity.userSpeaking, true);
  assert.equal(activity.codexSpeaking, true);
  activity = history.push(0, 0, false, 1_100 + VOICE_SPEAKER_HOLD_MS);
  assert.equal(activity.userSpeaking, false);
  assert.equal(activity.codexSpeaking, false);
  assert.equal(history.mic.length, 4);
  assert.ok(history.mic[1] > 0);

  // Muted: the mic line is flat, but talking is noticed for the hint.
  activity = history.push(0.1, 0, true, 5_000);
  assert.equal(history.mic.at(-1), 0);
  assert.equal(activity.userSpeaking, false);
  assert.equal(activity.mutedSpeech, true);
});

test("voice activity names one headline state", () => {
  const base: VoiceActivityInput = {
    status: "connected",
    muted: false,
    userSpeaking: false,
    codexSpeaking: false,
    transcript: [],
    working: false,
    lastEntryAgeMs: null,
  };
  const entry = (role: string, final: boolean) => ({
    id: role,
    role,
    text: "hi",
    final,
    at: 1,
  });
  assert.equal(deriveVoiceActivity(base), "listening");
  assert.equal(
    deriveVoiceActivity({ ...base, status: "preparing" }),
    "requesting-microphone",
  );
  assert.equal(
    deriveVoiceActivity({ ...base, status: "negotiating" }),
    "connecting",
  );
  assert.equal(
    deriveVoiceActivity({ ...base, muted: true, codexSpeaking: true }),
    "muted",
  );
  assert.equal(
    deriveVoiceActivity({ ...base, userSpeaking: true, codexSpeaking: true }),
    "hearing-you",
  );
  assert.equal(
    deriveVoiceActivity({ ...base, codexSpeaking: true }),
    "speaking",
  );
  // Other devices have no levels; partial captions stand in for them.
  assert.equal(
    deriveVoiceActivity({
      ...base,
      status: "remote",
      transcript: [entry("assistant", false)],
    }),
    "speaking",
  );
  assert.equal(deriveVoiceActivity({ ...base, working: true }), "working");
  assert.equal(
    deriveVoiceActivity({
      ...base,
      transcript: [entry("user", true)],
      lastEntryAgeMs: 1_000,
    }),
    "thinking",
  );
  assert.equal(
    deriveVoiceActivity({
      ...base,
      transcript: [entry("user", true)],
      lastEntryAgeMs: 60_000,
    }),
    "listening",
  );
  assert.match(
    describeVoiceActivity("muted", { shortcut: "⌥M" }).hint,
    /⌥M to unmute/,
  );
  assert.match(
    describeVoiceActivity("muted", { shortcut: "⌥M", mutedSpeech: true }).hint,
    /You're muted/,
  );
});

test("voice errors say what to do next", () => {
  const named = (name: string) => Object.assign(new Error("x"), { name });
  assert.equal(classifyMicrophoneError(named("NotAllowedError")), "permission");
  assert.equal(
    classifyMicrophoneError(named("NotFoundError")),
    "no-microphone",
  );
  assert.equal(
    classifyMicrophoneError(named("NotReadableError")),
    "microphone-busy",
  );
  assert.equal(
    classifyVoiceServiceError(
      "This Codex version does not support realtime voice.",
    ),
    "unsupported",
  );
  assert.equal(
    classifyVoiceServiceError(
      "A voice session is already active for this conversation on another device.",
    ),
    "conflict",
  );
  assert.equal(classifyVoiceServiceError("boom"), "service");
  assert.deepEqual(describeVoiceError("no-microphone"), {
    title: "No microphone found",
    retry: true,
    chooseMicrophone: true,
  });
  assert.equal(describeVoiceError("unsupported").retry, false);
  assert.doesNotMatch(
    describeMicrophoneError(named("NotAllowedError")),
    /\/voice/,
  );
});

test("voice mute shortcut matches the TUI's F9 and Alt/Option+M", () => {
  const key = (patch: Partial<Parameters<typeof isVoiceMuteShortcut>[0]>) => ({
    key: "",
    code: "",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...patch,
  });
  assert.equal(isVoiceMuteShortcut(key({ key: "F9", code: "F9" })), true);
  assert.equal(
    isVoiceMuteShortcut(key({ key: "µ", code: "KeyM", altKey: true })),
    true,
  );
  assert.equal(isVoiceMuteShortcut(key({ key: "m", code: "KeyM" })), false);
  assert.equal(
    isVoiceMuteShortcut(
      key({ key: "m", code: "KeyM", altKey: true, metaKey: true }),
    ),
    false,
  );
  assert.equal(
    isVoiceMuteShortcut(key({ key: "F9", code: "F9", isComposing: true })),
    false,
  );
  assert.equal(voiceMuteShortcutLabel("MacIntel"), "⌥M");
  assert.equal(voiceMuteShortcutLabel("Win32"), "Alt+M");
  assert.equal(formatVoiceDuration(83_400), "1:23");
  assert.equal(formatVoiceDuration(3_723_000), "1:02:03");
});

test("voice history merges saved and live captions with speaker roles", () => {
  const merged = mergeVoiceHistory(
    [
      {
        realtimeSessionId: "r1",
        eventId: "e2",
        observedAtMs: 20,
        kind: "handoff",
        mode: "start",
        text: "fix the tests",
      } as never,
    ],
    [
      {
        id: "live-1",
        eventId: "e1",
        realtimeSessionId: "r1",
        role: "user",
        text: "please fix the tests",
        final: false,
        at: 10,
      },
    ],
  );
  assert.deepEqual(
    merged.map((entry) => [entry.role, entry.label, entry.pending]),
    [
      ["user", "You", true],
      ["note", "Started a turn", false],
    ],
  );
});

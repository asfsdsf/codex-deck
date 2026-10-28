import { randomUUID } from "node:crypto";
import { nativeRecord, type NativeRpc } from "./codex-native";

/**
 * Thread-scoped realtime voice sessions bridged from `thread/realtime/*`.
 *
 * Deck uses the WebRTC transport: the owning browser creates the SDP offer
 * (microphone track + the `oai-events` data channel), Deck relays it through
 * `thread/realtime/start`, and the answer comes back as `thread/realtime/sdp`.
 * Media never flows through Deck, so the same path works for local SSE and for
 * the encrypted remote relay. Only the page that started a session owns its
 * media; every other page sees the shared state through `native_state_changed`
 * broadcasts (scope `voice`) and may stop it, matching upstream where
 * `thread/realtime/stop` is a thread-level operation.
 */

export type RealtimeVoicePhase =
  | "starting"
  | "active"
  | "stopping"
  | "ended"
  | "failed";

export interface RealtimeTranscriptEntry {
  id: string;
  role: string;
  text: string;
  final: boolean;
  at: number;
}

export interface RealtimeVoiceSessionView {
  threadId: string;
  voiceSessionId: string;
  /** Browser page that owns the media; null when started outside this Deck. */
  ownerClientId: string | null;
  phase: RealtimeVoicePhase;
  voice: string | null;
  realtimeSessionId: string | null;
  version: string | null;
  startedAt: number;
  updatedAt: number;
  error: string | null;
  closedReason: string | null;
  stoppedByClientId: string | null;
  transcript: RealtimeTranscriptEntry[];
  revision: number;
}

export interface RealtimeVoiceSnapshot {
  session: RealtimeVoiceSessionView | null;
  /** Remote SDP answer; only returned to the owning page. */
  answerSdp: string | null;
}

export interface RealtimeVoiceCatalog {
  voices: string[];
  defaultVoice: string | null;
  /** Value of `realtime.voice` in the effective config, if any. */
  configuredVoice: string | null;
}

export interface RealtimeVoiceStartInput {
  clientId: string;
  sdp: string;
  voice?: string | null;
}

export class RealtimeVoiceError extends Error {
  public readonly status: 400 | 403 | 404 | 409 | 501;
  public constructor(message: string, status: 400 | 403 | 404 | 409 | 501) {
    super(message);
    this.name = "RealtimeVoiceError";
    this.status = status;
  }
}

export interface RealtimeVoiceManagerOptions {
  rpc: NativeRpc;
  threadRpc: (
    method: string,
    params: Record<string, unknown>,
    threadId: string,
  ) => Promise<unknown>;
  notify: (threadId: string) => void;
  now?: () => number;
  answerTimeoutMs?: number;
  ownerTimeoutMs?: number;
  stopTimeoutMs?: number;
  notifyThrottleMs?: number;
}

interface SessionRecord {
  view: RealtimeVoiceSessionView;
  answerSdp: string | null;
  answerWaiters: Array<(error: Error | null) => void>;
  ownerTimer: ReturnType<typeof setTimeout> | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
}

const MAX_SDP_LENGTH = 128 * 1024;
const MAX_TRANSCRIPT_ENTRIES = 200;
const MAX_TRANSCRIPT_TEXT = 8_000;
const MAX_TRACKED_THREADS = 32;
const VOICE_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;

export function isLiveRealtimePhase(phase: RealtimeVoicePhase): boolean {
  return phase === "starting" || phase === "active" || phase === "stopping";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMethodNotFound(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === -32601
  );
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function validateRealtimeOfferSdp(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new RealtimeVoiceError("An SDP offer is required.", 400);
  if (value.length > MAX_SDP_LENGTH)
    throw new RealtimeVoiceError("The SDP offer is too large.", 400);
  if (!value.trimStart().startsWith("v=0"))
    throw new RealtimeVoiceError("The SDP offer is malformed.", 400);
  if (!/^m=audio /m.test(value))
    throw new RealtimeVoiceError(
      "The SDP offer must include a microphone audio track.",
      400,
    );
  if (!/^m=application /m.test(value))
    throw new RealtimeVoiceError(
      "The SDP offer must include the realtime events data channel.",
      400,
    );
  return value;
}

export function validateRealtimeVoiceName(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !VOICE_NAME_PATTERN.test(value))
    throw new RealtimeVoiceError("Invalid voice name.", 400);
  return value;
}

/** Parse `thread/realtime/listVoices`; V3 voices fall back to V1 (shared catalog). */
export function parseRealtimeVoices(
  value: unknown,
): Omit<RealtimeVoiceCatalog, "configuredVoice"> {
  const voices = nativeRecord(nativeRecord(value).voices);
  const list = (entry: unknown) =>
    Array.isArray(entry)
      ? entry.filter(
          (voice): voice is string =>
            typeof voice === "string" && VOICE_NAME_PATTERN.test(voice),
        )
      : [];
  const v3 = list(voices.v3);
  const catalog = v3.length > 0 ? v3 : list(voices.v1);
  if (catalog.length === 0)
    throw new Error("Invalid thread/realtime/listVoices response");
  const defaultVoice = stringField(voices.defaultV1);
  return {
    voices: [...new Set(catalog)],
    defaultVoice:
      defaultVoice && catalog.includes(defaultVoice) ? defaultVoice : null,
  };
}

export class RealtimeVoiceManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly pendingNotify = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly options: Required<
    Omit<RealtimeVoiceManagerOptions, "rpc" | "threadRpc" | "notify">
  > &
    Pick<RealtimeVoiceManagerOptions, "rpc" | "threadRpc" | "notify">;

  public constructor(options: RealtimeVoiceManagerOptions) {
    this.options = {
      now: () => Date.now(),
      answerTimeoutMs: 10_000,
      ownerTimeoutMs: 60_000,
      stopTimeoutMs: 8_000,
      notifyThrottleMs: 150,
      ...options,
    };
  }

  public async listVoices(
    threadId?: string | null,
  ): Promise<RealtimeVoiceCatalog> {
    let response: unknown;
    try {
      response = await this.options.rpc("thread/realtime/listVoices", {});
    } catch (error) {
      if (isMethodNotFound(error))
        throw new RealtimeVoiceError(
          "This Codex version does not support realtime voice.",
          501,
        );
      throw error;
    }
    const catalog = parseRealtimeVoices(response);
    return {
      ...catalog,
      configuredVoice: await this.readConfiguredVoice(threadId),
    };
  }

  public async setVoice(
    voice: string | null,
    threadId?: string | null,
  ): Promise<RealtimeVoiceCatalog & { warning: string | null }> {
    const normalized = validateRealtimeVoiceName(voice);
    if (normalized) {
      const catalog = parseRealtimeVoices(
        await this.options.rpc("thread/realtime/listVoices", {}),
      );
      if (!catalog.voices.includes(normalized))
        throw new RealtimeVoiceError(
          `The server does not offer the voice ${normalized}.`,
          400,
        );
    }
    const response = nativeRecord(
      await this.options.rpc("config/batchWrite", {
        edits: [
          {
            keyPath: "realtime.voice",
            value: normalized,
            mergeStrategy: "replace",
          },
        ],
        reloadUserConfig: true,
      }),
    );
    const readback = await this.listVoices(threadId);
    const overridden =
      response.status === "okOverridden" ||
      (normalized !== null && readback.configuredVoice !== normalized);
    for (const id of this.sessions.keys()) this.notifySoon(id, true);
    return {
      ...readback,
      warning: overridden
        ? "The voice was saved, but higher-priority configuration overrides it."
        : null,
    };
  }

  private async readConfiguredVoice(
    threadId?: string | null,
  ): Promise<string | null> {
    let cwd: string | null = null;
    if (threadId) {
      try {
        const thread = nativeRecord(
          nativeRecord(
            await this.options.rpc("thread/read", {
              threadId,
              includeTurns: false,
            }),
          ).thread,
        );
        cwd = stringField(thread.cwd);
      } catch {
        cwd = null;
      }
    }
    const config = nativeRecord(
      nativeRecord(
        await this.options.rpc("config/read", {
          includeLayers: false,
          ...(cwd ? { cwd } : {}),
        }),
      ).config,
    );
    const realtime = config.realtime;
    if (!realtime || typeof realtime !== "object") return null;
    const voice = (realtime as Record<string, unknown>).voice;
    return typeof voice === "string" && VOICE_NAME_PATTERN.test(voice)
      ? voice
      : null;
  }

  public snapshot(
    threadId: string,
    clientId?: string | null,
  ): RealtimeVoiceSnapshot {
    const record = this.sessions.get(threadId);
    if (!record) return { session: null, answerSdp: null };
    const owner =
      !!clientId &&
      record.view.ownerClientId === clientId &&
      isLiveRealtimePhase(record.view.phase);
    return {
      session: this.cloneView(record.view),
      answerSdp: owner ? record.answerSdp : null,
    };
  }

  public async start(
    threadId: string,
    input: RealtimeVoiceStartInput,
  ): Promise<RealtimeVoiceSnapshot> {
    const clientId = input.clientId?.trim();
    if (!threadId.trim())
      throw new RealtimeVoiceError("A conversation is required.", 400);
    if (!clientId)
      throw new RealtimeVoiceError("A client ID is required.", 400);
    const sdp = validateRealtimeOfferSdp(input.sdp);
    const voice = validateRealtimeVoiceName(input.voice);
    const existing = this.sessions.get(threadId);
    if (existing && isLiveRealtimePhase(existing.view.phase)) {
      throw new RealtimeVoiceError(
        existing.view.ownerClientId === clientId
          ? "This page already has a voice session for this conversation."
          : "A voice session is already active for this conversation on another device.",
        409,
      );
    }
    for (const other of this.sessions.values()) {
      if (
        other.view.ownerClientId === clientId &&
        isLiveRealtimePhase(other.view.phase)
      )
        throw new RealtimeVoiceError(
          "This page already has a voice session in another conversation. Stop it first.",
          409,
        );
    }
    if (existing) this.dispose(existing);
    const now = this.options.now();
    const record: SessionRecord = {
      view: {
        threadId,
        voiceSessionId: randomUUID(),
        ownerClientId: clientId,
        phase: "starting",
        voice,
        realtimeSessionId: null,
        version: null,
        startedAt: now,
        updatedAt: now,
        error: null,
        closedReason: null,
        stoppedByClientId: null,
        transcript: [],
        revision: 1,
      },
      answerSdp: null,
      answerWaiters: [],
      ownerTimer: null,
      stopTimer: null,
    };
    this.sessions.delete(threadId);
    this.sessions.set(threadId, record);
    this.pruneTracked();
    this.armOwnerTimer(record);
    this.notifySoon(threadId, true);
    try {
      await this.options.threadRpc(
        "thread/realtime/start",
        {
          threadId,
          outputModality: "audio",
          version: "v3",
          includeStartupContext: false,
          voiceSessionId: record.view.voiceSessionId,
          transport: { type: "webrtc", sdp },
          ...(voice ? { voice } : {}),
        },
        threadId,
      );
    } catch (error) {
      const message = isMethodNotFound(error)
        ? "This Codex version does not support realtime voice."
        : `Failed to start voice: ${errorMessage(error)}`;
      if (this.sessions.get(threadId) === record)
        this.finish(record, "failed", { error: message });
      if (isMethodNotFound(error)) throw new RealtimeVoiceError(message, 501);
      throw new Error(message);
    }
    await this.waitForAnswer(record);
    return this.snapshot(threadId, clientId);
  }

  private waitForAnswer(record: SessionRecord): Promise<void> {
    if (record.answerSdp || !isLiveRealtimePhase(record.view.phase)) {
      return record.view.phase === "failed"
        ? Promise.reject(
            new Error(record.view.error || "Voice failed to start."),
          )
        : Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        record.answerWaiters = record.answerWaiters.filter(
          (waiter) => waiter !== settle,
        );
        // The page keeps polling the snapshot for a late answer.
        resolve();
      }, this.options.answerTimeoutMs);
      timer.unref?.();
      const settle = (error: Error | null) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      record.answerWaiters.push(settle);
    });
  }

  public heartbeat(threadId: string, clientId: string): RealtimeVoiceSnapshot {
    const record = this.sessions.get(threadId);
    if (!record || !isLiveRealtimePhase(record.view.phase))
      return this.snapshot(threadId, clientId);
    if (record.view.ownerClientId !== clientId)
      throw new RealtimeVoiceError(
        "This page does not own the voice session.",
        403,
      );
    this.armOwnerTimer(record);
    return this.snapshot(threadId, clientId);
  }

  public async stop(
    threadId: string,
    clientId: string | null,
    options: { error?: string | null; reason?: string | null } = {},
  ): Promise<RealtimeVoiceSnapshot> {
    const record = this.sessions.get(threadId);
    if (!record || !isLiveRealtimePhase(record.view.phase)) {
      return this.snapshot(threadId, clientId);
    }
    if (record.view.phase !== "stopping") {
      record.view.phase = "stopping";
      record.view.stoppedByClientId = clientId;
      if (options.error) record.view.error = options.error.slice(0, 500);
      if (options.reason) record.view.closedReason = options.reason;
      this.finishPartialTranscripts(record);
      this.touch(record);
      this.notifySoon(threadId, true);
    }
    this.rejectAnswerWaiters(
      record,
      new Error(options.error || "Voice was stopped."),
    );
    if (!record.stopTimer) {
      record.stopTimer = setTimeout(() => {
        record.stopTimer = null;
        if (
          this.sessions.get(threadId) === record &&
          record.view.phase === "stopping"
        )
          this.finish(record, options.error ? "failed" : "ended", {
            closedReason: record.view.closedReason || "requested",
          });
      }, this.options.stopTimeoutMs);
      record.stopTimer.unref?.();
    }
    try {
      await this.options.threadRpc(
        "thread/realtime/stop",
        { threadId },
        threadId,
      );
    } catch (error) {
      // The backend may already have closed the call; the session is over.
      if (
        this.sessions.get(threadId) === record &&
        isLiveRealtimePhase(record.view.phase)
      )
        this.finish(record, options.error ? "failed" : "ended", {
          closedReason: record.view.closedReason || "requested",
        });
      if (isMethodNotFound(error))
        throw new RealtimeVoiceError(
          "This Codex version does not support realtime voice.",
          501,
        );
    }
    return this.snapshot(threadId, clientId);
  }

  /** Returns true when the notification belongs to realtime voice. */
  public handleNotification(method: string, params: unknown): boolean {
    if (
      method === "thread/closed" ||
      method === "thread/archived" ||
      method === "thread/deleted"
    ) {
      const threadId = stringField(
        (params as Record<string, unknown> | null)?.threadId,
      );
      const record = threadId ? this.sessions.get(threadId) : undefined;
      if (record && isLiveRealtimePhase(record.view.phase))
        this.finish(record, "ended", { closedReason: "conversation closed" });
      return false;
    }
    if (!method.startsWith("thread/realtime/")) return false;
    const value =
      params && typeof params === "object"
        ? (params as Record<string, unknown>)
        : {};
    const threadId = stringField(value.threadId);
    if (!threadId) return true;
    let record = this.sessions.get(threadId);
    switch (method) {
      case "thread/realtime/started": {
        if (!record || !isLiveRealtimePhase(record.view.phase)) {
          // Started by another client of a shared app-server.
          record = this.adoptExternal(threadId);
        }
        record.view.realtimeSessionId =
          stringField(value.realtimeSessionId) ?? record.view.realtimeSessionId;
        record.view.version = stringField(value.version) ?? record.view.version;
        if (record.view.phase === "starting") record.view.phase = "active";
        this.touch(record);
        this.notifySoon(threadId, true);
        return true;
      }
      case "thread/realtime/sdp": {
        const sdp = stringField(value.sdp);
        if (!record || !sdp || !isLiveRealtimePhase(record.view.phase))
          return true;
        record.answerSdp = sdp;
        for (const waiter of record.answerWaiters.splice(0)) waiter(null);
        this.notifySoon(threadId, true);
        return true;
      }
      case "thread/realtime/transcript/delta": {
        const delta = typeof value.delta === "string" ? value.delta : "";
        const role = stringField(value.role) ?? "assistant";
        if (!record || !delta || !isLiveRealtimePhase(record.view.phase))
          return true;
        this.appendTranscript(record, role, delta, false);
        return true;
      }
      case "thread/realtime/transcript/done": {
        const text = typeof value.text === "string" ? value.text : "";
        const role = stringField(value.role) ?? "assistant";
        if (!record) return true;
        this.appendTranscript(record, role, text, true);
        return true;
      }
      case "thread/realtime/error": {
        const message =
          stringField(value.message) ?? "Voice conversation failed.";
        if (!record || !isLiveRealtimePhase(record.view.phase)) return true;
        record.view.error = message.slice(0, 500);
        this.rejectAnswerWaiters(record, new Error(message));
        // Mirror the TUI: an error ends the call, so release the backend too.
        void this.options
          .threadRpc("thread/realtime/stop", { threadId }, threadId)
          .catch(() => {});
        this.finish(record, "failed", { closedReason: "error" });
        return true;
      }
      case "thread/realtime/closed": {
        if (!record || !isLiveRealtimePhase(record.view.phase)) return true;
        const reason = stringField(value.reason);
        const failed =
          record.view.error !== null ||
          (record.view.phase !== "stopping" &&
            (reason === null ||
              reason === "transport_closed" ||
              reason === "error"));
        this.finish(record, failed ? "failed" : "ended", {
          closedReason: record.view.closedReason || reason || "closed",
          ...(failed && !record.view.error
            ? {
                error: `Voice conversation ended: ${reason || "connection closed"}`,
              }
            : {}),
        });
        return true;
      }
      default:
        // item/*, itemAdded and outputAudio/delta (websocket transport only)
        // are not needed for the WebRTC transcript view.
        return true;
    }
  }

  /** The app-server process went away; no realtime call survives that. */
  public resetAll(reason: string): void {
    for (const record of this.sessions.values()) {
      if (isLiveRealtimePhase(record.view.phase))
        this.finish(record, "failed", { error: reason, closedReason: "error" });
    }
  }

  private adoptExternal(threadId: string): SessionRecord {
    const previous = this.sessions.get(threadId);
    if (previous) this.dispose(previous);
    const now = this.options.now();
    const record: SessionRecord = {
      view: {
        threadId,
        voiceSessionId: randomUUID(),
        ownerClientId: null,
        phase: "starting",
        voice: null,
        realtimeSessionId: null,
        version: null,
        startedAt: now,
        updatedAt: now,
        error: null,
        closedReason: null,
        stoppedByClientId: null,
        transcript: [],
        revision: 1,
      },
      answerSdp: null,
      answerWaiters: [],
      ownerTimer: null,
      stopTimer: null,
    };
    this.sessions.delete(threadId);
    this.sessions.set(threadId, record);
    this.pruneTracked();
    return record;
  }

  private appendTranscript(
    record: SessionRecord,
    role: string,
    text: string,
    final: boolean,
  ) {
    const transcript = record.view.transcript;
    let target: RealtimeTranscriptEntry | undefined;
    // Duplex chunks can interleave, so look back past the other speaker.
    for (
      let index = transcript.length - 1;
      index >= Math.max(0, transcript.length - 4);
      index--
    ) {
      const entry = transcript[index];
      if (!entry.final && entry.role === role) {
        target = entry;
        break;
      }
    }
    if (final) {
      if (target) {
        if (text.trim()) target.text = text.slice(0, MAX_TRANSCRIPT_TEXT);
        target.final = true;
        if (!target.text.trim())
          record.view.transcript = transcript.filter(
            (entry) => entry !== target,
          );
      } else if (text.trim()) {
        transcript.push({
          id: randomUUID(),
          role,
          text: text.slice(0, MAX_TRANSCRIPT_TEXT),
          final: true,
          at: this.options.now(),
        });
      } else return;
    } else if (target) {
      target.text = (target.text + text).slice(0, MAX_TRANSCRIPT_TEXT);
    } else {
      transcript.push({
        id: randomUUID(),
        role,
        text: text.slice(0, MAX_TRANSCRIPT_TEXT),
        final: false,
        at: this.options.now(),
      });
    }
    if (record.view.transcript.length > MAX_TRANSCRIPT_ENTRIES)
      record.view.transcript.splice(
        0,
        record.view.transcript.length - MAX_TRANSCRIPT_ENTRIES,
      );
    this.touch(record);
    this.notifySoon(record.view.threadId, final);
  }

  private finishPartialTranscripts(record: SessionRecord) {
    record.view.transcript = record.view.transcript.filter(
      (entry) => entry.final || entry.text.trim(),
    );
    for (const entry of record.view.transcript) entry.final = true;
  }

  private finish(
    record: SessionRecord,
    phase: "ended" | "failed",
    details: { error?: string; closedReason?: string } = {},
  ) {
    if (details.error) record.view.error = details.error.slice(0, 500);
    if (details.closedReason) record.view.closedReason = details.closedReason;
    record.view.phase = phase;
    record.answerSdp = null;
    this.finishPartialTranscripts(record);
    this.rejectAnswerWaiters(
      record,
      new Error(record.view.error || "Voice conversation ended."),
    );
    this.clearTimers(record);
    this.touch(record);
    this.notifySoon(record.view.threadId, true);
  }

  private rejectAnswerWaiters(record: SessionRecord, error: Error) {
    for (const waiter of record.answerWaiters.splice(0)) waiter(error);
  }

  private armOwnerTimer(record: SessionRecord) {
    if (record.ownerTimer) clearTimeout(record.ownerTimer);
    if (!record.view.ownerClientId) return;
    record.ownerTimer = setTimeout(() => {
      record.ownerTimer = null;
      if (
        this.sessions.get(record.view.threadId) === record &&
        isLiveRealtimePhase(record.view.phase) &&
        record.view.phase !== "stopping"
      )
        void this.stop(record.view.threadId, null, {
          error: "The device running voice stopped responding.",
          reason: "owner_timeout",
        }).catch(() => {});
    }, this.options.ownerTimeoutMs);
    record.ownerTimer.unref?.();
  }

  private clearTimers(record: SessionRecord) {
    if (record.ownerTimer) clearTimeout(record.ownerTimer);
    if (record.stopTimer) clearTimeout(record.stopTimer);
    record.ownerTimer = null;
    record.stopTimer = null;
  }

  private dispose(record: SessionRecord) {
    this.clearTimers(record);
    this.rejectAnswerWaiters(record, new Error("Voice session replaced."));
  }

  private pruneTracked() {
    while (this.sessions.size > MAX_TRACKED_THREADS) {
      const oldest = [...this.sessions.entries()].find(
        ([, record]) => !isLiveRealtimePhase(record.view.phase),
      );
      if (!oldest) return;
      this.dispose(oldest[1]);
      this.sessions.delete(oldest[0]);
    }
  }

  private touch(record: SessionRecord) {
    record.view.updatedAt = this.options.now();
    record.view.revision += 1;
  }

  private cloneView(view: RealtimeVoiceSessionView): RealtimeVoiceSessionView {
    return {
      ...view,
      transcript: view.transcript.map((entry) => ({ ...entry })),
    };
  }

  /** Coalesce transcript deltas; lifecycle changes are broadcast immediately. */
  private notifySoon(threadId: string, immediate = false) {
    const pending = this.pendingNotify.get(threadId);
    if (immediate || this.options.notifyThrottleMs <= 0) {
      if (pending) clearTimeout(pending);
      this.pendingNotify.delete(threadId);
      this.options.notify(threadId);
      return;
    }
    if (pending) return;
    const timer = setTimeout(() => {
      this.pendingNotify.delete(threadId);
      this.options.notify(threadId);
    }, this.options.notifyThrottleMs);
    timer.unref?.();
    this.pendingNotify.set(threadId, timer);
  }
}

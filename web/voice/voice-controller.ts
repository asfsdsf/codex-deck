import type {
  RealtimeVoiceSessionView,
  RealtimeVoiceSnapshot,
} from "@codex-deck/api";
import {
  getVoiceSnapshot,
  sendVoiceHeartbeat,
  startVoiceSession,
  stopVoiceSession,
} from "./voice-api";
import {
  browserVoiceMediaFactory,
  readPreferredMicrophone,
  type VoiceMediaFactory,
  type VoiceMediaSession,
} from "./voice-media";
import {
  describeEndedVoiceSession,
  describeMicrophoneError,
  isLiveVoicePhase,
  readVoiceEnvironment,
  voiceUnavailableReason,
  type VoiceEnvironment,
} from "./voice-support";

export type VoiceLocalStatus =
  | "idle"
  | "preparing"
  | "negotiating"
  | "connected"
  | "stopping";

export interface VoiceLocalState {
  /** Conversation whose voice media this page owns (null when idle). */
  threadId: string | null;
  status: VoiceLocalStatus;
  muted: boolean;
  playbackBlocked: boolean;
  error: string | null;
  errorThreadId: string | null;
}

export interface VoiceControllerDeps {
  clientId: string;
  api: {
    start: typeof startVoiceSession;
    stop: typeof stopVoiceSession;
    heartbeat: typeof sendVoiceHeartbeat;
    snapshot: typeof getVoiceSnapshot;
  };
  media: VoiceMediaFactory;
  environment: () => VoiceEnvironment;
  microphone: () => string | null;
  heartbeatMs?: number;
  answerPollMs?: number;
  answerTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const IDLE: VoiceLocalState = {
  threadId: null,
  status: "idle",
  muted: false,
  playbackBlocked: false,
  error: null,
  errorThreadId: null,
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One voice call per page. The page that starts a session owns its media and
 * keeps it alive across conversation switches; every page reconciles with
 * the shared server snapshot so a stop from another device tears media down.
 */
export class VoiceController {
  private state: VoiceLocalState = IDLE;
  private readonly listeners = new Set<() => void>();
  private media: VoiceMediaSession | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private voiceSessionId: string | null = null;
  private readonly deps: Required<VoiceControllerDeps>;

  public constructor(deps: VoiceControllerDeps) {
    this.deps = {
      heartbeatMs: 10_000,
      answerPollMs: 750,
      answerTimeoutMs: 20_000,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      ...deps,
    };
  }

  public get clientId(): string {
    return this.deps.clientId;
  }

  public getState = (): VoiceLocalState => this.state;

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private setState(patch: Partial<VoiceLocalState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  public unavailableReason(): string | null {
    return voiceUnavailableReason(this.deps.environment());
  }

  public clearError() {
    if (this.state.error) this.setState({ error: null, errorThreadId: null });
  }

  /** `/voice`: stop when this page runs voice, otherwise start for threadId. */
  public async toggle(threadId: string): Promise<void> {
    if (this.state.status !== "idle") {
      await this.stop();
      return;
    }
    await this.start(threadId);
  }

  public async start(threadId: string): Promise<void> {
    if (this.state.status !== "idle") {
      this.fail(
        threadId,
        this.state.threadId === threadId
          ? "Voice is already running for this conversation."
          : "Voice is running in another conversation. Stop it first.",
        false,
      );
      return;
    }
    const unavailable = this.unavailableReason();
    if (unavailable) {
      this.fail(threadId, unavailable, false);
      return;
    }
    const generation = ++this.generation;
    this.setState({
      ...IDLE,
      threadId,
      status: "preparing",
    });
    let media: VoiceMediaSession;
    try {
      media = await this.deps.media.create(
        { microphoneId: this.deps.microphone() },
        {
          onConnectionState: (connection) => {
            if (generation !== this.generation) return;
            if (connection === "connected")
              this.setState({ status: "connected" });
            else if (connection === "failed" || connection === "closed")
              void this.abandon(
                generation,
                connection === "failed"
                  ? "The voice connection failed. Check your network and try /voice again."
                  : "The voice connection closed.",
              );
          },
          onPlaybackBlocked: (blocked) => {
            if (generation === this.generation)
              this.setState({ playbackBlocked: blocked });
          },
        },
      );
    } catch (error) {
      if (generation === this.generation)
        this.fail(threadId, describeMicrophoneError(error));
      return;
    }
    if (generation !== this.generation) {
      media.close();
      return;
    }
    this.media = media;
    this.setState({ status: "negotiating" });
    let snapshot: RealtimeVoiceSnapshot;
    try {
      snapshot = await this.deps.api.start(threadId, {
        clientId: this.deps.clientId,
        sdp: media.offerSdp,
      });
    } catch (error) {
      if (generation === this.generation) this.fail(threadId, message(error));
      return;
    }
    if (generation !== this.generation) return;
    this.voiceSessionId = snapshot.session?.voiceSessionId ?? null;
    this.startHeartbeat(threadId, generation);
    let answer = snapshot.answerSdp;
    const deadline = Date.now() + this.deps.answerTimeoutMs;
    while (!answer && generation === this.generation) {
      if (snapshot.session && !isLiveVoicePhase(snapshot.session.phase)) {
        this.fail(
          threadId,
          describeEndedVoiceSession(snapshot.session, this.deps.clientId),
        );
        return;
      }
      if (Date.now() > deadline) {
        await this.abandon(
          generation,
          "Timed out waiting for the voice service to answer.",
        );
        return;
      }
      await this.deps.sleep(this.deps.answerPollMs);
      if (generation !== this.generation) return;
      try {
        snapshot = await this.deps.api.snapshot(threadId, this.deps.clientId);
        answer = snapshot.answerSdp;
      } catch {
        // keep polling until the deadline
      }
    }
    if (!answer || generation !== this.generation) return;
    try {
      await media.applyAnswer(answer);
    } catch (error) {
      await this.abandon(
        generation,
        `Could not connect voice: ${message(error)}`,
      );
    }
  }

  /** Stop the session this page owns. */
  public async stop(): Promise<void> {
    const threadId = this.state.threadId;
    if (!threadId || this.state.status === "idle") return;
    const generation = this.generation;
    this.setState({ status: "stopping" });
    try {
      await this.deps.api.stop(threadId, this.deps.clientId);
    } catch {
      // the server snapshot reconciles the final state
    }
    if (generation === this.generation) this.teardown();
  }

  /** Stop a session in threadId, including one owned by another device. */
  public async stopThread(threadId: string): Promise<void> {
    if (this.state.threadId === threadId && this.state.status !== "idle") {
      await this.stop();
      return;
    }
    try {
      await this.deps.api.stop(threadId, this.deps.clientId);
    } catch (error) {
      this.fail(threadId, message(error), false);
    }
  }

  public toggleMute(): boolean {
    if (!this.media || this.state.status === "idle") return false;
    const muted = !this.state.muted;
    this.media.setMuted(muted);
    this.setState({ muted });
    return true;
  }

  public async resumePlayback(): Promise<void> {
    await this.media?.resumePlayback();
  }

  /** Reconcile with the shared snapshot for threadId. */
  public observe(threadId: string, session: RealtimeVoiceSessionView | null) {
    if (
      this.state.threadId !== threadId ||
      this.state.status === "idle" ||
      this.state.status === "preparing"
    )
      return;
    // Until the start request returns, snapshots describe older sessions.
    if (!session || !this.voiceSessionId) return;
    if (session.voiceSessionId !== this.voiceSessionId) {
      if (isLiveVoicePhase(session.phase))
        this.fail(threadId, "Voice moved to another device.");
      return;
    }
    if (isLiveVoicePhase(session.phase)) return;
    // Ended, failed, or stopped from another device.
    if (this.state.status === "stopping") {
      this.teardown();
      return;
    }
    this.fail(threadId, describeEndedVoiceSession(session, this.deps.clientId));
  }

  private startHeartbeat(threadId: string, generation: number) {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (generation !== this.generation) return;
      void this.deps.api
        .heartbeat(threadId, this.deps.clientId)
        .then((snapshot) => this.observe(threadId, snapshot.session))
        .catch((error) => {
          if (/does not own/i.test(message(error)))
            this.fail(threadId, "Voice moved to another device.");
        });
    }, this.deps.heartbeatMs);
    (this.heartbeat as { unref?: () => void }).unref?.();
  }

  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /** Local media failed: release the backend call, then tear down. */
  private async abandon(generation: number, error: string) {
    if (generation !== this.generation || this.state.status === "idle") return;
    const threadId = this.state.threadId;
    this.fail(threadId, error);
    if (threadId)
      await this.deps.api
        .stop(threadId, this.deps.clientId, error)
        .catch(() => {});
  }

  private fail(threadId: string | null, error: string, teardown = true) {
    if (teardown) this.teardown();
    this.setState({ error, errorThreadId: threadId });
  }

  private teardown() {
    this.generation += 1;
    this.voiceSessionId = null;
    this.stopHeartbeat();
    this.media?.close();
    this.media = null;
    this.setState({
      threadId: null,
      status: "idle",
      muted: false,
      playbackBlocked: false,
    });
  }
}

function createClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

let shared: VoiceController | null = null;

/** The page-wide voice controller (one microphone owner per page). */
export function getVoiceController(): VoiceController {
  shared ??= new VoiceController({
    clientId: createClientId(),
    api: {
      start: startVoiceSession,
      stop: stopVoiceSession,
      heartbeat: sendVoiceHeartbeat,
      snapshot: getVoiceSnapshot,
    },
    media: browserVoiceMediaFactory,
    environment: readVoiceEnvironment,
    microphone: readPreferredMicrophone,
  });
  return shared;
}

import type {
  RealtimeTranscriptEntry,
  RealtimeVoicePhase,
  RealtimeVoiceSessionView,
} from "@codex-deck/api";

export type VoiceCommandAction = "toggle" | "settings" | "mute" | "stop";

export const VOICE_USAGE = "Usage: /voice [settings|mute|stop]";

/** Mirrors the TUI's `/voice [settings|mute|stop]` argument handling. */
export function parseVoiceCommandArgs(args: string): VoiceCommandAction | null {
  const normalized = args.trim().toLowerCase();
  if (!normalized) return "toggle";
  if (
    normalized === "settings" ||
    normalized === "mute" ||
    normalized === "stop"
  )
    return normalized;
  return null;
}

export interface VoiceEnvironment {
  isSecureContext?: boolean;
  hasGetUserMedia: boolean;
  hasPeerConnection: boolean;
  origin?: string | null;
}

export function readVoiceEnvironment(): VoiceEnvironment {
  if (typeof window === "undefined")
    return { hasGetUserMedia: false, hasPeerConnection: false };
  return {
    isSecureContext: window.isSecureContext,
    hasGetUserMedia:
      typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices?.getUserMedia === "function",
    hasPeerConnection: typeof window.RTCPeerConnection === "function",
    origin: window.location?.origin ?? null,
  };
}

/** Returns why voice cannot run in this browser, or null when it can. */
export function voiceUnavailableReason(env: VoiceEnvironment): string | null {
  if (env.isSecureContext === false) {
    const origin = env.origin ? ` (${env.origin})` : "";
    return `Voice needs microphone access, which browsers only allow on HTTPS pages or localhost. This page${origin} is not a secure context. Open Codex Deck over HTTPS (for example through a TLS reverse proxy or tunnel) or from localhost on the machine running it.`;
  }
  if (!env.hasGetUserMedia)
    return "This browser does not expose microphone capture (getUserMedia), so voice is unavailable.";
  if (!env.hasPeerConnection)
    return "This browser does not support WebRTC, which voice uses to stream audio.";
  return null;
}

export function describeMicrophoneError(error: unknown): string {
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name)
      : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "Microphone access was denied for this site. Allow it from the site settings next to the address bar (on iPhone: Settings › Safari › Microphone), then try again.";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "No usable microphone was found. Connect one, or choose another microphone, then try again.";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "The microphone could not be started. Close other apps that may be using it, then try again.";
    default:
      return `Could not start the microphone: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** What went wrong with voice, so the UI can offer the matching fix. */
export type VoiceErrorKind =
  | "permission"
  | "no-microphone"
  | "microphone-busy"
  | "unsupported"
  | "connection"
  | "conflict"
  | "service"
  | "ended";

function errorName(error: unknown): string {
  return error && typeof error === "object" && "name" in error
    ? String((error as { name?: unknown }).name)
    : "";
}

export function classifyMicrophoneError(error: unknown): VoiceErrorKind {
  switch (errorName(error)) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "permission";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "no-microphone";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "microphone-busy";
    default:
      return "service";
  }
}

/** Classify an error message returned by the voice routes. */
export function classifyVoiceServiceError(message: string): VoiceErrorKind {
  if (/does not support realtime voice|voice is unavailable/i.test(message))
    return "unsupported";
  if (/already|another device|another conversation|does not own/i.test(message))
    return "conflict";
  return "service";
}

export interface VoiceErrorPresentation {
  title: string;
  /** Starting voice again can succeed (after the user fixes the cause). */
  retry: boolean;
  /** Picking another microphone may fix it. */
  chooseMicrophone: boolean;
}

export function describeVoiceError(
  kind: VoiceErrorKind | null,
): VoiceErrorPresentation {
  switch (kind) {
    case "permission":
      return {
        title: "Microphone access is blocked",
        retry: true,
        chooseMicrophone: false,
      };
    case "no-microphone":
      return {
        title: "No microphone found",
        retry: true,
        chooseMicrophone: true,
      };
    case "microphone-busy":
      return {
        title: "The microphone is busy",
        retry: true,
        chooseMicrophone: true,
      };
    case "unsupported":
      return {
        title: "Voice isn't available here",
        retry: false,
        chooseMicrophone: false,
      };
    case "connection":
      return {
        title: "Voice couldn't connect",
        retry: true,
        chooseMicrophone: false,
      };
    case "conflict":
      return {
        title: "Voice is already in use",
        retry: false,
        chooseMicrophone: false,
      };
    case "ended":
      return {
        title: "Voice conversation ended",
        retry: true,
        chooseMicrophone: false,
      };
    default:
      return {
        title: "Voice stopped",
        retry: true,
        chooseMicrophone: false,
      };
  }
}

export type VoiceActivity =
  | "requesting-microphone"
  | "connecting"
  | "listening"
  | "hearing-you"
  | "speaking"
  | "thinking"
  | "working"
  | "muted"
  | "stopping";

export interface VoiceActivityInput {
  /** This page's call status, or "remote" for a call owned elsewhere. */
  status: string;
  muted: boolean;
  /** From the live microphone impulse (this page only). */
  userSpeaking: boolean;
  /** From Codex's live voice impulse (this page only). */
  codexSpeaking: boolean;
  transcript: readonly RealtimeTranscriptEntry[];
  /** A turn is running in the conversation (voice delegated work). */
  working: boolean;
  /** How long ago this page first saw the latest transcript entry. */
  lastEntryAgeMs: number | null;
}

const THINKING_WINDOW_MS = 8_000;

/**
 * One headline state for the call. Order follows the TUI (connecting, muted,
 * heard, speaking, listening), plus Deck's working/thinking cues.
 */
export function deriveVoiceActivity(input: VoiceActivityInput): VoiceActivity {
  if (input.status === "preparing") return "requesting-microphone";
  if (input.status === "negotiating") return "connecting";
  if (input.status === "stopping") return "stopping";
  if (input.muted) return "muted";
  const last = input.transcript.at(-1);
  const partial = last && !last.final ? last.role : null;
  if (input.userSpeaking || partial === "user") return "hearing-you";
  if (input.codexSpeaking || (partial && partial !== "user")) return "speaking";
  if (input.working) return "working";
  if (
    last?.role === "user" &&
    last.final &&
    input.lastEntryAgeMs !== null &&
    input.lastEntryAgeMs < THINKING_WINDOW_MS
  )
    return "thinking";
  return "listening";
}

export function describeVoiceActivity(
  activity: VoiceActivity,
  options: { shortcut: string; mutedSpeech?: boolean; remote?: boolean },
): { label: string; hint: string } {
  switch (activity) {
    case "requesting-microphone":
      return {
        label: "Requesting microphone",
        hint: "Allow microphone access if your browser asks.",
      };
    case "connecting":
      return { label: "Connecting", hint: "Setting up the voice call…" };
    case "stopping":
      return { label: "Ending call", hint: "Hanging up…" };
    case "muted":
      return {
        label: "Muted",
        hint: options.mutedSpeech
          ? `You're muted — press ${options.shortcut} to talk.`
          : `Codex can't hear you. Press ${options.shortcut} to unmute.`,
      };
    case "hearing-you":
      return {
        label: options.remote ? "Hearing the speaker" : "Hearing you",
        hint: "Pause when you're done.",
      };
    case "speaking":
      return {
        label: "Codex is speaking",
        hint: options.remote ? "Live on another device." : "Talk to interrupt.",
      };
    case "working":
      return {
        label: "Working on it",
        hint: "Progress appears in the conversation.",
      };
    case "thinking":
      return { label: "Thinking", hint: "Codex heard you." };
    default:
      return {
        label: "Listening",
        hint: options.remote
          ? "Live on another device."
          : "Go ahead — speak naturally.",
      };
  }
}

export interface VoiceShortcutEvent {
  key: string;
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}

/** F9 mirrors the TUI's default mute key; Alt/Option+M works on laptops. */
export function isVoiceMuteShortcut(event: VoiceShortcutEvent): boolean {
  if (event.isComposing || event.ctrlKey || event.metaKey || event.shiftKey)
    return false;
  if (event.key === "F9") return !event.altKey;
  return event.altKey && event.code === "KeyM";
}

export function voiceMuteShortcutLabel(platform: string): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌥M" : "Alt+M";
}

/** Format a call duration as m:ss (or h:mm:ss). */
export function formatVoiceDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

export function isLiveVoicePhase(
  phase: RealtimeVoicePhase | null | undefined,
): boolean {
  return phase === "starting" || phase === "active" || phase === "stopping";
}

export type VoiceSessionRelation = "none" | "owned" | "other-device" | "ended";

export function voiceSessionRelation(
  session: RealtimeVoiceSessionView | null | undefined,
  clientId: string,
): VoiceSessionRelation {
  if (!session) return "none";
  if (!isLiveVoicePhase(session.phase)) return "ended";
  return session.ownerClientId === clientId ? "owned" : "other-device";
}

/** Explain why a session the page owned ended, from the shared snapshot. */
export function describeEndedVoiceSession(
  session: RealtimeVoiceSessionView,
  clientId: string,
): string {
  if (session.error) return session.error;
  if (session.stoppedByClientId && session.stoppedByClientId !== clientId)
    return "Voice was stopped from another device.";
  if (session.closedReason && session.closedReason !== "requested")
    return `Voice conversation ended: ${session.closedReason.replace(/_/g, " ")}.`;
  return "Voice conversation ended.";
}

/**
 * Voice requests delegated to Codex arrive as user messages wrapped in
 * `<realtime_delegation><input>…</input></realtime_delegation>`. Show only the
 * spoken input, matching the TUI.
 */
export function getRealtimeDelegationDisplayText(text: string): string | null {
  const body = text
    .trim()
    .match(/^<realtime_delegation>([\s\S]*)<\/realtime_delegation>$/)?.[1];
  if (body === undefined) return null;
  const input = body.match(/<input>([\s\S]*?)<\/input>/)?.[1];
  if (input === undefined) return null;
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export const AUDIO_ATTACHMENT_MIME_TYPES: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  webm: "audio/webm",
  ogg: "audio/ogg",
};

export const MAX_AUDIO_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Upstream accepts wav, mp3, m4a, webm and ogg audio input. */
export function audioAttachmentMimeType(file: {
  name: string;
  type: string;
}): string | null {
  const type = file.type.toLowerCase().split(";")[0]?.trim() ?? "";
  const normalized =
    type === "audio/x-wav" || type === "audio/wave"
      ? "audio/wav"
      : type === "audio/mp3"
        ? "audio/mpeg"
        : type === "audio/x-m4a" || type === "audio/m4a"
          ? "audio/mp4"
          : type;
  if (Object.values(AUDIO_ATTACHMENT_MIME_TYPES).includes(normalized))
    return normalized;
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  return AUDIO_ATTACHMENT_MIME_TYPES[extension] ?? null;
}

export function isAudioDataUrl(url: string): boolean {
  return /^data:audio\/[a-z0-9.+-]+(;[^,]*)?,/i.test(url.trim());
}

/** Rewrites a data URL's media type (browsers may report e.g. audio/x-m4a). */
export function withAudioMimeType(dataUrl: string, mime: string): string {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return dataUrl;
  const header = dataUrl.slice(0, comma);
  const base64 = /;base64$/i.test(header) ? ";base64" : "";
  return `data:${mime}${base64}${dataUrl.slice(comma)}`;
}

export interface AudioCapableModel {
  id: string;
  displayName?: string;
  inputModalities?: string[] | null;
}

/** Returns why audio cannot be attached for this model, or null when allowed. */
export function audioAttachmentUnavailableReason(
  model: AudioCapableModel | null | undefined,
): string | null {
  if (!model)
    return "Audio attachments need a model that accepts audio input. Select a model first.";
  if (!Array.isArray(model.inputModalities))
    return "The connected Codex server does not report whether this model accepts audio input.";
  if (!model.inputModalities.includes("audio"))
    return `${model.displayName || model.id} does not accept audio input. Choose a model that lists audio input to attach audio.`;
  return null;
}

export interface VoiceToggleDescription {
  /** This page runs a call (pressing the button ends it, like /voice). */
  active: boolean;
  /** The call is connecting or hanging up. */
  busy: boolean;
  /** The call belongs to another conversation on this page. */
  elsewhere: boolean;
  label: string;
}

/**
 * The composer's voice button runs /voice, so like the CLI it works with any
 * conversation model (realtime voice uses its own realtime model).
 */
export function describeVoiceToggle(
  state: { status: string; threadId: string | null },
  threadId: string | null,
): VoiceToggleDescription {
  if (state.status === "idle")
    return {
      active: false,
      busy: false,
      elsewhere: false,
      label: "Start voice conversation",
    };
  const elsewhere = state.threadId !== threadId;
  const busy = state.status !== "connected";
  return {
    active: true,
    busy,
    elsewhere,
    label: elsewhere
      ? "End voice in the other conversation"
      : state.status === "stopping"
        ? "Ending voice conversation"
        : busy
          ? "Cancel voice connection"
          : "End voice conversation",
  };
}

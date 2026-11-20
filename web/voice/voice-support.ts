import type {
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
      return "Microphone access was denied. Allow microphone access for this site in your browser settings, then run /voice again.";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "No usable microphone was found. Connect a microphone or choose another one in /voice settings.";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "The microphone could not be started. It may be in use by another app.";
    default:
      return `Could not start the microphone: ${error instanceof Error ? error.message : String(error)}`;
  }
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

/**
 * The composer's voice button runs /voice, so like the CLI it works with any
 * conversation model (realtime voice uses its own realtime model).
 */
export function describeVoiceToggle(status: string): {
  active: boolean;
  label: string;
} {
  const active = status !== "idle";
  return {
    active,
    label: active ? "Stop voice conversation" : "Start voice conversation",
  };
}

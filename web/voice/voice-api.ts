import type {
  RealtimeVoiceCatalog,
  RealtimeVoiceSnapshot,
} from "@codex-deck/api";
import { requestJson } from "../transport";

// Plain JSON requests work over both the local HTTP API and the encrypted
// remote relay, so voice signaling behaves the same in both modes.

function threadPath(threadId: string, suffix = ""): string {
  return `/api/codex/threads/${encodeURIComponent(threadId)}/realtime${suffix}`;
}

export function getVoiceCatalog(
  threadId: string | null,
): Promise<RealtimeVoiceCatalog> {
  return requestJson(
    `/api/codex/realtime/voices${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ""}`,
  );
}

export function setVoicePreference(
  voice: string | null,
  threadId: string | null,
): Promise<RealtimeVoiceCatalog & { warning: string | null }> {
  return requestJson("/api/codex/realtime/voice", {
    method: "POST",
    body: JSON.stringify({ voice, threadId }),
  });
}

export function getVoiceSnapshot(
  threadId: string,
  clientId: string,
): Promise<RealtimeVoiceSnapshot> {
  return requestJson(
    `${threadPath(threadId)}?clientId=${encodeURIComponent(clientId)}`,
  );
}

export function startVoiceSession(
  threadId: string,
  input: { clientId: string; sdp: string; voice?: string | null },
): Promise<RealtimeVoiceSnapshot> {
  return requestJson(threadPath(threadId, "/start"), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function sendVoiceHeartbeat(
  threadId: string,
  clientId: string,
): Promise<RealtimeVoiceSnapshot> {
  return requestJson(threadPath(threadId, "/heartbeat"), {
    method: "POST",
    body: JSON.stringify({ clientId }),
  });
}

export function stopVoiceSession(
  threadId: string,
  clientId: string,
  error?: string | null,
): Promise<RealtimeVoiceSnapshot> {
  return requestJson(threadPath(threadId, "/stop"), {
    method: "POST",
    body: JSON.stringify({ clientId, ...(error ? { error } : {}) }),
  });
}

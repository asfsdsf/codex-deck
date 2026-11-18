import type {
  RealtimeTranscriptEntry,
  RealtimeVoiceHistoryEntry,
} from "@codex-deck/api";

export function realtimeEventKey(entry: {
  realtimeSessionId: string;
  eventId: string;
}): string {
  return JSON.stringify([entry.realtimeSessionId, entry.eventId]);
}

export function mergeVoiceHistory(
  saved: readonly RealtimeVoiceHistoryEntry[],
  live: readonly RealtimeTranscriptEntry[],
) {
  const events = new Map<
    string,
    {
      key: string;
      at: number | null;
      label: string;
      text: string;
      pending: boolean;
    }
  >();
  for (const entry of live) {
    if (!entry.text.trim()) continue;
    const key =
      entry.eventId && entry.realtimeSessionId
        ? realtimeEventKey({
            realtimeSessionId: entry.realtimeSessionId,
            eventId: entry.eventId,
          })
        : entry.id;
    events.set(key, {
      key,
      at: entry.at,
      label: entry.role === "user" ? "You" : "Codex",
      text: entry.text,
      pending: !entry.final,
    });
  }
  for (const entry of saved) {
    const key = realtimeEventKey(entry);
    const label =
      entry.kind === "saved"
        ? "Saved when voice ended"
        : entry.kind === "handoff"
          ? entry.mode === "steer"
            ? "Steered a turn"
            : "Started a turn"
          : entry.role === "user"
            ? "You"
            : "Codex";
    events.set(key, {
      key,
      at: entry.observedAtMs,
      label,
      text: entry.text,
      pending: false,
    });
  }
  return [...events.values()].sort(
    (left, right) => (left.at ?? 0) - (right.at ?? 0),
  );
}

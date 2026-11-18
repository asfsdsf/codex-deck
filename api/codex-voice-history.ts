import { nativeRecord, type NativeRpc } from "./codex-native";

interface RealtimeHistoryIdentity {
  eventId: string;
  realtimeSessionId: string;
  observedAtMs: number | null;
}

type RealtimeHistoryItem = RealtimeHistoryIdentity &
  (
    | { kind: "transcript"; role: "user" | "assistant"; text: string }
    | {
        kind: "handoff";
        mode: "start" | "steer";
        handoffId: string;
        turnId: string;
        inputItemId: string;
        sourceEventIds: string[];
        text: string;
      }
    | {
        kind: "saved";
        inputItemId: string;
        sourceEventIds: string[];
        text: string;
      }
  );

export type RealtimeVoiceHistoryEntry = RealtimeHistoryItem & {
  position: number;
};

export interface RealtimeVoiceHistoryPage {
  data: RealtimeVoiceHistoryEntry[];
  nextCursor: string | null;
  snapshotEnd: number;
  projectedThroughItemIndex: number;
  coverage: "ready" | "pending" | "unsupported";
}

export interface RealtimeVoiceHistoryQuery {
  cursor?: string;
  snapshotEnd?: number;
  requiredThroughPosition?: number;
}

const record = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export function isRealtimePosition(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const stringValue = (value: unknown) =>
  typeof value === "string" && value.trim() ? value : null;

export function parseRealtimeHistoryItem(
  value: unknown,
): RealtimeHistoryItem | null {
  const item = record(value);
  const eventId = stringValue(item?.id);
  const realtimeSessionId = stringValue(item?.realtimeSessionId);
  if (!item || !eventId || !realtimeSessionId) return null;
  const identity: RealtimeHistoryIdentity = {
    eventId,
    realtimeSessionId,
    observedAtMs: isRealtimePosition(item.observedAtMs)
      ? item.observedAtMs
      : null,
  };
  if (item.type === "frame" || item.type === "transcriptSegment") {
    const frame =
      item.type === "frame"
        ? record(record(item.channels)?.voice_transcript)
        : item;
    const role = frame?.role;
    const text = frame?.text;
    return (role === "user" || role === "assistant") && typeof text === "string"
      ? { ...identity, kind: "transcript", role, text }
      : null;
  }
  if (
    item.type === "turnInputAccepted" ||
    item.type === "sessionEndInputSaved"
  ) {
    const text = stringValue(item.input);
    const inputItemId = stringValue(item.inputItemId);
    if (!text || !inputItemId) return null;
    const sourceEventIds = Array.isArray(item.sourceEventIds)
      ? item.sourceEventIds.filter((id): id is string => typeof id === "string")
      : [];
    const input = { ...identity, inputItemId, sourceEventIds, text };
    if (item.type === "sessionEndInputSaved")
      return { ...input, kind: "saved" };
    const mode = item.mode;
    const handoffId = stringValue(item.handoffId);
    const turnId = stringValue(item.turnId);
    if (handoffId && turnId && (mode === "start" || mode === "steer")) {
      return { ...input, kind: "handoff", handoffId, turnId, mode };
    }
  }
  return null;
}

export async function listRealtimeVoiceHistory(
  rpc: NativeRpc,
  threadId: string,
  query: RealtimeVoiceHistoryQuery,
): Promise<RealtimeVoiceHistoryPage> {
  const method = "thread/realtime/list";
  let result: Record<string, unknown>;
  try {
    result = nativeRecord(
      await rpc(method, {
        threadId,
        order: "observedAt",
        limit: 50,
        ...query,
      }),
    );
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    const message = error instanceof Error ? error.message : "";
    if (
      code !== -32601 &&
      !(
        code === -32600 &&
        message.includes(method) &&
        /unknown variant|unknown method/i.test(message)
      )
    ) {
      throw error;
    }
    return {
      coverage: "unsupported",
      data: [],
      nextCursor: null,
      snapshotEnd: 0,
      projectedThroughItemIndex: 0,
    };
  }
  const { coverage, snapshotEnd, projectedThroughItemIndex, nextCursor } =
    result;
  if (
    (coverage !== "ready" &&
      coverage !== "pending" &&
      coverage !== "unsupported") ||
    !isRealtimePosition(snapshotEnd) ||
    !isRealtimePosition(projectedThroughItemIndex) ||
    !Array.isArray(result.data) ||
    (nextCursor !== null && typeof nextCursor !== "string") ||
    (coverage === "ready" &&
      query.snapshotEnd !== undefined &&
      query.snapshotEnd !== snapshotEnd)
  ) {
    throw new Error("Invalid Codex realtime history page.");
  }
  const data: RealtimeVoiceHistoryEntry[] = [];
  if (coverage === "ready") {
    for (const value of result.data) {
      const entry = record(value);
      const item = parseRealtimeHistoryItem(entry?.item);
      if (
        item &&
        isRealtimePosition(entry?.position) &&
        entry.position < snapshotEnd
      ) {
        data.push({ ...item, position: entry.position });
      }
    }
  }
  return {
    coverage,
    data,
    nextCursor: coverage === "ready" ? nextCursor : null,
    snapshotEnd,
    projectedThroughItemIndex,
  };
}

export type EditableConversationRole = "user" | "assistant";

export interface EditableConversationRecord {
  editId: string;
  role: EditableConversationRole;
  text: string;
  timestamp: string;
}

interface JsonlLineWithOffset {
  line: string;
  offset: number;
}

interface EditableEventRecord {
  offset: number;
  role: EditableConversationRole;
  text: string;
  timestampMs: number;
}

const EDITABLE_PAIR_MAX_TIMESTAMP_DELTA_MS = 1_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readTurnId(payload: Record<string, unknown>): string | null {
  const metadata = asRecord(payload.internal_chat_message_metadata_passthrough);
  const turnId = metadata?.turn_id;
  return typeof turnId === "string" && turnId.trim() ? turnId.trim() : null;
}

export function getResponseItemMessageText(
  payload: Record<string, unknown>,
): string | null {
  const content = payload.content;
  if (typeof content === "string") {
    return content.trim() ? content.trim() : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }

  const parts: string[] = [];
  for (const item of content) {
    const block = asRecord(item);
    if (
      !block ||
      (block.type !== "input_text" && block.type !== "output_text") ||
      typeof block.text !== "string"
    ) {
      continue;
    }
    const text = block.text.trim();
    if (text) {
      parts.push(text);
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

export function collectEditableMessagePairs(
  lines: readonly JsonlLineWithOffset[],
): Map<number, number> {
  const responseItems: Array<EditableConversationRecord & { offset: number }> =
    [];
  const events: EditableEventRecord[] = [];

  for (const { line, offset } of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (!record) {
      continue;
    }

    const responseItem = getEditableResponseItem(record, offset);
    if (responseItem) {
      responseItems.push({ ...responseItem, offset });
      continue;
    }

    const payload = asRecord(record?.payload);
    if (record?.type !== "event_msg" || !payload) {
      continue;
    }

    const role: EditableConversationRole | null =
      payload.type === "user_message"
        ? "user"
        : payload.type === "agent_message"
          ? "assistant"
          : null;
    const timestamp = record.timestamp;
    const text = payload.message;
    if (
      !role ||
      typeof timestamp !== "string" ||
      typeof text !== "string" ||
      !text.trim()
    ) {
      continue;
    }

    const timestampMs = Date.parse(timestamp);
    if (!Number.isFinite(timestampMs)) {
      continue;
    }
    events.push({
      offset,
      role,
      text: text.trim(),
      timestampMs,
    });
  }

  const pairs = new Map<number, number>();
  const matchedEventOffsets = new Set<number>();
  for (const responseItem of responseItems) {
    const responseTimestampMs = Date.parse(responseItem.timestamp);
    if (!Number.isFinite(responseTimestampMs)) {
      continue;
    }

    let bestEvent: EditableEventRecord | null = null;
    let bestTimestampDelta = Number.POSITIVE_INFINITY;
    let bestOffsetDelta = Number.POSITIVE_INFINITY;
    for (const event of events) {
      if (
        matchedEventOffsets.has(event.offset) ||
        event.role !== responseItem.role ||
        event.text !== responseItem.text
      ) {
        continue;
      }

      const timestampDelta = Math.abs(event.timestampMs - responseTimestampMs);
      if (timestampDelta > EDITABLE_PAIR_MAX_TIMESTAMP_DELTA_MS) {
        continue;
      }
      const offsetDelta = Math.abs(event.offset - responseItem.offset);
      if (
        timestampDelta < bestTimestampDelta ||
        (timestampDelta === bestTimestampDelta && offsetDelta < bestOffsetDelta)
      ) {
        bestEvent = event;
        bestTimestampDelta = timestampDelta;
        bestOffsetDelta = offsetDelta;
      }
    }

    if (bestEvent) {
      pairs.set(responseItem.offset, bestEvent.offset);
      matchedEventOffsets.add(bestEvent.offset);
    }
  }

  return pairs;
}

export function getEditableResponseItem(
  record: Record<string, unknown>,
  offset: number,
): EditableConversationRecord | null {
  const payload = asRecord(record.payload);
  const role = payload?.role;
  const timestamp = record.timestamp;
  if (
    record.type !== "response_item" ||
    payload?.type !== "message" ||
    (role !== "user" && role !== "assistant") ||
    typeof timestamp !== "string"
  ) {
    return null;
  }

  const text = getResponseItemMessageText(payload);
  if (!text) {
    return null;
  }

  const itemId =
    typeof payload.id === "string" && payload.id.trim()
      ? payload.id.trim()
      : null;
  const turnId = readTurnId(payload);
  const editId = itemId
    ? `item:${itemId}`
    : turnId
      ? `turn:${turnId}`
      : `offset:${offset}:${timestamp}`;

  return {
    editId,
    role,
    text,
    timestamp,
  };
}

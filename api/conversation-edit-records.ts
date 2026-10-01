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

function normalizeType(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/[\s_-]/g, "").toLowerCase()
    : "";
}

function getItemCompletedMessage(payload: Record<string, unknown>): {
  item: Record<string, unknown>;
  role: EditableConversationRole;
} | null {
  if (normalizeType(payload.type) !== "itemcompleted") {
    return null;
  }
  const item = asRecord(payload.item);
  const itemType = normalizeType(item?.type);
  const role: EditableConversationRole | null =
    itemType === "usermessage"
      ? "user"
      : itemType === "agentmessage"
        ? "assistant"
        : null;
  return item && role ? { item, role } : null;
}

function getItemCompletedMessageText(
  item: Record<string, unknown>,
): string | null {
  const content = item.content;
  if (typeof content === "string") {
    return content.trim() ? content.trim() : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }

  const parts: string[] = [];
  for (const value of content) {
    const block = asRecord(value);
    if (
      !block ||
      (normalizeType(block.type) !== "text" &&
        normalizeType(block.type) !== "inputtext" &&
        normalizeType(block.type) !== "outputtext") ||
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

export function getEditableEventRecord(
  record: Record<string, unknown>,
  offset: number,
): EditableEventRecord | null {
  const payload = asRecord(record.payload);
  const timestamp = record.timestamp;
  if (
    record.type !== "event_msg" ||
    !payload ||
    typeof timestamp !== "string"
  ) {
    return null;
  }

  const legacyRole: EditableConversationRole | null =
    payload.type === "user_message"
      ? "user"
      : payload.type === "agent_message"
        ? "assistant"
        : null;
  const itemCompletedMessage = getItemCompletedMessage(payload);
  const role = legacyRole ?? itemCompletedMessage?.role ?? null;
  const text = legacyRole
    ? typeof payload.message === "string"
      ? payload.message.trim()
      : ""
    : itemCompletedMessage
      ? (getItemCompletedMessageText(itemCompletedMessage.item) ?? "")
      : "";
  const timestampMs = Date.parse(timestamp);
  if (!role || !text || !Number.isFinite(timestampMs)) {
    return null;
  }

  return { offset, role, text, timestampMs };
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
  const eventsByRole = new Map<
    EditableConversationRole,
    Map<string, EditableEventRecord[]>
  >();

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

    const event = getEditableEventRecord(record, offset);
    if (event) {
      let eventsByText = eventsByRole.get(event.role);
      if (!eventsByText) {
        eventsByText = new Map();
        eventsByRole.set(event.role, eventsByText);
      }
      const matchingEvents = eventsByText.get(event.text) ?? [];
      matchingEvents.push(event);
      eventsByText.set(event.text, matchingEvents);
    }
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
    for (const event of eventsByRole
      .get(responseItem.role)
      ?.get(responseItem.text) ?? []) {
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

export function replaceEditableEventMessageText(
  record: Record<string, unknown>,
  text: string,
): boolean {
  const payload = asRecord(record.payload);
  if (record.type !== "event_msg" || !payload) {
    return false;
  }

  if (
    (payload.type === "user_message" || payload.type === "agent_message") &&
    typeof payload.message === "string"
  ) {
    payload.message = text;
    return true;
  }

  const itemCompletedMessage = getItemCompletedMessage(payload);
  if (!itemCompletedMessage) {
    return false;
  }
  const content = itemCompletedMessage.item.content;
  if (typeof content === "string") {
    itemCompletedMessage.item.content = text;
    return true;
  }
  if (!Array.isArray(content)) {
    return false;
  }

  let replaced = false;
  itemCompletedMessage.item.content = content.filter((value) => {
    const block = asRecord(value);
    const blockType = normalizeType(block?.type);
    const isTextBlock =
      block &&
      (blockType === "text" ||
        blockType === "inputtext" ||
        blockType === "outputtext") &&
      typeof block.text === "string";
    if (!isTextBlock) {
      return true;
    }
    if (replaced) {
      return false;
    }
    block.text = text;
    replaced = true;
    return true;
  });
  return replaced;
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

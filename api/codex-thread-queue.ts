import type { NativeRpc } from "./codex-native";

/**
 * Shared, server-side message queue (`thread/queue/*`). The app-server stores
 * queued submissions durably and drains them itself: when a turn completes
 * (not when it is interrupted) it starts the next queued submission, and an
 * enqueue onto an idle thread starts immediately. Clients therefore never
 * auto-start queued items; `thread/queue/start` is only the explicit
 * "send now" for an idle thread.
 */
export interface CodexQueuedMessage {
  id: string;
  text: string;
  images: string[];
  clientUserMessageId: string | null;
}

export interface CodexThreadQueueSnapshot {
  supported: boolean;
  items: CodexQueuedMessage[];
}

export type CodexQueueInputItem =
  | { type: "text"; text: string }
  | { type: "image"; url: string };

export const THREAD_QUEUE_UNSUPPORTED_MESSAGE =
  "The connected Codex app-server does not support shared message queues.";

export class ThreadQueueUnsupportedError extends Error {
  public constructor() {
    super(THREAD_QUEUE_UNSUPPORTED_MESSAGE);
    this.name = "ThreadQueueUnsupportedError";
  }
}

const MAX_QUEUE_PAGES = 20;

/** Older app-servers reject queue methods, as `codex queue` detects. */
export function isUnsupportedThreadQueueError(error: unknown): boolean {
  if (error instanceof ThreadQueueUnsupportedError) {
    return true;
  }
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  const message = String((error as { message?: unknown }).message ?? "");
  if (code === -32601) {
    return true;
  }
  const lower = message.toLowerCase();
  return (
    lower.includes("method not found") ||
    lower.includes("unknown variant `thread/queue") ||
    (lower.includes("thread/queue") &&
      lower.includes("requires experimentalapi")) ||
    lower.includes("user message queue is unavailable")
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseQueuedSubmission(
  value: unknown,
): CodexQueuedMessage | null {
  const record = asRecord(value);
  const id = typeof record?.id === "string" ? record.id.trim() : "";
  if (!record || !id || !Array.isArray(record.input)) {
    return null;
  }
  const texts: string[] = [];
  const images: string[] = [];
  for (const item of record.input) {
    const entry = asRecord(item);
    if (entry?.type === "text" && typeof entry.text === "string") {
      texts.push(entry.text);
    } else if (entry?.type === "image" && typeof entry.url === "string") {
      images.push(entry.url);
    } else if (entry?.type === "localImage" && typeof entry.path === "string") {
      texts.push(`[image: ${entry.path}]`);
    } else if (
      (entry?.type === "skill" || entry?.type === "mention") &&
      typeof entry.name === "string"
    ) {
      texts.push(`${entry.type === "skill" ? "$" : "@"}${entry.name}`);
    }
  }
  return {
    id,
    text: texts.join("\n"),
    images,
    clientUserMessageId:
      typeof record.clientUserMessageId === "string"
        ? record.clientUserMessageId
        : null,
  };
}

export function toQueueUserInput(
  input: readonly CodexQueueInputItem[],
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const item of input) {
    if (item.type === "text" && item.text.trim()) {
      result.push({ type: "text", text: item.text.trim(), text_elements: [] });
    } else if (item.type === "image" && item.url.trim()) {
      result.push({ type: "image", url: item.url.trim() });
    }
  }
  if (result.length === 0) {
    throw new Error("input is required");
  }
  return result;
}

/** Validates an HTTP body's `input` array; null when invalid. */
export function parseQueueInputItems(
  value: unknown,
): CodexQueueInputItem[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const items: CodexQueueInputItem[] = [];
  for (const raw of value) {
    const entry = asRecord(raw);
    if (entry?.type === "text" && typeof entry.text === "string") {
      if (entry.text.trim()) items.push({ type: "text", text: entry.text });
    } else if (entry?.type === "image" && typeof entry.url === "string") {
      if (entry.url.trim()) items.push({ type: "image", url: entry.url });
    } else {
      return null;
    }
  }
  return items.length > 0 ? items : null;
}

/**
 * Replaces the text of a queued submission while keeping its non-text items
 * (images, skills, mentions) so an edit does not drop attachments.
 */
export function rebuildQueuedInput(
  original: unknown,
  text: string,
): Array<Record<string, unknown>> {
  const kept = Array.isArray(original)
    ? original.filter((item) => asRecord(item)?.type !== "text")
    : [];
  const trimmed = text.trim();
  const next = [
    ...(trimmed ? [{ type: "text", text: trimmed, text_elements: [] }] : []),
    ...(kept as Array<Record<string, unknown>>),
  ];
  if (next.length === 0) {
    throw new Error("text is required");
  }
  return next;
}

async function call(
  rpc: NativeRpc,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await rpc(method, params);
  } catch (error) {
    if (isUnsupportedThreadQueueError(error)) {
      throw new ThreadQueueUnsupportedError();
    }
    throw error;
  }
}

async function listRawQueue(
  rpc: NativeRpc,
  threadId: string,
): Promise<unknown[]> {
  const items: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_QUEUE_PAGES; page += 1) {
    const response = asRecord(
      await call(rpc, "thread/queue/list", {
        threadId,
        ...(cursor ? { cursor } : {}),
      }),
    );
    if (!response || !Array.isArray(response.data)) {
      throw new Error("Invalid thread/queue/list response");
    }
    items.push(...response.data);
    cursor =
      typeof response.nextCursor === "string" && response.nextCursor
        ? response.nextCursor
        : null;
    if (!cursor) break;
  }
  return items;
}

export async function listThreadQueue(
  rpc: NativeRpc,
  threadId: string,
): Promise<CodexThreadQueueSnapshot> {
  try {
    const raw = await listRawQueue(rpc, threadId);
    return {
      supported: true,
      items: raw
        .map(parseQueuedSubmission)
        .filter((item): item is CodexQueuedMessage => item !== null),
    };
  } catch (error) {
    if (error instanceof ThreadQueueUnsupportedError) {
      return { supported: false, items: [] };
    }
    throw error;
  }
}

export async function addThreadQueueMessage(
  rpc: NativeRpc,
  threadId: string,
  input: readonly CodexQueueInputItem[],
  clientUserMessageId: string,
): Promise<CodexQueuedMessage> {
  const response = asRecord(
    await call(rpc, "thread/queue/add", {
      threadId,
      input: toQueueUserInput(input),
      clientUserMessageId,
    }),
  );
  const item = parseQueuedSubmission(response?.queuedSubmission);
  if (!item) throw new Error("Invalid thread/queue/add response");
  return item;
}

export async function updateThreadQueueMessage(
  rpc: NativeRpc,
  threadId: string,
  queuedSubmissionId: string,
  text: string,
): Promise<CodexQueuedMessage> {
  const current = asRecord(
    (await listRawQueue(rpc, threadId)).find(
      (item) => asRecord(item)?.id === queuedSubmissionId,
    ),
  );
  if (!current) {
    throw new Error(`queued submission not found: ${queuedSubmissionId}`);
  }
  const response = asRecord(
    await call(rpc, "thread/queue/update", {
      threadId,
      queuedSubmissionId,
      input: rebuildQueuedInput(current.input, text),
    }),
  );
  const item = parseQueuedSubmission(response?.queuedSubmission);
  if (!item) throw new Error("Invalid thread/queue/update response");
  return item;
}

export async function deleteThreadQueueMessage(
  rpc: NativeRpc,
  threadId: string,
  queuedSubmissionId: string,
): Promise<boolean> {
  const response = asRecord(
    await call(rpc, "thread/queue/delete", { threadId, queuedSubmissionId }),
  );
  return response?.deleted === true;
}

export async function reorderThreadQueue(
  rpc: NativeRpc,
  threadId: string,
  queuedSubmissionIds: readonly string[],
): Promise<void> {
  await call(rpc, "thread/queue/reorder", {
    threadId,
    queuedSubmissionIds: [...queuedSubmissionIds],
  });
}

/** New id order after moving one item up or down; null when it cannot move. */
export function moveQueueItemId(
  ids: readonly string[],
  itemId: string,
  direction: "up" | "down",
): string[] | null {
  const index = ids.indexOf(itemId);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= ids.length) {
    return null;
  }
  const next = [...ids];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/**
 * Moves one item using a fresh listing, since `thread/queue/reorder` must
 * name every queued submission exactly once (another client may have
 * changed the queue since this browser last listed it).
 */
export async function moveThreadQueueMessage(
  rpc: NativeRpc,
  threadId: string,
  queuedSubmissionId: string,
  direction: "up" | "down",
): Promise<boolean> {
  const ids = (await listRawQueue(rpc, threadId))
    .map((item) => asRecord(item)?.id)
    .filter((id): id is string => typeof id === "string");
  const next = moveQueueItemId(ids, queuedSubmissionId, direction);
  if (!next) return false;
  await reorderThreadQueue(rpc, threadId, next);
  return true;
}

export async function startThreadQueueMessage(
  rpc: NativeRpc,
  threadId: string,
  queuedSubmissionId: string | null,
): Promise<{ turnId: string | null }> {
  const response = asRecord(
    await call(rpc, "thread/queue/start", {
      threadId,
      ...(queuedSubmissionId ? { queuedSubmissionId } : {}),
    }),
  );
  const turn = asRecord(response?.turn);
  return { turnId: typeof turn?.id === "string" ? turn.id : null };
}

import { open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  ConversationParserState,
  parseConversationTextChunk,
} from "./conversation-parser";
import {
  inheritedHistoryChanged,
  readInheritedHistory,
  type InheritedHistoryFile,
  type SessionFileResolver,
} from "./conversation-history";
import type {
  CodexAppServerEvent,
  ConversationMessageWindow,
  StreamResult,
} from "./storage";

interface ConversationIndex {
  identity: string;
  fileId: string;
  offset: number;
  size: number;
  mtimeMs: number;
  anchor: Buffer;
  parser: ConversationParserState;
  inheritedBytes: number;
  inheritedMessages: number;
  inheritedFiles: InheritedHistoryFile[];
}

// Bound retained histories, and coalesce simultaneous readers of the same file.
const indexes = new Map<string, ConversationIndex>();
const reads = new Map<string, Promise<ConversationIndex>>();
const MAX_CACHED_FILES = 16;
const MAX_CACHED_BYTES = 64 * 1024 * 1024;

export function clearConversationIndexes(filePath?: string): void {
  if (filePath) indexes.delete(filePath);
  else indexes.clear();
}

async function readIndex(
  filePath: string,
  resolveSessionFile?: SessionFileResolver,
): Promise<ConversationIndex> {
  const pending = reads.get(filePath);
  if (pending) return pending;
  const read = refreshIndex(filePath, resolveSessionFile);
  reads.set(filePath, read);
  try {
    return await read;
  } finally {
    if (reads.get(filePath) === read) reads.delete(filePath);
  }
}

async function refreshIndex(
  filePath: string,
  resolveSessionFile?: SessionFileResolver,
): Promise<ConversationIndex> {
  const handle = await open(filePath, "r");
  try {
    const stats = await handle.stat();
    const identity = `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`;
    let index = indexes.get(filePath);
    if (index && (await inheritedHistoryChanged(index.inheritedFiles)))
      index = undefined;
    if (
      index &&
      (index.identity !== identity ||
        stats.size < index.size ||
        (stats.size === index.size && stats.mtimeMs !== index.mtimeMs))
    ) {
      index = undefined;
    }
    if (index && index.anchor.length) {
      const anchor = Buffer.alloc(index.anchor.length);
      const result = await handle.read(
        anchor,
        0,
        anchor.length,
        index.offset - anchor.length,
      );
      if (result.bytesRead !== anchor.length || !anchor.equals(index.anchor))
        index = undefined;
    }
    if (!index) {
      const parser = new ConversationParserState();
      const inherited = await readInheritedHistory(
        filePath,
        parser,
        resolveSessionFile,
      );
      index = {
        identity,
        fileId: `${identity}:${randomUUID()}`,
        offset: 0,
        size: 0,
        mtimeMs: 0,
        anchor: Buffer.alloc(0),
        parser,
        inheritedBytes: inherited.bytes,
        inheritedMessages: parser.messages.length,
        inheritedFiles: inherited.files,
      };
    }
    // Parse only appended bytes, with bounded reads and complete UTF-8 records.
    let position = index.offset;
    let remainder = Buffer.alloc(0);
    while (position < stats.size) {
      const buffer = Buffer.allocUnsafe(
        Math.min(1024 * 1024, stats.size - position),
      );
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (!bytesRead) break;
      position += bytesRead;
      const data = remainder.length
        ? Buffer.concat([remainder, buffer.subarray(0, bytesRead)])
        : buffer.subarray(0, bytesRead);
      const newline = data.lastIndexOf(10);
      const end = position >= stats.size ? data.length : newline + 1;
      const parsed = parseConversationTextChunk(
        data.subarray(0, end).toString("utf8"),
        index.inheritedBytes + index.offset,
        undefined,
        index.parser,
      );
      index.offset += parsed.consumedBytes;
      remainder = data.subarray(parsed.consumedBytes);
    }
    index.size = stats.size;
    index.mtimeMs = stats.mtimeMs;
    index.anchor = Buffer.alloc(Math.min(256, index.offset));
    if (index.anchor.length)
      await handle.read(
        index.anchor,
        0,
        index.anchor.length,
        index.offset - index.anchor.length,
      );
    indexes.delete(filePath);
    indexes.set(filePath, index);
    let cachedBytes = [...indexes.values()].reduce(
      (sum, entry) => sum + entry.size + entry.inheritedBytes,
      0,
    );
    for (const [path, entry] of indexes) {
      if (indexes.size <= MAX_CACHED_FILES && cachedBytes <= MAX_CACHED_BYTES)
        break;
      if (
        path === filePath ||
        entry.parser.messages.some((message) => message.streaming)
      )
        continue;
      indexes.delete(path);
      cachedBytes -= entry.size + entry.inheritedBytes;
    }
    return index;
  } finally {
    await handle.close();
  }
}

function presentMessage(
  index: ConversationIndex,
  message: ConversationIndex["parser"]["messages"][number],
) {
  if ((message.sequence ?? 0) <= index.inheritedMessages) {
    return {
      ...message,
      editable: false,
      editId: undefined,
      editText: undefined,
    };
  }
  if (index.inheritedBytes && message.editId?.startsWith("offset:")) {
    return {
      ...message,
      editId: message.editId.replace(
        /^offset:(\d+):/,
        (_, offset) => `offset:${Number(offset) - index.inheritedBytes}:`,
      ),
    };
  }
  return message;
}

export async function readConversationMessageWindow(
  filePath: string,
  beforeSequence?: number,
  resolveSessionFile?: SessionFileResolver,
): Promise<ConversationMessageWindow> {
  const index = await readIndex(filePath, resolveSessionFile);
  const messages = index.parser.messages;
  const end =
    beforeSequence === undefined
      ? messages.length
      : Math.max(0, Math.min(messages.length, Math.floor(beforeSequence) - 1));
  let start = 0;
  if (beforeSequence === undefined) {
    // Bootstrap the actual final page, including lifecycle records beside it.
    const firstNumber =
      Math.floor(Math.max(0, index.parser.visibleCount - 1) / 100) * 100 + 1;
    const first = messages.findIndex(
      (message) => (message.messageNumber ?? 0) >= firstNumber,
    );
    start = first >= 0 ? first : 0;
    while (start > 0 && messages[start - 1].messageNumber === undefined)
      start -= 1;
  } else {
    start = Math.max(0, end - 500);
  }
  const budget = beforeSequence === undefined ? 128 * 1024 : 512 * 1024;
  let bytes = 0;
  let boundedStart = end;
  while (boundedStart > start) {
    const size = Buffer.byteLength(JSON.stringify(messages[boundedStart - 1]));
    if (boundedStart < end && bytes + size > budget) break;
    bytes += size;
    boundedStart -= 1;
  }
  start = boundedStart;
  return {
    messages: messages
      .slice(start, end)
      .map((message) => presentMessage(index, message)),
    historyStartSequence: start === 0 ? 0 : start + 1,
    nextOffset: index.parser.version,
    done: true,
    fileId: index.fileId,
    totalMessages: index.parser.visibleCount,
  };
}

export async function readConversationMessageUpdates(
  filePath: string,
  fromOffset: number,
  maxPayloadBytes = 128 * 1024,
  resolveSessionFile?: SessionFileResolver,
): Promise<StreamResult> {
  const index = await readIndex(filePath, resolveSessionFile);
  const candidates = index.parser.messages.filter(
    (message) => message.revision! > fromOffset,
  );
  candidates.sort((a, b) => a.revision! - b.revision!);
  let bytes = 0;
  let end = 0;
  while (end < candidates.length) {
    const message = candidates[end];
    const size = Buffer.byteLength(JSON.stringify(message));
    if (end > 0 && bytes + size > maxPayloadBytes) break;
    bytes += size;
    end += 1;
  }
  const done = end === candidates.length;
  return {
    messages: candidates
      .slice(0, end)
      .map((message) => presentMessage(index, message)),
    nextOffset: done ? index.parser.version : candidates[end - 1].revision!,
    done,
    fileId: index.fileId,
    totalMessages: index.parser.visibleCount,
  };
}

/** Events are ingested in app-server order, before they fan out to any browser. */
export async function applyConversationLiveEvent(
  filePath: string,
  event: CodexAppServerEvent,
  resolveSessionFile?: SessionFileResolver,
): Promise<void> {
  const index = await readIndex(filePath, resolveSessionFile);
  const state = index.parser;
  switch (event.type) {
    case "assistant_delta":
    case "plan_delta":
      state.applyStreamText(
        event.turnId,
        event.itemId,
        "assistant",
        event.delta,
      );
      break;
    case "reasoning_summary_delta":
      state.applyStreamText(
        event.turnId,
        event.itemId,
        "reasoning",
        event.delta,
      );
      break;
    case "reasoning_text_delta":
      state.applyStreamText(
        event.turnId,
        event.itemId,
        "agent_reasoning",
        event.delta,
      );
      break;
    case "item_completed":
      state.completeStreamItem(event.turnId, event.itemId, event.item);
      break;
    case "thread_status":
      if (
        event.turnId &&
        (event.status === "idle" || event.status === "systemError")
      )
        state.completeStreamTurn(event.turnId);
      break;
  }
}

export async function readConversationMessageSnapshot(
  filePath: string,
  resolveSessionFile?: SessionFileResolver,
) {
  const index = await readIndex(filePath, resolveSessionFile);
  return index.parser.messages.map((message) => presentMessage(index, message));
}

import { open, stat } from "node:fs/promises";
import type { ConversationParserState } from "./conversation-parser";
import { parseConversationTextChunk } from "./conversation-parser";

export type SessionFileResolver = (sessionId: string) => Promise<string | null>;

export interface InheritedHistoryFile {
  path: string;
  identity: string;
  size: number;
  mtimeMs: number;
  end: number;
  anchor: Buffer;
}

function identity(stats: Awaited<ReturnType<typeof stat>>): string {
  return `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`;
}

function parseRecord(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    // Match the conversation parser's handling of malformed log records.
    return null;
  }
}

async function readMetadata(path: string) {
  const handle = await open(path, "r");
  try {
    const chunks: Buffer[] = [];
    let position = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (!bytesRead) break;
      position += bytesRead;
      const data = buffer.subarray(0, bytesRead);
      const newline = data.indexOf(10);
      chunks.push(newline < 0 ? data : data.subarray(0, newline));
      if (newline >= 0) break;
    }
    const record = parseRecord(Buffer.concat(chunks).toString("utf8"));
    return record?.type === "session_meta" ? record : null;
  } finally {
    await handle.close();
  }
}

/** Replay the immutable parent prefix before this fork's own append-only log. */
export async function readInheritedHistory(
  filePath: string,
  parser: ConversationParserState,
  resolveSessionFile?: SessionFileResolver,
): Promise<{ bytes: number; files: InheritedHistoryFile[] }> {
  const files: InheritedHistoryFile[] = [];
  const visited = new Set<string>([filePath]);
  let bytes = 0;

  const visit = async (path: string, end?: number, ordinalLimit?: number) => {
    const meta = await readMetadata(path);
    const payload = meta?.payload as Record<string, unknown> | undefined;
    const base = payload?.history_base as Record<string, unknown> | undefined;
    if (base != null) {
      if (
        typeof base.thread_id !== "string" ||
        typeof base.end_byte_offset !== "number" ||
        !Number.isSafeInteger(base.end_byte_offset) ||
        base.end_byte_offset < 0 ||
        typeof base.end_ordinal_exclusive !== "number" ||
        !Number.isSafeInteger(base.end_ordinal_exclusive) ||
        base.end_ordinal_exclusive < 0
      )
        throw new Error("Invalid fork history reference");
      const parent = await resolveSessionFile?.(base.thread_id);
      if (!parent)
        throw new Error(`Fork history source ${base.thread_id} is unavailable`);
      if (visited.has(parent)) throw new Error("Cyclic fork history reference");
      visited.add(parent);
      await visit(
        parent,
        base.end_byte_offset,
        Math.min(base.end_ordinal_exclusive, ordinalLimit ?? Infinity),
      );
    }
    if (end === undefined) return;
    const handle = await open(path, "r");
    try {
      const stats = await handle.stat();
      if (end > stats.size)
        throw new Error("Fork history source was truncated");
      let position = 0;
      let remainder = Buffer.alloc(0);
      let reachedLimit = false;
      // Legacy root logs have no ordinals. Count their records from zero;
      // a referenced fork's own records begin after its inherited prefix.
      let ordinal =
        typeof meta?.ordinal === "number"
          ? meta.ordinal
          : typeof base?.end_ordinal_exclusive === "number"
            ? base.end_ordinal_exclusive
            : 0;
      const isBeyondLimit = (line: Buffer) => {
        const record = parseRecord(line.toString("utf8"));
        const recordOrdinal =
          typeof record?.ordinal === "number" ? record.ordinal : ordinal;
        if (record) ordinal = recordOrdinal + 1;
        return record != null && recordOrdinal >= (ordinalLimit ?? Infinity);
      };
      const replay = (data: Buffer) => {
        const parsed = parseConversationTextChunk(
          data.toString("utf8"),
          bytes,
          undefined,
          parser,
        );
        bytes += parsed.consumedBytes;
        if (parsed.consumedBytes !== data.length)
          throw new Error("Fork history reference ends inside a log record");
      };
      while (position < end && !reachedLimit) {
        const buffer = Buffer.allocUnsafe(
          Math.min(1024 * 1024, end - position),
        );
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          position,
        );
        if (!bytesRead) throw new Error("Fork history source was truncated");
        position += bytesRead;
        const data = Buffer.concat([remainder, buffer.subarray(0, bytesRead)]);
        let consumed = 0;
        while (consumed < data.length) {
          const newline = data.indexOf(10, consumed);
          if (newline < 0) break;
          const line = data.subarray(consumed, newline + 1);
          if (isBeyondLimit(line)) {
            reachedLimit = true;
            break;
          }
          consumed = newline + 1;
        }
        if (consumed) replay(data.subarray(0, consumed));
        remainder = data.subarray(consumed);
      }
      if (!reachedLimit && remainder.length && !isBeyondLimit(remainder))
        replay(remainder);
      const anchor = Buffer.alloc(Math.min(256, end));
      if (anchor.length)
        await handle.read(anchor, 0, anchor.length, end - anchor.length);
      files.push({
        path,
        identity: identity(stats),
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        end,
        anchor,
      });
    } finally {
      await handle.close();
    }
  };
  await visit(filePath);
  // Records in the parent file cannot be edited through the fork's file offsets.
  parser.pendingEditableLines.clear();
  parser.responseMessageIndexes.clear();
  return { bytes, files };
}

export async function inheritedHistoryChanged(
  files: InheritedHistoryFile[],
): Promise<boolean> {
  for (const file of files) {
    try {
      const stats = await stat(file.path);
      if (
        identity(stats) !== file.identity ||
        stats.size < file.end ||
        (stats.mtimeMs !== file.mtimeMs && stats.size <= file.size)
      )
        return true;
      if (stats.mtimeMs !== file.mtimeMs) {
        const handle = await open(file.path, "r");
        try {
          const anchor = Buffer.alloc(file.anchor.length);
          const { bytesRead } = await handle.read(
            anchor,
            0,
            anchor.length,
            file.end - anchor.length,
          );
          if (bytesRead !== anchor.length || !anchor.equals(file.anchor))
            return true;
        } finally {
          await handle.close();
        }
        file.size = stats.size;
        file.mtimeMs = stats.mtimeMs;
      }
    } catch {
      return true;
    }
  }
  return false;
}

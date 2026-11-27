import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Developer-level context attached to a Codex thread by Codex Deck (for
 * example by a beforeFirstMessage plugin hook).
 *
 * Codex records turn/start `additionalContext` as a developer message in the
 * thread history. That message persists across turns and restarts, but a
 * compaction or rollback can drop it. Each thread's blocks are therefore kept
 * here and re-attached on the next turn/start whenever they may be missing.
 */
export const THREAD_CONTEXT_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MAX_THREAD_CONTEXT_VALUE_BYTES = 64 * 1024;
export const MAX_THREAD_CONTEXT_TOTAL_BYTES = 192 * 1024;

export interface ThreadContextEntry {
  value: string;
  updatedAt: number;
}

export interface ThreadContextRecord {
  threadId: string;
  /** Keyed by source; Codex wraps each value in a `<key>` tag. */
  entries: Record<string, ThreadContextEntry>;
  /** True when the next turn/start must attach the entries. */
  pending: boolean;
  injections: number;
  reinjections: number;
  lastInjectedAt: number | null;
  /** Turn that most recently carried the blocks into history. */
  injectedTurnId: string | null;
  updatedAt: number;
}

export type CodexAdditionalContext = Record<
  string,
  { value: string; kind: "application" }
>;

const fileName = (threadId: string) =>
  `${threadId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 160)}.json`;

/** Validate and normalize caller-supplied context blocks. */
export function normalizeThreadContext(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries: Record<string, string> = {};
  let total = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (!THREAD_CONTEXT_KEY_PATTERN.test(key)) {
      throw new Error(`Invalid thread context key "${key}".`);
    }
    if (typeof raw !== "string") {
      throw new Error(`Thread context "${key}" must be a string.`);
    }
    const text = raw.trim();
    if (!text) continue;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_THREAD_CONTEXT_VALUE_BYTES) {
      throw new Error(`Thread context "${key}" is larger than 64 KiB.`);
    }
    total += bytes;
    entries[key] = text;
  }
  if (total > MAX_THREAD_CONTEXT_TOTAL_BYTES) {
    throw new Error("Thread context is larger than 192 KiB.");
  }
  return entries;
}

export class ThreadContextStore {
  private locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly directory: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  private path(threadId: string): string {
    return join(this.directory(), fileName(threadId));
  }

  /** Serialize changes per thread; reads and writes are atomic replaces. */
  private lock<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(threadId) ?? Promise.resolve())
      .catch(() => {})
      .then(work);
    this.locks.set(threadId, next);
    void next
      .finally(() => {
        if (this.locks.get(threadId) === next) this.locks.delete(threadId);
      })
      .catch(() => {});
    return next;
  }

  async read(threadId: string): Promise<ThreadContextRecord | null> {
    let text: string;
    try {
      text = await readFile(this.path(threadId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const record = JSON.parse(text) as ThreadContextRecord;
      return record && typeof record.entries === "object" ? record : null;
    } catch {
      return null;
    }
  }

  private async write(record: ThreadContextRecord): Promise<void> {
    const path = this.path(record.threadId);
    await mkdir(this.directory(), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(record)}\n`, {
        mode: 0o600,
      });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  /** Add or replace blocks by key; they are attached to the next turn. */
  add(threadId: string, entries: Record<string, string>): Promise<void> {
    const keys = Object.keys(entries);
    if (!keys.length) return Promise.resolve();
    return this.lock(threadId, async () => {
      const record = (await this.read(threadId)) ?? {
        threadId,
        entries: {},
        pending: false,
        injections: 0,
        reinjections: 0,
        lastInjectedAt: null,
        injectedTurnId: null,
        updatedAt: this.now(),
      };
      for (const key of keys) {
        record.entries[key] = { value: entries[key], updatedAt: this.now() };
      }
      record.pending = true;
      record.updatedAt = this.now();
      await this.write(record);
    });
  }

  /** Blocks to attach to the next turn/start, or null when none are needed. */
  async pendingContext(
    threadId: string,
  ): Promise<CodexAdditionalContext | null> {
    const record = await this.read(threadId);
    if (!record?.pending) return null;
    const entries = Object.entries(record.entries);
    if (!entries.length) return null;
    return Object.fromEntries(
      entries.map(([key, entry]) => [
        key,
        { value: entry.value, kind: "application" as const },
      ]),
    );
  }

  /** Codex accepted a turn carrying the blocks. */
  markInjected(threadId: string, turnId: string | null): Promise<void> {
    return this.lock(threadId, async () => {
      const record = await this.read(threadId);
      if (!record?.pending) return;
      record.pending = false;
      if (record.injections > 0) record.reinjections++;
      record.injections++;
      record.lastInjectedAt = this.now();
      record.injectedTurnId = turnId;
      record.updatedAt = this.now();
      await this.write(record);
    });
  }

  /** History may no longer contain the blocks (compaction or rollback). */
  markMissing(threadId: string): Promise<void> {
    return this.lock(threadId, async () => {
      const record = await this.read(threadId);
      if (!record || record.pending || !Object.keys(record.entries).length)
        return;
      record.pending = true;
      record.updatedAt = this.now();
      await this.write(record);
    });
  }

  /**
   * A fork inherits the parent's blocks. When the fork may not contain the
   * turn that carried them (a truncated fork or a side chat without turns),
   * they are attached again on the fork's next turn.
   */
  copy(
    fromThreadId: string,
    toThreadId: string,
    options: { historyMayLackContext: boolean },
  ): Promise<void> {
    return this.lock(toThreadId, async () => {
      const source = await this.read(fromThreadId);
      if (!source || !Object.keys(source.entries).length) return;
      await this.write({
        ...source,
        threadId: toThreadId,
        pending: source.pending || options.historyMayLackContext,
        injections: 0,
        reinjections: 0,
        injectedTurnId: options.historyMayLackContext
          ? null
          : source.injectedTurnId,
        updatedAt: this.now(),
      });
    });
  }
}

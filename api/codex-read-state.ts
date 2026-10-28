import { nativeRecord, type NativeRpc } from "./codex-native";

export type ThreadUnreadPosition =
  | { type: "threadStart" }
  | { type: "turn"; turnId: string };

/** Durable read receipt kept by the app-server; `firstUnread: null` means read. */
export interface ThreadReadState {
  firstUnread: ThreadUnreadPosition | null;
  revision: string;
}

export interface ThreadReadStatesSnapshot {
  /** False when the connected app-server does not expose durable read state. */
  available: boolean;
  /** Receipts keyed by thread ID. Absent keys are ineligible or older rows. */
  states: Record<string, ThreadReadState>;
}

export type ThreadReadStateOperation = "read" | "unread";

export type ThreadReadStateUpdateResult =
  | { status: "applied" | "conflict"; readState: ThreadReadState }
  | { status: "unavailable"; readState: null; message: string };

const READ_STATE_PAGE_SIZE = 100;
const READ_STATE_MAX_PAGES = 3;
const READ_STATE_CACHE_MS = 1_000;

export function parseThreadReadState(value: unknown): ThreadReadState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.revision !== "string" || !record.revision) return null;
  const position = record.firstUnread;
  if (position === null || position === undefined)
    return { firstUnread: null, revision: record.revision };
  if (!position || typeof position !== "object" || Array.isArray(position))
    return null;
  const typed = position as Record<string, unknown>;
  if (typed.type === "threadStart")
    return { firstUnread: { type: "threadStart" }, revision: record.revision };
  if (typed.type === "turn" && typeof typed.turnId === "string")
    return {
      firstUnread: { type: "turn", turnId: typed.turnId },
      revision: record.revision,
    };
  return null;
}

function errorCode(error: unknown): number | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Older or state-DB-less app-servers reject the method or report no receipts. */
export function isReadStateUnsupportedError(error: unknown): boolean {
  if (errorCode(error) === -32601) return true;
  return /read state unavailable|unknown variant|method not found|not supported/i.test(
    errorMessage(error),
  );
}

function conflictState(error: unknown): ThreadReadState | null {
  const data = (error as { data?: unknown } | null)?.data;
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  return record.reason === "readStateConflict"
    ? parseThreadReadState(record.readState)
    : null;
}

/**
 * Shared read receipts. Every Deck client reads the same app-server state and
 * is notified through `native_state_changed` (scope `readState`) after edits
 * or upstream `thread/readState/changed` notifications.
 */
export class ThreadReadStateService {
  private cache: { at: number; snapshot: ThreadReadStatesSnapshot } | null =
    null;
  private inFlight: Promise<ThreadReadStatesSnapshot> | null = null;
  private generation = 0;

  public constructor(
    private readonly rpc: NativeRpc,
    private readonly notify: (threadId: string | null) => void,
    private readonly now: () => number = Date.now,
  ) {}

  public list(): Promise<ThreadReadStatesSnapshot> {
    if (this.cache && this.now() - this.cache.at < READ_STATE_CACHE_MS)
      return Promise.resolve(this.cache.snapshot);
    if (this.inFlight) return this.inFlight;
    const generation = this.generation;
    const load = this.load()
      .then((snapshot) => {
        if (generation === this.generation)
          this.cache = { at: this.now(), snapshot };
        return snapshot;
      })
      .finally(() => {
        if (this.inFlight === load) this.inFlight = null;
      });
    this.inFlight = load;
    return load;
  }

  private async load(): Promise<ThreadReadStatesSnapshot> {
    const states: Record<string, ThreadReadState> = {};
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < READ_STATE_MAX_PAGES; page++) {
      let result: Record<string, unknown>;
      try {
        result = nativeRecord(
          await this.rpc("thread/list", {
            limit: READ_STATE_PAGE_SIZE,
            sortKey: "updated_at",
            useStateDbOnly: true,
            ...(cursor ? { cursor } : {}),
          }),
        );
      } catch (error) {
        if (page === 0 && isReadStateUnsupportedError(error))
          return { available: false, states: {} };
        throw error;
      }
      const readStates = result.readStates;
      if (
        !readStates ||
        typeof readStates !== "object" ||
        Array.isArray(readStates)
      ) {
        if (page === 0) return { available: false, states: {} };
        break;
      }
      for (const [threadId, value] of Object.entries(readStates)) {
        const state = parseThreadReadState(value);
        if (threadId && state) states[threadId] = state;
      }
      const next = result.nextCursor;
      if (typeof next !== "string" || !next || seen.has(next)) break;
      seen.add(next);
      cursor = next;
    }
    return { available: true, states };
  }

  private invalidate(threadId: string | null) {
    this.generation += 1;
    this.cache = null;
    this.inFlight = null;
    this.notify(threadId);
  }

  public async update(
    threadId: string,
    operation: ThreadReadStateOperation,
    expectedRevision: string,
  ): Promise<ThreadReadStateUpdateResult> {
    let result: Record<string, unknown>;
    try {
      result = nativeRecord(
        await this.rpc("thread/readState/update", {
          threadId,
          operation: { type: operation },
          expectedRevision,
        }),
      );
    } catch (error) {
      const latest = conflictState(error);
      if (latest) {
        // Never retry automatically: the caller has not seen this newer state.
        this.invalidate(threadId);
        return { status: "conflict", readState: latest };
      }
      if (isReadStateUnsupportedError(error))
        return {
          status: "unavailable",
          readState: null,
          message: errorMessage(error),
        };
      throw error;
    }
    const readState = parseThreadReadState(result.readState);
    if (!readState) throw new Error("Invalid thread read-state response");
    this.invalidate(threadId);
    return { status: "applied", readState };
  }

  public handleNotification(method: string, params: unknown): boolean {
    if (method !== "thread/readState/changed") return false;
    const record =
      params && typeof params === "object"
        ? (params as Record<string, unknown>)
        : null;
    const threadId =
      typeof record?.threadId === "string" ? record.threadId : null;
    this.invalidate(threadId);
    return true;
  }
}

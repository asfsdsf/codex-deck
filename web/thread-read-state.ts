import type {
  ThreadReadState,
  ThreadReadStatesSnapshot,
  ThreadReadStateUpdateResult,
} from "@codex-deck/api";
import type { SessionStatus } from "./session-status";

export type ReadReceipt = "read" | "unread";

export const EMPTY_READ_STATES: ThreadReadStatesSnapshot = {
  available: false,
  states: {},
};

/** Durable receipt for a row, or null when Codex has none (use local status). */
export function getReadReceipt(
  snapshot: ThreadReadStatesSnapshot,
  threadId: string,
): ReadReceipt | null {
  if (!snapshot.available) return null;
  const state = snapshot.states[threadId];
  if (!state) return null;
  return state.firstUnread ? "unread" : "read";
}

/**
 * Combines Deck's browser-local turn tracking with the shared durable receipt.
 * A running turn always wins; otherwise the shared receipt replaces the
 * browser-local "unreviewed" marker when Codex provides one for the row.
 */
export function resolveSessionReadStatus(
  localStatus: SessionStatus,
  receipt: ReadReceipt | null,
): SessionStatus {
  if (localStatus === "running" || receipt === null) return localStatus;
  return receipt === "unread" ? "unreviewed" : "completed";
}

export function applyReadStateResult(
  snapshot: ThreadReadStatesSnapshot,
  threadId: string,
  result: ThreadReadStateUpdateResult,
): ThreadReadStatesSnapshot {
  if (result.status === "unavailable") return EMPTY_READ_STATES;
  return {
    available: true,
    states: { ...snapshot.states, [threadId]: result.readState },
  };
}

/** Viewing an unread thread marks it read once per revision actually seen. */
export function shouldAutoMarkRead(
  state: ThreadReadState | undefined,
  attemptedRevision: string | undefined,
  suppressed: boolean,
): state is ThreadReadState {
  return (
    !!state &&
    state.firstUnread !== null &&
    !suppressed &&
    attemptedRevision !== state.revision
  );
}

const AUTO_MARK_READ_RETRY_BASE_MS = 1_000;
const AUTO_MARK_READ_MAX_FAILURES = 5;

/**
 * Backoff before retrying a failed automatic mark-as-read (for example when
 * the app-server is briefly overloaded). Returns null once the page should
 * stop retrying the same revision.
 */
export function autoMarkReadRetryDelay(failures: number): number | null {
  if (failures < 1 || failures > AUTO_MARK_READ_MAX_FAILURES) return null;
  return AUTO_MARK_READ_RETRY_BASE_MS * 2 ** (failures - 1);
}

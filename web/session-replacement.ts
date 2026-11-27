import type { Session } from "@codex-deck/api";

/**
 * Point a locally listed session at the thread that replaced it. The entry
 * keeps its place; a stale duplicate of the new ID is dropped.
 */
export function replaceSessionId(
  sessions: Session[],
  fromSessionId: string,
  toSessionId: string,
): Session[] {
  if (fromSessionId === toSessionId) return sessions;
  if (!sessions.some((session) => session.id === fromSessionId))
    return sessions;
  return sessions
    .filter((session) => session.id !== toSessionId)
    .map((session) =>
      session.id === fromSessionId ? { ...session, id: toSessionId } : session,
    );
}

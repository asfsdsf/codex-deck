interface SessionIdLike {
  id: string;
}

export interface StableSessionIdsResult {
  sessionIds: string[];
  sessionIdsKey: string;
}

export function getStableSessionIds(
  sessions: readonly SessionIdLike[],
): StableSessionIdsResult {
  const sessionIds = [...new Set(sessions.map((session) => session.id))].sort();
  return {
    sessionIds,
    sessionIdsKey: sessionIds.join(","),
  };
}

export interface SessionSelectionItem {
  id: string;
}

export function normalizeSessionSelectionId(sessionId: string): string {
  return sessionId.trim();
}

export function isKnownSessionSelection(
  sessionId: string,
  sessions: readonly SessionSelectionItem[],
): boolean {
  const normalizedSessionId = normalizeSessionSelectionId(sessionId);
  if (!normalizedSessionId) {
    return false;
  }

  return sessions.some((session) => session.id === normalizedSessionId);
}

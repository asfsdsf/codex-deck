export interface SessionSelectionItem {
  id: string;
  display?: string;
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

export function resolveSessionSelection(
  query: string,
  sessions: readonly SessionSelectionItem[],
): SessionSelectionItem | null {
  const normalizedQuery = normalizeSessionSelectionId(query);
  if (!normalizedQuery) {
    return null;
  }

  const exactId = sessions.find((session) => session.id === normalizedQuery);
  if (exactId) {
    return exactId;
  }

  const lowerQuery = normalizedQuery.toLowerCase();
  return (
    sessions.find((session) => session.display?.trim() === normalizedQuery) ??
    sessions.find(
      (session) => session.display?.trim().toLowerCase() === lowerQuery,
    ) ??
    sessions.find((session) => session.id.startsWith(normalizedQuery)) ??
    null
  );
}

export type PendingUserMessageStatus =
  | "queued"
  | "sending"
  | "awaiting_confirmation";

export interface PendingUserMessage {
  pendingId: string;
  text: string;
  images: string[];
  status: PendingUserMessageStatus;
  turnId?: string | null;
}

export type PendingUserMessagesBySession = Record<string, PendingUserMessage[]>;

export function appendPendingUserMessage(
  previous: PendingUserMessagesBySession,
  sessionId: string,
  message: PendingUserMessage,
): PendingUserMessagesBySession {
  const current = previous[sessionId] ?? [];
  return {
    ...previous,
    [sessionId]: [...current, message],
  };
}

export function updatePendingUserMessageStatus(
  previous: PendingUserMessagesBySession,
  sessionId: string,
  pendingId: string,
  status: PendingUserMessageStatus,
  turnId?: string | null,
): PendingUserMessagesBySession {
  const current = previous[sessionId];
  if (!Array.isArray(current) || current.length === 0) {
    return previous;
  }

  let changed = false;
  const next = current.map((entry) => {
    if (entry.pendingId !== pendingId) {
      return entry;
    }

    const normalizedTurnId = turnId?.trim() || null;
    const shouldUpdateTurnId =
      turnId !== undefined && entry.turnId !== normalizedTurnId;
    if (entry.status === status && !shouldUpdateTurnId) {
      return entry;
    }

    changed = true;
    return {
      ...entry,
      status,
      ...(turnId !== undefined ? { turnId: normalizedTurnId } : {}),
    };
  });

  if (!changed) {
    return previous;
  }

  return {
    ...previous,
    [sessionId]: next,
  };
}

export function removePendingUserMessage(
  previous: PendingUserMessagesBySession,
  sessionId: string,
  pendingId: string,
): PendingUserMessagesBySession {
  const current = previous[sessionId];
  if (!Array.isArray(current) || current.length === 0) {
    return previous;
  }

  const next = current.filter((entry) => entry.pendingId !== pendingId);
  if (next.length === current.length) {
    return previous;
  }

  return {
    ...previous,
    [sessionId]: next,
  };
}

export function getPendingUserMessage(
  previous: PendingUserMessagesBySession,
  sessionId: string,
  pendingId: string,
): PendingUserMessage | null {
  const current = previous[sessionId];
  if (!Array.isArray(current) || current.length === 0) {
    return null;
  }

  return current.find((entry) => entry.pendingId === pendingId) ?? null;
}

export function nextQueuedPendingUserMessage(
  previous: PendingUserMessagesBySession,
  sessionId: string,
): PendingUserMessage | null {
  const current = previous[sessionId];
  if (!Array.isArray(current) || current.length === 0) {
    return null;
  }

  return current.find((entry) => entry.status === "queued") ?? null;
}

export function hasQueuedPendingUserMessages(
  previous: PendingUserMessagesBySession,
  sessionId: string,
): boolean {
  return nextQueuedPendingUserMessage(previous, sessionId) !== null;
}

export function consumeConfirmedPendingUserMessages(
  previous: PendingUserMessagesBySession,
  sessionId: string,
  confirmedCountDelta: number,
): PendingUserMessagesBySession {
  if (!Number.isFinite(confirmedCountDelta) || confirmedCountDelta <= 0) {
    return previous;
  }

  const current = previous[sessionId];
  if (!Array.isArray(current) || current.length === 0) {
    return previous;
  }

  // Only messages that were actually sent to the server can show up in the
  // confirmed history; entries still queued locally must never be consumed.
  let removeCount = Math.min(
    current.filter((entry) => entry.status !== "queued").length,
    Math.floor(confirmedCountDelta),
  );
  if (removeCount <= 0) {
    return previous;
  }

  const next = current.filter((entry) => {
    if (entry.status === "queued" || removeCount <= 0) {
      return true;
    }
    removeCount -= 1;
    return false;
  });

  return {
    ...previous,
    [sessionId]: next,
  };
}

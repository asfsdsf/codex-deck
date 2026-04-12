export type PendingUserMessageStatus = "sending" | "awaiting_confirmation";

export interface PendingUserMessage {
  pendingId: string;
  text: string;
  images: string[];
  status: PendingUserMessageStatus;
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
): PendingUserMessagesBySession {
  const current = previous[sessionId];
  if (!Array.isArray(current) || current.length === 0) {
    return previous;
  }

  let changed = false;
  const next = current.map((entry) => {
    if (entry.pendingId !== pendingId || entry.status === status) {
      return entry;
    }
    changed = true;
    return {
      ...entry,
      status,
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

  const removeCount = Math.min(current.length, Math.floor(confirmedCountDelta));
  if (removeCount <= 0) {
    return previous;
  }

  return {
    ...previous,
    [sessionId]: current.slice(removeCount),
  };
}

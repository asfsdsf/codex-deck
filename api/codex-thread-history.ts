/**
 * Conversation-history operations backed by app-server v2: forking at a turn
 * boundary (`thread/fork`), rewinding (`thread/revert`), and durable thread
 * attachments (`thread/attachment/*`).
 */

/** Exactly one boundary, matching `ThreadForkParams.lastTurnId|beforeTurnId`. */
export type CodexForkBoundary =
  | { lastTurnId: string; beforeTurnId?: undefined }
  | { beforeTurnId: string; lastTurnId?: undefined };

export class ThreadHistoryRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 = 400,
  ) {
    super(message);
    this.name = "ThreadHistoryRequestError";
  }
}

const TURN_ID_MAX_LENGTH = 256;

function turnIdValue(value: unknown, name: string): string | undefined {
  if (value == null) return undefined;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > TURN_ID_MAX_LENGTH
  )
    throw new ThreadHistoryRequestError(`${name} must be a turn ID.`);
  return value.trim();
}

/** Validates a fork boundary request body; `null` means fork the whole thread. */
export function parseForkBoundary(body: unknown): CodexForkBoundary | null {
  if (body == null) return null;
  if (typeof body !== "object" || Array.isArray(body))
    throw new ThreadHistoryRequestError("Fork options must be an object.");
  const record = body as Record<string, unknown>;
  const lastTurnId = turnIdValue(record.lastTurnId, "lastTurnId");
  const beforeTurnId = turnIdValue(record.beforeTurnId, "beforeTurnId");
  if (lastTurnId && beforeTurnId)
    throw new ThreadHistoryRequestError(
      "lastTurnId cannot be combined with beforeTurnId.",
    );
  if (lastTurnId) return { lastTurnId };
  if (beforeTurnId) return { beforeTurnId };
  return null;
}

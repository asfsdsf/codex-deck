import { nativeRecord, type NativeRpc } from "./codex-native";

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

export function parseRevertTurnId(body: unknown): string {
  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const beforeTurnId = turnIdValue(record.beforeTurnId, "beforeTurnId");
  if (!beforeTurnId)
    throw new ThreadHistoryRequestError("beforeTurnId is required.");
  return beforeTurnId;
}

/** The selected turn's opening prompt, restored to the composer after a rewind. */
export interface CodexRewoundPrompt {
  text: string;
  /** Images, audio, and other inputs that cannot be restored as composer text. */
  omittedInputCount: number;
}

export interface CodexThreadRevertResult {
  threadId: string;
  beforeTurnId: string;
  prompt: CodexRewoundPrompt | null;
}

export function promptFromUserInputs(content: unknown): CodexRewoundPrompt {
  const parts: string[] = [];
  let omittedInputCount = 0;
  for (const input of Array.isArray(content) ? content : []) {
    const record =
      input && typeof input === "object"
        ? (input as Record<string, unknown>)
        : {};
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    } else if (record.type === "skill" || record.type === "mention") {
      // Their text placeholders are already part of the text input.
      continue;
    } else {
      omittedInputCount += 1;
    }
  }
  return { text: parts.join("\n"), omittedInputCount };
}

function threadStatusType(thread: Record<string, unknown>): string | null {
  const status = thread.status;
  if (typeof status === "string") return status;
  if (status && typeof status === "object") {
    const type = (status as Record<string, unknown>).type;
    return typeof type === "string" ? type : null;
  }
  return null;
}

/**
 * Upstream TUI backtrack semantics: revert drops the selected turn and every
 * later turn, then the selected turn's opening prompt is returned for editing.
 * Workspace files are never reverted.
 */
export async function revertThreadBeforeTurn(
  rpc: NativeRpc,
  revert: NativeRpc,
  threadId: string,
  beforeTurnId: string,
): Promise<CodexThreadRevertResult> {
  const metadata = nativeRecord(
    await rpc("thread/read", { threadId, includeTurns: false }),
  );
  const thread = nativeRecord(metadata.thread);
  if (thread.ephemeral === true)
    throw new ThreadHistoryRequestError(
      "Ephemeral conversations cannot be rewound.",
      409,
    );
  if (thread.historyMode !== "paginated")
    throw new ThreadHistoryRequestError(
      "Rewind is only available for conversations with paginated history. Fork before this turn instead.",
      409,
    );
  if (threadStatusType(thread) === "active")
    throw new ThreadHistoryRequestError(
      "Stop the running turn before rewinding this conversation.",
      409,
    );

  const page = nativeRecord(
    await rpc("thread/items/list", {
      threadId,
      turnId: beforeTurnId,
      limit: 100,
      sortDirection: "asc",
    }),
  );
  if (!Array.isArray(page.data))
    throw new Error("Invalid thread/items/list response");
  let prompt: CodexRewoundPrompt | null = null;
  for (const entry of page.data) {
    const record =
      entry && typeof entry === "object"
        ? (entry as Record<string, unknown>)
        : {};
    const item =
      record.item && typeof record.item === "object"
        ? (record.item as Record<string, unknown>)
        : null;
    if (item?.type === "userMessage") {
      prompt = promptFromUserInputs(item.content);
      break;
    }
  }

  await revert("thread/revert", { threadId, beforeTurnId });
  return { threadId, beforeTurnId, prompt };
}

// Codex's reply envelope for request_user_input_async answers. Mirrors
// codex-rs `AnsweredQuestion` (writing) and the TUI's `async_question_reply`
// (reading), so answers from the web app, the TUI and the desktop app are
// recognized the same way.

const OPEN_TAG = "<send_user_message_question_reply>";
const CLOSE_TAG = "</send_user_message_question_reply>";
const IDE_CONTEXT_PREFIX = "# Context from my IDE setup:\n";
const IDE_REQUEST_MARKER = "\n## My request for Codex:\n";
const MAX_QUESTION_CHARS = 512;

export const ASYNC_QUESTION_TOOL_NAME = "request_user_input_async";

export interface AsyncQuestionReply {
  questionItemId: string;
  question: string;
  answer: string;
}

/** Matches the desktop's JSON.stringify([tool name, item id, question index]). */
export function getAsyncQuestionItemId(itemId: string, index: number): string {
  return JSON.stringify([ASYNC_QUESTION_TOOL_NAME, itemId, index]);
}

/** Returns the tool item id and question index, or null for message-level ids. */
export function parseAsyncQuestionItemId(
  questionItemId: string,
): { itemId: string; index: number } | null {
  try {
    const value: unknown = JSON.parse(questionItemId);
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      value[0] === ASYNC_QUESTION_TOOL_NAME &&
      typeof value[1] === "string" &&
      Number.isInteger(value[2]) &&
      value[2] >= 0
    ) {
      return { itemId: value[1], index: value[2] };
    }
  } catch {
    // Older desktop replies identify the whole source message instead.
  }
  return null;
}

export function buildAsyncQuestionReplyText(
  replies: readonly AsyncQuestionReply[],
): string {
  const payload = replies.map((reply) => ({
    answer: reply.answer,
    question: Array.from(reply.question)
      .slice(0, MAX_QUESTION_CHARS)
      .join("")
      .replace(/[\r\n]/g, " "),
    questionItemId: reply.questionItemId,
  }));
  return `${OPEN_TAG}\n${JSON.stringify(payload)}\n${CLOSE_TAG}`;
}

function isReply(value: unknown): value is AsyncQuestionReply {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.questionItemId === "string" &&
    typeof record.question === "string" &&
    typeof record.answer === "string"
  );
}

/** Only a complete envelope (optionally after the IDE context prefix) counts. */
export function parseAsyncQuestionReply(
  text: string,
): AsyncQuestionReply[] | null {
  let body = text.trim();
  if (body.startsWith(IDE_CONTEXT_PREFIX)) {
    const markerIndex = body.lastIndexOf(IDE_REQUEST_MARKER);
    if (markerIndex < 0) return null;
    body = body.slice(markerIndex + IDE_REQUEST_MARKER.length).trim();
  }
  if (!body.startsWith(OPEN_TAG) || !body.endsWith(CLOSE_TAG)) return null;
  let value: unknown;
  try {
    value = JSON.parse(body.slice(OPEN_TAG.length, -CLOSE_TAG.length));
  } catch {
    return null;
  }
  const replies = Array.isArray(value) ? value : [value];
  if (!replies.length || !replies.every(isReply)) return null;
  return replies.map(({ questionItemId, question, answer }) => ({
    questionItemId,
    question,
    answer,
  }));
}

export function getAsyncQuestionReplyDisplayText(text: string): string | null {
  const replies = parseAsyncQuestionReply(text);
  if (!replies) return null;
  return replies
    .map((reply) => `> ${reply.question}\n\n${reply.answer}`)
    .join("\n\n");
}

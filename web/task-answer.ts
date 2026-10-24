import type { ConversationMessage } from "@codex-deck/api";
import { isVisibleConversationMessage } from "../api/conversation-pagination";
import { sanitizeText } from "./utils";

/** Attach one set of answer actions after each completed task's last block. */
export function getCompletedTaskAnswers(
  messages: readonly ConversationMessage[],
): Map<ConversationMessage, ConversationMessage> {
  const completions = new Map<ConversationMessage, ConversationMessage>();
  let lastMessage: ConversationMessage | undefined;
  for (const message of messages) {
    if (message.type === "task_complete") {
      if (
        lastMessage &&
        (!message.turnId ||
          !lastMessage.turnId ||
          message.turnId === lastMessage.turnId)
      ) {
        completions.set(lastMessage, message);
      }
      lastMessage = undefined;
    } else if (
      ["task_started", "turn_aborted", "user"].includes(message.type)
    ) {
      lastMessage = undefined;
    } else if (isVisibleConversationMessage(message)) {
      lastMessage = message;
    }
  }
  return completions;
}

/** Every assistant text block for the task, including explanations and Markdown/commands. */
export function getCompletedTaskAnswer(
  messages: readonly ConversationMessage[],
  completion: ConversationMessage,
): string | null {
  const endIndex = messages.findIndex(
    (message) =>
      message.type === "task_complete" &&
      (!completion.turnId ||
        !message.turnId ||
        completion.turnId === message.turnId) &&
      (completion.sequence !== undefined
        ? message.sequence === completion.sequence
        : completion.uuid
          ? message.uuid === completion.uuid
          : message === completion ||
            (message.turnId === completion.turnId &&
              message.timestamp === completion.timestamp)),
  );
  if (endIndex < 0)
    throw new Error(
      "The completed task is no longer in this conversation. Refresh and try again.",
    );

  const paragraphs: string[] = [];
  for (let index = endIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      ["task_started", "task_complete", "turn_aborted", "user"].includes(
        message.type,
      )
    )
      break;
    if (
      message.type !== "assistant" ||
      message.streaming ||
      (completion.turnId &&
        message.turnId &&
        message.turnId !== completion.turnId)
    )
      continue;
    const content = message.message?.content;
    const text =
      typeof content === "string"
        ? sanitizeText(content)
        : (content ?? [])
            .filter((block) => block.type === "text")
            .map((block) => sanitizeText(block.text ?? ""))
            .filter(Boolean)
            .join("\n\n");
    const answer = text
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\r\n/g, "\n")
      .trim();
    if (!answer) continue;
    const plan = answer.match(
      /^<proposed_plan>\n([\s\S]*?)\n<\/proposed_plan>([\s\S]*)$/,
    );
    paragraphs.push(
      plan
        ? [plan[1].trim(), plan[2].trim()].filter(Boolean).join("\n\n")
        : answer,
    );
  }
  return paragraphs.length ? paragraphs.reverse().join("\n\n") : null;
}

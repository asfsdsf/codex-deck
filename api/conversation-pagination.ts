import type { ConversationMessage } from "./storage";

/** Shared with pagination: lifecycle records and single retry notices are hidden. */
export function isVisibleConversationMessage(
  message: ConversationMessage,
): boolean {
  return (
    [
      "user",
      "assistant",
      "reasoning",
      "agent_reasoning",
      "system_error",
      "turn_aborted",
      "thread_goal",
    ].includes(message.type) ||
    (message.type === "token_limit_notice" && (message.repeatCount ?? 1) > 1)
  );
}

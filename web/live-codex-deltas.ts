import type { ConversationMessage } from "@codex-deck/api";

export function isLiveConversationMessage(
  message: ConversationMessage,
): boolean {
  if (message.streaming !== undefined) return message.streaming;
  // Compatibility with older, unnumbered display messages.
  return typeof message.uuid === "string" && message.uuid.startsWith("live:");
}

import type { ConversationMessage } from "@codex-deck/api";

export function getTokenLimitNoticeRepeatCount(
  message: ConversationMessage,
): number | null {
  if (message.type !== "token_limit_notice") {
    return null;
  }

  return Math.max(1, message.repeatCount ?? 1);
}

export function shouldShowTokenLimitNotice(
  message: ConversationMessage,
): boolean {
  const repeatCount = getTokenLimitNoticeRepeatCount(message);
  return repeatCount === null || repeatCount > 1;
}

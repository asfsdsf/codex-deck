import type { ConversationMessage, TokenUsage } from "./storage";

export function isModelOutputMessage(message: ConversationMessage): boolean {
  if (message.type === "reasoning" || message.type === "agent_reasoning") {
    return true;
  }
  if (
    message.type !== "assistant" ||
    message.uuid?.includes(":context-compacted:")
  ) {
    return false;
  }
  const content = message.message?.content;
  return (
    typeof content === "string" ||
    (Array.isArray(content) && content.some((block) => block.type === "text"))
  );
}

export function getModelOutputTokenUsage(
  message: ConversationMessage,
): TokenUsage | undefined {
  if (!isModelOutputMessage(message)) return undefined;
  if (message.type === "assistant") return message.message?.usage;
  const content = message.message?.content;
  return Array.isArray(content)
    ? content.find((block) => block.type === message.type)?.token_usage
    : undefined;
}

export function withModelOutputTokenUsage(
  message: ConversationMessage,
  usage: TokenUsage,
): ConversationMessage | null {
  if (
    !isModelOutputMessage(message) ||
    !message.message ||
    getModelOutputTokenUsage(message)
  ) {
    return null;
  }
  if (message.type === "assistant") {
    return { ...message, message: { ...message.message, usage } };
  }
  const content = message.message.content;
  if (
    !Array.isArray(content) ||
    !content.some((block) => block.type === message.type)
  ) {
    return null;
  }
  return {
    ...message,
    message: {
      ...message.message,
      content: content.map((block) =>
        block.type === message.type ? { ...block, token_usage: usage } : block,
      ),
    },
  };
}

/** The latest uncounted model output can include both reasoning and reply text. */
export function attachTokenUsageToModelOutputs(
  messages: ConversationMessage[],
  usage: TokenUsage,
): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type === "user" || message.type === "task_started") return;
    if (!isModelOutputMessage(message)) continue;
    // A counted output marks an earlier model request. Never overwrite it.
    if (getModelOutputTokenUsage(message)) return;
    const updated = withModelOutputTokenUsage(message, usage);
    if (updated) messages[index] = updated;
  }
}

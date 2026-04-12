import type { ContentBlock, ConversationMessage } from "@codex-deck/api";

type ConversationInsertion = "append" | "prepend";

function getMessageContentBlocks(
  message: ConversationMessage,
): ContentBlock[] | null {
  if (message.type !== "assistant") {
    return null;
  }

  const content = message.message?.content;
  return Array.isArray(content) ? content : null;
}

function getPendingToolUseCallId(message: ConversationMessage): string | null {
  const blocks = getMessageContentBlocks(message);
  if (!blocks || blocks.length === 0) {
    return null;
  }

  if (blocks.some((block) => block.type === "tool_result")) {
    return null;
  }

  const toolUseBlock = blocks.find(
    (block): block is ContentBlock & { type: "tool_use"; id: string } =>
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      block.id.trim().length > 0,
  );

  return toolUseBlock ? toolUseBlock.id : null;
}

function getToolResultOnlyBlock(
  message: ConversationMessage,
): (ContentBlock & { type: "tool_result"; tool_use_id: string }) | null {
  const blocks = getMessageContentBlocks(message);
  if (!blocks || blocks.length !== 1) {
    return null;
  }

  const resultBlock = blocks[0];
  if (
    resultBlock.type !== "tool_result" ||
    typeof resultBlock.tool_use_id !== "string" ||
    resultBlock.tool_use_id.trim().length === 0
  ) {
    return null;
  }

  return resultBlock as ContentBlock & {
    type: "tool_result";
    tool_use_id: string;
  };
}

function getPairedToolCallId(message: ConversationMessage): string | null {
  const blocks = getMessageContentBlocks(message);
  if (!blocks || blocks.length < 2) {
    return null;
  }

  const toolUseBlock = blocks.find(
    (block): block is ContentBlock & { type: "tool_use"; id: string } =>
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      block.id.trim().length > 0,
  );
  if (!toolUseBlock) {
    return null;
  }

  const hasMatchingResult = blocks.some(
    (block) =>
      block.type === "tool_result" && block.tool_use_id === toolUseBlock.id,
  );
  return hasMatchingResult ? toolUseBlock.id : null;
}

function mergeToolResultIntoPendingMessage(
  previousMessages: ConversationMessage[],
  incomingMessage: ConversationMessage,
): boolean {
  const pairedToolCallId = getPairedToolCallId(incomingMessage);
  if (pairedToolCallId) {
    for (let index = previousMessages.length - 1; index >= 0; index -= 1) {
      if (
        getPendingToolUseCallId(previousMessages[index]) !== pairedToolCallId
      ) {
        continue;
      }

      previousMessages[index] = incomingMessage;
      return true;
    }
    return false;
  }

  const resultBlock = getToolResultOnlyBlock(incomingMessage);
  if (!resultBlock) {
    return false;
  }

  for (let index = previousMessages.length - 1; index >= 0; index -= 1) {
    const pendingMessage = previousMessages[index];
    const pendingCallId = getPendingToolUseCallId(pendingMessage);
    if (pendingCallId !== resultBlock.tool_use_id) {
      continue;
    }

    const blocks = getMessageContentBlocks(pendingMessage);
    if (!blocks) {
      continue;
    }
    const pendingToolUse = blocks.find(
      (block): block is ContentBlock & { type: "tool_use"; name?: string } =>
        block.type === "tool_use" && block.id === pendingCallId,
    );

    const mergedResultBlock: ContentBlock = {
      ...resultBlock,
      name:
        typeof resultBlock.name === "string" &&
        resultBlock.name.trim().length > 0
          ? resultBlock.name
          : pendingToolUse?.name,
    };
    const incomingUuid =
      typeof incomingMessage.uuid === "string" &&
      incomingMessage.uuid.length > 0
        ? incomingMessage.uuid
        : pendingMessage.uuid;

    previousMessages[index] = {
      ...pendingMessage,
      uuid: incomingUuid,
      message: {
        role: pendingMessage.message?.role ?? "assistant",
        content: [...blocks, mergedResultBlock],
      },
    };
    return true;
  }

  return false;
}

function getMessageUuid(message: ConversationMessage): string | null {
  return typeof message.uuid === "string" && message.uuid.length > 0
    ? message.uuid
    : null;
}

function getTokenLimitNoticeKey(message: ConversationMessage): string | null {
  if (message.type !== "token_limit_notice") {
    return null;
  }

  const rateLimitId =
    typeof message.rateLimitId === "string" ? message.rateLimitId.trim() : "";
  return rateLimitId || "token-limit-notice";
}

function mergeTokenLimitNotice(
  previousMessages: ConversationMessage[],
  incomingMessage: ConversationMessage,
): boolean {
  if (incomingMessage.type !== "token_limit_notice") {
    return false;
  }

  const lastMessage = previousMessages[previousMessages.length - 1];
  if (lastMessage?.type !== "token_limit_notice") {
    return false;
  }

  const incomingKey = getTokenLimitNoticeKey(incomingMessage);
  const lastKey = getTokenLimitNoticeKey(lastMessage);
  if (!incomingKey || incomingKey !== lastKey) {
    return false;
  }

  previousMessages[previousMessages.length - 1] = {
    ...lastMessage,
    ...incomingMessage,
    uuid: incomingMessage.uuid ?? lastMessage.uuid,
    timestamp: incomingMessage.timestamp ?? lastMessage.timestamp,
    repeatCount:
      (lastMessage.repeatCount ?? 1) + (incomingMessage.repeatCount ?? 1),
    repeatCountMax:
      incomingMessage.repeatCountMax ?? lastMessage.repeatCountMax,
    rateLimitId: incomingMessage.rateLimitId ?? lastMessage.rateLimitId ?? null,
  };
  return true;
}

function mergePrependedTokenLimitBoundary(
  previousMessages: ConversationMessage[],
  incomingMessages: ConversationMessage[],
): ConversationMessage[] | null {
  if (incomingMessages.length === 0 || previousMessages.length === 0) {
    return null;
  }

  const lastIncoming = incomingMessages[incomingMessages.length - 1];
  const firstPrevious = previousMessages[0];
  if (
    lastIncoming.type !== "token_limit_notice" ||
    firstPrevious.type !== "token_limit_notice"
  ) {
    return null;
  }

  const incomingKey = getTokenLimitNoticeKey(lastIncoming);
  const previousKey = getTokenLimitNoticeKey(firstPrevious);
  if (!incomingKey || incomingKey !== previousKey) {
    return null;
  }

  const mergedBoundaryMessage: ConversationMessage = {
    ...lastIncoming,
    ...firstPrevious,
    uuid: firstPrevious.uuid ?? lastIncoming.uuid,
    timestamp: firstPrevious.timestamp ?? lastIncoming.timestamp,
    repeatCount:
      (lastIncoming.repeatCount ?? 1) + (firstPrevious.repeatCount ?? 1),
    repeatCountMax: firstPrevious.repeatCountMax ?? lastIncoming.repeatCountMax,
    rateLimitId: firstPrevious.rateLimitId ?? lastIncoming.rateLimitId ?? null,
  };

  return [
    ...incomingMessages.slice(0, -1),
    mergedBoundaryMessage,
    ...previousMessages.slice(1),
  ];
}

export function mergeDisplayConversationMessages(
  previousMessages: ConversationMessage[],
  incomingMessages: ConversationMessage[],
  insertion: ConversationInsertion = "append",
): ConversationMessage[] {
  const existingIds = new Set(
    previousMessages
      .map((message) => getMessageUuid(message))
      .filter((id): id is string => id !== null),
  );
  const uniqueIncoming: ConversationMessage[] = [];
  for (const message of incomingMessages) {
    const uuid = getMessageUuid(message);
    if (uuid && existingIds.has(uuid)) {
      continue;
    }
    if (uuid) {
      existingIds.add(uuid);
    }
    uniqueIncoming.push(message);
  }

  if (uniqueIncoming.length === 0) {
    return previousMessages;
  }

  if (insertion === "prepend") {
    const mergedBoundary = mergePrependedTokenLimitBoundary(
      previousMessages,
      uniqueIncoming,
    );
    return mergedBoundary ?? [...uniqueIncoming, ...previousMessages];
  }

  const nextMessages = [...previousMessages];
  for (const message of uniqueIncoming) {
    if (mergeTokenLimitNotice(nextMessages, message)) {
      continue;
    }
    if (mergeToolResultIntoPendingMessage(nextMessages, message)) {
      continue;
    }
    nextMessages.push(message);
  }
  return nextMessages;
}

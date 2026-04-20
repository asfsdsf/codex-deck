import type { ConversationMessage } from "@codex-deck/api";
import {
  deriveAiTerminalStepStatesByMessageKey,
  extractConversationMessageText,
  getAiTerminalMessageKey,
  parseAiTerminalMessage,
  type AiTerminalStepState,
} from "./ai-terminal";

export interface TerminalEmbeddedMessageItem {
  messageKey: string;
  message: ConversationMessage;
}

export interface TerminalEmbeddedMessagesState {
  sessionId: string | null;
  messages: TerminalEmbeddedMessageItem[];
  persistedStepStatesByMessageKey: Record<
    string,
    Record<string, AiTerminalStepState | undefined>
  >;
}

export const EMPTY_TERMINAL_EMBEDDED_MESSAGES_STATE: TerminalEmbeddedMessagesState =
  {
    sessionId: null,
    messages: [],
    persistedStepStatesByMessageKey: {},
  };

function areTerminalEmbeddedMessageItemsEqual(
  current: TerminalEmbeddedMessageItem[],
  next: TerminalEmbeddedMessageItem[],
): boolean {
  if (current.length !== next.length) {
    return false;
  }

  for (let index = 0; index < current.length; index += 1) {
    const currentItem = current[index];
    const nextItem = next[index];
    if (
      currentItem?.messageKey !== nextItem?.messageKey ||
      currentItem?.message !== nextItem?.message
    ) {
      return false;
    }
  }

  return true;
}

function areStepStatesEqual(
  current: Record<string, Record<string, AiTerminalStepState | undefined>>,
  next: Record<string, Record<string, AiTerminalStepState | undefined>>,
): boolean {
  const currentMessageKeys = Object.keys(current);
  const nextMessageKeys = Object.keys(next);
  if (currentMessageKeys.length !== nextMessageKeys.length) {
    return false;
  }

  for (const messageKey of currentMessageKeys) {
    const currentStates = current[messageKey];
    const nextStates = next[messageKey];
    if (!nextStates) {
      return false;
    }

    const currentStepIds = Object.keys(currentStates ?? {});
    const nextStepIds = Object.keys(nextStates);
    if (currentStepIds.length !== nextStepIds.length) {
      return false;
    }

    for (const stepId of currentStepIds) {
      if (currentStates?.[stepId] !== nextStates[stepId]) {
        return false;
      }
    }
  }

  return true;
}

export function deriveTerminalEmbeddedMessagesState(input: {
  current: TerminalEmbeddedMessagesState;
  sessionId: string;
  mergedMessages: ConversationMessage[];
}): TerminalEmbeddedMessagesState {
  const persistedStepStatesByMessageKey =
    deriveAiTerminalStepStatesByMessageKey(input.mergedMessages, {
      getMessage: (message) => message,
      getMessageKey: (message, _messageIndex, planIndex) =>
        getAiTerminalMessageKey(message) ??
        `terminal-ai:${input.sessionId}:${planIndex}`,
    });

  const nextMessages = input.mergedMessages
    .filter((message) => {
      if (message.type !== "assistant") {
        return false;
      }
      return (
        parseAiTerminalMessage(extractConversationMessageText(message)) !== null
      );
    })
    .map((message, index) => ({
      messageKey:
        getAiTerminalMessageKey(message) ??
        `terminal-ai:${input.sessionId}:${index}`,
      message,
    }));

  if (
    input.current.sessionId === input.sessionId &&
    areTerminalEmbeddedMessageItemsEqual(input.current.messages, nextMessages) &&
    areStepStatesEqual(
      input.current.persistedStepStatesByMessageKey,
      persistedStepStatesByMessageKey,
    )
  ) {
    return input.current;
  }

  return {
    sessionId: input.sessionId,
    messages: nextMessages,
    persistedStepStatesByMessageKey,
  };
}

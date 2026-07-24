import type { ConversationMessage } from "@codex-deck/api";
import { isLiveConversationMessage } from "./live-codex-deltas";
import type { PendingUserMessage } from "./pending-user-messages";

export interface DisplayConversationMessage {
  message: ConversationMessage;
  pendingUserMessage: PendingUserMessage | null;
}

function toPendingConversationMessage(
  pending: PendingUserMessage,
): ConversationMessage {
  return {
    type: "user",
    uuid: `pending:${pending.pendingId}`,
    turnId: pending.turnId?.trim() || undefined,
    message: {
      role: "user",
      content: [
        ...(pending.text.trim()
          ? [{ type: "text" as const, text: pending.text }]
          : []),
        ...pending.images
          .filter((imageUrl) => imageUrl.trim().length > 0)
          .map((imageUrl) => ({
            type: "image" as const,
            image_url: imageUrl,
          })),
      ],
    },
  };
}

function hasConfirmedUserMessageForTurn(
  messages: readonly ConversationMessage[],
  turnId: string,
): boolean {
  return messages.some(
    (message) => message.type === "user" && message.turnId === turnId,
  );
}

function findPendingInsertionIndex(
  entries: readonly DisplayConversationMessage[],
  pending: PendingUserMessage,
): number {
  const turnId = pending.turnId?.trim();
  if (turnId) {
    const matchingTurnIndex = entries.findIndex(
      (entry) =>
        entry.message.turnId === turnId && entry.message.type !== "user",
    );
    if (matchingTurnIndex >= 0) {
      return matchingTurnIndex;
    }
  }

  // A turn/start response normally supplies turnId before any live delta, but
  // the two transports are independent. If a delta wins that race, keep the
  // optimistic prompt immediately before the live tail until turnId arrives.
  if (pending.status === "sending") {
    let firstTrailingLiveIndex = entries.length;
    while (
      firstTrailingLiveIndex > 0 &&
      isLiveConversationMessage(entries[firstTrailingLiveIndex - 1].message)
    ) {
      firstTrailingLiveIndex -= 1;
    }
    if (firstTrailingLiveIndex < entries.length) {
      return firstTrailingLiveIndex;
    }
  }

  return entries.length;
}

export function mergePendingConversationMessages(
  messages: readonly ConversationMessage[],
  pendingMessages: readonly PendingUserMessage[],
): DisplayConversationMessage[] {
  const entries: DisplayConversationMessage[] = messages.map((message) => ({
    message,
    pendingUserMessage: null,
  }));
  const queued: PendingUserMessage[] = [];

  for (const pending of pendingMessages) {
    if (pending.status === "queued") {
      queued.push(pending);
      continue;
    }

    const turnId = pending.turnId?.trim();
    if (turnId && hasConfirmedUserMessageForTurn(messages, turnId)) {
      continue;
    }

    entries.splice(findPendingInsertionIndex(entries, pending), 0, {
      message: toPendingConversationMessage(pending),
      pendingUserMessage: pending,
    });
  }

  for (const pending of queued) {
    entries.push({
      message: toPendingConversationMessage(pending),
      pendingUserMessage: pending,
    });
  }

  return entries;
}

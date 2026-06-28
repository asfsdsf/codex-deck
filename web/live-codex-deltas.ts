import type {
  CodexAppServerEvent,
  ContentBlock,
  ConversationMessage,
} from "@codex-deck/api";

const LIVE_MESSAGE_UUID_PREFIX = "live:";

type LiveDeltaEvent = Extract<
  CodexAppServerEvent,
  {
    type:
      | "assistant_delta"
      | "plan_delta"
      | "reasoning_summary_delta"
      | "reasoning_text_delta";
  }
>;

interface LiveMessageEntry {
  message: ConversationMessage;
  text: string;
}

export function isLiveConversationMessage(
  message: ConversationMessage,
): boolean {
  return (
    typeof message.uuid === "string" &&
    message.uuid.startsWith(LIVE_MESSAGE_UUID_PREFIX)
  );
}

export function getLiveMessageUuid(event: LiveDeltaEvent): string {
  return `${LIVE_MESSAGE_UUID_PREFIX}${event.threadId}:${event.turnId}:${event.itemId}:${event.type}`;
}

function appendTextBlock(
  message: ConversationMessage,
  text: string,
): ConversationMessage {
  return {
    ...message,
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text,
        },
      ],
    },
  };
}

function appendReasoningBlock(
  message: ConversationMessage,
  type: "reasoning" | "agent_reasoning",
  text: string,
): ConversationMessage {
  const block: ContentBlock = {
    type,
    text,
  };
  return {
    ...message,
    message: {
      role: "assistant",
      content: [block],
    },
  };
}

function createLiveMessage(event: LiveDeltaEvent): LiveMessageEntry {
  const uuid = getLiveMessageUuid(event);
  const base = {
    uuid,
    turnId: event.turnId,
    sessionId: event.threadId,
    timestamp: new Date().toISOString(),
  };

  if (
    event.type === "reasoning_summary_delta" ||
    event.type === "reasoning_text_delta"
  ) {
    const message: ConversationMessage = {
      ...base,
      type:
        event.type === "reasoning_summary_delta"
          ? "reasoning"
          : "agent_reasoning",
      message: {
        role: "assistant",
        content: [],
      },
    };
    return {
      message,
      text: "",
    };
  }

  return {
    message: {
      ...base,
      type: "assistant",
      message: {
        role: "assistant",
        content: [],
      },
    },
    text: "",
  };
}

export class LiveCodexDeltaAccumulator {
  private readonly entries = new Map<string, LiveMessageEntry>();

  clear(): void {
    this.entries.clear();
  }

  apply(event: CodexAppServerEvent): ConversationMessage | null {
    if (
      event.type !== "assistant_delta" &&
      event.type !== "plan_delta" &&
      event.type !== "reasoning_summary_delta" &&
      event.type !== "reasoning_text_delta"
    ) {
      return null;
    }

    const key = getLiveMessageUuid(event);
    const entry = this.entries.get(key) ?? createLiveMessage(event);
    entry.text += event.delta;

    if (event.type === "reasoning_summary_delta") {
      entry.message = appendReasoningBlock(
        entry.message,
        "reasoning",
        entry.text,
      );
    } else if (event.type === "reasoning_text_delta") {
      entry.message = appendReasoningBlock(
        entry.message,
        "agent_reasoning",
        entry.text,
      );
    } else {
      entry.message = appendTextBlock(entry.message, entry.text);
    }

    this.entries.set(key, entry);
    return entry.message;
  }
}

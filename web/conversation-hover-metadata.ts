import type { ConversationMessage } from "@codex-deck/api";
import {
  formatDurationFromTimestamps,
  formatDurationMs,
  formatLocalTimestamp,
} from "./utils";

export interface ConversationHoverMetadata {
  timestamp: string | undefined;
  time: string | null;
  details: { label: string; value: string }[];
}

export function getConversationHoverMetadata(
  message: ConversationMessage,
  blockIndex: number | null,
  fallbackToolTimestampMap?: Map<string, string>,
): ConversationHoverMetadata {
  const content = message.message?.content;
  const blocks = Array.isArray(content) ? content : [];
  const block =
    blockIndex === null
      ? blocks.length === 1
        ? blocks[0]
        : undefined
      : blocks[blockIndex];
  const timestamp = block?.timestamp ?? message.timestamp;
  const details: ConversationHoverMetadata["details"] = [];
  const addText = (label: string, value: string | null | undefined) => {
    if (value?.trim()) details.push({ label, value });
  };
  const addCount = (label: string, value: number | null | undefined) => {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      details.push({ label, value: Math.round(value).toLocaleString() });
    }
  };

  // A message's overall usage belongs to its primary text, not sibling tools.
  const usage =
    block?.token_usage ??
    (!block || block.type === "text" || block.type === "image"
      ? message.message?.usage
      : undefined);
  if (usage) {
    addCount("Input tokens", usage.input_tokens);
    addCount("Output tokens", usage.output_tokens);
    addCount("Total tokens", usage.total_tokens);
    addCount("Reasoning tokens", usage.reasoning_output_tokens);
    addCount("Cache read tokens", usage.cache_read_input_tokens);
    addCount("Cache creation tokens", usage.cache_creation_input_tokens);
  }

  if (block?.type === "tool_result") {
    const call = block.tool_use_id
      ? blocks.find(
          (item) => item.type === "tool_use" && item.id === block.tool_use_id,
        )
      : undefined;
    addText(
      "Duration",
      formatDurationFromTimestamps(
        call?.timestamp ??
          (block.tool_use_id
            ? fallbackToolTimestampMap?.get(block.tool_use_id)
            : undefined),
        block.timestamp,
      ),
    );
  }

  const goal = message.threadGoal;
  if (goal) {
    addCount("Tokens used", goal.tokensUsed);
    addCount("Token budget", goal.tokenBudget);
    if (Number.isFinite(goal.timeUsedSeconds) && goal.timeUsedSeconds >= 0) {
      addText("Elapsed", formatDurationMs(goal.timeUsedSeconds * 1000));
    }
  }
  return {
    timestamp,
    time: formatLocalTimestamp(timestamp),
    details,
  };
}

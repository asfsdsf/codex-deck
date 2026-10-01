import type { ConversationMessage } from "@codex-deck/api";
import {
  DEFAULT_CONVERSATION_HOVER_SETTINGS,
  type ConversationHoverSettings,
  type ConversationHoverField,
} from "../api/conversation-hover-settings";
import { getToolResultMetadata } from "./tool-result-metadata";
import {
  formatDurationFromTimestamps,
  formatDurationMs,
  formatLocalTimestamp,
} from "./utils";

export interface ConversationHoverMetadata {
  showNumber: boolean;
  timestamp: string | undefined;
  time: string | null;
  details: { label: string; value: string }[];
}

export function getConversationHoverMetadata(
  message: ConversationMessage,
  blockIndex: number | null,
  fallbackToolTimestampMap?: Map<string, string>,
  settings: ConversationHoverSettings = DEFAULT_CONVERSATION_HOVER_SETTINGS,
): ConversationHoverMetadata {
  if (!settings.enabled)
    return { showNumber: false, timestamp: undefined, time: null, details: [] };
  const content = message.message?.content;
  const blocks = Array.isArray(content) ? content : [];
  const block =
    blockIndex === null
      ? blocks.length === 1
        ? blocks[0]
        : undefined
      : blocks[blockIndex];
  const timestamp = settings.timestamp
    ? (block?.timestamp ?? message.timestamp)
    : undefined;
  const details: ConversationHoverMetadata["details"] = [];
  const addText = (
    field: ConversationHoverField,
    label: string,
    value: string | null | undefined,
  ) => {
    if (settings[field] && value?.trim()) details.push({ label, value });
  };
  const addCount = (
    field: ConversationHoverField,
    label: string,
    value: number | null | undefined,
  ) => {
    if (
      settings[field] &&
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0
    ) {
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
    addCount("input_tokens", "Input tokens", usage.input_tokens);
    addCount("output_tokens", "Output tokens", usage.output_tokens);
    addCount("total_tokens", "Total tokens", usage.total_tokens);
    addCount(
      "reasoning_tokens",
      "Reasoning tokens",
      usage.reasoning_output_tokens,
    );
    addCount(
      "cache_read_tokens",
      "Cache read tokens",
      usage.cache_read_input_tokens,
    );
    addCount(
      "cache_creation_tokens",
      "Cache creation tokens",
      usage.cache_creation_input_tokens,
    );
    if (
      usage.input_tokens > 0 &&
      usage.cache_read_input_tokens != null &&
      usage.cache_read_input_tokens >= 0 &&
      usage.cache_read_input_tokens <= usage.input_tokens
    ) {
      addText(
        "cache_hit_rate",
        "Cache reuse",
        `${((usage.cache_read_input_tokens / usage.input_tokens) * 100).toFixed(1)}%`,
      );
    }
    if (usage.model_context_window && usage.model_context_window > 0) {
      const used =
        usage.total_tokens ?? usage.input_tokens + usage.output_tokens;
      addText(
        "context_usage",
        "Context used",
        `${((used / usage.model_context_window) * 100).toFixed(1)}% (${used.toLocaleString()} / ${usage.model_context_window.toLocaleString()})`,
      );
    }
  }

  if (
    block?.type === "subagent_activity" ||
    block?.type === "collab_agent_tool_call"
  ) {
    addText("model", "Model", block.model);
    addText("reasoning_effort", "Reasoning effort", block.reasoningEffort);
  } else if (
    message.message?.role === "assistant" &&
    (!block ||
      ["text", "reasoning", "agent_reasoning", "thinking"].includes(block.type))
  ) {
    addText("model", "Model", message.message.model);
    addText(
      "reasoning_effort",
      "Reasoning effort",
      message.message.reasoningEffort,
    );
    addText("service_tier", "Service tier", message.message.serviceTier);
  }

  if (block?.type === "tool_result") {
    const call = block.tool_use_id
      ? blocks.find(
          (item) => item.type === "tool_use" && item.id === block.tool_use_id,
        )
      : undefined;
    const metrics = getToolResultMetadata(block.content);
    addText(
      "duration",
      "Duration",
      metrics.durationMs !== undefined
        ? formatDurationMs(metrics.durationMs)
        : formatDurationFromTimestamps(
            call?.timestamp ??
              (block.tool_use_id
                ? fallbackToolTimestampMap?.get(block.tool_use_id)
                : undefined),
            block.timestamp,
          ),
    );
    if (metrics.exitCode !== undefined)
      addText("exit_code", "Exit code", String(metrics.exitCode));
    addCount("tool_output_tokens", "Tool output tokens", metrics.outputTokens);
    if (metrics.truncated)
      addText("output_truncated", "Output truncated", "Yes");
  }

  const goal = message.threadGoal;
  if (goal) {
    addCount("goal_tokens", "Tokens used", goal.tokensUsed);
    addCount("goal_budget", "Token budget", goal.tokenBudget);
    if (Number.isFinite(goal.timeUsedSeconds) && goal.timeUsedSeconds >= 0) {
      addText(
        "goal_elapsed",
        "Elapsed",
        formatDurationMs(goal.timeUsedSeconds * 1000),
      );
    }
  }
  return {
    showNumber: settings.message_number,
    timestamp,
    time: formatLocalTimestamp(timestamp),
    details,
  };
}

import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationMessage } from "../../api/storage";
import { getConversationHoverMetadata } from "../../web/conversation-hover-metadata";

test("hover metadata shows each block's available measurements and omits descriptive labels", () => {
  const message: ConversationMessage = {
    type: "assistant",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant",
      model: "model-name",
      usage: { input_tokens: 100, output_tokens: 0 },
      content: [
        {
          type: "reasoning",
          text: "Thinking",
          token_usage: {
            input_tokens: 1200,
            output_tokens: 80,
            reasoning_output_tokens: 40,
          },
        },
        {
          type: "tool_use",
          name: "exec_command",
          id: "call-1",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
        {
          type: "tool_result",
          tool_use_id: "call-1",
          timestamp: "2026-01-01T00:00:01.500Z",
          is_error: true,
          content: "Failure",
        },
        { type: "text", text: "Answer" },
      ],
    },
  };
  assert.deepEqual(getConversationHoverMetadata(message, 0).details, [
    { label: "Input tokens", value: "1,200" },
    { label: "Output tokens", value: "80" },
    { label: "Reasoning tokens", value: "40" },
  ]);
  assert.deepEqual(getConversationHoverMetadata(message, 1).details, []);
  const result = getConversationHoverMetadata(message, 2);
  assert.equal(result.timestamp, "2026-01-01T00:00:01.500Z");
  assert.deepEqual(result.details, [{ label: "Duration", value: "1.5s" }]);
  assert.deepEqual(getConversationHoverMetadata(message, 3).details, [
    { label: "Input tokens", value: "100" },
    { label: "Output tokens", value: "0" },
  ]);
});

test("hover metadata leaves missing fields out and resolves separately cached tool timing", () => {
  const minimal = getConversationHoverMetadata({ type: "user" }, null);
  assert.deepEqual(minimal.details, []);
  assert.equal(minimal.time, null);
  const result = getConversationHoverMetadata(
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            timestamp: "2026-01-01T00:00:01.000Z",
            content: "done",
          },
        ],
      },
    },
    0,
    new Map([["call-1", "2026-01-01T00:00:00.000Z"]]),
  );
  assert.deepEqual(result.details, [{ label: "Duration", value: "1s" }]);
});

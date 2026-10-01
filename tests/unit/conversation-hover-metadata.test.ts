import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationMessage } from "../../api/storage";
import { getConversationHoverMetadata } from "../../web/conversation-hover-metadata";
import { DEFAULT_CONVERSATION_HOVER_SETTINGS } from "../../api/conversation-hover-settings";
import { getToolResultMetadata } from "../../web/tool-result-metadata";

test("floating tip filters fields independently and shows available cache, context, and model details", () => {
  const message: ConversationMessage = {
    type: "assistant",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Answer" }],
      model: "model-a",
      reasoningEffort: "high",
      serviceTier: "fast",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        cache_read_input_tokens: 50,
        model_context_window: 1000,
      },
    },
  };
  const selected = {
    ...DEFAULT_CONVERSATION_HOVER_SETTINGS,
    model: true,
    reasoning_effort: true,
    service_tier: true,
    input_tokens: false,
    timestamp: false,
    message_number: false,
  };
  const metadata = getConversationHoverMetadata(
    message,
    0,
    undefined,
    selected,
  );
  assert.equal(metadata.showNumber, false);
  assert.equal(metadata.time, null);
  assert.deepEqual(metadata.details, [
    { label: "Output tokens", value: "20" },
    { label: "Total tokens", value: "120" },
    { label: "Cache read tokens", value: "50" },
    { label: "Cache reuse", value: "50.0%" },
    { label: "Context used", value: "12.0% (120 / 1,000)" },
    { label: "Model", value: "model-a" },
    { label: "Reasoning effort", value: "high" },
    { label: "Service tier", value: "fast" },
  ]);
});

test("tool metrics come from recorded envelopes and do not interpret stdout as measurements", () => {
  const output =
    "Chunk ID: abc\nWall time: 1.5 seconds\nProcess exited with code 2\nOriginal token count: 40\nWarning: truncated output\nOutput:\nProcess exited with code 0\n";
  assert.deepEqual(getToolResultMetadata(output), {
    durationMs: 1500,
    exitCode: 2,
    outputTokens: 40,
    truncated: true,
  });
  assert.deepEqual(
    getToolResultMetadata(
      "Command stdout\nProcess exited with code 3\nWall time: 2 seconds",
    ),
    {},
  );
  assert.deepEqual(
    getToolResultMetadata({
      exit_code: 0,
      wall_time_seconds: 0,
      truncated: false,
    }),
    { durationMs: 0, exitCode: 0, truncated: false },
  );
  const metadata = getConversationHoverMetadata(
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_result", content: output }],
      },
    },
    0,
  );
  assert.deepEqual(metadata.details, [
    { label: "Duration", value: "1.5s" },
    { label: "Exit code", value: "2" },
    { label: "Tool output tokens", value: "40" },
    { label: "Output truncated", value: "Yes" },
  ]);
});

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

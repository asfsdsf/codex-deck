import assert from "node:assert/strict";
import test from "node:test";
import { parseConversationTextChunk } from "../../api/conversation-parser";

function line(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

test("parseConversationTextChunk keeps unresolved tool calls in-place", () => {
  const text = [
    line({
      timestamp: "2026-04-07T12:05:25.280Z",
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "call_old",
        name: "exec_command",
        arguments: { cmd: "echo old command" },
      },
    }),
    line({
      timestamp: "2026-04-07T12:05:25.353Z",
      type: "event_msg",
      payload: {
        type: "exec_command_end",
        call_id: "call_old",
        process_id: "12345",
      },
    }),
    line({
      timestamp: "2026-04-07T12:05:34.190Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Scheduler turn completed." }],
      },
    }),
    line({
      timestamp: "2026-04-07T12:05:34.221Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn_1",
      },
    }),
  ].join("\n");

  const { messages } = parseConversationTextChunk(`${text}\n`, 0);
  const toolUseIndex = messages.findIndex(
    (message) =>
      message.type === "assistant" &&
      Array.isArray(message.message?.content) &&
      message.message.content.some(
        (block) =>
          block.type === "tool_use" &&
          block.name === "exec_command" &&
          block.id === "call_old",
      ),
  );
  const finalAssistantIndex = messages.findIndex(
    (message) =>
      message.type === "assistant" &&
      Array.isArray(message.message?.content) &&
      message.message.content.some(
        (block) =>
          block.type === "text" && block.text === "Scheduler turn completed.",
      ),
  );

  assert.equal(toolUseIndex >= 0, true);
  assert.equal(finalAssistantIndex >= 0, true);
  assert.equal(toolUseIndex < finalAssistantIndex, true);
  assert.equal(messages[messages.length - 1]?.type, "task_complete");
});

test("parseConversationTextChunk attaches last token usage to reasoning blocks", () => {
  const text = [
    line({
      timestamp: "2026-04-07T12:05:25.280Z",
      type: "response_item",
      payload: {
        type: "reasoning",
        summary: [{ text: "Plan steps" }],
        last_token_usage: {
          input_tokens: 1200,
          output_tokens: 345,
          total_tokens: 1545,
          reasoning_output_tokens: 123,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 200,
        },
      },
    }),
  ].join("\n");

  const { messages } = parseConversationTextChunk(`${text}\n`, 0);
  const reasoningMessage = messages.find(
    (message) => message.type === "reasoning",
  );
  assert.ok(reasoningMessage);
  assert.ok(Array.isArray(reasoningMessage.message?.content));
  assert.deepEqual(reasoningMessage.message.content[0]?.token_usage, {
    input_tokens: 1200,
    output_tokens: 345,
    total_tokens: 1545,
    reasoning_output_tokens: 123,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 200,
  });
});

test("parseConversationTextChunk attaches token count event usage to previous encrypted reasoning", () => {
  const text = [
    line({
      timestamp: "2026-04-07T12:05:25.280Z",
      type: "response_item",
      payload: {
        type: "reasoning",
        summary: [],
        content: null,
        encrypted_content: "encrypted",
      },
    }),
    line({
      timestamp: "2026-04-07T12:05:25.355Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 14696,
            cached_input_tokens: 4480,
            output_tokens: 426,
            reasoning_output_tokens: 161,
            total_tokens: 15122,
          },
        },
      },
    }),
  ].join("\n");

  const { messages } = parseConversationTextChunk(`${text}\n`, 0);
  const reasoningMessage = messages.find(
    (message) => message.type === "reasoning",
  );
  assert.ok(reasoningMessage);
  assert.ok(Array.isArray(reasoningMessage.message?.content));
  assert.deepEqual(reasoningMessage.message.content[0]?.token_usage, {
    input_tokens: 14696,
    output_tokens: 426,
    total_tokens: 15122,
    reasoning_output_tokens: 161,
    cache_read_input_tokens: 4480,
  });
});

test("parseConversationTextChunk keeps paired tool call and output as one message", () => {
  const text = [
    line({
      timestamp: "2026-04-07T12:05:25.280Z",
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "call_pair",
        name: "exec_command",
        arguments: { cmd: "echo hello" },
      },
    }),
    line({
      timestamp: "2026-04-07T12:05:25.355Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_pair",
        output: "hello",
      },
    }),
  ].join("\n");

  const { messages } = parseConversationTextChunk(`${text}\n`, 0);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.type, "assistant");
  const content = Array.isArray(messages[0]?.message?.content)
    ? messages[0].message.content
    : [];
  assert.equal(
    content.some((block) => block.type === "tool_use"),
    true,
  );
  assert.equal(
    content.some((block) => block.type === "tool_result"),
    true,
  );
});

test("parseConversationTextChunk renders thread goal updates as messages", () => {
  const text = [
    line({
      timestamp: "2026-04-07T12:05:25.280Z",
      type: "event_msg",
      payload: {
        type: "thread_goal_updated",
        thread_id: "thread-1",
        turn_id: null,
        goal: {
          threadId: "thread-1",
          objective: "Improve benchmark coverage",
          status: "active",
          tokenBudget: 10000,
          tokensUsed: 1250,
          timeUsedSeconds: 90,
          createdAt: 100,
          updatedAt: 120,
        },
      },
    }),
  ].join("\n");

  const { messages } = parseConversationTextChunk(`${text}\n`, 0);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.type, "thread_goal");
  assert.equal(messages[0]?.message?.content, "Improve benchmark coverage");
  assert.equal(messages[0]?.threadGoal?.status, "active");
  assert.equal(messages[0]?.threadGoal?.tokenBudget, 10000);
});

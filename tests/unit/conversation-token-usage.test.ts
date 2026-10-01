import assert from "node:assert/strict";
import test from "node:test";
import {
  ConversationParserState,
  parseConversationTextChunk,
} from "../../api/conversation-parser";
import { getModelOutputTokenUsage } from "../../api/conversation-token-usage";
import {
  eventMsgLine,
  responseItemMessageLine,
  responseItemRawLine,
} from "./test-utils";

const reasoning = responseItemRawLine({
  type: "reasoning",
  summary: [{ type: "summary_text", text: "Thinking" }],
});
const usage = {
  input_tokens: 1200,
  output_tokens: 80,
  reasoning_output_tokens: 40,
};
const tokenCount = (value = usage) =>
  eventMsgLine({ type: "token_count", info: { last_token_usage: value } });

test("model metadata and context capacity stay attached to their own historical calls", () => {
  const state = new ConversationParserState();
  const records = [
    JSON.stringify({
      type: "turn_context",
      payload: { model: "model-a", effort: "high", service_tier: "fast" },
    }),
    reasoning,
    responseItemMessageLine("assistant", "First answer"),
    eventMsgLine({
      type: "token_count",
      info: { last_token_usage: usage, model_context_window: 10000 },
    }),
    JSON.stringify({
      type: "turn_context",
      payload: { model: "model-b", effort: "low" },
    }),
    responseItemMessageLine("assistant", "Second answer"),
    tokenCount(),
  ];
  let offset = 0;
  for (const record of records)
    offset += parseConversationTextChunk(
      `${record}\n`,
      offset,
      undefined,
      state,
    ).consumedBytes;
  const first = state.messages[1].message!;
  assert.equal(first.model, "model-a");
  assert.equal(first.reasoningEffort, "high");
  assert.equal(first.serviceTier, "fast");
  assert.equal(first.usage?.model_context_window, 10000);
  assert.equal(state.messages[0].message?.model, "model-a");
  assert.equal(
    getModelOutputTokenUsage(state.messages[0])?.model_context_window,
    10000,
  );
  const second = state.messages[2].message!;
  assert.equal(second.model, "model-b");
  assert.equal(second.reasoningEffort, "low");
  assert.equal(second.serviceTier, undefined);
  assert.equal(second.usage?.model_context_window, undefined);
});

for (const incremental of [false, true]) {
  const mode = incremental ? "incremental" : "static";
  const parse = (records: string[]) => {
    if (!incremental) {
      return parseConversationTextChunk(`${records.join("\n")}\n`).messages;
    }
    const state = new ConversationParserState();
    let offset = 0;
    for (const record of records) {
      offset += parseConversationTextChunk(
        `${record}\n`,
        offset,
        undefined,
        state,
      ).consumedBytes;
    }
    return state.messages;
  };

  test(`${mode} usage links reasoning and reply text across tool records`, () => {
    const messages = parse([
      reasoning,
      responseItemMessageLine("assistant", "Running a command"),
      responseItemRawLine({
        type: "function_call",
        call_id: "call-1",
        name: "exec_command",
        arguments: "{}",
      }),
      responseItemRawLine({
        type: "function_call_output",
        call_id: "call-1",
        output: "done",
      }),
      tokenCount(),
    ]);
    assert.equal(messages.length, 3);
    assert.deepEqual(getModelOutputTokenUsage(messages[0]), usage);
    assert.deepEqual(messages[1].message?.usage, usage);
    assert.equal(messages[2].message?.usage, undefined);
  });

  test(`${mode} usage keeps distinct model calls and ignores duplicate counts`, () => {
    const finalUsage = {
      input_tokens: 1500,
      output_tokens: 20,
      reasoning_output_tokens: 0,
    };
    const messages = parse([
      reasoning,
      tokenCount(),
      responseItemMessageLine("assistant", "Final answer"),
      tokenCount(finalUsage),
      tokenCount(),
    ]);
    assert.deepEqual(getModelOutputTokenUsage(messages[0]), usage);
    assert.deepEqual(messages[1].message?.usage, finalUsage);
  });

  for (const boundary of [
    responseItemMessageLine("user", "Next question"),
    eventMsgLine({ type: "task_started", turn_id: "next-turn" }),
  ]) {
    test(`${mode} usage stops at ${JSON.parse(boundary).payload.type} boundaries`, () => {
      const messages = parse([
        reasoning,
        responseItemMessageLine("assistant", "Earlier answer"),
        boundary,
        tokenCount(),
      ]);
      assert.equal(getModelOutputTokenUsage(messages[0]), undefined);
      assert.equal(messages[1].message?.usage, undefined);
    });
  }

  test(`${mode} assistant inline usage preserves cache-write details`, () => {
    const messages = parse([
      responseItemRawLine({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Answer" }],
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          cached_input_tokens: 25,
          cache_write_input_tokens: 50,
        },
      }),
      tokenCount(),
    ]);
    assert.deepEqual(messages[0].message?.usage, {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 25,
      cache_creation_input_tokens: 50,
    });
  });
}

test("usage follows persisted model outputs when live notifications reserve later slots", () => {
  const state = new ConversationParserState();
  let offset = 0;
  const append = (record: string) => {
    offset += parseConversationTextChunk(
      `${record}\n`,
      offset,
      undefined,
      state,
    ).consumedBytes;
  };
  append(eventMsgLine({ type: "task_started", turn_id: "turn-1" }));
  state.applyStreamText("turn-1", "reasoning-1", "reasoning", "Thinking");
  state.applyStreamText("turn-1", "reply-1", "assistant", "Final answer");
  state.completeStreamItem("turn-1", "reply-1", {
    type: "agentMessage",
    text: "Final answer",
  });
  append(reasoning);
  append(tokenCount());
  const firstReasoning = state.messages.find(
    (message) => message.type === "reasoning",
  )!;
  const reply = state.messages.find((message) => message.type === "assistant")!;
  assert.deepEqual(getModelOutputTokenUsage(firstReasoning), usage);
  assert.equal(reply.message?.usage, undefined);
  append(responseItemMessageLine("assistant", "Final answer"));
  append(
    tokenCount({
      input_tokens: 1500,
      output_tokens: 20,
      reasoning_output_tokens: 0,
    }),
  );
  const finalReply = state.messages.find(
    (message) => message.type === "assistant",
  )!;
  assert.equal(finalReply.sequence, reply.sequence);
  assert.equal(finalReply.messageNumber, reply.messageNumber);
  assert.equal(finalReply.message?.usage?.output_tokens, 20);
  assert.deepEqual(
    getModelOutputTokenUsage(
      state.messages.find((message) => message.type === "reasoning")!,
    ),
    usage,
  );
});

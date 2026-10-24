import assert from "node:assert/strict";
import test from "node:test";
import {
  ConversationParserState,
  parseConversationTextChunk,
} from "../../api/conversation-parser";

function line(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

for (const incremental of [false, true]) {
  test(`${incremental ? "incremental" : "static"} parsing preserves answer phases without leaking them to unphased messages`, () => {
    const records = [
      "commentary",
      "final_answer",
      undefined,
      "unknown_future_phase",
    ].map((phase) =>
      line({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase,
          content: [
            { type: "output_text", text: `Content ${phase ?? "legacy"}` },
          ],
        },
      }),
    );
    const state = incremental ? new ConversationParserState() : undefined;
    let messages;
    if (state) {
      let offset = 0;
      for (const record of records)
        offset += parseConversationTextChunk(
          record + "\n",
          offset,
          undefined,
          state,
        ).consumedBytes;
      messages = state.messages;
    } else
      messages = parseConversationTextChunk(records.join("\n") + "\n").messages;
    assert.deepEqual(
      messages.map((message) => message.message?.phase),
      ["commentary", "final_answer", undefined, undefined],
    );
  });
}

test("live assistant completion retains its phase for answer-only copy and translation", () => {
  const state = new ConversationParserState();
  state.applyStreamText("turn-1", "progress", "assistant", "Progress text");
  state.completeStreamItem("turn-1", "progress", {
    type: "agentMessage",
    phase: "commentary",
    text: "Progress text",
  });
  state.applyStreamText("turn-1", "answer", "assistant", "Answer text");
  state.completeStreamItem("turn-1", "answer", {
    type: "agentMessage",
    phase: "final_answer",
  });
  assert.deepEqual(
    state.messages.map((message) => message.message?.phase),
    ["commentary", "final_answer"],
  );
  assert.equal(state.messages[1].streaming, false);
  assert.deepEqual(state.messages[1].message?.content, [
    { type: "text", text: "Answer text" },
  ]);
});

test("native async questions survive history parsing and live message completion", () => {
  const questions = [
    { title: "Which audience?", options: ["Engineers", "Executives"] },
    { title: "Any requirements?", options: null },
  ];
  const record = line({
    type: "response_item",
    payload: {
      type: "message",
      id: "async-1",
      role: "assistant",
      delivery: "async",
      content: [],
      questions,
    },
  });
  const parsed = parseConversationTextChunk(`${record}\n`, 0);
  assert.equal(parsed.messages.length, 1);
  assert.match(
    JSON.stringify(parsed.messages[0].message?.content),
    /Which audience\?/,
  );
  assert.match(
    JSON.stringify(parsed.messages[0].message?.content),
    /Engineers/,
  );
  assert.match(
    JSON.stringify(parsed.messages[0].message?.content),
    /Any requirements\?/,
  );

  const state = new ConversationParserState();
  state.applyStreamText("turn-1", "async-1", "assistant", "A quick question.");
  state.completeStreamItem("turn-1", "async-1", {
    type: "agentMessage",
    text: "A quick question.",
    questions,
  });
  assert.equal(state.messages.length, 1);
  assert.match(
    JSON.stringify(state.messages[0].message?.content),
    /Any requirements\?/,
  );
  assert.equal(state.messages[0].streaming, false);
});

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

test("parseConversationTextChunk renders persisted collaboration items in both wire casings", () => {
  const text = [
    line({
      timestamp: "2026-04-07T12:05:25.280Z",
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "turn-snake",
        item: {
          type: "collab_agent_tool_call",
          id: "collab-snake",
          tool: "send_input",
          status: "completed",
          sender_thread_id: "root-thread",
          receiver_thread_ids: ["child-thread"],
          prompt: "Continue the investigation",
          model: "custom-model",
          reasoning_effort: "ultra",
          agents_states: {
            "child-thread": {
              status: "running",
              message: "Investigating",
            },
          },
        },
      },
    }),
    line({
      timestamp: "2026-04-07T12:05:26.280Z",
      type: "event_msg",
      payload: {
        type: "itemCompleted",
        turnId: "turn-camel",
        item: {
          type: "subAgentActivity",
          id: "activity-camel",
          agentThreadId: "child-thread",
          agentPath: "/root/child",
          kind: "interacted",
        },
      },
    }),
  ].join("\n");

  const { messages } = parseConversationTextChunk(`${text}\n`, 0);
  assert.equal(messages.length, 2);

  const firstBlock = messages[0]?.message?.content;
  assert.ok(Array.isArray(firstBlock));
  assert.deepEqual(firstBlock[0], {
    type: "collab_agent_tool_call",
    id: "collab-snake",
    tool: "sendInput",
    status: "completed",
    senderThreadId: "root-thread",
    receiverThreadIds: ["child-thread"],
    prompt: "Continue the investigation",
    model: "custom-model",
    reasoningEffort: "ultra",
    agentsStates: {
      "child-thread": {
        status: "running",
        message: "Investigating",
      },
    },
    timestamp: "2026-04-07T12:05:25.280Z",
  });
  assert.equal(messages[0]?.turnId, "turn-snake");

  const secondBlock = messages[1]?.message?.content;
  assert.ok(Array.isArray(secondBlock));
  assert.deepEqual(secondBlock[0], {
    type: "subagent_activity",
    id: "activity-camel",
    agentThreadId: "child-thread",
    agentPath: "/root/child",
    kind: "interacted",
    timestamp: "2026-04-07T12:05:26.280Z",
  });
  assert.equal(messages[1]?.turnId, "turn-camel");
});

test("parseConversationTextChunk marks item_completed message pairs editable", () => {
  const userText = "Edit this new-format user message.";
  const assistantText = "Edit this new-format assistant message.";
  const text = [
    line({
      timestamp: "2026-09-03T08:50:23.434Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "user-response-item",
        role: "user",
        content: [{ type: "input_text", text: userText }],
      },
    }),
    line({
      timestamp: "2026-09-03T08:50:23.434Z",
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "UserMessage",
          id: "different-user-event-item",
          content: [{ type: "text", text: userText }],
        },
      },
    }),
    line({
      timestamp: "2026-09-03T08:50:38.638Z",
      type: "event_msg",
      payload: {
        type: "itemCompleted",
        item: {
          type: "AgentMessage",
          id: "assistant-response-item",
          content: [{ type: "Text", text: assistantText }],
        },
      },
    }),
    line({
      timestamp: "2026-09-03T08:50:38.643Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "assistant-response-item",
        role: "assistant",
        content: [{ type: "output_text", text: assistantText }],
      },
    }),
  ].join("\n");

  const { messages } = parseConversationTextChunk(`${text}\n`, 0);
  const editableMessages = messages.filter(
    (message) => message.editable === true,
  );

  assert.deepEqual(
    editableMessages.map((message) => ({
      type: message.type,
      editId: message.editId,
      editText: message.editText,
    })),
    [
      {
        type: "user",
        editId: "item:user-response-item",
        editText: userText,
      },
      {
        type: "assistant",
        editId: "item:assistant-response-item",
        editText: assistantText,
      },
    ],
  );
});

test("parseConversationTextChunk skips newline-terminated malformed lines", () => {
  const validLine = line({
    timestamp: "2026-04-07T12:05:34.190Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "After corruption." }],
    },
  });
  const text = `{corrupted line\n${validLine}\n`;

  const { messages, consumedBytes } = parseConversationTextChunk(text, 0);

  assert.equal(consumedBytes, Buffer.byteLength(text, "utf-8"));
  assert.equal(
    messages.some(
      (message) =>
        message.type === "assistant" &&
        Array.isArray(message.message?.content) &&
        message.message.content.some(
          (block) =>
            block.type === "text" && block.text === "After corruption.",
        ),
    ),
    true,
  );
});

test("parseConversationTextChunk still treats an unterminated tail as partial", () => {
  const text = `{"incomplete": tr`;
  const { messages, consumedBytes } = parseConversationTextChunk(text, 0);
  assert.equal(messages.length, 0);
  assert.equal(consumedBytes, 0);
});

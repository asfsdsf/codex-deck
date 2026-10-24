import test from "node:test";
import assert from "node:assert/strict";
import type { ContentBlock, ConversationMessage } from "@codex-deck/api";
import {
  ConversationParserState,
  parseConversationTextChunk,
} from "../../api/conversation-parser";
import {
  eventMsgLine,
  responseItemMessageLine,
  responseItemRawLine,
} from "./test-utils";
import {
  getCompletedTaskAnswer,
  getCompletedTaskAnswers,
} from "../../web/task-answer";

function chat(
  type: "user" | "assistant",
  content: string | ContentBlock[],
  turnId = "turn-1",
): ConversationMessage {
  return { type, turnId, message: { role: type, content } };
}

function complete(turnId = "turn-1", sequence = 100): ConversationMessage {
  return { type: "task_complete", turnId, sequence };
}

test("one answer includes every assistant paragraph across separate messages and content blocks", () => {
  const completion = complete("turn-2", 200);
  const messages: ConversationMessage[] = [
    chat("user", "Earlier question"),
    chat("assistant", "Earlier answer"),
    complete(),
    { type: "task_started", turnId: "turn-2" },
    chat("user", "Explain the change", "turn-2"),
    chat("assistant", "First paragraph.", "turn-2"),
    {
      type: "reasoning",
      turnId: "turn-2",
      message: { role: "assistant", content: "Private reasoning" },
    },
    chat(
      "assistant",
      [
        { type: "tool_use", name: "exec_command", input: { cmd: "pwd" } },
        { type: "tool_result", content: "Tool output" },
      ],
      "turn-2",
    ),
    chat(
      "assistant",
      [
        { type: "text", text: "**Second paragraph.**" },
        { type: "thinking", thinking: "Hidden reasoning" },
        {
          type: "text",
          text: "Third paragraph.\n\n```ts\nconst result = true;\n```",
        },
      ],
      "turn-2",
    ),
    { type: "thread_goal", turnId: "turn-2" },
    completion,
    chat("user", "Later question", "turn-3"),
    chat("assistant", "Later answer", "turn-3"),
  ];
  assert.equal(
    getCompletedTaskAnswer(messages, { ...completion }),
    "First paragraph.\n\n**Second paragraph.**\n\nThird paragraph.\n\n```ts\nconst result = true;\n```",
  );
  assert.equal(getCompletedTaskAnswer(messages, complete()), "Earlier answer");
});

test("the greeting answer has no conversation heading or user question", () => {
  const completion = complete();
  const first = "I'm Codex, OpenAI's coding assistant.";
  const second = "I can help you understand, write, review, and debug code.";
  assert.equal(
    getCompletedTaskAnswer(
      [
        chat("user", "Hello, who are you?"),
        chat("assistant", first),
        chat("assistant", second),
        completion,
      ],
      completion,
    ),
    `${first}\n\n${second}`,
  );
});

test("all paragraphs, list items, and commands in a single final answer are preserved", () => {
  const completion = complete();
  const answer = [
    "I'm Codex, OpenAI's coding assistant.",
    "I can help you:",
    "- Understand the project.\n- Investigate errors.\n- Build features.",
    "## Commands\n\n```sh\npnpm test\npnpm build\n```",
    "Describe what you want, and I can make the changes.",
  ].join("\n\n");
  const message = chat("assistant", answer);
  message.message!.phase = "final_answer";
  assert.equal(
    getCompletedTaskAnswer(
      [chat("user", "Who are you?"), message, completion],
      completion,
    ),
    answer,
  );
});

test("every assistant paragraph is included regardless of commentary or final-answer phase", () => {
  const completion = complete();
  const explanation = chat("assistant", [
    { type: "text", text: "## Explanation\n\nThe first part of the answer." },
    { type: "text", text: "The second explanatory paragraph." },
  ]);
  explanation.message!.phase = "commentary";
  const final = chat("assistant", "## Result\n\nThe final paragraph.");
  final.message!.phase = "final_answer";
  assert.equal(
    getCompletedTaskAnswer(
      [
        chat("user", "Explain every step"),
        explanation,
        chat("assistant", [
          {
            type: "tool_use",
            name: "exec",
            input: { code: "internal script" },
          },
          { type: "tool_result", content: "Script completed\nReturned image" },
        ]),
        final,
        completion,
      ],
      completion,
    ),
    "## Explanation\n\nThe first part of the answer.\n\nThe second explanatory paragraph.\n\n## Result\n\nThe final paragraph.",
  );
});

test("long answers are preserved completely across multiple messages", () => {
  const completion = complete();
  const first = "All of the assistant's answer 中文 😀.\n".repeat(7000).trim();
  const second = "The final paragraph.";
  assert.equal(
    getCompletedTaskAnswer(
      [chat("assistant", first), chat("assistant", second), completion],
      completion,
    ),
    `${first}\n\n${second}`,
  );
});

test("a task without answer text does not copy or translate earlier tasks, streaming text, or other threads", () => {
  const completion = complete("tool-only", 200);
  const messages: ConversationMessage[] = [
    chat("assistant", "Earlier answer"),
    complete(),
    { type: "task_started", turnId: "tool-only" },
    chat("user", "Run a tool", "tool-only"),
    chat(
      "assistant",
      [{ type: "tool_use", name: "exec_command", input: { cmd: "pwd" } }],
      "tool-only",
    ),
    { ...chat("assistant", "Still streaming", "tool-only"), streaming: true },
    chat("assistant", "Other turn", "unrelated"),
    completion,
  ];
  assert.equal(getCompletedTaskAnswer(messages, completion), null);
  assert.throws(
    () => getCompletedTaskAnswer(messages, complete("missing", 900)),
    /no longer in this conversation/,
  );
  assert.throws(
    () => getCompletedTaskAnswer(messages, complete("wrong-thread", 200)),
    /no longer in this conversation/,
  );
});

test("visible plan bodies and Markdown are preserved without internal wrappers", () => {
  const completion = complete();
  assert.equal(
    getCompletedTaskAnswer(
      [
        chat(
          "assistant",
          "<proposed_plan>\n# Plan\n\n1. Inspect the code\n</proposed_plan>\n\nReady for review.",
        ),
        completion,
      ],
      completion,
    ),
    "# Plan\n\n1. Inspect the code\n\nReady for review.",
  );
});

test("completed-task controls attach only once, below the final block", () => {
  const finalReply = chat("assistant", "Finished");
  const first = complete();
  const tool = chat(
    "assistant",
    [{ type: "tool_use", name: "update_plan", input: { plan: [] } }],
    "turn-2",
  );
  const second = complete("turn-2", 200);
  assert.deepEqual(
    [
      ...getCompletedTaskAnswers([
        chat("user", "Start"),
        { type: "task_started", turnId: "turn-1" },
        chat("assistant", "Progress"),
        finalReply,
        first,
        chat("user", "Update plan", "turn-2"),
        { type: "task_started", turnId: "turn-2" },
        tool,
        second,
        chat("user", "Still working", "turn-3"),
        { type: "task_started", turnId: "turn-3" },
        chat("assistant", "Working", "turn-3"),
      ]),
    ],
    [
      [finalReply, first],
      [tool, second],
    ],
  );
});

test("aborted, active, empty, and mismatched turns have no completion controls", () => {
  assert.equal(
    getCompletedTaskAnswers([
      chat("assistant", "Interrupted"),
      { type: "turn_aborted", turnId: "turn-1" },
      complete(),
      { type: "task_started", turnId: "empty" },
      complete("empty"),
      chat("assistant", "Other turn", "other"),
      complete("unrelated"),
    ]).size,
    0,
  );
});

test("the reported exec/image wrapper is excluded while answer headings and shell commands are preserved", () => {
  const wrapper = `const results = await Promise.allSettled([
  tools.view_image({path:"/private/tmp/answer-light.png"}),
  tools.view_image({path:"/private/tmp/answer-dark.png"})
]); for (const r of results) if (r.status === "fulfilled") image(r.value.image_url);`;
  const first =
    "# Answer\n\nThe change is ready.\n\n## Commands\n\n```sh\npnpm test\npnpm build\n```";
  const second = "## Result\n\nAll requested paragraphs are included.";
  const state = new ConversationParserState();
  parseConversationTextChunk(
    [
      eventMsgLine({ type: "task_started", turn_id: "turn-clean" }),
      responseItemMessageLine("user", "Explain the change"),
      responseItemRawLine({
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [
          {
            type: "output_text",
            text: "The answer covers the fix and the verification commands.",
          },
        ],
      }),
      responseItemRawLine({
        type: "custom_tool_call",
        name: "exec",
        call_id: "internal-images",
        input: wrapper,
      }),
      responseItemRawLine({
        type: "custom_tool_call_output",
        call_id: "internal-images",
        output:
          "Script completed\nWall time 0.0 seconds\nOutput:\nReturned image\nReturned image",
      }),
      ...[first, second].map((text) =>
        responseItemRawLine({
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text }],
        }),
      ),
      eventMsgLine({ type: "task_complete", turn_id: "turn-clean" }),
    ].join("\n") + "\n",
    0,
    undefined,
    state,
  );
  const completion = state.messages.find(
    (message) => message.type === "task_complete",
  )!;
  assert.equal(
    getCompletedTaskAnswer(state.messages, completion),
    `The answer covers the fix and the verification commands.\n\n${first}\n\n${second}`,
  );
  assert.deepEqual(
    state.messages
      .filter((message) => message.message?.phase)
      .map((message) => message.message?.phase),
    ["commentary", "final_answer", "final_answer"],
  );
});

test("legitimate command/code examples containing exec are not removed by text-pattern filtering", () => {
  const completion = complete();
  const answer =
    "## Commands\n\n```sh\nexec node app.js\n```\n\n## JavaScript example\n\n```js\nconst results = await Promise.allSettled([loadFirst(), loadSecond()]);\n```";
  assert.equal(
    getCompletedTaskAnswer([chat("assistant", answer), completion], completion),
    answer,
  );
});

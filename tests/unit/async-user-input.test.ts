import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  CodexUserInputRequest,
  ConversationMessage,
} from "@codex-deck/api";
import { PendingUserInputRequests } from "../../web/components/pending-user-input-requests";
import MessageBlock from "../../web/components/message-block";
import { getViewportMessageGroup } from "../../web/message-viewport-groups";
import {
  shouldDefaultExpandToolUse,
  getSearchableToolUseText,
} from "../../web/message-block-utils";
import {
  buildAsyncUserInputMessage,
  buildUserInputResponsePayload,
  getAsyncUserInputState,
  getUnattachedUserInputRequests,
  isMessageUserInputRequest,
  isUserInputQuestionAnswered,
  normalizeUserInputQuestions,
} from "../../web/user-input";
import { USER_INPUT_OTHER_OPTION_LABEL, sanitizeText } from "../../web/utils";
import { parseAsyncQuestionReply } from "../../web/async-question-reply";
import {
  CodexAppServerRpcError,
  __TEST_ONLY__,
} from "../../api/codex-app-server";

(globalThis as { React?: typeof React }).React = React;

const questions = normalizeUserInputQuestions({
  questions: [
    {
      id: "audience",
      title: "Who is the report for?",
      options: ["Engineers", "Executives"],
    },
    { id: "details", title: "Any other requirements?" },
  ],
});

function request(id = "question-1"): CodexUserInputRequest {
  return {
    requestId: id,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: `item-${id}`,
    isBlocking: false,
    questions,
  };
}

test("async question schemas accept string options and free text alongside legacy questions", () => {
  assert.deepEqual(questions[0].options, [
    { label: "Engineers", description: "" },
    { label: "Executives", description: "" },
  ]);
  assert.deepEqual(questions[1].options, []);
  assert.equal(questions[1].question, "Any other requirements?");
  assert.deepEqual(
    normalizeUserInputQuestions({
      questions: [
        {
          id: "legacy",
          header: "Scope",
          question: "Which scope?",
          options: [{ label: "Local", description: "This machine" }],
          isSecret: true,
        },
      ],
    })[0],
    {
      id: "legacy",
      header: "Scope",
      question: "Which scope?",
      options: [{ label: "Local", description: "This machine" }],
      isOther: false,
      isSecret: true,
      multiSelect: false,
    },
  );
});

test("free-text replies send the answer itself and do not submit empty drafts", () => {
  assert.equal(
    isUserInputQuestionAnswered(questions[1], {
      optionLabel: USER_INPUT_OTHER_OPTION_LABEL,
      otherText: "  ",
    }),
    false,
  );
  assert.deepEqual(
    buildUserInputResponsePayload(request(), {
      audience: { optionLabel: "Engineers", otherText: "" },
      details: {
        optionLabel: USER_INPUT_OTHER_OPTION_LABEL,
        otherText: "  Include examples  ",
      },
    }),
    {
      answers: {
        audience: { answers: ["Engineers"] },
        details: { answers: ["Include examples"] },
      },
    },
  );
  assert.deepEqual(buildUserInputResponsePayload(request(), {}), {
    answers: {},
  });
});

test("requests without tool calls remain independently answerable while messages continue", () => {
  const requests = [request(), request("question-2")];
  const messages: ConversationMessage[] = [
    {
      type: "assistant",
      message: { role: "assistant", content: "Working while you answer." },
    },
  ];
  assert.deepEqual(
    getUnattachedUserInputRequests(messages, requests),
    requests,
  );
  const html = renderToStaticMarkup(
    createElement(PendingUserInputRequests, {
      requests,
      selectedAnswers: {
        "question-2": {
          details: {
            optionLabel: USER_INPUT_OTHER_OPTION_LABEL,
            otherText: "Saved draft",
          },
        },
      },
      submittingRequestIds: ["question-1"],
      onSelectOption: () => {},
      onChangeOtherText: () => {},
      onSubmitAnswers: () => {},
    }),
  );
  assert.equal(
    (html.match(/data-pending-user-input-request=/g) ?? []).length,
    2,
  );
  assert.match(html, /Agent can continue working/);
  assert.match(html, /<textarea[^>]+aria-label="Any other requirements\?"/);
  assert.match(html, /Saved draft/);
  assert.match(html, /Sending answers/);
});

test("async tool calls expand, stay prominent and use the app-server question IDs when answering", () => {
  const block = {
    type: "tool_use" as const,
    id: "item-question-1",
    name: "request_user_input_async",
    input: {
      questions: [
        {
          title: "Who is the report for?",
          options: ["Engineers", "Executives"],
        },
      ],
    },
  };
  const message: ConversationMessage = {
    type: "assistant",
    message: { role: "assistant", content: [block] },
  };
  assert.equal(shouldDefaultExpandToolUse(block.name), true);
  assert.equal(getViewportMessageGroup(message), "important");
  assert.match(getSearchableToolUseText(block), /Who is the report for\?/);
  assert.match(getSearchableToolUseText(block), /Engineers/);
  assert.deepEqual(getUnattachedUserInputRequests([message], [request()]), []);
  const html = renderToStaticMarkup(
    createElement(MessageBlock, {
      message,
      pendingUserInputRequests: [request()],
      onSelectUserInputOption: () => {},
      onChangeUserInputOtherText: () => {},
      onSubmitUserInputAnswers: () => {},
    }),
  );
  assert.match(html, /Any other requirements\?/);
  assert.match(html, /<textarea[^>]+aria-label="Any other requirements\?"/);
  assert.doesNotMatch(html, /<button[^>]+disabled=""[^>]*>[\s\S]*?Engineers/);
});

test("acknowledged async tool calls accept message replies without a pending RPC", () => {
  const messages: ConversationMessage[] = [
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "async-call",
            name: "request_user_input_async",
            input: { questions: [{ title: "Any requirements?" }] },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "async-call",
            content: '{"accepted":true}',
          },
        ],
      },
    },
  ];
  const state = getAsyncUserInputState(messages, "thread-1");
  assert.equal(state.requests.length, 1);
  assert.equal(state.resolvedAnswersByItemId.size, 0);
  const request = state.requests[0];
  assert.equal(isMessageUserInputRequest(request), true);
  assert.equal(request.questions[0].id, "question-0");
  const draft = {
    optionLabel: USER_INPUT_OTHER_OPTION_LABEL,
    otherText: "Include examples",
  };
  const text = buildAsyncUserInputMessage(
    request,
    buildUserInputResponsePayload(request, { "question-0": draft }),
  );
  assert.equal(
    text,
    '<send_user_message_question_reply>\n[{"answer":"Include examples","question":"Any requirements?","questionItemId":"[\\"request_user_input_async\\",\\"async-call\\",0]"}]\n</send_user_message_question_reply>',
  );
  assert.equal(sanitizeText(text), "> Any requirements?\n\nInclude examples");
  assert.deepEqual(
    getAsyncUserInputState(messages, "thread-1", [
      { text },
    ]).resolvedAnswersByItemId.get("async-call"),
    { "question-0": draft },
  );
  // Removing a failed or cancelled pending message makes the question answerable again.
  assert.equal(
    getAsyncUserInputState(messages, "thread-1").resolvedAnswersByItemId.size,
    0,
  );
  messages.push({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  });
  assert.deepEqual(
    getAsyncUserInputState(messages, "thread-1").resolvedAnswersByItemId.get(
      "async-call",
    ),
    { "question-0": draft },
  );
});

test("message replies resolve only their own questions and preserve choice and custom answers", () => {
  const messages: ConversationMessage[] = [
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: ["first", "second"].map((id) => ({
          type: "tool_use" as const,
          id,
          name: "request_user_input_async",
          input: {
            questions: [
              {
                title: `Audience for ${id}?`,
                options: ["Engineers", "Executives"],
              },
              { title: `Requirements for ${id}?`, options: ["Use defaults"] },
            ],
          },
        })),
      },
    },
  ];
  const state = getAsyncUserInputState(messages, "thread-1");
  const drafts = {
    "question-0": { optionLabel: "Engineers", otherText: "" },
    "question-1": {
      optionLabel: USER_INPUT_OTHER_OPTION_LABEL,
      otherText: "Custom\nrequirements",
    },
  };
  const request = state.requests[1];
  const text = buildAsyncUserInputMessage(
    request,
    buildUserInputResponsePayload(request, drafts),
  );
  const resolved = getAsyncUserInputState(messages, "thread-1", [{ text }]);
  assert.equal(resolved.resolvedAnswersByItemId.has("first"), false);
  assert.deepEqual(resolved.resolvedAnswersByItemId.get("second"), drafts);
  messages.push({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "first",
          is_error: true,
          content: "Tool failed",
        },
      ],
    },
  });
  assert.deepEqual(
    getAsyncUserInputState(messages, "thread-1").requests.map(
      (request) => request.itemId,
    ),
    ["second"],
  );
});

function asyncQuestionMessages(): ConversationMessage[] {
  return [
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-1",
            name: "request_user_input_async",
            input: {
              questions: [
                { title: "Which environment?", options: ["Staging", "Prod"] },
                { title: "Anything else?" },
              ],
            },
          },
        ],
      },
    },
  ];
}

test("replies from the Codex TUI or desktop resolve questions by their stable id", () => {
  const messages = asyncQuestionMessages();
  // The TUI answers one question per message, with the Codex envelope.
  messages.push({
    type: "user",
    message: {
      role: "user",
      content:
        '<send_user_message_question_reply>\n[{"answer":"Staging","question":"Which environment?","questionItemId":"[\\"request_user_input_async\\",\\"call-1\\",0]"}]\n</send_user_message_question_reply>',
    },
  });
  assert.deepEqual(
    getAsyncUserInputState(messages, "thread-1").resolvedAnswersByItemId.get(
      "call-1",
    ),
    { "question-0": { optionLabel: "Staging", otherText: "" } },
  );
  // Older desktop replies identify the whole tool call.
  const older = asyncQuestionMessages();
  older.push({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: '<send_user_message_question_reply>{"questionItemId":"call-1","question":"Which environment?","answer":"Prod"}</send_user_message_question_reply>',
        },
      ],
    },
  });
  assert.equal(
    getAsyncUserInputState(older, "thread-1").resolvedAnswersByItemId.has(
      "call-1",
    ),
    true,
  );
});

test("answers written by earlier codex-deck versions still resolve their questions", () => {
  const messages = asyncQuestionMessages();
  messages.push({
    type: "user",
    message: {
      role: "user",
      content:
        "Question: Which environment?\nAnswer: Prod\n\nQuestion: Anything else?\nAnswer: No",
    },
  });
  assert.deepEqual(
    getAsyncUserInputState(messages, "thread-1").resolvedAnswersByItemId.get(
      "call-1",
    ),
    {
      "question-0": { optionLabel: "Prod", otherText: "" },
      "question-1": {
        optionLabel: USER_INPUT_OTHER_OPTION_LABEL,
        otherText: "No",
      },
    },
  );
});

test("reply envelopes are only recognized when complete, as in the Codex TUI", () => {
  const reply = '{"questionItemId":"one","question":"First?","answer":"Yes"}';
  assert.deepEqual(
    parseAsyncQuestionReply(
      `# Context from my IDE setup:\nfoo\n## My request for Codex:\n<send_user_message_question_reply>[${reply}]</send_user_message_question_reply>`,
    ),
    [{ questionItemId: "one", question: "First?", answer: "Yes" }],
  );
  for (const text of [
    "<send_user_message_question_reply>[]</send_user_message_question_reply>",
    `<send_user_message_question_reply>[${reply},null]</send_user_message_question_reply>`,
    `Quoted: <send_user_message_question_reply>${reply}</send_user_message_question_reply>`,
    `<send_user_message_question_reply>${reply}</send_user_message_question_reply> trailing`,
  ]) {
    assert.equal(parseAsyncQuestionReply(text), null, text);
    assert.equal(sanitizeText(text), text.trim());
  }
});

function steerHarness(activeTurnId: string | null) {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const harness = client as unknown as {
    request: (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>;
    getThreadState: () => Promise<{ activeTurnId: string | null }>;
    steerActiveTurn: (
      threadId: string,
      input: unknown,
    ) => Promise<{ turnId: string | null; steered?: boolean } | null>;
  };
  harness.getThreadState = async () => ({ activeTurnId });
  return { client, calls, harness };
}

test("async answers steer the running turn and fall back like the Codex TUI", async () => {
  const input = [{ type: "text", text: "answer" }];
  {
    const { client, calls, harness } = steerHarness("turn-1");
    harness.request = async (method, params) => {
      calls.push({ method, params });
      return { turnId: "turn-1" };
    };
    assert.deepEqual(await harness.steerActiveTurn("thread-1", input), {
      turnId: "turn-1",
      steered: true,
    });
    assert.deepEqual(calls, [
      {
        method: "turn/steer",
        params: { threadId: "thread-1", input, expectedTurnId: "turn-1" },
      },
    ]);
    await client.close();
  }
  {
    // No running turn: the caller starts one with turn/start.
    const { client, calls, harness } = steerHarness(null);
    harness.request = async (method, params) => {
      calls.push({ method, params });
      return {};
    };
    assert.equal(await harness.steerActiveTurn("thread-1", input), null);
    assert.deepEqual(calls, []);
    await client.close();
  }
  {
    // The turn ended between reading state and steering.
    const { client, harness } = steerHarness("turn-1");
    harness.request = async () => {
      throw new CodexAppServerRpcError(-32600, "no active turn to steer");
    };
    assert.equal(await harness.steerActiveTurn("thread-1", input), null);
    await client.close();
  }
  {
    // A stale turn id is retried once with the server-reported turn.
    const { client, calls, harness } = steerHarness("turn-1");
    harness.request = async (method, params) => {
      calls.push({ method, params });
      if (params.expectedTurnId === "turn-1") {
        throw new CodexAppServerRpcError(
          -32600,
          "expected active turn id `turn-1` but found `turn-2`",
        );
      }
      return { turnId: "turn-2" };
    };
    assert.deepEqual(await harness.steerActiveTurn("thread-1", input), {
      turnId: "turn-2",
      steered: true,
    });
    assert.deepEqual(
      calls.map((call) => call.params.expectedTurnId),
      ["turn-1", "turn-2"],
    );
    await client.close();
  }
  {
    // Review/compact turns cannot be steered; the web app queues instead.
    const { client, harness } = steerHarness("turn-1");
    harness.request = async () => {
      throw new CodexAppServerRpcError(-32600, "cannot steer a review turn");
    };
    await assert.rejects(
      harness.steerActiveTurn("thread-1", input),
      /cannot steer a review turn/,
    );
    await client.close();
  }
});

function rpcHarness() {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const rpc = client as unknown as {
    handleStdoutMessage: (message: Record<string, unknown>) => void;
    respondToServerRequest: (
      id: string | number,
      value: unknown,
    ) => Promise<void>;
  };
  const send = (
    id: string | number,
    params: Partial<CodexUserInputRequest> & Record<string, unknown> = {},
  ) =>
    rpc.handleStdoutMessage({
      id,
      method: "item/tool/requestUserInput",
      params: { ...request(String(id)), ...params },
    });
  return { client, rpc, send };
}

test("parallel async questions remain pending across agent progress and can be answered in any order", async () => {
  const { client, rpc, send } = rpcHarness();
  const responses: unknown[] = [];
  rpc.respondToServerRequest = async (id, value) => {
    responses.push({ id, value });
  };
  const eventsA: unknown[] = [],
    eventsB: unknown[] = [];
  const stopA = client.subscribeAppServerEvents((event) => eventsA.push(event));
  const stopB = client.subscribeAppServerEvents((event) => eventsB.push(event));
  try {
    send(10);
    send("second", { turnId: "turn-2" });
    send("other-thread", { threadId: "thread-2" });
    rpc.handleStdoutMessage({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "progress",
        delta: "Still working",
      },
    });
    rpc.handleStdoutMessage({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    });
    assert.equal(client.listPendingUserInputRequests("thread-1").length, 2);
    assert.equal(
      client.listPendingUserInputRequests("thread-1")[0].isBlocking,
      false,
    );
    assert.deepEqual(responses, []);
    const answer = { answers: { details: { answers: ["Include examples"] } } };
    await client.submitUserInput("thread-1", "second", answer);
    assert.deepEqual(responses, [{ id: "second", value: answer }]);
    assert.deepEqual(
      client.listPendingUserInputRequests("thread-1").map((r) => r.requestId),
      ["10"],
    );
    await client.submitUserInput("thread-1", "10", answer);
    assert.deepEqual(responses[1], { id: 10, value: answer });
    assert.equal(client.listPendingUserInputRequests("thread-2").length, 1);
    assert.deepEqual(eventsA, eventsB);
    assert.ok(
      eventsA.some(
        (event) => (event as { type: string }).type === "assistant_delta",
      ),
    );
  } finally {
    stopA();
    stopB();
    await client.close();
  }
});

test("legacy blocking metadata, external resolution, and concurrent answers stay safe", async () => {
  const { client, rpc, send } = rpcHarness();
  let completeWrite!: () => void;
  let writes = 0;
  rpc.respondToServerRequest = async () => {
    writes++;
    await new Promise<void>((resolve) => {
      completeWrite = resolve;
    });
  };
  try {
    send(1, { isBlocking: undefined });
    send(2, { isBlocking: undefined, autoResolutionMs: 1000 });
    assert.deepEqual(
      client.listPendingUserInputRequests("thread-1").map((r) => r.isBlocking),
      [true, false],
    );
    const answer = { answers: { audience: { answers: ["Engineers"] } } };
    const first = client.submitUserInput("thread-1", "1", answer);
    await assert.rejects(
      client.submitUserInput("thread-1", "1", answer),
      /already in progress/,
    );
    assert.equal(writes, 1);
    completeWrite();
    await first;
    rpc.handleStdoutMessage({
      method: "serverRequest/resolved",
      params: { requestId: 2 },
    });
    assert.deepEqual(client.listPendingUserInputRequests("thread-1"), []);
    await assert.rejects(
      client.submitUserInput("thread-1", "2", answer),
      /request not found/,
    );
  } finally {
    await client.close();
  }
});

test("a failed answer remains pending and can be retried", async () => {
  const { client, rpc, send } = rpcHarness();
  try {
    send(1);
    rpc.respondToServerRequest = async () => {
      throw new Error("write failed");
    };
    await assert.rejects(
      client.submitUserInput("thread-1", "1", { answers: {} }),
      /write failed/,
    );
    assert.equal(client.listPendingUserInputRequests("thread-1").length, 1);
    rpc.respondToServerRequest = async () => {};
    await client.submitUserInput("thread-1", "1", { answers: {} });
    assert.deepEqual(client.listPendingUserInputRequests("thread-1"), []);
  } finally {
    await client.close();
  }
});

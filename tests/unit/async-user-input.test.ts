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
  buildUserInputResponsePayload,
  getUnattachedUserInputRequests,
  isUserInputQuestionAnswered,
  normalizeUserInputQuestions,
} from "../../web/user-input";
import { USER_INPUT_OTHER_OPTION_LABEL } from "../../web/utils";
import { __TEST_ONLY__ } from "../../api/codex-app-server";

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

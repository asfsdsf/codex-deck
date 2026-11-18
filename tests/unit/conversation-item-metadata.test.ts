import assert from "node:assert/strict";
import test from "node:test";
import {
  ConversationParserState,
  parseConversationTextChunk,
} from "../../api/conversation-parser";
import {
  getAnswerRestriction,
  readConversationItemMetadata,
} from "../../api/conversation-item-metadata";
import { mergeDisplayConversationMessages } from "../../web/conversation-message-merge";
import { transcriptMarkdown } from "../../web/transcript-export";
import { getCompletedTaskAnswer } from "../../web/task-answer";
import { getConversationHoverMetadata } from "../../web/conversation-hover-metadata";
import { eventMsgLine, responseItemMessageLine } from "./test-utils";

const body = "Synthetic original answer";
const started = 1730000000010;
const completed = 1730000002310;
const hide = {
  moderated: true,
  display: {
    version: 1,
    mode: "hide",
    replacement: { kind: "wellbeingPromptHelpline" },
  },
};
const block = {
  moderated: true,
  display: {
    version: 1,
    mode: "block",
    reason: { kind: "protection", protectionType: "test" },
  },
};
const show = {
  moderated: true,
  display: {
    version: 1,
    mode: "show",
    trustedContacts: "skip",
    annotation: { kind: "wellbeingHelpline", subject: "answer" },
  },
};
const unknown = { moderated: false, display: { version: 42, mode: "show" } };

const item = (id: string, moderation: unknown, text = body) => ({
  type: "AgentMessage",
  id,
  phase: "final_answer",
  content: [{ type: "Text", text }],
  moderation,
});
const complete = (id: string, moderation: unknown, text = body) =>
  eventMsgLine({
    type: "item_completed",
    turn_id: "turn1",
    started_at_ms: started,
    completed_at_ms: completed,
    content_token_count: 0,
    item: item(id, moderation, text),
  });
const split = (state: ConversationParserState, lines: string[]) => {
  let offset = 0;
  for (const line of lines) {
    const parsed = parseConversationTextChunk(
      line + "\n",
      offset,
      undefined,
      state,
    );
    offset += parsed.consumedBytes;
  }
  return state.messages;
};

for (const [mode, moderation] of [
  ["hide", hide],
  ["block", block],
  ["show", show],
  ["unknown", unknown],
] as const) {
  test(`persisted ${mode} survives an ID-less response and export`, () => {
    const messages = split(new ConversationParserState(), [
      eventMsgLine({ type: "task_started", turn_id: "turn1" }),
      complete("answer", moderation),
      responseItemMessageLine("assistant", body),
      eventMsgLine({ type: "task_complete", turn_id: "turn1" }),
    ]);
    const answers = messages.filter((message) => message.type === "assistant");
    assert.equal(answers.length, 1);
    const [answer] = answers;
    assert.equal(answer.itemId, "answer");
    assert.equal(answer.startedAtMs, started);
    assert.equal(answer.completedAtMs, completed);
    assert.equal(answer.contentTokenCount, 0);
    assert.equal(answer.moderation?.display?.mode, mode);
    const restricted = mode !== "show";
    const exportText = transcriptMarkdown(messages, "thread");
    assert.equal(JSON.stringify(answers).includes(body), !restricted);
    assert.equal(exportText.includes(body), !restricted);
    assert.equal(
      getCompletedTaskAnswer(messages, messages[2]),
      restricted ? null : body,
    );
    const labels = getConversationHoverMetadata(answer, null).details.map(
      ({ label }) => label,
    );
    assert.ok(
      labels.includes("Content tokens") &&
        labels.includes("Started") &&
        labels.includes("Completed"),
    );
  });
}

test("live moderation overwrites streamed text and later raw records cannot restore it", () => {
  const state = new ConversationParserState();
  state.noteItemStart("turn1", "answer", { startedAtMs: started });
  state.applyStreamText("turn1", "answer", "assistant", body);
  const before = state.messages[0];
  assert.equal(before.startedAtMs, started);
  assert.ok(JSON.stringify(before).includes(body));
  state.completeStreamItem(
    "turn1",
    "answer",
    { type: "agentMessage", text: body, moderation: block },
    readConversationItemMetadata(
      {
        completedAtMs: completed,
        contentTokenCount: 5,
      },
      { moderation: block },
    ),
  );
  const after = state.messages[0];
  state.applyStreamText("turn1", "answer", "assistant", "stale delta");
  const raw = responseItemMessageLine("assistant", body);
  split(state, [
    complete("answer", block),
    raw,
    raw,
    responseItemMessageLine("assistant", "Later permitted answer"),
  ]);
  assert.equal(state.messages.length, 2);
  assert.equal(state.messages[0].uuid, before.uuid);
  assert.equal(
    getAnswerRestriction(state.messages[0].moderation),
    "Codex blocked this answer.",
  );
  assert.doesNotMatch(
    JSON.stringify(state.messages),
    /Synthetic original answer|stale delta/,
  );
  assert.match(JSON.stringify(state.messages[1]), /Later permitted answer/);

  const staleWindow = { ...before, revision: (after.revision ?? 0) + 1 };
  assert.doesNotMatch(
    JSON.stringify(mergeDisplayConversationMessages([after], [staleWindow])),
    /Synthetic original answer/,
  );
});

test("a completion following its raw legacy message updates that slot only", () => {
  const messages = split(new ConversationParserState(), [
    eventMsgLine({ type: "task_started", turn_id: "turn1" }),
    responseItemMessageLine("assistant", body),
    complete("answer", hide),
    responseItemMessageLine("assistant", "Unrelated text"),
  ]);
  const answers = messages.filter((message) => message.type === "assistant");
  assert.equal(answers.length, 2);
  assert.equal(
    getAnswerRestriction(answers[0].moderation),
    "Codex hid this answer.",
  );
  assert.equal(getAnswerRestriction(answers[1].moderation), null);
});

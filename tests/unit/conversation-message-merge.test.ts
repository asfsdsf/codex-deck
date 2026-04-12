import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationMessage } from "@codex-deck/api";
import { mergeDisplayConversationMessages } from "../../web/conversation-message-merge";

function createPendingToolMessage(
  callId: string,
  uuid: string,
): ConversationMessage {
  return {
    type: "assistant",
    uuid,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: callId,
          name: "apply_patch",
          input: { raw: "*** Begin Patch\n*** End Patch\n" },
        },
      ],
    },
  };
}

function createToolResultOnlyMessage(
  callId: string,
  uuid: string,
): ConversationMessage {
  return {
    type: "assistant",
    uuid,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_result",
          tool_use_id: callId,
          name: "apply_patch",
          content: "Done",
        },
      ],
    },
  };
}

function createPairedToolMessage(
  callId: string,
  uuid: string,
): ConversationMessage {
  return {
    type: "assistant",
    uuid,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: callId,
          name: "apply_patch",
          input: { raw: "*** Begin Patch\n*** End Patch\n" },
        },
        {
          type: "tool_result",
          tool_use_id: callId,
          name: "apply_patch",
          content: "Done",
        },
      ],
    },
  };
}

test("merges tool_result-only updates into existing pending tool messages", () => {
  const previousMessages = [createPendingToolMessage("call_1", "pending_1")];
  const incomingMessages = [createToolResultOnlyMessage("call_1", "result_1")];

  const merged = mergeDisplayConversationMessages(
    previousMessages,
    incomingMessages,
    "append",
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].uuid, "result_1");
  assert.ok(Array.isArray(merged[0].message?.content));
  assert.equal((merged[0].message?.content as unknown[]).length, 2);
});

test("replaces pending tool message when a paired tool message arrives", () => {
  const previousMessages = [createPendingToolMessage("call_1", "pending_1")];
  const incomingMessages = [createPairedToolMessage("call_1", "paired_1")];

  const merged = mergeDisplayConversationMessages(
    previousMessages,
    incomingMessages,
    "append",
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].uuid, "paired_1");
  assert.ok(Array.isArray(merged[0].message?.content));
  assert.equal((merged[0].message?.content as unknown[]).length, 2);
});

test("keeps unmatched tool result messages as separate entries", () => {
  const previousMessages = [createPendingToolMessage("call_1", "pending_1")];
  const incomingMessages = [createToolResultOnlyMessage("call_2", "result_2")];

  const merged = mergeDisplayConversationMessages(
    previousMessages,
    incomingMessages,
    "append",
  );

  assert.equal(merged.length, 2);
  assert.equal(merged[0].uuid, "pending_1");
  assert.equal(merged[1].uuid, "result_2");
});

test("preserves prepend ordering behavior", () => {
  const previousMessages = [createPendingToolMessage("call_2", "pending_2")];
  const incomingMessages = [createPendingToolMessage("call_1", "pending_1")];

  const merged = mergeDisplayConversationMessages(
    previousMessages,
    incomingMessages,
    "prepend",
  );

  assert.equal(merged.length, 2);
  assert.equal(merged[0].uuid, "pending_1");
  assert.equal(merged[1].uuid, "pending_2");
});

test("merges token limit notices across prepend boundaries", () => {
  const previousMessages: ConversationMessage[] = [
    {
      type: "token_limit_notice",
      uuid: "notice_2",
      timestamp: "2026-01-01T00:00:02.000Z",
      repeatCount: 2,
      repeatCountMax: 6,
      rateLimitId: "codex",
      summary: "Rate Limit Reached",
      message: {
        role: "assistant",
        content:
          "Token count updates hit the Codex rate limit. Codex is waiting and retrying automatically.",
      },
    },
  ];
  const incomingMessages: ConversationMessage[] = [
    {
      type: "token_limit_notice",
      uuid: "notice_1",
      timestamp: "2026-01-01T00:00:01.000Z",
      repeatCount: 1,
      repeatCountMax: 6,
      rateLimitId: "codex",
      summary: "Rate Limit Reached",
      message: {
        role: "assistant",
        content:
          "Token count updates hit the Codex rate limit. Codex is waiting and retrying automatically.",
      },
    },
  ];

  const merged = mergeDisplayConversationMessages(
    previousMessages,
    incomingMessages,
    "prepend",
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.uuid, "notice_2");
  assert.equal(merged[0]?.repeatCount, 3);
  assert.equal(merged[0]?.timestamp, "2026-01-01T00:00:02.000Z");
});

test("merges consecutive token limit notices into one live-updated message", () => {
  const previousMessages: ConversationMessage[] = [
    {
      type: "token_limit_notice",
      uuid: "notice_1",
      timestamp: "2026-01-01T00:00:01.000Z",
      repeatCount: 2,
      repeatCountMax: 6,
      rateLimitId: "codex",
      summary: "Rate Limit Reached",
      message: {
        role: "assistant",
        content:
          "Token count updates hit the Codex rate limit. Codex is waiting and retrying automatically.",
      },
    },
  ];
  const incomingMessages: ConversationMessage[] = [
    {
      type: "token_limit_notice",
      uuid: "notice_2",
      timestamp: "2026-01-01T00:00:02.000Z",
      repeatCount: 1,
      repeatCountMax: 6,
      rateLimitId: "codex",
      summary: "Rate Limit Reached",
      message: {
        role: "assistant",
        content:
          "Token count updates hit the Codex rate limit. Codex is waiting and retrying automatically.",
      },
    },
  ];

  const merged = mergeDisplayConversationMessages(
    previousMessages,
    incomingMessages,
    "append",
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.uuid, "notice_2");
  assert.equal(merged[0]?.repeatCount, 3);
  assert.equal(merged[0]?.timestamp, "2026-01-01T00:00:02.000Z");
});

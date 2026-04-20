import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationMessage } from "@codex-deck/api";
import { deriveTerminalEmbeddedMessagesState } from "../../web/terminal-embedded-messages";

function createAssistantMessage(
  uuid: string,
  content: string,
): ConversationMessage {
  return {
    uuid,
    type: "assistant",
    message: {
      role: "assistant",
      content,
    },
  };
}

function createUserMessage(uuid: string, content: string): ConversationMessage {
  return {
    uuid,
    type: "user",
    message: {
      role: "user",
      content,
    },
  };
}

test("deriveTerminalEmbeddedMessagesState preserves state identity for non-terminal-visible messages", () => {
  const sessionId = "session-terminal";
  const visiblePlan = createAssistantMessage(
    "plan-1",
    `<ai-terminal-plan>
  <ai-terminal-step>
    <step_id>pwd</step_id>
    <step_goal>Show current directory</step_goal>
    <command><![CDATA[pwd]]></command>
    <risk>low</risk>
    <next_action>approve</next_action>
  </ai-terminal-step>
</ai-terminal-plan>`,
  );

  const current = deriveTerminalEmbeddedMessagesState({
    current: {
      sessionId,
      messages: [],
      persistedStepStatesByMessageKey: {},
    },
    sessionId,
    mergedMessages: [visiblePlan],
  });

  const next = deriveTerminalEmbeddedMessagesState({
    current,
    sessionId,
    mergedMessages: [visiblePlan, createUserMessage("user-1", "thanks")],
  });

  assert.equal(next, current);
});

test("deriveTerminalEmbeddedMessagesState returns a new state when a visible plan card changes", () => {
  const sessionId = "session-terminal";
  const firstPlan = createAssistantMessage(
    "plan-1",
    `<ai-terminal-plan>
  <ai-terminal-step>
    <step_id>pwd</step_id>
    <command><![CDATA[pwd]]></command>
    <risk>low</risk>
    <next_action>approve</next_action>
  </ai-terminal-step>
</ai-terminal-plan>`,
  );
  const secondPlan = createAssistantMessage(
    "plan-2",
    `<ai-terminal-plan>
  <ai-terminal-step>
    <step_id>ls</step_id>
    <command><![CDATA[ls]]></command>
    <risk>low</risk>
    <next_action>approve</next_action>
  </ai-terminal-step>
</ai-terminal-plan>`,
  );

  const current = deriveTerminalEmbeddedMessagesState({
    current: {
      sessionId,
      messages: [],
      persistedStepStatesByMessageKey: {},
    },
    sessionId,
    mergedMessages: [firstPlan],
  });

  const next = deriveTerminalEmbeddedMessagesState({
    current,
    sessionId,
    mergedMessages: [firstPlan, secondPlan],
  });

  assert.notEqual(next, current);
  assert.deepEqual(
    next.messages.map((item) => item.messageKey),
    ["plan-1", "plan-2"],
  );
});

test("deriveTerminalEmbeddedMessagesState returns a new state when persisted step feedback changes", () => {
  const sessionId = "session-terminal";
  const plan = createAssistantMessage(
    "plan-1",
    `<ai-terminal-plan>
  <ai-terminal-step>
    <step_id>pwd</step_id>
    <command><![CDATA[pwd]]></command>
    <risk>low</risk>
    <next_action>approve</next_action>
  </ai-terminal-step>
</ai-terminal-plan>`,
  );
  const feedback = createAssistantMessage(
    "feedback-1",
    `<ai-terminal-execution>
  <step_id>pwd</step_id>
  <status>success</status>
</ai-terminal-execution>`,
  );

  const current = deriveTerminalEmbeddedMessagesState({
    current: {
      sessionId,
      messages: [],
      persistedStepStatesByMessageKey: {},
    },
    sessionId,
    mergedMessages: [plan],
  });

  const next = deriveTerminalEmbeddedMessagesState({
    current,
    sessionId,
    mergedMessages: [plan, feedback],
  });

  assert.notEqual(next, current);
  assert.deepEqual(next.persistedStepStatesByMessageKey, {
    "plan-1": {
      pwd: "completed",
    },
  });
});

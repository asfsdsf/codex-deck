import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationMessage } from "../../api/storage";
import { mergePendingConversationMessages } from "../../web/pending-conversation-messages";
import type { PendingUserMessage } from "../../web/pending-user-messages";

function message(
  type: "user" | "assistant",
  uuid: string,
  turnId: string,
): ConversationMessage {
  return {
    type,
    uuid,
    turnId,
    message: {
      role: type,
      content: type === "user" ? "Prompt" : "Reply",
    },
  };
}

function pending(
  pendingId: string,
  status: PendingUserMessage["status"],
  turnId?: string,
): PendingUserMessage {
  return {
    pendingId,
    text: `Pending ${pendingId}`,
    images: [],
    status,
    turnId,
  };
}

test("places a sent pending prompt before live output from its turn", () => {
  const entries = mergePendingConversationMessages(
    [
      message("user", "user-old", "turn-old"),
      message("assistant", "assistant-old", "turn-old"),
      {
        ...message("assistant", "live:thread:turn-new:item:delta", "turn-new"),
        message: { role: "assistant", content: "Streaming reply" },
      },
    ],
    [pending("new", "awaiting_confirmation", "turn-new")],
  );

  assert.deepEqual(
    entries.map((entry) => entry.message.uuid),
    [
      "user-old",
      "assistant-old",
      "pending:new",
      "live:thread:turn-new:item:delta",
    ],
  );
});

test("does not duplicate a pending prompt after its user record arrives", () => {
  const entries = mergePendingConversationMessages(
    [
      message("user", "user-new", "turn-new"),
      message("assistant", "assistant-new", "turn-new"),
    ],
    [pending("new", "awaiting_confirmation", "turn-new")],
  );

  assert.deepEqual(
    entries.map((entry) => entry.message.uuid),
    ["user-new", "assistant-new"],
  );
});

test("places a sending prompt before a live delta that beats turn/start", () => {
  const entries = mergePendingConversationMessages(
    [
      message("user", "user-old", "turn-old"),
      {
        ...message("assistant", "live:thread:turn-new:item:delta", "turn-new"),
        message: { role: "assistant", content: "Streaming reply" },
      },
    ],
    [pending("new", "sending")],
  );

  assert.deepEqual(
    entries.map((entry) => entry.message.uuid),
    ["user-old", "pending:new", "live:thread:turn-new:item:delta"],
  );
});

test("keeps queued prompts after the active turn output", () => {
  const entries = mergePendingConversationMessages(
    [
      message("user", "user-active", "turn-active"),
      message("assistant", "assistant-active", "turn-active"),
    ],
    [pending("queued", "queued")],
  );

  assert.deepEqual(
    entries.map((entry) => entry.message.uuid),
    ["user-active", "assistant-active", "pending:queued"],
  );
});

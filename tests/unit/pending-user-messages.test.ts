import test from "node:test";
import assert from "node:assert/strict";
import {
  appendPendingUserMessage,
  consumeConfirmedPendingUserMessages,
  removePendingUserMessage,
  updatePendingUserMessageStatus,
  type PendingUserMessagesBySession,
} from "../../web/pending-user-messages";

const SESSION_ID = "session-1";

function buildState(): PendingUserMessagesBySession {
  return {
    [SESSION_ID]: [
      {
        pendingId: "a",
        text: "first",
        images: [],
        status: "sending",
      },
      {
        pendingId: "b",
        text: "second",
        images: [],
        status: "awaiting_confirmation",
      },
      {
        pendingId: "c",
        text: "third",
        images: [],
        status: "awaiting_confirmation",
      },
    ],
  };
}

test("appendPendingUserMessage appends to session queue", () => {
  const initial: PendingUserMessagesBySession = {};
  const next = appendPendingUserMessage(initial, SESSION_ID, {
    pendingId: "new",
    text: "hello",
    images: [],
    status: "sending",
  });

  assert.equal(next[SESSION_ID].length, 1);
  assert.equal(next[SESSION_ID][0].pendingId, "new");
});

test("updatePendingUserMessageStatus updates only matching entry", () => {
  const initial = buildState();
  const next = updatePendingUserMessageStatus(
    initial,
    SESSION_ID,
    "a",
    "awaiting_confirmation",
  );

  assert.equal(next[SESSION_ID][0].status, "awaiting_confirmation");
  assert.equal(next[SESSION_ID][1].status, "awaiting_confirmation");
});

test("removePendingUserMessage removes matching entry", () => {
  const initial = buildState();
  const next = removePendingUserMessage(initial, SESSION_ID, "b");
  assert.deepEqual(
    next[SESSION_ID].map((entry) => entry.pendingId),
    ["a", "c"],
  );
});

test("consumeConfirmedPendingUserMessages removes oldest entries in FIFO order", () => {
  const initial = buildState();
  const next = consumeConfirmedPendingUserMessages(initial, SESSION_ID, 2);
  assert.deepEqual(
    next[SESSION_ID].map((entry) => entry.pendingId),
    ["c"],
  );
});

test("consumeConfirmedPendingUserMessages clamps removals to queue length", () => {
  const initial = buildState();
  const next = consumeConfirmedPendingUserMessages(initial, SESSION_ID, 99);
  assert.deepEqual(next[SESSION_ID], []);
});

test("consumeConfirmedPendingUserMessages is no-op for zero delta", () => {
  const initial = buildState();
  const next = consumeConfirmedPendingUserMessages(initial, SESSION_ID, 0);
  assert.equal(next, initial);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  appendPendingUserMessage,
  consumeConfirmedPendingUserMessages,
  getPendingUserMessage,
  hasQueuedPendingUserMessages,
  nextQueuedPendingUserMessage,
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

test("updatePendingUserMessageStatus associates the confirmed turn", () => {
  const initial = buildState();
  const next = updatePendingUserMessageStatus(
    initial,
    SESSION_ID,
    "a",
    "awaiting_confirmation",
    " turn-1 ",
  );

  assert.equal(next[SESSION_ID][0].turnId, "turn-1");
  assert.equal(next[SESSION_ID][1].turnId, undefined);
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

function buildStateWithQueued(): PendingUserMessagesBySession {
  return {
    [SESSION_ID]: [
      {
        pendingId: "sent",
        text: "already sent",
        images: [],
        status: "awaiting_confirmation",
      },
      {
        pendingId: "q1",
        text: "queued first",
        images: [],
        status: "queued",
      },
      {
        pendingId: "q2",
        text: "queued second",
        images: [],
        status: "queued",
      },
    ],
  };
}

test("nextQueuedPendingUserMessage returns oldest queued entry", () => {
  const state = buildStateWithQueued();
  assert.equal(
    nextQueuedPendingUserMessage(state, SESSION_ID)?.pendingId,
    "q1",
  );
});

test("nextQueuedPendingUserMessage returns null without queued entries", () => {
  assert.equal(nextQueuedPendingUserMessage(buildState(), SESSION_ID), null);
  assert.equal(nextQueuedPendingUserMessage({}, SESSION_ID), null);
});

test("hasQueuedPendingUserMessages reflects queued entries", () => {
  assert.equal(
    hasQueuedPendingUserMessages(buildStateWithQueued(), SESSION_ID),
    true,
  );
  assert.equal(hasQueuedPendingUserMessages(buildState(), SESSION_ID), false);
});

test("getPendingUserMessage finds entry by pendingId", () => {
  const state = buildStateWithQueued();
  assert.equal(
    getPendingUserMessage(state, SESSION_ID, "q2")?.text,
    "queued second",
  );
  assert.equal(getPendingUserMessage(state, SESSION_ID, "missing"), null);
});

test("consumeConfirmedPendingUserMessages skips queued entries", () => {
  const state = buildStateWithQueued();
  const next = consumeConfirmedPendingUserMessages(state, SESSION_ID, 2);
  assert.deepEqual(
    next[SESSION_ID].map((entry) => entry.pendingId),
    ["q1", "q2"],
  );
});

test("consumeConfirmedPendingUserMessages is no-op when only queued entries remain", () => {
  const state: PendingUserMessagesBySession = {
    [SESSION_ID]: [
      {
        pendingId: "q1",
        text: "queued",
        images: [],
        status: "queued",
      },
    ],
  };
  const next = consumeConfirmedPendingUserMessages(state, SESSION_ID, 1);
  assert.equal(next, state);
});

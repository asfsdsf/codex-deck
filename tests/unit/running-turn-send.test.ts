import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexAppServerRpcError,
  __TEST_ONLY__,
} from "../../api/codex-app-server";
import { resolveComposerPrimaryActionState } from "../../web/message-composer-actions";
import {
  markPendingUserMessageSteered,
  type PendingUserMessagesBySession,
} from "../../web/pending-user-messages";
import {
  isNonSteerableTurnError,
  resolveComposerSendRoute,
  runningTurnComposerHint,
} from "../../web/running-turn-send";

test("Enter steers a running turn, Tab queues, and idle sends start a turn", () => {
  assert.equal(
    resolveComposerSendRoute({
      turnActive: true,
      hasQueuedBacklog: false,
      intent: "default",
    }),
    "steer",
  );
  // A queued backlog does not block steering, as in the Codex TUI.
  assert.equal(
    resolveComposerSendRoute({
      turnActive: true,
      hasQueuedBacklog: true,
      intent: "default",
    }),
    "steer",
  );
  assert.equal(
    resolveComposerSendRoute({
      turnActive: true,
      hasQueuedBacklog: false,
      intent: "queue",
    }),
    "queue",
  );
  // Tab while idle submits immediately.
  assert.equal(
    resolveComposerSendRoute({
      turnActive: false,
      hasQueuedBacklog: false,
      intent: "queue",
    }),
    "start",
  );
  assert.equal(
    resolveComposerSendRoute({
      turnActive: false,
      hasQueuedBacklog: true,
      intent: "default",
    }),
    "queue",
  );
});

test("only review and compact steer rejections fall back to the queue", () => {
  assert.equal(isNonSteerableTurnError("cannot steer a review turn"), true);
  assert.equal(isNonSteerableTurnError("cannot steer a compact turn"), true);
  assert.equal(isNonSteerableTurnError("no active turn to steer"), false);
  assert.equal(
    isNonSteerableTurnError("expected active turn id `a` but found `b`"),
    false,
  );
});

test("the composer labels the send action Steer while a turn runs", () => {
  const base = {
    hasMessageContent: true,
    hasIdlePrimaryAction: false,
    idlePrimaryActionButtonLabel: "Send",
    idlePrimaryActionBusy: false,
    idlePrimaryActionOnlyWithoutContent: false,
    allowIdlePrimaryActionWithoutContent: false,
    sendingMessage: false,
    shouldUseStopAction: false,
    stoppingTurn: false,
  };
  assert.equal(resolveComposerPrimaryActionState(base).label, "Send");
  const steer = resolveComposerPrimaryActionState({
    ...base,
    steerWhileGenerating: true,
  });
  assert.equal(steer.kind, "send");
  assert.equal(steer.label, "Steer");
  assert.match(
    runningTurnComposerHint({ canQueue: true, touch: false }),
    /Enter to steer.*Tab to queue/,
  );
  assert.doesNotMatch(
    runningTurnComposerHint({ canQueue: true, touch: true }),
    /Tab/,
  );
});

test("steered pending messages are flagged once", () => {
  const state: PendingUserMessagesBySession = {
    s: [
      {
        pendingId: "a",
        text: "hi",
        images: [],
        status: "awaiting_confirmation",
      },
    ],
  };
  const next = markPendingUserMessageSteered(state, "s", "a");
  assert.equal(next.s[0].steered, true);
  assert.equal(markPendingUserMessageSteered(next, "s", "a"), next);
  assert.equal(markPendingUserMessageSteered(state, "s", "missing"), state);
});

test("steering uses the caller's expected turn id and retries once on mismatch", async () => {
  const client = new __TEST_ONLY__.CodexAppServerClient();
  const calls: Array<Record<string, unknown>> = [];
  let stateReads = 0;
  const harness = client as unknown as {
    request: (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>;
    getThreadState: () => Promise<{ activeTurnId: string | null }>;
    steerActiveTurn: (
      threadId: string,
      input: unknown,
      expectedTurnId?: string | null,
    ) => Promise<{ turnId: string | null; steered?: boolean } | null>;
  };
  harness.getThreadState = async () => {
    stateReads += 1;
    return { activeTurnId: "turn-server" };
  };
  harness.request = async (_method, params) => {
    calls.push(params);
    if (params.expectedTurnId === "turn-browser") {
      throw new CodexAppServerRpcError(
        -32600,
        "expected active turn id `turn-browser` but found `turn-next`",
      );
    }
    return { turnId: params.expectedTurnId };
  };
  assert.deepEqual(await harness.steerActiveTurn("t", [], "turn-browser"), {
    turnId: "turn-next",
    steered: true,
  });
  assert.deepEqual(
    calls.map((call) => call.expectedTurnId),
    ["turn-browser", "turn-next"],
  );
  assert.equal(stateReads, 0);

  // A turn that finished meanwhile makes the caller start a new turn.
  harness.request = async () => {
    throw new CodexAppServerRpcError(-32600, "no active turn to steer");
  };
  assert.equal(await harness.steerActiveTurn("t", [], "turn-old"), null);
  await client.close();
});

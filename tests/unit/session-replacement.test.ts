import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "../../api/storage";
import { movePendingUserMessages } from "../../web/pending-user-messages";
import { replaceSessionId } from "../../web/session-replacement";

const session = (id: string, display = "(new session)"): Session =>
  ({ id, display, createdAt: 1, timestamp: 1, project: "/repo" }) as Session;

test("a replaced session keeps its list position and drops a stale duplicate", () => {
  const list = [
    session("a"),
    session("old"),
    session("new", "stale"),
    session("b"),
  ];
  assert.deepEqual(
    replaceSessionId(list, "old", "new").map((item) => [item.id, item.display]),
    [
      ["a", "(new session)"],
      ["new", "(new session)"],
      ["b", "(new session)"],
    ],
  );
  assert.equal(replaceSessionId(list, "missing", "new"), list);
  assert.equal(replaceSessionId(list, "old", "old"), list);
});

test("pending messages move to the replacement session", () => {
  const message = {
    pendingId: "p1",
    text: "hi",
    images: [],
    status: "sending" as const,
  };
  const moved = movePendingUserMessages(
    { old: [message], other: [] },
    "old",
    "new",
  );
  assert.deepEqual(moved, { other: [], new: [message] });
  const untouched = { other: [] };
  assert.equal(movePendingUserMessages(untouched, "old", "new"), untouched);
});

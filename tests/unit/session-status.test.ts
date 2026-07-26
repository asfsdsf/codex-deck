import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_STATUS_STORAGE_KEY,
  getSessionStatus,
  markTrackedSessionReviewed,
  persistTrackedSessionStatuses,
  readTrackedSessionStatuses,
  removeTrackedSessionStatus,
  settleTrackedSession,
  trackSessionRunning,
} from "../../web/session-status";

test("unknown sessions default to completed", () => {
  assert.equal(getSessionStatus({}, "external-session"), "completed");
});

test("tracked sessions move from running to unreviewed until opened", () => {
  const running = trackSessionRunning({}, "session-1", "turn-1");
  assert.equal(getSessionStatus(running, "session-1"), "running");

  const unreviewed = settleTrackedSession(running, "session-1", false);
  assert.equal(getSessionStatus(unreviewed, "session-1"), "unreviewed");

  const reviewed = markTrackedSessionReviewed(unreviewed, "session-1");
  assert.equal(getSessionStatus(reviewed, "session-1"), "completed");
});

test("a viewed session becomes completed as soon as its turn settles", () => {
  const running = trackSessionRunning({}, "session-1", "turn-1");
  const settled = settleTrackedSession(running, "session-1", true);
  assert.deepEqual(settled, {});
});

test("tracked status storage ignores malformed and completed entries", () => {
  const storage = {
    getItem(key: string) {
      assert.equal(key, SESSION_STATUS_STORAGE_KEY);
      return JSON.stringify({
        running: { status: "running", turnId: " turn-1 " },
        unread: { status: "unreviewed", turnId: null },
        completed: { status: "completed", turnId: null },
        malformed: "running",
      });
    },
  };

  assert.deepEqual(readTrackedSessionStatuses(storage), {
    running: { status: "running", turnId: "turn-1" },
    unread: { status: "unreviewed", turnId: null },
  });
});

test("tracked status storage persists and removes entries", () => {
  let writtenKey = "";
  let writtenValue = "";
  persistTrackedSessionStatuses(
    { "session-1": { status: "unreviewed", turnId: "turn-1" } },
    {
      setItem(key: string, value: string) {
        writtenKey = key;
        writtenValue = value;
      },
    },
  );

  assert.equal(writtenKey, SESSION_STATUS_STORAGE_KEY);
  assert.deepEqual(JSON.parse(writtenValue), {
    "session-1": { status: "unreviewed", turnId: "turn-1" },
  });
  assert.deepEqual(
    removeTrackedSessionStatus(JSON.parse(writtenValue), "session-1"),
    {},
  );
});

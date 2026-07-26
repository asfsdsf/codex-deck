import assert from "node:assert/strict";
import test from "node:test";
import { createSettleChimeTracker } from "../../web/session-settle-chime";

test("chimes only for sessions observed running, once per settle", () => {
  const tracker = createSettleChimeTracker();

  tracker.noteRunning("session-a");

  assert.equal(tracker.consumeSettled("session-a"), true);
  // Eligibility is consumed; a repeated settle stays silent.
  assert.equal(tracker.consumeSettled("session-a"), false);
  // A session never observed running stays silent.
  assert.equal(tracker.consumeSettled("session-b"), false);
});

test("clear drops eligibility so hidden-period completions stay silent", () => {
  const tracker = createSettleChimeTracker();

  tracker.noteRunning("session-a");
  tracker.noteRunning("session-b");
  tracker.clear();

  assert.equal(tracker.consumeSettled("session-a"), false);
  assert.equal(tracker.consumeSettled("session-b"), false);

  // Re-observed running after the page is visible again re-arms the chime.
  tracker.noteRunning("session-a");
  assert.equal(tracker.consumeSettled("session-a"), true);
});

test("ignores blank session ids", () => {
  const tracker = createSettleChimeTracker();

  tracker.noteRunning("   ");
  assert.equal(tracker.consumeSettled("   "), false);
  assert.equal(tracker.consumeSettled(""), false);
});

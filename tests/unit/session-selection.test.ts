import assert from "node:assert/strict";
import test from "node:test";

import {
  isKnownSessionSelection,
  normalizeSessionSelectionId,
  resolveSessionSelection,
} from "../../web/session-selection";

test("normalizeSessionSelectionId trims session ids", () => {
  assert.equal(normalizeSessionSelectionId(" session-1 "), "session-1");
  assert.equal(normalizeSessionSelectionId("  "), "");
});

test("isKnownSessionSelection matches locally loaded sessions", () => {
  const sessions = [{ id: "session-1" }, { id: "session-2" }];

  assert.equal(isKnownSessionSelection(" session-2 ", sessions), true);
  assert.equal(isKnownSessionSelection("missing-session", sessions), false);
  assert.equal(isKnownSessionSelection("", sessions), false);
});

test("resolveSessionSelection matches id, display name, and id prefix", () => {
  const sessions = [
    { id: "session-alpha", display: "Alpha thread" },
    { id: "session-beta", display: "Beta Thread" },
  ];

  assert.deepEqual(resolveSessionSelection(" session-alpha ", sessions), {
    id: "session-alpha",
    display: "Alpha thread",
  });
  assert.deepEqual(resolveSessionSelection("beta thread", sessions), {
    id: "session-beta",
    display: "Beta Thread",
  });
  assert.deepEqual(resolveSessionSelection("session-b", sessions), {
    id: "session-beta",
    display: "Beta Thread",
  });
  assert.equal(resolveSessionSelection("missing", sessions), null);
});

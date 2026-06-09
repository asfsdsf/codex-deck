import assert from "node:assert/strict";
import test from "node:test";

import {
  isKnownSessionSelection,
  normalizeSessionSelectionId,
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

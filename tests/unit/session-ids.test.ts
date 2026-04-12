import test from "node:test";
import assert from "node:assert/strict";
import { getStableSessionIds } from "../../web/session-ids";

test("getStableSessionIds only depends on unique sorted session ids", () => {
  const first = getStableSessionIds([
    { id: "session-b" },
    { id: "session-a" },
    { id: "session-b" },
  ]);

  const second = getStableSessionIds([
    { id: "session-a" },
    { id: "session-b" },
  ]);

  assert.deepEqual(first.sessionIds, ["session-a", "session-b"]);
  assert.equal(first.sessionIdsKey, "session-a,session-b");
  assert.deepEqual(second.sessionIds, ["session-a", "session-b"]);
  assert.equal(second.sessionIdsKey, "session-a,session-b");
});

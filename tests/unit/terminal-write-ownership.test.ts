import assert from "node:assert/strict";
import test from "node:test";
import { shouldAutoClaimWriteAfterRestart } from "../../web/terminal-write-ownership";

test("shouldAutoClaimWriteAfterRestart reclaims write when this client owned the terminal", () => {
  assert.equal(shouldAutoClaimWriteAfterRestart("client-a", "client-a"), true);
});

test("shouldAutoClaimWriteAfterRestart reclaims write when the terminal had no owner", () => {
  assert.equal(shouldAutoClaimWriteAfterRestart(null, "client-a"), true);
});

test("shouldAutoClaimWriteAfterRestart preserves another client's ownership", () => {
  assert.equal(shouldAutoClaimWriteAfterRestart("client-b", "client-a"), false);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_NEW_SESSION_CWD_STATE,
  clearNewSessionCwdForProjectSelection,
  resolveNewSessionCwdForCreate,
  setNewSessionCwdFromUserInput,
} from "../../web/new-session-cwd-state";

test("new session cwd starts empty and only stores user input", () => {
  assert.deepEqual(EMPTY_NEW_SESSION_CWD_STATE, { value: "" });
  assert.deepEqual(setNewSessionCwdFromUserInput("/repo/app"), {
    value: "/repo/app",
  });
});

test("new session cwd stays empty after the user clears the field", () => {
  const cleared = setNewSessionCwdFromUserInput("");

  assert.deepEqual(cleared, { value: "" });
});

test("project selection clears the input", () => {
  assert.deepEqual(clearNewSessionCwdForProjectSelection(), { value: "" });
});

test("new session creation uses the current path when the input is empty", () => {
  assert.equal(
    resolveNewSessionCwdForCreate("", "/repo/current"),
    "/repo/current",
  );
  assert.equal(
    resolveNewSessionCwdForCreate("  ", "/repo/current"),
    "/repo/current",
  );
});

test("new session creation prefers an explicit input path", () => {
  assert.equal(
    resolveNewSessionCwdForCreate(" /repo/custom ", "/repo/current"),
    "/repo/custom",
  );
  assert.equal(resolveNewSessionCwdForCreate("", ""), "");
});

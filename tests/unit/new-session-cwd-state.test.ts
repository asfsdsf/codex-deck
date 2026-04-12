import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_NEW_SESSION_CWD_STATE,
  clearNewSessionCwdForProjectSelection,
  maybeAutoFillNewSessionCwd,
  setNewSessionCwdFromUserInput,
} from "../../web/new-session-cwd-state";

test("new session cwd auto-fills when a single project is available and the field is pristine", () => {
  assert.deepEqual(
    maybeAutoFillNewSessionCwd(EMPTY_NEW_SESSION_CWD_STATE, {
      selectedProject: null,
      candidates: ["/repo/app"],
    }),
    {
      value: "/repo/app",
      preserveManualEmpty: false,
    },
  );
});

test("new session cwd stays empty after the user clears the field", () => {
  const autoFilled = maybeAutoFillNewSessionCwd(EMPTY_NEW_SESSION_CWD_STATE, {
    selectedProject: null,
    candidates: ["/repo/app"],
  });
  const cleared = setNewSessionCwdFromUserInput("");

  assert.deepEqual(autoFilled, {
    value: "/repo/app",
    preserveManualEmpty: false,
  });
  assert.deepEqual(
    maybeAutoFillNewSessionCwd(cleared, {
      selectedProject: null,
      candidates: ["/repo/app"],
    }),
    cleared,
  );
});

test("project selection clears keep the input empty instead of restoring the lone project path", () => {
  const clearedForSelection = clearNewSessionCwdForProjectSelection();

  assert.deepEqual(
    maybeAutoFillNewSessionCwd(clearedForSelection, {
      selectedProject: null,
      candidates: ["/repo/app"],
    }),
    clearedForSelection,
  );
});

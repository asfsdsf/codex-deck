import assert from "node:assert/strict";
import test from "node:test";
import {
  resolvePaneSlashCommandNavigation,
  resolveRightPaneTarget,
} from "../../web/right-pane-routing";

test("right pane target follows the terminal bound session in terminal view", () => {
  assert.deepEqual(
    resolveRightPaneTarget({
      centerView: "terminal",
      selectedSessionId: "selected-codex-session",
      terminalSessionId: "terminal-bound-session",
      workflowProjectPath: null,
      workflowKey: null,
    }),
    {
      kind: "session",
      sessionId: "terminal-bound-session",
    },
  );
});

test("right pane target is unavailable for an unbound terminal", () => {
  assert.equal(
    resolveRightPaneTarget({
      centerView: "terminal",
      selectedSessionId: "selected-codex-session",
      terminalSessionId: null,
      workflowProjectPath: null,
      workflowKey: null,
    }),
    null,
  );
});

test("right pane target preserves existing session and workflow behavior", () => {
  assert.deepEqual(
    resolveRightPaneTarget({
      centerView: "session",
      selectedSessionId: "selected-codex-session",
      terminalSessionId: "terminal-bound-session",
      workflowProjectPath: null,
      workflowKey: null,
    }),
    {
      kind: "session",
      sessionId: "selected-codex-session",
    },
  );

  assert.deepEqual(
    resolveRightPaneTarget({
      centerView: "workflow",
      selectedSessionId: "selected-codex-session",
      terminalSessionId: "terminal-bound-session",
      workflowProjectPath: "/repo/project",
      workflowKey: "workflow-a",
    }),
    {
      kind: "workflow-project",
      workflowKey: "workflow-a",
      projectPath: "/repo/project",
    },
  );
});

test("pane slash commands preserve terminal and workflow center views", () => {
  assert.deepEqual(
    resolvePaneSlashCommandNavigation({
      centerView: "terminal",
      commandSessionId: "terminal-bound-session",
      paneSessionId: "terminal-bound-session",
    }),
    {
      preserveCenterView: true,
      shouldClearWorkflowTaskSelection: false,
      shouldSelectCommandSession: false,
    },
  );

  assert.deepEqual(
    resolvePaneSlashCommandNavigation({
      centerView: "workflow",
      commandSessionId: "workflow-bound-session",
      paneSessionId: "workflow-bound-session",
    }),
    {
      preserveCenterView: true,
      shouldClearWorkflowTaskSelection: true,
      shouldSelectCommandSession: false,
    },
  );
});

test("pane slash commands preserve the current Codex session pane too", () => {
  assert.deepEqual(
    resolvePaneSlashCommandNavigation({
      centerView: "session",
      commandSessionId: "selected-codex-session",
      paneSessionId: "selected-codex-session",
    }),
    {
      preserveCenterView: true,
      shouldClearWorkflowTaskSelection: false,
      shouldSelectCommandSession: false,
    },
  );
});

test("pane slash commands fall back to the Codex session view otherwise", () => {
  assert.deepEqual(
    resolvePaneSlashCommandNavigation({
      centerView: "terminal",
      commandSessionId: "other-session",
      paneSessionId: "terminal-bound-session",
    }),
    {
      preserveCenterView: false,
      shouldClearWorkflowTaskSelection: false,
      shouldSelectCommandSession: true,
    },
  );
});

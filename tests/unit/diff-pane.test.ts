import test from "node:test";
import assert from "node:assert/strict";
import React, { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DiffPane from "../../web/components/diff-pane";

(globalThis as { React?: typeof React }).React = React;

type DiffPaneProps = ComponentProps<typeof DiffPane>;

function renderDiffPane(overrides: Partial<DiffPaneProps> = {}): string {
  const props: DiffPaneProps = {
    collapsed: false,
    fileLinkOpenVersion: 0,
    isMobilePhone: false,
    mode: "files",
    sessionId: "session-1",
    threadId: "session-1",
    width: 420,
    loading: false,
    error: null,
    diffData: null,
    fileTreeNodesData: {
      sessionId: "session-1",
      projectPath: "/repo",
      dir: "",
      nodes: [
        {
          name: "app.ts",
          path: "src/app.ts",
          isDirectory: false,
        },
      ],
      nextCursor: null,
      unavailableReason: null,
    },
    fileTreeLoadingMore: false,
    fileContent: {
      sessionId: "session-1",
      projectPath: "/repo",
      path: "src/app.ts",
      content: 'export const answer = 42;\nconsole.log("ready");',
      page: 1,
      totalPages: 1,
      paginationMode: "lines",
      lineStart: 1,
      lineEnd: 2,
      isBinary: false,
      previewKind: null,
      previewMediaType: null,
      previewDataUrl: null,
      previewUnavailableReason: null,
      unavailableReason: null,
    },
    fileContentLoading: false,
    fileContentError: null,
    fileContentPage: 1,
    selectedFilePath: "src/app.ts",
    targetLineNumber: null,
    terminalRuns: [],
    terminalRunsLoading: false,
    terminalRunsError: null,
    selectedTerminalRunId: null,
    terminalRunOutput: "",
    terminalRunOutputLoading: false,
    terminalRunOutputError: null,
    hooksData: null,
    hooksLoading: false,
    hooksError: null,
    selectedHookKey: null,
    updatingHookKey: null,
    skillsData: null,
    skillsLoading: false,
    skillsError: null,
    selectedSkillPath: null,
    updatingSkillPath: null,
    onToggleCollapsed: () => {},
    onResizeStart: () => {},
    onChangeMode: () => {},
    onSelectFilePath: () => {},
    onOpenFileTreeDirectory: () => {},
    onLoadMoreFileTreeNodes: () => {},
    onChangeFileContentPage: () => {},
    onRefreshFiles: () => {},
    onSelectTerminalRun: () => {},
    onRefreshTerminalRuns: () => {},
    onSelectHookKey: () => {},
    onToggleHookEnabled: () => {},
    onTrustHook: () => {},
    onTrustAllHooks: () => {},
    onRefreshHooks: () => {},
    onSelectSkillPath: () => {},
    onToggleSkillEnabled: () => {},
    onRefreshSkills: () => {},
    ...overrides,
  };

  return renderToStaticMarkup(createElement(DiffPane, props));
}

test("DiffPane keeps the current file preview visible while the file tree refreshes", () => {
  const html = renderDiffPane({
    loading: true,
  });

  assert.match(html, /answer =/);
  assert.doesNotMatch(html, /Loading file tree/);
});

test("DiffPane keeps the current file preview visible while the file content refreshes", () => {
  const html = renderDiffPane({
    fileContentLoading: true,
  });

  assert.match(html, /ready/);
  assert.doesNotMatch(html, /Loading file content/);
});

test("DiffPane still shows a blocking loading state before the first file tree payload arrives", () => {
  const html = renderDiffPane({
    loading: true,
    fileTreeNodesData: null,
    fileContent: null,
    selectedFilePath: null,
  });

  assert.match(html, /Loading files/);
});

test("right sidebar start page offers Files, Git, Tasks, Skills, and Hooks", () => {
  const html = renderDiffPane({ mode: "home" });

  assert.match(html, /data-right-pane-guide-entry="files"/);
  assert.match(html, /data-right-pane-guide-entry="git"/);
  assert.match(html, /data-right-pane-guide-entry="tasks"/);
  assert.match(html, /data-right-pane-guide-entry="skills"/);
  assert.match(html, /data-right-pane-guide-entry="hooks"/);
  assert.doesNotMatch(
    html,
    /data-right-pane-guide-entry="(?:staged|last-turn)/,
  );
  assert.doesNotMatch(html, /Terminal run|Last turn|Staged/);
});

test("workflow project panes keep configuration and unavailable states without thread runtime panels", () => {
  const project = { sessionId: "/repo/project", threadId: null };
  const terminalHtml = renderDiffPane({
    ...project,
    mode: "tasks",
    terminalRunsError: "Tasks are unavailable for workflow projects.",
  });
  assert.match(terminalHtml, /Tasks are unavailable for workflow projects/);
  assert.doesNotMatch(
    terminalHtml,
    /Codex background commands|Loading active commands/,
  );
  const hookHtml = renderDiffPane({ ...project, mode: "hooks" });
  assert.match(hookHtml, /No hooks available/);
  assert.doesNotMatch(
    hookHtml,
    /Hook executions|Recent hook executions|Refresh executions/,
  );
});

test("session panes offer background commands and a separate hook execution view", () => {
  assert.match(renderDiffPane({ mode: "tasks" }), /Codex background commands/);
  assert.match(renderDiffPane({ mode: "hooks" }), /aria-label="Hooks view"/);
  assert.match(renderDiffPane({ mode: "hooks" }), />Executions<\/button>/);
  assert.doesNotMatch(
    renderDiffPane({ mode: "hooks", collapsed: true }),
    /aria-label="Hooks view"/,
  );
});

test("capability panes do not show configuration from a previous session", () => {
  const skillsData: NonNullable<DiffPaneProps["skillsData"]> = {
    sessionId: "previous-session",
    projectPath: "/previous-project",
    cwd: "/previous-project",
    skills: [
      {
        name: "previous-workspace-skill",
        description: "Previous workspace",
        shortDescription: null,
        interface: null,
        dependencies: null,
        path: "/previous-project/SKILL.md",
        scope: "repo",
        enabled: true,
      },
    ],
    errors: [],
    unavailableReason: null,
  };
  const hooksData: NonNullable<DiffPaneProps["hooksData"]> = {
    sessionId: "previous-session",
    projectPath: "/previous-project",
    cwd: "/previous-project",
    hooks: [
      {
        key: "old-hook",
        eventName: "stop",
        handlerType: "command",
        matcher: null,
        command: "previous-workspace-command",
        timeoutSec: 30,
        statusMessage: null,
        sourcePath: "/previous-project/hooks.json",
        source: "project",
        pluginId: null,
        displayOrder: 0,
        enabled: true,
        isManaged: false,
        currentHash: "hash",
        trustStatus: "trusted",
      },
    ],
    warnings: [],
    errors: [],
    unavailableReason: null,
  };
  assert.doesNotMatch(
    renderDiffPane({ mode: "skills", skillsData }),
    /previous-workspace-skill/,
  );
  assert.doesNotMatch(
    renderDiffPane({ mode: "hooks", hooksData }),
    /previous-workspace-command/,
  );
  assert.match(
    renderDiffPane({
      mode: "skills",
      skillsData: { ...skillsData, sessionId: "session-1" },
    }),
    /previous-workspace-skill/,
  );
  assert.match(
    renderDiffPane({
      mode: "hooks",
      hooksData: { ...hooksData, sessionId: "session-1" },
    }),
    /previous-workspace-command/,
  );
});

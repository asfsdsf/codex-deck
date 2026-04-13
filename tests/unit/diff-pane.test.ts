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
    revealFileListVersion: 0,
    isMobilePhone: false,
    mode: "file-tree",
    sessionId: "session-1",
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
    onSelectTerminalRun: () => {},
    onRefreshTerminalRuns: () => {},
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

  assert.match(html, /Loading file tree/);
});

import test from "node:test";
import assert from "node:assert/strict";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  CodexApprovalRequest,
  ContentBlock,
  ConversationMessage,
} from "@codex-deck/api";
import { CollapsedViewportSummary } from "../../web/components/collapsed-viewport-summary";
import { shouldAutoForceBlockModeForMessages } from "../../web/components/session-view";
import type { CollapsedViewportLine } from "../../web/message-viewport-groups";

(globalThis as { React?: typeof React }).React = React;

function renderCollapsedSummary(line: CollapsedViewportLine): string {
  return renderToStaticMarkup(
    createElement(CollapsedViewportSummary, {
      line,
    }),
  );
}

function createAssistantMessage(
  content: string | ContentBlock[],
): ConversationMessage {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content,
    },
  };
}

function createApprovalRequest(
  overrides: Partial<CodexApprovalRequest>,
): CodexApprovalRequest {
  return {
    requestId: "approval-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "exec-1",
    kind: "permissions",
    reason: "Need permission",
    command: "pnpm test",
    cwd: "/repo",
    permissions: { mode: "danger-full-access" },
    availableDecisions: [],
    ...overrides,
  };
}

test("CollapsedViewportSummary uses one truncating container for segmented text mode lines", () => {
  const html = renderCollapsedSummary({
    tone: "tool",
    text: 'Search "a-very-long-query-value" in a/very/long/path/to/a/file.ts',
    segments: [
      { kind: "label", text: "Search" },
      { kind: "query", text: '"a-very-long-query-value"' },
      { kind: "detail", text: "in" },
      { kind: "path", text: "a/very/long/path/to/a/file.ts" },
    ],
  });

  assert.match(html, /class="block min-w-0 flex-1 truncate whitespace-nowrap"/);
  assert.doesNotMatch(html, /flex min-w-0 flex-1 items-center/);
  assert.doesNotMatch(html, /shrink-0/);
});

test("CollapsedViewportSummary keeps command highlighting inside the shared truncating container", () => {
  const html = renderCollapsedSummary({
    tone: "tool",
    text: "pnpm --filter codex-deck test -- --grep text-mode-summary",
    segments: [
      {
        kind: "command",
        text: "pnpm --filter codex-deck test -- --grep text-mode-summary",
      },
    ],
  });

  assert.match(html, /class="block min-w-0 flex-1 truncate whitespace-nowrap"/);
  assert.match(html, /command-syntax-inline command-syntax text-zinc-100/);
  assert.doesNotMatch(html, /truncate whitespace-pre/);
});

test("CollapsedViewportSummary styles goal status prefix separately from objective", () => {
  for (const prefix of [
    "Goal Active:",
    "Goal Paused:",
    "Goal Blocked:",
    "Goal Usage Limited:",
    "Goal Budget Limited:",
    "Goal Complete:",
  ]) {
    const html = renderCollapsedSummary({
      tone: "goal",
      text: `${prefix} Improve benchmark coverage`,
      segments: [
        { kind: "goal", text: prefix },
        { kind: "detail", text: "Improve benchmark coverage" },
      ],
    });

    assert.match(
      html,
      new RegExp(
        `<span class="font-semibold text-emerald-200 ">${prefix}</span>`,
      ),
    );
    assert.match(
      html,
      /<span class="text-zinc-300 ml-1">Improve benchmark coverage<\/span>/,
    );
  }
});

test("text mode auto-forces block mode for exec_command with pending permissions approval", () => {
  const messages = [
    createAssistantMessage([
      {
        type: "tool_use",
        id: "exec-1",
        name: "exec_command",
        input: { cmd: "pnpm test" },
      },
    ]),
  ];
  const requests = [createApprovalRequest({ itemId: "exec-1" })];

  assert.equal(shouldAutoForceBlockModeForMessages(messages, requests), true);
});

test("text mode does not auto-force for non-exec tool approvals", () => {
  const messages = [
    createAssistantMessage([
      {
        type: "tool_use",
        id: "patch-1",
        name: "apply_patch",
        input: { patch: "*** Begin Patch" },
      },
    ]),
  ];
  const requests = [createApprovalRequest({ itemId: "patch-1" })];

  assert.equal(shouldAutoForceBlockModeForMessages(messages, requests), false);
});

test("text mode auto-forces for commandExecution approval kinds linked to exec_command", () => {
  const messages = [
    createAssistantMessage([
      {
        type: "tool_use",
        id: "exec-2",
        name: "exec_command",
        input: { cmd: "pnpm lint" },
      },
    ]),
  ];
  const requests = [
    createApprovalRequest({
      itemId: "exec-2",
      kind: "commandExecution",
    }),
  ];

  assert.equal(shouldAutoForceBlockModeForMessages(messages, requests), true);
});

test("text mode does not auto-force when approval itemId does not match exec_command id", () => {
  const messages = [
    createAssistantMessage([
      {
        type: "tool_use",
        id: "exec-3",
        name: "exec_command",
        input: { cmd: "pnpm build" },
      },
    ]),
  ];
  const requests = [createApprovalRequest({ itemId: "other-id" })];

  assert.equal(shouldAutoForceBlockModeForMessages(messages, requests), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import type { ContentBlock, ConversationMessage } from "@codex-deck/api";
import {
  getCollapsedViewportLine,
  getViewportMessageGroup,
} from "../../web/message-viewport-groups";

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

test("viewport grouping marks required important messages", () => {
  const userMessage: ConversationMessage = {
    type: "user",
    message: {
      role: "user",
      content: "run tests",
    },
  };
  const assistantTextMessage = createAssistantMessage("Main reply");
  const requestUserInputMessage = createAssistantMessage([
    {
      type: "tool_use",
      id: "1",
      name: "request_user_input",
      input: { question: "choose one" },
    },
  ]);
  const updatePlanMessage = createAssistantMessage([
    {
      type: "tool_use",
      id: "2",
      name: "update_plan",
      input: { plan: [{ step: "A", status: "in_progress" }] },
    },
  ]);
  const defaultToolMessage = createAssistantMessage([
    {
      type: "tool_use",
      id: "3",
      name: "read",
      input: { path: "README.md" },
    },
  ]);
  const reasoningMessage: ConversationMessage = {
    type: "reasoning",
    message: {
      role: "assistant",
      content: "Thinking...",
    },
  };

  assert.equal(getViewportMessageGroup(userMessage), "important");
  assert.equal(getViewportMessageGroup(assistantTextMessage), "important");
  assert.equal(getViewportMessageGroup(requestUserInputMessage), "important");
  assert.equal(getViewportMessageGroup(updatePlanMessage), "important");
  assert.equal(getViewportMessageGroup(defaultToolMessage), "default");
  assert.equal(getViewportMessageGroup(reasoningMessage), "default");
});

test("single token limit notices stay out of the important viewport flow", () => {
  const singleNotice: ConversationMessage = {
    type: "token_limit_notice",
    repeatCount: 1,
    repeatCountMax: 6,
    summary: "Rate Limit Reached",
    message: {
      role: "assistant",
      content:
        "Token count updates hit the Codex rate limit. Codex is waiting and retrying automatically.",
    },
  };

  assert.equal(getViewportMessageGroup(singleNotice), "default");
  assert.equal(getCollapsedViewportLine(singleNotice), null);
});

test("collapsed text mode hides reasoning and command results", () => {
  const reasoningMessage: ConversationMessage = {
    type: "reasoning",
    message: {
      role: "assistant",
      content: "internal reasoning",
    },
  };
  const commandResultOnlyMessage = createAssistantMessage([
    {
      type: "tool_result",
      tool_use_id: "cmd-1",
      content: "command output",
      is_error: false,
    },
  ]);

  assert.equal(getCollapsedViewportLine(reasoningMessage), null);
  assert.equal(
    getCollapsedViewportLine(commandResultOnlyMessage, {
      toolMapByCallId: new Map([["cmd-1", "exec_command"]]),
    }),
    null,
  );
});

test("collapsed text mode hides exec metadata headers in command results", () => {
  const commandResultMessage = createAssistantMessage([
    {
      type: "tool_result",
      tool_use_id: "cmd-meta-1",
      content:
        "Chunk ID: abc123\nWall time: 1.00 seconds\nProcess running with session ID 3000\nOriginal token count: 2\nOutput:\nboot output\n",
      is_error: false,
    },
  ]);

  assert.equal(
    getCollapsedViewportLine(commandResultMessage, {
      toolMapByCallId: new Map([["cmd-meta-1", "exec_command"]]),
    }),
    null,
  );
});

test("collapsed text mode generates one-line previews", () => {
  const planMessage = createAssistantMessage(
    "<proposed_plan>\n1. Ship it\n</proposed_plan>\n",
  );
  const toolUseMessage = createAssistantMessage([
    {
      type: "tool_use",
      id: "exec",
      name: "exec_command",
      input: { command: "pnpm test" },
    },
  ]);

  const planLine = getCollapsedViewportLine(planMessage);
  const toolLine = getCollapsedViewportLine(toolUseMessage);

  assert.ok(planLine);
  assert.equal(planLine?.tone, "plan");
  assert.match(planLine?.text ?? "", /^Plan: /);

  assert.ok(toolLine);
  assert.equal(toolLine?.tone, "tool");
  assert.equal(toolLine?.text ?? "", "pnpm test");
  assert.deepEqual(toolLine?.segments, [
    { kind: "command", text: "pnpm test" },
  ]);
});

test("collapsed text mode customizes sed -n summaries", () => {
  const sedMessage = createAssistantMessage([
    {
      type: "tool_use",
      id: "sed-1",
      name: "exec_command",
      input: {
        command: "sed -n '10,20p' /repo/src/example.ts",
      },
    },
  ]);

  const line = getCollapsedViewportLine(sedMessage, {
    projectPath: "/repo",
  });

  assert.deepEqual(line, {
    tone: "tool",
    text: "Read src/example.ts :10-20",
    segments: [
      { kind: "label", text: "Read" },
      { kind: "path", text: "src/example.ts" },
      { kind: "range", text: ":10-20" },
    ],
  });
});

test("collapsed text mode customizes other frequent command summaries", () => {
  const catLine = getCollapsedViewportLine(
    createAssistantMessage([
      {
        type: "tool_use",
        id: "cat-1",
        name: "exec_command",
        input: { command: "cat /repo/README.md" },
      },
    ]),
    { projectPath: "/repo" },
  );
  const catHeredocLine = getCollapsedViewportLine(
    createAssistantMessage([
      {
        type: "tool_use",
        id: "cat-2",
        name: "exec_command",
        input: {
          command: "cat > /repo/server/README.md <<'EOF'\nhello\nEOF",
        },
      },
    ]),
    { projectPath: "/repo" },
  );
  const rgLine = getCollapsedViewportLine(
    createAssistantMessage([
      {
        type: "tool_use",
        id: "rg-1",
        name: "exec_command",
        input: { command: "rg viewport web/components" },
      },
    ]),
  );
  const lsLine = getCollapsedViewportLine(
    createAssistantMessage([
      {
        type: "tool_use",
        id: "ls-1",
        name: "exec_command",
        input: { command: "ls web/components" },
      },
    ]),
  );
  const gitDiffLine = getCollapsedViewportLine(
    createAssistantMessage([
      {
        type: "tool_use",
        id: "git-1",
        name: "exec_command",
        input: { command: "git diff web/message-viewport-groups.ts" },
      },
    ]),
  );

  assert.deepEqual(catLine, {
    tone: "tool",
    text: "Read README.md",
    segments: [
      { kind: "label", text: "Read" },
      { kind: "path", text: "README.md" },
    ],
  });
  assert.deepEqual(catHeredocLine, {
    tone: "tool",
    text: "Write server/README.md",
    segments: [
      { kind: "label", text: "Write" },
      { kind: "path", text: "server/README.md" },
    ],
  });
  const catAppendLine = getCollapsedViewportLine(
    createAssistantMessage([
      {
        type: "tool_use",
        id: "cat-append",
        name: "exec_command",
        input: {
          command: "cat >> /repo/server/README.md <<'EOF'\nhello\nEOF",
        },
      },
    ]),
    { projectPath: "/repo" },
  );
  assert.deepEqual(rgLine, {
    tone: "tool",
    text: 'Search "viewport" in web/components',
    segments: [
      { kind: "label", text: "Search" },
      { kind: "query", text: '"viewport"' },
      { kind: "detail", text: "in" },
      { kind: "path", text: "web/components" },
    ],
  });
  assert.deepEqual(lsLine, {
    tone: "tool",
    text: "List web/components",
    segments: [
      { kind: "label", text: "List" },
      { kind: "path", text: "web/components" },
    ],
  });
  assert.deepEqual(catAppendLine, {
    tone: "tool",
    text: "Append server/README.md",
    segments: [
      { kind: "label", text: "Append" },
      { kind: "path", text: "server/README.md" },
    ],
  });
  assert.deepEqual(gitDiffLine, {
    tone: "tool",
    text: "Diff web/message-viewport-groups.ts",
    segments: [
      { kind: "label", text: "Diff" },
      { kind: "path", text: "web/message-viewport-groups.ts" },
    ],
  });
});

test("collapsed text mode falls back for unsupported sed commands", () => {
  const sedMessage = createAssistantMessage([
    {
      type: "tool_use",
      id: "sed-unsupported",
      name: "exec_command",
      input: {
        command: "sed -n '10,20q' /repo/src/example.ts",
      },
    },
  ]);

  const line = getCollapsedViewportLine(sedMessage, {
    projectPath: "/repo",
  });

  assert.deepEqual(line, {
    tone: "tool",
    text: "sed -n '10,20q' /repo/src/example.ts",
    segments: [
      { kind: "command", text: "sed -n '10,20q' /repo/src/example.ts" },
    ],
  });
});

test("collapsed text mode summarizes apply_patch with repo-relative counts", () => {
  const patchMessage = createAssistantMessage([
    {
      type: "tool_use",
      id: "patch-1",
      name: "apply_patch",
      input: {
        raw: [
          "*** Begin Patch",
          "*** Update File: /repo/src/example.ts",
          "@@ -1,2 +1,3 @@",
          " const a = 1;",
          "-const b = 2;",
          "+const b = 3;",
          "+const c = 4;",
          "*** End Patch",
        ].join("\n"),
      },
    },
  ]);

  const line = getCollapsedViewportLine(patchMessage, {
    projectPath: "/repo",
  });

  assert.deepEqual(line, {
    tone: "tool",
    text: "Edited src/example.ts (+2 -1)",
    segments: [
      { kind: "label", text: "Edited" },
      { kind: "path", text: "src/example.ts" },
      { kind: "punctuation", text: "(" },
      { kind: "count-add", text: "+2" },
      { kind: "count-remove", text: "-1" },
      { kind: "punctuation", text: ")" },
    ],
  });
});

test("collapsed text mode summarizes multi-file apply_patch", () => {
  const patchMessage = createAssistantMessage([
    {
      type: "tool_use",
      id: "patch-2",
      name: "apply_patch",
      input: {
        raw: [
          "*** Begin Patch",
          "*** Add File: /repo/src/new.ts",
          "+export const value = 1;",
          "*** Update File: /repo/src/old.ts",
          "@@ -1 +1 @@",
          "-export const value = 0;",
          "+export const value = 1;",
          "*** End Patch",
        ].join("\n"),
      },
    },
  ]);

  const line = getCollapsedViewportLine(patchMessage, {
    projectPath: "/repo",
  });

  assert.deepEqual(line, {
    tone: "tool",
    text: "Edited 2 files (+2 -1)",
    segments: [
      { kind: "label", text: "Edited" },
      { kind: "path", text: "2 files" },
      { kind: "punctuation", text: "(" },
      { kind: "count-add", text: "+2" },
      { kind: "count-remove", text: "-1" },
      { kind: "punctuation", text: ")" },
    ],
  });
});

test("collapsed text mode summarizes generic tool results with codex-style wording", () => {
  const resultMessage = createAssistantMessage([
    {
      type: "tool_result",
      tool_use_id: "search-1",
      content: "Found styling guidance in styles.md",
      is_error: false,
    },
  ]);

  const line = getCollapsedViewportLine(resultMessage, {
    toolMapByCallId: new Map([["search-1", "search.find_docs"]]),
  });

  assert.deepEqual(line, {
    tone: "tool",
    text: "Called search.find_docs · Found styling guidance in styles.md",
    segments: [
      { kind: "label", text: "Called" },
      { kind: "detail", text: "search.find_docs" },
      { kind: "punctuation", text: "·" },
      { kind: "detail", text: "Found styling guidance in styles.md" },
    ],
  });
});

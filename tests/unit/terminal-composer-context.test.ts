import assert from "node:assert/strict";
import test from "node:test";
import {
  FROZEN_TERMINAL_OUTPUT_CHAR_LIMIT,
  buildFrozenTerminalCommandOutputTag,
  buildTerminalBoundUserMessageText,
  buildTerminalChatBootstrapMessage,
} from "../../api/terminal-chat-context";

test("buildFrozenTerminalCommandOutputTag wraps transcript in a dedicated tag", () => {
  const tag = buildFrozenTerminalCommandOutputTag({
    terminalId: "terminal-1",
    transcript: "$ pwd\n/repo/app",
  });

  assert.equal(
    tag,
    [
      "<terminal-command-output>",
      "<terminal_id>terminal-1</terminal_id>",
      "<content><![CDATA[$ pwd",
      "/repo/app]]></content>",
      "</terminal-command-output>",
    ].join("\n"),
  );
});

test("buildFrozenTerminalCommandOutputTag truncates transcript beyond the character limit", () => {
  const transcript = `>${"x".repeat(FROZEN_TERMINAL_OUTPUT_CHAR_LIMIT + 4)}`;
  const tag = buildFrozenTerminalCommandOutputTag({
    terminalId: "terminal-1",
    transcript,
  });

  assert.ok(
    tag.includes(
      [
        `${transcript.slice(0, FROZEN_TERMINAL_OUTPUT_CHAR_LIMIT)}`,
        '<codex-deck-frozen-terminal-omitted-characters-notice omitted-characters="5">5 characters omitted from frozen terminal output.</codex-deck-frozen-terminal-omitted-characters-notice>',
      ].join(""),
    ),
  );
  assert.doesNotMatch(tag, /codex-deck-frozen-terminal-omitted-lines-notice/);
});

test("buildFrozenTerminalCommandOutputTag keeps the first and last 20 lines when long output fits the character limit", () => {
  const transcript = Array.from(
    { length: 55 },
    (_, index) => `line-${index + 1}`,
  ).join("\n");
  const tag = buildFrozenTerminalCommandOutputTag({
    terminalId: "terminal-1",
    transcript,
  });

  assert.match(
    tag,
    /line-20\n<codex-deck-frozen-terminal-omitted-lines-notice omitted-lines="15">15 lines omitted from frozen terminal output\.<\/codex-deck-frozen-terminal-omitted-lines-notice>\nline-36/,
  );
  assert.doesNotMatch(tag, /line-21/);
  assert.doesNotMatch(tag, /line-35/);
  assert.match(tag, /line-55/);
});

test("buildTerminalBoundUserMessageText appends the frozen terminal tag after the user's text", () => {
  const message = buildTerminalBoundUserMessageText({
    text: "Please explain the failure.",
    terminalContext: {
      terminalId: "terminal-1",
      transcript: "$ pnpm test\nFAIL src/example.test.ts",
    },
  });

  assert.match(
    message,
    /^Please explain the failure\.\n\n<terminal-command-output>/,
  );
  assert.match(message, /<terminal_id>terminal-1<\/terminal_id>/);
  assert.match(message, /FAIL src\/example\.test\.ts/);
});

test("buildTerminalBoundUserMessageText returns only the terminal tag when the draft is empty", () => {
  const message = buildTerminalBoundUserMessageText({
    text: "   ",
    terminalContext: {
      terminalId: "terminal-1",
      transcript: "$ git status\nnothing to commit",
    },
  });

  assert.equal(
    message,
    [
      "<terminal-command-output>",
      "<terminal_id>terminal-1</terminal_id>",
      "<content><![CDATA[$ git status",
      "nothing to commit]]></content>",
      "</terminal-command-output>",
    ].join("\n"),
  );
});

test("buildTerminalChatBootstrapMessage places frozen terminal context after controller metadata", () => {
  const message = buildTerminalChatBootstrapMessage({
    terminalId: "terminal-1",
    cwd: "/repo/app",
    shell: "zsh",
    osName: "macOS",
    osRelease: "macOS 15.4.1",
    architecture: "arm64",
    platform: "darwin",
    initialUserMessage: "Find the failing test.",
    imageCount: 0,
    terminalContext: {
      terminalId: "terminal-1",
      transcript: "$ pnpm test\nFAIL src/example.test.ts",
    },
  });

  const controllerContextEnd = message.indexOf(
    "</ai-terminal-controller-context>",
  );
  const terminalContextStart = message.indexOf("<terminal-command-output>");
  const firstRequestStart = message.indexOf(
    "Treat the next section as the user's first request",
  );

  assert.ok(controllerContextEnd >= 0);
  assert.ok(terminalContextStart > controllerContextEnd);
  assert.ok(firstRequestStart > terminalContextStart);
});

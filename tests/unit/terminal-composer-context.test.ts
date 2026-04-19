import assert from "node:assert/strict";
import test from "node:test";
import {
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

test("buildTerminalBoundUserMessageText appends the frozen terminal tag after the user's text", () => {
  const message = buildTerminalBoundUserMessageText({
    text: "Please explain the failure.",
    terminalContext: {
      terminalId: "terminal-1",
      transcript: "$ pnpm test\nFAIL src/example.test.ts",
    },
  });

  assert.match(message, /^Please explain the failure\.\n\n<terminal-command-output>/);
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

  const controllerContextEnd = message.indexOf("</ai-terminal-controller-context>");
  const terminalContextStart = message.indexOf("<terminal-command-output>");
  const firstRequestStart = message.indexOf("Treat the next section as the user's first request");

  assert.ok(controllerContextEnd >= 0);
  assert.ok(terminalContextStart > controllerContextEnd);
  assert.ok(firstRequestStart > terminalContextStart);
});

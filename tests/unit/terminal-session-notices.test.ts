import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTerminalRestartNoticeTag,
  prependTerminalRestartNoticeToMessage,
  parseTerminalRestartNoticeMessage,
  TERMINAL_RESTART_BOUND_SESSION_NOTICE,
  sendTerminalRestartNoticeToBoundSession,
} from "../../web/terminal-session-notices";

test("terminal restart notice is sent to a bound session with terminal cwd", async () => {
  const calls: Array<{
    payload: { text: string; images: string[] };
    options: { sessionIdOverride: string; cwdOverride: string | null };
  }> = [];

  const sent = await sendTerminalRestartNoticeToBoundSession({
    boundSessionId: " session-1 ",
    cwd: "/repo/project",
    sendMessage: async (payload, options) => {
      calls.push({ payload, options });
      return true;
    },
  });

  assert.equal(sent, true);
  assert.deepEqual(calls, [
    {
      payload: {
        text: buildTerminalRestartNoticeTag(),
        images: [],
      },
      options: {
        sessionIdOverride: "session-1",
        cwdOverride: "/repo/project",
      },
    },
  ]);
  assert.match(TERMINAL_RESTART_BOUND_SESSION_NOTICE, /restarted/i);
  assert.match(TERMINAL_RESTART_BOUND_SESSION_NOTICE, /Do not respond/);
});

test("terminal restart notice is skipped without a bound session", async () => {
  let sendCount = 0;

  const sent = await sendTerminalRestartNoticeToBoundSession({
    boundSessionId: " ",
    cwd: "/repo/project",
    sendMessage: async () => {
      sendCount += 1;
      return true;
    },
  });

  assert.equal(sent, false);
  assert.equal(sendCount, 0);
});

test("prependTerminalRestartNoticeToMessage adds a tagged restart notice before the user message", () => {
  const prefixed = prependTerminalRestartNoticeToMessage(
    "Please continue from the previous output.",
  );

  assert.match(
    prefixed,
    /^<terminal-restart-message>[\s\S]*<\/terminal-restart-message>\n\nPlease continue from the previous output\.$/,
  );

  const parsed = parseTerminalRestartNoticeMessage(prefixed);
  assert.deepEqual(parsed, {
    notice: TERMINAL_RESTART_BOUND_SESSION_NOTICE,
    leadingMarkdown: "",
    trailingMarkdown: "Please continue from the previous output.",
    rawBlock: `<terminal-restart-message>${TERMINAL_RESTART_BOUND_SESSION_NOTICE}</terminal-restart-message>`,
  });
});

test("prependTerminalRestartNoticeToMessage emits only the tagged notice for empty text", () => {
  const prefixed = prependTerminalRestartNoticeToMessage("  ");

  assert.equal(
    prefixed,
    `<terminal-restart-message>${TERMINAL_RESTART_BOUND_SESSION_NOTICE}</terminal-restart-message>`,
  );
});

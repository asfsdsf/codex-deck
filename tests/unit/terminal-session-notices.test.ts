import assert from "node:assert/strict";
import test from "node:test";
import {
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
        text: TERMINAL_RESTART_BOUND_SESSION_NOTICE,
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

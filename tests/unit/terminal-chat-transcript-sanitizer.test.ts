import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeTerminalChatTranscript } from "../../api/terminal-chat-transcript-sanitizer";

test("sanitizeTerminalChatTranscript removes ANSI control sequences and prompt artifacts", async () => {
  const sanitized = await sanitizeTerminalChatTranscript(
    [
      "\u001b]2;pnpm test\u0007",
      "$ pnpm test",
      "FAIL src/example.test.ts",
      "\u001b[1m\u001b[7m%\u001b[27m\u001b[1m\u001b[0m",
      '\u001b[?2004h_\u0008__CODEX_DECK_AI_CWD="$(pwd)"',
    ].join("\n"),
  );

  assert.equal(sanitized.includes("\u001b"), false);
  assert.equal(sanitized.includes("]2;pnpm test"), false);
  assert.equal(sanitized.includes("\n%\n"), false);
  assert.match(sanitized, /\$ pnpm test/);
  assert.match(sanitized, /FAIL src\/example\.test\.ts/);
  assert.match(sanitized, /__CODEX_DECK_AI_CWD="\$\(pwd\)"/);
});

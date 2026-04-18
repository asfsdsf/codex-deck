import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTerminalTimelineEntries,
  sanitizeTerminalTranscriptChunk,
} from "../../api/terminal-transcript";

test("buildTerminalTimelineEntries renders ordered blocks before their cards", () => {
  const entries = buildTerminalTimelineEntries({
    messageKeys: ["plan", "complete"],
    blocks: [
      {
        blockId: "block-2",
        terminalId: "terminal-1",
        sessionId: "session-1",
        kind: "execution",
        sequence: 2,
        createdAt: "2026-01-01T00:00:02.000Z",
        updatedAt: "2026-01-01T00:00:02.000Z",
        messageKey: "complete",
        stepId: null,
        transcriptPath: "blocks/block-2.txt",
        transcriptLength: 12,
        action: null,
        transcript: "final-output",
      },
      {
        blockId: "block-1",
        terminalId: "terminal-1",
        sessionId: "session-1",
        kind: "manual",
        sequence: 1,
        createdAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        messageKey: "plan",
        stepId: null,
        transcriptPath: "blocks/block-1.txt",
        transcriptLength: 11,
        action: null,
        transcript: "plan-output",
      },
    ],
  });

  assert.deepEqual(
    entries.map((entry) =>
      entry.type === "card" ? entry.messageKey : entry.text,
    ),
    ["plan-output", "plan", "final-output", "complete"],
  );
});

test("buildTerminalTimelineEntries appends standalone manual blocks after message-bound cards", () => {
  const entries = buildTerminalTimelineEntries({
    messageKeys: ["plan"],
    blocks: [
      {
        blockId: "block-1",
        terminalId: "terminal-1",
        sessionId: "session-1",
        kind: "manual",
        sequence: 1,
        createdAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        messageKey: null,
        stepId: null,
        transcriptPath: "blocks/block-1.txt",
        transcriptLength: 6,
        action: null,
        transcript: "saved!",
      },
    ],
  });

  assert.deepEqual(
    entries.map((entry) =>
      entry.type === "card" ? entry.messageKey : entry.text,
    ),
    ["plan", "saved!"],
  );
});

test("sanitizeTerminalTranscriptChunk strips control sequences but preserves literal marker text", () => {
  const raw = [
    "\u001b]2;title\u0007",
    "__CODEX_DECK_AI_EXIT_CODE=$?",
    "ls -la",
    '\u001b[?2004h_\u0008__CODEX_DECK_AI_CWD="$(pwd)"',
    "__CODEX_DECK_AI_RESULT__ step=s1 exit=0 cwd=/repo",
    "README.md",
  ].join("\n");

  const sanitized = sanitizeTerminalTranscriptChunk(raw);

  assert.equal(sanitized.includes("__CODEX_DECK_AI_EXIT_CODE"), true);
  assert.equal(sanitized.includes("__CODEX_DECK_AI_CWD"), true);
  assert.equal(sanitized.includes("__CODEX_DECK_AI_RESULT__"), true);
  assert.match(sanitized, /ls -la/);
  assert.match(sanitized, /README\.md/);
});

test("sanitizeTerminalTranscriptChunk drops transient prompt artifact lines", () => {
  const raw = [
    "\u001b[1m\u001b[7m%\u001b[27m\u001b[1m\u001b[0m",
    "",
    "(base) Project/codex-deck » ",
  ].join("\n");

  const sanitized = sanitizeTerminalTranscriptChunk(raw);

  assert.equal(sanitized.includes("%"), false);
  assert.equal(sanitized.includes("\u001b"), false);
  assert.equal(sanitized.trim(), "(base) Project/codex-deck »");
});

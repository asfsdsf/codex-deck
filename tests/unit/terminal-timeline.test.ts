import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTerminalTimeline,
  getTerminalInlineAnchorOffset,
  sanitizeTerminalTranscriptChunk,
} from "../../web/terminal-timeline";

test("getTerminalInlineAnchorOffset keeps the active line below new cards", () => {
  assert.equal(getTerminalInlineAnchorOffset("line 1\nprompt> "), 7);
  assert.equal(getTerminalInlineAnchorOffset("prompt> "), 0);
  assert.equal(getTerminalInlineAnchorOffset("a\rprompt> "), 2);
});

test("buildTerminalTimeline interleaves output slices and cards", () => {
  const timeline = buildTerminalTimeline({
    output: "alpha\nbeta\nprompt> ",
    messageKeys: ["m1", "m2"],
    anchors: {
      m1: { offset: 6, order: 0 },
      m2: { offset: 11, order: 1 },
    },
  });

  assert.deepEqual(timeline.entries, [
    {
      type: "output",
      key: "output:0:6",
      text: "alpha\n",
    },
    {
      type: "card",
      key: "card:m1",
      messageKey: "m1",
    },
    {
      type: "output",
      key: "output:6:11",
      text: "beta\n",
    },
    {
      type: "card",
      key: "card:m2",
      messageKey: "m2",
    },
  ]);
  assert.equal(timeline.liveOutput, "prompt> ");
});

test("buildTerminalTimeline orders cards with the same anchor by insertion order", () => {
  const timeline = buildTerminalTimeline({
    output: "alpha\nprompt> ",
    messageKeys: ["later", "earlier"],
    anchors: {
      later: { offset: 6, order: 1 },
      earlier: { offset: 6, order: 0 },
    },
  });

  assert.deepEqual(
    timeline.entries.map((entry) => entry.type === "card" ? entry.messageKey : entry.text),
    ["alpha\n", "earlier", "later"],
  );
  assert.equal(timeline.liveOutput, "prompt> ");
});

test("sanitizeTerminalTranscriptChunk strips control sequences and internal helper lines", () => {
  const raw = [
    "\u001b]2;title\u0007",
    "__CODEX_DECK_AI_EXIT_CODE=$?",
    "ls -la",
    "\u001b[?2004h_\u0008__CODEX_DECK_AI_CWD=\"$(pwd)\"",
    "__CODEX_DECK_AI_RESULT__ step=s1 exit=0 cwd=/repo",
    "README.md",
  ].join("\n");

  const sanitized = sanitizeTerminalTranscriptChunk(raw);

  assert.equal(sanitized.includes("__CODEX_DECK_AI_EXIT_CODE"), false);
  assert.equal(sanitized.includes("__CODEX_DECK_AI_CWD"), false);
  assert.equal(sanitized.includes("__CODEX_DECK_AI_RESULT__"), false);
  assert.match(sanitized, /ls -la/);
  assert.match(sanitized, /README\.md/);
});

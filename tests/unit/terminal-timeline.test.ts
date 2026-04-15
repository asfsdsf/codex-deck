import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTerminalTimeline,
  getTerminalInlineAnchorOffset,
  getTerminalTranscriptStartOffset,
  normalizeFrozenTerminalOutputsInOrder,
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
    timeline.entries.map((entry) =>
      entry.type === "card" ? entry.messageKey : entry.text,
    ),
    ["alpha\n", "earlier", "later"],
  );
  assert.equal(timeline.liveOutput, "prompt> ");
});

test("buildTerminalTimeline can insert frozen transcript output before a later card", () => {
  const timeline = buildTerminalTimeline({
    output: "prompt> find .\n0 ./a\n0 ./b\nprompt> ",
    messageKeys: ["plan", "complete"],
    anchors: {
      plan: { offset: 27, order: 0 },
      complete: { offset: 27, order: 1 },
    },
    frozenOutputByMessageKey: {
      complete: "prompt> find .\n0 ./a\n0 ./b\nprompt> ",
    },
  });

  assert.deepEqual(
    timeline.entries.map((entry) =>
      entry.type === "card" ? entry.messageKey : entry.text,
    ),
    ["plan", "prompt> find .\n0 ./a\n0 ./b\nprompt> ", "complete"],
  );
  assert.equal(timeline.liveOutput, "prompt> ");
});

test("buildTerminalTimeline keeps multiple restored frozen transcript blocks separate", () => {
  const timeline = buildTerminalTimeline({
    output: "prompt> one\n1\nprompt> two\n2\nprompt> ",
    messageKeys: ["plan-1", "complete-1", "plan-2", "complete-2"],
    anchors: {
      "plan-1": { offset: 31, order: 0 },
      "complete-1": { offset: 31, order: 1 },
      "plan-2": { offset: 31, order: 2 },
      "complete-2": { offset: 31, order: 3 },
    },
    frozenOutputByMessageKey: {
      "complete-1": "prompt> one\n1\nprompt> ",
      "complete-2": "prompt> two\n2\nprompt> ",
    },
  });

  assert.deepEqual(
    timeline.entries.map((entry) =>
      entry.type === "card" ? entry.messageKey : entry.text,
    ),
    [
      "plan-1",
      "prompt> one\n1\nprompt> ",
      "complete-1",
      "plan-2",
      "prompt> two\n2\nprompt> ",
      "complete-2",
    ],
  );
  assert.equal(
    new Set(timeline.entries.map((entry) => entry.key)).size,
    timeline.entries.length,
  );
});

test("getTerminalTranscriptStartOffset uses the nearest preceding anchored card", () => {
  assert.equal(
    getTerminalTranscriptStartOffset({
      messageKeys: ["plan-1", "complete-1", "plan-2", "complete-2"],
      anchors: {
        "plan-1": { offset: 0, order: 0 },
        "complete-1": { offset: 20, order: 1 },
        "plan-2": { offset: 20, order: 2 },
      },
      messageKey: "complete-2",
    }),
    20,
  );
});

test("normalizeFrozenTerminalOutputsInOrder trims cumulative restored blocks", () => {
  assert.deepEqual(
    normalizeFrozenTerminalOutputsInOrder([
      "prompt> one\n1\nprompt>\nprompt> two\n2\nprompt>",
      "prompt> two\n2\nprompt>",
    ]),
    ["prompt> one\n1\nprompt>", "prompt> two\n2\nprompt>"],
  );
});

test("sanitizeTerminalTranscriptChunk strips control sequences and internal helper lines", () => {
  const raw = [
    "\u001b]2;title\u0007",
    "__CODEX_DECK_AI_EXIT_CODE=$?",
    "ls -la",
    '\u001b[?2004h_\u0008__CODEX_DECK_AI_CWD="$(pwd)"',
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

test("sanitizeTerminalTranscriptChunk drops transient prompt artifact lines", () => {
  const raw = [
    "\u001b[1m\u001b[7m%\u001b[27m\u001b[1m\u001b[0m",
    "",
    "(base) Project/codex-deck » ",
  ].join("\n");

  const sanitized = sanitizeTerminalTranscriptChunk(raw);

  assert.equal(sanitized.includes("%"), false);
  assert.match(sanitized, /\(base\) Project\/codex-deck »/);
});

test("sanitizeTerminalTranscriptChunk drops prompt lines with transient suffix artifacts", () => {
  const sanitized = sanitizeTerminalTranscriptChunk(
    [
      "(base) Project/codex-deck » =",
      "",
      "(base) Project/codex-deck » printf 'FIRST_ONLY\\n'",
      "FIRST_ONLY",
    ].join("\n"),
  );

  assert.equal(sanitized.includes("» ="), false);
  assert.equal(sanitized.startsWith("\n"), false);
  assert.match(sanitized, /printf 'FIRST_ONLY\\n'/);
  assert.match(sanitized, /FIRST_ONLY/);
});

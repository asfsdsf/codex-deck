import assert from "node:assert/strict";
import test from "node:test";
import {
  TERMINAL_EXTRA_KEYS,
  applyTerminalCtrlModifier,
  getTerminalExtraKeySequence,
} from "../../web/terminal-extra-keys";

test("extra keys send the expected bytes in normal cursor mode", () => {
  const normal = { applicationCursorKeys: false };
  assert.equal(getTerminalExtraKeySequence("esc", normal), "\u001b");
  assert.equal(getTerminalExtraKeySequence("tab", normal), "\t");
  assert.equal(getTerminalExtraKeySequence("ctrl-c", normal), "\u0003");
  assert.equal(getTerminalExtraKeySequence("up", normal), "\u001b[A");
  assert.equal(getTerminalExtraKeySequence("left", normal), "\u001b[D");
  assert.equal(getTerminalExtraKeySequence("home", normal), "\u001b[H");
  assert.equal(getTerminalExtraKeySequence("pipe", normal), "|");
  assert.equal(getTerminalExtraKeySequence("ctrl", normal), null);
});

test("cursor keys switch to application mode for full-screen apps", () => {
  const application = { applicationCursorKeys: true };
  assert.equal(getTerminalExtraKeySequence("up", application), "\u001bOA");
  assert.equal(getTerminalExtraKeySequence("right", application), "\u001bOC");
  assert.equal(getTerminalExtraKeySequence("end", application), "\u001bOF");
});

test("every listed key has a label and an accessible name", () => {
  const ids = new Set<string>();
  for (const key of TERMINAL_EXTRA_KEYS) {
    assert.ok(key.label.length > 0);
    assert.ok(key.ariaLabel.length > 0);
    ids.add(key.id);
  }
  assert.equal(ids.size, TERMINAL_EXTRA_KEYS.length);
});

test("applyTerminalCtrlModifier maps letters and symbols to control codes", () => {
  assert.equal(applyTerminalCtrlModifier("c"), "\u0003");
  assert.equal(applyTerminalCtrlModifier("C"), "\u0003");
  assert.equal(applyTerminalCtrlModifier("l"), "\u000c");
  assert.equal(applyTerminalCtrlModifier("["), "\u001b");
  assert.equal(applyTerminalCtrlModifier(" "), "\u0000");
  assert.equal(applyTerminalCtrlModifier("?"), "\u007f");
});

test("applyTerminalCtrlModifier leaves other input unchanged", () => {
  assert.equal(applyTerminalCtrlModifier("é"), "é");
  assert.equal(applyTerminalCtrlModifier("ls"), "ls");
  assert.equal(applyTerminalCtrlModifier(""), "");
});

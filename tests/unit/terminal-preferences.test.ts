import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  clampTerminalFontSize,
  readStoredTerminalFontSize,
  writeStoredTerminalFontSize,
} from "../../web/terminal-preferences";

function createStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

test("clampTerminalFontSize keeps sizes in the supported range", () => {
  assert.equal(clampTerminalFontSize(1), MIN_TERMINAL_FONT_SIZE);
  assert.equal(clampTerminalFontSize(99), MAX_TERMINAL_FONT_SIZE);
  assert.equal(clampTerminalFontSize(14.4), 14);
  assert.equal(clampTerminalFontSize(Number.NaN), DEFAULT_TERMINAL_FONT_SIZE);
});

test("terminal font size round-trips through storage", () => {
  const storage = createStorage();
  assert.equal(readStoredTerminalFontSize(storage), DEFAULT_TERMINAL_FONT_SIZE);

  writeStoredTerminalFontSize(16, storage);
  assert.equal(readStoredTerminalFontSize(storage), 16);

  storage.values.set("codex-deck:terminal-font-size", "garbage");
  assert.equal(readStoredTerminalFontSize(storage), DEFAULT_TERMINAL_FONT_SIZE);
});

test("terminal font size falls back when storage is unavailable", () => {
  const throwingStorage = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };

  assert.equal(
    readStoredTerminalFontSize(throwingStorage),
    DEFAULT_TERMINAL_FONT_SIZE,
  );
  assert.doesNotThrow(() => writeStoredTerminalFontSize(15, throwingStorage));
  assert.equal(readStoredTerminalFontSize(null), DEFAULT_TERMINAL_FONT_SIZE);
});

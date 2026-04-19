import assert from "node:assert/strict";
import test from "node:test";
import { getTerminalTheme } from "../../web/terminal-theme";

test("getTerminalTheme returns the light terminal palette", () => {
  assert.deepEqual(getTerminalTheme("light"), {
    background: "#f8fafc",
    foreground: "#1f2937",
    cursor: "#0f172a",
  });
});

test("getTerminalTheme returns the dark terminal palette", () => {
  assert.deepEqual(getTerminalTheme("dark"), {
    background: "#09090b",
    foreground: "#e4e4e7",
    cursor: "#d4d4d8",
  });
});

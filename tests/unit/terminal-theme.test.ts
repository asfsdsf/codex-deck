import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { getTerminalTheme } from "../../web/terminal-theme";

function readCssTerminalTokens(theme: "dark" | "light") {
  const css = readFileSync(join(process.cwd(), "web/index.css"), "utf8");
  const blockStart =
    theme === "light" ? css.indexOf(':root[data-theme="light"]') : 0;
  const block = css.slice(blockStart);
  const read = (name: string) =>
    block.match(new RegExp(`--app-terminal-${name}:\\s*([^;]+);`))?.[1];
  return {
    background: read("background"),
    foreground: read("foreground"),
    cursor: read("cursor"),
  };
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme} terminal palette matches the --app-terminal-* tokens`, () => {
    const palette = getTerminalTheme(theme);
    assert.deepEqual(
      {
        background: palette.background,
        foreground: palette.foreground,
        cursor: palette.cursor,
      },
      readCssTerminalTokens(theme),
    );
  });

  test(`${theme} terminal palette defines every ANSI color and a selection color`, () => {
    const palette = getTerminalTheme(theme);
    for (const name of [
      "black",
      "red",
      "green",
      "yellow",
      "blue",
      "magenta",
      "cyan",
      "white",
      "brightBlack",
      "brightRed",
      "brightGreen",
      "brightYellow",
      "brightBlue",
      "brightMagenta",
      "brightCyan",
      "brightWhite",
      "selectionBackground",
    ] as const) {
      assert.ok(palette[name], `${theme} palette is missing ${name}`);
    }
  });
}

test("light terminal selection is not xterm's translucent white", () => {
  const selection = getTerminalTheme("light").selectionBackground;
  assert.doesNotMatch(selection, /255,\s*255,\s*255/u);
});

test("getTerminalTheme returns a fresh object each call", () => {
  const first = getTerminalTheme("dark");
  first.background = "#000000";
  assert.notEqual(getTerminalTheme("dark").background, "#000000");
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  fitTerminalViewport,
  isUsableTerminalSize,
  MIN_USABLE_TERMINAL_COLS,
  MIN_USABLE_TERMINAL_ROWS,
} from "../../web/terminal-render";

test("fitTerminalViewport skips hidden containers", () => {
  let fitCalls = 0;

  const result = fitTerminalViewport({
    container: {
      clientWidth: 0,
      clientHeight: 320,
    },
    fitAddon: {
      fit() {
        fitCalls += 1;
      },
    },
    terminal: { cols: 80, rows: 24 },
  });

  assert.deepEqual(result, { didFit: false, sizeChanged: false });
  assert.equal(fitCalls, 0);
});

test("fitTerminalViewport skips containers too small to be a usable terminal", () => {
  let fitCalls = 0;
  const terminal = { cols: 86, rows: 31 };

  const result = fitTerminalViewport({
    container: { clientWidth: 30, clientHeight: 480 },
    fitAddon: {
      fit() {
        fitCalls += 1;
      },
      proposeDimensions: () => ({ cols: 3, rows: 22 }),
    },
    terminal,
  });

  assert.deepEqual(result, { didFit: false, sizeChanged: false });
  assert.equal(fitCalls, 0);
  assert.deepEqual(terminal, { cols: 86, rows: 31 });
});

test("fitTerminalViewport reports a size change", () => {
  const terminal = { cols: 80, rows: 24 };

  const result = fitTerminalViewport({
    container: {
      clientWidth: 960,
      clientHeight: 480,
    },
    fitAddon: {
      fit() {
        terminal.cols = 120;
        terminal.rows = 30;
      },
      proposeDimensions: () => ({ cols: 120, rows: 30 }),
    },
    terminal,
  });

  assert.deepEqual(result, { didFit: true, sizeChanged: true });
});

test("fitTerminalViewport reports an unchanged geometry", () => {
  const result = fitTerminalViewport({
    container: {
      clientWidth: 960,
      clientHeight: 480,
    },
    fitAddon: {
      fit() {
        // Keep the existing geometry.
      },
    },
    terminal: { cols: 120, rows: 30 },
  });

  assert.deepEqual(result, { didFit: true, sizeChanged: false });
});

test("isUsableTerminalSize rejects slivers and accepts phone-sized grids", () => {
  assert.equal(
    isUsableTerminalSize({
      cols: MIN_USABLE_TERMINAL_COLS - 1,
      rows: 24,
    }),
    false,
  );
  assert.equal(
    isUsableTerminalSize({
      cols: 80,
      rows: MIN_USABLE_TERMINAL_ROWS - 1,
    }),
    false,
  );
  assert.equal(isUsableTerminalSize({ cols: Number.NaN, rows: 24 }), false);
  assert.equal(isUsableTerminalSize({ cols: 44, rows: 24 }), true);
});

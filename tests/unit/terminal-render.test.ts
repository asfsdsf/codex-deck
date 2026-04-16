import assert from "node:assert/strict";
import test from "node:test";
import { fitTerminalViewport } from "../../web/terminal-render";

test("fitTerminalViewport skips hidden containers", () => {
  let fitCalls = 0;
  let resetCalls = 0;
  let written = "";

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
    terminal: {
      cols: 80,
      rows: 24,
      reset() {
        resetCalls += 1;
      },
      write(data: string) {
        written += data;
      },
    },
    replayOutput: "prompt> ls",
  });

  assert.deepEqual(result, { didFit: false, sizeChanged: false });
  assert.equal(fitCalls, 0);
  assert.equal(resetCalls, 0);
  assert.equal(written, "");
});

test("fitTerminalViewport redraws the rendered buffer after a size change", () => {
  let resetCalls = 0;
  let written = "";
  const terminal = {
    cols: 80,
    rows: 24,
    reset() {
      resetCalls += 1;
    },
    write(data: string) {
      written += data;
    },
  };

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
    },
    terminal,
    replayOutput: "(base) Project/codex-deck » ls",
  });

  assert.deepEqual(result, { didFit: true, sizeChanged: true });
  assert.equal(resetCalls, 1);
  assert.equal(written, "(base) Project/codex-deck » ls");
});

test("fitTerminalViewport avoids redraw when the geometry is unchanged", () => {
  let resetCalls = 0;
  let writeCalls = 0;

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
    terminal: {
      cols: 120,
      rows: 30,
      reset() {
        resetCalls += 1;
      },
      write() {
        writeCalls += 1;
      },
    },
    replayOutput: "prompt> pwd",
  });

  assert.deepEqual(result, { didFit: true, sizeChanged: false });
  assert.equal(resetCalls, 0);
  assert.equal(writeCalls, 0);
});

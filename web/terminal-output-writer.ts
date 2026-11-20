// Keeps the browser-side copy of a terminal's output and is the only code that
// writes into xterm. Live chunks are appended as they arrive. Authoritative
// snapshots (bootstrap, reset, restart) are redrawn from scratch as
// "replays": at the PTY size the output was produced at, so cursor-relative
// redraws (prompts, syntax highlighting, progress bars) land where they did,
// after which the caller fits the grid to the screen and xterm reflows it.
//
// While a replay is being parsed, xterm's automatic replies to old queries
// (cursor position, device attributes, colors) must not reach the shell, so
// callers can ask `isReplaying()`.

export const MAX_RENDERED_TERMINAL_OUTPUT_CHARS = 1_000_000;

// Trimming copies the whole buffer, so let it grow a little past the limit
// before cutting it back instead of slicing on every chunk.
const TRIM_SLACK_CHARS = 128_000;

// When trimming, prefer to start the kept text on a fresh line (so it does not
// begin in the middle of an escape sequence) if a line break is this close.
const LINE_BOUNDARY_SEARCH_CHARS = 16_384;

// RIS ("reset to initial state"). xterm parses writes asynchronously, while
// its reset() method runs immediately, so a reset() issued while earlier
// writes are still queued would let that queued output land on the fresh
// screen. Sending the reset as part of the stream keeps it in order.
export const TERMINAL_FULL_RESET_SEQUENCE = "\u001bc";

export interface TerminalOutputSink {
  // Callbacks run in order, after the data is parsed and before later writes.
  write: (data: string, callback?: () => void) => void;
  resize?: (cols: number, rows: number) => void;
}

export interface TerminalOutputSize {
  cols?: number | null;
  rows?: number | null;
}

export interface TerminalOutputWriter {
  append: (chunk: string) => void;
  replace: (output: string, size?: TerminalOutputSize) => void;
  clear: () => void;
  getOutput: () => string;
  hasVisibleOutput: () => boolean;
  isReplaying: () => boolean;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isUsableDimension(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 2;
}

export function trimTerminalOutputHead(
  output: string,
  maxChars: number,
): string {
  if (output.length <= maxChars) {
    return output;
  }
  if (maxChars <= 0) {
    return "";
  }

  let start = output.length - maxChars;
  const lineBreak = output.indexOf("\n", start);
  if (lineBreak !== -1 && lineBreak - start < LINE_BOUNDARY_SEARCH_CHARS) {
    start = lineBreak + 1;
  } else if (isLowSurrogate(output.charCodeAt(start))) {
    start += 1;
  }
  return output.slice(start);
}

export function appendTerminalOutput(
  current: string,
  chunk: string,
  maxChars: number,
): string {
  const next = `${current}${chunk}`;
  if (next.length <= maxChars + TRIM_SLACK_CHARS) {
    return next;
  }
  return trimTerminalOutputHead(next, maxChars);
}

function containsVisibleText(text: string): boolean {
  return /\S/u.test(text);
}

export function createTerminalOutputWriter(input: {
  getSink: () => TerminalOutputSink | null;
  maxChars?: number;
  onVisibleOutputChange?: (hasVisibleOutput: boolean) => void;
  // Runs after each replay write has been parsed, so the caller can fit the
  // grid back to its container (a redraw may have used the PTY's size).
  // Callers should not fit while `isReplaying()` is true: xterm may yield
  // between queued writes, and a fit landing between the resize and the data
  // would draw the snapshot at the wrong width.
  onRedrawComplete?: () => void;
}): TerminalOutputWriter {
  const maxChars = input.maxChars ?? MAX_RENDERED_TERMINAL_OUTPUT_CHARS;
  let output = "";
  let visible = false;
  // Replay writes queued in the sink and not yet parsed. Every write is
  // eventually parsed (a reset is just more stream data), so each one's
  // callback balances the count.
  let pendingReplayWrites = 0;

  const setVisible = (next: boolean) => {
    if (visible === next) {
      return;
    }
    visible = next;
    input.onVisibleOutputChange?.(next);
  };

  const writeReplayData = (
    sink: TerminalOutputSink,
    data: string,
    afterParse?: () => void,
  ) => {
    pendingReplayWrites += 1;
    sink.write(data, () => {
      pendingReplayWrites = Math.max(0, pendingReplayWrites - 1);
      try {
        afterParse?.();
      } catch (error) {
        // An exception here would abort xterm's write loop.
        console.error(error);
      }
    });
  };

  const redraw = (data: string, size?: TerminalOutputSize) => {
    const sink = input.getSink();
    if (!sink) {
      return;
    }
    const cols = size?.cols;
    const rows = size?.rows;
    if (sink.resize && isUsableDimension(cols) && isUsableDimension(rows)) {
      // Resize between the reset and the data, in stream order.
      writeReplayData(sink, TERMINAL_FULL_RESET_SEQUENCE, () => {
        sink.resize?.(cols, rows);
      });
      writeReplayData(sink, data, input.onRedrawComplete);
      return;
    }
    writeReplayData(
      sink,
      `${TERMINAL_FULL_RESET_SEQUENCE}${data}`,
      input.onRedrawComplete,
    );
  };

  return {
    append(chunk) {
      if (!chunk) {
        return;
      }
      output = appendTerminalOutput(output, chunk, maxChars);
      input.getSink()?.write(chunk);
      if (!visible && containsVisibleText(chunk)) {
        setVisible(true);
      }
    },
    replace(nextOutput, size) {
      const trimmed = trimTerminalOutputHead(nextOutput, maxChars);
      if (trimmed === output) {
        return;
      }

      // A snapshot that only extends what is already on screen (for example
      // after a short reconnect) is written as a delta to avoid a flash.
      if (output.length > 0 && trimmed.startsWith(output)) {
        const delta = trimmed.slice(output.length);
        output = trimmed;
        const sink = input.getSink();
        if (sink) {
          writeReplayData(sink, delta, input.onRedrawComplete);
        }
      } else {
        output = trimmed;
        redraw(output, size);
      }
      setVisible(containsVisibleText(output));
    },
    // Forget retained output when the sink itself is being replaced.
    clear() {
      output = "";
      pendingReplayWrites = 0;
      setVisible(false);
    },
    getOutput() {
      return output;
    },
    hasVisibleOutput() {
      return visible;
    },
    isReplaying() {
      return pendingReplayWrites > 0;
    },
  };
}

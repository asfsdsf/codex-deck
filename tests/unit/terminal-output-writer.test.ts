import assert from "node:assert/strict";
import test from "node:test";
import {
  TERMINAL_FULL_RESET_SEQUENCE,
  appendTerminalOutput,
  createTerminalOutputWriter,
  trimTerminalOutputHead,
  type TerminalOutputSink,
} from "../../web/terminal-output-writer";

// Mimics xterm: writes are queued and parsed later, callbacks run in order
// right after their own data is parsed, and resize() applies immediately.
class FakeTerminalSink implements TerminalOutputSink {
  public readonly events: string[] = [];
  public cols = 40;
  public rows = 10;
  private queue: Array<{ data: string; callback?: () => void }> = [];

  public write(data: string, callback?: () => void): void {
    this.queue.push({ data, callback });
  }

  public resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.events.push(`resize ${cols}x${rows}`);
  }

  public flush(): void {
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.events.push(
        `parse ${JSON.stringify(next.data)} at ${this.cols}x${this.rows}`,
      );
      next.callback?.();
    }
  }

  public get pendingWrites(): number {
    return this.queue.length;
  }
}

const RESET = JSON.stringify(TERMINAL_FULL_RESET_SEQUENCE);

test("trimTerminalOutputHead keeps short output and cuts long output at a line break", () => {
  assert.equal(trimTerminalOutputHead("abc", 10), "abc");
  assert.equal(
    trimTerminalOutputHead("\u001b[31mold line\nnew line\n", 12),
    "new line\n",
  );
});

test("trimTerminalOutputHead does not start with half of a surrogate pair", () => {
  const output = `x😀${"y".repeat(10)}`;
  const trimmed = trimTerminalOutputHead(output, 11);
  assert.equal(trimmed, "y".repeat(10));
});

test("appendTerminalOutput lets the buffer grow past the limit before trimming", () => {
  const limit = 1000;
  const grown = appendTerminalOutput("a".repeat(limit), "b".repeat(10), limit);
  assert.equal(grown.length, limit + 10);

  const trimmed = appendTerminalOutput(grown, "c".repeat(200_000), limit);
  assert.equal(trimmed.length, limit);
  assert.ok(trimmed.endsWith("c"));
});

test("append writes live chunks straight to the terminal", () => {
  const sink = new FakeTerminalSink();
  const visibleChanges: boolean[] = [];
  const writer = createTerminalOutputWriter({
    getSink: () => sink,
    onVisibleOutputChange: (visible) => visibleChanges.push(visible),
  });

  writer.append("\u001b[?2004h");
  writer.append("prompt> ");
  sink.flush();

  assert.deepEqual(sink.events, [
    `parse ${JSON.stringify("\u001b[?2004h")} at 40x10`,
    `parse ${JSON.stringify("prompt> ")} at 40x10`,
  ]);
  assert.equal(writer.getOutput(), "\u001b[?2004hprompt> ");
  assert.equal(writer.isReplaying(), false);
  assert.deepEqual(visibleChanges, [true]);
});

test("replace redraws at the PTY size, then reports completion", () => {
  const sink = new FakeTerminalSink();
  let completions = 0;
  const writer = createTerminalOutputWriter({
    getSink: () => sink,
    onRedrawComplete: () => {
      completions += 1;
      sink.events.push("redraw complete");
    },
  });

  writer.replace("history", { cols: 86, rows: 31 });
  assert.equal(writer.isReplaying(), true);
  sink.flush();

  assert.deepEqual(sink.events, [
    `parse ${RESET} at 40x10`,
    "resize 86x31",
    `parse "history" at 86x31`,
    "redraw complete",
  ]);
  assert.equal(writer.isReplaying(), false);
  assert.equal(completions, 1);
});

test("replace without a usable size redraws at the current size", () => {
  const sink = new FakeTerminalSink();
  const writer = createTerminalOutputWriter({ getSink: () => sink });

  writer.replace("history", { cols: 0, rows: 31 });
  sink.flush();

  assert.deepEqual(sink.events, [
    `parse ${JSON.stringify(`${TERMINAL_FULL_RESET_SEQUENCE}history`)} at 40x10`,
  ]);
});

test("a restart snapshot clears the old screen instead of appending to it", () => {
  const sink = new FakeTerminalSink();
  const visibleChanges: boolean[] = [];
  const writer = createTerminalOutputWriter({
    getSink: () => sink,
    onVisibleOutputChange: (visible) => visibleChanges.push(visible),
  });
  writer.append("old shell output\r\n");
  sink.flush();
  sink.events.length = 0;

  writer.replace("");
  sink.flush();

  assert.deepEqual(sink.events, [`parse ${RESET} at 40x10`]);
  assert.equal(writer.getOutput(), "");
  assert.deepEqual(visibleChanges, [true, false]);
});

test("a reconnect snapshot that matches the screen writes nothing", () => {
  const sink = new FakeTerminalSink();
  const writer = createTerminalOutputWriter({ getSink: () => sink });
  writer.append("line 1\r\n");
  writer.append("line 2\r\n");
  sink.flush();
  sink.events.length = 0;

  writer.replace("line 1\r\nline 2\r\n", { cols: 40, rows: 10 });
  writer.append("line 3\r\n");
  sink.flush();

  assert.deepEqual(sink.events, [`parse "line 3\\r\\n" at 40x10`]);
  assert.equal(writer.getOutput(), "line 1\r\nline 2\r\nline 3\r\n");
});

test("a reconnect snapshot that extends the screen writes only the new part", () => {
  const sink = new FakeTerminalSink();
  const writer = createTerminalOutputWriter({ getSink: () => sink });
  writer.append("line 1\r\n");
  sink.flush();
  sink.events.length = 0;

  writer.replace("line 1\r\nmissed while away\r\n");
  assert.equal(writer.isReplaying(), true);
  sink.flush();

  assert.deepEqual(sink.events, [`parse "missed while away\\r\\n" at 40x10`]);
  assert.equal(writer.isReplaying(), false);
});

test("a redraw queued behind another redraw still ends on the newest snapshot", () => {
  const sink = new FakeTerminalSink();
  const writer = createTerminalOutputWriter({ getSink: () => sink });

  writer.replace("first");
  writer.replace("second");
  assert.equal(sink.pendingWrites, 2);
  sink.flush();

  assert.deepEqual(sink.events, [
    `parse ${JSON.stringify(`${TERMINAL_FULL_RESET_SEQUENCE}first`)} at 40x10`,
    `parse ${JSON.stringify(`${TERMINAL_FULL_RESET_SEQUENCE}second`)} at 40x10`,
  ]);
  assert.equal(writer.getOutput(), "second");
});

test("a throwing completion callback does not leave the writer replaying", () => {
  const sink = new FakeTerminalSink();
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    const writer = createTerminalOutputWriter({
      getSink: () => sink,
      onRedrawComplete: () => {
        throw new Error("fit failed");
      },
    });
    writer.replace("history");
    sink.flush();
    assert.equal(writer.isReplaying(), false);
  } finally {
    console.error = originalConsoleError;
  }
});

test("clear forgets retained output", () => {
  const sink = new FakeTerminalSink();
  const writer = createTerminalOutputWriter({ getSink: () => sink });
  writer.append("hello");
  writer.replace("other");

  writer.clear();

  assert.equal(writer.getOutput(), "");
  assert.equal(writer.hasVisibleOutput(), false);
  assert.equal(writer.isReplaying(), false);
});

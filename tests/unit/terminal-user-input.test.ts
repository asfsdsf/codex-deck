import assert from "node:assert/strict";
import test from "node:test";
import {
  bindTerminalInputHandlers,
  buildTerminalPasteInput,
  USER_INPUT_ATTRIBUTION_WINDOW_MS,
  type TerminalInputQueueOptions,
} from "../../web/terminal-user-input";

class FakeElement {
  private readonly listeners = new Map<string, Set<() => void>>();

  public addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  public dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }

  public listenerCount(): number {
    let count = 0;
    for (const listeners of this.listeners.values()) {
      count += listeners.size;
    }
    return count;
  }
}

class FakeTerminal {
  public readonly element = new FakeElement();
  private readonly dataListeners = new Set<(data: string) => void>();

  public onData(listener: (data: string) => void): { dispose: () => void } {
    this.dataListeners.add(listener);
    return {
      dispose: () => {
        this.dataListeners.delete(listener);
      },
    };
  }

  public emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  public get dataListenerCount(): number {
    return this.dataListeners.size;
  }
}

function bind(options?: { replaying?: () => boolean }) {
  const terminal = new FakeTerminal();
  const sent: Array<{ data: string; options?: TerminalInputQueueOptions }> = [];
  let now = 1_000;
  const cleanup = bindTerminalInputHandlers({
    terminal: terminal as unknown as Parameters<
      typeof bindTerminalInputHandlers
    >[0]["terminal"],
    controller: {
      queueInput: (data, queueOptions) => {
        sent.push({ data, options: queueOptions });
      },
    },
    isReplayingOutput: options?.replaying ?? (() => false),
    now: () => now,
  });
  return {
    terminal,
    sent,
    cleanup,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("buildTerminalPasteInput normalizes line endings and brackets paste when enabled", () => {
  assert.equal(
    buildTerminalPasteInput("line 1\nline 2", {
      bracketedPasteMode: true,
    }),
    "\u001b[200~line 1\rline 2\u001b[201~",
  );
});

test("typed input, including input-event-only text from mobile keyboards, is forwarded as user input", () => {
  const { terminal, sent, cleanup } = bind();

  terminal.element.dispatch("keydown");
  terminal.emitData("l");
  terminal.element.dispatch("input");
  terminal.emitData("s -la");

  assert.deepEqual(sent, [
    { data: "l", options: { userInitiated: true } },
    { data: "s -la", options: { userInitiated: true } },
  ]);
  cleanup();
});

test("IME text flushed shortly after compositionend still counts as typed", () => {
  const { terminal, sent, cleanup, advance } = bind();

  terminal.element.dispatch("compositionend");
  advance(USER_INPUT_ATTRIBUTION_WINDOW_MS - 1);
  terminal.emitData("中文");

  assert.deepEqual(sent, [{ data: "中文", options: { userInitiated: true } }]);
  cleanup();
});

test("terminal query replies are forwarded as automatic input", () => {
  const { terminal, sent, cleanup, advance } = bind();

  terminal.element.dispatch("keydown");
  advance(USER_INPUT_ATTRIBUTION_WINDOW_MS + 1);
  terminal.emitData("\u001b[5;1R");

  assert.deepEqual(sent, [
    { data: "\u001b[5;1R", options: { userInitiated: false } },
  ]);
  cleanup();
});

test("replies generated while old output is replayed are dropped, typing is not", () => {
  let replaying = true;
  const { terminal, sent, cleanup, advance } = bind({
    replaying: () => replaying,
  });

  terminal.emitData("\u001b[?1;2c");
  terminal.element.dispatch("keydown");
  terminal.emitData("q");
  advance(USER_INPUT_ATTRIBUTION_WINDOW_MS + 1);
  replaying = false;
  terminal.emitData("\u001b[12;1R");

  assert.deepEqual(sent, [
    { data: "q", options: { userInitiated: true } },
    { data: "\u001b[12;1R", options: { userInitiated: false } },
  ]);
  cleanup();
});

test("cleanup unsubscribes from xterm and the DOM", () => {
  const { terminal, cleanup } = bind();
  assert.equal(terminal.dataListenerCount, 1);
  assert.ok(terminal.element.listenerCount() > 0);

  cleanup();

  assert.equal(terminal.dataListenerCount, 0);
  assert.equal(terminal.element.listenerCount(), 0);
});

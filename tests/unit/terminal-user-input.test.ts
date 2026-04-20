import assert from "node:assert/strict";
import test from "node:test";
import {
  bindTerminalExplicitInputHandlers,
  buildTerminalPasteInput,
} from "../../web/terminal-user-input";

class FakeTextArea {
  public value = "";
  private readonly listeners = new Map<
    string,
    Set<(event: Event | KeyboardEvent | ClipboardEvent) => void>
  >();

  public addEventListener(
    type: string,
    listener: (event: Event | KeyboardEvent | ClipboardEvent) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(
    type: string,
    listener: (event: Event | KeyboardEvent | ClipboardEvent) => void,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  public dispatch(
    type: string,
    event: Event | KeyboardEvent | ClipboardEvent,
  ): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class FakeTerminal {
  public readonly textarea = new FakeTextArea();
  public readonly modes: { bracketedPasteMode: boolean } = {
    bracketedPasteMode: false,
  };
  public onDataSubscriptions = 0;
  private readonly keyListeners = new Set<
    (event: { key: string; domEvent: KeyboardEvent }) => void
  >();

  public onKey(
    listener: (event: { key: string; domEvent: KeyboardEvent }) => void,
  ): { dispose: () => void } {
    this.keyListeners.add(listener);
    return {
      dispose: () => {
        this.keyListeners.delete(listener);
      },
    };
  }

  public onData(): { dispose: () => void } {
    this.onDataSubscriptions += 1;
    return {
      dispose: () => undefined,
    };
  }

  public emitKey(key: string): void {
    const domEvent = {
      key,
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    } as unknown as KeyboardEvent;
    for (const listener of this.keyListeners) {
      listener({ key, domEvent });
    }
  }
}

test("buildTerminalPasteInput normalizes line endings and brackets paste when enabled", () => {
  assert.equal(
    buildTerminalPasteInput("line 1\nline 2", {
      bracketedPasteMode: true,
    }),
    "\u001b[200~line 1\rline 2\u001b[201~",
  );
});

test("bindTerminalExplicitInputHandlers forwards key input without subscribing to terminal onData", () => {
  const terminal = new FakeTerminal();
  const sentInputs: string[] = [];

  const cleanup = bindTerminalExplicitInputHandlers({
    terminal: terminal as unknown as Parameters<
      typeof bindTerminalExplicitInputHandlers
    >[0]["terminal"],
    controller: {
      queueInput: (chunk: string) => {
        sentInputs.push(chunk);
      },
    },
  });

  terminal.emitKey("a");

  assert.deepEqual(sentInputs, ["a"]);
  assert.equal(terminal.onDataSubscriptions, 0);

  cleanup();
});

test("bindTerminalExplicitInputHandlers forwards explicit paste input with bracketed paste mode", () => {
  const terminal = new FakeTerminal();
  terminal.modes.bracketedPasteMode = true;
  const sentInputs: string[] = [];
  let prevented = false;
  let stopped = false;

  const cleanup = bindTerminalExplicitInputHandlers({
    terminal: terminal as unknown as Parameters<
      typeof bindTerminalExplicitInputHandlers
    >[0]["terminal"],
    controller: {
      queueInput: (chunk: string) => {
        sentInputs.push(chunk);
      },
    },
  });

  terminal.textarea.dispatch("paste", {
    clipboardData: {
      getData: () => "foo\nbar",
    },
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
  } as unknown as ClipboardEvent);

  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.deepEqual(sentInputs, ["\u001b[200~foo\rbar\u001b[201~"]);

  cleanup();
});

test("bindTerminalExplicitInputHandlers forwards committed composition text", async () => {
  const terminal = new FakeTerminal();
  const sentInputs: string[] = [];

  const cleanup = bindTerminalExplicitInputHandlers({
    terminal: terminal as unknown as Parameters<
      typeof bindTerminalExplicitInputHandlers
    >[0]["terminal"],
    controller: {
      queueInput: (chunk: string) => {
        sentInputs.push(chunk);
      },
    },
  });

  terminal.textarea.value = "";
  terminal.textarea.dispatch("compositionstart", {} as Event);
  terminal.textarea.value = "中";
  terminal.textarea.dispatch("compositionend", {} as Event);

  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  assert.deepEqual(sentInputs, ["中"]);
  assert.equal(terminal.textarea.value, "");

  cleanup();
});

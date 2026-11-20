// Routes everything xterm emits through `onData` to the terminal input
// controller. That covers typed keys, IME composition, mobile keyboards that
// only fire `input` events, paste (xterm applies bracketed paste itself),
// mouse reporting for full-screen apps, and xterm's automatic replies to
// terminal queries (cursor position, device attributes, colors).
//
// Automatic replies are only correct for live output. When historical output
// is replayed (page load, reconnect, restart, resize redraw) xterm answers
// queries that were already answered long ago, and those answers would be
// typed into the shell as garbage. Callers report replays through
// `isReplayingOutput`, and data that arrives during a replay without a recent
// keyboard interaction is dropped.

export interface TerminalInputQueueOptions {
  // True for data that comes from the person typing or pasting. Anything else
  // (mouse reports, focus reports, automatic query replies) is false.
  userInitiated: boolean;
}

export interface TerminalInputController {
  queueInput: (chunk: string, options?: TerminalInputQueueOptions) => void;
}

interface TerminalSubscription {
  dispose: () => void;
}

interface TerminalEventTargetLike {
  addEventListener: (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  removeEventListener: (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => void;
}

export interface TerminalInputBindingTarget {
  onData: (listener: (data: string) => void) => TerminalSubscription;
  element?: TerminalEventTargetLike | null;
}

// xterm delivers some typed text a tick after the DOM event (IME composition
// is flushed from a timeout), so attribution uses a short time window.
export const USER_INPUT_ATTRIBUTION_WINDOW_MS = 250;

const USER_INPUT_EVENT_TYPES = [
  "keydown",
  "keypress",
  "beforeinput",
  "input",
  "compositionstart",
  "compositionupdate",
  "compositionend",
  "paste",
  "drop",
] as const;

export function prepareTerminalPasteInput(text: string): string {
  return text.replace(/\r?\n/g, "\r");
}

export function buildTerminalPasteInput(
  text: string,
  options?: {
    bracketedPasteMode?: boolean | null;
  },
): string {
  const normalized = prepareTerminalPasteInput(text);
  if (options?.bracketedPasteMode) {
    return `\u001b[200~${normalized}\u001b[201~`;
  }
  return normalized;
}

export function bindTerminalInputHandlers(input: {
  terminal: TerminalInputBindingTarget;
  controller: TerminalInputController;
  isReplayingOutput: () => boolean;
  now?: () => number;
}): () => void {
  const now = input.now ?? (() => Date.now());
  let lastUserInputAt = Number.NEGATIVE_INFINITY;

  const markUserInput = () => {
    lastUserInputAt = now();
  };

  const element = input.terminal.element ?? null;
  for (const type of USER_INPUT_EVENT_TYPES) {
    element?.addEventListener(type, markUserInput, true);
  }

  const dataSubscription = input.terminal.onData((data) => {
    if (!data) {
      return;
    }
    const userInitiated =
      now() - lastUserInputAt <= USER_INPUT_ATTRIBUTION_WINDOW_MS;
    if (!userInitiated && input.isReplayingOutput()) {
      return;
    }
    input.controller.queueInput(data, { userInitiated });
  });

  return () => {
    dataSubscription.dispose();
    for (const type of USER_INPUT_EVENT_TYPES) {
      element?.removeEventListener(type, markUserInput, true);
    }
  };
}

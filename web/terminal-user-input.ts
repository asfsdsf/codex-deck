export interface ExplicitTerminalInputController {
  queueInput: (chunk: string) => void;
}

interface TerminalKeySubscription {
  dispose: () => void;
}

interface TerminalTextAreaLike {
  value: string;
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

export interface ExplicitTerminalInputBindingTarget {
  onKey: (
    listener: (event: { key: string; domEvent: KeyboardEvent }) => void,
  ) => TerminalKeySubscription;
  textarea?: TerminalTextAreaLike | null;
  modes: {
    bracketedPasteMode?: boolean | null;
  };
}

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

export function bindTerminalExplicitInputHandlers(input: {
  terminal: ExplicitTerminalInputBindingTarget;
  controller: ExplicitTerminalInputController;
}): () => void {
  const keySubscription = input.terminal.onKey(({ key }) => {
    if (key) {
      input.controller.queueInput(key);
    }
  });

  const textarea = input.terminal.textarea;
  if (!textarea) {
    return () => {
      keySubscription.dispose();
    };
  }

  let isComposing = false;
  let compositionStartValue = "";
  let compositionFlushTimer: ReturnType<typeof setTimeout> | null = null;

  const clearCompositionFlushTimer = () => {
    if (compositionFlushTimer) {
      clearTimeout(compositionFlushTimer);
      compositionFlushTimer = null;
    }
  };

  const flushCommittedComposition = (waitForPropagation: boolean) => {
    const deliver = () => {
      compositionFlushTimer = null;
      const currentValue = textarea.value;
      const committedText = currentValue.startsWith(compositionStartValue)
        ? currentValue.slice(compositionStartValue.length)
        : currentValue;
      if (committedText) {
        input.controller.queueInput(committedText);
      }
      textarea.value = "";
      compositionStartValue = "";
    };

    clearCompositionFlushTimer();
    if (waitForPropagation) {
      compositionFlushTimer = setTimeout(deliver, 0);
      return;
    }
    deliver();
  };

  const handlePaste = (event: Event) => {
    const clipboardEvent = event as ClipboardEvent;
    const pastedText = clipboardEvent.clipboardData?.getData("text/plain") ?? "";
    if (!pastedText) {
      return;
    }

    clipboardEvent.preventDefault();
    clipboardEvent.stopPropagation();
    input.controller.queueInput(
      buildTerminalPasteInput(pastedText, {
        bracketedPasteMode: input.terminal.modes.bracketedPasteMode,
      }),
    );
    textarea.value = "";
  };

  const handleCompositionStart = () => {
    clearCompositionFlushTimer();
    isComposing = true;
    compositionStartValue = textarea.value;
  };

  const handleCompositionEnd = () => {
    isComposing = false;
    flushCommittedComposition(true);
  };

  const handleKeyDownCapture = (event: Event) => {
    const keyboardEvent = event as KeyboardEvent;
    if (!isComposing || keyboardEvent.isComposing) {
      return;
    }

    if (keyboardEvent.key === "Enter") {
      flushCommittedComposition(false);
    }
  };

  const handleFocus = () => {
    clearCompositionFlushTimer();
    isComposing = false;
    compositionStartValue = "";
    textarea.value = "";
  };

  textarea.addEventListener("paste", handlePaste, true);
  textarea.addEventListener("compositionstart", handleCompositionStart);
  textarea.addEventListener("compositionend", handleCompositionEnd);
  textarea.addEventListener("keydown", handleKeyDownCapture, true);
  textarea.addEventListener("focus", handleFocus);

  return () => {
    clearCompositionFlushTimer();
    keySubscription.dispose();
    textarea.removeEventListener("paste", handlePaste, true);
    textarea.removeEventListener("compositionstart", handleCompositionStart);
    textarea.removeEventListener("compositionend", handleCompositionEnd);
    textarea.removeEventListener("keydown", handleKeyDownCapture, true);
    textarea.removeEventListener("focus", handleFocus);
  };
}

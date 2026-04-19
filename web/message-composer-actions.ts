export const TERMINAL_COMPOSER_CONTINUE_MESSAGE =
  "Continue from the current terminal state.";

export interface ComposerPrimaryActionStateInput {
  hasMessageContent: boolean;
  hasIdlePrimaryAction: boolean;
  idlePrimaryActionButtonLabel: string;
  idlePrimaryActionBusy: boolean;
  idlePrimaryActionBusyLabel?: string;
  idlePrimaryActionOnlyWithoutContent: boolean;
  allowIdlePrimaryActionWithoutContent: boolean;
  sendingMessage: boolean;
  shouldUseStopAction: boolean;
  stoppingTurn: boolean;
}

export interface ComposerPrimaryActionState {
  kind: "stop" | "idle" | "send";
  disabled: boolean;
  label: string;
}

export function resolveComposerPrimaryActionState(
  input: ComposerPrimaryActionStateInput,
): ComposerPrimaryActionState {
  if (input.shouldUseStopAction) {
    return {
      kind: "stop",
      disabled: input.stoppingTurn,
      label: input.stoppingTurn ? "Stopping..." : "Stop",
    };
  }

  const shouldUseIdlePrimaryAction =
    input.hasIdlePrimaryAction &&
    (!input.idlePrimaryActionOnlyWithoutContent || !input.hasMessageContent);

  if (shouldUseIdlePrimaryAction) {
    const idleBusy = input.sendingMessage || input.idlePrimaryActionBusy;
    return {
      kind: "idle",
      disabled:
        idleBusy ||
        (!input.allowIdlePrimaryActionWithoutContent &&
          !input.hasMessageContent),
      label: idleBusy
        ? (input.idlePrimaryActionBusyLabel ??
          `${input.idlePrimaryActionButtonLabel}...`)
        : input.idlePrimaryActionButtonLabel,
    };
  }

  return {
    kind: "send",
    disabled: input.sendingMessage || !input.hasMessageContent,
    label: input.sendingMessage ? "Sending..." : "Send",
  };
}

export function resolveTerminalComposerContinueText(text: string): string {
  return text.trim().length > 0 ? text : TERMINAL_COMPOSER_CONTINUE_MESSAGE;
}

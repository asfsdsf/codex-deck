import assert from "node:assert/strict";
import test from "node:test";
import {
  TERMINAL_COMPOSER_CONTINUE_MESSAGE,
  resolveComposerPrimaryActionState,
  resolveTerminalComposerContinueText,
} from "../../web/message-composer-actions";

test("composer keeps init as the primary action while creating a session", () => {
  const state = resolveComposerPrimaryActionState({
    hasMessageContent: true,
    hasIdlePrimaryAction: true,
    idlePrimaryActionButtonLabel: "Init",
    idlePrimaryActionBusy: false,
    idlePrimaryActionBusyLabel: "Initializing...",
    idlePrimaryActionOnlyWithoutContent: false,
    allowIdlePrimaryActionWithoutContent: true,
    sendingMessage: false,
    shouldUseStopAction: false,
    stoppingTurn: false,
  });

  assert.equal(state.kind, "idle");
  assert.equal(state.label, "Init");
  assert.equal(state.disabled, false);
});

test("composer exposes Continue only for empty terminal-bound submits", () => {
  const emptyState = resolveComposerPrimaryActionState({
    hasMessageContent: false,
    hasIdlePrimaryAction: true,
    idlePrimaryActionButtonLabel: "Continue",
    idlePrimaryActionBusy: false,
    idlePrimaryActionBusyLabel: "Continuing...",
    idlePrimaryActionOnlyWithoutContent: true,
    allowIdlePrimaryActionWithoutContent: true,
    sendingMessage: false,
    shouldUseStopAction: false,
    stoppingTurn: false,
  });

  assert.equal(emptyState.kind, "idle");
  assert.equal(emptyState.label, "Continue");
  assert.equal(emptyState.disabled, false);

  const draftState = resolveComposerPrimaryActionState({
    hasMessageContent: true,
    hasIdlePrimaryAction: true,
    idlePrimaryActionButtonLabel: "Continue",
    idlePrimaryActionBusy: false,
    idlePrimaryActionBusyLabel: "Continuing...",
    idlePrimaryActionOnlyWithoutContent: true,
    allowIdlePrimaryActionWithoutContent: true,
    sendingMessage: false,
    shouldUseStopAction: false,
    stoppingTurn: false,
  });

  assert.equal(draftState.kind, "send");
  assert.equal(draftState.label, "Send");
  assert.equal(draftState.disabled, false);
});

test("resolveTerminalComposerContinueText falls back to a concise continue prompt", () => {
  assert.equal(
    resolveTerminalComposerContinueText(""),
    TERMINAL_COMPOSER_CONTINUE_MESSAGE,
  );
  assert.equal(
    resolveTerminalComposerContinueText("   "),
    TERMINAL_COMPOSER_CONTINUE_MESSAGE,
  );
  assert.equal(
    resolveTerminalComposerContinueText("Please inspect the error."),
    "Please inspect the error.",
  );
});

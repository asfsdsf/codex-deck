/**
 * Mirrors Codex TUI submission while a task runs: Enter steers the running
 * turn (`turn/steer`), Tab queues a follow-up for after it, and
 * interrupt-and-send is a separate explicit action.
 */
export type ComposerSendIntent = "default" | "queue";

export type ComposerSendRoute = "start" | "steer" | "queue";

export function resolveComposerSendRoute(input: {
  turnActive: boolean;
  hasQueuedBacklog: boolean;
  intent: ComposerSendIntent;
}): ComposerSendRoute {
  if (input.turnActive) {
    return input.intent === "queue" ? "queue" : "steer";
  }
  // Idle: a queued backlog that is still draining keeps submission order.
  return input.hasQueuedBacklog ? "queue" : "start";
}

/**
 * Review and compact turns reject `turn/steer`; Codex TUI keeps those
 * messages and submits them when the turn ends.
 */
export function isNonSteerableTurnError(message: string): boolean {
  return /^cannot steer a (review|compact) turn$/.test(message.trim());
}

export const RUNNING_TURN_STEER_LABEL = "Steer";
export const RUNNING_TURN_QUEUE_LABEL = "Queue";
export const RUNNING_TURN_INTERRUPT_LABEL = "Interrupt & send";

export function runningTurnComposerHint(input: {
  canQueue: boolean;
  touch: boolean;
}): string {
  if (input.touch) {
    return input.canQueue
      ? "Steer adds this to the running turn · Queue sends it after the turn"
      : "Steer adds this to the running turn";
  }
  return input.canQueue
    ? "Enter to steer the running turn · Tab to queue for after it"
    : "Enter to steer the running turn";
}

/** Caption for a message steered into a running turn, as Codex TUI shows. */
export const STEERED_MESSAGE_CAPTION =
  "Steering — submitted after the next tool call";

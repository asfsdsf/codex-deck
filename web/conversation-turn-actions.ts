import type { ConversationMessage } from "@codex-deck/api";

/** Per-message history operations bound to the message's persisted turn. */
export type ConversationTurnAction = "fork-through" | "fork-before";

/**
 * `prompt` is the opening user message of a turn, `steer` a later user message
 * in the same turn, and `response` an assistant message of the turn.
 */
export type MessageTurnRole = "prompt" | "steer" | "response";

/** `turn` means this message's own turn is still in progress. */
export type MessageTurnBusyState = "idle" | "thread" | "turn";

export interface ConversationTurnActionItem {
  action: ConversationTurnAction;
  label: string;
  description: string;
  disabledReason: string | null;
}

const CONTEXTUAL_USER_PREFIXES = [
  "<environment_context>",
  "<user_instructions>",
  "<turn_aborted>",
  "# AGENTS.md instructions",
];

function messageText(message: ConversationMessage): string {
  const content = message.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("");
}

function isContextualUserMessage(message: ConversationMessage): boolean {
  const text = messageText(message).trimStart();
  return CONTEXTUAL_USER_PREFIXES.some((prefix) => text.startsWith(prefix));
}

export function messageTurnId(message: ConversationMessage): string | null {
  const turnId = message.turnId?.trim();
  return turnId ? turnId : null;
}

/**
 * Maps each turn to its opening prompt. Only that prompt can be rewound
 * independently: app-server reverts whole turns, so a mid-turn steer cannot
 * be reopened on its own (upstream `backtrack_revert_before_turn_id`).
 */
export function collectTurnPrompts(
  messages: readonly ConversationMessage[],
  excluded: ConversationMessage | null = null,
): Map<string, ConversationMessage> {
  const prompts = new Map<string, ConversationMessage>();
  const seenUserTurns = new Set<string>();
  for (const message of messages) {
    if (message.type !== "user" || message === excluded) continue;
    const turnId = messageTurnId(message);
    if (!turnId || seenUserTurns.has(turnId)) continue;
    if (isContextualUserMessage(message)) continue;
    seenUserTurns.add(turnId);
    prompts.set(turnId, message);
  }
  return prompts;
}

/** The latest turn is the one in progress while the thread is running. */
export function latestTurnId(
  messages: readonly ConversationMessage[],
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const turnId = messageTurnId(messages[index]);
    if (turnId) return turnId;
  }
  return null;
}

/** Legacy histories without turn IDs return null: no boundary is offered. */
export function getMessageTurnRole(
  message: ConversationMessage,
  prompts: ReadonlyMap<string, ConversationMessage>,
): MessageTurnRole | null {
  const turnId = messageTurnId(message);
  if (!turnId) return null;
  if (message.type === "user") {
    if (isContextualUserMessage(message)) return null;
    return prompts.get(turnId) === message ? "prompt" : "steer";
  }
  return message.type === "assistant" ? "response" : null;
}

export function getTurnActionItems(
  role: MessageTurnRole,
  busy: MessageTurnBusyState,
): ConversationTurnActionItem[] {
  const items: ConversationTurnActionItem[] = [
    {
      action: "fork-through",
      label: "Fork from here",
      description: "New conversation that includes this turn",
      disabledReason: busy === "turn" ? "This turn is still running." : null,
    },
  ];
  if (role !== "prompt") return items;
  items.push({
    action: "fork-before",
    label: "Fork before this turn",
    description: "New conversation without this turn or later ones",
    disabledReason: null,
  });
  return items;
}

/** Text restored to the composer when no server prompt is returned. */
export function getTurnPromptText(message: ConversationMessage): string {
  return messageText(message).trim();
}

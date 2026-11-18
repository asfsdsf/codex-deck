import type { ConversationMessage } from "./storage";

type AnswerAnnotation = {
  kind: "wellbeingHelpline";
  subject: "prompt" | "answer";
};

export type AgentMessageDisplay =
  | {
      version: 1;
      mode: "show";
      trustedContacts: "check" | "skip";
      annotation?: AnswerAnnotation;
    }
  | {
      version: 1;
      mode: "hide";
      replacement: { kind: "wellbeingPromptHelpline" };
    }
  | {
      version: 1;
      mode: "block";
      reason:
        | { kind: "protection"; protectionType: string }
        | { kind: "cyber"; trustedAccess?: boolean };
    }
  | { mode: "unknown"; version: number | null };

export interface AgentMessageModeration {
  moderated: boolean;
  display: AgentMessageDisplay | null;
}

export interface ConversationItemMetadata {
  moderation?: AgentMessageModeration;
  startedAtMs?: number;
  completedAtMs?: number;
  contentTokenCount?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function integer(value: unknown, minimum: number): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum
    ? value
    : undefined;
}

function parseDisplay(value: unknown): AgentMessageDisplay {
  const display = record(value);
  const version = integer(display?.version, 0) ?? null;
  if (display && version === 1) {
    switch (display.mode) {
      case "show": {
        const { trustedContacts } = display;
        if (trustedContacts !== "check" && trustedContacts !== "skip") break;
        const annotation = record(display.annotation);
        if (
          display.annotation != null &&
          (annotation?.kind !== "wellbeingHelpline" ||
            (annotation.subject !== "prompt" &&
              annotation.subject !== "answer"))
        )
          break;
        return {
          version,
          mode: "show",
          trustedContacts,
          ...(annotation
            ? {
                annotation: {
                  kind: "wellbeingHelpline",
                  subject: annotation.subject as "prompt" | "answer",
                },
              }
            : {}),
        };
      }
      case "hide":
        if (record(display.replacement)?.kind === "wellbeingPromptHelpline")
          return {
            version,
            mode: "hide",
            replacement: { kind: "wellbeingPromptHelpline" },
          };
        break;
      case "block": {
        const reason = record(display.reason);
        if (
          reason?.kind === "protection" &&
          typeof reason.protectionType === "string"
        )
          return {
            version,
            mode: "block",
            reason: {
              kind: "protection",
              protectionType: reason.protectionType,
            },
          };
        if (reason?.kind === "cyber")
          return {
            version,
            mode: "block",
            reason: {
              kind: "cyber",
              ...(typeof reason.trustedAccess === "boolean"
                ? { trustedAccess: reason.trustedAccess }
                : {}),
            },
          };
      }
    }
  }
  return { mode: "unknown", version };
}

export function readConversationItemMetadata(
  envelope: Record<string, unknown>,
  item: Record<string, unknown> = envelope,
): ConversationItemMetadata {
  const startedAtMs = integer(
    item.startedAtMs ??
      item.started_at_ms ??
      envelope.startedAtMs ??
      envelope.started_at_ms,
    1,
  );
  const completedAtMs = integer(
    item.completedAtMs ??
      item.completed_at_ms ??
      envelope.completedAtMs ??
      envelope.completed_at_ms,
    1,
  );
  const contentTokenCount = integer(
    envelope.contentTokenCount ??
      envelope.content_token_count ??
      item.contentTokenCount ??
      item.content_token_count,
    0,
  );
  const metadata: ConversationItemMetadata = {
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
    ...(completedAtMs !== undefined ? { completedAtMs } : {}),
    ...(contentTokenCount !== undefined ? { contentTokenCount } : {}),
  };
  if (item.moderation != null) {
    const moderation = record(item.moderation);
    const display =
      moderation?.display == null ? null : parseDisplay(moderation.display);
    metadata.moderation = {
      moderated: moderation?.moderated !== false || display?.mode === "unknown",
      display,
    };
  }
  return metadata;
}

export function getAnswerRestriction(
  moderation: AgentMessageModeration | undefined,
): string | null {
  const mode = moderation?.display?.mode;
  if (mode === "show" && moderation?.display?.version === 1) return null;
  if (mode === "hide") return "Codex hid this answer.";
  if (mode === "block") return "Codex blocked this answer.";
  if (moderation?.display || moderation?.moderated)
    return "This answer has restricted display instructions.";
  return null;
}

/** Carry authoritative metadata through content updates and redact before returning messages. */
export function withConversationItemMetadata(
  message: ConversationMessage,
  metadata: ConversationItemMetadata,
): ConversationMessage {
  const moderation = getAnswerRestriction(message.moderation)
    ? message.moderation
    : (metadata.moderation ?? message.moderation);
  const updated = {
    ...message,
    ...(metadata.startedAtMs !== undefined
      ? { startedAtMs: metadata.startedAtMs }
      : {}),
    ...(metadata.completedAtMs !== undefined
      ? { completedAtMs: metadata.completedAtMs }
      : {}),
    ...(metadata.contentTokenCount !== undefined
      ? { contentTokenCount: metadata.contentTokenCount }
      : {}),
    ...(moderation ? { moderation } : {}),
  };
  if (!getAnswerRestriction(moderation)) return updated;
  return {
    ...updated,
    message: updated.message ? { ...updated.message, content: [] } : undefined,
    summary: undefined,
    editable: false,
    editId: undefined,
    editText: undefined,
    streaming: false,
  };
}

export function retainConversationItemMetadata(
  previous: ConversationMessage,
  next: ConversationMessage,
): ConversationMessage {
  return withConversationItemMetadata(next, {
    startedAtMs: next.startedAtMs ?? previous.startedAtMs,
    completedAtMs: next.completedAtMs ?? previous.completedAtMs,
    contentTokenCount: next.contentTokenCount ?? previous.contentTokenCount,
    moderation: getAnswerRestriction(previous.moderation)
      ? previous.moderation
      : (next.moderation ?? previous.moderation),
  });
}

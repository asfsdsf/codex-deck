export interface TerminalTimelineAnchor {
  offset: number;
  order: number;
}

export type TerminalTimelineEntry =
  | {
      type: "output";
      key: string;
      text: string;
    }
  | {
      type: "card";
      key: string;
      messageKey: string;
    };

export function getTerminalInlineAnchorOffset(output: string): number {
  const lastLineFeed = output.lastIndexOf("\n");
  const lastCarriageReturn = output.lastIndexOf("\r");
  const anchorIndex = Math.max(lastLineFeed, lastCarriageReturn);
  return anchorIndex >= 0 ? anchorIndex + 1 : 0;
}

const ANSI_OSC_SEQUENCE_PATTERN = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const ANSI_CSI_SEQUENCE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_SINGLE_CHAR_SEQUENCE_PATTERN = /\u001b[@-_]/g;
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const AI_TERMINAL_HELPER_ASSIGNMENT_PATTERN =
  /^\s*__CODEX_DECK_AI_(?:EXIT_CODE|CWD)\s*=.*$/gm;
const AI_TERMINAL_RESULT_LINE_PATTERN =
  /^\s*__CODEX_DECK_AI_RESULT__\b.*$/gm;

function applyBackspaceCorrections(value: string): string {
  let next = value;
  let previous: string | null = null;
  while (next !== previous) {
    previous = next;
    next = next.replace(/[^\n]\u0008/g, "");
  }
  return next.replace(/\u0008/g, "");
}

export function sanitizeTerminalTranscriptChunk(text: string): string {
  if (!text) {
    return "";
  }

  return applyBackspaceCorrections(text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"))
    .replace(ANSI_OSC_SEQUENCE_PATTERN, "")
    .replace(ANSI_CSI_SEQUENCE_PATTERN, "")
    .replace(ANSI_SINGLE_CHAR_SEQUENCE_PATTERN, "")
    .replace(CONTROL_CHAR_PATTERN, "")
    .replace(AI_TERMINAL_HELPER_ASSIGNMENT_PATTERN, "")
    .replace(AI_TERMINAL_RESULT_LINE_PATTERN, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
}

export function buildTerminalTimeline(input: {
  output: string;
  messageKeys: string[];
  anchors: Record<string, TerminalTimelineAnchor | undefined>;
}): {
  entries: TerminalTimelineEntry[];
  liveOutput: string;
} {
  const anchoredCards = input.messageKeys
    .map((messageKey) => {
      const anchor = input.anchors[messageKey];
      if (!anchor) {
        return null;
      }
      return {
        messageKey,
        offset: Math.max(0, Math.min(input.output.length, anchor.offset)),
        order: anchor.order,
      };
    })
    .filter((value): value is { messageKey: string; offset: number; order: number } =>
      value !== null,
    )
    .sort((left, right) => {
      if (left.offset !== right.offset) {
        return left.offset - right.offset;
      }
      return left.order - right.order;
    });

  const entries: TerminalTimelineEntry[] = [];
  let cursor = 0;

  for (const card of anchoredCards) {
    if (card.offset > cursor) {
      entries.push({
        type: "output",
        key: `output:${cursor}:${card.offset}`,
        text: input.output.slice(cursor, card.offset),
      });
    }
    entries.push({
      type: "card",
      key: `card:${card.messageKey}`,
      messageKey: card.messageKey,
    });
    cursor = card.offset;
  }

  return {
    entries,
    liveOutput: input.output.slice(cursor),
  };
}

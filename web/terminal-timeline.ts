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

export function getTerminalTranscriptStartOffset(input: {
  messageKeys: string[];
  anchors: Record<string, TerminalTimelineAnchor | undefined>;
  messageKey: string;
}): number {
  const targetIndex = input.messageKeys.indexOf(input.messageKey);
  if (targetIndex <= 0) {
    return 0;
  }

  for (let index = targetIndex - 1; index >= 0; index -= 1) {
    const previousMessageKey = input.messageKeys[index];
    const previousAnchor = input.anchors[previousMessageKey];
    if (previousAnchor) {
      return Math.max(0, previousAnchor.offset);
    }
  }

  return 0;
}

export function normalizeFrozenTerminalOutputsInOrder(
  outputs: string[],
): string[] {
  const normalized = [...outputs];

  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index];
    if (!current) {
      continue;
    }

    for (
      let nextIndex = index + 1;
      nextIndex < normalized.length;
      nextIndex += 1
    ) {
      const next = normalized[nextIndex];
      const nextNeedle = next?.trim();
      if (!next || !nextNeedle) {
        continue;
      }

      const exactIndex = current.indexOf(next);
      const trimmedIndex =
        exactIndex > 0 ? exactIndex : current.indexOf(nextNeedle);
      if (trimmedIndex > 0) {
        normalized[index] = current.slice(0, trimmedIndex).replace(/\s+$/u, "");
        break;
      }
    }
  }

  return normalized;
}

const ANSI_OSC_SEQUENCE_PATTERN =
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const ANSI_CSI_SEQUENCE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_SINGLE_CHAR_SEQUENCE_PATTERN = /\u001b[@-_]/g;
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const AI_TERMINAL_HELPER_ASSIGNMENT_PATTERN =
  /^\s*__CODEX_DECK_AI_(?:EXIT_CODE|CWD)\s*=.*$/gm;
const AI_TERMINAL_RESULT_LINE_PATTERN = /^\s*__CODEX_DECK_AI_RESULT__\b.*$/gm;
const TRANSIENT_PROMPT_ARTIFACT_LINE_PATTERN = /^[%=><]$/;
const TRANSIENT_PROMPT_SUFFIX_ARTIFACT_LINE_PATTERN = /[#$%>»]\s*[%=><]\s*$/;

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

  const sanitized = applyBackspaceCorrections(
    text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
  )
    .replace(ANSI_OSC_SEQUENCE_PATTERN, "")
    .replace(ANSI_CSI_SEQUENCE_PATTERN, "")
    .replace(ANSI_SINGLE_CHAR_SEQUENCE_PATTERN, "")
    .replace(CONTROL_CHAR_PATTERN, "")
    .replace(AI_TERMINAL_HELPER_ASSIGNMENT_PATTERN, "")
    .replace(AI_TERMINAL_RESULT_LINE_PATTERN, "")
    .replace(/[ \t]+$/gm, "");

  return sanitized
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return (
        !TRANSIENT_PROMPT_ARTIFACT_LINE_PATTERN.test(trimmed) &&
        !TRANSIENT_PROMPT_SUFFIX_ARTIFACT_LINE_PATTERN.test(trimmed)
      );
    })
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n{3,}/g, "\n\n");
}

export function buildTerminalTimeline(input: {
  output: string;
  messageKeys: string[];
  anchors: Record<string, TerminalTimelineAnchor | undefined>;
  frozenOutputByMessageKey?: Record<string, string | undefined>;
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
    .filter(
      (value): value is { messageKey: string; offset: number; order: number } =>
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
  const offsetsWithFrozenOutput = new Set(
    anchoredCards
      .filter((card) => input.frozenOutputByMessageKey?.[card.messageKey])
      .map((card) => card.offset),
  );

  for (const card of anchoredCards) {
    const rawSlice =
      card.offset > cursor ? input.output.slice(cursor, card.offset) : "";
    const frozenText =
      input.frozenOutputByMessageKey?.[card.messageKey] ?? undefined;
    const outputText =
      frozenText ?? (offsetsWithFrozenOutput.has(card.offset) ? "" : rawSlice);

    if (outputText.length > 0) {
      entries.push({
        type: "output",
        key: frozenText
          ? `output:frozen:${card.messageKey}`
          : `output:${cursor}:${card.offset}`,
        text: outputText,
      });
    }
    entries.push({
      type: "card",
      key: `card:${card.messageKey}`,
      messageKey: card.messageKey,
    });
    cursor = Math.max(cursor, card.offset);
  }

  return {
    entries,
    liveOutput: input.output.slice(cursor),
  };
}

import type {
  TerminalSessionBlockRecordWithSnapshot,
  TerminalTimelineEntry,
} from "./storage";

const ANSI_OSC_SEQUENCE_PATTERN =
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const ANSI_CSI_SEQUENCE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_SINGLE_CHAR_SEQUENCE_PATTERN = /\u001b[@-_]/g;
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const TRANSIENT_PROMPT_ARTIFACT_LINE_PATTERN = /^[%=><]$/;
const TRANSIENT_PROMPT_SUFFIX_ARTIFACT_LINE_PATTERN = /[#$%>»]\s*[%=><]\s*$/;

function applyBackspaceCorrections(value: string): string {
  const lines = [""];
  let lineIndex = 0;
  let column = 0;

  const ensureLine = () => {
    if (!lines[lineIndex]) {
      lines[lineIndex] = "";
    }
  };

  for (const char of value) {
    if (char === "\n") {
      lineIndex += 1;
      column = 0;
      ensureLine();
      continue;
    }

    if (char === "\r") {
      column = 0;
      continue;
    }

    if (char === "\u0008") {
      if (column > 0) {
        const current = lines[lineIndex] ?? "";
        const removeAt = column - 1;
        lines[lineIndex] =
          `${current.slice(0, removeAt)}${current.slice(column)}`;
        column -= 1;
      }
      continue;
    }

    const current = lines[lineIndex] ?? "";
    if (column >= current.length) {
      const padding =
        column > current.length ? " ".repeat(column - current.length) : "";
      lines[lineIndex] = `${current}${padding}${char}`;
    } else {
      lines[lineIndex] =
        `${current.slice(0, column)}${char}${current.slice(column + 1)}`;
    }
    column += 1;
  }

  return lines.join("\n");
}

export function sanitizeTerminalTranscriptChunk(text: string): string {
  if (!text) {
    return "";
  }

  const sanitized = applyBackspaceCorrections(
    text
      .replace(/\r\n/g, "\n")
      .replace(ANSI_OSC_SEQUENCE_PATTERN, "")
      .replace(ANSI_CSI_SEQUENCE_PATTERN, "")
      .replace(ANSI_SINGLE_CHAR_SEQUENCE_PATTERN, ""),
  )
    .replace(CONTROL_CHAR_PATTERN, "")
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

export function buildTerminalTimelineEntries(input: {
  messageKeys: string[];
  blocks: TerminalSessionBlockRecordWithSnapshot[];
}): TerminalTimelineEntry[] {
  const entries: TerminalTimelineEntry[] = [];
  const blocksByMessageKey = new Map<string, TerminalSessionBlockRecordWithSnapshot[]>();
  const standaloneBlocks: TerminalSessionBlockRecordWithSnapshot[] = [];

  for (const block of [...input.blocks].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    return left.blockId.localeCompare(right.blockId);
  })) {
    if (!block.snapshot) {
      continue;
    }
    if (block.messageKey) {
      const group = blocksByMessageKey.get(block.messageKey) ?? [];
      group.push(block);
      blocksByMessageKey.set(block.messageKey, group);
    } else {
      standaloneBlocks.push(block);
    }
  }

  for (const messageKey of input.messageKeys) {
    const blocks = blocksByMessageKey.get(messageKey) ?? [];
    for (const block of blocks) {
      if (!block.snapshot) {
        continue;
      }
      entries.push({
        type: "snapshot",
        key: `block:${block.blockId}`,
        blockId: block.blockId,
        snapshot: block.snapshot,
      });
    }
    entries.push({
      type: "card",
      key: `card:${messageKey}`,
      messageKey,
    });
  }

  for (const block of standaloneBlocks) {
    if (!block.snapshot) {
      continue;
    }
    entries.push({
      type: "snapshot",
      key: `block:${block.blockId}`,
      blockId: block.blockId,
      snapshot: block.snapshot,
    });
  }

  return entries;
}

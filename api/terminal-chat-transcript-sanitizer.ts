import xtermHeadless from "@xterm/headless";
import {
  normalizeSanitizedTerminalLines,
  sanitizeTerminalTranscriptChunk,
} from "./terminal-transcript";

const { Terminal: HeadlessTerminal } = xtermHeadless as {
  Terminal: new (options: {
    allowProposedApi: boolean;
    cols: number;
    rows: number;
    scrollback: number;
  }) => {
    write: (data: string, callback?: () => void) => void;
    buffer: {
      active: {
        baseY: number;
        cursorY: number;
        getLine: (index: number) => {
          translateToString: (trimRight?: boolean) => string;
        } | undefined;
      };
    };
  };
};

const MIN_TERMINAL_COLS = 80;
const MAX_TERMINAL_COLS = 4096;
const MIN_TERMINAL_ROWS = 24;
const MAX_TERMINAL_ROWS = 4096;
const TERMINAL_SCROLLBACK = 50_000;

function clampTerminalSize(
  value: number | null | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.floor(value)));
}

function resolveTerminalCols(
  text: string,
  preferredCols: number | null | undefined,
): number {
  const widestLine = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .reduce((widest, line) => Math.max(widest, line.length), 0);
  const inferredCols = clampTerminalSize(
    widestLine + 1,
    MIN_TERMINAL_COLS,
    MAX_TERMINAL_COLS,
    MIN_TERMINAL_COLS,
  );
  const normalizedPreferred = clampTerminalSize(
    preferredCols,
    MIN_TERMINAL_COLS,
    MAX_TERMINAL_COLS,
    inferredCols,
  );
  return Math.max(inferredCols, normalizedPreferred);
}

function resolveTerminalRows(
  text: string,
  preferredRows: number | null | undefined,
): number {
  const lineCount = text.replace(/\r\n/g, "\n").split("\n").length;
  const inferredRows = clampTerminalSize(
    lineCount + 1,
    MIN_TERMINAL_ROWS,
    MAX_TERMINAL_ROWS,
    MIN_TERMINAL_ROWS,
  );
  return clampTerminalSize(
    preferredRows,
    MIN_TERMINAL_ROWS,
    MAX_TERMINAL_ROWS,
    inferredRows,
  );
}

export async function sanitizeTerminalChatTranscript(
  text: string,
  options?: {
    cols?: number | null;
    rows?: number | null;
  },
): Promise<string> {
  if (!text) {
    return "";
  }

  try {
    const cols = resolveTerminalCols(text, options?.cols);
    const rows = resolveTerminalRows(text, options?.rows);
    const terminal = new HeadlessTerminal({
      allowProposedApi: true,
      cols,
      rows,
      scrollback: TERMINAL_SCROLLBACK,
    });

    await new Promise<void>((resolve) => {
      terminal.write(text.replace(/\r?\n/g, "\r\n"), () => resolve());
    });

    const activeBuffer = terminal.buffer.active;
    const lineCount = Math.max(1, activeBuffer.baseY + activeBuffer.cursorY + 1);
    const lines: string[] = [];
    for (let index = 0; index < lineCount; index += 1) {
      const line = activeBuffer.getLine(index)?.translateToString(true) ?? "";
      lines.push(line.replace(/[ \t]+$/g, ""));
    }
    return normalizeSanitizedTerminalLines(lines);
  } catch {
    return sanitizeTerminalTranscriptChunk(text);
  }
}

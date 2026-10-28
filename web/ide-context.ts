// Browser side of Codex CLI `/ide` (codex-rs/tui/src/chatwidget/ide_context.rs).
import type {
  CodexIdeContextStatus,
  CodexIdeContextSummary,
} from "@codex-deck/api";

export type IdeCommandAction = "toggle" | "on" | "off" | "status";

export const IDE_COMMAND_USAGE = "Usage: /ide [on|off|status]";
export const IDE_CONTEXT_OFF_MESSAGE = "IDE context is off.";
export const IDE_CONTEXT_SKIPPED_MESSAGE =
  "IDE context was skipped for this message.";

export function parseIdeCommandArgs(args: string): IdeCommandAction | null {
  switch (args.trim().toLowerCase()) {
    case "":
      return "toggle";
    case "on":
      return "on";
    case "off":
      return "off";
    case "status":
      return "status";
    default:
      return null;
  }
}

/**
 * Result of enabling or checking `/ide`: upstream disables IDE context when
 * the IDE cannot be reached while turning it on.
 */
export function describeIdeContextStatus(status: CodexIdeContextStatus): {
  enabled: boolean;
  message: string;
} {
  if (!status.available) {
    return {
      enabled: false,
      message: `IDE context could not be enabled. ${status.hint}`,
    };
  }
  return {
    enabled: true,
    message: status.summary.hasPromptContext
      ? "IDE context is on. Future messages will include your current IDE selection and open tabs."
      : "IDE context is on. Connected to your IDE.",
  };
}

function pathTail(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** One-line description of what the next message will include. */
export function formatIdeContextSummary(
  summary: CodexIdeContextSummary | null,
): string {
  if (!summary) return "Connected to your IDE.";
  const parts: string[] = [];
  if (summary.activeFile) {
    parts.push(summary.activeFile.label || pathTail(summary.activeFile.path));
  }
  if (summary.selections.length === 1) {
    const range = summary.selections[0];
    parts.push(
      range.startLine === range.endLine
        ? `line ${range.startLine} selected`
        : `lines ${range.startLine}–${range.endLine} selected`,
    );
  } else if (summary.selections.length > 1) {
    parts.push(`${summary.selections.length} selections`);
  }
  if (summary.openTabCount > 0) {
    parts.push(
      `${summary.openTabCount} open tab${summary.openTabCount === 1 ? "" : "s"}`,
    );
  }
  return parts.length > 0 ? parts.join(" · ") : "No file or selection in IDE.";
}

const IDE_CONTEXT_PREFIX = "# Context from my IDE setup:\n";
const PROMPT_REQUEST_BEGIN = "## My request for Codex:";

/**
 * Like upstream `extract_prompt_request_with_offset`, transcripts show only the
 * request after the last delimiter. Limited to IDE-context messages so other
 * text that merely mentions the delimiter is untouched.
 */
export function stripIdeContextPrefix(text: string): string {
  if (!text.trimStart().startsWith(IDE_CONTEXT_PREFIX)) return text;
  const index = text.lastIndexOf(PROMPT_REQUEST_BEGIN);
  if (index < 0) return text;
  return text.slice(index + PROMPT_REQUEST_BEGIN.length).trim();
}

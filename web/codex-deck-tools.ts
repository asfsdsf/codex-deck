// Display helpers for codex-deck's dynamic task tools ("codex_deck.*" tool
// calls in a conversation). The backend host lives in api/codex-dynamic-tools.ts.
import { parseCodexDeckToolName } from "../api/codex-dynamic-tool-names";

export { parseCodexDeckToolName };

const TOOL_LABELS: Record<string, string> = {
  list_threads: "List tasks",
  list_archived_threads: "List archived tasks",
  read_thread: "Read task",
  wait_threads: "Wait for tasks",
  set_thread_title: "Rename task",
  set_thread_archived: "Archive task",
  create_thread: "Create task",
  send_message_to_thread: "Message task",
  fork_thread: "Fork task",
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

export function shortThreadId(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return text.length > 13 ? `${text.slice(0, 8)}…` : text;
}

/** Human label for a Deck task tool, e.g. "Read task"; null for other tools. */
export function getCodexDeckToolLabel(
  name: string | null | undefined,
  input?: JsonRecord,
): string | null {
  const tool = parseCodexDeckToolName(name);
  if (!tool) {
    return null;
  }
  if (tool === "set_thread_archived" && input?.archived === false) {
    return "Restore task";
  }
  return TOOL_LABELS[tool] ?? tool;
}

export function getCodexDeckToolPreview(
  name: string | null | undefined,
  input: JsonRecord | undefined,
): string | null {
  const tool = parseCodexDeckToolName(name);
  if (!tool || !input) {
    return null;
  }
  switch (tool) {
    case "list_threads":
    case "list_archived_threads":
      return typeof input.limit === "number" ? `limit ${input.limit}` : null;
    case "read_thread": {
      const id = shortThreadId(input.threadId);
      const turns =
        typeof input.turnLimit === "number"
          ? ` · ${input.turnLimit} turns`
          : "";
      return id ? `${id}${turns}` : null;
    }
    case "wait_threads": {
      const count = Array.isArray(input.targets) ? input.targets.length : 0;
      const timeout =
        typeof input.timeoutMs === "number"
          ? input.timeoutMs === 0
            ? " · snapshot"
            : ` · ${Math.round(input.timeoutMs / 1000)}s`
          : "";
      return `${count} task${count === 1 ? "" : "s"}${timeout}`;
    }
    case "set_thread_title":
      return typeof input.title === "string" ? `"${input.title}"` : null;
    case "set_thread_archived":
      return typeof input.threadId === "string"
        ? shortThreadId(input.threadId)
        : "this task";
    default:
      return null;
  }
}

export interface CodexDeckToolOutput {
  /** Parsed JSON result for successful calls, otherwise null. */
  value: JsonRecord | null;
  /** Raw text of the output (the failure message for failed calls). */
  text: string;
}

/**
 * Tool outputs arrive either as the JSON text itself or as Responses content
 * items (`[{ type: "input_text", text }]`). Successful Deck tools always
 * return a JSON object; failures return plain text.
 */
export function parseCodexDeckToolOutput(content: string): CodexDeckToolOutput {
  let text = content;
  const outer = tryParseJson(content);
  if (Array.isArray(outer)) {
    const texts = outer
      .filter(
        (item): item is JsonRecord =>
          isRecord(item) &&
          (item.type === "input_text" || item.type === "inputText") &&
          typeof item.text === "string",
      )
      .map((item) => item.text as string);
    if (texts.length > 0) {
      text = texts.join("\n");
    }
  } else if (isRecord(outer)) {
    return { value: outer, text };
  }
  const inner = tryParseJson(text);
  return { value: isRecord(inner) ? inner : null, text };
}

export function isCodexDeckToolFailureOutput(
  name: string | null | undefined,
  content: string,
): boolean {
  if (!parseCodexDeckToolName(name) || !content.trim()) {
    return false;
  }
  return parseCodexDeckToolOutput(content).value === null;
}

export function formatCodexDeckStatus(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value) && typeof value.type === "string") {
    const flags = Array.isArray(value.activeFlags)
      ? value.activeFlags.filter((flag) => typeof flag === "string")
      : [];
    return flags.length > 0
      ? `${value.type} (${flags.join(", ")})`
      : value.type;
  }
  return null;
}

function firstLine(text: string, max = 120): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function getCodexDeckToolResultPreview(
  name: string | null | undefined,
  content: string,
): string | null {
  const tool = parseCodexDeckToolName(name);
  if (!tool) {
    return null;
  }
  const { value, text } = parseCodexDeckToolOutput(content);
  if (!value) {
    return text.trim() ? firstLine(text) : null;
  }
  switch (tool) {
    case "list_threads":
    case "list_archived_threads": {
      const count = Array.isArray(value.threads) ? value.threads.length : 0;
      const more = typeof value.nextCursor === "string" ? " · more" : "";
      return `${count} task${count === 1 ? "" : "s"}${more}`;
    }
    case "read_thread": {
      const thread = isRecord(value.thread) ? value.thread : {};
      const title =
        typeof thread.title === "string" && thread.title
          ? thread.title
          : typeof thread.preview === "string"
            ? thread.preview
            : shortThreadId(thread.id);
      const status = formatCodexDeckStatus(thread.status);
      return [firstLine(title, 80), status].filter(Boolean).join(" · ") || null;
    }
    case "wait_threads": {
      const wake = isRecord(value.wake) ? value.wake : null;
      if (wake) {
        return `${String(wake.reason ?? "woke")} · ${shortThreadId(wake.threadId)}`;
      }
      return value.timedOut === true ? "timed out" : "no change";
    }
    case "set_thread_title":
      return typeof value.title === "string" ? `"${value.title}"` : null;
    case "set_thread_archived":
      return value.archived === true ? "archived" : "restored";
    default:
      return null;
  }
}

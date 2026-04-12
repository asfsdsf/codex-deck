import type { ContentBlock } from "@codex-deck/api";
import { sanitizeText } from "./utils";

const DEFAULT_EXPANDED_TOOL_USE_NAMES = new Set([
  "exec_command",
  "bash",
  "write_stdin",
  "request_user_input",
  "update_plan",
]);

export function shouldDefaultExpandToolUse(
  toolName: string | null | undefined,
): boolean {
  return DEFAULT_EXPANDED_TOOL_USE_NAMES.has((toolName || "").toLowerCase());
}

function stringifyJson(value: unknown): string {
  try {
    return sanitizeText(JSON.stringify(value, null, 2) ?? "null");
  } catch {
    return sanitizeText(String(value));
  }
}

function summarizeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "string") {
    const trimmed = sanitizeText(value);
    if (!trimmed.trim()) {
      return "(empty)";
    }
    return trimmed.length > 140 ? `${trimmed.slice(0, 140)}...` : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `${value.length} item(s)`;
  }
  if (value && typeof value === "object") {
    return `${Object.keys(value).length} field(s)`;
  }
  return String(value);
}

function getTodoSearchText(input: Record<string, unknown>): string {
  const todos = Array.isArray(input.plan)
    ? input.plan
    : Array.isArray(input.todos)
      ? input.todos
      : [];

  return todos
    .map((todo) => {
      if (!todo || typeof todo !== "object") {
        return "";
      }

      const record = todo as Record<string, unknown>;
      const step =
        typeof record.step === "string"
          ? sanitizeText(record.step)
          : typeof record.content === "string"
            ? sanitizeText(record.content)
            : "";
      const status =
        typeof record.status === "string" ? sanitizeText(record.status) : "";
      return [status, step].filter((part) => part.length > 0).join(" ");
    })
    .filter((line) => line.length > 0)
    .join("\n");
}

function getQuestionSearchText(input: Record<string, unknown>): string {
  if (!Array.isArray(input.questions)) {
    return "";
  }

  return input.questions
    .map((question) => {
      if (!question || typeof question !== "object") {
        return "";
      }

      const record = question as Record<string, unknown>;
      const header =
        typeof record.header === "string" ? sanitizeText(record.header) : "";
      const prompt =
        typeof record.question === "string"
          ? sanitizeText(record.question)
          : "";
      const options = Array.isArray(record.options)
        ? record.options
            .map((option) => {
              if (!option || typeof option !== "object") {
                return "";
              }

              const optionRecord = option as Record<string, unknown>;
              const label =
                typeof optionRecord.label === "string"
                  ? sanitizeText(optionRecord.label)
                  : "";
              const description =
                typeof optionRecord.description === "string"
                  ? sanitizeText(optionRecord.description)
                  : "";
              return [label, description]
                .filter((part) => part.length > 0)
                .join(" ");
            })
            .filter((line) => line.length > 0)
            .join("\n")
        : "";

      return [header, prompt, options]
        .filter((part) => part.length > 0)
        .join("\n");
    })
    .filter((line) => line.length > 0)
    .join("\n");
}

function getTaskSearchText(input: Record<string, unknown>): string {
  const description =
    typeof input.description === "string"
      ? sanitizeText(input.description)
      : "";
  const prompt =
    typeof input.prompt === "string"
      ? sanitizeText(input.prompt)
      : typeof input.message === "string"
        ? sanitizeText(input.message)
        : "";
  const agentType =
    typeof input.subagent_type === "string"
      ? sanitizeText(input.subagent_type)
      : typeof input.agent_type === "string"
        ? sanitizeText(input.agent_type)
        : "";
  const model =
    typeof input.model === "string" ? sanitizeText(input.model) : "";
  const resume =
    typeof input.resume === "string"
      ? sanitizeText(input.resume)
      : typeof input.id === "string"
        ? sanitizeText(input.id)
        : "";

  return [agentType, description, prompt, model, resume]
    .filter((part) => part.length > 0)
    .join("\n");
}

export function getSearchableToolUseText(block: ContentBlock): string {
  if (
    block.type !== "tool_use" ||
    !block.input ||
    typeof block.input !== "object" ||
    Array.isArray(block.input)
  ) {
    return "";
  }

  const input = block.input as Record<string, unknown>;
  const toolName = sanitizeText(block.name ?? "");
  const normalizedToolName = toolName.toLowerCase();
  const parts = toolName.length > 0 ? [toolName] : [];

  if (normalizedToolName === "apply_patch" && typeof input.raw === "string") {
    parts.push(sanitizeText(input.raw));
    return parts.join("\n");
  }

  if (
    normalizedToolName === "bash" ||
    normalizedToolName === "exec_command" ||
    normalizedToolName === "write_stdin"
  ) {
    const command =
      typeof input.command === "string"
        ? sanitizeText(input.command)
        : typeof input.cmd === "string"
          ? sanitizeText(input.cmd)
          : typeof input.chars === "string"
            ? sanitizeText(input.chars)
            : "";
    const description =
      typeof input.description === "string"
        ? sanitizeText(input.description)
        : typeof input.session_id === "number"
          ? `session ${input.session_id}`
          : "";
    return [...parts, description, command]
      .filter((part) => part.length > 0)
      .join("\n");
  }

  if (normalizedToolName === "read" && typeof input.file_path === "string") {
    return [
      ...parts,
      sanitizeText(input.file_path),
      typeof input.offset === "number" ? `from line ${input.offset}` : "",
      typeof input.limit === "number" ? `${input.limit} lines` : "",
    ]
      .filter((part) => part.length > 0)
      .join("\n");
  }

  if (normalizedToolName === "grep" && typeof input.pattern === "string") {
    return [
      ...parts,
      sanitizeText(input.pattern),
      typeof input.path === "string" ? sanitizeText(input.path) : "",
      typeof input.glob === "string" ? sanitizeText(input.glob) : "",
      typeof input.type === "string" ? sanitizeText(input.type) : "",
    ]
      .filter((part) => part.length > 0)
      .join("\n");
  }

  if (normalizedToolName === "glob" && typeof input.pattern === "string") {
    return [
      ...parts,
      sanitizeText(input.pattern),
      typeof input.path === "string" ? sanitizeText(input.path) : "",
    ]
      .filter((part) => part.length > 0)
      .join("\n");
  }

  if (normalizedToolName === "edit" && typeof input.file_path === "string") {
    return [
      ...parts,
      sanitizeText(input.file_path),
      typeof input.old_string === "string"
        ? sanitizeText(input.old_string)
        : "",
      typeof input.new_string === "string"
        ? sanitizeText(input.new_string)
        : "",
    ]
      .filter((part) => part.length > 0)
      .join("\n");
  }

  if (normalizedToolName === "write" && typeof input.file_path === "string") {
    const content =
      typeof input.content === "string"
        ? sanitizeText(input.content)
        : stringifyJson(input.content);
    const truncatedContent =
      content.length > 500 ? content.slice(0, 500) : content;
    return [...parts, sanitizeText(input.file_path), truncatedContent]
      .filter((part) => part.length > 0)
      .join("\n");
  }

  if (
    normalizedToolName === "update_plan" ||
    normalizedToolName === "todowrite"
  ) {
    return [...parts, getTodoSearchText(input)]
      .filter((part) => part.length > 0)
      .join("\n");
  }

  if (
    normalizedToolName === "request_user_input" ||
    normalizedToolName === "askuserquestion"
  ) {
    return [...parts, getQuestionSearchText(input)]
      .filter((part) => part.length > 0)
      .join("\n");
  }

  if (normalizedToolName === "task" || normalizedToolName === "spawn_agent") {
    return [...parts, getTaskSearchText(input)]
      .filter((part) => part.length > 0)
      .join("\n");
  }

  for (const [key, value] of Object.entries(input)) {
    parts.push(`${sanitizeText(key)} ${summarizeValue(value)}`.trim());
  }

  return parts.filter((part) => part.length > 0).join("\n");
}

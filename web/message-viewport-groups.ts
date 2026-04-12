import type { ContentBlock, ConversationMessage } from "@codex-deck/api";
import { shouldShowTokenLimitNotice } from "./token-limit-notices";
import { sanitizeText } from "./utils";

export type ViewportMessageGroup = "default" | "important";
export type ViewportTextTone =
  | "user"
  | "assistant"
  | "tool"
  | "plan"
  | "system";

export type CollapsedViewportSegmentKind =
  | "plain"
  | "label"
  | "detail"
  | "path"
  | "query"
  | "range"
  | "count-add"
  | "count-remove"
  | "punctuation"
  | "command"
  | "error";

export interface CollapsedViewportSegment {
  text: string;
  kind: CollapsedViewportSegmentKind;
}

export interface CollapsedViewportLine {
  text: string;
  tone: ViewportTextTone;
  segments?: CollapsedViewportSegment[];
}

export interface CollapsedViewportContext {
  projectPath?: string | null;
  toolMapByCallId?: Map<string, string>;
  toolInputMapByCallId?: Map<string, Record<string, unknown>>;
}

interface PatchSummaryRow {
  operation: "add" | "update" | "delete";
  path: string;
  movePath: string | null;
  added: number;
  removed: number;
}

const IMPORTANT_TOOL_NAMES = new Set([
  "request_user_input",
  "update_plan",
  "askuserquestion",
  "todowrite",
]);

const PROPOSED_PLAN_BLOCK_REGEX =
  /^<proposed_plan>\n([\s\S]*?)\n<\/proposed_plan>([\s\S]*)$/;
const PATCH_FILE_HEADER_REGEX = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const PATCH_MOVE_TO_HEADER_REGEX = /^\*\*\* Move to: (.+)$/;

function normalizeInlineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateInlineText(text: string, maxLength: number = 180): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function plainLine(
  tone: ViewportTextTone,
  text: string,
  segments?: CollapsedViewportSegment[],
): CollapsedViewportLine {
  return { tone, text, segments };
}

function plainSegment(
  kind: CollapsedViewportSegmentKind,
  text: string,
): CollapsedViewportSegment {
  return { kind, text };
}

function detailSegment(text: string): CollapsedViewportSegment {
  return plainSegment("detail", text);
}

function pathSegment(text: string): CollapsedViewportSegment {
  return plainSegment("path", text);
}

function querySegment(text: string): CollapsedViewportSegment {
  return plainSegment("query", text);
}

function rangeSegment(text: string): CollapsedViewportSegment {
  return plainSegment("range", text);
}

function punctuationSegment(text: string): CollapsedViewportSegment {
  return plainSegment("punctuation", text);
}

function extractNonEmptyTextBlocks(content: ContentBlock[]): string[] {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => normalizeInlineText(sanitizeText(block.text ?? "")))
    .filter((text) => text.length > 0);
}

function hasImportantToolUse(content: ContentBlock[]): boolean {
  return content.some(
    (block) =>
      block.type === "tool_use" &&
      typeof block.name === "string" &&
      IMPORTANT_TOOL_NAMES.has(block.name.toLowerCase()),
  );
}

function parsePlanSummary(text: string): string | null {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const match = normalized.match(PROPOSED_PLAN_BLOCK_REGEX);
  if (!match) {
    return null;
  }

  const planBody = match[1].trim();
  if (!planBody) {
    return null;
  }

  const firstLine = planBody
    .split("\n")
    .map((line) => normalizeInlineText(line))
    .find((line) => line.length > 0);
  return firstLine ?? "Plan proposal";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getFirstString(
  input: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") {
      const normalized = normalizeInlineText(value);
      if (normalized.length > 0) {
        return normalized;
      }
    }
  }

  return null;
}

function getToolInputHint(input: unknown): string | null {
  if (!isRecord(input)) {
    return null;
  }

  return getFirstString(input, [
    "command",
    "cmd",
    "path",
    "file_path",
    "query",
    "url",
    "message",
  ]);
}

function toDisplayPath(
  filePath: string,
  projectPath: string | null | undefined,
): string {
  const normalizedPath = filePath.trim().replace(/\\/g, "/");
  if (!normalizedPath) {
    return filePath;
  }

  const normalizedProject = projectPath?.trim().replace(/\\/g, "/") ?? "";
  if (
    normalizedProject &&
    (normalizedPath === normalizedProject ||
      normalizedPath.startsWith(`${normalizedProject}/`))
  ) {
    return normalizedPath.slice(normalizedProject.length).replace(/^\/+/, "");
  }

  return normalizedPath;
}

function stringifyCompactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseJsonValue(content: string): { parsed: boolean; value: unknown } {
  const trimmed = content.trim();
  if (!trimmed) {
    return { parsed: false, value: null };
  }

  const startsLikeJson =
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    trimmed.startsWith('"') ||
    trimmed === "null" ||
    trimmed === "true" ||
    trimmed === "false" ||
    /^-?\d/.test(trimmed);

  if (!startsLikeJson) {
    return { parsed: false, value: null };
  }

  try {
    return { parsed: true, value: JSON.parse(trimmed) };
  } catch {
    return { parsed: false, value: null };
  }
}

function getFirstNonEmptyLine(value: string): string | null {
  return (
    value
      .split("\n")
      .map((line) => normalizeInlineText(line))
      .find((line) => line.length > 0) ?? null
  );
}

function parsePatchSummaryRows(raw: string): PatchSummaryRow[] {
  const rows: PatchSummaryRow[] = [];
  let currentRow: PatchSummaryRow | null = null;

  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    const headerMatch = line.match(PATCH_FILE_HEADER_REGEX);
    if (headerMatch) {
      currentRow = {
        operation:
          headerMatch[1].toLowerCase() === "add"
            ? "add"
            : headerMatch[1].toLowerCase() === "delete"
              ? "delete"
              : "update",
        path: headerMatch[2].trim(),
        movePath: null,
        added: 0,
        removed: 0,
      };
      rows.push(currentRow);
      continue;
    }

    if (!currentRow) {
      continue;
    }

    const moveMatch = line.match(PATCH_MOVE_TO_HEADER_REGEX);
    if (moveMatch) {
      currentRow.movePath = moveMatch[1].trim();
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentRow.added += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      currentRow.removed += 1;
    }
  }

  return rows;
}

function buildPatchLine(
  row: PatchSummaryRow,
  projectPath: string | null | undefined,
): CollapsedViewportLine {
  const prefix =
    row.operation === "add"
      ? "Added"
      : row.operation === "delete"
        ? "Deleted"
        : "Edited";
  const sourcePath = toDisplayPath(row.path, projectPath);
  const path = row.movePath
    ? `${sourcePath} → ${toDisplayPath(row.movePath, projectPath)}`
    : sourcePath;
  const text = `${prefix} ${path} (+${row.added} -${row.removed})`;
  return plainLine("tool", text, [
    plainSegment("label", prefix),
    pathSegment(path),
    punctuationSegment("("),
    plainSegment("count-add", `+${row.added}`),
    plainSegment("count-remove", `-${row.removed}`),
    punctuationSegment(")"),
  ]);
}

function summarizePatch(
  raw: string,
  projectPath: string | null | undefined,
): CollapsedViewportLine | null {
  const rows = parsePatchSummaryRows(raw);
  if (rows.length === 0) {
    return null;
  }

  if (rows.length === 1) {
    return buildPatchLine(rows[0], projectPath);
  }

  const added = rows.reduce((sum, row) => sum + row.added, 0);
  const removed = rows.reduce((sum, row) => sum + row.removed, 0);
  return plainLine(
    "tool",
    `Edited ${rows.length} files (+${added} -${removed})`,
    [
      plainSegment("label", "Edited"),
      pathSegment(`${rows.length} files`),
      punctuationSegment("("),
      plainSegment("count-add", `+${added}`),
      plainSegment("count-remove", `-${removed}`),
      punctuationSegment(")"),
    ],
  );
}

function getCommandText(input: Record<string, unknown>): string | null {
  return getFirstString(input, ["command", "cmd", "chars"]);
}

function shellLikeTokenize(command: string): string[] {
  const tokens = command.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  return tokens.map((token) => {
    if (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'"))
    ) {
      return token.slice(1, -1);
    }
    return token;
  });
}

function unwrapShellCommand(command: string): string {
  const tokens = shellLikeTokenize(command.trim());
  if (
    tokens.length >= 3 &&
    (tokens[0] === "bash" || tokens[0] === "sh" || tokens[0] === "zsh") &&
    (tokens[1] === "-lc" || tokens[1] === "-c")
  ) {
    return tokens.slice(2).join(" ").trim();
  }
  return command.trim();
}

function findLikelyFilePath(command: string): string | null {
  const firstSegment = command.split("|")[0] ?? command;
  const tokens = shellLikeTokenize(firstSegment);
  const candidate = [...tokens]
    .reverse()
    .find(
      (token) =>
        token.length > 0 &&
        token !== "&&" &&
        token !== ";" &&
        !token.startsWith("-") &&
        !token.startsWith("$") &&
        (token.includes("/") || token.includes("\\") || token.includes(".")),
    );
  return candidate ?? null;
}

function parseSedPrintRange(
  script: string,
): { start: number; end: number } | null {
  const singleLine = script.match(/^(\d+)p$/);
  if (singleLine) {
    const line = Number.parseInt(singleLine[1] ?? "", 10);
    return Number.isFinite(line) ? { start: line, end: line } : null;
  }

  const range = script.match(/^(\d+),(\d+)p$/);
  if (!range) {
    return null;
  }

  const start = Number.parseInt(range[1] ?? "", 10);
  const end = Number.parseInt(range[2] ?? "", 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }

  return { start, end };
}

function summarizeFrequentCommand(
  command: string,
  projectPath: string | null | undefined,
): CollapsedViewportLine | null {
  const unwrapped = unwrapShellCommand(command);
  const tokens = shellLikeTokenize(unwrapped);
  if (tokens.length === 0) {
    return null;
  }

  if (tokens[0] === "sed" && tokens[1] === "-n" && tokens.length >= 4) {
    const lineRange = parseSedPrintRange(tokens[2] ?? "");
    const filePath = tokens[3] ?? "";
    if (lineRange && filePath) {
      const displayPath = toDisplayPath(filePath, projectPath);
      const rangeText =
        lineRange.start === lineRange.end
          ? `${lineRange.start}`
          : `${lineRange.start}-${lineRange.end}`;
      return plainLine("tool", `Read ${displayPath} :${rangeText}`, [
        plainSegment("label", "Read"),
        pathSegment(displayPath),
        rangeSegment(`:${rangeText}`),
      ]);
    }
  }

  if (tokens[0] === "cat" && tokens.length >= 2) {
    const redirectIndex = tokens.findIndex(
      (token) => token === ">" || token === ">>",
    );
    const filePath =
      redirectIndex >= 0
        ? (tokens[redirectIndex + 1] ?? "")
        : (tokens[tokens.length - 1] ?? "");
    if (filePath) {
      const displayPath = toDisplayPath(filePath, projectPath);
      if (redirectIndex >= 0) {
        const action = tokens[redirectIndex] === ">>" ? "Append" : "Write";
        return plainLine("tool", `${action} ${displayPath}`, [
          plainSegment("label", action),
          pathSegment(displayPath),
        ]);
      }

      return plainLine("tool", `Read ${displayPath}`, [
        plainSegment("label", "Read"),
        pathSegment(displayPath),
      ]);
    }
  }

  if (tokens[0] === "ls") {
    const target =
      tokens.find((token, index) => index > 0 && !token.startsWith("-")) ?? ".";
    const displayPath = toDisplayPath(target, projectPath);
    return plainLine("tool", `List ${displayPath}`, [
      plainSegment("label", "List"),
      pathSegment(displayPath),
    ]);
  }

  if (tokens[0] === "rg" && tokens.length >= 2) {
    const pattern = tokens.find(
      (token, index) => index > 0 && !token.startsWith("-"),
    );
    if (pattern) {
      const searchRoots = tokens.filter(
        (token, index) =>
          index > tokens.indexOf(pattern) &&
          token.length > 0 &&
          token !== "--" &&
          !token.startsWith("-"),
      );
      const location = searchRoots[0] ?? ".";
      const displayPath = toDisplayPath(location, projectPath);
      return plainLine("tool", `Search "${pattern}" in ${displayPath}`, [
        plainSegment("label", "Search"),
        querySegment(`"${pattern}"`),
        detailSegment("in"),
        pathSegment(displayPath),
      ]);
    }
  }

  if (tokens[0] === "git" && tokens[1] === "diff") {
    const target =
      tokens.find((token, index) => index > 1 && !token.startsWith("-")) ??
      "working tree";
    const displayTarget =
      target === "working tree" ? target : toDisplayPath(target, projectPath);
    return plainLine("tool", `Diff ${displayTarget}`, [
      plainSegment("label", "Diff"),
      target === "working tree"
        ? detailSegment(displayTarget)
        : pathSegment(displayTarget),
    ]);
  }

  return null;
}

function summarizeCommandToolUse(
  toolName: string,
  input: Record<string, unknown>,
  context: CollapsedViewportContext,
): CollapsedViewportLine | null {
  const command = getCommandText(input);
  if (toolName === "write_stdin") {
    const sessionText =
      typeof input.session_id === "number" ? `session ${input.session_id}` : "";
    if (command && sessionText) {
      return plainLine(`tool`, `Wrote to ${sessionText} · ${command}`, [
        plainSegment("label", "Wrote to"),
        detailSegment(sessionText),
        punctuationSegment("·"),
        plainSegment("command", command),
      ]);
    }
    if (sessionText) {
      return plainLine("tool", `Wrote to ${sessionText}`, [
        plainSegment("label", "Wrote to"),
        detailSegment(sessionText),
      ]);
    }
  }

  if (!command) {
    return null;
  }

  const customized = summarizeFrequentCommand(command, context.projectPath);
  if (customized) {
    return customized;
  }

  const truncated = truncateInlineText(command, 120);
  return plainLine("tool", truncated, [plainSegment("command", truncated)]);
}

function summarizeCommandToolResult(
  _toolName: string,
  _content: string,
  _isError: boolean,
): CollapsedViewportLine | null {
  return null;
}

function summarizeToolCall(
  toolName: string,
  input: Record<string, unknown>,
  context: CollapsedViewportContext,
): CollapsedViewportLine | null {
  if (IMPORTANT_TOOL_NAMES.has(toolName)) {
    return null;
  }

  if (toolName === "apply_patch" && typeof input.raw === "string") {
    return summarizePatch(input.raw, context.projectPath);
  }

  if (
    toolName === "exec_command" ||
    toolName === "bash" ||
    toolName === "write_stdin"
  ) {
    return summarizeCommandToolUse(toolName, input, context);
  }

  if (toolName === "wait" && Array.isArray(input.ids)) {
    const detail = `${input.ids.length} agent(s)`;
    return plainLine("tool", `Waiting for ${detail}`, [
      plainSegment("label", "Waiting for"),
      detailSegment(detail),
    ]);
  }

  if (toolName.includes("web_search")) {
    const query = getFirstString(input, ["query", "q", "url"]);
    return plainLine(
      "tool",
      query ? `Searching ${query}` : "Searching the web",
      [plainSegment("label", "Searching"), detailSegment(query ?? "the web")],
    );
  }

  if (toolName === "read") {
    const filePath = getFirstString(input, ["file_path", "path"]);
    const displayPath = filePath
      ? toDisplayPath(filePath, context.projectPath)
      : "file";
    return plainLine("tool", `Reading ${displayPath}`, [
      plainSegment("label", "Reading"),
      pathSegment(displayPath),
    ]);
  }

  if (toolName === "view_image") {
    const filePath = getFirstString(input, ["path"]);
    const displayPath = filePath
      ? toDisplayPath(filePath, context.projectPath)
      : "image";
    return plainLine("tool", `Viewing ${displayPath}`, [
      plainSegment("label", "Viewing"),
      pathSegment(displayPath),
    ]);
  }

  if (toolName === "spawn_agent" || toolName === "task") {
    const summary =
      getFirstString(input, ["description", "message", "prompt"]) ??
      "Task request";
    const truncated = truncateInlineText(summary, 120);
    return plainLine("tool", `Starting ${truncated}`, [
      plainSegment("label", "Starting"),
      detailSegment(truncated),
    ]);
  }

  const hint = getToolInputHint(input);
  if (hint) {
    const truncated = truncateInlineText(hint, 120);
    return plainLine("tool", `Calling ${toolName}(${truncated})`, [
      plainSegment("label", "Calling"),
      detailSegment(toolName),
      punctuationSegment("("),
      detailSegment(truncated),
      punctuationSegment(")"),
    ]);
  }

  const serialized = truncateInlineText(stringifyCompactJson(input), 120);
  return plainLine("tool", `Calling ${toolName}(${serialized})`, [
    plainSegment("label", "Calling"),
    detailSegment(toolName),
    punctuationSegment("("),
    detailSegment(serialized),
    punctuationSegment(")"),
  ]);
}

function summarizeToolResult(
  toolName: string,
  block: ContentBlock,
  context: CollapsedViewportContext,
): CollapsedViewportLine | null {
  const content =
    typeof block.content === "string"
      ? sanitizeText(block.content)
      : typeof block.content === "object"
        ? JSON.stringify(block.content, null, 2)
        : String(block.content ?? "");
  const isError = block.is_error === true;

  if (toolName === "apply_patch") {
    const input =
      block.tool_use_id && context.toolInputMapByCallId
        ? context.toolInputMapByCallId.get(block.tool_use_id)
        : undefined;
    if (input && typeof input.raw === "string") {
      return summarizePatch(input.raw, context.projectPath);
    }
  }

  if (
    toolName === "exec_command" ||
    toolName === "bash" ||
    toolName === "write_stdin"
  ) {
    return summarizeCommandToolResult(toolName, content, isError);
  }

  if (toolName === "wait") {
    const parsed = parseJsonValue(content);
    if (parsed.parsed && isRecord(parsed.value)) {
      if (parsed.value.timed_out === true) {
        return plainLine("system", "Wait timed out", [
          plainSegment("error", "Wait timed out"),
        ]);
      }
      if (isRecord(parsed.value.status)) {
        const detail = `${Object.keys(parsed.value.status).length} wait result(s)`;
        return plainLine("tool", `Received ${detail}`, [
          plainSegment("label", "Received"),
          detailSegment(detail),
        ]);
      }
    }
  }

  if (toolName === "view_image") {
    const parsed = parseJsonValue(content);
    if (parsed.parsed && Array.isArray(parsed.value)) {
      const imageCount = parsed.value.filter(
        (item) => isRecord(item) && item.type === "input_image",
      ).length;
      if (imageCount > 0) {
        const detail = `${imageCount} image${imageCount > 1 ? "s" : ""}`;
        return plainLine("tool", detail, [detailSegment(detail)]);
      }
    }
  }

  const firstLine = getFirstNonEmptyLine(content);
  if (firstLine) {
    const truncated = truncateInlineText(firstLine, 120);
    if (isError) {
      return plainLine("system", `Error ${toolName} · ${truncated}`, [
        plainSegment("error", "Error"),
        detailSegment(toolName),
        punctuationSegment("·"),
        plainSegment("error", truncated),
      ]);
    }
    return plainLine("tool", `Called ${toolName} · ${truncated}`, [
      plainSegment("label", "Called"),
      detailSegment(toolName),
      punctuationSegment("·"),
      detailSegment(truncated),
    ]);
  }

  if (isError) {
    return plainLine("system", `${toolName} failed`, [
      plainSegment("error", `${toolName} failed`),
    ]);
  }

  return plainLine("tool", `Called ${toolName}`, [
    plainSegment("label", "Called"),
    detailSegment(toolName),
  ]);
}

function getAssistantInlinePreview(
  content: string | ContentBlock[] | undefined,
  context: CollapsedViewportContext,
): CollapsedViewportLine | null {
  if (typeof content === "string") {
    const sanitizedBlockText = sanitizeText(content).trim();
    if (!sanitizedBlockText) {
      return null;
    }

    const planSummary = parsePlanSummary(sanitizedBlockText);
    if (planSummary) {
      return plainLine("plan", `Plan: ${planSummary}`, [
        plainSegment("label", "Plan:"),
        detailSegment(planSummary),
      ]);
    }

    const normalized = truncateInlineText(
      normalizeInlineText(sanitizedBlockText),
    );
    return plainLine("assistant", normalized, [detailSegment(normalized)]);
  }

  if (!Array.isArray(content)) {
    return null;
  }

  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      const sanitizedBlockText = sanitizeText(block.text).trim();
      if (!sanitizedBlockText) {
        continue;
      }

      const planSummary = parsePlanSummary(sanitizedBlockText);
      if (planSummary) {
        return plainLine("plan", `Plan: ${planSummary}`, [
          plainSegment("label", "Plan:"),
          detailSegment(planSummary),
        ]);
      }

      const normalized = truncateInlineText(
        normalizeInlineText(sanitizedBlockText),
      );
      return plainLine("assistant", normalized, [detailSegment(normalized)]);
    }

    if (block.type === "tool_use" && typeof block.name === "string") {
      const toolName = normalizeInlineText(block.name).toLowerCase();
      if (!toolName || !isRecord(block.input)) {
        continue;
      }
      const summary = summarizeToolCall(toolName, block.input, context);
      if (summary) {
        return summary;
      }
      continue;
    }

    if (block.type === "tool_result") {
      const toolName = normalizeInlineText(
        block.name ||
          (block.tool_use_id && context.toolMapByCallId
            ? context.toolMapByCallId.get(block.tool_use_id) || ""
            : ""),
      ).toLowerCase();
      if (!toolName || IMPORTANT_TOOL_NAMES.has(toolName)) {
        continue;
      }
      const summary = summarizeToolResult(toolName, block, context);
      if (summary) {
        return summary;
      }
      continue;
    }

    if (
      block.type === "image" &&
      typeof block.image_url === "string" &&
      block.image_url.trim().length > 0
    ) {
      return plainLine("assistant", "Image attachment", [
        detailSegment("Image attachment"),
      ]);
    }
  }

  return null;
}

function hasAssistantPrimaryText(
  content: string | ContentBlock[] | undefined,
): boolean {
  if (typeof content === "string") {
    return normalizeInlineText(sanitizeText(content)).length > 0;
  }

  if (!Array.isArray(content)) {
    return false;
  }

  return extractNonEmptyTextBlocks(content).length > 0;
}

export function getViewportMessageGroup(
  message: ConversationMessage,
): ViewportMessageGroup {
  if (message.type === "token_limit_notice") {
    return shouldShowTokenLimitNotice(message) ? "important" : "default";
  }

  if (
    message.type === "user" ||
    message.type === "system_error" ||
    message.type === "turn_aborted"
  ) {
    return "important";
  }

  if (message.type !== "assistant") {
    return "default";
  }

  const content = message.message?.content;
  if (hasAssistantPrimaryText(content)) {
    return "important";
  }

  if (Array.isArray(content) && hasImportantToolUse(content)) {
    return "important";
  }

  return "default";
}

export function getCollapsedViewportLine(
  message: ConversationMessage,
  context: CollapsedViewportContext = {},
): CollapsedViewportLine | null {
  if (message.type === "reasoning" || message.type === "agent_reasoning") {
    return null;
  }

  const content = message.message?.content;

  if (message.type === "assistant") {
    return getAssistantInlinePreview(content, context);
  }

  if (message.type === "user") {
    const userText =
      typeof content === "string"
        ? normalizeInlineText(sanitizeText(content))
        : Array.isArray(content)
          ? (extractNonEmptyTextBlocks(content)[0] ?? "")
          : "";
    if (!userText) {
      return null;
    }
    const truncated = truncateInlineText(userText);
    return plainLine("user", truncated, [detailSegment(truncated)]);
  }

  if (message.type === "system_error" || message.type === "turn_aborted") {
    const fallback = normalizeInlineText(sanitizeText(message.summary ?? ""));
    const details =
      typeof content === "string"
        ? normalizeInlineText(sanitizeText(content))
        : Array.isArray(content)
          ? (extractNonEmptyTextBlocks(content)[0] ?? "")
          : "";
    const text = truncateInlineText(details || fallback || "System message");
    return plainLine("system", text, [plainSegment("error", text)]);
  }

  if (message.type === "token_limit_notice") {
    if (!shouldShowTokenLimitNotice(message)) {
      return null;
    }

    const fallback = normalizeInlineText(sanitizeText(message.summary ?? ""));
    const details =
      typeof content === "string"
        ? normalizeInlineText(sanitizeText(content))
        : Array.isArray(content)
          ? (extractNonEmptyTextBlocks(content)[0] ?? "")
          : "";
    const text = truncateInlineText(details || fallback || "System message");
    return plainLine("system", text, [plainSegment("error", text)]);
  }

  return null;
}

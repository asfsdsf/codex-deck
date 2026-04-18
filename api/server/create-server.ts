import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import {
  initStorage,
  loadStorage,
  getCodexDir,
  getSessions,
  getProjects,
  getSessionContext,
  getCodexConfigDefaults,
  getConversation,
  getConversationRawChunk,
  getConversationRawWindow,
  getConversationStream,
  deleteSession,
  fixDanglingTurns,
  getSessionWaitState,
  sessionExists,
  getSessionTerminalRunOutput,
  getSessionTerminalRuns,
  invalidateHistoryCache,
  addToFileIndex,
  type SessionsRemovedEvent,
  type CodexThreadStateResponse,
  type CodexThreadNameSetRequest,
  type CodexThreadNameSetResponse,
  type CodexThreadForkResponse,
  type CodexThreadCompactResponse,
  type CodexThreadAgentListResponse,
  type CodexThreadSummariesRequest,
  type CodexThreadSummariesResponse,
  type CodexUserInputRequest,
  type CodexUserInputResponsePayload,
  type CodexApprovalRequest,
  type CodexApprovalResponsePayload,
  type CreateCodexThreadRequest,
  type SendCodexMessageInputItem,
  type SendCodexMessageRequest,
  type SendCodexMessageResponse,
  type ConversationMessage,
  type ConversationRawChunkResponse,
  type ConversationRawWindowResponse,
  type SessionDiffMode,
  type SessionDiffResponse,
  type SessionTerminalRunOutputResponse,
  type SessionTerminalRunsResponse,
  type SessionFileTreeResponse,
  type SessionFileTreeNodesResponse,
  type SessionFileSearchResponse,
  type SessionFileContentResponse,
  type SessionsDeltaResponse,
  type SessionSkillsResponse,
  type SessionSkillConfigWriteRequest,
  type SessionSkillConfigWriteResponse,
  type WorkflowActionResponse,
  type WorkflowBindSessionRequest,
  type WorkflowControlMessageRequest,
  type WorkflowCreateResponse,
  type WorkflowDaemonStatusResponse,
  type WorkflowDetailResponse,
  type WorkflowLogResponse,
  type WorkflowSessionLookupResult,
  type WorkflowSessionRolesRequest,
  type WorkflowSessionRolesResponse,
  type WorkflowSummary,
  type CreateWorkflowRequest,
  type TerminalSummary,
  type TerminalListResponse,
  type CreateTerminalRequest,
  type TerminalSnapshotResponse,
  type TerminalInputRequest,
  type TerminalResizeRequest,
  type TerminalClaimWriteRequest,
  type TerminalReleaseWriteRequest,
  type TerminalCommandResponse,
  type TerminalEventsResponse,
  type TerminalStreamEvent,
} from "../storage";
import {
  initWatcher,
  startWatcher,
  stopWatcher,
  onHistoryChange,
  offHistoryChange,
  onSessionChange,
  offSessionChange,
  onWorkflowChange,
  offWorkflowChange,
} from "../watcher";
import { dirname, join, resolve } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { readFileSync, existsSync } from "fs";
import { open as openFile, readdir, stat } from "fs/promises";
import open from "open";
import { isPathWithinDirectory, splitPathSegments } from "../path-utils";
import {
  CodexAppServerRpcError,
  CodexAppServerTransportError,
  closeCodexAppServerClient,
  getCodexAppServerClient,
  isCodexReasoningEffort,
  isCodexServiceTier,
  type CodexCollaborationModeInput,
  type CodexServiceTier,
  type CodexThreadSummary,
  type CodexLiveTerminalRun,
  type CodexReasoningEffort,
} from "../codex-app-server";
import {
  closeLocalTerminalManager,
  getLocalTerminalManager,
} from "../local-terminal";
import { INTERNAL_REMOTE_PROXY_ACCESS_HEADER } from "../remote/internal-proxy";
import { RemoteServerClient } from "../remote/remote-server-client";
import { registerTerminalRoutes } from "./terminal-routes";
import { registerSystemRoutes } from "./system-routes";
import {
  MAX_LONG_POLL_WAIT_MS,
  parseNonNegativeInteger,
  responseStatusForError,
  toErrorMessage,
  waitForAbortableTimeout,
} from "./utils";
import { registerWorkflowRoutes } from "./workflow-routes";
import { getWorkflowSummaryByKey, listWorkflows } from "../workflows";
import {
  getTerminalBindingsByTerminalIds,
  onTerminalBindingChange,
} from "../terminal-bindings";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_CONVERSATION_CHUNK_MAX_BYTES = 512 * 1024;
const DEFAULT_CONVERSATION_RAW_CHUNK_MAX_BYTES = 512 * 1024;
const SESSION_DELTA_LOG_LIMIT = 500;
const ENABLE_WAIT_MODE_DETECTION_LOG = false;

function getWebDistPath(): string {
  const prodPath = join(__dirname, "web");
  if (existsSync(prodPath)) {
    return prodPath;
  }
  return join(__dirname, "..", "dist", "web");
}

function logWaitModeDetected(
  source: "thread-state-fallback" | "degraded-thread-state",
  threadId: string,
  requestedTurnId: string | null,
  activeTurnId: string | null,
  danglingTurnIds: string[],
): void {
  if (!ENABLE_WAIT_MODE_DETECTION_LOG) {
    return;
  }

  const danglingSummary =
    danglingTurnIds.length > 0 ? danglingTurnIds.join(",") : "none";
  console.log(
    `[codex-deck] wait mode detected (${source}) threadId=${threadId} requestedTurnId=${requestedTurnId ?? "none"} activeTurnId=${activeTurnId ?? "none"} danglingTurnIds=${danglingSummary}`,
  );
}

function mergeTerminalOutputText(persisted: string, live: string): string {
  if (!persisted) {
    return live;
  }
  if (!live) {
    return persisted;
  }
  if (live.includes(persisted)) {
    return live;
  }
  if (persisted.includes(live)) {
    return persisted;
  }
  return live.length >= persisted.length ? live : persisted;
}

function toIsoTimestampFromMs(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  return new Date(ms).toISOString();
}

function parseOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}

async function withTerminalBindings(
  terminals: TerminalSummary[],
): Promise<TerminalSummary[]> {
  if (terminals.length === 0) {
    return [];
  }

  const bindings = await getTerminalBindingsByTerminalIds(
    terminals.map((terminal) => terminal.terminalId),
  );
  return terminals.map((terminal) => ({
    ...terminal,
    boundSessionId: bindings[terminal.terminalId] ?? null,
  }));
}

function normalizeCwdPath(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return "";
  }
  if (normalized === "~") {
    return homedir();
  }
  if (normalized.startsWith("~/")) {
    return join(homedir(), normalized.slice(2));
  }
  return normalized;
}

function parseOptionalEffort(
  value: unknown,
): CodexReasoningEffort | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return isCodexReasoningEffort(value) ? value : undefined;
}

function parseOptionalServiceTier(
  value: unknown,
): CodexServiceTier | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return isCodexServiceTier(value) ? value : undefined;
}

function parseOptionalCollaborationMode(
  value: unknown,
): CodexCollaborationModeInput | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const mode = typeof record.mode === "string" ? record.mode.trim() : "";
  if (!mode) {
    return undefined;
  }

  const settingsValue = record.settings;
  if (settingsValue === undefined || settingsValue === null) {
    return { mode };
  }

  if (
    typeof settingsValue !== "object" ||
    Array.isArray(settingsValue) ||
    !settingsValue
  ) {
    return undefined;
  }

  const settingsRecord = settingsValue as Record<string, unknown>;
  const model = parseOptionalString(settingsRecord.model);
  if (settingsRecord.model !== undefined && model === undefined) {
    return undefined;
  }

  const hasReasoningEffortCamel = Object.prototype.hasOwnProperty.call(
    settingsRecord,
    "reasoningEffort",
  );
  const hasReasoningEffortSnake = Object.prototype.hasOwnProperty.call(
    settingsRecord,
    "reasoning_effort",
  );
  const hasReasoningEffort = hasReasoningEffortCamel || hasReasoningEffortSnake;
  const reasoningEffortRaw = hasReasoningEffortCamel
    ? settingsRecord.reasoningEffort
    : hasReasoningEffortSnake
      ? settingsRecord.reasoning_effort
      : undefined;
  const reasoningEffort = parseOptionalEffort(reasoningEffortRaw);
  if (hasReasoningEffort && reasoningEffort === undefined) {
    return undefined;
  }

  const hasDeveloperInstructionsCamel = Object.prototype.hasOwnProperty.call(
    settingsRecord,
    "developerInstructions",
  );
  const hasDeveloperInstructionsSnake = Object.prototype.hasOwnProperty.call(
    settingsRecord,
    "developer_instructions",
  );
  const hasDeveloperInstructions =
    hasDeveloperInstructionsCamel || hasDeveloperInstructionsSnake;
  const developerInstructionsRaw = hasDeveloperInstructionsCamel
    ? settingsRecord.developerInstructions
    : hasDeveloperInstructionsSnake
      ? settingsRecord.developer_instructions
      : undefined;
  const developerInstructions = parseOptionalString(developerInstructionsRaw);
  if (hasDeveloperInstructions && developerInstructions === undefined) {
    return undefined;
  }

  const settings = {
    ...(model !== null ? { model } : {}),
    ...(reasoningEffort !== null ? { reasoningEffort } : {}),
    ...(developerInstructions !== null ? { developerInstructions } : {}),
  };

  if (Object.keys(settings).length === 0) {
    return { mode };
  }

  return {
    mode,
    settings,
  };
}

function parseSendMessageInputItems(
  value: unknown,
): SendCodexMessageInputItem[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const parsed: SendCodexMessageInputItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return undefined;
    }

    const record = item as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    if (type === "text") {
      if (typeof record.text !== "string") {
        return undefined;
      }
      const text = record.text.trim();
      if (!text) {
        continue;
      }
      parsed.push({
        type: "text",
        text,
      });
      continue;
    }

    if (type === "image") {
      if (typeof record.url !== "string") {
        return undefined;
      }
      const url = record.url.trim();
      if (!url) {
        continue;
      }
      parsed.push({
        type: "image",
        url,
      });
      continue;
    }

    return undefined;
  }

  return parsed;
}

function isThreadStateUnavailableError(error: unknown): boolean {
  if (!(error instanceof CodexAppServerRpcError)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("thread not found") ||
    message.includes("thread not loaded") ||
    message.includes("unknown thread") ||
    message.includes("not materialized yet") ||
    message.includes("includeturns is unavailable before first user message") ||
    message.includes("no rollout found for thread id")
  );
}

interface GitCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const SESSION_DIFF_MODES: SessionDiffMode[] = [
  "unstaged",
  "staged",
  "last-turn",
];

const FILE_CONTENT_PAGE_BYTES = 128 * 1024;
const FILE_CONTENT_BINARY_SNIFF_BYTES = 32 * 1024;
const FILE_CONTENT_PAGE_LINES = 1000;
const FILE_CONTENT_LONG_LINE_THRESHOLD = 10_000;
const FILE_CONTENT_ANALYZE_CHUNK_BYTES = 64 * 1024;
const FILE_CONTENT_INLINE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;
const FILE_SEARCH_DEFAULT_LIMIT = 40;
const FILE_SEARCH_MAX_LIMIT = 100;

const FILE_IMAGE_PREVIEW_MEDIA_TYPES = new Map<string, string>([
  ["avif", "image/avif"],
  ["bmp", "image/bmp"],
  ["gif", "image/gif"],
  ["ico", "image/x-icon"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["svg", "image/svg+xml"],
  ["webp", "image/webp"],
]);

function parseSessionDiffMode(
  value: string | undefined,
): SessionDiffMode | null {
  if (value === "unstaged" || value === "staged" || value === "last-turn") {
    return value;
  }
  return null;
}

function normalizeRelativeProjectPath(value: string): string | null {
  const normalized = value
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part.length > 0 && part !== ".")
    .join("/");
  if (!normalized) {
    return null;
  }
  if (normalized.split("/").some((segment) => segment === "..")) {
    return null;
  }
  return normalized;
}

function parseFileSearchLimit(value: string | undefined): number {
  if (!value) {
    return FILE_SEARCH_DEFAULT_LIMIT;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return FILE_SEARCH_DEFAULT_LIMIT;
  }
  return Math.min(FILE_SEARCH_MAX_LIMIT, parsed);
}

function normalizeFileSearchQuery(value: string): string {
  return value
    .trim()
    .replace(/^["']+/, "")
    .toLowerCase();
}

function getBasename(path: string): string {
  const slashIndex = path.lastIndexOf("/");
  return slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
}

function getFileSearchScore(
  path: string,
  normalizedQuery: string,
): [number, number] | null {
  const normalizedPath = path.toLowerCase();
  const normalizedBasename = getBasename(normalizedPath);

  if (normalizedPath === normalizedQuery) {
    return [0, 0];
  }

  if (normalizedPath.startsWith(normalizedQuery)) {
    return [1, normalizedPath.length];
  }

  if (normalizedBasename === normalizedQuery) {
    return [2, 0];
  }

  if (normalizedBasename.startsWith(normalizedQuery)) {
    return [3, normalizedBasename.length];
  }

  const segmentIndex = normalizedPath.indexOf(`/${normalizedQuery}`);
  if (segmentIndex >= 0) {
    return [4, segmentIndex];
  }

  const containsIndex = normalizedPath.indexOf(normalizedQuery);
  if (containsIndex >= 0) {
    return [5, containsIndex];
  }

  return null;
}

function searchProjectFiles(
  files: string[],
  query: string,
  limit: number,
): string[] {
  const normalizedQuery = normalizeFileSearchQuery(query);
  if (!normalizedQuery || files.length === 0) {
    return [];
  }

  return files
    .map((path) => ({
      path,
      score: getFileSearchScore(path, normalizedQuery),
    }))
    .filter(
      (entry): entry is { path: string; score: [number, number] } =>
        entry.score !== null,
    )
    .sort((a, b) => {
      if (a.score[0] !== b.score[0]) {
        return a.score[0] - b.score[0];
      }
      if (a.score[1] !== b.score[1]) {
        return a.score[1] - b.score[1];
      }
      return a.path.localeCompare(b.path);
    })
    .slice(0, limit)
    .map((entry) => entry.path);
}

/**
 * Safe wrapper around getSessionWaitState that returns a default "not waiting"
 * state on error instead of throwing. Used as a fallback when the RPC-based
 * thread state is unavailable.
 *
 * NOTE: This function intentionally does NOT auto-fix dangling turns.
 * Fixing dangling turns (appending synthetic completions to the session file)
 * must only be triggered by an explicit user action via the "Fix dangling"
 * button / POST /api/sessions/:id/fix-dangling endpoint.
 */
async function getSessionWaitStateSafe(sessionId: string) {
  try {
    return await getSessionWaitState(sessionId);
  } catch (error) {
    console.warn(
      `[codex-deck] failed to read session wait state for ${sessionId}: ${toErrorMessage(error)}`,
    );
    return {
      sessionId,
      isWaiting: false,
      activeTurnId: null,
      danglingTurnIds: [],
    };
  }
}

async function collectProjectFiles(projectPath: string): Promise<string[]> {
  const files: string[] = [];
  const stack: string[] = [""];

  while (stack.length > 0) {
    const relativeDir = stack.pop() ?? "";
    const absoluteDir = relativeDir
      ? join(projectPath, relativeDir)
      : projectPath;
    const entries = await readdir(absoluteDir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (entry.name === ".git") {
        continue;
      }

      const relativePath = relativeDir
        ? `${relativeDir}/${entry.name}`
        : entry.name;

      if (entry.isDirectory()) {
        stack.push(relativePath);
        continue;
      }

      if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }

  files.sort((left, right) => left.localeCompare(right));
  return files;
}

interface ProjectDirectoryNode {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface ProjectDirectoryNodePage {
  nodes: ProjectDirectoryNode[];
  nextCursor: number | null;
}

function normalizeRelativeDirectoryInput(dir: string | null): string {
  if (!dir) {
    return "";
  }
  const normalized = dir
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!normalized) {
    return "";
  }
  return splitPathSegments(normalized).join("/");
}

async function listProjectDirectoryNodes(
  projectPath: string,
  dir: string,
  cursor: number,
  limit: number,
): Promise<ProjectDirectoryNodePage> {
  const normalizedDir = normalizeRelativeDirectoryInput(dir);
  const absoluteDir = normalizedDir
    ? join(projectPath, normalizedDir)
    : projectPath;

  if (!isPathWithinDirectory(absoluteDir, projectPath)) {
    throw new Error("Requested directory is outside the project root.");
  }

  const directoryStat = await stat(absoluteDir);
  if (!directoryStat.isDirectory()) {
    throw new Error("Requested path is not a directory.");
  }

  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const nodes = entries
    .filter((entry) => entry.name !== ".git")
    .map((entry) => {
      const path = normalizedDir
        ? `${normalizedDir}/${entry.name}`
        : entry.name;
      return {
        name: entry.name,
        path,
        isDirectory: entry.isDirectory(),
      } satisfies ProjectDirectoryNode;
    })
    .sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) {
        return left.isDirectory ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });

  const normalizedCursor =
    Number.isFinite(cursor) && cursor >= 0 ? Math.floor(cursor) : 0;
  const normalizedLimit =
    Number.isFinite(limit) && limit > 0
      ? Math.min(Math.floor(limit), 2000)
      : 500;
  const page = nodes.slice(
    normalizedCursor,
    normalizedCursor + normalizedLimit,
  );
  const nextCursor =
    normalizedCursor + page.length < nodes.length
      ? normalizedCursor + page.length
      : null;

  return {
    nodes: page,
    nextCursor,
  };
}

function getFileExtension(path: string): string {
  const fileName = path.split("/").pop()?.toLowerCase() ?? "";
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
    return "";
  }
  return fileName.slice(dotIndex + 1);
}

function getInlinePreviewDescriptor(filePath: string): {
  kind: "image" | "pdf";
  mediaType: string;
} | null {
  const extension = getFileExtension(filePath);
  const imageMediaType = FILE_IMAGE_PREVIEW_MEDIA_TYPES.get(extension);
  if (imageMediaType) {
    return {
      kind: "image",
      mediaType: imageMediaType,
    };
  }

  if (extension === "pdf") {
    return {
      kind: "pdf",
      mediaType: "application/pdf",
    };
  }

  return null;
}

function toDataUrl(mediaType: string, content: Buffer): string {
  return `data:${mediaType};base64,${content.toString("base64")}`;
}

async function readProjectFilePage(
  filePath: string,
  page: number,
): Promise<{
  content: string;
  page: number;
  totalPages: number;
  paginationMode: "bytes" | "lines";
  lineStart: number | null;
  lineEnd: number | null;
  isBinary: boolean;
  previewKind: "image" | "pdf" | null;
  previewMediaType: string | null;
  previewDataUrl: string | null;
  previewUnavailableReason: string | null;
}> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error("Requested path is not a file.");
  }

  const fileSize = fileStat.size;
  const preview = getInlinePreviewDescriptor(filePath);
  const fileHandle = await openFile(filePath, "r");

  try {
    if (preview) {
      if (fileSize > FILE_CONTENT_INLINE_PREVIEW_MAX_BYTES) {
        return {
          content: "",
          page: 1,
          totalPages: 1,
          paginationMode: "bytes",
          lineStart: null,
          lineEnd: null,
          isBinary: true,
          previewKind: preview.kind,
          previewMediaType: preview.mediaType,
          previewDataUrl: null,
          previewUnavailableReason:
            "Preview is only available for files up to 8 MB.",
        };
      }

      const buffer = Buffer.alloc(fileSize);
      let totalBytesRead = 0;
      while (totalBytesRead < fileSize) {
        const { bytesRead } = await fileHandle.read(
          buffer,
          totalBytesRead,
          fileSize - totalBytesRead,
          totalBytesRead,
        );
        if (bytesRead <= 0) {
          break;
        }
        totalBytesRead += bytesRead;
      }

      return {
        content: "",
        page: 1,
        totalPages: 1,
        paginationMode: "bytes",
        lineStart: null,
        lineEnd: null,
        isBinary: true,
        previewKind: preview.kind,
        previewMediaType: preview.mediaType,
        previewDataUrl: toDataUrl(
          preview.mediaType,
          buffer.subarray(0, totalBytesRead),
        ),
        previewUnavailableReason: null,
      };
    }

    const sniffBytes = Math.min(fileSize, FILE_CONTENT_BINARY_SNIFF_BYTES);
    if (sniffBytes > 0) {
      const binaryProbe = Buffer.alloc(sniffBytes);
      const { bytesRead: probeRead } = await fileHandle.read(
        binaryProbe,
        0,
        sniffBytes,
        0,
      );
      const probeSlice = binaryProbe.subarray(0, probeRead);
      if (probeSlice.includes(0)) {
        return {
          content: "",
          page: 1,
          totalPages: 1,
          paginationMode: "bytes",
          lineStart: null,
          lineEnd: null,
          isBinary: true,
          previewKind: null,
          previewMediaType: null,
          previewDataUrl: null,
          previewUnavailableReason: null,
        };
      }
    }

    let hasVeryLongLine = false;
    const lineOffsets: number[] = fileSize > 0 ? [0] : [];
    if (fileSize > 0) {
      const inspectBuffer = Buffer.alloc(FILE_CONTENT_ANALYZE_CHUNK_BYTES);
      let position = 0;
      let currentLineLength = 0;

      while (position < fileSize) {
        const bytesToRead = Math.min(
          FILE_CONTENT_ANALYZE_CHUNK_BYTES,
          fileSize - position,
        );
        const { bytesRead } = await fileHandle.read(
          inspectBuffer,
          0,
          bytesToRead,
          position,
        );
        if (bytesRead <= 0) {
          break;
        }

        for (let index = 0; index < bytesRead; index += 1) {
          const byte = inspectBuffer[index];
          if (byte === 0x0a) {
            currentLineLength = 0;
            const nextLineOffset = position + index + 1;
            if (nextLineOffset < fileSize) {
              lineOffsets.push(nextLineOffset);
            }
            continue;
          }

          currentLineLength += 1;
          if (currentLineLength > FILE_CONTENT_LONG_LINE_THRESHOLD) {
            hasVeryLongLine = true;
            break;
          }
        }

        if (hasVeryLongLine) {
          break;
        }

        position += bytesRead;
      }
    }

    if (!hasVeryLongLine) {
      const totalLines = lineOffsets.length;
      const totalPages = Math.max(
        1,
        Math.ceil(totalLines / FILE_CONTENT_PAGE_LINES),
      );
      const normalizedPage = Math.min(Math.max(page, 1), totalPages);

      if (totalLines <= 0) {
        return {
          content: "",
          page: normalizedPage,
          totalPages,
          paginationMode: "lines",
          lineStart: 0,
          lineEnd: 0,
          isBinary: false,
          previewKind: null,
          previewMediaType: null,
          previewDataUrl: null,
          previewUnavailableReason: null,
        };
      }

      const lineStart = (normalizedPage - 1) * FILE_CONTENT_PAGE_LINES + 1;
      const lineEnd = Math.min(
        lineStart + FILE_CONTENT_PAGE_LINES - 1,
        totalLines,
      );
      const pageStartOffset = lineOffsets[lineStart - 1] ?? 0;
      const pageEndOffset =
        lineEnd >= totalLines ? fileSize : (lineOffsets[lineEnd] ?? fileSize);
      const bytesToRead = Math.max(0, pageEndOffset - pageStartOffset);

      let content = "";
      if (bytesToRead > 0) {
        const buffer = Buffer.alloc(bytesToRead);
        const { bytesRead } = await fileHandle.read(
          buffer,
          0,
          bytesToRead,
          pageStartOffset,
        );
        content = buffer
          .subarray(0, bytesRead)
          .toString("utf-8")
          .replace(/\r\n/g, "\n");
      }

      return {
        content,
        page: normalizedPage,
        totalPages,
        paginationMode: "lines",
        lineStart,
        lineEnd,
        isBinary: false,
        previewKind: null,
        previewMediaType: null,
        previewDataUrl: null,
        previewUnavailableReason: null,
      };
    }

    const totalPages =
      fileSize <= 0 ? 1 : Math.ceil(fileSize / FILE_CONTENT_PAGE_BYTES);
    const normalizedPage = Math.min(Math.max(page, 1), totalPages);
    const pageOffset = (normalizedPage - 1) * FILE_CONTENT_PAGE_BYTES;
    const bytesToRead = Math.max(
      0,
      Math.min(FILE_CONTENT_PAGE_BYTES, fileSize - pageOffset),
    );

    if (bytesToRead <= 0) {
      return {
        content: "",
        page: normalizedPage,
        totalPages,
        paginationMode: "bytes",
        lineStart: null,
        lineEnd: null,
        isBinary: false,
        previewKind: null,
        previewMediaType: null,
        previewDataUrl: null,
        previewUnavailableReason: null,
      };
    }

    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await fileHandle.read(
      buffer,
      0,
      bytesToRead,
      pageOffset,
    );
    const content = buffer
      .subarray(0, bytesRead)
      .toString("utf-8")
      .replace(/\r\n/g, "\n");

    return {
      content,
      page: normalizedPage,
      totalPages,
      paginationMode: "bytes",
      lineStart: null,
      lineEnd: null,
      isBinary: false,
      previewKind: null,
      previewMediaType: null,
      previewDataUrl: null,
      previewUnavailableReason: null,
    };
  } finally {
    await fileHandle.close();
  }
}

function normalizeGitPathToken(value: string): string | null {
  let normalized = value.trim();
  if (!normalized || normalized === "/dev/null") {
    return null;
  }

  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1);
  }

  normalized = normalized.replace(/\\\\/g, "\\").replace(/\\"/g, '"');

  if (normalized.startsWith("a/") || normalized.startsWith("b/")) {
    normalized = normalized.slice(2);
  }

  return normalized.trim() || null;
}

function parseGitNameStatus(output: string): Map<string, string> {
  const statuses = new Map<string, string>();

  for (const line of output.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const parts = trimmed.split("\t");
    if (parts.length < 2) {
      continue;
    }

    const status = parts[0]?.trim() ?? "";
    const path =
      status.startsWith("R") || status.startsWith("C")
        ? (parts[2]?.trim() ?? "")
        : (parts[1]?.trim() ?? "");

    if (!status || !path) {
      continue;
    }

    statuses.set(path, status);
  }

  return statuses;
}

function extractPathFromDiffChunk(chunk: string): string | null {
  const lines = chunk.split("\n");
  let minusPath: string | null = null;
  let plusPath: string | null = null;

  for (const line of lines) {
    if (line.startsWith("--- ")) {
      minusPath = normalizeGitPathToken(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      plusPath = normalizeGitPathToken(line.slice(4));
    }
  }

  if (plusPath) {
    return plusPath;
  }
  if (minusPath) {
    return minusPath;
  }

  const firstLine = lines[0] ?? "";
  const headerMatch = firstLine.match(/^diff --git (.+?) (.+)$/);
  if (!headerMatch) {
    return null;
  }

  return (
    normalizeGitPathToken(headerMatch[2] ?? "") ??
    normalizeGitPathToken(headerMatch[1] ?? "")
  );
}

function splitGitDiffByFile(diffText: string): Map<string, string> {
  const byFile = new Map<string, string>();
  const normalized = diffText.replace(/\r\n/g, "\n");
  const headerRegex = /^diff --git .+$/gm;
  const starts = Array.from(normalized.matchAll(headerRegex))
    .map((match) => match.index ?? -1)
    .filter((index) => index >= 0);

  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]!;
    const end = starts[index + 1] ?? normalized.length;
    const chunk = normalized.slice(start, end).trimEnd();
    const path = extractPathFromDiffChunk(chunk);
    if (!path) {
      continue;
    }

    const existing = byFile.get(path);
    byFile.set(path, existing ? `${existing}\n${chunk}` : chunk);
  }

  return byFile;
}

function inferStatusFromDiff(diff: string): string {
  if (/\nnew file mode /m.test(diff)) {
    return "A";
  }
  if (/\ndeleted file mode /m.test(diff)) {
    return "D";
  }
  if (/\nrename from /m.test(diff) || /\nrename to /m.test(diff)) {
    return "R";
  }
  return "M";
}

function firstLineOrFallback(text: string, fallback: string): string {
  const firstLine = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ?? fallback;
}

async function runGitCommand(
  projectPath: string,
  args: string[],
): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd: projectPath,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, 10_000);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        exitCode: -1,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        timedOut,
      });
    });

    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

async function buildGitDiffResponse(
  sessionId: string,
  mode: "unstaged" | "staged",
  projectPath: string | null,
): Promise<SessionDiffResponse> {
  if (!projectPath) {
    return {
      sessionId,
      mode,
      projectPath,
      turnId: null,
      files: [],
      unavailableReason: "Session project path is unavailable.",
    };
  }

  const sharedArgs = ["--no-color", "--find-renames"];
  const nameStatusArgs =
    mode === "staged"
      ? ["diff", "--cached", "--name-status", ...sharedArgs]
      : ["diff", "--name-status", ...sharedArgs];
  const patchArgs =
    mode === "staged"
      ? ["diff", "--cached", "--patch", ...sharedArgs]
      : ["diff", "--patch", ...sharedArgs];

  const [nameStatusResult, patchResult] = await Promise.all([
    runGitCommand(projectPath, nameStatusArgs),
    runGitCommand(projectPath, patchArgs),
  ]);

  if (nameStatusResult.timedOut || patchResult.timedOut) {
    return {
      sessionId,
      mode,
      projectPath,
      turnId: null,
      files: [],
      unavailableReason: "Timed out while reading git diff.",
    };
  }

  if (nameStatusResult.exitCode !== 0 || patchResult.exitCode !== 0) {
    const fallback = "Git diff is unavailable for this project.";
    const message = firstLineOrFallback(
      `${nameStatusResult.stderr}\n${patchResult.stderr}`,
      fallback,
    );
    return {
      sessionId,
      mode,
      projectPath,
      turnId: null,
      files: [],
      unavailableReason: message,
    };
  }

  const statusByPath = parseGitNameStatus(nameStatusResult.stdout);
  const diffByPath = splitGitDiffByFile(patchResult.stdout);
  const paths = new Set<string>([...statusByPath.keys(), ...diffByPath.keys()]);

  const files = [...paths]
    .map((path) => {
      const diff = diffByPath.get(path) ?? "";
      const status = statusByPath.get(path) ?? inferStatusFromDiff(diff);
      return {
        path,
        status,
        diff,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    sessionId,
    mode,
    projectPath,
    turnId: null,
    files,
    unavailableReason: null,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function getFilePathFromToolInput(
  input: Record<string, unknown>,
): string | null {
  return (
    asTrimmedString(input.file_path) ?? asTrimmedString(input.path) ?? null
  );
}

function mergeSessionDiffFile(
  byPath: Map<string, { status: string; diff: string }>,
  path: string,
  status: string,
  diff: string,
): void {
  const normalizedPath = path.trim();
  if (!normalizedPath) {
    return;
  }

  const normalizedStatus = status.trim() || "M";
  const normalizedDiff = diff.trimEnd();
  const existing = byPath.get(normalizedPath);

  if (!existing) {
    byPath.set(normalizedPath, {
      status: normalizedStatus,
      diff: normalizedDiff,
    });
    return;
  }

  if (normalizedDiff && normalizedDiff !== existing.diff) {
    existing.diff = existing.diff
      ? `${existing.diff}\n\n${normalizedDiff}`
      : normalizedDiff;
  }

  if (existing.status === "M" && normalizedStatus !== "M") {
    existing.status = normalizedStatus;
  }
}

function createWritePseudoDiff(path: string, content: string): string {
  const normalizedPath = path.trim();
  if (!normalizedPath) {
    return "";
  }

  const normalizedContent = content.replace(/\r\n/g, "\n");
  const lines = normalizedContent.split("\n");
  const lineCount = lines.length;
  const header = [
    `diff --git a/${normalizedPath} b/${normalizedPath}`,
    `--- a/${normalizedPath}`,
    `+++ b/${normalizedPath}`,
    `@@ -1,${lineCount} +1,${lineCount} @@`,
  ];

  return `${header.join("\n")}\n${lines.map((line) => `+${line}`).join("\n")}`;
}

function parseApplyPatchInput(
  patchText: string,
): Array<{ path: string; status: string; diff: string }> {
  const lines = patchText.replace(/\r\n/g, "\n").split("\n");
  const resultByPath = new Map<string, { status: string; diff: string }>();

  let currentPath: string | null = null;
  let currentStatus = "M";
  let currentLines: string[] = [];

  const flushCurrent = () => {
    if (!currentPath) {
      currentLines = [];
      return;
    }

    const chunk = currentLines.join("\n").trimEnd();
    mergeSessionDiffFile(resultByPath, currentPath, currentStatus, chunk);
    currentPath = null;
    currentStatus = "M";
    currentLines = [];
  };

  for (const line of lines) {
    if (line.startsWith("*** Update File: ")) {
      flushCurrent();
      currentPath = line.slice("*** Update File: ".length).trim();
      currentStatus = "M";
      currentLines = [line];
      continue;
    }

    if (line.startsWith("*** Add File: ")) {
      flushCurrent();
      currentPath = line.slice("*** Add File: ".length).trim();
      currentStatus = "A";
      currentLines = [line];
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      flushCurrent();
      currentPath = line.slice("*** Delete File: ".length).trim();
      currentStatus = "D";
      currentLines = [line];
      continue;
    }

    if (line.startsWith("*** End Patch")) {
      if (currentPath) {
        currentLines.push(line);
      }
      flushCurrent();
      continue;
    }

    if (currentPath) {
      currentLines.push(line);
    }
  }

  flushCurrent();

  return [...resultByPath.entries()].map(([path, entry]) => ({
    path,
    status: entry.status,
    diff: entry.diff,
  }));
}

function extractLastTurnFileChangesFromConversation(
  messages: ConversationMessage[],
): Array<{ path: string; status: string; diff: string }> {
  const parseMessageOffset = (message: ConversationMessage): number | null => {
    const value = message.uuid;
    if (typeof value !== "string") {
      return null;
    }

    const match = value.match(/^(\d+):/);
    if (!match) {
      return null;
    }

    const parsed = Number(match[1]);
    return Number.isFinite(parsed) ? parsed : null;
  };

  let lastUserOffset: number | null = null;
  for (const message of messages) {
    if (message?.type !== "user") {
      continue;
    }

    const offset = parseMessageOffset(message);
    if (offset === null) {
      continue;
    }

    if (lastUserOffset === null || offset > lastUserOffset) {
      lastUserOffset = offset;
    }
  }

  if (lastUserOffset === null) {
    return [];
  }

  const fileChanges = new Map<string, { status: string; diff: string }>();

  for (const message of messages) {
    if (message?.type !== "assistant") {
      continue;
    }

    const messageOffset = parseMessageOffset(message);
    if (messageOffset === null || messageOffset <= lastUserOffset) {
      continue;
    }

    const content = message.message?.content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (const blockValue of content) {
      const block = asRecord(blockValue);
      if (!block || block.type !== "tool_use") {
        continue;
      }

      const toolName = (asTrimmedString(block.name) ?? "").toLowerCase();
      const toolInput = asRecord(block.input);
      if (!toolInput) {
        continue;
      }

      const filePath = getFilePathFromToolInput(toolInput);

      if (
        (toolName === "edit" || toolName.endsWith("_edit")) &&
        filePath &&
        typeof toolInput.old_string === "string" &&
        typeof toolInput.new_string === "string"
      ) {
        const diff = createTwoFilesPatch(
          `a/${filePath}`,
          `b/${filePath}`,
          toolInput.old_string,
          toolInput.new_string,
          "",
          "",
          { context: 3 },
        );
        mergeSessionDiffFile(fileChanges, filePath, "M", diff);
        continue;
      }

      if (
        (toolName === "write" || toolName.endsWith("_write")) &&
        filePath &&
        typeof toolInput.content === "string"
      ) {
        const diff = createWritePseudoDiff(filePath, toolInput.content);
        mergeSessionDiffFile(fileChanges, filePath, "M", diff);
        continue;
      }

      if (toolName === "multi_edit" && filePath) {
        const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
        const chunks: string[] = [];

        for (const editValue of edits) {
          const edit = asRecord(editValue);
          if (!edit) {
            continue;
          }

          const oldString =
            typeof edit.old_string === "string" ? edit.old_string : null;
          const newString =
            typeof edit.new_string === "string" ? edit.new_string : null;
          if (oldString === null || newString === null) {
            continue;
          }

          chunks.push(
            createTwoFilesPatch(
              `a/${filePath}`,
              `b/${filePath}`,
              oldString,
              newString,
              "",
              "",
              { context: 3 },
            ),
          );
        }

        if (chunks.length > 0) {
          mergeSessionDiffFile(fileChanges, filePath, "M", chunks.join("\n"));
          continue;
        }
      }

      if (toolName === "apply_patch") {
        const patchText =
          asTrimmedString(toolInput.patch) ??
          asTrimmedString(toolInput.input) ??
          asTrimmedString(toolInput.raw);
        if (!patchText) {
          continue;
        }

        const parsedPatches = parseApplyPatchInput(patchText);
        for (const patch of parsedPatches) {
          mergeSessionDiffFile(
            fileChanges,
            patch.path,
            patch.status,
            patch.diff,
          );
        }
      }
    }
  }

  return [...fileChanges.entries()]
    .map(([path, entry]) => ({
      path,
      status: entry.status,
      diff: entry.diff,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

async function buildLastTurnDiffResponse(
  sessionId: string,
  projectPath: string | null,
): Promise<SessionDiffResponse> {
  const messages = await getConversation(sessionId);
  const conversationFiles =
    extractLastTurnFileChangesFromConversation(messages);
  if (conversationFiles.length > 0) {
    return {
      sessionId,
      mode: "last-turn",
      projectPath,
      turnId: null,
      files: conversationFiles,
      unavailableReason: null,
    };
  }

  try {
    const turnDiff = await getCodexAppServerClient().getLastTurnDiff(sessionId);
    return {
      sessionId,
      mode: "last-turn",
      projectPath,
      turnId: turnDiff.turnId,
      files: turnDiff.files
        .map((entry) => ({
          path: entry.path,
          status: entry.kind,
          diff: entry.diff,
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
      unavailableReason: null,
    };
  } catch {
    return {
      sessionId,
      mode: "last-turn",
      projectPath,
      turnId: null,
      files: [],
      unavailableReason: null,
    };
  }
}

export interface ServerOptions {
  port: number;
  codexDir?: string;
  dev?: boolean;
  open?: boolean;
  remoteServerUrl?: string;
  remoteUsername?: string;
  remotePassword?: string;
  remoteSetupToken?: string;
  remoteMachineId?: string;
  remotePinnedRealmId?: string;
  remotePinnedOpaqueServerPublicKey?: string;
  remoteProxyAccessToken?: string;
}

interface SessionSkillsChangedEvent {
  sessionId: string;
  path: string;
  enabled: boolean;
  effectiveEnabled: boolean;
  timestampMs: number;
}

interface SessionDeltaEvent {
  version: number;
  changedSessionIds: string[];
  removedSessionIds: string[];
  skillsChangedSessionIds: string[];
  forceFullSnapshot: boolean;
}

export function createServer(options: ServerOptions) {
  const {
    port,
    codexDir,
    dev = false,
    open: shouldOpen = true,
    remoteServerUrl,
    remoteUsername,
    remotePassword,
    remoteSetupToken,
    remoteMachineId,
    remotePinnedRealmId,
    remotePinnedOpaqueServerPublicKey,
    remoteProxyAccessToken,
  } = options;

  initStorage(codexDir);
  initWatcher(getCodexDir());

  const app = new Hono();
  const internalRemoteProxyAccessToken = remoteServerUrl
    ? remoteProxyAccessToken?.trim() || randomUUID()
    : null;
  const workflowRouteUnavailable = (headers: Headers): boolean => {
    if (!remoteServerUrl) {
      return false;
    }
    return (
      headers.get(INTERNAL_REMOTE_PROXY_ACCESS_HEADER) !==
      internalRemoteProxyAccessToken
    );
  };
  const sessionsRemovedListeners = new Set<
    (event: SessionsRemovedEvent) => void
  >();
  const skillsChangedListeners = new Set<
    (event: SessionSkillsChangedEvent) => void
  >();
  const sessionsDeltaWaiters = new Set<() => void>();
  let sessionsDeltaVersion = 1;
  const sessionDeltaEvents: SessionDeltaEvent[] = [];

  const notifySessionDeltaWaiters = () => {
    for (const notify of sessionsDeltaWaiters) {
      notify();
    }
  };

  const recordSessionDeltaEvent = (event: {
    changedSessionIds?: string[];
    removedSessionIds?: string[];
    skillsChangedSessionIds?: string[];
    forceFullSnapshot?: boolean;
  }) => {
    const changedSessionIds = [
      ...new Set(
        (event.changedSessionIds ?? [])
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
    const removedSessionIds = [
      ...new Set(
        (event.removedSessionIds ?? [])
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
    const skillsChangedSessionIds = [
      ...new Set(
        (event.skillsChangedSessionIds ?? [])
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
    const forceFullSnapshot = Boolean(event.forceFullSnapshot);

    if (
      !forceFullSnapshot &&
      changedSessionIds.length === 0 &&
      removedSessionIds.length === 0 &&
      skillsChangedSessionIds.length === 0
    ) {
      return;
    }

    sessionsDeltaVersion += 1;
    sessionDeltaEvents.push({
      version: sessionsDeltaVersion,
      changedSessionIds,
      removedSessionIds,
      skillsChangedSessionIds,
      forceFullSnapshot,
    });
    if (sessionDeltaEvents.length > SESSION_DELTA_LOG_LIMIT) {
      sessionDeltaEvents.splice(
        0,
        sessionDeltaEvents.length - SESSION_DELTA_LOG_LIMIT,
      );
    }
    notifySessionDeltaWaiters();
  };

  const waitForSessionDeltaChange = (
    currentVersion: number,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (waitMs <= 0 || sessionsDeltaVersion > currentVersion) {
      return Promise.resolve(sessionsDeltaVersion > currentVersion);
    }

    return new Promise((resolve) => {
      let settled = false;
      let timeout: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout);
        }
        sessionsDeltaWaiters.delete(onDeltaChange);
        signal.removeEventListener("abort", onAbort);
      };

      const finish = (changed: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(changed);
      };

      const onDeltaChange = () => {
        finish(sessionsDeltaVersion > currentVersion);
      };

      const onAbort = () => {
        finish(false);
      };

      timeout = setTimeout(() => {
        finish(sessionsDeltaVersion > currentVersion);
      }, waitMs);

      sessionsDeltaWaiters.add(onDeltaChange);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };

  const buildSessionsDeltaResponse = async (
    sinceVersion: number,
  ): Promise<SessionsDeltaResponse> => {
    const currentVersion = sessionsDeltaVersion;
    const normalizedSinceVersion =
      Number.isFinite(sinceVersion) && sinceVersion >= 0
        ? Math.floor(sinceVersion)
        : 0;
    const eventsStartVersion = sessionDeltaEvents[0]?.version ?? currentVersion;

    if (
      normalizedSinceVersion <= 0 ||
      normalizedSinceVersion < eventsStartVersion - 1
    ) {
      return {
        version: currentVersion,
        isFullSnapshot: true,
        sessions: await getSessions(),
        updates: [],
        removedSessionIds: [],
        skillsChangedSessionIds: [],
      };
    }

    const relevantEvents = sessionDeltaEvents.filter(
      (event) => event.version > normalizedSinceVersion,
    );
    if (relevantEvents.length === 0) {
      return {
        version: currentVersion,
        isFullSnapshot: false,
        sessions: [],
        updates: [],
        removedSessionIds: [],
        skillsChangedSessionIds: [],
      };
    }

    if (relevantEvents.some((event) => event.forceFullSnapshot)) {
      return {
        version: currentVersion,
        isFullSnapshot: true,
        sessions: await getSessions(),
        updates: [],
        removedSessionIds: [],
        skillsChangedSessionIds: [],
      };
    }

    const changedSessionIds = new Set<string>();
    const removedSessionIds = new Set<string>();
    const skillsChangedSessionIds = new Set<string>();

    for (const event of relevantEvents) {
      for (const sessionId of event.changedSessionIds) {
        changedSessionIds.add(sessionId);
      }
      for (const sessionId of event.removedSessionIds) {
        removedSessionIds.add(sessionId);
      }
      for (const sessionId of event.skillsChangedSessionIds) {
        skillsChangedSessionIds.add(sessionId);
      }
    }

    const sessions = await getSessions();
    const sessionById = new Map(
      sessions.map((session) => [session.id, session]),
    );
    const updates = [...changedSessionIds]
      .map((sessionId) => sessionById.get(sessionId))
      .filter((session): session is NonNullable<typeof session> =>
        Boolean(session),
      );
    const finalRemovedSessionIds = [...removedSessionIds].filter(
      (sessionId) => !sessionById.has(sessionId),
    );

    return {
      version: currentVersion,
      isFullSnapshot: false,
      sessions: [],
      updates,
      removedSessionIds: finalRemovedSessionIds,
      skillsChangedSessionIds: [...skillsChangedSessionIds],
    };
  };

  const emitSessionsRemoved = (event: SessionsRemovedEvent) => {
    recordSessionDeltaEvent({
      removedSessionIds: event.sessionIds,
    });
    for (const listener of sessionsRemovedListeners) {
      listener(event);
    }
  };

  const emitSkillsChanged = (event: SessionSkillsChangedEvent) => {
    recordSessionDeltaEvent({
      skillsChangedSessionIds: [event.sessionId],
    });
    for (const listener of skillsChangedListeners) {
      listener(event);
    }
  };

  const resolveSessionProjectPath = async (
    sessionId: string,
  ): Promise<string | null | undefined> => {
    const sessions = await getSessions();
    const session = sessions.find((entry) => entry.id === sessionId);
    if (session) {
      const projectPath = session.project?.trim();
      return projectPath ? projectPath : null;
    }

    const getThreadSummary = getCodexAppServerClient().getThreadSummary;
    if (typeof getThreadSummary !== "function") {
      return undefined;
    }

    try {
      const summary = await getThreadSummary(sessionId);
      const cwd = summary.cwd.trim();
      return cwd ? cwd : null;
    } catch {
      return undefined;
    }
  };

  const resolveWorkflowProjectPath = async (
    workflowKey: string,
  ): Promise<string | null | undefined> => {
    const summary = await getWorkflowSummaryByKey(workflowKey, getCodexDir());
    if (!summary) {
      return undefined;
    }
    const projectPath = summary.projectRoot?.trim();
    return projectPath ? projectPath : null;
  };

  if (dev) {
    app.use(
      "*",
      cors({
        origin: ["http://localhost:12000"],
        allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type"],
      }),
    );
  }

  app.get("/api/sessions", async (c) => {
    const sessions = await getSessions();
    return c.json(sessions);
  });

  app.get("/api/sessions/delta", async (c) => {
    const sinceVersionRaw = c.req.query("sinceVersion");
    const parsedSinceVersion =
      sinceVersionRaw !== undefined
        ? parseNonNegativeInteger(sinceVersionRaw)
        : 0;
    if (sinceVersionRaw !== undefined && parsedSinceVersion === null) {
      return c.json(
        { error: "sinceVersion must be a non-negative integer" },
        400,
      );
    }
    const sinceVersion = parsedSinceVersion ?? 0;

    const waitMsRaw = c.req.query("waitMs");
    const parsedWaitMs =
      waitMsRaw !== undefined ? parseNonNegativeInteger(waitMsRaw) : 0;
    if (waitMsRaw !== undefined && parsedWaitMs === null) {
      return c.json({ error: "waitMs must be a non-negative integer" }, 400);
    }
    const waitMs = Math.min(parsedWaitMs ?? 0, MAX_LONG_POLL_WAIT_MS);

    await waitForSessionDeltaChange(sinceVersion, waitMs, c.req.raw.signal);
    const response = await buildSessionsDeltaResponse(sinceVersion);
    return c.json(response satisfies SessionsDeltaResponse);
  });

  app.get("/api/sessions/:id/exists", async (c) => {
    const sessionId = c.req.param("id")?.trim();
    if (!sessionId) {
      return c.json({ error: "session id is required" }, 400);
    }

    try {
      const response = await sessionExists(sessionId);
      return c.json(response);
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.delete("/api/sessions/:id", async (c) => {
    const sessionId = c.req.param("id")?.trim();
    if (!sessionId) {
      return c.json({ error: "session id is required" }, 400);
    }

    const actorClientIdRaw = c.req.query("clientId");
    const actorClientId =
      typeof actorClientIdRaw === "string" && actorClientIdRaw.trim()
        ? actorClientIdRaw.trim()
        : null;

    try {
      const response = await deleteSession(sessionId);
      emitSessionsRemoved({
        sessionIds: [response.sessionId],
        actorClientId,
        timestampMs: Date.now(),
      });
      return c.json(response);
    } catch (error) {
      const message = toErrorMessage(error);
      if (message.toLowerCase().includes("session not found")) {
        return c.json({ error: message }, 404);
      }

      return c.json(
        {
          error: message,
        },
        responseStatusForError(error),
      );
    }
  });

  app.get("/api/projects", async (c) => {
    const projects = await getProjects();
    return c.json(projects);
  });
  registerWorkflowRoutes(app, { workflowRouteUnavailable });
  registerSystemRoutes(app);
  registerTerminalRoutes(app);

  app.get("/api/sessions/stream", async (c) => {
    return streamSSE(c, async (stream) => {
      let isConnected = true;
      const disconnectController = new AbortController();
      const knownSessions = new Map<string, number>();
      const terminalManager = getLocalTerminalManager();
      let previousTerminalsPayload = "";
      let previousWorkflowsPayload = "";
      let unsubscribeTerminals: (() => void) | null = null;
      let unsubscribeTerminalBindings: (() => void) | null = null;

      const cleanup = () => {
        if (!isConnected) {
          return;
        }
        isConnected = false;
        disconnectController.abort();
        offHistoryChange(handleSessionsChange);
        offSessionChange(handleSessionsChange);
        offWorkflowChange(handleWorkflowsChange);
        sessionsRemovedListeners.delete(handleSessionsRemoved);
        skillsChangedListeners.delete(handleSkillsChanged);
        if (unsubscribeTerminals) {
          unsubscribeTerminals();
          unsubscribeTerminals = null;
        }
        if (unsubscribeTerminalBindings) {
          unsubscribeTerminalBindings();
          unsubscribeTerminalBindings = null;
        }
      };

      const writeTerminals = async () => {
        if (!isConnected) {
          return;
        }

        const terminals = await withTerminalBindings(
          terminalManager.listTerminals(),
        );
        const payload = JSON.stringify(terminals);
        if (payload === previousTerminalsPayload) {
          return;
        }
        previousTerminalsPayload = payload;
        await stream.writeSSE({
          event: "terminals",
          data: payload,
        });
      };

      const writeWorkflows = async () => {
        if (!isConnected) {
          return;
        }

        const workflows = await listWorkflows();
        const payload = JSON.stringify(workflows);
        if (payload === previousWorkflowsPayload) {
          return;
        }
        previousWorkflowsPayload = payload;
        await stream.writeSSE({
          event: "workflows",
          data: payload,
        });
      };

      const handleSessionsChange = async (
        changedSessionId?: string,
        _filePath?: string,
      ) => {
        if (!isConnected) {
          return;
        }
        try {
          const sessions = await getSessions();
          const updateMap = new Map<string, (typeof sessions)[number]>();
          const newOrUpdated = sessions.filter((s) => {
            const known = knownSessions.get(s.id);
            return known === undefined || known !== s.timestamp;
          });
          for (const session of newOrUpdated) {
            updateMap.set(session.id, session);
          }

          if (changedSessionId) {
            const changedSession = sessions.find(
              (s) => s.id === changedSessionId,
            );
            if (changedSession) {
              updateMap.set(changedSession.id, changedSession);
            }
          }

          knownSessions.clear();
          for (const session of sessions) {
            knownSessions.set(session.id, session.timestamp);
          }

          const updates = Array.from(updateMap.values());
          if (updates.length > 0) {
            await stream.writeSSE({
              event: "sessionsUpdate",
              data: JSON.stringify(updates),
            });
          }
        } catch {
          cleanup();
        }
      };

      const handleTerminalsChange = async () => {
        if (!isConnected) {
          return;
        }

        try {
          await writeTerminals();
        } catch {
          cleanup();
        }
      };

      const handleWorkflowsChange = async () => {
        if (!isConnected) {
          return;
        }

        try {
          await writeWorkflows();
        } catch {
          cleanup();
        }
      };

      const handleSessionsRemoved = async (event: SessionsRemovedEvent) => {
        if (!isConnected) {
          return;
        }

        for (const sessionId of event.sessionIds) {
          knownSessions.delete(sessionId);
        }

        try {
          await stream.writeSSE({
            event: "sessionsRemoved",
            data: JSON.stringify(event),
          });
        } catch {
          cleanup();
        }
      };

      const handleSkillsChanged = async (event: SessionSkillsChangedEvent) => {
        if (!isConnected) {
          return;
        }

        try {
          await stream.writeSSE({
            event: "skillsChanged",
            data: JSON.stringify(event),
          });
        } catch {
          cleanup();
        }
      };

      onHistoryChange(handleSessionsChange);
      onSessionChange(handleSessionsChange);
      onWorkflowChange(handleWorkflowsChange);
      sessionsRemovedListeners.add(handleSessionsRemoved);
      skillsChangedListeners.add(handleSkillsChanged);
      unsubscribeTerminals = terminalManager.subscribeTerminals(() => {
        void handleTerminalsChange();
      });
      unsubscribeTerminalBindings = onTerminalBindingChange(() => {
        void handleTerminalsChange();
      });
      stream.onAbort(cleanup);
      c.req.raw.signal.addEventListener("abort", cleanup, { once: true });

      try {
        const sessions = await getSessions();
        for (const s of sessions) {
          knownSessions.set(s.id, s.timestamp);
        }

        await stream.writeSSE({
          event: "sessions",
          data: JSON.stringify(sessions),
        });
        await writeTerminals();
        await writeWorkflows();

        while (isConnected) {
          await stream.writeSSE({
            event: "heartbeat",
            data: JSON.stringify({ timestamp: Date.now() }),
          });
          await waitForAbortableTimeout(30000, disconnectController.signal);
        }
      } catch {
        // Connection closed
      } finally {
        cleanup();
      }
    });
  });

  app.get("/api/sessions/:id/context", async (c) => {
    const sessionId = c.req.param("id")?.trim();
    if (!sessionId) {
      return c.json({ error: "session id is required" }, 400);
    }

    try {
      const context = await getSessionContext(sessionId);
      return c.json(context);
    } catch (error) {
      console.warn(
        `[codex-deck] degraded context response for ${sessionId}: ${toErrorMessage(error)}`,
      );
      return c.json({
        sessionId,
        contextLeftPercent: null,
        usedTokens: null,
        modelContextWindow: null,
        tokenUsage: null,
      });
    }
  });

  // Fix dangling turns: appends synthetic completions for unfinished turns.
  // This is a DESTRUCTIVE operation (mutates the session file) and must ONLY
  // be triggered by an explicit user action (the "Fix dangling" button in the
  // web UI). It must never be called automatically by server-side logic.
  app.post("/api/sessions/:id/fix-dangling", async (c) => {
    const sessionId = c.req.param("id")?.trim();
    if (!sessionId) {
      return c.json({ error: "session id is required" }, 400);
    }

    try {
      const result = await fixDanglingTurns(sessionId);
      return c.json(result);
    } catch (error) {
      const message = toErrorMessage(error);
      if (message.toLowerCase().includes("session file not found")) {
        return c.json({ error: message }, 404);
      }

      return c.json(
        {
          error: message,
        },
        responseStatusForError(error),
      );
    }
  });

  app.get("/api/sessions/:id/diff", async (c) => {
    const sessionId = c.req.param("id")?.trim();
    if (!sessionId) {
      return c.json({ error: "session id is required" }, 400);
    }

    const mode = parseSessionDiffMode(c.req.query("mode"));
    if (!mode) {
      return c.json(
        {
          error: `mode must be one of: ${SESSION_DIFF_MODES.join(", ")}`,
        },
        400,
      );
    }

    const projectPath = await resolveSessionProjectPath(sessionId);
    if (projectPath === undefined) {
      return c.json({ error: "session not found" }, 404);
    }

    const response =
      mode === "last-turn"
        ? await buildLastTurnDiffResponse(sessionId, projectPath)
        : await buildGitDiffResponse(sessionId, mode, projectPath);

    return c.json(response);
  });

  app.get("/api/workflow-project/:key/diff", async (c) => {
    const workflowKey = c.req.param("key")?.trim();
    if (!workflowKey) {
      return c.json({ error: "workflow key is required" }, 400);
    }
    if (workflowRouteUnavailable(c.req.raw.headers)) {
      return c.json(
        { error: "Workflow pane is unavailable in remote mode." },
        501,
      );
    }

    const mode = parseSessionDiffMode(c.req.query("mode"));
    if (!mode) {
      return c.json(
        {
          error: `mode must be one of: ${SESSION_DIFF_MODES.join(", ")}`,
        },
        400,
      );
    }

    const projectPath = await resolveWorkflowProjectPath(workflowKey);
    if (projectPath === undefined) {
      return c.json({ error: "workflow not found" }, 404);
    }

    if (mode === "last-turn") {
      const response: SessionDiffResponse = {
        sessionId: workflowKey,
        mode: "last-turn",
        projectPath,
        turnId: null,
        files: [],
        unavailableReason: "Last-turn diff is unavailable without a session.",
      };
      return c.json(response);
    }

    const response = await buildGitDiffResponse(workflowKey, mode, projectPath);
    return c.json(response);
  });

  app.get("/api/sessions/:id/terminal-runs", async (c) => {
    const sessionId = c.req.param("id")?.trim();
    if (!sessionId) {
      return c.json({ error: "session id is required" }, 400);
    }

    if ((await resolveSessionProjectPath(sessionId)) === undefined) {
      return c.json({ error: "session not found" }, 404);
    }

    const response: SessionTerminalRunsResponse =
      await getSessionTerminalRuns(sessionId);

    const liveRuns: CodexLiveTerminalRun[] =
      getCodexAppServerClient().listLiveTerminalRuns?.(sessionId) ?? [];
    if (liveRuns.length > 0) {
      const mergedByProcessId = new Map(
        response.runs.map((run) => [run.processId, run]),
      );

      for (const liveRun of liveRuns) {
        if (!liveRun.isRunning) {
          continue;
        }

        const existing = mergedByProcessId.get(liveRun.processId);
        if (existing) {
          existing.isRunning = true;
          if (!existing.command || existing.command === "(unknown command)") {
            existing.command = liveRun.command || existing.command;
          }
          existing.latestActivityAt =
            toIsoTimestampFromMs(liveRun.updatedAt) ??
            existing.latestActivityAt;
          continue;
        }

        mergedByProcessId.set(liveRun.processId, {
          processId: liveRun.processId,
          callId: liveRun.callId,
          command: liveRun.command || "(unknown command)",
          isRunning: true,
          startedAt: null,
          endedAt: null,
          latestActivityAt: toIsoTimestampFromMs(liveRun.updatedAt),
        });
      }

      response.runs = [...mergedByProcessId.values()].sort((left, right) => {
        const leftTs = left.latestActivityAt
          ? Date.parse(left.latestActivityAt)
          : 0;
        const rightTs = right.latestActivityAt
          ? Date.parse(right.latestActivityAt)
          : 0;
        return rightTs - leftTs;
      });
    }

    return c.json(response);
  });

  app.post("/api/sessions/:id/terminal-runs/clean", async (c) => {
    const sessionId = c.req.param("id")?.trim();
    if (!sessionId) {
      return c.json({ error: "session id is required" }, 400);
    }

    if ((await resolveSessionProjectPath(sessionId)) === undefined) {
      return c.json({ error: "session not found" }, 404);
    }

    const cleanBackgroundTerminals =
      getCodexAppServerClient().cleanBackgroundTerminals;
    if (typeof cleanBackgroundTerminals !== "function") {
      return c.json(
        { error: "Background terminal cleanup is unavailable." },
        501,
      );
    }

    try {
      await cleanBackgroundTerminals(sessionId);
      return c.json({ ok: true });
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.get("/api/sessions/:id/terminal-runs/:processId", async (c) => {
    const sessionId = c.req.param("id")?.trim();
    if (!sessionId) {
      return c.json({ error: "session id is required" }, 400);
    }

    const processId = c.req.param("processId")?.trim();
    if (!processId) {
      return c.json({ error: "process id is required" }, 400);
    }

    if ((await resolveSessionProjectPath(sessionId)) === undefined) {
      return c.json({ error: "session not found" }, 404);
    }

    const persistedResponse: SessionTerminalRunOutputResponse | null =
      await getSessionTerminalRunOutput(sessionId, processId);
    const liveRun =
      getCodexAppServerClient().getLiveTerminalRun?.(sessionId, processId) ??
      null;

    if (!persistedResponse && !liveRun) {
      return c.json({ error: "terminal run not found" }, 404);
    }

    if (persistedResponse && !liveRun) {
      return c.json(persistedResponse);
    }

    if (!persistedResponse && liveRun) {
      return c.json({
        sessionId,
        processId: liveRun.processId,
        command: liveRun.command || "(unknown command)",
        isRunning: liveRun.isRunning,
        output: liveRun.output,
        unavailableReason: null,
      } satisfies SessionTerminalRunOutputResponse);
    }

    const response = persistedResponse as SessionTerminalRunOutputResponse;
    const live = liveRun as CodexLiveTerminalRun;

    return c.json({
      ...response,
      command:
        response.command && response.command !== "(unknown command)"
          ? response.command
          : live.command || response.command,
      isRunning: live.isRunning,
      output: mergeTerminalOutputText(response.output, live.output),
    } satisfies SessionTerminalRunOutputResponse);
  });

  app.get("/api/sessions/:id/file-tree", async (c) => {
    const sessionId = c.req.param("id")?.trim();
    if (!sessionId) {
      return c.json({ error: "session id is required" }, 400);
    }

    const projectPath = await resolveSessionProjectPath(sessionId);
    if (projectPath === undefined) {
      return c.json({ error: "session not found" }, 404);
    }

    if (!projectPath) {
      const response: SessionFileTreeResponse = {
        sessionId,
        projectPath: null,
        files: [],
        unavailableReason: "Session has no project directory.",
      };
      return c.json(response);
    }

    try {
      const projectStat = await stat(projectPath);
      if (!projectStat.isDirectory()) {
        const response: SessionFileTreeResponse = {
          sessionId,
          projectPath,
          files: [],
          unavailableReason: "Project directory is unavailable.",
        };
        return c.json(response);
      }
    } catch {
      const response: SessionFileTreeResponse = {
        sessionId,
        projectPath,
        files: [],
        unavailableReason: "Project directory is unavailable.",
      };
      return c.json(response);
    }

    try {
      const files = await collectProjectFiles(projectPath);
      const response: SessionFileTreeResponse = {
        sessionId,
        projectPath,
        files,
        unavailableReason: null,
      };
      return c.json(response);
    } catch {
      const response: SessionFileTreeResponse = {
        sessionId,
        projectPath,
        files: [],
        unavailableReason: "Failed to read project file tree.",
      };
      return c.json(response);
    }
  });

  app.get("/api/sessions/:id/file-tree/nodes", async (c) => {
    const sessionId = c.req.param("id")?.trim();
    if (!sessionId) {
      return c.json({ error: "session id is required" }, 400);
    }

    const projectPath = await resolveSessionProjectPath(sessionId);
    if (projectPath === undefined) {
      return c.json({ error: "session not found" }, 404);
    }

    const dir = normalizeRelativeDirectoryInput(c.req.query("dir") ?? "");
    const cursorRaw = c.req.query("cursor");
    const cursorParsed = cursorRaw ? Number.parseInt(cursorRaw, 10) : 0;
    const cursor =
      Number.isFinite(cursorParsed) && cursorParsed >= 0 ? cursorParsed : 0;
    const limitRaw = c.req.query("limit");
    const limitParsed = limitRaw ? Number.parseInt(limitRaw, 10) : 500;
    const limit =
      Number.isFinite(limitParsed) && limitParsed > 0
        ? Math.min(limitParsed, 2000)
        : 500;

    if (!projectPath) {
      const response: SessionFileTreeNodesResponse = {
        sessionId,
        projectPath: null,
        dir,
        nodes: [],
        nextCursor: null,
        unavailableReason: "Session has no project directory.",
      };
      return c.json(response);
    }

    try {
      const { nodes, nextCursor } = await listProjectDirectoryNodes(
        projectPath,
        dir,
        cursor,
        limit,
      );
      const response: SessionFileTreeNodesResponse = {
        sessionId,
        projectPath,
        dir,
        nodes,
        nextCursor,
        unavailableReason: null,
      };
      return c.json(response);
    } catch (error) {
      const response: SessionFileTreeNodesResponse = {
        sessionId,
        projectPath,
        dir,
        nodes: [],
        nextCursor: null,
        unavailableReason: toErrorMessage(error),
      };
      return c.json(response);
    }
  });

  app.get("/api/workflow-project/:key/file-tree/nodes", async (c) => {
    const workflowKey = c.req.param("key")?.trim();
    if (!workflowKey) {
      return c.json({ error: "workflow key is required" }, 400);
    }
    if (workflowRouteUnavailable(c.req.raw.headers)) {
      return c.json(
        { error: "Workflow pane is unavailable in remote mode." },
        501,
      );
    }

    const projectPath = await resolveWorkflowProjectPath(workflowKey);
    if (projectPath === undefined) {
      return c.json({ error: "workflow not found" }, 404);
    }

    const dir = normalizeRelativeDirectoryInput(c.req.query("dir") ?? "");
    const cursorRaw = c.req.query("cursor");
    const cursorParsed = cursorRaw ? Number.parseInt(cursorRaw, 10) : 0;
    const cursor =
      Number.isFinite(cursorParsed) && cursorParsed >= 0 ? cursorParsed : 0;
    const limitRaw = c.req.query("limit");
    const limitParsed = limitRaw ? Number.parseInt(limitRaw, 10) : 500;
    const limit =
      Number.isFinite(limitParsed) && limitParsed > 0
        ? Math.min(limitParsed, 2000)
        : 500;

    if (!projectPath) {
      const response: SessionFileTreeNodesResponse = {
        sessionId: workflowKey,
        projectPath: null,
        dir,
        nodes: [],
        nextCursor: null,
        unavailableReason: "Workflow has no project directory.",
      };
      return c.json(response);
    }

    try {
      const { nodes, nextCursor } = await listProjectDirectoryNodes(
        projectPath,
        dir,
        cursor,
        limit,
      );
      const response: SessionFileTreeNodesResponse = {
        sessionId: workflowKey,
        projectPath,
        dir,
        nodes,
        nextCursor,
        unavailableReason: null,
      };
      return c.json(response);
    } catch (error) {
      const response: SessionFileTreeNodesResponse = {
        sessionId: workflowKey,
        projectPath,
        dir,
        nodes: [],
        nextCursor: null,
        unavailableReason: toErrorMessage(error),
      };
      return c.json(response);
    }
  });

  app.get("/api/sessions/:id/file-search", async (c) => {
    const sessionId = c.req.param("id")?.trim();
    if (!sessionId) {
      return c.json({ error: "session id is required" }, 400);
    }

    const query = c.req.query("query") ?? "";
    const limit = parseFileSearchLimit(c.req.query("limit"));

    const projectPath = await resolveSessionProjectPath(sessionId);
    if (projectPath === undefined) {
      return c.json({ error: "session not found" }, 404);
    }

    if (!projectPath) {
      const response: SessionFileSearchResponse = {
        sessionId,
        projectPath: null,
        query,
        files: [],
        unavailableReason: "Session has no project directory.",
      };
      return c.json(response);
    }

    try {
      const projectStat = await stat(projectPath);
      if (!projectStat.isDirectory()) {
        const response: SessionFileSearchResponse = {
          sessionId,
          projectPath,
          query,
          files: [],
          unavailableReason: "Project directory is unavailable.",
        };
        return c.json(response);
      }
    } catch {
      const response: SessionFileSearchResponse = {
        sessionId,
        projectPath,
        query,
        files: [],
        unavailableReason: "Project directory is unavailable.",
      };
      return c.json(response);
    }

    const normalizedQuery = normalizeFileSearchQuery(query);
    if (!normalizedQuery) {
      const response: SessionFileSearchResponse = {
        sessionId,
        projectPath,
        query,
        files: [],
        unavailableReason: null,
      };
      return c.json(response);
    }

    try {
      const files = await collectProjectFiles(projectPath);
      const response: SessionFileSearchResponse = {
        sessionId,
        projectPath,
        query,
        files: searchProjectFiles(files, query, limit),
        unavailableReason: null,
      };
      return c.json(response);
    } catch {
      const response: SessionFileSearchResponse = {
        sessionId,
        projectPath,
        query,
        files: [],
        unavailableReason: "Failed to search project files.",
      };
      return c.json(response);
    }
  });

  app.get("/api/sessions/:id/file-content", async (c) => {
    const sessionId = c.req.param("id")?.trim();
    if (!sessionId) {
      return c.json({ error: "session id is required" }, 400);
    }

    const relativePathRaw = c.req.query("path");
    if (!relativePathRaw) {
      return c.json({ error: "path query is required" }, 400);
    }
    const pageRaw = c.req.query("page");
    const page = pageRaw ? Number.parseInt(pageRaw, 10) : 1;
    if (!Number.isFinite(page) || page < 1) {
      return c.json({ error: "page query must be a positive integer" }, 400);
    }

    const relativePath = normalizeRelativeProjectPath(relativePathRaw);
    if (!relativePath) {
      return c.json({ error: "path query is invalid" }, 400);
    }

    if (splitPathSegments(relativePath).includes(".git")) {
      return c.json({ error: "path is outside allowed tree" }, 403);
    }

    const projectPath = await resolveSessionProjectPath(sessionId);
    if (projectPath === undefined) {
      return c.json({ error: "session not found" }, 404);
    }

    if (!projectPath) {
      const response: SessionFileContentResponse = {
        sessionId,
        projectPath: null,
        path: relativePath,
        content: "",
        page: 1,
        totalPages: 1,
        paginationMode: "bytes",
        lineStart: null,
        lineEnd: null,
        isBinary: false,
        previewKind: null,
        previewMediaType: null,
        previewDataUrl: null,
        previewUnavailableReason: null,
        unavailableReason: "Session has no project directory.",
      };
      return c.json(response);
    }

    const absolutePath = resolve(projectPath, relativePath);
    if (!isPathWithinDirectory(absolutePath, projectPath)) {
      return c.json({ error: "path is outside project directory" }, 403);
    }

    try {
      const contentPage = await readProjectFilePage(absolutePath, page);
      const response: SessionFileContentResponse = {
        sessionId,
        projectPath,
        path: relativePath,
        content: contentPage.content,
        page: contentPage.page,
        totalPages: contentPage.totalPages,
        paginationMode: contentPage.paginationMode,
        lineStart: contentPage.lineStart,
        lineEnd: contentPage.lineEnd,
        isBinary: contentPage.isBinary,
        previewKind: contentPage.previewKind,
        previewMediaType: contentPage.previewMediaType,
        previewDataUrl: contentPage.previewDataUrl,
        previewUnavailableReason: contentPage.previewUnavailableReason,
        unavailableReason: null,
      };
      return c.json(response);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) {
        const errorCode = (error as { code?: string }).code;
        if (errorCode === "ENOENT") {
          return c.json({ error: "file not found" }, 404);
        }
      }

      const response: SessionFileContentResponse = {
        sessionId,
        projectPath,
        path: relativePath,
        content: "",
        page: 1,
        totalPages: 1,
        paginationMode: "bytes",
        lineStart: null,
        lineEnd: null,
        isBinary: false,
        previewKind: null,
        previewMediaType: null,
        previewDataUrl: null,
        previewUnavailableReason: null,
        unavailableReason: "Failed to read file content.",
      };
      return c.json(response);
    }
  });

  app.get("/api/workflow-project/:key/file-content", async (c) => {
    const workflowKey = c.req.param("key")?.trim();
    if (!workflowKey) {
      return c.json({ error: "workflow key is required" }, 400);
    }
    if (workflowRouteUnavailable(c.req.raw.headers)) {
      return c.json(
        { error: "Workflow pane is unavailable in remote mode." },
        501,
      );
    }

    const relativePathRaw = c.req.query("path");
    if (!relativePathRaw) {
      return c.json({ error: "path query is required" }, 400);
    }
    const pageRaw = c.req.query("page");
    const page = pageRaw ? Number.parseInt(pageRaw, 10) : 1;
    if (!Number.isFinite(page) || page < 1) {
      return c.json({ error: "page query must be a positive integer" }, 400);
    }

    const relativePath = normalizeRelativeProjectPath(relativePathRaw);
    if (!relativePath) {
      return c.json({ error: "path query is invalid" }, 400);
    }

    if (splitPathSegments(relativePath).includes(".git")) {
      return c.json({ error: "path is outside allowed tree" }, 403);
    }

    const projectPath = await resolveWorkflowProjectPath(workflowKey);
    if (projectPath === undefined) {
      return c.json({ error: "workflow not found" }, 404);
    }

    if (!projectPath) {
      const response: SessionFileContentResponse = {
        sessionId: workflowKey,
        projectPath: null,
        path: relativePath,
        content: "",
        page: 1,
        totalPages: 1,
        paginationMode: "bytes",
        lineStart: null,
        lineEnd: null,
        isBinary: false,
        previewKind: null,
        previewMediaType: null,
        previewDataUrl: null,
        previewUnavailableReason: null,
        unavailableReason: "Workflow has no project directory.",
      };
      return c.json(response);
    }

    const absolutePath = resolve(projectPath, relativePath);
    if (!isPathWithinDirectory(absolutePath, projectPath)) {
      return c.json({ error: "path is outside project directory" }, 403);
    }

    try {
      const contentPage = await readProjectFilePage(absolutePath, page);
      const response: SessionFileContentResponse = {
        sessionId: workflowKey,
        projectPath,
        path: relativePath,
        content: contentPage.content,
        page: contentPage.page,
        totalPages: contentPage.totalPages,
        paginationMode: contentPage.paginationMode,
        lineStart: contentPage.lineStart,
        lineEnd: contentPage.lineEnd,
        isBinary: contentPage.isBinary,
        previewKind: contentPage.previewKind,
        previewMediaType: contentPage.previewMediaType,
        previewDataUrl: contentPage.previewDataUrl,
        previewUnavailableReason: contentPage.previewUnavailableReason,
        unavailableReason: null,
      };
      return c.json(response);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) {
        const errorCode = (error as { code?: string }).code;
        if (errorCode === "ENOENT") {
          return c.json({ error: "file not found" }, 404);
        }
      }

      const response: SessionFileContentResponse = {
        sessionId: workflowKey,
        projectPath,
        path: relativePath,
        content: "",
        page: 1,
        totalPages: 1,
        paginationMode: "bytes",
        lineStart: null,
        lineEnd: null,
        isBinary: false,
        previewKind: null,
        previewMediaType: null,
        previewDataUrl: null,
        previewUnavailableReason: null,
        unavailableReason: "Failed to read file content.",
      };
      return c.json(response);
    }
  });

  app.get("/api/sessions/:id/skills", async (c) => {
    const sessionId = c.req.param("id")?.trim();
    if (!sessionId) {
      return c.json({ error: "session id is required" }, 400);
    }

    const projectPath = await resolveSessionProjectPath(sessionId);
    if (projectPath === undefined) {
      return c.json({ error: "session not found" }, 404);
    }

    if (!projectPath) {
      const response: SessionSkillsResponse = {
        sessionId,
        projectPath: null,
        cwd: null,
        skills: [],
        errors: [],
        unavailableReason: "Session has no project directory.",
      };
      return c.json(response);
    }

    try {
      const projectStat = await stat(projectPath);
      if (!projectStat.isDirectory()) {
        const response: SessionSkillsResponse = {
          sessionId,
          projectPath,
          cwd: projectPath,
          skills: [],
          errors: [],
          unavailableReason: "Project directory is unavailable.",
        };
        return c.json(response);
      }
    } catch {
      const response: SessionSkillsResponse = {
        sessionId,
        projectPath,
        cwd: projectPath,
        skills: [],
        errors: [],
        unavailableReason: "Project directory is unavailable.",
      };
      return c.json(response);
    }

    const listSkills = getCodexAppServerClient().listSkills;
    if (typeof listSkills !== "function") {
      return c.json(
        {
          error: "Skills listing is unavailable.",
        },
        501,
      );
    }

    try {
      const entries = await listSkills({
        cwd: projectPath,
      });
      const selectedEntry =
        entries.find((entry) => entry.cwd === projectPath) ??
        entries[0] ??
        null;

      const response: SessionSkillsResponse = {
        sessionId,
        projectPath,
        cwd: selectedEntry?.cwd ?? projectPath,
        skills: selectedEntry?.skills ?? [],
        errors: selectedEntry?.errors ?? [],
        unavailableReason: null,
      };
      return c.json(response);
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.get("/api/workflow-project/:key/skills", async (c) => {
    const workflowKey = c.req.param("key")?.trim();
    if (!workflowKey) {
      return c.json({ error: "workflow key is required" }, 400);
    }
    if (workflowRouteUnavailable(c.req.raw.headers)) {
      return c.json(
        { error: "Workflow pane is unavailable in remote mode." },
        501,
      );
    }

    const projectPath = await resolveWorkflowProjectPath(workflowKey);
    if (projectPath === undefined) {
      return c.json({ error: "workflow not found" }, 404);
    }

    if (!projectPath) {
      const response: SessionSkillsResponse = {
        sessionId: workflowKey,
        projectPath: null,
        cwd: null,
        skills: [],
        errors: [],
        unavailableReason: "Workflow has no project directory.",
      };
      return c.json(response);
    }

    try {
      const projectStat = await stat(projectPath);
      if (!projectStat.isDirectory()) {
        const response: SessionSkillsResponse = {
          sessionId: workflowKey,
          projectPath,
          cwd: projectPath,
          skills: [],
          errors: [],
          unavailableReason: "Project directory is unavailable.",
        };
        return c.json(response);
      }
    } catch {
      const response: SessionSkillsResponse = {
        sessionId: workflowKey,
        projectPath,
        cwd: projectPath,
        skills: [],
        errors: [],
        unavailableReason: "Project directory is unavailable.",
      };
      return c.json(response);
    }

    const listSkills = getCodexAppServerClient().listSkills;
    if (typeof listSkills !== "function") {
      return c.json(
        {
          error: "Skills listing is unavailable.",
        },
        501,
      );
    }

    try {
      const entries = await listSkills({
        cwd: projectPath,
      });
      const selectedEntry =
        entries.find((entry) => entry.cwd === projectPath) ??
        entries[0] ??
        null;

      const response: SessionSkillsResponse = {
        sessionId: workflowKey,
        projectPath,
        cwd: selectedEntry?.cwd ?? projectPath,
        skills: selectedEntry?.skills ?? [],
        errors: selectedEntry?.errors ?? [],
        unavailableReason: null,
      };
      return c.json(response);
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/workflow-project/:key/skills/config", async (c) => {
    const workflowKey = c.req.param("key")?.trim();
    if (!workflowKey) {
      return c.json({ error: "workflow key is required" }, 400);
    }
    if (workflowRouteUnavailable(c.req.raw.headers)) {
      return c.json(
        { error: "Workflow pane is unavailable in remote mode." },
        501,
      );
    }

    if ((await resolveWorkflowProjectPath(workflowKey)) === undefined) {
      return c.json({ error: "workflow not found" }, 404);
    }

    let body: Partial<SessionSkillConfigWriteRequest>;
    try {
      body = (await c.req.json()) as Partial<SessionSkillConfigWriteRequest>;
    } catch {
      return c.json({ error: "invalid json body" }, 400);
    }
    const path = typeof body.path === "string" ? body.path.trim() : "";
    if (!path) {
      return c.json({ error: "path is required" }, 400);
    }
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled must be a boolean" }, 400);
    }

    const writeSkillConfig = getCodexAppServerClient().writeSkillConfig;
    if (typeof writeSkillConfig !== "function") {
      return c.json(
        {
          error: "Skill configuration updates are unavailable.",
        },
        501,
      );
    }

    try {
      const result = await writeSkillConfig(path, body.enabled);
      const response: SessionSkillConfigWriteResponse = {
        sessionId: workflowKey,
        path,
        enabled: body.enabled,
        effectiveEnabled: result.effectiveEnabled,
      };
      return c.json(response);
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/sessions/:id/skills/config", async (c) => {
    const sessionId = c.req.param("id")?.trim();
    if (!sessionId) {
      return c.json({ error: "session id is required" }, 400);
    }

    if ((await resolveSessionProjectPath(sessionId)) === undefined) {
      return c.json({ error: "session not found" }, 404);
    }

    let body: Partial<SessionSkillConfigWriteRequest>;
    try {
      body = (await c.req.json()) as Partial<SessionSkillConfigWriteRequest>;
    } catch {
      return c.json({ error: "invalid json body" }, 400);
    }
    const path = typeof body.path === "string" ? body.path.trim() : "";
    if (!path) {
      return c.json({ error: "path is required" }, 400);
    }
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled must be a boolean" }, 400);
    }

    const writeSkillConfig = getCodexAppServerClient().writeSkillConfig;
    if (typeof writeSkillConfig !== "function") {
      return c.json(
        {
          error: "Skill configuration updates are unavailable.",
        },
        501,
      );
    }

    try {
      const result = await writeSkillConfig(path, body.enabled);
      const response: SessionSkillConfigWriteResponse = {
        sessionId,
        path,
        enabled: body.enabled,
        effectiveEnabled: result.effectiveEnabled,
      };
      emitSkillsChanged({
        ...response,
        timestampMs: Date.now(),
      });
      return c.json(response);
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.get("/api/conversation/:id", async (c) => {
    const sessionId = c.req.param("id");
    const messages = await getConversation(sessionId);
    return c.json(messages);
  });

  app.get("/api/conversation/:id/chunk", async (c) => {
    const sessionId = c.req.param("id");
    const offsetParam = c.req.query("offset");
    const parsedOffset = offsetParam ? parseInt(offsetParam, 10) : 0;
    const offset =
      Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;

    const maxPayloadBytesParam = c.req.query("maxPayloadBytes");
    const parsedMaxPayloadBytes = maxPayloadBytesParam
      ? parseInt(maxPayloadBytesParam, 10)
      : DEFAULT_CONVERSATION_CHUNK_MAX_BYTES;
    const maxPayloadBytes =
      Number.isFinite(parsedMaxPayloadBytes) && parsedMaxPayloadBytes > 0
        ? parsedMaxPayloadBytes
        : DEFAULT_CONVERSATION_CHUNK_MAX_BYTES;

    const chunk = await getConversationStream(sessionId, offset, {
      maxPayloadBytes,
    });
    return c.json(chunk);
  });

  app.get("/api/conversation/:id/raw-chunk", async (c) => {
    const sessionId = c.req.param("id");
    const offsetParam = c.req.query("offset");
    const parsedOffset = offsetParam ? parseInt(offsetParam, 10) : 0;
    const offset =
      Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;

    const maxBytesParam = c.req.query("maxBytes");
    const parsedMaxBytes = maxBytesParam
      ? parseInt(maxBytesParam, 10)
      : DEFAULT_CONVERSATION_RAW_CHUNK_MAX_BYTES;
    const maxBytes =
      Number.isFinite(parsedMaxBytes) && parsedMaxBytes > 0
        ? parsedMaxBytes
        : DEFAULT_CONVERSATION_RAW_CHUNK_MAX_BYTES;

    const chunk = await getConversationRawChunk(sessionId, offset, maxBytes);
    return c.json(chunk satisfies ConversationRawChunkResponse);
  });

  app.get("/api/conversation/:id/window", async (c) => {
    const sessionId = c.req.param("id");
    const beforeOffsetParam = c.req.query("beforeOffset");
    const parsedBeforeOffset = beforeOffsetParam
      ? parseInt(beforeOffsetParam, 10)
      : NaN;
    const beforeOffset =
      Number.isFinite(parsedBeforeOffset) && parsedBeforeOffset >= 0
        ? parsedBeforeOffset
        : undefined;

    const maxBytesParam = c.req.query("maxBytes");
    const parsedMaxBytes = maxBytesParam
      ? parseInt(maxBytesParam, 10)
      : DEFAULT_CONVERSATION_RAW_CHUNK_MAX_BYTES;
    const maxBytes =
      Number.isFinite(parsedMaxBytes) && parsedMaxBytes > 0
        ? parsedMaxBytes
        : DEFAULT_CONVERSATION_RAW_CHUNK_MAX_BYTES;

    const window = await getConversationRawWindow(
      sessionId,
      beforeOffset,
      maxBytes,
    );
    return c.json(window satisfies ConversationRawWindowResponse);
  });

  app.get("/api/conversation/:id/stream", async (c) => {
    const sessionId = c.req.param("id");
    const offsetParam = c.req.query("offset");
    const parsedOffset = offsetParam ? parseInt(offsetParam, 10) : 0;
    let offset =
      Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;

    return streamSSE(c, async (stream) => {
      let isConnected = true;
      const disconnectController = new AbortController();

      const writeConversationBatches = async (
        emitWhenEmpty: boolean,
      ): Promise<void> => {
        let firstBatch = true;

        while (isConnected) {
          const previousOffset = offset;
          const {
            messages: batchMessages,
            nextOffset: batchNextOffset,
            done,
          } = await getConversationStream(sessionId, offset);
          offset = batchNextOffset;

          if (
            (emitWhenEmpty && firstBatch) ||
            batchMessages.length > 0 ||
            batchNextOffset > previousOffset
          ) {
            await stream.writeSSE({
              event: "messages",
              data: JSON.stringify({
                messages: batchMessages,
                nextOffset: batchNextOffset,
                done,
              }),
            });
          }

          if (done || batchNextOffset <= previousOffset) {
            break;
          }

          firstBatch = false;
        }
      };

      const cleanup = () => {
        if (!isConnected) {
          return;
        }
        isConnected = false;
        disconnectController.abort();
        offSessionChange(handleSessionChange);
      };

      const handleSessionChange = async (changedSessionId: string) => {
        if (changedSessionId !== sessionId || !isConnected) {
          return;
        }

        try {
          await writeConversationBatches(false);
        } catch {
          cleanup();
        }
      };

      onSessionChange(handleSessionChange);
      stream.onAbort(cleanup);
      c.req.raw.signal.addEventListener("abort", cleanup, { once: true });

      try {
        await writeConversationBatches(true);

        while (isConnected) {
          await stream.writeSSE({
            event: "heartbeat",
            data: JSON.stringify({ timestamp: Date.now() }),
          });
          await waitForAbortableTimeout(30000, disconnectController.signal);
        }
      } catch {
        // Connection closed
      } finally {
        cleanup();
      }
    });
  });

  app.get("/api/codex/models", async (c) => {
    try {
      const models = await getCodexAppServerClient().listModels();
      return c.json({ models });
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.get("/api/codex/collaboration-modes", async (c) => {
    try {
      const modes = await getCodexAppServerClient().listCollaborationModes();
      return c.json({ modes });
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.get("/api/codex/defaults", async (c) => {
    try {
      const defaults = await getCodexConfigDefaults();
      return c.json(defaults);
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/codex/threads", async (c) => {
    try {
      const body = (await c.req.json()) as Partial<CreateCodexThreadRequest>;
      const cwd =
        typeof body.cwd === "string" ? normalizeCwdPath(body.cwd) : "";
      if (!cwd) {
        return c.json(
          {
            error: "cwd is required",
          },
          400,
        );
      }

      try {
        const cwdStats = await stat(cwd);
        if (!cwdStats.isDirectory()) {
          return c.json(
            {
              error: `Project path is not a directory: ${cwd}`,
            },
            400,
          );
        }
      } catch (error) {
        const errorCode =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : null;

        if (errorCode === "ENOENT") {
          return c.json(
            {
              error: `Project path does not exist: ${cwd}`,
            },
            400,
          );
        }

        throw error;
      }

      const model = parseOptionalString(body.model);
      if (body.model !== undefined && model === undefined) {
        return c.json({ error: "model must be a string or null" }, 400);
      }

      const effort = parseOptionalEffort(body.effort);
      if (body.effort !== undefined && effort === undefined) {
        return c.json({ error: "effort is invalid" }, 400);
      }

      const threadId = await getCodexAppServerClient().createThread({
        cwd,
        model,
        effort,
      });

      return c.json({ threadId });
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/codex/threads/summaries", async (c) => {
    try {
      const client = getCodexAppServerClient();
      if (!client.getThreadSummary) {
        return c.json(
          {
            error: "Thread summaries are not available for this codex client",
          },
          503,
        );
      }

      const body = (await c.req.json()) as Partial<CodexThreadSummariesRequest>;
      if (!Array.isArray(body.threadIds)) {
        return c.json({ error: "threadIds must be an array" }, 400);
      }

      const threadIds = [...new Set(body.threadIds)]
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);

      if (threadIds.length === 0) {
        const empty: CodexThreadSummariesResponse = { threads: [] };
        return c.json(empty);
      }

      const results = await Promise.allSettled(
        threadIds.map((threadId) => client.getThreadSummary!(threadId)),
      );
      const threads = results
        .filter(
          (result): result is PromiseFulfilledResult<CodexThreadSummary> =>
            result.status === "fulfilled",
        )
        .map((result) => result.value);

      const response: CodexThreadSummariesResponse = {
        threads,
      };
      return c.json(response);
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/codex/threads/:id/name", async (c) => {
    const threadId = c.req.param("id")?.trim();
    if (!threadId) {
      return c.json({ error: "thread id is required" }, 400);
    }

    try {
      const client = getCodexAppServerClient();
      if (!client.setThreadName) {
        return c.json(
          {
            error: "Thread rename is not available for this codex client",
          },
          503,
        );
      }

      const body = (await c.req.json()) as Partial<CodexThreadNameSetRequest>;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) {
        return c.json({ error: "name is required" }, 400);
      }

      await client.setThreadName(threadId, name);
      const response: CodexThreadNameSetResponse = {
        ok: true,
      };
      return c.json(response);
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/codex/threads/:id/fork", async (c) => {
    const threadId = c.req.param("id")?.trim();
    if (!threadId) {
      return c.json({ error: "thread id is required" }, 400);
    }

    try {
      const client = getCodexAppServerClient();
      if (!client.forkThread) {
        return c.json(
          {
            error: "Thread fork is not available for this codex client",
          },
          503,
        );
      }

      const thread = await client.forkThread(threadId);
      const response: CodexThreadForkResponse = {
        thread,
      };
      return c.json(response);
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/codex/threads/:id/compact", async (c) => {
    const threadId = c.req.param("id")?.trim();
    if (!threadId) {
      return c.json({ error: "thread id is required" }, 400);
    }

    try {
      const client = getCodexAppServerClient();
      if (!client.compactThread) {
        return c.json(
          {
            error: "Thread compact is not available for this codex client",
          },
          503,
        );
      }

      await client.compactThread(threadId);
      const response: CodexThreadCompactResponse = {
        ok: true,
      };
      return c.json(response);
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.get("/api/codex/threads/:id/agent-threads", async (c) => {
    const threadId = c.req.param("id")?.trim();
    if (!threadId) {
      return c.json({ error: "thread id is required" }, 400);
    }

    try {
      const client = getCodexAppServerClient();
      if (!client.listLoadedThreadIds || !client.getThreadSummary) {
        return c.json(
          {
            error:
              "Agent thread listing is not available for this codex client",
          },
          503,
        );
      }

      const loadedThreadIds = await client.listLoadedThreadIds();
      const candidateIds = [...new Set([threadId, ...loadedThreadIds])];
      const summaries = await Promise.allSettled(
        candidateIds.map((id) => client.getThreadSummary!(id)),
      );

      const threads = summaries
        .filter(
          (result): result is PromiseFulfilledResult<CodexThreadSummary> =>
            result.status === "fulfilled",
        )
        .map((result) => result.value)
        .sort((left, right) => {
          if (left.threadId === threadId && right.threadId !== threadId) {
            return -1;
          }
          if (right.threadId === threadId && left.threadId !== threadId) {
            return 1;
          }

          const leftUpdated = left.updatedAt ?? 0;
          const rightUpdated = right.updatedAt ?? 0;
          if (rightUpdated !== leftUpdated) {
            return rightUpdated - leftUpdated;
          }

          return left.threadId.localeCompare(right.threadId);
        });

      const response: CodexThreadAgentListResponse = {
        threads,
      };
      return c.json(response);
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/codex/threads/:id/messages", async (c) => {
    const threadId = c.req.param("id")?.trim();
    if (!threadId) {
      return c.json({ error: "thread id is required" }, 400);
    }

    try {
      const body = (await c.req.json()) as Partial<SendCodexMessageRequest>;
      const inputItems = parseSendMessageInputItems(body.input);
      if (body.input !== undefined && inputItems === undefined) {
        return c.json({ error: "input is invalid" }, 400);
      }
      const text = typeof body.text === "string" ? body.text.trim() : "";
      const input =
        inputItems && inputItems.length > 0
          ? inputItems
          : text
            ? [{ type: "text", text } satisfies SendCodexMessageInputItem]
            : [];
      if (input.length === 0) {
        return c.json({ error: "text or input is required" }, 400);
      }

      const cwd = parseOptionalString(body.cwd);
      if (body.cwd !== undefined && cwd === undefined) {
        return c.json({ error: "cwd must be a string" }, 400);
      }
      const normalizedCwd =
        typeof cwd === "string" ? normalizeCwdPath(cwd) : cwd;

      const model = parseOptionalString(body.model);
      if (body.model !== undefined && model === undefined) {
        return c.json({ error: "model must be a string or null" }, 400);
      }

      const effort = parseOptionalEffort(body.effort);
      if (body.effort !== undefined && effort === undefined) {
        return c.json({ error: "effort is invalid" }, 400);
      }

      const serviceTier = parseOptionalServiceTier(body.serviceTier);
      if (body.serviceTier !== undefined && serviceTier === undefined) {
        return c.json({ error: "serviceTier is invalid" }, 400);
      }

      const collaborationMode = parseOptionalCollaborationMode(
        body.collaborationMode,
      );
      if (
        body.collaborationMode !== undefined &&
        collaborationMode === undefined
      ) {
        return c.json({ error: "collaborationMode is invalid" }, 400);
      }

      const result = await getCodexAppServerClient().sendMessage({
        threadId,
        input,
        ...(normalizedCwd ? { cwd: normalizedCwd } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(serviceTier !== undefined ? { serviceTier } : {}),
        ...(effort !== undefined ? { effort } : {}),
        ...(collaborationMode !== undefined ? { collaborationMode } : {}),
      });

      const response: SendCodexMessageResponse = {
        ok: true,
        turnId: result.turnId,
      };
      return c.json(response);
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.get("/api/codex/threads/:id/state", async (c) => {
    const threadId = c.req.param("id")?.trim();
    if (!threadId) {
      return c.json({ error: "thread id is required" }, 400);
    }

    const requestedTurnIdRaw = c.req.query("turnId");
    const requestedTurnId =
      typeof requestedTurnIdRaw === "string" && requestedTurnIdRaw.trim()
        ? requestedTurnIdRaw.trim()
        : null;

    try {
      const state = await getCodexAppServerClient().getThreadState(
        threadId,
        requestedTurnId,
      );
      let response: CodexThreadStateResponse = {
        threadId: state.threadId,
        activeTurnId: state.activeTurnId,
        isGenerating: state.isGenerating,
        requestedTurnId: state.requestedTurnId,
        requestedTurnStatus: state.requestedTurnStatus,
      };

      const hasAmbiguousGeneratingState =
        response.isGenerating &&
        response.activeTurnId === null &&
        response.requestedTurnStatus !== "inProgress";
      if (!response.isGenerating || hasAmbiguousGeneratingState) {
        const waitState = await getSessionWaitStateSafe(threadId);
        if (waitState.isWaiting) {
          logWaitModeDetected(
            "thread-state-fallback",
            threadId,
            requestedTurnId,
            waitState.activeTurnId,
            waitState.danglingTurnIds,
          );

          const requestedTurnStatus =
            response.requestedTurnStatus ??
            (requestedTurnId &&
            waitState.danglingTurnIds.includes(requestedTurnId)
              ? "inProgress"
              : null);

          response = {
            ...response,
            activeTurnId: response.activeTurnId ?? waitState.activeTurnId,
            isGenerating: true,
            requestedTurnStatus,
          };
        } else if (hasAmbiguousGeneratingState) {
          response = {
            ...response,
            activeTurnId: null,
            isGenerating: false,
          };
        }
      }

      return c.json(response);
    } catch (error) {
      if (
        isThreadStateUnavailableError(error) ||
        error instanceof CodexAppServerRpcError ||
        error instanceof CodexAppServerTransportError
      ) {
        console.warn(
          `[codex-deck] degraded thread state response for ${threadId}: ${toErrorMessage(error)}`,
        );
        const waitState = await getSessionWaitStateSafe(threadId);
        if (waitState.isWaiting) {
          logWaitModeDetected(
            "degraded-thread-state",
            threadId,
            requestedTurnId,
            waitState.activeTurnId,
            waitState.danglingTurnIds,
          );
        }

        const response: CodexThreadStateResponse = {
          threadId,
          activeTurnId: waitState.activeTurnId,
          isGenerating: waitState.isWaiting,
          requestedTurnId,
          requestedTurnStatus:
            requestedTurnId &&
            waitState.danglingTurnIds.includes(requestedTurnId)
              ? "inProgress"
              : null,
        };
        return c.json(response);
      }

      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/codex/threads/:id/interrupt", async (c) => {
    const threadId = c.req.param("id")?.trim();
    if (!threadId) {
      return c.json({ error: "thread id is required" }, 400);
    }

    try {
      await getCodexAppServerClient().interruptThread(threadId);
      return c.json({ ok: true });
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.get("/api/codex/threads/:id/requests/user-input", async (c) => {
    const threadId = c.req.param("id")?.trim();
    if (!threadId) {
      return c.json({ error: "thread id is required" }, 400);
    }

    try {
      const requests =
        getCodexAppServerClient().listPendingUserInputRequests(threadId);
      return c.json({ requests: requests as CodexUserInputRequest[] });
    } catch (error) {
      if (
        error instanceof CodexAppServerRpcError ||
        error instanceof CodexAppServerTransportError
      ) {
        console.warn(
          `[codex-deck] degraded user-input requests response for ${threadId}: ${toErrorMessage(error)}`,
        );
        return c.json({ requests: [] });
      }

      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.post(
    "/api/codex/threads/:id/requests/user-input/:requestId/respond",
    async (c) => {
      const threadId = c.req.param("id")?.trim();
      if (!threadId) {
        return c.json({ error: "thread id is required" }, 400);
      }

      const requestId = c.req.param("requestId")?.trim();
      if (!requestId) {
        return c.json({ error: "request id is required" }, 400);
      }

      try {
        const body =
          (await c.req.json()) as Partial<CodexUserInputResponsePayload>;
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          !body.answers ||
          typeof body.answers !== "object" ||
          Array.isArray(body.answers)
        ) {
          return c.json({ error: "response.answers must be an object" }, 400);
        }

        const response: CodexUserInputResponsePayload = {
          answers: body.answers as CodexUserInputResponsePayload["answers"],
        };

        await getCodexAppServerClient().submitUserInput(
          threadId,
          requestId,
          response,
        );

        return c.json({ ok: true });
      } catch (error) {
        const message = toErrorMessage(error);
        const lowered = message.toLowerCase();
        if (lowered.includes("request not found")) {
          return c.json({ error: message }, 404);
        }
        if (lowered.includes("response.answers")) {
          return c.json({ error: message }, 400);
        }

        return c.json(
          {
            error: message,
          },
          responseStatusForError(error),
        );
      }
    },
  );

  app.get("/api/codex/threads/:id/requests/approvals", async (c) => {
    const threadId = c.req.param("id")?.trim();
    if (!threadId) {
      return c.json({ error: "thread id is required" }, 400);
    }

    try {
      const client = getCodexAppServerClient();
      if (typeof client.listPendingApprovalRequests !== "function") {
        return c.json({ requests: [] as CodexApprovalRequest[] });
      }

      const requests = client.listPendingApprovalRequests(threadId);
      return c.json({ requests: requests as CodexApprovalRequest[] });
    } catch (error) {
      if (
        error instanceof CodexAppServerRpcError ||
        error instanceof CodexAppServerTransportError
      ) {
        console.warn(
          `[codex-deck] degraded approval requests response for ${threadId}: ${toErrorMessage(error)}`,
        );
        return c.json({ requests: [] });
      }

      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.post(
    "/api/codex/threads/:id/requests/approvals/:requestId/respond",
    async (c) => {
      const threadId = c.req.param("id")?.trim();
      if (!threadId) {
        return c.json({ error: "thread id is required" }, 400);
      }

      const requestId = c.req.param("requestId")?.trim();
      if (!requestId) {
        return c.json({ error: "request id is required" }, 400);
      }

      try {
        const client = getCodexAppServerClient();
        if (typeof client.submitApproval !== "function") {
          return c.json({ error: "approval requests are not supported" }, 501);
        }

        const body =
          (await c.req.json()) as Partial<CodexApprovalResponsePayload>;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return c.json({ error: "response must be an object" }, 400);
        }

        const response: CodexApprovalResponsePayload = {
          ...(typeof body.decisionId === "string"
            ? { decisionId: body.decisionId }
            : {}),
          ...(body.grant === "allow" || body.grant === "deny"
            ? { grant: body.grant }
            : {}),
          ...(body.scope === "turn" || body.scope === "session"
            ? { scope: body.scope }
            : {}),
        };

        if (
          response.decisionId === undefined &&
          response.grant === undefined &&
          response.scope === undefined
        ) {
          return c.json(
            {
              error:
                "response.decisionId, response.grant, or response.scope is required",
            },
            400,
          );
        }

        await client.submitApproval(threadId, requestId, response);

        return c.json({ ok: true });
      } catch (error) {
        const message = toErrorMessage(error);
        const lowered = message.toLowerCase();
        if (lowered.includes("request not found")) {
          return c.json({ error: message }, 404);
        }
        if (
          lowered.includes("response.decisionid") ||
          lowered.includes("response.grant") ||
          lowered.includes("response.scope") ||
          lowered.includes("response must be an object")
        ) {
          return c.json({ error: message }, 400);
        }

        return c.json(
          {
            error: message,
          },
          responseStatusForError(error),
        );
      }
    },
  );

  const webDistPath = getWebDistPath();

  app.use("/*", serveStatic({ root: webDistPath }));

  app.get("/*", async (c) => {
    const indexPath = join(webDistPath, "index.html");
    try {
      const html = readFileSync(indexPath, "utf-8");
      return c.html(html);
    } catch {
      return c.text("UI not found. Run 'pnpm build' first.", 404);
    }
  });

  const handleHistoryChange = () => {
    invalidateHistoryCache();
    recordSessionDeltaEvent({
      forceFullSnapshot: true,
    });
  };

  const handleSessionChange = (sessionId: string, filePath: string) => {
    addToFileIndex(sessionId, filePath);
    recordSessionDeltaEvent({
      changedSessionIds: [sessionId],
    });
  };

  onHistoryChange(handleHistoryChange);
  onSessionChange(handleSessionChange);

  startWatcher();

  let httpServer: ServerType | null = null;
  let remoteServerClient: RemoteServerClient | null = null;

  return {
    app,
    port,
    start: async () => {
      await loadStorage();
      const openUrl = `http://localhost:${dev ? 12000 : port}/`;

      httpServer = serve({
        fetch: app.fetch,
        port,
        // Bind to IPv4 explicitly. In WSL, binding to Node's default "::"
        // can make localhost forwarding to Windows browsers unreliable.
        hostname: "0.0.0.0",
      });

      if (
        remoteServerUrl &&
        remoteUsername &&
        remotePassword &&
        remoteSetupToken &&
        remoteMachineId
      ) {
        remoteServerClient = new RemoteServerClient({
          serverUrl: remoteServerUrl,
          username: remoteUsername,
          password: remotePassword,
          setupToken: remoteSetupToken,
          machineId: remoteMachineId,
          codexDir: getCodexDir(),
          localPort: port,
          pinnedRealmId: remotePinnedRealmId,
          pinnedOpaqueServerPublicKey: remotePinnedOpaqueServerPublicKey,
          appFetch: async (request) => app.fetch(request),
          internalProxyAccessToken: internalRemoteProxyAccessToken,
        });
        await remoteServerClient.start();
        const firstLoginBootstrapUrl =
          remoteServerClient.getFirstLoginBootstrapUrl();
        if (firstLoginBootstrapUrl) {
          console.log(
            `[codex-deck remote] First-login URL (paste into web app Server URL field): ${firstLoginBootstrapUrl}`,
          );
        }
      }

      console.log(`\n  codex-deck is running at ${openUrl}\n`);
      if (!dev && shouldOpen) {
        open(openUrl).catch(console.error);
      }

      return httpServer;
    },
    stop: () => {
      offHistoryChange(handleHistoryChange);
      offSessionChange(handleSessionChange);
      stopWatcher();
      void closeCodexAppServerClient();
      void closeLocalTerminalManager();
      void remoteServerClient?.stop();
      if (httpServer) {
        httpServer.close();
      }
    },
  };
}

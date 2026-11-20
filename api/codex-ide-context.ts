// IDE context for Codex CLI `/ide` parity.
//
// Ports codex-rs/tui/src/ide_context{.rs,/ipc.rs,/prompt.rs}: the backend runs
// next to the IDE, so it asks the desktop/IDE-extension IPC router for the
// active file, selection and open tabs, and folds them into the outgoing user
// message exactly like the TUI and desktop app do.

import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  CodexIdeContextStatus,
  CodexIdeContextSummary,
  SendCodexMessageInputItem,
} from "./storage";

// The desktop IPC client gives requests 5 seconds to complete (upstream).
export const IDE_CONTEXT_REQUEST_TIMEOUT_MS = 5_000;
export const MAX_IPC_FRAME_BYTES = 256 * 1024 * 1024;
export const IDE_CONTEXT_SOURCE_CLIENT_ID = "codex-deck";
export const PROMPT_REQUEST_BEGIN = "## My request for Codex:";

const MAX_ACTIVE_SELECTION_CHARS = 40_000;
const MAX_OPEN_TABS = 100;
const MAX_OPEN_TABS_CHARS = 20_000;

const OPEN_IDE_HINT =
  "Open this project in VS Code or Cursor with the Codex extension active.";
const IDE_DID_NOT_PROVIDE_CONTEXT_HINT =
  "The IDE extension did not provide context.";
const KEEP_TRYING_HINT = "Codex will keep trying on future messages.";

export interface IdePosition {
  line: number;
  character: number;
}

export interface IdeRange {
  start: IdePosition;
  end: IdePosition;
}

export interface IdeFileDescriptor {
  label: string;
  path: string;
}

export interface IdeActiveFile extends IdeFileDescriptor {
  selection: IdeRange;
  activeSelectionContent: string;
  selections: IdeRange[];
}

export interface IdeContext {
  activeFile: IdeActiveFile | null;
  openTabs: IdeFileDescriptor[];
}

export type IdeContextErrorKind =
  | "connect"
  | "send"
  | "read"
  | "timeout"
  | "invalid-response"
  | "too-large"
  | "request-failed"
  | "unsupported-platform"
  | "no-workspace";

export class IdeContextError extends Error {
  constructor(
    readonly kind: IdeContextErrorKind,
    message: string,
    /** Router error code for `request-failed` (e.g. `no-client-found`). */
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "IdeContextError";
  }
}

function hintWithRetry(message: string): string {
  return `${message} ${KEEP_TRYING_HINT}`;
}

/** Hint shown when `/ide` cannot be enabled (upstream `user_facing_hint`). */
export function ideContextUserFacingHint(error: IdeContextError): string {
  switch (error.kind) {
    case "connect":
      return OPEN_IDE_HINT;
    case "request-failed":
      return error.code === "no-client-found"
        ? OPEN_IDE_HINT
        : `${IDE_DID_NOT_PROVIDE_CONTEXT_HINT} Try /ide again.`;
    case "too-large":
      return "The selected IDE context is too large. Clear any large selection in your IDE and try /ide again.";
    case "send":
      return "Codex could not request IDE context. Try /ide again.";
    case "read":
    case "timeout":
    case "invalid-response":
      return "Codex could not read IDE context. Try /ide again.";
    case "unsupported-platform":
      return "IDE context is not supported on this platform.";
    case "no-workspace":
      return "Select a session with a project directory before using /ide.";
  }
}

/** Hint shown when context is skipped for one message (`prompt_skip_hint`). */
export function ideContextPromptSkipHint(error: IdeContextError): string {
  switch (error.kind) {
    case "too-large":
      return "The selected IDE context is too large. Clear any large selection in your IDE.";
    case "connect":
      return OPEN_IDE_HINT;
    case "timeout":
      return "Codex timed out waiting for IDE context. It will keep trying on future messages.";
    case "request-failed":
      switch (error.code) {
        case "no-client-found":
          return OPEN_IDE_HINT;
        case "client-disconnected":
          return hintWithRetry(
            "The IDE connection changed while Codex was requesting context.",
          );
        case "request-timeout":
          return hintWithRetry("The IDE extension did not answer in time.");
        case "request-version-mismatch":
          return "The connected IDE extension is not compatible with this IDE context request.";
        case "no-handler-for-request":
          return "The connected IDE client does not support IDE context requests.";
        default:
          return hintWithRetry(IDE_DID_NOT_PROVIDE_CONTEXT_HINT);
      }
    case "send":
      return hintWithRetry(
        "Codex lost the IDE connection while requesting context.",
      );
    case "invalid-response":
      return hintWithRetry(
        "Codex received an unexpected IDE context response.",
      );
    case "read":
      return hintWithRetry("Codex could not read IDE context.");
    case "unsupported-platform":
      return "IDE context is not supported on this platform.";
    case "no-workspace":
      return "The session has no project directory for IDE context.";
  }
}

export function primaryIpcSocketPath(codexHome: string): string {
  return join(codexHome, "ipc", "ipc.sock");
}

export function legacyIpcSocketPaths(tempDir: string, uid: number): string[] {
  const ipcDir = join(tempDir, "codex-ipc");
  return uid === 0
    ? [join(ipcDir, "ipc.sock"), join(ipcDir, "ipc-0.sock")]
    : [join(ipcDir, `ipc-${uid}.sock`)];
}

class PathValidationError extends Error {}

/**
 * Mirrors upstream `validate_unix_socket_path`: the socket and its parent
 * directory must belong to the current user and the directory must not be
 * writable by anyone else, so no other account can plant or swap the socket.
 * (Upstream also checks the peer uid with getpeereid/SO_PEERCRED, which Node
 * cannot do; the ownership checks here are what keep foreign listeners out.)
 */
export function validateUnixSocketPath(socketPath: string, uid: number): void {
  const parent = dirname(socketPath);
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.uid !== uid) {
    throw new PathValidationError(
      "IDE context socket directory is not owned by the current user",
    );
  }
  if ((parentStat.mode & 0o022) !== 0) {
    throw new PathValidationError(
      "IDE context socket directory is writable by other users",
    );
  }
  const socketStat = lstatSync(socketPath);
  if (!socketStat.isSocket() || socketStat.uid !== uid) {
    throw new PathValidationError(
      "IDE context socket is not owned by the current user",
    );
  }
}

function isPosition(value: unknown): value is IdePosition {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return [record.line, record.character].every(
    (part) =>
      typeof part === "number" &&
      Number.isInteger(part) &&
      part >= 0 &&
      part <= 0xffffffff,
  );
}

function parseRange(value: unknown): IdeRange | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!isPosition(record.start) || !isPosition(record.end)) return null;
  return {
    start: { line: record.start.line, character: record.start.character },
    end: { line: record.end.line, character: record.end.character },
  };
}

function parseDescriptor(value: unknown): IdeFileDescriptor | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.label !== "string" || typeof record.path !== "string") {
    return null;
  }
  return { label: record.label, path: record.path };
}

/** Same shape rules as upstream's serde `IdeContext` deserializer. */
export function parseIdeContext(value: unknown): IdeContext {
  const invalid = (message: string) =>
    new IdeContextError("invalid-response", message);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("ideContext must be an object");
  }
  const record = value as Record<string, unknown>;
  let activeFile: IdeActiveFile | null = null;
  if (record.activeFile !== undefined && record.activeFile !== null) {
    const descriptor = parseDescriptor(record.activeFile);
    const raw = record.activeFile as Record<string, unknown>;
    const selection = parseRange(raw.selection);
    if (!descriptor || !selection) throw invalid("invalid activeFile");
    const content = raw.activeSelectionContent ?? "";
    if (typeof content !== "string") {
      throw invalid("invalid activeSelectionContent");
    }
    const rawSelections = raw.selections ?? [];
    if (!Array.isArray(rawSelections)) throw invalid("invalid selections");
    const selections = rawSelections.map(parseRange);
    if (selections.some((range) => range === null)) {
      throw invalid("invalid selections");
    }
    activeFile = {
      ...descriptor,
      selection,
      activeSelectionContent: content,
      selections: selections as IdeRange[],
    };
  }
  const rawTabs = record.openTabs ?? [];
  if (!Array.isArray(rawTabs)) throw invalid("invalid openTabs");
  const openTabs = rawTabs.map(parseDescriptor);
  if (openTabs.some((tab) => tab === null)) throw invalid("invalid openTabs");
  return { activeFile, openTabs: openTabs as IdeFileDescriptor[] };
}

function encodeFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/** Incremental reader for u32-LE length-prefixed JSON frames. */
class FrameReader {
  private chunks: Buffer[] = [];
  private buffered = 0;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
  }

  private take(length: number): Buffer {
    const joined =
      this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const out = joined.subarray(0, length);
    const rest = joined.subarray(length);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.buffered = rest.length;
    return out;
  }

  private peekLength(): number | null {
    if (this.buffered < 4) return null;
    if (this.chunks[0].length < 4) {
      this.chunks = [Buffer.concat(this.chunks)];
    }
    return this.chunks[0].readUInt32LE(0);
  }

  next(): unknown | undefined {
    const length = this.peekLength();
    if (length === null) return undefined;
    if (length > MAX_IPC_FRAME_BYTES) {
      throw new IdeContextError(
        "too-large",
        "IDE context response exceeded maximum size",
      );
    }
    if (this.buffered < 4 + length) return undefined;
    const frame = this.take(4 + length).subarray(4);
    try {
      return JSON.parse(frame.toString("utf8"));
    } catch (error) {
      throw new IdeContextError(
        "invalid-response",
        `invalid JSON payload: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function connectSocket(socketPath: string, deadline: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      reject(
        new IdeContextError("timeout", "timed out waiting for IDE context"),
      );
      return;
    }
    const socket = connect({ path: socketPath });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new IdeContextError("timeout", "timed out waiting for IDE context"),
      );
    }, remaining);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      // Keep a listener until the exchange attaches its own handler.
      socket.on("error", () => {});
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
  });
}

function exchange(
  socket: Socket,
  workspaceRoot: string,
  deadline: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const reader = new FrameReader();
    let settled = false;
    const finish = (error: unknown, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners("data");
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const remaining = Math.max(1, deadline - Date.now());
    const timer = setTimeout(
      () =>
        finish(
          new IdeContextError("timeout", "timed out waiting for IDE context"),
        ),
      remaining,
    );
    const write = (message: unknown) => {
      socket.write(encodeFrame(message), (error) => {
        if (error) finish(new IdeContextError("send", error.message));
      });
    };
    const handle = (message: unknown) => {
      const record =
        message && typeof message === "object"
          ? (message as Record<string, unknown>)
          : {};
      const type = record.type;
      const inboundId =
        typeof record.requestId === "string" ? record.requestId : null;
      switch (type) {
        case "response":
          if (inboundId === requestId) finish(null, record);
          return;
        case "broadcast":
        case "client-discovery-response":
          return;
        case "client-discovery-request":
          if (inboundId) {
            write({
              type: "client-discovery-response",
              requestId: inboundId,
              response: { canHandle: false },
            });
          }
          return;
        case "request":
          if (inboundId) {
            write({
              type: "response",
              requestId: inboundId,
              resultType: "error",
              error: "no-handler-for-request",
            });
          }
          return;
        default:
          finish(
            new IdeContextError(
              "invalid-response",
              typeof type === "string"
                ? `unexpected IDE context message type: ${type}`
                : "IDE context message did not include a type",
            ),
          );
      }
    };
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      try {
        reader.push(chunk);
        for (;;) {
          const message = reader.next();
          if (message === undefined || settled) break;
          handle(message);
        }
      } catch (error) {
        finish(error);
      }
    });
    socket.on("error", (error) =>
      finish(new IdeContextError("read", error.message)),
    );
    socket.on("close", () =>
      finish(
        new IdeContextError("read", "failed to fill whole IDE context frame"),
      ),
    );
    write({
      type: "request",
      requestId,
      sourceClientId: IDE_CONTEXT_SOURCE_CLIENT_ID,
      version: 0,
      method: "ide-context",
      params: { workspaceRoot },
    });
  });
}

export function extractIdeContext(response: unknown): IdeContext {
  const record =
    response && typeof response === "object"
      ? (response as Record<string, unknown>)
      : {};
  if (record.resultType === "error") {
    const code =
      typeof record.error === "string" ? record.error : "unknown error";
    throw new IdeContextError(
      "request-failed",
      "IDE context request failed",
      code,
    );
  }
  if (record.resultType !== "success") {
    throw new IdeContextError(
      "invalid-response",
      "response did not include a success or error resultType",
    );
  }
  const result = record.result;
  const ideContext =
    result && typeof result === "object"
      ? (result as Record<string, unknown>).ideContext
      : undefined;
  if (ideContext === undefined) {
    throw new IdeContextError(
      "invalid-response",
      "ide-context response did not include result.ideContext",
    );
  }
  return parseIdeContext(ideContext);
}

export interface FetchIdeContextOptions {
  workspaceRoot: string;
  codexHome: string;
  timeoutMs?: number;
  /** Overrides for tests; defaults follow upstream discovery. */
  socketPaths?: string[];
  uid?: number;
  platform?: NodeJS.Platform;
}

export async function fetchIdeContext(
  options: FetchIdeContextOptions,
): Promise<IdeContext> {
  const platform = options.platform ?? process.platform;
  // Upstream's Windows transport verifies the named-pipe server's token SID,
  // which Node cannot do, so Deck does not connect there.
  if (platform === "win32" || typeof process.getuid !== "function") {
    throw new IdeContextError(
      "unsupported-platform",
      "IDE context is not supported on this platform",
    );
  }
  const uid = options.uid ?? process.getuid();
  const deadline =
    Date.now() + (options.timeoutMs ?? IDE_CONTEXT_REQUEST_TIMEOUT_MS);
  const socketPaths = options.socketPaths ?? [
    primaryIpcSocketPath(options.codexHome),
    ...legacyIpcSocketPaths(tmpdir(), uid),
  ];
  let lastError: unknown = new Error("no IDE IPC socket paths were available");
  let socket: Socket | null = null;
  for (const socketPath of socketPaths) {
    try {
      validateUnixSocketPath(socketPath, uid);
      socket = await connectSocket(socketPath, deadline);
      break;
    } catch (error) {
      if (error instanceof IdeContextError && error.kind === "timeout") {
        throw new IdeContextError("connect", error.message);
      }
      if (Date.now() >= deadline) {
        throw new IdeContextError(
          "connect",
          "IDE IPC connection exhausted the request deadline",
        );
      }
      lastError = error;
    }
  }
  if (!socket) {
    throw new IdeContextError(
      "connect",
      `failed to connect to IDE context provider: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }
  const response = await exchange(socket, options.workspaceRoot, deadline);
  return extractIdeContext(response);
}

function isEmptyRange(range: IdeRange): boolean {
  return (
    range.start.line === range.end.line &&
    range.start.character === range.end.character
  );
}

function nonEmptyRanges(activeFile: IdeActiveFile): IdeRange[] {
  const ranges =
    activeFile.selections.length > 0
      ? activeFile.selections
      : [activeFile.selection];
  return ranges.filter((range) => !isEmptyRange(range));
}

/** Port of upstream `render_prompt_context`; null when there is nothing to add. */
export function renderIdeContextPrompt(context: IdeContext): string | null {
  let section = "";
  const activeFile = context.activeFile;
  if (activeFile) {
    section += `\n## Active file: ${activeFile.path}\n`;
    const ranges = nonEmptyRanges(activeFile);
    if (
      ranges.length > 0 &&
      (activeFile.activeSelectionContent.length === 0 || ranges.length > 1)
    ) {
      section +=
        ranges.length === 1
          ? "\n## Active selection range:\n"
          : "\n## Active selection ranges:\n";
      for (const range of ranges) {
        section += `- ${activeFile.path}: line ${range.start.line + 1}, column ${range.start.character + 1} to line ${range.end.line + 1}, column ${range.end.character + 1}\n`;
      }
    }
    if (activeFile.activeSelectionContent.length > 0) {
      section += "\n## Active selection of the file:\n";
      const chars = Array.from(activeFile.activeSelectionContent);
      if (chars.length > MAX_ACTIVE_SELECTION_CHARS) {
        section += chars.slice(0, MAX_ACTIVE_SELECTION_CHARS).join("");
        section += `\n[Selection truncated to ${MAX_ACTIVE_SELECTION_CHARS} characters.]\n`;
      } else {
        section += activeFile.activeSelectionContent;
      }
    }
  }
  if (context.openTabs.length > 0) {
    section += "\n## Open tabs:\n";
    let renderedTabs = 0;
    let renderedBytes = 0;
    for (const tab of context.openTabs) {
      if (renderedTabs >= MAX_OPEN_TABS) break;
      const line = `- ${tab.label}: ${tab.path}\n`;
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (renderedBytes + lineBytes > MAX_OPEN_TABS_CHARS) break;
      section += line;
      renderedTabs += 1;
      renderedBytes += lineBytes;
    }
    const omitted = context.openTabs.length - renderedTabs;
    if (omitted > 0) section += `[${omitted} open tabs omitted.]\n`;
  }
  return section ? `# Context from my IDE setup:\n${section}` : null;
}

/**
 * Port of `apply_ide_context_to_user_input`: prefix the first text item (or
 * insert one) with the context and the desktop request delimiter.
 */
export function applyIdeContextToInput(
  context: IdeContext,
  input: SendCodexMessageInputItem[],
): { input: SendCodexMessageInputItem[]; applied: boolean } {
  const contextText = renderIdeContextPrompt(context);
  if (!contextText) return { input, applied: false };
  const prefix = `${contextText}\n${PROMPT_REQUEST_BEGIN}\n`;
  const textIndex = input.findIndex((item) => item.type === "text");
  if (textIndex < 0) {
    return { input: [{ type: "text", text: prefix }, ...input], applied: true };
  }
  const next = input.slice();
  const item = next[textIndex] as { type: "text"; text: string };
  next[textIndex] = { type: "text", text: `${prefix}${item.text}` };
  return { input: next, applied: true };
}

export type IdeContextSummary = CodexIdeContextSummary;

const SUMMARY_MAX_TABS = 20;

/** What the browser may show; selection text itself stays on the backend. */
export function summarizeIdeContext(context: IdeContext): IdeContextSummary {
  const activeFile = context.activeFile;
  return {
    activeFile: activeFile
      ? { label: activeFile.label, path: activeFile.path }
      : null,
    selections: activeFile
      ? nonEmptyRanges(activeFile).map((range) => ({
          startLine: range.start.line + 1,
          startColumn: range.start.character + 1,
          endLine: range.end.line + 1,
          endColumn: range.end.character + 1,
        }))
      : [],
    selectionChars: activeFile
      ? Array.from(activeFile.activeSelectionContent).length
      : 0,
    openTabs: context.openTabs.slice(0, SUMMARY_MAX_TABS),
    openTabCount: context.openTabs.length,
    hasPromptContext: renderIdeContextPrompt(context) !== null,
  };
}

export type IdeContextStatus = CodexIdeContextStatus;

export function toIdeContextError(error: unknown): IdeContextError {
  if (error instanceof IdeContextError) return error;
  return new IdeContextError(
    "read",
    error instanceof Error ? error.message : String(error),
  );
}

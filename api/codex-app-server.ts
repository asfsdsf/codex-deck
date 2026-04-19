import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MODEL_LIMIT = 200;
const MODELS_CACHE_TTL_MS = 30_000;
const COLLABORATION_MODES_CACHE_TTL_MS = 30_000;
const THREAD_STATE_CACHE_TTL_MS = 250;

export type CodexReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type CodexServiceTier = "fast" | "flex";

export interface CodexModelOption {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  hidden: boolean;
  defaultReasoningEffort: CodexReasoningEffort | null;
  supportedReasoningEfforts: CodexReasoningEffort[];
}

export interface CodexCollaborationModeSettings {
  model?: string | null;
  reasoningEffort?: CodexReasoningEffort | null;
  developerInstructions?: string | null;
}

export interface CodexCollaborationModeOption {
  mode: string;
  name: string;
  model?: string | null;
  reasoningEffort?: CodexReasoningEffort | null;
  developerInstructions?: string | null;
}

export interface CodexCollaborationModeInput {
  mode: string;
  settings?: CodexCollaborationModeSettings;
}

export type CodexSkillScope = "user" | "repo" | "system" | "admin" | "unknown";

export interface CodexSkillInterface {
  displayName: string | null;
  shortDescription: string | null;
  iconSmall: string | null;
  iconLarge: string | null;
  brandColor: string | null;
  defaultPrompt: string | null;
}

export interface CodexSkillToolDependency {
  type: string;
  value: string;
  description: string | null;
  transport: string | null;
  command: string | null;
  url: string | null;
}

export interface CodexSkillDependencies {
  tools: CodexSkillToolDependency[];
}

export interface CodexSkillMetadata {
  name: string;
  description: string;
  shortDescription: string | null;
  interface: CodexSkillInterface | null;
  dependencies: CodexSkillDependencies | null;
  path: string;
  scope: CodexSkillScope;
  enabled: boolean;
}

export interface CodexSkillErrorInfo {
  path: string;
  message: string;
}

export interface CodexSkillsListEntry {
  cwd: string;
  skills: CodexSkillMetadata[];
  errors: CodexSkillErrorInfo[];
}

export interface CodexSkillsListInput {
  cwd: string;
  forceReload?: boolean;
}

export interface CodexSkillsConfigWriteResult {
  effectiveEnabled: boolean;
}

export interface CreateCodexThreadInput {
  cwd: string;
  model?: string | null;
  effort?: CodexReasoningEffort | null;
}

export interface SendCodexMessageInput {
  threadId: string;
  text?: string;
  input?: SendCodexInputItem[];
  cwd?: string;
  model?: string | null;
  serviceTier?: CodexServiceTier | null;
  effort?: CodexReasoningEffort | null;
  collaborationMode?: CodexCollaborationModeInput | null;
}

export type SendCodexInputItem =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      url: string;
    };

export interface SendCodexMessageResult {
  turnId: string | null;
}

export type CodexTurnStatus =
  | "inProgress"
  | "completed"
  | "failed"
  | "interrupted";

export interface CodexThreadState {
  threadId: string;
  activeTurnId: string | null;
  isGenerating: boolean;
  requestedTurnId: string | null;
  requestedTurnStatus: CodexTurnStatus | null;
}

export type CodexThreadRuntimeStatus =
  | "notLoaded"
  | "idle"
  | "systemError"
  | "active"
  | "unknown";

export interface CodexThreadSummary {
  threadId: string;
  name: string | null;
  preview: string;
  cwd: string;
  agentNickname: string | null;
  agentRole: string | null;
  status: CodexThreadRuntimeStatus;
  updatedAt: number | null;
}

type JsonRpcRequestId = string | number;

export interface CodexUserInputQuestionOption {
  label: string;
  description: string;
}

export interface CodexUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: CodexUserInputQuestionOption[];
}

export interface CodexUserInputRequest {
  requestId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  questions: CodexUserInputQuestion[];
}

export interface CodexUserInputResponsePayload {
  answers: Record<string, { answers: string[] }>;
}

export type CodexApprovalRequestKind =
  | "commandExecution"
  | "fileChange"
  | "permissions";

export type CodexApprovalScope = "turn" | "session";

export interface CodexApprovalDecisionOption {
  id: string;
  label: string;
  description: string;
}

export interface CodexApprovalRequest {
  requestId: string;
  threadId: string;
  turnId: string | null;
  itemId: string;
  kind: CodexApprovalRequestKind;
  reason: string | null;
  command: string | null;
  cwd: string | null;
  permissions: Record<string, unknown> | null;
  availableDecisions: CodexApprovalDecisionOption[];
}

export interface CodexApprovalResponsePayload {
  decisionId?: string;
  grant?: "allow" | "deny";
  scope?: CodexApprovalScope;
}

export interface CodexLiveTerminalRun {
  threadId: string;
  processId: string;
  callId: string;
  command: string;
  output: string;
  isRunning: boolean;
  updatedAt: number;
}

interface PendingUserInputRequest {
  requestId: string;
  rawRequestId: JsonRpcRequestId;
  threadId: string;
  turnId: string;
  itemId: string;
  questions: CodexUserInputQuestion[];
}

interface PendingApprovalDecisionOption extends CodexApprovalDecisionOption {
  decision: unknown;
}

interface PendingApprovalRequest {
  requestId: string;
  rawRequestId: JsonRpcRequestId;
  threadId: string;
  turnId: string | null;
  itemId: string;
  kind: CodexApprovalRequestKind;
  reason: string | null;
  command: string | null;
  cwd: string | null;
  permissions: Record<string, unknown> | null;
  availableDecisions: PendingApprovalDecisionOption[];
}

interface AppServerTurnRecord {
  id?: unknown;
  status?: unknown;
  items?: unknown;
}

interface AppServerThreadRecord {
  id?: unknown;
  name?: unknown;
  preview?: unknown;
  cwd?: unknown;
  agentNickname?: unknown;
  agentRole?: unknown;
  status?: unknown;
  updatedAt?: unknown;
}

export interface CodexTurnFileDiff {
  path: string;
  diff: string;
  kind: string;
}

export interface CodexLastTurnDiff {
  threadId: string;
  turnId: string | null;
  files: CodexTurnFileDiff[];
}

export class CodexAppServerRpcError extends Error {
  public readonly code: number;
  public readonly data: unknown;

  public constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "CodexAppServerRpcError";
    this.code = code;
    this.data = data;
  }
}

export class CodexAppServerTransportError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CodexAppServerTransportError";
  }
}

interface PendingRequest {
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface ReadCacheEntry<T> {
  value: T;
  expiresAt: number;
}

function sanitizeAppServerJsonText(text: string): string {
  let result = "";
  let inString = false;
  let escapeNext = false;

  for (const char of text) {
    if (inString) {
      if (escapeNext) {
        result += char;
        escapeNext = false;
        continue;
      }

      if (char === "\\") {
        result += char;
        escapeNext = true;
        continue;
      }

      if (char === '"') {
        result += char;
        inString = false;
        continue;
      }

      const code = char.charCodeAt(0);
      if (code <= 0x1f) {
        if (char === "\n") {
          result += "\\n";
        } else if (char === "\r") {
          result += "\\r";
        } else if (char === "\t") {
          result += "\\t";
        } else {
          result += `\\u${code.toString(16).padStart(4, "0")}`;
        }
        continue;
      }

      result += char;
      continue;
    }

    result += char;
    if (char === '"') {
      inString = true;
    }
  }

  return result;
}

function parseAppServerJsonMessage(
  text: string,
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    const sanitized = sanitizeAppServerJsonText(text);
    if (sanitized === text) {
      console.error(
        `[codex-deck] failed to parse app-server stdout message: ${text.slice(0, 200)}`,
      );
      return null;
    }

    try {
      const parsed = JSON.parse(sanitized);
      console.warn(
        "[codex-deck] recovered app-server stdout message containing raw control characters",
      );
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      console.error(
        `[codex-deck] failed to parse sanitized app-server stdout message: ${sanitized.slice(0, 200)}`,
      );
      return null;
    }
  }
}

class AppServerStdoutMessageParser {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private scanIndex = 0;
  private objectStart = -1;
  private depth = 0;
  private inString = false;
  private escapeNext = false;

  public push(chunk: Buffer | string): Record<string, unknown>[] {
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    return this.pushText(text);
  }

  public finish(): Record<string, unknown>[] {
    const trailing = this.decoder.end();
    const messages = trailing ? this.pushText(trailing) : [];
    this.reset();
    return messages;
  }

  public reset(): void {
    this.buffer = "";
    this.scanIndex = 0;
    this.objectStart = -1;
    this.depth = 0;
    this.inString = false;
    this.escapeNext = false;
  }

  private pushText(text: string): Record<string, unknown>[] {
    if (!text) {
      return [];
    }

    this.buffer += text;
    const messages: Record<string, unknown>[] = [];

    while (this.scanIndex < this.buffer.length) {
      const char = this.buffer[this.scanIndex];

      if (this.objectStart === -1) {
        if (char === "{") {
          this.objectStart = this.scanIndex;
          this.depth = 1;
          this.inString = false;
          this.escapeNext = false;
        }
        this.scanIndex += 1;
        continue;
      }

      if (this.inString) {
        if (this.escapeNext) {
          this.escapeNext = false;
        } else if (char === "\\") {
          this.escapeNext = true;
        } else if (char === '"') {
          this.inString = false;
        }
        this.scanIndex += 1;
        continue;
      }

      if (char === '"') {
        this.inString = true;
        this.scanIndex += 1;
        continue;
      }

      if (char === "{") {
        this.depth += 1;
        this.scanIndex += 1;
        continue;
      }

      if (char === "}") {
        this.depth -= 1;
        this.scanIndex += 1;

        if (this.depth === 0) {
          const raw = this.buffer.slice(this.objectStart, this.scanIndex);
          const parsed = parseAppServerJsonMessage(raw);
          if (parsed) {
            messages.push(parsed);
          }

          this.buffer = this.buffer.slice(this.scanIndex);
          this.scanIndex = 0;
          this.objectStart = -1;
          this.depth = 0;
          this.inString = false;
          this.escapeNext = false;
        }
        continue;
      }

      this.scanIndex += 1;
    }

    if (this.objectStart === -1 && this.buffer.length > 0) {
      this.buffer = "";
      this.scanIndex = 0;
    }

    return messages;
  }
}

export const __TEST_ONLY__ = {
  AppServerStdoutMessageParser,
  createCodexAppServerSpawnSpec,
  createReadCoalescer,
  pickPreferredWindowsCommandPath,
  resolveWindowsCommandPath,
  sanitizeAppServerJsonText,
};

function createReadCoalescer() {
  const cache = new Map<string, ReadCacheEntry<unknown>>();
  const inFlight = new Map<string, Promise<unknown>>();

  return {
    async getOrLoad<T>(
      key: string,
      ttlMs: number,
      loader: () => Promise<T>,
    ): Promise<T> {
      if (ttlMs > 0) {
        const cached = cache.get(key);
        if (cached && cached.expiresAt > Date.now()) {
          return cached.value as T;
        }
        if (cached) {
          cache.delete(key);
        }
      }

      const existing = inFlight.get(key);
      if (existing) {
        return existing as Promise<T>;
      }

      const promise = (async () => {
        try {
          const value = await loader();
          if (ttlMs > 0) {
            cache.set(key, {
              value,
              expiresAt: Date.now() + ttlMs,
            });
          }
          return value;
        } finally {
          if (inFlight.get(key) === promise) {
            inFlight.delete(key);
          }
        }
      })();

      inFlight.set(key, promise);
      return promise;
    },

    clearKey(key: string): void {
      cache.delete(key);
      inFlight.delete(key);
    },

    clearMatching(matcher: (key: string) => boolean): void {
      for (const key of cache.keys()) {
        if (matcher(key)) {
          cache.delete(key);
        }
      }
      for (const key of inFlight.keys()) {
        if (matcher(key)) {
          inFlight.delete(key);
        }
      }
    },
  };
}

interface SpawnSpec {
  command: string;
  args: string[];
  shell?: boolean;
}

interface CodexAppServerClientOptions {
  executablePath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  userAgent?: string;
}

class CodexAppServerClient {
  private readonly executablePath: string;
  private readonly cwd: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly requestTimeoutMs: number;
  private readonly userAgent: string;

  private process: ChildProcessWithoutNullStreams | null = null;
  private stderrReader: ReadlineInterface | null = null;
  private readonly stdoutMessageParser = new AppServerStdoutMessageParser();
  private initialized = false;
  private initializeInFlight: Promise<void> | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private pendingUserInputRequests = new Map<string, PendingUserInputRequest>();
  private pendingApprovalRequests = new Map<string, PendingApprovalRequest>();
  private liveTerminalRunsByThread = new Map<
    string,
    Map<string, CodexLiveTerminalRun>
  >();
  private liveTerminalProcessByItemByThread = new Map<
    string,
    Map<string, string>
  >();
  private liveTerminalPendingDeltaByItemByThread = new Map<
    string,
    Map<string, string>
  >();
  private readonly readCoalescer = createReadCoalescer();

  public constructor(options: CodexAppServerClientOptions = {}) {
    this.executablePath =
      options.executablePath?.trim() || resolveCodexExecutablePath();
    this.cwd = options.cwd;
    this.env = options.env;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.userAgent = options.userAgent ?? "codex-deck/0.2.4";
  }

  public async listModels(
    limit = DEFAULT_MODEL_LIMIT,
  ): Promise<CodexModelOption[]> {
    return this.readCoalescer.getOrLoad(
      `models:${limit}`,
      MODELS_CACHE_TTL_MS,
      async () => {
        const result = await this.request("model/list", { limit });
        if (!result || typeof result !== "object") {
          throw new CodexAppServerTransportError(
            "Invalid model/list response from codex app-server",
          );
        }

        const data = (result as { data?: unknown }).data;
        if (!Array.isArray(data)) {
          throw new CodexAppServerTransportError(
            "Missing model data in codex app-server response",
          );
        }

        const models: CodexModelOption[] = [];

        for (const entry of data) {
          if (!entry || typeof entry !== "object") {
            continue;
          }

          const record = entry as Record<string, unknown>;
          const fallbackModelName = asString(record.model)?.trim();
          const id = asString(record.id)?.trim() || fallbackModelName;
          if (!id) {
            continue;
          }

          const supported = collectSupportedReasoningEfforts(
            record.supportedReasoningEfforts,
          );

          models.push({
            id,
            displayName: asString(record.displayName)?.trim() || id,
            description: asString(record.description)?.trim() || "",
            isDefault: record.isDefault === true,
            hidden: record.hidden === true,
            defaultReasoningEffort: toReasoningEffort(
              record.defaultReasoningEffort,
            ),
            supportedReasoningEfforts: supported,
          });
        }

        return models;
      },
    );
  }

  public async listCollaborationModes(): Promise<
    CodexCollaborationModeOption[]
  > {
    return this.readCoalescer.getOrLoad(
      "collaboration-modes",
      COLLABORATION_MODES_CACHE_TTL_MS,
      async () => {
        const result = await this.request("collaborationMode/list", {});
        if (!result || typeof result !== "object") {
          throw new CodexAppServerTransportError(
            "Invalid collaborationMode/list response from codex app-server",
          );
        }

        const data = (result as { data?: unknown }).data;
        if (!Array.isArray(data)) {
          throw new CodexAppServerTransportError(
            "Missing collaboration mode data in codex app-server response",
          );
        }

        const modes: CodexCollaborationModeOption[] = [];

        for (const entry of data) {
          if (!entry || typeof entry !== "object") {
            continue;
          }

          const record = entry as Record<string, unknown>;
          const mode = asString(record.mode)?.trim();
          if (!mode) {
            continue;
          }

          const reasoningEffort = toReasoningEffort(
            record.reasoning_effort ?? record.reasoningEffort,
          );

          modes.push({
            mode,
            name: asString(record.name)?.trim() || mode,
            model: asNullableString(record.model),
            ...(reasoningEffort ? { reasoningEffort } : {}),
            developerInstructions: asNullableString(
              record.developer_instructions ?? record.developerInstructions,
            ),
          });
        }

        return modes;
      },
    );
  }

  public async listSkills(
    input: CodexSkillsListInput,
  ): Promise<CodexSkillsListEntry[]> {
    const cwd = input.cwd.trim();
    if (!cwd) {
      throw new Error("cwd is required");
    }

    const result = await this.request("skills/list", {
      cwds: [cwd],
      forceReload: input.forceReload === true,
    });
    if (!result || typeof result !== "object") {
      throw new CodexAppServerTransportError(
        "Invalid skills/list response from codex app-server",
      );
    }

    const data = (result as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      throw new CodexAppServerTransportError(
        "Missing skills data in codex app-server response",
      );
    }

    const entries: CodexSkillsListEntry[] = [];
    for (const entryValue of data) {
      const entryRecord = asRecord(entryValue);
      if (!entryRecord) {
        continue;
      }

      const skills: CodexSkillMetadata[] = [];
      const skillValues = Array.isArray(entryRecord.skills)
        ? entryRecord.skills
        : [];
      for (const skillValue of skillValues) {
        const skillRecord = asRecord(skillValue);
        if (!skillRecord) {
          continue;
        }

        const name = asTrimmedString(skillRecord.name);
        const path = asTrimmedString(skillRecord.path);
        if (!name || !path) {
          continue;
        }

        const interfaceRecord = asRecord(skillRecord.interface);
        const dependenciesRecord = asRecord(skillRecord.dependencies);
        const toolDependencies: CodexSkillToolDependency[] = [];
        if (dependenciesRecord && Array.isArray(dependenciesRecord.tools)) {
          for (const toolValue of dependenciesRecord.tools) {
            const toolRecord = asRecord(toolValue);
            if (!toolRecord) {
              continue;
            }

            const type = asTrimmedString(toolRecord.type);
            const value = asTrimmedString(toolRecord.value);
            if (!type || !value) {
              continue;
            }

            toolDependencies.push({
              type,
              value,
              description: asNullableString(toolRecord.description),
              transport: asNullableString(toolRecord.transport),
              command: asNullableString(toolRecord.command),
              url: asNullableString(toolRecord.url),
            });
          }
        }

        skills.push({
          name,
          description: asString(skillRecord.description)?.trim() || "",
          shortDescription: asNullableString(
            skillRecord.shortDescription ?? skillRecord.short_description,
          ),
          interface: interfaceRecord
            ? {
                displayName: asNullableString(interfaceRecord.displayName),
                shortDescription: asNullableString(
                  interfaceRecord.shortDescription ??
                    interfaceRecord.short_description,
                ),
                iconSmall: asNullableString(
                  interfaceRecord.iconSmall ?? interfaceRecord.icon_small,
                ),
                iconLarge: asNullableString(
                  interfaceRecord.iconLarge ?? interfaceRecord.icon_large,
                ),
                brandColor: asNullableString(
                  interfaceRecord.brandColor ?? interfaceRecord.brand_color,
                ),
                defaultPrompt: asNullableString(
                  interfaceRecord.defaultPrompt ??
                    interfaceRecord.default_prompt,
                ),
              }
            : null,
          dependencies: dependenciesRecord
            ? {
                tools: toolDependencies,
              }
            : null,
          path,
          scope: toSkillScope(skillRecord.scope),
          enabled: skillRecord.enabled !== false,
        });
      }

      const errors: CodexSkillErrorInfo[] = [];
      const errorValues = Array.isArray(entryRecord.errors)
        ? entryRecord.errors
        : [];
      for (const errorValue of errorValues) {
        const errorRecord = asRecord(errorValue);
        if (!errorRecord) {
          continue;
        }
        const path = asTrimmedString(errorRecord.path);
        const message = asTrimmedString(errorRecord.message);
        if (!path || !message) {
          continue;
        }
        errors.push({
          path,
          message,
        });
      }

      entries.push({
        cwd: asTrimmedString(entryRecord.cwd) ?? cwd,
        skills,
        errors,
      });
    }

    return entries;
  }

  public async writeSkillConfig(
    path: string,
    enabled: boolean,
  ): Promise<CodexSkillsConfigWriteResult> {
    const normalizedPath = path.trim();
    if (!normalizedPath) {
      throw new Error("path is required");
    }

    const result = await this.request("skills/config/write", {
      path: normalizedPath,
      enabled,
    });
    if (!result || typeof result !== "object") {
      throw new CodexAppServerTransportError(
        "Invalid skills/config/write response from codex app-server",
      );
    }

    const effectiveEnabled = asBoolean(
      (result as { effectiveEnabled?: unknown }).effectiveEnabled,
    );
    if (effectiveEnabled === null) {
      throw new CodexAppServerTransportError(
        "Missing effectiveEnabled in skills/config/write response",
      );
    }

    return {
      effectiveEnabled,
    };
  }

  public async createThread(input: CreateCodexThreadInput): Promise<string> {
    const cwd = input.cwd.trim();
    if (!cwd) {
      throw new Error("cwd is required");
    }

    const params: Record<string, unknown> = {
      cwd,
      ephemeral: false,
    };

    if (typeof input.model === "string" && input.model.trim()) {
      params.model = input.model.trim();
    }

    // thread/start does not support direct effort override; use config as best effort.
    if (input.effort) {
      params.config = {
        model_reasoning_effort: input.effort,
      };
    }

    const result = await this.request("thread/start", params);
    if (!result || typeof result !== "object") {
      throw new CodexAppServerTransportError(
        "Invalid thread/start response from codex app-server",
      );
    }

    const thread = (result as { thread?: unknown }).thread;
    if (!thread || typeof thread !== "object") {
      throw new CodexAppServerTransportError(
        "Missing thread payload in thread/start response",
      );
    }

    const threadId = asString((thread as Record<string, unknown>).id)?.trim();
    if (!threadId) {
      throw new CodexAppServerTransportError(
        "Missing thread id in thread/start response",
      );
    }

    return threadId;
  }

  public async setThreadName(threadId: string, name: string): Promise<void> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      throw new Error("threadId is required");
    }

    const normalizedName = name.trim();
    if (!normalizedName) {
      throw new Error("name is required");
    }

    const payload = {
      threadId: normalizedThreadId,
      name: normalizedName,
    };

    try {
      await this.request("thread/name/set", payload);
    } catch (error) {
      if (!shouldRetryAfterResume(error)) {
        throw error;
      }

      await this.resumeThread(normalizedThreadId);
      await this.request("thread/name/set", payload);
    }
  }

  public async forkThread(threadId: string): Promise<CodexThreadSummary> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      throw new Error("threadId is required");
    }

    try {
      const result = await this.request("thread/fork", {
        threadId: normalizedThreadId,
        persistExtendedHistory: true,
      });
      return extractThreadSummaryFromResult(result);
    } catch (error) {
      if (!shouldRetryAfterResume(error)) {
        throw error;
      }

      await this.resumeThread(normalizedThreadId);
      const result = await this.request("thread/fork", {
        threadId: normalizedThreadId,
        persistExtendedHistory: true,
      });
      return extractThreadSummaryFromResult(result);
    }
  }

  public async compactThread(threadId: string): Promise<void> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      throw new Error("threadId is required");
    }

    try {
      await this.request("thread/compact/start", {
        threadId: normalizedThreadId,
      });
    } catch (error) {
      if (!shouldRetryAfterResume(error)) {
        throw error;
      }

      await this.resumeThread(normalizedThreadId);
      await this.request("thread/compact/start", {
        threadId: normalizedThreadId,
      });
    }
  }

  public async getThreadSummary(threadId: string): Promise<CodexThreadSummary> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      throw new Error("threadId is required");
    }

    const result = await this.readThread(normalizedThreadId, false);
    return extractThreadSummaryFromResult(result);
  }

  public async listLoadedThreadIds(): Promise<string[]> {
    const result = await this.request("thread/loaded/list", {});
    if (!result || typeof result !== "object") {
      throw new CodexAppServerTransportError(
        "Invalid thread/loaded/list response from codex app-server",
      );
    }

    const data = (result as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      throw new CodexAppServerTransportError(
        "Missing loaded thread ids in codex app-server response",
      );
    }

    const ids: string[] = [];
    for (const value of data) {
      const id = asString(value)?.trim();
      if (id) {
        ids.push(id);
      }
    }

    return ids;
  }

  public async sendMessage(
    input: SendCodexMessageInput,
  ): Promise<SendCodexMessageResult> {
    const threadId = input.threadId.trim();
    if (!threadId) {
      throw new Error("threadId is required");
    }

    const normalizedInput: SendCodexInputItem[] = [];
    if (Array.isArray(input.input)) {
      for (const item of input.input) {
        if (!item || typeof item !== "object") {
          continue;
        }

        if (item.type === "text") {
          const text = item.text.trim();
          if (!text) {
            continue;
          }
          normalizedInput.push({
            type: "text",
            text,
          });
          continue;
        }

        if (item.type === "image") {
          const url = item.url.trim();
          if (!url) {
            continue;
          }
          normalizedInput.push({
            type: "image",
            url,
          });
        }
      }
    }

    if (normalizedInput.length === 0) {
      const text = typeof input.text === "string" ? input.text.trim() : "";
      if (text) {
        normalizedInput.push({
          type: "text",
          text,
        });
      }
    }

    if (normalizedInput.length === 0) {
      throw new Error("input is required");
    }

    const params: Record<string, unknown> = {
      threadId,
      input: normalizedInput.map((item) =>
        item.type === "text"
          ? { type: "text", text: item.text }
          : { type: "image", url: item.url },
      ),
      attachments: [],
    };

    if (typeof input.cwd === "string" && input.cwd.trim()) {
      params.cwd = input.cwd.trim();
    }

    if (typeof input.model === "string" && input.model.trim()) {
      params.model = input.model.trim();
    }

    if (input.serviceTier === null) {
      params.serviceTier = null;
    } else if (input.serviceTier !== undefined) {
      params.serviceTier = input.serviceTier;
    }

    if (input.effort) {
      params.effort = input.effort;
    }

    if (input.collaborationMode === null) {
      params.collaborationMode = null;
    } else if (input.collaborationMode !== undefined) {
      params.collaborationMode = toCollaborationModePayload(
        input.collaborationMode,
      );
    }

    try {
      this.clearThreadStateCache(threadId);
      const result = await this.request("turn/start", params);
      return {
        turnId: extractTurnIdFromTurnStartResult(result),
      };
    } catch (error) {
      if (!shouldRetryAfterResume(error)) {
        throw error;
      }

      await this.resumeThread(threadId);
      this.clearThreadStateCache(threadId);
      const result = await this.request("turn/start", params);
      return {
        turnId: extractTurnIdFromTurnStartResult(result),
      };
    }
  }

  public async interruptThread(threadId: string): Promise<void> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      throw new Error("threadId is required");
    }

    this.clearThreadStateCache(normalizedThreadId);
    const threadState = await this.getThreadState(normalizedThreadId);
    const activeTurnId = threadState.activeTurnId;
    if (!activeTurnId) {
      return;
    }

    try {
      await this.request("turn/interrupt", {
        threadId: normalizedThreadId,
        turnId: activeTurnId,
      });
      this.clearThreadStateCache(normalizedThreadId);
    } catch (error) {
      if (!shouldRetryAfterResume(error)) {
        throw error;
      }

      await this.resumeThread(normalizedThreadId);
      this.clearThreadStateCache(normalizedThreadId);
      const refreshedThreadState =
        await this.getThreadState(normalizedThreadId);
      if (!refreshedThreadState.activeTurnId) {
        return;
      }

      await this.request("turn/interrupt", {
        threadId: normalizedThreadId,
        turnId: refreshedThreadState.activeTurnId,
      });
      this.clearThreadStateCache(normalizedThreadId);
    }
  }

  public async cleanBackgroundTerminals(threadId: string): Promise<void> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      throw new Error("threadId is required");
    }

    try {
      await this.request("thread/backgroundTerminals/clean", {
        threadId: normalizedThreadId,
      });
    } catch (error) {
      if (!shouldRetryAfterResume(error)) {
        throw error;
      }

      await this.resumeThread(normalizedThreadId);
      await this.request("thread/backgroundTerminals/clean", {
        threadId: normalizedThreadId,
      });
    }
  }

  public async getThreadState(
    threadId: string,
    requestedTurnId?: string | null,
  ): Promise<CodexThreadState> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      throw new Error("threadId is required");
    }

    const normalizedRequestedTurnId =
      typeof requestedTurnId === "string" && requestedTurnId.trim()
        ? requestedTurnId.trim()
        : null;

    return this.readCoalescer.getOrLoad(
      this.getThreadStateCacheKey(
        normalizedThreadId,
        normalizedRequestedTurnId,
      ),
      THREAD_STATE_CACHE_TTL_MS,
      async () => {
        const result = await this.readThreadWithTurns(normalizedThreadId);

        const turns = extractTurnsFromThreadReadResult(result);
        let activeTurnId: string | null = null;
        let requestedTurnStatus: CodexTurnStatus | null = null;

        for (let index = turns.length - 1; index >= 0; index -= 1) {
          const turn = turns[index];
          if (!turn || typeof turn !== "object") {
            continue;
          }

          const turnId = asString(turn.id)?.trim() ?? "";
          const turnStatus = toTurnStatus(turn.status);

          if (
            normalizedRequestedTurnId &&
            turnId === normalizedRequestedTurnId &&
            turnStatus
          ) {
            requestedTurnStatus = turnStatus;
          }

          if (!activeTurnId && turnStatus === "inProgress" && turnId) {
            activeTurnId = turnId;
          }
        }

        const threadRuntimeStatus = extractThreadStatusFromReadResult(result);

        return {
          threadId: normalizedThreadId,
          activeTurnId,
          isGenerating:
            activeTurnId !== null || threadRuntimeStatus === "active",
          requestedTurnId: normalizedRequestedTurnId,
          requestedTurnStatus,
        };
      },
    );
  }

  public async getLastTurnDiff(threadId: string): Promise<CodexLastTurnDiff> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      throw new Error("threadId is required");
    }

    const result = await this.readThreadWithTurns(normalizedThreadId);
    const turns = extractTurnsFromThreadReadResult(result);

    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (!turn || typeof turn !== "object") {
        continue;
      }

      const files = extractFileChangesFromTurn(turn);
      if (files.length === 0) {
        continue;
      }

      const turnId = asString(turn.id)?.trim() || null;
      return {
        threadId: normalizedThreadId,
        turnId,
        files,
      };
    }

    const latestTurn = turns[turns.length - 1];
    const latestTurnId =
      latestTurn && typeof latestTurn === "object"
        ? asString(latestTurn.id)?.trim() || null
        : null;

    return {
      threadId: normalizedThreadId,
      turnId: latestTurnId,
      files: [],
    };
  }

  public listPendingUserInputRequests(
    threadId: string,
  ): CodexUserInputRequest[] {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      throw new Error("threadId is required");
    }

    return [...this.pendingUserInputRequests.values()]
      .filter((request) => request.threadId === normalizedThreadId)
      .map((request) => ({
        requestId: request.requestId,
        threadId: request.threadId,
        turnId: request.turnId,
        itemId: request.itemId,
        questions: request.questions,
      }));
  }

  public listPendingApprovalRequests(threadId: string): CodexApprovalRequest[] {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      throw new Error("threadId is required");
    }

    return [...this.pendingApprovalRequests.values()]
      .filter((request) => request.threadId === normalizedThreadId)
      .map((request) => ({
        requestId: request.requestId,
        threadId: request.threadId,
        turnId: request.turnId,
        itemId: request.itemId,
        kind: request.kind,
        reason: request.reason,
        command: request.command,
        cwd: request.cwd,
        permissions: request.permissions,
        availableDecisions: request.availableDecisions.map((option) => ({
          id: option.id,
          label: option.label,
          description: option.description,
        })),
      }));
  }

  public async submitUserInput(
    threadId: string,
    requestId: string,
    response: CodexUserInputResponsePayload,
  ): Promise<void> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      throw new Error("threadId is required");
    }

    const normalizedRequestId = requestId.trim();
    if (!normalizedRequestId) {
      throw new Error("requestId is required");
    }

    const pendingRequest =
      this.pendingUserInputRequests.get(normalizedRequestId);
    if (!pendingRequest || pendingRequest.threadId !== normalizedThreadId) {
      throw new Error("request not found");
    }

    validateUserInputResponsePayload(response);

    await this.respondToServerRequest(pendingRequest.rawRequestId, response);
    this.pendingUserInputRequests.delete(normalizedRequestId);
  }

  public async submitApproval(
    threadId: string,
    requestId: string,
    response: CodexApprovalResponsePayload,
  ): Promise<void> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      throw new Error("threadId is required");
    }

    const normalizedRequestId = requestId.trim();
    if (!normalizedRequestId) {
      throw new Error("requestId is required");
    }

    const pendingRequest =
      this.pendingApprovalRequests.get(normalizedRequestId);
    if (!pendingRequest || pendingRequest.threadId !== normalizedThreadId) {
      throw new Error("request not found");
    }

    validateApprovalResponsePayload(response);

    if (pendingRequest.kind === "permissions") {
      const grant = response.grant;
      if (grant !== "allow" && grant !== "deny") {
        throw new Error("response.grant must be 'allow' or 'deny'");
      }

      const scope = response.scope ?? "turn";
      if (scope !== "turn" && scope !== "session") {
        throw new Error("response.scope must be 'turn' or 'session'");
      }

      const result = {
        scope,
        permissions:
          grant === "allow"
            ? (pendingRequest.permissions ?? {})
            : ({} as Record<string, unknown>),
      };
      await this.respondToServerRequest(pendingRequest.rawRequestId, result);
      this.pendingApprovalRequests.delete(normalizedRequestId);
      return;
    }

    const decisionId = asTrimmedString(response.decisionId);
    if (!decisionId) {
      throw new Error("response.decisionId is required");
    }

    const selectedDecision = pendingRequest.availableDecisions.find(
      (option) => option.id === decisionId,
    );
    if (!selectedDecision) {
      throw new Error("response.decisionId is invalid");
    }

    await this.respondToServerRequest(pendingRequest.rawRequestId, {
      decision: selectedDecision.decision,
    });
    this.pendingApprovalRequests.delete(normalizedRequestId);
  }

  public listLiveTerminalRuns(threadId: string): CodexLiveTerminalRun[] {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      throw new Error("threadId is required");
    }

    this.pruneLiveTerminalRuns(normalizedThreadId);
    const runs = this.liveTerminalRunsByThread.get(normalizedThreadId);
    if (!runs || runs.size === 0) {
      return [];
    }

    return [...runs.values()].sort(
      (left, right) => right.updatedAt - left.updatedAt,
    );
  }

  public getLiveTerminalRun(
    threadId: string,
    processId: string,
  ): CodexLiveTerminalRun | null {
    const normalizedThreadId = threadId.trim();
    const normalizedProcessId = processId.trim();
    if (!normalizedThreadId || !normalizedProcessId) {
      throw new Error("threadId and processId are required");
    }

    this.pruneLiveTerminalRuns(normalizedThreadId);
    return (
      this.liveTerminalRunsByThread
        .get(normalizedThreadId)
        ?.get(normalizedProcessId) ?? null
    );
  }

  private async resumeThread(threadId: string): Promise<void> {
    this.clearThreadStateCache(threadId);
    await this.request("thread/resume", {
      threadId,
      persistExtendedHistory: true,
    });
    this.clearThreadStateCache(threadId);
  }

  private getThreadStateCacheKey(
    threadId: string,
    requestedTurnId: string | null,
  ): string {
    return `thread-state:${threadId}:${requestedTurnId ?? ""}`;
  }

  private clearThreadStateCache(threadId: string): void {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      return;
    }

    this.readCoalescer.clearMatching((key) =>
      key.startsWith(`thread-state:${normalizedThreadId}:`),
    );
  }

  private async readThread(
    threadId: string,
    includeTurns: boolean,
  ): Promise<unknown> {
    const requestPayload = {
      threadId,
      includeTurns,
    };

    try {
      return await this.request("thread/read", requestPayload);
    } catch (error) {
      if (!shouldRetryAfterResume(error)) {
        throw error;
      }

      await this.resumeThread(threadId);
      return await this.request("thread/read", requestPayload);
    }
  }

  private async readThreadWithTurns(threadId: string): Promise<unknown> {
    return this.readThread(threadId, true);
  }

  public async close(): Promise<void> {
    this.rejectAll(new CodexAppServerTransportError("app-server closed"));
    this.pendingUserInputRequests.clear();
    this.pendingApprovalRequests.clear();
    this.liveTerminalRunsByThread.clear();
    this.liveTerminalProcessByItemByThread.clear();
    this.liveTerminalPendingDeltaByItemByThread.clear();
    for (const message of this.stdoutMessageParser.finish()) {
      this.handleStdoutMessage(message);
    }

    this.stderrReader?.close();
    this.stderrReader = null;

    if (this.process) {
      try {
        this.process.kill("SIGTERM");
      } catch {
        // Ignore process kill errors during shutdown.
      }
    }

    this.process = null;
    this.initialized = false;
    this.initializeInFlight = null;
  }

  private ensureStarted(): void {
    if (this.process) {
      return;
    }

    const spawnSpec = createCodexAppServerSpawnSpec(this.executablePath);
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: this.cwd,
      env: {
        ...process.env,
        ...this.env,
        CODEX_USER_AGENT: this.userAgent,
        CODEX_CLIENT_ID: `codex-deck-${randomUUID()}`,
      },
      shell: spawnSpec.shell,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.on("exit", (code, signal) => {
      this.handleProcessExit(
        `app-server exited (code=${String(code)}, signal=${String(signal)})`,
      );
    });

    child.on("error", (error) => {
      this.handleProcessExit(`app-server process error: ${error.message}`);
    });

    child.stdout.on("data", (chunk: Buffer) => {
      for (const message of this.stdoutMessageParser.push(chunk)) {
        this.handleStdoutMessage(message);
      }
    });

    this.stderrReader = createInterface({ input: child.stderr });
    this.stderrReader.on("line", (line) => {
      const text = line.trim();
      if (!text) {
        return;
      }
      console.error(`[codex app-server] ${text}`);
    });

    this.process = child;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.initializeInFlight) {
      return this.initializeInFlight;
    }

    this.initializeInFlight = (async () => {
      const result = await this.requestRaw(
        "initialize",
        {
          clientInfo: {
            name: "codex-deck",
            version: "0.2.4",
          },
          capabilities: {
            experimentalApi: true,
          },
        },
        this.requestTimeoutMs,
      );

      if (!result || typeof result !== "object") {
        throw new CodexAppServerTransportError(
          "Invalid initialize response from codex app-server",
        );
      }

      this.initialized = true;
    })().finally(() => {
      this.initializeInFlight = null;
    });

    return this.initializeInFlight;
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    this.ensureStarted();

    if (method !== "initialize") {
      await this.ensureInitialized();
    }

    return this.requestRaw(method, params, this.requestTimeoutMs);
  }

  private async requestRaw(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const processHandle = this.process;
    if (!processHandle) {
      throw new CodexAppServerTransportError("app-server failed to start");
    }

    const id = ++this.requestId;

    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new CodexAppServerTransportError(
            `app-server request timed out: ${method}`,
          ),
        );
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      processHandle.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) {
          return;
        }

        const pendingRequest = this.pending.get(id);
        if (!pendingRequest) {
          return;
        }

        clearTimeout(pendingRequest.timer);
        this.pending.delete(id);
        pendingRequest.reject(
          new CodexAppServerTransportError(
            `Failed to write app-server request: ${error.message}`,
          ),
        );
      });
    });
  }

  private handleStdoutMessage(message: Record<string, unknown>): void {
    const idValue = message.id;
    const method = typeof message.method === "string" ? message.method : null;
    const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
    const hasError = Object.prototype.hasOwnProperty.call(message, "error");

    if ((hasResult || hasError) && typeof idValue === "number") {
      this.resolvePendingRequest(idValue, message);
      return;
    }

    if (
      method &&
      !hasResult &&
      !hasError &&
      !Object.prototype.hasOwnProperty.call(message, "id")
    ) {
      this.handleServerNotification(method, message.params);
      return;
    }

    if (
      (typeof idValue === "number" || typeof idValue === "string") &&
      method &&
      Object.prototype.hasOwnProperty.call(message, "params")
    ) {
      if (method === "item/tool/requestUserInput") {
        if (this.handleRequestUserInput(idValue, message.params)) {
          return;
        }
      }

      if (this.handleApprovalRequest(idValue, method, message.params)) {
        return;
      }

      void this.respondMethodNotFound(idValue, method);
    }
  }

  private handleServerNotification(method: string, params: unknown): void {
    if (!params || typeof params !== "object") {
      return;
    }

    if (method === "item/started") {
      this.handleItemStartedNotification(params);
      return;
    }

    if (method === "item/completed") {
      this.handleItemCompletedNotification(params);
      return;
    }

    if (method === "item/commandExecution/outputDelta") {
      this.handleCommandExecutionOutputDeltaNotification(params);
      return;
    }

    if (method === "serverRequest/resolved") {
      this.handleServerRequestResolved(params);
    }
  }

  private handleItemStartedNotification(params: unknown): void {
    const notification = asRecord(params);
    if (!notification) {
      return;
    }

    const threadId = asTrimmedString(
      notification.threadId ?? notification.thread_id,
    );
    const item = asRecord(notification.item);
    if (!threadId || !item) {
      return;
    }

    const itemType = asTrimmedString(item.type)?.toLowerCase() ?? "";
    if (itemType !== "commandexecution" && itemType !== "command_execution") {
      return;
    }

    const processId = asTrimmedString(item.processId ?? item.process_id);
    const callId = asTrimmedString(item.id);
    if (!processId || !callId) {
      return;
    }

    const command = asTrimmedString(item.command) ?? "(unknown command)";
    const updatedAt = Date.now();
    const output = this.consumePendingLiveDelta(threadId, callId);

    this.setLiveTerminalRun(threadId, processId, {
      threadId,
      processId,
      callId,
      command,
      output,
      isRunning: true,
      updatedAt,
    });
    this.mapLiveTerminalProcessId(threadId, callId, processId);
  }

  private handleItemCompletedNotification(params: unknown): void {
    const notification = asRecord(params);
    if (!notification) {
      return;
    }

    const threadId = asTrimmedString(
      notification.threadId ?? notification.thread_id,
    );
    const item = asRecord(notification.item);
    if (!threadId || !item) {
      return;
    }

    const itemType = asTrimmedString(item.type)?.toLowerCase() ?? "";
    if (itemType !== "commandexecution" && itemType !== "command_execution") {
      return;
    }

    const callId = asTrimmedString(item.id);
    const processId =
      asTrimmedString(item.processId ?? item.process_id) ??
      (callId ? this.getLiveProcessIdForItem(threadId, callId) : null);
    if (!processId) {
      return;
    }

    const runsForThread = this.liveTerminalRunsByThread.get(threadId);
    const existing = runsForThread?.get(processId);
    const command =
      asTrimmedString(item.command) ?? existing?.command ?? "(unknown command)";
    const aggregatedOutput = asString(
      item.aggregatedOutput ?? item.aggregated_output,
    );

    this.setLiveTerminalRun(threadId, processId, {
      threadId,
      processId,
      callId: callId ?? existing?.callId ?? processId,
      command,
      output:
        typeof aggregatedOutput === "string"
          ? chooseLongerOutput(existing?.output ?? "", aggregatedOutput)
          : (existing?.output ?? ""),
      isRunning: false,
      updatedAt: Date.now(),
    });

    if (callId) {
      this.unmapLiveTerminalProcessId(threadId, callId);
      this.consumePendingLiveDelta(threadId, callId);
    }
  }

  private handleCommandExecutionOutputDeltaNotification(params: unknown): void {
    const notification = asRecord(params);
    if (!notification) {
      return;
    }

    const threadId = asTrimmedString(
      notification.threadId ?? notification.thread_id,
    );
    const itemId = asTrimmedString(notification.itemId ?? notification.item_id);
    const delta = asString(notification.delta) ?? "";
    if (!threadId || !itemId || !delta) {
      return;
    }

    const processId = this.getLiveProcessIdForItem(threadId, itemId);
    if (!processId) {
      this.appendPendingLiveDelta(threadId, itemId, delta);
      return;
    }

    const runsForThread = this.liveTerminalRunsByThread.get(threadId);
    const existing = runsForThread?.get(processId);
    const baseOutput = existing?.output ?? "";

    this.setLiveTerminalRun(threadId, processId, {
      threadId,
      processId,
      callId: existing?.callId ?? itemId,
      command: existing?.command ?? "(unknown command)",
      output: `${baseOutput}${delta}`,
      isRunning: existing?.isRunning ?? true,
      updatedAt: Date.now(),
    });
  }

  private setLiveTerminalRun(
    threadId: string,
    processId: string,
    run: CodexLiveTerminalRun,
  ): void {
    let runsForThread = this.liveTerminalRunsByThread.get(threadId);
    if (!runsForThread) {
      runsForThread = new Map<string, CodexLiveTerminalRun>();
      this.liveTerminalRunsByThread.set(threadId, runsForThread);
    }
    runsForThread.set(processId, run);
  }

  private mapLiveTerminalProcessId(
    threadId: string,
    itemId: string,
    processId: string,
  ): void {
    let processByItem = this.liveTerminalProcessByItemByThread.get(threadId);
    if (!processByItem) {
      processByItem = new Map<string, string>();
      this.liveTerminalProcessByItemByThread.set(threadId, processByItem);
    }
    processByItem.set(itemId, processId);
  }

  private unmapLiveTerminalProcessId(threadId: string, itemId: string): void {
    const processByItem = this.liveTerminalProcessByItemByThread.get(threadId);
    if (!processByItem) {
      return;
    }

    processByItem.delete(itemId);
    if (processByItem.size === 0) {
      this.liveTerminalProcessByItemByThread.delete(threadId);
    }
  }

  private getLiveProcessIdForItem(
    threadId: string,
    itemId: string,
  ): string | null {
    return (
      this.liveTerminalProcessByItemByThread.get(threadId)?.get(itemId) ?? null
    );
  }

  private appendPendingLiveDelta(
    threadId: string,
    itemId: string,
    delta: string,
  ): void {
    let pendingByItem =
      this.liveTerminalPendingDeltaByItemByThread.get(threadId);
    if (!pendingByItem) {
      pendingByItem = new Map<string, string>();
      this.liveTerminalPendingDeltaByItemByThread.set(threadId, pendingByItem);
    }
    pendingByItem.set(itemId, `${pendingByItem.get(itemId) ?? ""}${delta}`);
  }

  private consumePendingLiveDelta(threadId: string, itemId: string): string {
    const pendingByItem =
      this.liveTerminalPendingDeltaByItemByThread.get(threadId);
    if (!pendingByItem) {
      return "";
    }

    const pending = pendingByItem.get(itemId) ?? "";
    pendingByItem.delete(itemId);
    if (pendingByItem.size === 0) {
      this.liveTerminalPendingDeltaByItemByThread.delete(threadId);
    }
    return pending;
  }

  private pruneLiveTerminalRuns(threadId: string): void {
    const runsForThread = this.liveTerminalRunsByThread.get(threadId);
    if (!runsForThread || runsForThread.size === 0) {
      return;
    }

    const now = Date.now();
    const completedRetentionMs = 5 * 60 * 1000;
    for (const [processId, run] of runsForThread.entries()) {
      if (!run.isRunning && now - run.updatedAt > completedRetentionMs) {
        runsForThread.delete(processId);
      }
    }

    if (runsForThread.size === 0) {
      this.liveTerminalRunsByThread.delete(threadId);
    }
  }

  private handleRequestUserInput(
    requestId: JsonRpcRequestId,
    params: unknown,
  ): boolean {
    const normalized = parseRequestUserInputParams(params);
    if (!normalized) {
      return false;
    }

    this.pendingUserInputRequests.set(String(requestId), {
      requestId: String(requestId),
      rawRequestId: requestId,
      threadId: normalized.threadId,
      turnId: normalized.turnId,
      itemId: normalized.itemId,
      questions: normalized.questions,
    });

    return true;
  }

  private handleServerRequestResolved(params: unknown): void {
    if (!params || typeof params !== "object") {
      return;
    }

    const record = params as Record<string, unknown>;
    const requestId = record.requestId;
    if (typeof requestId !== "string" && typeof requestId !== "number") {
      return;
    }

    this.pendingUserInputRequests.delete(String(requestId));
    this.pendingApprovalRequests.delete(String(requestId));
  }

  private handleApprovalRequest(
    requestId: JsonRpcRequestId,
    method: string,
    params: unknown,
  ): boolean {
    const request =
      method === "item/commandExecution/requestApproval"
        ? parseCommandExecutionApprovalRequest(requestId, params)
        : method === "item/fileChange/requestApproval"
          ? parseFileChangeApprovalRequest(requestId, params)
          : method === "item/permissions/requestApproval"
            ? parsePermissionsApprovalRequest(requestId, params)
            : method === "execCommandApproval"
              ? parseLegacyCommandApprovalRequest(requestId, params)
              : method === "applyPatchApproval"
                ? parseLegacyFileChangeApprovalRequest(requestId, params)
                : null;

    if (!request) {
      return false;
    }

    this.pendingApprovalRequests.set(String(requestId), request);
    return true;
  }

  private resolvePendingRequest(
    requestId: number,
    message: Record<string, unknown>,
  ): void {
    const pendingRequest = this.pending.get(requestId);
    if (!pendingRequest) {
      return;
    }

    this.pending.delete(requestId);
    clearTimeout(pendingRequest.timer);

    if (Object.prototype.hasOwnProperty.call(message, "error")) {
      const errorValue = message.error;
      if (errorValue && typeof errorValue === "object") {
        const errorObj = errorValue as Record<string, unknown>;
        const code = typeof errorObj.code === "number" ? errorObj.code : -32000;
        const errorMessage =
          asString(errorObj.message)?.trim() || "Unknown app-server error";

        pendingRequest.reject(
          new CodexAppServerRpcError(code, errorMessage, errorObj.data),
        );
        return;
      }

      pendingRequest.reject(
        new CodexAppServerRpcError(
          -32000,
          "Unknown app-server error (malformed error payload)",
        ),
      );
      return;
    }

    pendingRequest.resolve(message.result);
  }

  private async respondMethodNotFound(
    requestId: JsonRpcRequestId,
    method: string,
  ): Promise<void> {
    const processHandle = this.process;
    if (!processHandle) {
      return;
    }

    const payload = {
      jsonrpc: "2.0",
      id: requestId,
      error: {
        code: -32601,
        message: `Method not handled by codex-deck client: ${method}`,
      },
    };

    await new Promise<void>((resolve) => {
      processHandle.stdin.write(`${JSON.stringify(payload)}\n`, () => {
        resolve();
      });
    });
  }

  private async respondToServerRequest(
    requestId: JsonRpcRequestId,
    result: unknown,
  ): Promise<void> {
    const processHandle = this.process;
    if (!processHandle) {
      throw new CodexAppServerTransportError("app-server failed to start");
    }

    const payload = {
      jsonrpc: "2.0",
      id: requestId,
      result,
    };

    await new Promise<void>((resolve, reject) => {
      processHandle.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) {
          reject(
            new CodexAppServerTransportError(
              `Failed to write app-server response: ${error.message}`,
            ),
          );
          return;
        }

        resolve();
      });
    });
  }

  private handleProcessExit(reason: string): void {
    for (const message of this.stdoutMessageParser.finish()) {
      this.handleStdoutMessage(message);
    }
    this.stderrReader?.close();
    this.stderrReader = null;

    this.process = null;
    this.initialized = false;
    this.initializeInFlight = null;
    this.liveTerminalRunsByThread.clear();
    this.liveTerminalProcessByItemByThread.clear();
    this.liveTerminalPendingDeltaByItemByThread.clear();
    this.pendingUserInputRequests.clear();
    this.pendingApprovalRequests.clear();

    this.rejectAll(new CodexAppServerTransportError(reason));
  }

  private rejectAll(error: Error): void {
    for (const pendingRequest of this.pending.values()) {
      clearTimeout(pendingRequest.timer);
      pendingRequest.reject(error);
    }
    this.pending.clear();
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asTrimmedString(value: unknown): string | null {
  const text = asString(value)?.trim();
  return text ? text : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toSkillScope(value: unknown): CodexSkillScope {
  const scope = asTrimmedString(value)?.toLowerCase();
  if (
    scope === "user" ||
    scope === "repo" ||
    scope === "system" ||
    scope === "admin"
  ) {
    return scope;
  }
  return "unknown";
}

function chooseLongerOutput(left: string, right: string): string {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  if (right.includes(left)) {
    return right;
  }
  if (left.includes(right)) {
    return left;
  }
  return right.length >= left.length ? right : left;
}

function asNullableString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return asString(value);
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function toReasoningEffort(value: unknown): CodexReasoningEffort | null {
  if (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  return null;
}

function toServiceTier(value: unknown): CodexServiceTier | null {
  if (value === "fast" || value === "flex") {
    return value;
  }
  return null;
}

function collectSupportedReasoningEfforts(
  value: unknown,
): CodexReasoningEffort[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const efforts = new Set<CodexReasoningEffort>();

  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const effort = toReasoningEffort(
      (entry as Record<string, unknown>).reasoningEffort,
    );

    if (effort) {
      efforts.add(effort);
    }
  }

  return [...efforts];
}

const DEFAULT_COMMAND_APPROVAL_DECISIONS_V2: unknown[] = [
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
];
const DEFAULT_FILE_CHANGE_APPROVAL_DECISIONS_V2: unknown[] = [
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
];
const DEFAULT_COMMAND_APPROVAL_DECISIONS_V1: unknown[] = [
  "approved",
  "approved_for_session",
  "denied",
  "abort",
];
const DEFAULT_FILE_CHANGE_APPROVAL_DECISIONS_V1: unknown[] = [
  "approved",
  "approved_for_session",
  "denied",
  "abort",
];

function normalizeDecisionVariant(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  const record = asRecord(value);
  if (!record) {
    return "";
  }
  const keys = Object.keys(record);
  if (keys.length !== 1) {
    return "";
  }
  return keys[0].trim();
}

function sanitizeOptionId(value: string): string {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return normalized || "decision";
}

function humanizeDecisionVariant(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);

  if (words.length === 0) {
    return "Choose";
  }

  return words.map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
}

function describeApprovalDecisionVariant(value: string): {
  label: string;
  description: string;
} {
  switch (value) {
    case "accept":
    case "approved":
      return {
        label: "Allow once",
        description: "Approve only this request.",
      };
    case "acceptForSession":
    case "approved_for_session":
      return {
        label: "Allow for session",
        description: "Approve this and similar requests for this session.",
      };
    case "decline":
    case "denied":
      return {
        label: "Deny",
        description: "Reject this request and continue.",
      };
    case "cancel":
    case "abort":
      return {
        label: "Cancel",
        description: "Cancel this request.",
      };
    case "acceptWithExecpolicyAmendment":
    case "approved_execpolicy_amendment":
      return {
        label: "Allow and add exec policy",
        description: "Approve and save an execution policy amendment.",
      };
    case "applyNetworkPolicyAmendment":
    case "network_policy_amendment":
      return {
        label: "Apply network policy",
        description: "Apply a network policy amendment.",
      };
    default:
      return {
        label: humanizeDecisionVariant(value),
        description: "Approve with this decision variant.",
      };
  }
}

function normalizeApprovalDecisionOptions(
  decisions: unknown,
  fallback: unknown[],
): PendingApprovalDecisionOption[] {
  const sourceValues =
    Array.isArray(decisions) && decisions.length > 0 ? decisions : fallback;

  const options: PendingApprovalDecisionOption[] = [];
  const idCounts = new Map<string, number>();
  let fallbackIndex = 1;

  for (const decision of sourceValues) {
    const variant = normalizeDecisionVariant(decision);
    const baseId = sanitizeOptionId(variant || `decision_${fallbackIndex}`);
    const nextCount = (idCounts.get(baseId) ?? 0) + 1;
    idCounts.set(baseId, nextCount);
    const id = nextCount === 1 ? baseId : `${baseId}_${nextCount}`;
    const description = describeApprovalDecisionVariant(variant);

    options.push({
      id,
      label: description.label,
      description: description.description,
      decision,
    });

    fallbackIndex += 1;
  }

  return options;
}

function parseCommandExecutionApprovalRequest(
  requestId: JsonRpcRequestId,
  value: unknown,
): PendingApprovalRequest | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const threadId = asTrimmedString(record.threadId ?? record.thread_id);
  const itemId = asTrimmedString(record.itemId ?? record.item_id);
  if (!threadId || !itemId) {
    return null;
  }

  const availableDecisions = normalizeApprovalDecisionOptions(
    record.availableDecisions ?? record.available_decisions,
    DEFAULT_COMMAND_APPROVAL_DECISIONS_V2,
  );

  return {
    requestId: String(requestId),
    rawRequestId: requestId,
    threadId,
    turnId: asTrimmedString(record.turnId ?? record.turn_id) ?? null,
    itemId,
    kind: "commandExecution",
    reason: asTrimmedString(record.reason) ?? null,
    command: asTrimmedString(record.command) ?? null,
    cwd: asTrimmedString(record.cwd) ?? null,
    permissions: null,
    availableDecisions,
  };
}

function parseFileChangeApprovalRequest(
  requestId: JsonRpcRequestId,
  value: unknown,
): PendingApprovalRequest | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const threadId = asTrimmedString(record.threadId ?? record.thread_id);
  const itemId = asTrimmedString(record.itemId ?? record.item_id);
  if (!threadId || !itemId) {
    return null;
  }

  const availableDecisions = normalizeApprovalDecisionOptions(
    record.availableDecisions ?? record.available_decisions,
    DEFAULT_FILE_CHANGE_APPROVAL_DECISIONS_V2,
  );

  return {
    requestId: String(requestId),
    rawRequestId: requestId,
    threadId,
    turnId: asTrimmedString(record.turnId ?? record.turn_id) ?? null,
    itemId,
    kind: "fileChange",
    reason: asTrimmedString(record.reason) ?? null,
    command: null,
    cwd: null,
    permissions: null,
    availableDecisions,
  };
}

function parsePermissionsApprovalRequest(
  requestId: JsonRpcRequestId,
  value: unknown,
): PendingApprovalRequest | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const threadId = asTrimmedString(record.threadId ?? record.thread_id);
  const itemId = asTrimmedString(record.itemId ?? record.item_id);
  const permissions = asRecord(record.permissions);
  if (!threadId || !itemId || !permissions) {
    return null;
  }

  return {
    requestId: String(requestId),
    rawRequestId: requestId,
    threadId,
    turnId: asTrimmedString(record.turnId ?? record.turn_id) ?? null,
    itemId,
    kind: "permissions",
    reason: asTrimmedString(record.reason) ?? null,
    command: null,
    cwd: null,
    permissions,
    availableDecisions: [],
  };
}

function parseLegacyCommandApprovalRequest(
  requestId: JsonRpcRequestId,
  value: unknown,
): PendingApprovalRequest | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const threadId = asTrimmedString(
    record.conversationId ?? record.conversation_id,
  );
  const itemId = asTrimmedString(record.callId ?? record.call_id);
  if (!threadId || !itemId) {
    return null;
  }

  const availableDecisions = normalizeApprovalDecisionOptions(
    null,
    DEFAULT_COMMAND_APPROVAL_DECISIONS_V1,
  );

  return {
    requestId: String(requestId),
    rawRequestId: requestId,
    threadId,
    turnId: null,
    itemId,
    kind: "commandExecution",
    reason: asTrimmedString(record.reason) ?? null,
    command: Array.isArray(record.command)
      ? record.command
          .filter((entry): entry is string => typeof entry === "string")
          .join(" ")
      : (asTrimmedString(record.command) ?? null),
    cwd: asTrimmedString(record.cwd) ?? null,
    permissions: null,
    availableDecisions,
  };
}

function parseLegacyFileChangeApprovalRequest(
  requestId: JsonRpcRequestId,
  value: unknown,
): PendingApprovalRequest | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const threadId = asTrimmedString(
    record.conversationId ?? record.conversation_id,
  );
  const itemId = asTrimmedString(record.callId ?? record.call_id);
  if (!threadId || !itemId) {
    return null;
  }

  const availableDecisions = normalizeApprovalDecisionOptions(
    null,
    DEFAULT_FILE_CHANGE_APPROVAL_DECISIONS_V1,
  );

  return {
    requestId: String(requestId),
    rawRequestId: requestId,
    threadId,
    turnId: null,
    itemId,
    kind: "fileChange",
    reason: asTrimmedString(record.reason) ?? null,
    command: null,
    cwd: null,
    permissions: null,
    availableDecisions,
  };
}

function parseRequestUserInputParams(value: unknown): {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: CodexUserInputQuestion[];
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const threadId = asString(record.threadId)?.trim() ?? "";
  const turnId = asString(record.turnId)?.trim() ?? "";
  const itemId = asString(record.itemId)?.trim() ?? "";
  if (!threadId || !turnId || !itemId) {
    return null;
  }

  if (!Array.isArray(record.questions)) {
    return null;
  }

  const questions = record.questions
    .map((questionValue) => {
      if (
        !questionValue ||
        typeof questionValue !== "object" ||
        Array.isArray(questionValue)
      ) {
        return null;
      }

      const question = questionValue as Record<string, unknown>;
      const id = asString(question.id)?.trim() ?? "";
      const header = asString(question.header)?.trim() ?? "";
      const prompt = asString(question.question)?.trim() ?? "";
      if (!id || !prompt) {
        return null;
      }

      const options = Array.isArray(question.options)
        ? question.options
            .map((optionValue) => {
              if (
                !optionValue ||
                typeof optionValue !== "object" ||
                Array.isArray(optionValue)
              ) {
                return null;
              }
              const option = optionValue as Record<string, unknown>;
              const label = asString(option.label)?.trim() ?? "";
              if (!label) {
                return null;
              }
              return {
                label,
                description: asString(option.description) ?? "",
              };
            })
            .filter(
              (option): option is CodexUserInputQuestionOption => !!option,
            )
        : [];

      return {
        id,
        header: header || "Question",
        question: prompt,
        isOther: question.isOther === true,
        isSecret: question.isSecret === true,
        options,
      };
    })
    .filter((question): question is CodexUserInputQuestion => !!question);

  if (questions.length === 0) {
    return null;
  }

  return {
    threadId,
    turnId,
    itemId,
    questions,
  };
}

function validateUserInputResponsePayload(
  value: unknown,
): asserts value is CodexUserInputResponsePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("response must be an object");
  }

  const record = value as Record<string, unknown>;
  if (
    !Object.prototype.hasOwnProperty.call(record, "answers") ||
    !record.answers ||
    typeof record.answers !== "object" ||
    Array.isArray(record.answers)
  ) {
    throw new Error("response.answers must be an object");
  }

  const answers = record.answers as Record<string, unknown>;
  for (const [questionId, answerValue] of Object.entries(answers)) {
    if (!questionId.trim()) {
      throw new Error("response.answers has an empty question id");
    }
    if (
      !answerValue ||
      typeof answerValue !== "object" ||
      Array.isArray(answerValue)
    ) {
      throw new Error(`response.answers.${questionId} must be an object`);
    }
    const answerRecord = answerValue as Record<string, unknown>;
    if (!Array.isArray(answerRecord.answers)) {
      throw new Error(
        `response.answers.${questionId}.answers must be an array`,
      );
    }
    for (const option of answerRecord.answers) {
      if (typeof option !== "string") {
        throw new Error(
          `response.answers.${questionId}.answers entries must be strings`,
        );
      }
    }
  }
}

function validateApprovalResponsePayload(
  value: unknown,
): asserts value is CodexApprovalResponsePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("response must be an object");
  }

  const record = value as Record<string, unknown>;
  if (
    record.decisionId !== undefined &&
    typeof record.decisionId !== "string"
  ) {
    throw new Error("response.decisionId must be a string");
  }

  if (
    record.grant !== undefined &&
    record.grant !== "allow" &&
    record.grant !== "deny"
  ) {
    throw new Error("response.grant must be 'allow' or 'deny'");
  }

  if (
    record.scope !== undefined &&
    record.scope !== "turn" &&
    record.scope !== "session"
  ) {
    throw new Error("response.scope must be 'turn' or 'session'");
  }
}

function extractTurnsFromThreadReadResult(
  result: unknown,
): AppServerTurnRecord[] {
  if (!result || typeof result !== "object") {
    return [];
  }

  const threadValue = (result as { thread?: unknown }).thread;
  if (!threadValue || typeof threadValue !== "object") {
    return [];
  }

  const turnsValue = (threadValue as { turns?: unknown }).turns;
  if (!Array.isArray(turnsValue) || turnsValue.length === 0) {
    return [];
  }

  return turnsValue as AppServerTurnRecord[];
}

function extractThreadStatusFromReadResult(
  result: unknown,
): CodexThreadRuntimeStatus {
  if (!result || typeof result !== "object") {
    return "unknown";
  }
  const threadValue = (result as { thread?: unknown }).thread;
  if (!threadValue || typeof threadValue !== "object") {
    return "unknown";
  }
  return toThreadRuntimeStatus((threadValue as { status?: unknown }).status);
}

function toThreadRuntimeStatus(value: unknown): CodexThreadRuntimeStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "unknown";
  }

  const type = asString((value as { type?: unknown }).type)?.trim();
  if (
    type === "notLoaded" ||
    type === "idle" ||
    type === "systemError" ||
    type === "active"
  ) {
    return type;
  }
  return "unknown";
}

function extractThreadSummaryFromResult(result: unknown): CodexThreadSummary {
  if (!result || typeof result !== "object") {
    throw new CodexAppServerTransportError(
      "Invalid thread response from codex app-server",
    );
  }

  const threadValue = (result as { thread?: unknown }).thread;
  if (!threadValue || typeof threadValue !== "object") {
    throw new CodexAppServerTransportError(
      "Missing thread payload in codex app-server response",
    );
  }

  const thread = threadValue as AppServerThreadRecord;
  const threadId = asString(thread.id)?.trim();
  if (!threadId) {
    throw new CodexAppServerTransportError(
      "Missing thread id in codex app-server response",
    );
  }

  const name = asNullableString(thread.name);
  const preview = asString(thread.preview)?.trim() ?? "";
  const cwd = asString(thread.cwd)?.trim() ?? "";

  return {
    threadId,
    name: name === undefined ? null : name,
    preview,
    cwd,
    agentNickname: asNullableString(thread.agentNickname) ?? null,
    agentRole: asNullableString(thread.agentRole) ?? null,
    status: toThreadRuntimeStatus(thread.status),
    updatedAt: asFiniteNumber(thread.updatedAt),
  };
}

function extractTurnIdFromTurnStartResult(result: unknown): string | null {
  if (!result || typeof result !== "object") {
    return null;
  }

  const turnValue = (result as { turn?: unknown }).turn;
  if (!turnValue || typeof turnValue !== "object") {
    return null;
  }

  const turnId = asString((turnValue as { id?: unknown }).id)?.trim();
  return turnId || null;
}

function extractFileChangesFromTurn(
  turnValue: AppServerTurnRecord,
): CodexTurnFileDiff[] {
  const itemsValue = turnValue.items;
  if (!Array.isArray(itemsValue) || itemsValue.length === 0) {
    return [];
  }

  const changesByPath = new Map<string, CodexTurnFileDiff>();

  for (const itemValue of itemsValue) {
    if (
      !itemValue ||
      typeof itemValue !== "object" ||
      Array.isArray(itemValue)
    ) {
      continue;
    }

    const item = itemValue as Record<string, unknown>;
    if (item.type !== "fileChange" || !Array.isArray(item.changes)) {
      continue;
    }

    for (const changeValue of item.changes) {
      if (
        !changeValue ||
        typeof changeValue !== "object" ||
        Array.isArray(changeValue)
      ) {
        continue;
      }

      const change = changeValue as Record<string, unknown>;
      const path = asString(change.path)?.trim() ?? "";
      if (!path) {
        continue;
      }

      const diff = asString(change.diff) ?? "";
      const kindValue = change.kind;
      const kind =
        kindValue && typeof kindValue === "object" && !Array.isArray(kindValue)
          ? asString((kindValue as Record<string, unknown>).type)?.trim() ||
            "unknown"
          : "unknown";

      const existing = changesByPath.get(path);
      if (!existing) {
        changesByPath.set(path, {
          path,
          diff,
          kind,
        });
        continue;
      }

      existing.diff =
        existing.diff && diff
          ? `${existing.diff}\n${diff}`
          : existing.diff || diff;
      if (existing.kind === "unknown" && kind !== "unknown") {
        existing.kind = kind;
      }
    }
  }

  return [...changesByPath.values()];
}

function toTurnStatus(value: unknown): CodexTurnStatus | null {
  if (
    value === "inProgress" ||
    value === "completed" ||
    value === "failed" ||
    value === "interrupted"
  ) {
    return value;
  }
  return null;
}

function shouldRetryAfterResume(error: unknown): boolean {
  if (!(error instanceof CodexAppServerRpcError)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("thread not found") ||
    message.includes("thread not loaded") ||
    message.includes("not loaded") ||
    message.includes("unknown thread") ||
    message.includes("no rollout found for thread id") ||
    message.includes("not materialized yet")
  );
}

function toCollaborationModePayload(
  value: CodexCollaborationModeInput,
): Record<string, unknown> {
  const mode = value.mode.trim();
  const settings = value.settings;
  const payload: Record<string, unknown> = { mode };

  if (settings) {
    const normalizedSettings: Record<string, unknown> = {};

    if (typeof settings.model === "string" && settings.model.trim()) {
      normalizedSettings.model = settings.model.trim();
    }

    if (settings.reasoningEffort) {
      normalizedSettings.reasoning_effort = settings.reasoningEffort;
    }

    if (
      typeof settings.developerInstructions === "string" &&
      settings.developerInstructions.trim()
    ) {
      normalizedSettings.developer_instructions =
        settings.developerInstructions.trim();
    }

    if (Object.keys(normalizedSettings).length > 0) {
      payload.settings = normalizedSettings;
    }
  }

  return payload;
}

function resolveCodexExecutablePath(): string {
  const envPath = stripWrappingQuotes(process.env["CODEX_CLI_PATH"]?.trim());
  if (envPath) {
    if (process.platform === "win32") {
      return resolveWindowsCommandPath(envPath) ?? envPath;
    }

    return envPath;
  }

  if (process.platform === "win32") {
    const pathCommand = resolveWindowsCommandPath("codex");
    if (pathCommand) {
      return pathCommand;
    }
  }

  if (isCommandAvailable("codex")) {
    return "codex";
  }

  const desktopPath = "/Applications/Codex.app/Contents/Resources/codex";
  if (existsSync(desktopPath)) {
    return desktopPath;
  }

  if (process.platform === "win32") {
    const windowsCandidates = [
      process.env["APPDATA"]
        ? join(process.env["APPDATA"], "npm", "codex.cmd")
        : null,
      process.env["APPDATA"]
        ? join(process.env["APPDATA"], "npm", "codex.exe")
        : null,
      process.env["LOCALAPPDATA"]
        ? join(process.env["LOCALAPPDATA"], "Programs", "Codex", "codex.exe")
        : null,
      process.env["LOCALAPPDATA"]
        ? join(process.env["LOCALAPPDATA"], "Codex", "codex.exe")
        : null,
      "C:\\Program Files\\Codex\\codex.exe",
      "C:\\Program Files (x86)\\Codex\\codex.exe",
    ];

    for (const candidate of windowsCandidates) {
      if (candidate && existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return "codex";
}

function createCodexAppServerSpawnSpec(
  executablePath: string,
  platform: NodeJS.Platform = process.platform,
): SpawnSpec {
  if (platform === "win32") {
    const extension = extname(executablePath).toLowerCase();
    if (extension === ".cmd" || extension === ".bat") {
      return {
        command: `${quoteWindowsShellArgument(executablePath)} app-server`,
        args: [],
        shell: true,
      };
    }
  }

  return {
    command: executablePath,
    args: ["app-server"],
  };
}

function resolveWindowsCommandPath(
  commandOrPath: string,
  options: {
    lookupCommand?: (command: string) => string[];
    pathExists?: (path: string) => boolean;
  } = {},
): string | null {
  const normalized = stripWrappingQuotes(commandOrPath.trim());
  if (!normalized) {
    return null;
  }

  const pathExists = options.pathExists ?? existsSync;
  if (isPathLikeCommand(normalized)) {
    return resolveWindowsPathCandidate(normalized, pathExists);
  }

  const matches =
    options.lookupCommand?.(normalized) ??
    queryWindowsCommandMatches(normalized);
  return pickPreferredWindowsCommandPath(matches);
}

function resolveWindowsPathCandidate(
  commandPath: string,
  pathExists: (path: string) => boolean,
): string | null {
  const extension = extname(commandPath).toLowerCase();
  if (extension) {
    return pathExists(commandPath) ? commandPath : null;
  }

  for (const candidateExtension of [".exe", ".cmd", ".bat", ".com"]) {
    const candidate = `${commandPath}${candidateExtension}`;
    if (pathExists(candidate)) {
      return candidate;
    }
  }

  return pathExists(commandPath) ? commandPath : null;
}

function queryWindowsCommandMatches(command: string): string[] {
  const result = spawnSync("where.exe", [command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (
    result.error ||
    result.status !== 0 ||
    typeof result.stdout !== "string"
  ) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function pickPreferredWindowsCommandPath(paths: string[]): string | null {
  const ranked = paths
    .map((path) => ({
      path,
      rank: getWindowsCommandExtensionRank(extname(path).toLowerCase()),
    }))
    .sort((left, right) => left.rank - right.rank);

  return ranked[0]?.path ?? null;
}

function getWindowsCommandExtensionRank(extension: string): number {
  switch (extension) {
    case ".exe":
      return 0;
    case ".cmd":
      return 1;
    case ".bat":
      return 2;
    case ".com":
      return 3;
    case "":
      return 4;
    default:
      return 5;
  }
}

function isPathLikeCommand(value: string): boolean {
  return (
    /[\\/]/u.test(value) || /^[A-Za-z]:/u.test(value) || value.startsWith(".")
  );
}

function stripWrappingQuotes(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function quoteWindowsShellArgument(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function isCommandAvailable(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore",
  });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return code !== "ENOENT";
  }

  return result.status === 0;
}

let client: CodexAppServerClient | null = null;
let clientOverride: CodexAppServerClientFacade | null = null;

export interface CodexAppServerClientFacade {
  listModels: (limit?: number) => Promise<CodexModelOption[]>;
  listCollaborationModes: () => Promise<CodexCollaborationModeOption[]>;
  listSkills?: (input: CodexSkillsListInput) => Promise<CodexSkillsListEntry[]>;
  writeSkillConfig?: (
    path: string,
    enabled: boolean,
  ) => Promise<CodexSkillsConfigWriteResult>;
  createThread: (input: CreateCodexThreadInput) => Promise<string>;
  setThreadName?: (threadId: string, name: string) => Promise<void>;
  forkThread?: (threadId: string) => Promise<CodexThreadSummary>;
  compactThread?: (threadId: string) => Promise<void>;
  getThreadSummary?: (threadId: string) => Promise<CodexThreadSummary>;
  listLoadedThreadIds?: () => Promise<string[]>;
  sendMessage: (
    input: SendCodexMessageInput,
  ) => Promise<SendCodexMessageResult>;
  getThreadState: (
    threadId: string,
    requestedTurnId?: string | null,
  ) => Promise<CodexThreadState>;
  getLastTurnDiff: (threadId: string) => Promise<CodexLastTurnDiff>;
  interruptThread: (threadId: string) => Promise<void>;
  cleanBackgroundTerminals?: (threadId: string) => Promise<void>;
  listPendingUserInputRequests: (threadId: string) => CodexUserInputRequest[];
  submitUserInput: (
    threadId: string,
    requestId: string,
    response: CodexUserInputResponsePayload,
  ) => Promise<void>;
  listPendingApprovalRequests?: (threadId: string) => CodexApprovalRequest[];
  submitApproval?: (
    threadId: string,
    requestId: string,
    response: CodexApprovalResponsePayload,
  ) => Promise<void>;
  listLiveTerminalRuns?: (threadId: string) => CodexLiveTerminalRun[];
  getLiveTerminalRun?: (
    threadId: string,
    processId: string,
  ) => CodexLiveTerminalRun | null;
}

export function getCodexAppServerClient(): CodexAppServerClientFacade {
  if (clientOverride) {
    return clientOverride;
  }

  if (!client) {
    client = new CodexAppServerClient();
  }

  return {
    listModels: (limit?: number) => client!.listModels(limit),
    listCollaborationModes: () => client!.listCollaborationModes(),
    listSkills: (input: CodexSkillsListInput) => client!.listSkills(input),
    writeSkillConfig: (path: string, enabled: boolean) =>
      client!.writeSkillConfig(path, enabled),
    createThread: (input: CreateCodexThreadInput) =>
      client!.createThread(input),
    setThreadName: (threadId: string, name: string) =>
      client!.setThreadName(threadId, name),
    forkThread: (threadId: string) => client!.forkThread(threadId),
    compactThread: (threadId: string) => client!.compactThread(threadId),
    getThreadSummary: (threadId: string) => client!.getThreadSummary(threadId),
    listLoadedThreadIds: () => client!.listLoadedThreadIds(),
    sendMessage: (input: SendCodexMessageInput) => client!.sendMessage(input),
    getThreadState: (threadId: string, requestedTurnId?: string | null) =>
      client!.getThreadState(threadId, requestedTurnId),
    getLastTurnDiff: (threadId: string) => client!.getLastTurnDiff(threadId),
    interruptThread: (threadId: string) => client!.interruptThread(threadId),
    cleanBackgroundTerminals: (threadId: string) =>
      client!.cleanBackgroundTerminals(threadId),
    listPendingUserInputRequests: (threadId: string) =>
      client!.listPendingUserInputRequests(threadId),
    submitUserInput: (
      threadId: string,
      requestId: string,
      response: CodexUserInputResponsePayload,
    ) => client!.submitUserInput(threadId, requestId, response),
    listPendingApprovalRequests: (threadId: string) =>
      client!.listPendingApprovalRequests(threadId),
    submitApproval: (
      threadId: string,
      requestId: string,
      response: CodexApprovalResponsePayload,
    ) => client!.submitApproval(threadId, requestId, response),
    listLiveTerminalRuns: (threadId: string) =>
      client!.listLiveTerminalRuns(threadId),
    getLiveTerminalRun: (threadId: string, processId: string) =>
      client!.getLiveTerminalRun(threadId, processId),
  };
}

export function setCodexAppServerClientForTests(
  override: CodexAppServerClientFacade | null,
): void {
  clientOverride = override;
}

export async function closeCodexAppServerClient(): Promise<void> {
  if (!client) {
    return;
  }

  const current = client;
  client = null;
  await current.close();
}

export function isCodexReasoningEffort(
  value: unknown,
): value is CodexReasoningEffort {
  return toReasoningEffort(value) !== null;
}

export function isCodexServiceTier(value: unknown): value is CodexServiceTier {
  return toServiceTier(value) !== null;
}

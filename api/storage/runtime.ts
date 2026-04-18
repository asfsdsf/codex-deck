import {
  readdir,
  readFile,
  stat,
  open,
  appendFile,
  writeFile,
  rm,
} from "fs/promises";
import { basename, isAbsolute, join, resolve } from "path";
import { homedir } from "os";
import { spawnSync } from "node:child_process";
import { parseConversationTextChunk } from "../conversation-parser";
import { splitPathSegments } from "../path-utils";

export interface HistoryEntry {
  sessionId: string;
  timestamp: number;
  text: string;
}

export interface Session {
  id: string;
  display: string;
  timestamp: number;
  project: string;
  projectName: string;
}

export interface SessionsDeltaResponse {
  version: number;
  isFullSnapshot: boolean;
  sessions: Session[];
  updates: Session[];
  removedSessionIds: string[];
  skillsChangedSessionIds: string[];
}

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

export interface CreateCodexThreadRequest {
  cwd: string;
  model?: string | null;
  effort?: CodexReasoningEffort | null;
}

export interface CreateCodexThreadResponse {
  threadId: string;
}

export interface SendCodexMessageRequest {
  text?: string;
  input?: SendCodexMessageInputItem[];
  cwd?: string;
  model?: string | null;
  serviceTier?: CodexServiceTier | null;
  effort?: CodexReasoningEffort | null;
  collaborationMode?: CodexCollaborationModeInput | null;
}

export type SendCodexMessageInputItem =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      url: string;
    };

export interface SendCodexMessageResponse {
  ok: boolean;
  turnId: string | null;
}

export type CodexTurnStatus =
  | "inProgress"
  | "completed"
  | "failed"
  | "interrupted";

export interface CodexThreadStateResponse {
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

export interface CodexThreadNameSetRequest {
  name: string;
}

export interface CodexThreadNameSetResponse {
  ok: boolean;
}

export interface CodexThreadForkResponse {
  thread: CodexThreadSummary;
}

export interface CodexThreadCompactResponse {
  ok: boolean;
}

export interface CodexThreadAgentListResponse {
  threads: CodexThreadSummary[];
}

export interface CodexThreadSummariesRequest {
  threadIds: string[];
}

export interface CodexThreadSummariesResponse {
  threads: CodexThreadSummary[];
}

export interface CodexSessionWaitStateResponse {
  sessionId: string;
  isWaiting: boolean;
  activeTurnId: string | null;
  danglingTurnIds: string[];
}

export interface SessionFileStats {
  mtimeMs: number;
  size: number;
}

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

export interface CodexSessionContextResponse {
  sessionId: string;
  contextLeftPercent: number | null;
  usedTokens: number | null;
  modelContextWindow: number | null;
  tokenUsage: CodexSessionTokenUsage | null;
}

export interface CodexSessionTokenUsage {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
}

export interface SystemContextResponse {
  osName: string;
  osRelease: string;
  osVersion: string | null;
  architecture: string;
  platform: string;
  hostname: string;
  defaultShell: string | null;
}

export interface CodexConfigDefaultsResponse {
  model: string | null;
  reasoningEffort: CodexReasoningEffort | null;
  planModeReasoningEffort: CodexReasoningEffort | null;
}

export interface FixDanglingSessionResponse {
  sessionId: string;
  filePath: string;
  startedTurnCount: number;
  endedTurnCountBefore: number;
  endedTurnCountAfter: number;
  danglingTurnIds: string[];
  appendedTurnIds: string[];
}

export interface SessionExistsResponse {
  sessionId: string;
  exists: boolean;
}

export interface DeleteSessionSqliteResult {
  dbPath: string | null;
  logsDbPath: string | null;
  threadsDeleted: number;
  logsDeleted: number;
  skippedReason: string | null;
  warnings: string[];
}

export interface DeleteSessionResponse {
  sessionId: string;
  removedSessionFilePaths: string[];
  removedHistoryEntries: number;
  removedSessionIndexEntries: number;
  sqlite: DeleteSessionSqliteResult;
}

export interface SessionsRemovedEvent {
  sessionIds: string[];
  actorClientId: string | null;
  timestampMs: number;
}

export type SessionDiffMode = "unstaged" | "staged" | "last-turn" | "file-tree";

export interface SessionDiffFile {
  path: string;
  status: string;
  diff: string;
}

export interface SessionDiffResponse {
  sessionId: string;
  mode: SessionDiffMode;
  projectPath: string | null;
  turnId: string | null;
  files: SessionDiffFile[];
  unavailableReason: string | null;
}

export interface SessionTerminalRunSummary {
  processId: string;
  callId: string;
  command: string;
  isRunning: boolean;
  startedAt: string | null;
  endedAt: string | null;
  latestActivityAt: string | null;
}

export interface SessionTerminalRunsResponse {
  sessionId: string;
  runs: SessionTerminalRunSummary[];
  unavailableReason: string | null;
}

export interface SessionTerminalRunOutputResponse {
  sessionId: string;
  processId: string;
  command: string;
  isRunning: boolean;
  output: string;
  unavailableReason: string | null;
}

export interface TerminalSummary {
  id: string;
  terminalId: string;
  boundSessionId?: string | null;
  display: string;
  firstCommand: string | null;
  timestamp: number;
  project: string;
  projectName: string;
  cwd: string;
  shell: string;
  running: boolean;
}

export interface TerminalListResponse {
  terminals: TerminalSummary[];
}

export interface TerminalBindingResponse {
  terminalId: string;
  boundSessionId: string | null;
}

export interface TerminalBindSessionRequest {
  sessionId?: string | null;
}

export type TerminalSessionRole = "terminal";

export interface TerminalSessionRoleSummary {
  sessionId: string;
  role: TerminalSessionRole;
  terminalId: string;
}

export interface TerminalSessionRolesRequest {
  sessionIds: string[];
}

export interface TerminalSessionRolesResponse {
  sessions: TerminalSessionRoleSummary[];
}

export interface CreateTerminalRequest {
  cwd?: string;
}

export interface TerminalSnapshotResponse {
  id: string;
  terminalId: string;
  running: boolean;
  cwd: string;
  shell: string;
  output: string;
  seq: number;
  writeOwnerId: string | null;
}

export interface TerminalInputRequest {
  input: string;
}

export interface TerminalExecuteCommandRequest {
  command: string;
  cwd?: string | null;
  timeoutMs?: number;
  displayCommand?: string | null;
}

export interface TerminalResizeRequest {
  cols: number;
  rows: number;
}

export interface TerminalClaimWriteRequest {
  clientId: string;
}

export interface TerminalReleaseWriteRequest {
  clientId: string;
}

export interface TerminalCommandResponse {
  ok: boolean;
  id: string;
  terminalId: string;
  running: boolean;
  seq: number;
  writeOwnerId: string | null;
}

export interface TerminalInputResponse extends TerminalCommandResponse {
  startSeq: number;
  startOffset: number;
}

export interface TerminalExecuteCommandResponse extends TerminalCommandResponse {
  startSeq: number;
  startOffset: number;
  endSeq: number;
  exitCode: number | null;
  cwdAfter: string;
  rawOutput: string;
  timedOut: boolean;
}

export type TerminalStreamEvent =
  | {
      terminalId: string;
      seq: number;
      type: "output";
      chunk: string;
    }
  | {
      terminalId: string;
      seq: number;
      type: "state";
      running: boolean;
    }
  | {
      terminalId: string;
      seq: number;
      type: "reset";
      output: string;
      running: boolean;
    }
  | {
      terminalId: string;
      seq: number;
      type: "ownership";
      writeOwnerId: string | null;
    };

export interface TerminalEventsResponse {
  events: TerminalStreamEvent[];
  requiresReset: boolean;
  snapshot: TerminalSnapshotResponse | null;
}

export type TerminalSessionMessageActionDecision = "approved" | "rejected";

export interface TerminalSessionMessageActionStep {
  stepId: string;
  decision: TerminalSessionMessageActionDecision;
  reason: string | null;
  updatedAt: string;
}

export interface TerminalSessionMessageAction {
  kind: "ai-terminal-step-actions";
  steps: TerminalSessionMessageActionStep[];
}

export type TerminalSessionBlockKind = "execution" | "manual";

export interface TerminalSessionBlockRecord {
  blockId: string;
  terminalId: string;
  sessionId: string;
  kind: TerminalSessionBlockKind;
  sequence: number;
  createdAt: string;
  updatedAt: string;
  messageKey: string | null;
  stepId: string | null;
  transcriptPath: string | null;
  transcriptLength: number;
  action: TerminalSessionMessageAction | null;
}

export interface TerminalSessionBlockRecordWithTranscript
  extends TerminalSessionBlockRecord {
  transcript: string | null;
}

export interface TerminalSessionArtifactsManifest {
  terminalId: string;
  createdAt: string;
  updatedAt: string;
  blocks: TerminalSessionBlockRecord[];
}

export interface TerminalPersistFrozenBlockRequest {
  sessionId: string;
  kind?: TerminalSessionBlockKind | null;
  messageKey?: string | null;
  transcript: string;
  stepId?: string | null;
  sequence?: number | null;
}

export interface TerminalPersistFrozenBlockResponse {
  block: TerminalSessionBlockRecord;
}

export interface TerminalPersistMessageActionRequest {
  sessionId: string;
  messageKey: string;
  stepId: string;
  decision: TerminalSessionMessageActionDecision;
  reason?: string | null;
}

export interface TerminalPersistMessageActionResponse {
  terminalId: string;
  sessionId: string;
  messageKey: string;
  action: TerminalSessionMessageAction;
}

export interface TerminalSessionArtifactsResponse {
  terminalId: string;
  sessionId: string | null;
  manifest: TerminalSessionArtifactsManifest;
  blocks: TerminalSessionBlockRecordWithTranscript[];
}

export interface SessionFileTreeResponse {
  sessionId: string;
  projectPath: string | null;
  files: string[];
  unavailableReason: string | null;
}

export interface SessionFileTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface SessionFileTreeNodesResponse {
  sessionId: string;
  projectPath: string | null;
  dir: string;
  nodes: SessionFileTreeNode[];
  nextCursor: number | null;
  unavailableReason: string | null;
}

export interface SessionFileSearchResponse {
  sessionId: string;
  projectPath: string | null;
  query: string;
  files: string[];
  unavailableReason: string | null;
}

export type SessionFileContentPreviewKind = "image" | "pdf";

export interface SessionFileContentResponse {
  sessionId: string;
  projectPath: string | null;
  path: string;
  content: string;
  page: number;
  totalPages: number;
  paginationMode: "bytes" | "lines";
  lineStart: number | null;
  lineEnd: number | null;
  isBinary: boolean;
  previewKind: SessionFileContentPreviewKind | null;
  previewMediaType: string | null;
  previewDataUrl: string | null;
  previewUnavailableReason: string | null;
  unavailableReason: string | null;
}

export type WorkflowStatus =
  | "draft"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
export type WorkflowTaskStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "cancelled";

export interface WorkflowTaskCounts {
  total: number;
  cancelled: number;
  failed: number;
  pending: number;
  running: number;
  success: number;
}

export interface WorkflowRecentOutcome {
  taskId: string;
  status: WorkflowTaskStatus;
  resultCommit: string | null;
  failureReason: string | null;
  noOp: boolean;
  stopPending: boolean;
  finishedAt: string | null;
  summary: string | null;
}

export interface WorkflowSummary {
  key: string;
  workflowPath: string;
  id: string;
  title: string;
  status: WorkflowStatus;
  projectRoot: string;
  projectName: string;
  targetBranch: string | null;
  updatedAt: string | null;
  createdAt: string | null;
  request: string | null;
  boundSessionId: string | null;
  schedulerRunning: boolean;
  schedulerPendingTrigger: boolean;
  schedulerLastSessionId: string | null;
  schedulerThreadId: string | null;
  schedulerLastReason: string | null;
  schedulerLastRunAt: string | null;
  schedulerLastTurnStatus: string | null;
  maxParallel: number | null;
  mergePolicy: string | null;
  taskCounts: WorkflowTaskCounts;
  recentOutcomes: WorkflowRecentOutcome[];
}

export interface WorkflowTaskSummary {
  id: string;
  name: string;
  prompt: string;
  dependsOn: string[];
  status: WorkflowTaskStatus;
  sessionId: string | null;
  branchName: string | null;
  worktreePath: string | null;
  baseCommit: string | null;
  resultCommit: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  summary: string | null;
  failureReason: string | null;
  noOp: boolean;
  stopPending: boolean;
  runnerPid: number | null;
  ready: boolean;
}

export interface WorkflowHistoryEntry {
  at: string | null;
  type: string;
  details: Record<string, unknown>;
}

export interface WorkflowControlMessage {
  requestId: string | null;
  type: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string | null;
}

export interface WorkflowSchedulerState {
  running: boolean;
  pendingTrigger: boolean;
  lastRunAt: string | null;
  lastSessionId: string | null;
  threadId: string | null;
  lastTurnId: string | null;
  lastTurnStatus: string | null;
  lastReason: string | null;
  controllerMode: string | null;
  controller: Record<string, unknown>;
  builtInPrompt: string | null;
  lastComposedPrompt: string | null;
  controlMessages: WorkflowControlMessage[];
}

export interface WorkflowDetailResponse {
  summary: WorkflowSummary;
  boundSessionId: string | null;
  settings: {
    codexHome: string | null;
    codexCliPath: string | null;
    maxParallel: number | null;
    mergePolicy: string | null;
    stopSignal: string | null;
  };
  scheduler: WorkflowSchedulerState;
  tasks: WorkflowTaskSummary[];
  history: WorkflowHistoryEntry[];
  raw: Record<string, unknown>;
}

export type WorkflowSessionRole = "bound" | "scheduler" | "task";

export interface WorkflowSessionLookupResponse {
  sessionId: string;
  role: WorkflowSessionRole;
  taskId: string | null;
  workflow: WorkflowSummary;
}

export interface WorkflowSessionLookupResult {
  match: WorkflowSessionLookupResponse | null;
}

export interface WorkflowSessionRoleSummary {
  sessionId: string;
  role: WorkflowSessionRole;
  taskId: string | null;
}

export interface WorkflowSessionRolesRequest {
  sessionIds: string[];
}

export interface WorkflowSessionRolesResponse {
  sessions: WorkflowSessionRoleSummary[];
}

export interface WorkflowLogResponse {
  key: string;
  scope: "scheduler" | "task" | "daemon";
  taskId: string | null;
  path: string | null;
  content: string;
  unavailableReason: string | null;
}

export interface WorkflowDaemonStatusResponse {
  state: string;
  pid: number | null;
  port: number | null;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  lastRequestAt: string | null;
  queueDepth: number | null;
  activeProjects: string[];
  activeWorkflows: string[];
  daemonId: string | null;
  daemonLogPath: string | null;
}

export interface WorkflowActionResponse {
  ok: boolean;
  command: string;
  workflowKey: string | null;
  output: string | null;
}

export interface CreateWorkflowRequest {
  title: string;
  request: string;
  projectRoot?: string | null;
  workflowId?: string | null;
  targetBranch?: string | null;
  taskCount?: number | null;
  tasksJson?: string | null;
  sequential?: boolean;
  maxParallel?: number | null;
}

export interface WorkflowCreateResponse extends WorkflowActionResponse {
  workflowKey: string;
  workflowPath: string;
}

export interface WorkflowControlMessageRequest {
  type: string;
  reason?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface WorkflowBindSessionRequest {
  sessionId?: string | null;
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

export interface SessionSkillsResponse {
  sessionId: string;
  projectPath: string | null;
  cwd: string | null;
  skills: CodexSkillMetadata[];
  errors: CodexSkillErrorInfo[];
  unavailableReason: string | null;
}

export interface SessionSkillConfigWriteRequest {
  path: string;
  enabled: boolean;
}

export interface SessionSkillConfigWriteResponse {
  sessionId: string;
  path: string;
  enabled: boolean;
  effectiveEnabled: boolean;
}

export interface ConversationMessage {
  type:
    | "user"
    | "assistant"
    | "summary"
    | "file-history-snapshot"
    | "reasoning"
    | "agent_reasoning"
    | "system_error"
    | "token_limit_notice"
    | "turn_aborted"
    | "task_started"
    | "task_complete";
  uuid?: string;
  parentUuid?: string;
  turnId?: string;
  timestamp?: string;
  sessionId?: string;
  message?: {
    role: string;
    content: string | ContentBlock[];
    model?: string;
    usage?: TokenUsage;
  };
  summary?: string;
  repeatCount?: number;
  repeatCountMax?: number;
  rateLimitId?: string | null;
}

export interface ContentBlock {
  type:
    | "text"
    | "image"
    | "thinking"
    | "tool_use"
    | "tool_result"
    | "reasoning"
    | "agent_reasoning";
  text?: string;
  image_url?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  timestamp?: string;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface StreamResult {
  messages: ConversationMessage[];
  nextOffset: number;
  done: boolean;
}

export interface ConversationStreamOptions {
  maxPayloadBytes?: number;
}

export interface ConversationRawChunkResponse {
  chunkBase64: string;
  nextOffset: number;
  done: boolean;
}

export interface ConversationRawWindowResponse {
  chunkBase64: string;
  startOffset: number;
  endOffset: number;
  fileSize: number;
  done: boolean;
}

interface SessionMeta {
  id: string;
  cwd: string;
  timestamp: number;
}

interface SessionHistory {
  timestamp: number;
  text: string;
}

interface LineWithOffset {
  line: string;
  offset: number;
}

interface SessionWaitStateCacheEntry {
  filePath: string;
  mtimeMs: number;
  size: number;
  result: CodexSessionWaitStateResponse;
}

interface PendingToolUse {
  callId: string;
  name: string;
  input: Record<string, unknown>;
  timestamp?: string;
  lineOffset: number;
}

interface TerminalRunRecord {
  processId: string;
  callId: string;
  command: string;
  isRunning: boolean;
  startedAt: string | null;
  startedAtMs: number;
  endedAt: string | null;
  endedAtMs: number;
  latestActivityAt: string | null;
  latestActivitySortKey: number;
  outputParts: string[];
}

const TOOL_RESULT_MAX_LENGTH = 200_000;
const CONTEXT_WINDOW_BASELINE_TOKENS = 12_000;
const TURN_ABORTED_DEFAULT_TEXT =
  "The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed; verify current state before retrying.";
const TURN_ABORTED_DEFAULT_TEXT_VARIANTS = [
  TURN_ABORTED_DEFAULT_TEXT,
  "The user interrupted the previous turn on purpose. Any running unified exec processes were terminated. If any tools/commands were aborted, they may have partially executed; verify current state before retrying.",
  "This turn was interrupted before the assistant finished responding.",
];
const TURN_ABORTED_TAG_REGEX =
  /^\s*<turn_aborted>\s*([\s\S]*?)\s*<\/turn_aborted>\s*$/i;
const TOKEN_LIMIT_NOTICE_TITLE = "Rate Limit Reached";
const TOKEN_LIMIT_NOTICE_REPEAT_MAX = 6;
const TOKEN_LIMIT_NOTICE_TEXT =
  "Token count updates hit the Codex rate limit. Codex is waiting and retrying automatically.";
const SESSION_INDEX_FILENAME = "session_index.jsonl";
const SQLITE_BUSY_TIMEOUT_MS = 5000;
const STATE_DB_FILE_REGEX = /^state_(\d+)\.sqlite$/i;
const LOGS_DB_FILE_REGEX = /^logs_(\d+)\.sqlite$/i;
const LEGACY_STATE_DB_FILE = "state.sqlite";
const LEGACY_LOGS_DB_FILE = "logs.sqlite";
const HISTORY_SESSION_ID_KEYS = ["session_id", "sessionId", "conversation_id"];
const SESSION_INDEX_ID_KEYS = ["id", "thread_id", "threadId"];

let codexDir = join(homedir(), ".codex");
let codexHistoryPath = join(codexDir, "history.jsonl");
let codexSessionsDir = join(codexDir, "sessions");

const fileIndex = new Map<string, string>();
const sessionMetaIndex = new Map<string, SessionMeta>();
const sessionDisplayCache = new Map<string, string>();
const sessionWaitStateCache = new Map<string, SessionWaitStateCacheEntry>();
let historyCache: Map<string, SessionHistory> | null = null;

const pendingRequests = new Map<string, Promise<unknown>>();
const sessionToolNameIndex = new Map<string, Map<string, string>>();

export function initStorage(dir?: string): void {
  codexDir = dir ?? join(homedir(), ".codex");
  codexHistoryPath = join(codexDir, "history.jsonl");
  codexSessionsDir = join(codexDir, "sessions");
  sessionWaitStateCache.clear();
}

export function getCodexDir(): string {
  return codexDir;
}

// Backward-compatible export to avoid breaking existing imports.
export function getClaudeDir(): string {
  return getCodexDir();
}

export function invalidateHistoryCache(): void {
  historyCache = null;
}

export function addToFileIndex(sessionId: string, filePath: string): void {
  fileIndex.set(sessionId, filePath);
  sessionDisplayCache.delete(sessionId);
  sessionWaitStateCache.delete(sessionId);
  void hydrateSessionMeta(sessionId, filePath);
}

function clearSessionCaches(sessionId: string): void {
  fileIndex.delete(sessionId);
  sessionMetaIndex.delete(sessionId);
  sessionDisplayCache.delete(sessionId);
  sessionWaitStateCache.delete(sessionId);
  sessionToolNameIndex.delete(sessionId);
  if (historyCache) {
    historyCache.delete(sessionId);
  }
}

function resolvePathWithHome(value: string, baseDir: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return baseDir;
  }

  if (trimmed.startsWith("~/")) {
    return join(homedir(), trimmed.slice(2));
  }
  if (trimmed === "~") {
    return homedir();
  }
  if (isAbsolute(trimmed)) {
    return trimmed;
  }
  return resolve(baseDir, trimmed);
}

function extractTomlStringValue(value: string): string | null {
  const trimmed = value.trim();
  const singleQuotedMatch = trimmed.match(/^'([^']*)'$/);
  if (singleQuotedMatch) {
    return singleQuotedMatch[1];
  }

  const doubleQuotedMatch = trimmed.match(/^"((?:\\.|[^"])*)"$/);
  if (!doubleQuotedMatch) {
    return null;
  }

  try {
    return JSON.parse(`"${doubleQuotedMatch[1]}"`) as string;
  } catch {
    return null;
  }
}

function stripTomlLineComment(line: string): string {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (inDoubleQuote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inDoubleQuote = false;
      }
      continue;
    }

    if (inSingleQuote) {
      if (char === "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (char === '"') {
      inDoubleQuote = true;
      continue;
    }

    if (char === "'") {
      inSingleQuote = true;
      continue;
    }

    if (char === "#") {
      return line.slice(0, index);
    }
  }

  return line;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseTopLevelTomlStringSettings(
  content: string,
  keys: string[],
): Record<string, string | null> {
  const results = Object.fromEntries(keys.map((key) => [key, null])) as Record<
    string,
    string | null
  >;
  let inTopLevel = true;

  for (const line of content.split("\n")) {
    const withoutComment = stripTomlLineComment(line).trim();
    if (!withoutComment) {
      continue;
    }

    if (
      /^\[\[.*\]\]$/.test(withoutComment) ||
      /^\[.*\]$/.test(withoutComment)
    ) {
      inTopLevel = false;
      continue;
    }

    if (!inTopLevel) {
      continue;
    }

    for (const key of keys) {
      const match = withoutComment.match(
        new RegExp(`^${escapeRegExp(key)}\\s*=\\s*(.+?)\\s*$`),
      );
      if (!match) {
        continue;
      }

      const parsedValue = extractTomlStringValue(match[1]);
      if (parsedValue !== null) {
        results[key] = parsedValue.trim();
      }
      break;
    }
  }

  return results;
}

function toConfiguredReasoningEffort(
  value: string | null | undefined,
): CodexReasoningEffort | null {
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

function getJsonRecordValue(
  record: Record<string, unknown>,
  keys: string[],
): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function getProjectName(projectPath: string): string {
  const parts = splitPathSegments(projectPath);
  return parts[parts.length - 1] || projectPath;
}

function normalizeDisplayText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(no prompt text)";
  }
  return normalized.length > 240
    ? `${normalized.slice(0, 240)}...`
    : normalized;
}

function extractSessionIdFromPath(filePath: string): string | null {
  const name = basename(filePath);
  const match = name.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  );
  return match?.[1] ?? null;
}

function parseTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return asNumber;
    }
    const asDate = Date.parse(value);
    if (!Number.isNaN(asDate)) {
      return asDate;
    }
  }
  return 0;
}

function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function parseFiniteNumber(value: unknown): number | null {
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

function parseTokenUsageSummary(value: unknown): CodexSessionTokenUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const inputTokensRaw =
    parseFiniteNumber(record.input_tokens) ??
    parseFiniteNumber(record.inputTokens);
  const outputTokensRaw =
    parseFiniteNumber(record.output_tokens) ??
    parseFiniteNumber(record.outputTokens);
  const totalTokensRaw =
    parseFiniteNumber(record.total_tokens) ??
    parseFiniteNumber(record.totalTokens);
  const cachedInputTokensRaw =
    parseFiniteNumber(record.cached_input_tokens) ??
    parseFiniteNumber(record.cachedInputTokens) ??
    parseFiniteNumber(record.cache_read_input_tokens);

  let inputTokens =
    inputTokensRaw !== null ? Math.max(0, Math.round(inputTokensRaw)) : null;
  const outputTokens =
    outputTokensRaw !== null ? Math.max(0, Math.round(outputTokensRaw)) : null;
  const totalTokensRounded =
    totalTokensRaw !== null ? Math.max(0, Math.round(totalTokensRaw)) : null;
  const cachedInputTokens =
    cachedInputTokensRaw !== null
      ? Math.max(0, Math.round(cachedInputTokensRaw))
      : 0;

  if (inputTokens !== null) {
    inputTokens = Math.max(0, inputTokens - cachedInputTokens);
  } else if (totalTokensRounded !== null && outputTokens !== null) {
    inputTokens = Math.max(0, totalTokensRounded - outputTokens);
  }

  if (inputTokens === null || outputTokens === null) {
    return null;
  }

  return {
    totalTokens: Math.max(0, inputTokens + outputTokens),
    inputTokens,
    outputTokens,
  };
}

function parseRecordLine(line: string): {
  timestampMs: number;
  timestampText: string | null;
  type: string;
  payload: Record<string, unknown>;
} | null {
  const parsed = safeJsonParse(line);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const record = parsed as {
    timestamp?: unknown;
    type?: unknown;
    payload?: unknown;
  };
  if (!record.payload || typeof record.payload !== "object") {
    return null;
  }

  const type = typeof record.type === "string" ? record.type : "";
  if (!type) {
    return null;
  }

  const timestampText =
    typeof record.timestamp === "string" && record.timestamp.trim()
      ? record.timestamp
      : null;
  const timestampMs = timestampText ? parseTimestamp(timestampText) : 0;

  return {
    timestampMs,
    timestampText,
    type,
    payload: record.payload as Record<string, unknown>,
  };
}

function toProcessId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function toCallId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return null;
}

function getPayloadType(payload: Record<string, unknown>): string {
  const directType =
    typeof payload.type === "string" ? payload.type.trim() : "";
  if (directType) {
    return directType;
  }

  const nested = payload.msg;
  if (!nested || typeof nested !== "object") {
    return "";
  }

  const nestedType =
    typeof (nested as Record<string, unknown>).type === "string"
      ? (nested as Record<string, unknown>).type
      : "";
  return nestedType.trim();
}

function getEventPayloadRecord(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const nested = payload.msg;
  if (!nested || typeof nested !== "object") {
    return payload;
  }

  const nestedRecord = nested as Record<string, unknown>;
  if (typeof nestedRecord.type === "string" && nestedRecord.type.trim()) {
    return nestedRecord;
  }

  return payload;
}

function getPayloadValue(
  payload: Record<string, unknown>,
  ...keys: string[]
): unknown {
  for (const key of keys) {
    if (payload[key] !== undefined) {
      return payload[key];
    }
  }

  const nested = payload.msg;
  if (!nested || typeof nested !== "object") {
    return undefined;
  }

  const nestedRecord = nested as Record<string, unknown>;
  for (const key of keys) {
    if (nestedRecord[key] !== undefined) {
      return nestedRecord[key];
    }
  }

  return undefined;
}

function parseToolArguments(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const parsed = safeJsonParse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  return parsed as Record<string, unknown>;
}

function toCommandDisplay(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const parts = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      return parts.join(" ");
    }
  }
  return "(unknown command)";
}

function toCommandDisplayFromExecEvent(
  payload: Record<string, unknown>,
): string {
  const parsedCommand = getPayloadValue(payload, "parsed_cmd", "parsedCmd");
  if (Array.isArray(parsedCommand)) {
    for (const part of parsedCommand) {
      if (!part || typeof part !== "object") {
        continue;
      }

      const command = (part as Record<string, unknown>).cmd;
      if (typeof command === "string" && command.trim()) {
        return command.trim();
      }
    }
  }

  return toCommandDisplay(getPayloadValue(payload, "command"));
}

function isUnifiedExecSource(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return (
    normalized === "unified_exec_startup" ||
    normalized === "unified_exec_interaction"
  );
}

function decodeBase64Chunk(value: unknown): string {
  if (typeof value !== "string" || !value) {
    return "";
  }

  try {
    return Buffer.from(value, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

function formatStdinChunk(stdin: string): string {
  const normalized = stdin.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const prefixed = lines.map((line) => `$ ${line}`).join("\n");
  return `${prefixed}\n`;
}

function splitToolOutputSections(output: string): {
  header: string;
  body: string;
} {
  const normalized = output.replace(/\r\n/g, "\n");
  const outputMarker = "\nOutput:\n";
  const outputMarkerIndex = normalized.indexOf(outputMarker);
  if (outputMarkerIndex >= 0) {
    return {
      header: normalized.slice(0, outputMarkerIndex),
      body: normalized.slice(outputMarkerIndex + outputMarker.length),
    };
  }

  if (normalized.startsWith("Output:\n")) {
    return {
      header: "",
      body: normalized.slice("Output:\n".length),
    };
  }

  return {
    header: normalized,
    body: normalized,
  };
}

function extractProcessIdFromRunningOutput(output: string): string | null {
  const { header } = splitToolOutputSections(output);
  const match = header.match(
    /(?:^|\n)\s*Process running with session ID ([^\r\n]+)\s*(?:\n|$)/i,
  );
  if (!match) {
    return null;
  }
  return toProcessId(match[1]);
}

function extractToolOutputBody(output: string): string {
  return splitToolOutputSections(output).body;
}

function toolOutputIndicatesProcessExit(output: string): boolean {
  const { header } = splitToolOutputSections(output);
  return /(?:^|\n)\s*Process exited with code(?:\s|$)/i.test(header);
}

function touchTerminalRun(
  run: TerminalRunRecord,
  timestampText: string | null,
  timestampMs: number,
  sortKey: number,
): void {
  run.latestActivityAt = timestampText;
  run.latestActivitySortKey = timestampMs > 0 ? timestampMs : sortKey;
}

function parseTerminalRuns(lines: LineWithOffset[]): TerminalRunRecord[] {
  const runsByProcessId = new Map<string, TerminalRunRecord>();
  const processIdByCallId = new Map<string, string>();
  const commandByCallId = new Map<string, string>();
  const processIdByWriteCallId = new Map<string, string>();

  const ensureRun = (
    processId: string,
    options: {
      callId?: string | null;
      command?: string;
      timestampText: string | null;
      timestampMs: number;
      sortKey: number;
    },
  ): TerminalRunRecord => {
    const existing = runsByProcessId.get(processId);
    if (existing) {
      if (options.callId) {
        existing.callId = options.callId;
      }
      if (
        options.command &&
        options.command !== "(unknown command)" &&
        (existing.command === "(unknown command)" ||
          existing.command.trim() === "")
      ) {
        existing.command = options.command;
      }
      if (existing.startedAt === null) {
        existing.startedAt = options.timestampText;
      }
      if (existing.startedAtMs === 0 && options.timestampMs > 0) {
        existing.startedAtMs = options.timestampMs;
      }
      return existing;
    }

    const run: TerminalRunRecord = {
      processId,
      callId: options.callId ?? processId,
      command: options.command ?? "(unknown command)",
      isRunning: true,
      startedAt: options.timestampText,
      startedAtMs: options.timestampMs > 0 ? options.timestampMs : 0,
      endedAt: null,
      endedAtMs: 0,
      latestActivityAt: options.timestampText,
      latestActivitySortKey:
        options.timestampMs > 0 ? options.timestampMs : options.sortKey,
      outputParts: [],
    };
    runsByProcessId.set(processId, run);
    return run;
  };

  for (const { line, offset } of lines) {
    const parsedLine = parseRecordLine(line);
    if (!parsedLine) {
      continue;
    }

    if (parsedLine.type === "response_item") {
      const payloadType = getPayloadType(parsedLine.payload);

      if (
        payloadType === "function_call" ||
        payloadType === "custom_tool_call"
      ) {
        const callId = toCallId(
          getPayloadValue(parsedLine.payload, "call_id", "callId", "id"),
        );
        const toolNameValue = getPayloadValue(parsedLine.payload, "name");
        const toolName = typeof toolNameValue === "string" ? toolNameValue : "";
        const args = parseToolArguments(
          getPayloadValue(parsedLine.payload, "arguments", "input"),
        );

        if (toolName === "exec_command" && callId) {
          const command = toCommandDisplay(
            args?.cmd ?? args?.command ?? args?.argv,
          );
          commandByCallId.set(callId, command);
          continue;
        }

        if (toolName === "write_stdin") {
          const processId = toProcessId(
            args?.session_id ??
              args?.sessionId ??
              args?.process_id ??
              args?.processId,
          );
          if (!processId) {
            continue;
          }

          if (callId) {
            processIdByWriteCallId.set(callId, processId);
          }

          const existingRun = runsByProcessId.get(processId);
          if (existingRun) {
            existingRun.isRunning = true;
            touchTerminalRun(
              existingRun,
              parsedLine.timestampText,
              parsedLine.timestampMs,
              offset,
            );
          }
          continue;
        }

        continue;
      }

      if (
        payloadType === "function_call_output" ||
        payloadType === "custom_tool_call_output"
      ) {
        const callId = toCallId(
          getPayloadValue(parsedLine.payload, "call_id", "callId", "id"),
        );
        if (!callId) {
          continue;
        }

        const rawOutput = getPayloadValue(parsedLine.payload, "output");
        if (typeof rawOutput !== "string") {
          continue;
        }

        const outputBody = extractToolOutputBody(rawOutput);
        const runningProcessId = extractProcessIdFromRunningOutput(rawOutput);
        if (runningProcessId) {
          const run = ensureRun(runningProcessId, {
            callId,
            command: commandByCallId.get(callId) ?? "(unknown command)",
            timestampText: parsedLine.timestampText,
            timestampMs: parsedLine.timestampMs,
            sortKey: offset,
          });
          run.isRunning = true;
          if (outputBody) {
            run.outputParts.push(outputBody);
          }
          touchTerminalRun(
            run,
            parsedLine.timestampText,
            parsedLine.timestampMs,
            offset,
          );
          processIdByCallId.set(callId, runningProcessId);
          continue;
        }

        const processId =
          processIdByWriteCallId.get(callId) ??
          processIdByCallId.get(callId) ??
          null;
        if (!processId) {
          continue;
        }

        const run = ensureRun(processId, {
          timestampText: parsedLine.timestampText,
          timestampMs: parsedLine.timestampMs,
          sortKey: offset,
        });
        if (outputBody) {
          run.outputParts.push(outputBody);
        }
        if (toolOutputIndicatesProcessExit(rawOutput)) {
          runsByProcessId.delete(processId);
          if (callId) {
            processIdByCallId.delete(callId);
          }
          processIdByWriteCallId.delete(callId);
          continue;
        }
        touchTerminalRun(
          run,
          parsedLine.timestampText,
          parsedLine.timestampMs,
          offset,
        );
      }

      continue;
    }

    if (parsedLine.type !== "event_msg") {
      continue;
    }

    const eventPayload = getEventPayloadRecord(parsedLine.payload);
    const payloadType = getPayloadType(parsedLine.payload);
    if (!payloadType) {
      continue;
    }

    const callId = toCallId(getPayloadValue(eventPayload, "call_id", "callId"));

    if (payloadType === "turn_aborted") {
      const reason = getPayloadValue(eventPayload, "reason");
      if (
        typeof reason === "string" &&
        reason.trim().toLowerCase() === "interrupted"
      ) {
        runsByProcessId.clear();
      }
      continue;
    }

    if (payloadType === "exec_command_begin") {
      const processId = toProcessId(
        getPayloadValue(eventPayload, "process_id", "processId"),
      );
      if (!processId || !callId) {
        continue;
      }

      if (!isUnifiedExecSource(getPayloadValue(eventPayload, "source"))) {
        continue;
      }

      const command = toCommandDisplayFromExecEvent(eventPayload);
      const run = ensureRun(processId, {
        callId,
        command,
        timestampText: parsedLine.timestampText,
        timestampMs: parsedLine.timestampMs,
        sortKey: offset,
      });
      run.isRunning = true;
      run.endedAt = null;
      run.endedAtMs = 0;
      touchTerminalRun(
        run,
        parsedLine.timestampText,
        parsedLine.timestampMs,
        offset,
      );
      processIdByCallId.set(callId, processId);
      commandByCallId.set(callId, command);
      continue;
    }

    if (payloadType === "exec_command_output_delta") {
      const processId =
        toProcessId(getPayloadValue(eventPayload, "process_id", "processId")) ??
        (() => {
          return callId ? (processIdByCallId.get(callId) ?? null) : null;
        })();
      if (!processId) {
        continue;
      }

      const run = ensureRun(processId, {
        timestampText: parsedLine.timestampText,
        timestampMs: parsedLine.timestampMs,
        sortKey: offset,
      });
      run.isRunning = true;

      const decoded = decodeBase64Chunk(getPayloadValue(eventPayload, "chunk"));
      if (decoded) {
        run.outputParts.push(decoded);
      }
      touchTerminalRun(
        run,
        parsedLine.timestampText,
        parsedLine.timestampMs,
        offset,
      );
      continue;
    }

    if (payloadType === "terminal_interaction") {
      const processId =
        toProcessId(getPayloadValue(eventPayload, "process_id", "processId")) ??
        (() => {
          return callId ? (processIdByCallId.get(callId) ?? null) : null;
        })();
      if (!processId) {
        continue;
      }

      const run = ensureRun(processId, {
        timestampText: parsedLine.timestampText,
        timestampMs: parsedLine.timestampMs,
        sortKey: offset,
      });
      run.isRunning = true;

      const stdin =
        typeof getPayloadValue(eventPayload, "stdin") === "string"
          ? (getPayloadValue(eventPayload, "stdin") as string)
          : "";
      if (stdin) {
        run.outputParts.push(formatStdinChunk(stdin));
      }
      touchTerminalRun(
        run,
        parsedLine.timestampText,
        parsedLine.timestampMs,
        offset,
      );
      continue;
    }

    if (payloadType === "exec_command_end") {
      const processId =
        toProcessId(getPayloadValue(eventPayload, "process_id", "processId")) ??
        (callId ? (processIdByCallId.get(callId) ?? null) : null);
      if (!processId) {
        continue;
      }

      if (!runsByProcessId.has(processId)) {
        continue;
      }

      runsByProcessId.delete(processId);
      if (callId) {
        processIdByCallId.delete(callId);
      }
      continue;
    }
  }

  return [...runsByProcessId.values()].sort((left, right) => {
    if (left.isRunning !== right.isRunning) {
      return left.isRunning ? -1 : 1;
    }
    return right.latestActivitySortKey - left.latestActivitySortKey;
  });
}

function computeContextLeftPercent(
  totalTokens: number,
  contextWindow: number,
): number {
  if (contextWindow <= CONTEXT_WINDOW_BASELINE_TOKENS) {
    return 0;
  }

  const effectiveWindow = contextWindow - CONTEXT_WINDOW_BASELINE_TOKENS;
  const used = Math.max(totalTokens - CONTEXT_WINDOW_BASELINE_TOKENS, 0);
  const remaining = Math.max(effectiveWindow - used, 0);
  const percent = Math.round((remaining / effectiveWindow) * 100);
  return Math.max(0, Math.min(100, percent));
}

async function readFirstLine(filePath: string): Promise<string | null> {
  let fileHandle;
  try {
    fileHandle = await open(filePath, "r");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, 0);
    if (bytesRead <= 0) {
      return null;
    }

    const chunk = buffer.subarray(0, bytesRead);
    const newlineIndex = chunk.indexOf(0x0a);
    return chunk
      .subarray(0, newlineIndex === -1 ? chunk.length : newlineIndex)
      .toString("utf-8");
  } catch {
    return null;
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }
}

function parseSessionMetaLine(line: string): SessionMeta | null {
  const parsed = safeJsonParse(line);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const record = parsed as { type?: string; payload?: Record<string, unknown> };
  if (record.type !== "session_meta" || !record.payload) {
    return null;
  }

  const id =
    typeof record.payload.id === "string" ? record.payload.id.trim() : "";
  if (!id) {
    return null;
  }

  return {
    id,
    cwd:
      typeof record.payload.cwd === "string" ? record.payload.cwd.trim() : "",
    timestamp: parseTimestamp(record.payload.timestamp),
  };
}

async function readSessionMetaFromFile(
  filePath: string,
): Promise<SessionMeta | null> {
  const firstLine = await readFirstLine(filePath);
  if (!firstLine) {
    return null;
  }
  return parseSessionMetaLine(firstLine);
}

async function hydrateSessionMeta(
  sessionId: string,
  filePath: string,
): Promise<void> {
  if (sessionMetaIndex.has(sessionId)) {
    return;
  }

  const meta = await readSessionMetaFromFile(filePath);
  if (meta) {
    sessionMetaIndex.set(sessionId, meta);
  }
}

async function collectSessionFiles(
  dirPath: string,
  output: string[],
): Promise<void> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await collectSessionFiles(fullPath, output);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        output.push(fullPath);
      }
    }
  } catch {
    // Session directory may not exist yet.
  }
}

async function buildFileIndex(): Promise<void> {
  fileIndex.clear();
  sessionMetaIndex.clear();
  sessionWaitStateCache.clear();

  const files: string[] = [];
  await collectSessionFiles(codexSessionsDir, files);

  for (const filePath of files) {
    const fileSessionId = extractSessionIdFromPath(filePath);

    let sessionId = fileSessionId;
    const meta = await readSessionMetaFromFile(filePath);
    if (meta) {
      sessionMetaIndex.set(meta.id, meta);
      sessionId = meta.id;
    }

    if (sessionId) {
      fileIndex.set(sessionId, filePath);
    }
  }
}

function collectTurnLifecycle(lines: Iterable<string>): {
  startedTurnIds: Set<string>;
  startedTurnOrder: string[];
  endedTurnIds: Set<string>;
} {
  const startedTurnIds = new Set<string>();
  const startedTurnOrder: string[] = [];
  const endedTurnIds = new Set<string>();
  let activeTurnId: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const parsed = safeJsonParse(trimmed);
    if (!parsed || typeof parsed !== "object") {
      continue;
    }

    const record = parsed as {
      type?: unknown;
      payload?: Record<string, unknown>;
    };
    if (record.type !== "event_msg" || !record.payload) {
      continue;
    }

    const eventType =
      typeof record.payload.type === "string" ? record.payload.type.trim() : "";
    const turnId =
      typeof record.payload.turn_id === "string"
        ? record.payload.turn_id.trim()
        : "";
    if (!turnId) {
      continue;
    }

    if (eventType === "task_started") {
      if (activeTurnId && activeTurnId !== turnId) {
        endedTurnIds.add(activeTurnId);
      }
      if (!startedTurnIds.has(turnId)) {
        startedTurnIds.add(turnId);
        startedTurnOrder.push(turnId);
      }
      activeTurnId = turnId;
      continue;
    }

    if (eventType === "task_complete" || eventType === "turn_aborted") {
      endedTurnIds.add(turnId);
      if (activeTurnId === turnId) {
        activeTurnId = null;
      }
    }
  }

  return { startedTurnIds, startedTurnOrder, endedTurnIds };
}

async function loadHistoryCache(): Promise<Map<string, SessionHistory>> {
  const cache = new Map<string, SessionHistory>();

  try {
    const content = await readFile(codexHistoryPath, "utf-8");
    const lines = content.split("\n");

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      const parsed = safeJsonParse(line);
      if (!parsed || typeof parsed !== "object") {
        continue;
      }

      const entry = parsed as {
        session_id?: unknown;
        ts?: unknown;
        text?: unknown;
      };

      if (typeof entry.session_id !== "string" || !entry.session_id.trim()) {
        continue;
      }

      const ts = parseTimestamp(entry.ts);
      if (!Number.isFinite(ts) || ts <= 0) {
        continue;
      }

      const current = cache.get(entry.session_id);
      if (current && current.timestamp > ts) {
        continue;
      }

      cache.set(entry.session_id, {
        timestamp: ts,
        text: typeof entry.text === "string" ? entry.text : "",
      });
    }
  } catch {
    // History file may not exist yet.
  }

  historyCache = cache;
  return cache;
}

async function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = pendingRequests.get(key);
  if (existing) {
    return existing as Promise<T>;
  }

  const promise = fn().finally(() => {
    pendingRequests.delete(key);
  });

  pendingRequests.set(key, promise);
  return promise;
}

async function findSessionFile(sessionId: string): Promise<string | null> {
  if (fileIndex.has(sessionId)) {
    return fileIndex.get(sessionId)!;
  }

  await buildFileIndex();
  if (fileIndex.has(sessionId)) {
    return fileIndex.get(sessionId)!;
  }

  return null;
}

async function sessionFileExists(filePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

async function findSessionFilesForDeletion(
  sessionId: string,
): Promise<string[]> {
  const candidates = new Set<string>();
  const indexedPath = fileIndex.get(sessionId);
  if (indexedPath) {
    candidates.add(indexedPath);
  }

  const files: string[] = [];
  await collectSessionFiles(codexSessionsDir, files);

  for (const filePath of files) {
    const fileSessionId = extractSessionIdFromPath(filePath);
    if (fileSessionId === sessionId) {
      candidates.add(filePath);
      continue;
    }

    if (fileSessionId) {
      continue;
    }

    const meta = await readSessionMetaFromFile(filePath);
    if (meta?.id === sessionId) {
      candidates.add(filePath);
    }
  }

  return [...candidates];
}

async function pruneJsonlFileBySessionId(
  filePath: string,
  keys: string[],
  sessionId: string,
): Promise<number> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return 0;
  }

  const lines = content.split("\n");
  const keptLines: string[] = [];
  let removed = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const parsed = safeJsonParse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      keptLines.push(trimmed);
      continue;
    }

    const record = parsed as Record<string, unknown>;
    const lineSessionId = getJsonRecordValue(record, keys);
    if (lineSessionId === sessionId) {
      removed += 1;
      continue;
    }

    keptLines.push(trimmed);
  }

  if (removed <= 0) {
    return 0;
  }

  const nextContent = keptLines.length > 0 ? `${keptLines.join("\n")}\n` : "";
  await writeFile(filePath, nextContent, "utf-8");
  return removed;
}

async function resolveConfiguredSqliteHome(
  codexHome: string,
): Promise<string | null> {
  const configPath = join(codexHome, "config.toml");
  let content: string;
  try {
    content = await readFile(configPath, "utf-8");
  } catch {
    return null;
  }

  const configuredValue = parseTopLevelTomlStringSettings(content, [
    "sqlite_home",
  ]).sqlite_home;

  if (!configuredValue) {
    return null;
  }

  return resolvePathWithHome(configuredValue, codexHome);
}

export async function getCodexConfigDefaults(): Promise<CodexConfigDefaultsResponse> {
  const configPath = join(codexDir, "config.toml");
  let content: string;
  try {
    content = await readFile(configPath, "utf-8");
  } catch {
    return {
      model: null,
      reasoningEffort: null,
      planModeReasoningEffort: null,
    };
  }

  const settings = parseTopLevelTomlStringSettings(content, [
    "model",
    "model_reasoning_effort",
    "plan_mode_reasoning_effort",
  ]);
  const model = settings.model?.trim() || null;

  return {
    model,
    reasoningEffort: toConfiguredReasoningEffort(
      settings.model_reasoning_effort,
    ),
    planModeReasoningEffort: toConfiguredReasoningEffort(
      settings.plan_mode_reasoning_effort,
    ),
  };
}

async function resolveSqliteHome(codexHome: string): Promise<string> {
  const envValue = process.env.CODEX_SQLITE_HOME;
  if (typeof envValue === "string" && envValue.trim()) {
    return resolvePathWithHome(envValue, codexHome);
  }

  const configured = await resolveConfiguredSqliteHome(codexHome);
  if (configured) {
    return configured;
  }

  return codexHome;
}

async function findVersionedDbPath(
  sqliteHome: string,
  fileRegex: RegExp,
  legacyFilename: string,
): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(sqliteHome, { withFileTypes: true });
  } catch {
    return null;
  }

  let bestMatch: { version: number; path: string } | null = null;
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const match = entry.name.match(fileRegex);
    if (!match) {
      continue;
    }

    const version = Number.parseInt(match[1], 10);
    if (!Number.isFinite(version)) {
      continue;
    }

    const absolutePath = join(sqliteHome, entry.name);
    if (!bestMatch || version > bestMatch.version) {
      bestMatch = {
        version,
        path: absolutePath,
      };
    }
  }

  if (bestMatch) {
    return bestMatch.path;
  }

  const legacyPath = join(sqliteHome, legacyFilename);
  return (await sessionFileExists(legacyPath)) ? legacyPath : null;
}

function runSqliteCommand(dbPath: string, sql: string): string {
  const result = spawnSync(
    "sqlite3",
    [
      "-batch",
      "-noheader",
      "-cmd",
      `PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS};`,
      dbPath,
      sql,
    ],
    {
      encoding: "utf-8",
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    throw new Error(
      stderr || stdout || `sqlite3 exited with code ${result.status ?? -1}`,
    );
  }

  return result.stdout?.trim() ?? "";
}

function parseChangesResult(output: string): number {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return 0;
  }

  const lastLine = lines[lines.length - 1];
  const value = Number.parseInt(lastLine, 10);
  return Number.isFinite(value) ? value : 0;
}

async function deleteSessionFromSqliteDbs(
  sessionId: string,
): Promise<DeleteSessionSqliteResult> {
  const sqliteHome = await resolveSqliteHome(codexDir);
  const stateDbPath = await findVersionedDbPath(
    sqliteHome,
    STATE_DB_FILE_REGEX,
    LEGACY_STATE_DB_FILE,
  );
  const logsDbPath = await findVersionedDbPath(
    sqliteHome,
    LOGS_DB_FILE_REGEX,
    LEGACY_LOGS_DB_FILE,
  );

  if (!stateDbPath && !logsDbPath) {
    return {
      dbPath: null,
      logsDbPath: null,
      threadsDeleted: 0,
      logsDeleted: 0,
      skippedReason: "state/logs db not found",
      warnings: [],
    };
  }

  const sqliteVersion = spawnSync("sqlite3", ["-version"], {
    encoding: "utf-8",
  });
  if (sqliteVersion.error || sqliteVersion.status !== 0) {
    const message = sqliteVersion.error
      ? sqliteVersion.error.message
      : (sqliteVersion.stderr?.trim() ?? "sqlite3 command failed");
    return {
      dbPath: stateDbPath,
      logsDbPath,
      threadsDeleted: 0,
      logsDeleted: 0,
      skippedReason: "sqlite3 is unavailable",
      warnings: [message],
    };
  }

  const escapedSessionId = sessionId.replaceAll("'", "''");
  let threadsDeleted = 0;
  let logsDeleted = 0;
  const warnings: string[] = [];

  if (logsDbPath) {
    try {
      const logsOutput = runSqliteCommand(
        logsDbPath,
        `DELETE FROM logs WHERE thread_id='${escapedSessionId}'; SELECT changes();`,
      );
      logsDeleted = parseChangesResult(logsOutput);
    } catch (error) {
      warnings.push(
        `failed to delete logs rows from ${logsDbPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (stateDbPath) {
    try {
      const threadsOutput = runSqliteCommand(
        stateDbPath,
        `DELETE FROM threads WHERE id='${escapedSessionId}'; SELECT changes();`,
      );
      threadsDeleted = parseChangesResult(threadsOutput);
    } catch (error) {
      warnings.push(
        `failed to delete thread row from ${stateDbPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return {
    dbPath: stateDbPath,
    logsDbPath,
    threadsDeleted,
    logsDeleted,
    skippedReason: null,
    warnings,
  };
}

function truncateToolResult(content: string): string {
  if (content.length <= TOOL_RESULT_MAX_LENGTH) {
    return content;
  }

  const omitted = content.length - TOOL_RESULT_MAX_LENGTH;
  return `${content.slice(0, TOOL_RESULT_MAX_LENGTH)}\n... [truncated ${omitted} chars]`;
}

function toToolInput(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    const parsed = safeJsonParse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { raw: value };
  }
  if (value === undefined) {
    return {};
  }
  return { value };
}

function toToolOutputValue(value: unknown): unknown {
  if (typeof value === "string") {
    return truncateToolResult(value);
  }
  if (value === undefined || value === null) {
    return "";
  }

  return value;
}

function createChatMessage(
  role: "user" | "assistant",
  content: ContentBlock[],
  uuid: string,
  timestamp?: string,
): ConversationMessage {
  return {
    type: role,
    uuid,
    timestamp,
    message: {
      role,
      content,
    },
  };
}

function createReasoningMessage(
  type: "reasoning" | "agent_reasoning",
  text: string,
  uuid: string,
  timestamp?: string,
): ConversationMessage {
  return {
    type,
    uuid,
    timestamp,
    message: {
      role: "assistant",
      content: [
        {
          type,
          text,
        },
      ],
    },
  };
}

function createTurnAbortedMessage(
  text: string,
  uuid: string,
  timestamp?: string,
  turnId?: string,
): ConversationMessage {
  return {
    type: "turn_aborted",
    uuid,
    turnId,
    timestamp,
    message: {
      role: "assistant",
      content: text,
    },
  };
}

function createSystemErrorMessage(
  title: string,
  text: string,
  uuid: string,
  timestamp?: string,
): ConversationMessage {
  return {
    type: "system_error",
    uuid,
    timestamp,
    summary: title,
    message: {
      role: "assistant",
      content: text,
    },
  };
}

function createTokenLimitNoticeMessage(
  uuid: string,
  timestamp?: string,
  rateLimitId?: string | null,
  repeatCount: number = 1,
): ConversationMessage {
  return {
    type: "token_limit_notice",
    uuid,
    timestamp,
    summary: TOKEN_LIMIT_NOTICE_TITLE,
    repeatCount,
    repeatCountMax: TOKEN_LIMIT_NOTICE_REPEAT_MAX,
    rateLimitId: rateLimitId ?? null,
    message: {
      role: "assistant",
      content: TOKEN_LIMIT_NOTICE_TEXT,
    },
  };
}

function createToolMessage(
  toolUse: PendingToolUse,
  uuid: string,
  result?: { content: unknown; isError?: boolean; timestamp?: string },
): ConversationMessage {
  const content: ContentBlock[] = [
    {
      type: "tool_use",
      id: toolUse.callId,
      name: toolUse.name,
      input: toolUse.input,
      timestamp: toolUse.timestamp,
    },
  ];

  if (result) {
    content.push({
      type: "tool_result",
      tool_use_id: toolUse.callId,
      name: toolUse.name,
      content: result.content,
      is_error: result.isError,
      timestamp: result.timestamp,
    });
  }

  return {
    type: "assistant",
    uuid,
    timestamp: toolUse.timestamp ?? result?.timestamp,
    message: {
      role: "assistant",
      content,
    },
  };
}

function createToolResultOnlyMessage(
  callId: string,
  content: unknown,
  uuid: string,
  timestamp?: string,
  isError?: boolean,
  name?: string,
): ConversationMessage {
  return {
    type: "assistant",
    uuid,
    timestamp,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_result",
          tool_use_id: callId,
          name,
          content,
          is_error: isError,
          timestamp,
        },
      ],
    },
  };
}

function extractContentBlocksFromPayloadContent(
  content: unknown,
): ContentBlock[] {
  if (typeof content === "string") {
    return content.trim()
      ? [
          {
            type: "text",
            text: content,
          },
        ]
      : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: ContentBlock[] = [];
  const IMAGE_TAG_ONLY_TEXT_REGEX = /^<\/?image\b[^>]*>$/i;

  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const block = item as {
      type?: unknown;
      text?: unknown;
      image_url?: unknown;
      imageUrl?: unknown;
    };

    if (
      (block.type === "input_text" || block.type === "output_text") &&
      typeof block.text === "string" &&
      block.text.trim().length > 0
    ) {
      if (IMAGE_TAG_ONLY_TEXT_REGEX.test(block.text.trim())) {
        continue;
      }
      blocks.push({
        type: "text",
        text: block.text,
      });
      continue;
    }

    if (block.type === "input_image") {
      const imageUrl =
        typeof block.image_url === "string"
          ? block.image_url
          : typeof block.imageUrl === "string"
            ? block.imageUrl
            : "";
      if (imageUrl.trim().length > 0) {
        blocks.push({
          type: "image",
          image_url: imageUrl,
        });
      }
    }
  }

  return blocks;
}

function extractTextFromPayloadContent(content: unknown): string {
  return extractContentBlocksFromPayloadContent(content)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n\n")
    .trim();
}

function extractTextFromReasoningParts(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractTextFromReasoningParts(item))
      .filter(Boolean);
    return parts.join("\n\n").trim();
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as {
    text?: unknown;
    summary?: unknown;
    content?: unknown;
  };

  if (typeof record.text === "string") {
    return record.text.trim();
  }

  if (record.summary !== undefined) {
    const summaryText = extractTextFromReasoningParts(record.summary);
    if (summaryText) {
      return summaryText;
    }
  }

  if (record.content !== undefined) {
    return extractTextFromReasoningParts(record.content);
  }

  return "";
}

function extractReasoningText(payload: Record<string, unknown>): string {
  const summaryText = extractTextFromReasoningParts(payload.summary);
  if (summaryText) {
    return summaryText;
  }

  return extractTextFromReasoningParts(payload.content);
}

function normalizeReasoningText(text: string): string {
  const trimmed = text.trim();
  const unwrapped = trimmed.replace(/^\*\*(.*?)\*\*$/s, "$1");
  return unwrapped.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeComparableText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function isDefaultTurnAbortedText(text: string): boolean {
  const normalized = normalizeComparableText(text);
  return TURN_ABORTED_DEFAULT_TEXT_VARIANTS.some(
    (variant) => normalizeComparableText(variant) === normalized,
  );
}

function extractTurnAbortedText(text: string): string | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = normalized.match(TURN_ABORTED_TAG_REGEX);
  if (!match) {
    return null;
  }

  const content = match[1].trim();
  return content || TURN_ABORTED_DEFAULT_TEXT;
}

function getReasoningTextFromMessage(
  message: ConversationMessage,
): string | null {
  if (message.type !== "reasoning" && message.type !== "agent_reasoning") {
    return null;
  }

  const content = message.message?.content;
  if (!Array.isArray(content)) {
    return null;
  }

  const block = content.find(
    (item) => item.type === "reasoning" || item.type === "agent_reasoning",
  );

  return typeof block?.text === "string" ? block.text : null;
}

function getTurnAbortedTextFromMessage(
  message: ConversationMessage,
): string | null {
  if (message.type !== "turn_aborted") {
    return null;
  }

  const content = message.message?.content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed || null;
  }

  if (Array.isArray(content)) {
    const textBlock = content.find(
      (item) => item.type === "text" && typeof item.text === "string",
    );
    const text =
      typeof textBlock?.text === "string" ? textBlock.text.trim() : "";
    return text || null;
  }

  return null;
}

function getSystemErrorComparableText(
  message: ConversationMessage,
): string | null {
  if (message.type !== "system_error") {
    return null;
  }

  const title =
    typeof message.summary === "string" ? message.summary.trim() : "";
  const content = message.message?.content;
  const text =
    typeof content === "string"
      ? content.trim()
      : Array.isArray(content)
        ? content
            .filter(
              (item) => item.type === "text" && typeof item.text === "string",
            )
            .map((item) => item.text?.trim() ?? "")
            .filter(Boolean)
            .join("\n")
        : "";
  const combined = [title, text].filter(Boolean).join("\n").trim();
  return combined || null;
}

function getTokenLimitNoticeComparableKey(
  message: ConversationMessage,
): string | null {
  if (message.type !== "token_limit_notice") {
    return null;
  }

  const rateLimitId =
    typeof message.rateLimitId === "string" ? message.rateLimitId.trim() : "";
  return rateLimitId || "token-limit-notice";
}

function getMostRecentVisibleMessageIndex(
  messages: ConversationMessage[],
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (
      candidate.type === "task_started" ||
      candidate.type === "task_complete"
    ) {
      continue;
    }
    return index;
  }

  return -1;
}

function pushConversationMessage(
  messages: ConversationMessage[],
  message: ConversationMessage,
): void {
  if (message.type === "reasoning" || message.type === "agent_reasoning") {
    const text = getReasoningTextFromMessage(message);
    const lastMessage = messages[messages.length - 1];
    const lastText = lastMessage
      ? getReasoningTextFromMessage(lastMessage)
      : null;

    if (
      text &&
      lastText &&
      normalizeReasoningText(text) === normalizeReasoningText(lastText)
    ) {
      return;
    }
  }

  if (message.type === "turn_aborted") {
    const text = getTurnAbortedTextFromMessage(message);
    const lastVisibleMessageIndex = getMostRecentVisibleMessageIndex(messages);
    const lastMessage =
      lastVisibleMessageIndex >= 0
        ? messages[lastVisibleMessageIndex]
        : undefined;
    const lastText = lastMessage
      ? getTurnAbortedTextFromMessage(lastMessage)
      : null;

    if (lastMessage?.type === "turn_aborted") {
      if (!text || !lastText) {
        return;
      }

      if (normalizeComparableText(text) === normalizeComparableText(lastText)) {
        return;
      }

      if (isDefaultTurnAbortedText(text)) {
        return;
      }

      if (isDefaultTurnAbortedText(lastText)) {
        messages[lastVisibleMessageIndex] = message;
        return;
      }

      return;
    }
  }

  if (message.type === "system_error") {
    const text = getSystemErrorComparableText(message);
    const lastMessage = messages[messages.length - 1];
    const lastText = lastMessage
      ? getSystemErrorComparableText(lastMessage)
      : null;

    if (
      text &&
      lastText &&
      normalizeComparableText(text) === normalizeComparableText(lastText)
    ) {
      return;
    }
  }

  if (message.type === "token_limit_notice") {
    const lastMessage = messages[messages.length - 1];
    const lastKey = lastMessage
      ? getTokenLimitNoticeComparableKey(lastMessage)
      : null;
    const nextKey = getTokenLimitNoticeComparableKey(message);

    if (
      lastMessage?.type === "token_limit_notice" &&
      nextKey &&
      lastKey === nextKey
    ) {
      messages[messages.length - 1] = {
        ...lastMessage,
        ...message,
        uuid: message.uuid ?? lastMessage.uuid,
        timestamp: message.timestamp ?? lastMessage.timestamp,
        repeatCount:
          (lastMessage.repeatCount ?? 1) + (message.repeatCount ?? 1),
        repeatCountMax: message.repeatCountMax ?? lastMessage.repeatCountMax,
        rateLimitId: message.rateLimitId ?? lastMessage.rateLimitId ?? null,
      };
      return;
    }
  }

  messages.push(message);
}

function parseToolUseFromPayload(
  payload: Record<string, unknown>,
  timestamp: string | undefined,
  offset: number,
): PendingToolUse {
  const payloadType = typeof payload.type === "string" ? payload.type : "";

  let input: Record<string, unknown> = {};
  if (payloadType === "function_call") {
    input = toToolInput(payload.arguments);
  } else if (payloadType === "custom_tool_call") {
    input = toToolInput(payload.input);
  } else if (payloadType === "web_search_call") {
    input = toToolInput(payload.action);
  }

  const name =
    payloadType === "web_search_call"
      ? "web_search"
      : typeof payload.name === "string"
        ? payload.name
        : "unknown_tool";

  const callId =
    typeof payload.call_id === "string" && payload.call_id
      ? payload.call_id
      : `${name}-${offset}`;

  return {
    callId,
    name,
    input,
    timestamp,
    lineOffset: offset,
  };
}

function parseToolResultFromPayload(payload: Record<string, unknown>): {
  callId: string;
  content: unknown;
  isError?: boolean;
} {
  const callId =
    typeof payload.call_id === "string" && payload.call_id
      ? payload.call_id
      : `unknown-call-${Date.now()}`;

  const isError =
    typeof payload.is_error === "boolean"
      ? payload.is_error
      : typeof payload.error === "boolean"
        ? payload.error
        : undefined;

  return {
    callId,
    content: toToolOutputValue(payload.output),
    isError,
  };
}

function parseCodexConversation(
  lines: LineWithOffset[],
  knownToolNames?: Map<string, string>,
): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  const pendingToolCalls = new Map<string, PendingToolUse>();
  const pendingToolMessageIndexes = new Map<string, number>();
  const toolNames = knownToolNames ?? new Map<string, string>();

  for (const { line, offset } of lines) {
    const parsed = safeJsonParse(line);
    if (!parsed || typeof parsed !== "object") {
      continue;
    }

    const record = parsed as {
      type?: unknown;
      timestamp?: unknown;
      payload?: unknown;
    };
    const timestamp =
      typeof record.timestamp === "string" ? record.timestamp : undefined;

    if (!record.payload || typeof record.payload !== "object") {
      continue;
    }

    const payload = record.payload as Record<string, unknown>;
    const payloadType = typeof payload.type === "string" ? payload.type : "";

    if (record.type === "event_msg") {
      if (payloadType === "turn_aborted") {
        const reason =
          typeof payload.reason === "string" ? payload.reason.trim() : "";
        const turnId =
          typeof payload.turn_id === "string" ? payload.turn_id.trim() : "";
        const text =
          reason === "interrupted" || !reason
            ? TURN_ABORTED_DEFAULT_TEXT
            : `Turn aborted (${reason}). ${TURN_ABORTED_DEFAULT_TEXT}`;

        pushConversationMessage(
          messages,
          createTurnAbortedMessage(
            text,
            `${offset}:turn-aborted-event:${messages.length}`,
            timestamp,
            turnId || undefined,
          ),
        );
        continue;
      }

      if (payloadType === "error") {
        const text =
          typeof payload.message === "string" ? payload.message.trim() : "";
        if (!text) {
          continue;
        }

        pushConversationMessage(
          messages,
          createSystemErrorMessage(
            "Error",
            text,
            `${offset}:system-error:${messages.length}`,
            timestamp,
          ),
        );
        continue;
      }

      if (
        payloadType === "token_count" &&
        payload.info == null &&
        payload.rate_limits &&
        typeof payload.rate_limits === "object"
      ) {
        const rateLimitId =
          typeof (payload.rate_limits as Record<string, unknown>).limit_id ===
          "string"
            ? (
                (payload.rate_limits as Record<string, unknown>)
                  .limit_id as string
              ).trim()
            : null;

        pushConversationMessage(
          messages,
          createTokenLimitNoticeMessage(
            `${offset}:token-limit-notice:${messages.length}`,
            timestamp,
            rateLimitId,
          ),
        );
        continue;
      }

      if (
        payloadType === "context_compacted" ||
        payloadType === "contextCompacted"
      ) {
        pushConversationMessage(
          messages,
          createChatMessage(
            "assistant",
            [
              {
                type: "text",
                text: "Context compacted",
              },
            ],
            `${offset}:context-compacted:${messages.length}`,
            timestamp,
          ),
        );
        continue;
      }

      if (payloadType === "task_started") {
        const turnId =
          typeof payload.turn_id === "string" ? payload.turn_id.trim() : "";
        pushConversationMessage(messages, {
          type: "task_started",
          uuid: `${offset}:task-started:${messages.length}`,
          turnId: turnId || undefined,
          timestamp,
        });
        continue;
      }

      if (payloadType === "task_complete") {
        const turnId =
          typeof payload.turn_id === "string" ? payload.turn_id.trim() : "";
        pushConversationMessage(messages, {
          type: "task_complete",
          uuid: `${offset}:task-complete:${messages.length}`,
          turnId: turnId || undefined,
          timestamp,
        });
        continue;
      }

      if (payloadType !== "agent_reasoning") {
        continue;
      }

      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text) {
        continue;
      }

      pushConversationMessage(
        messages,
        createReasoningMessage(
          "agent_reasoning",
          text,
          `${offset}:agent-reasoning:${messages.length}`,
          timestamp,
        ),
      );
      continue;
    }

    if (record.type !== "response_item") {
      continue;
    }

    if (payloadType === "message") {
      const role = payload.role;
      if (role !== "user" && role !== "assistant") {
        continue;
      }

      const content = extractContentBlocksFromPayloadContent(payload.content);
      if (content.length === 0) {
        continue;
      }

      const text = content
        .filter(
          (block) => block.type === "text" && typeof block.text === "string",
        )
        .map((block) => block.text ?? "")
        .join("\n\n")
        .trim();
      const turnAbortedText =
        role === "user" ? extractTurnAbortedText(text) : null;
      if (turnAbortedText) {
        pushConversationMessage(
          messages,
          createTurnAbortedMessage(
            turnAbortedText,
            `${offset}:turn-aborted-message:${messages.length}`,
            timestamp,
          ),
        );
        continue;
      }

      pushConversationMessage(
        messages,
        createChatMessage(
          role,
          content,
          `${offset}:message:${messages.length}`,
          timestamp,
        ),
      );
      continue;
    }

    if (payloadType === "reasoning") {
      let text = extractReasoningText(payload);
      if (!text) {
        const hasEncryptedContent =
          typeof payload.encrypted_content === "string" &&
          payload.encrypted_content.trim().length > 0;
        if (!hasEncryptedContent) {
          continue;
        }
        text = "Encrypted reasoning captured in the session log";
      }

      pushConversationMessage(
        messages,
        createReasoningMessage(
          "reasoning",
          text,
          `${offset}:reasoning:${messages.length}`,
          timestamp,
        ),
      );
      continue;
    }

    if (
      payloadType === "function_call" ||
      payloadType === "custom_tool_call" ||
      payloadType === "web_search_call"
    ) {
      const toolUse = parseToolUseFromPayload(payload, timestamp, offset);
      pendingToolCalls.set(toolUse.callId, toolUse);
      toolNames.set(toolUse.callId, toolUse.name);
      pushConversationMessage(
        messages,
        createToolMessage(toolUse, `${offset}:tool:${messages.length}`),
      );
      pendingToolMessageIndexes.set(toolUse.callId, messages.length - 1);

      // Web search may not emit a separate output item, so include status if available.
      if (payloadType === "web_search_call" && payload.status !== undefined) {
        const messageIndex = pendingToolMessageIndexes.get(toolUse.callId);
        const messageUuid =
          typeof messageIndex === "number" &&
          messageIndex >= 0 &&
          messageIndex < messages.length
            ? (messages[messageIndex]?.uuid ??
              `${offset}:tool:${messages.length}`)
            : `${offset}:tool:${messages.length}`;
        const completedMessage = createToolMessage(toolUse, messageUuid, {
          content: toToolOutputValue(payload.status),
        });
        if (
          typeof messageIndex === "number" &&
          messageIndex >= 0 &&
          messageIndex < messages.length
        ) {
          messages[messageIndex] = completedMessage;
        } else {
          pushConversationMessage(messages, completedMessage);
        }
        pendingToolCalls.delete(toolUse.callId);
        pendingToolMessageIndexes.delete(toolUse.callId);
      }
      continue;
    }

    if (
      payloadType === "function_call_output" ||
      payloadType === "custom_tool_call_output"
    ) {
      const result = parseToolResultFromPayload(payload);
      const pairedToolUse = pendingToolCalls.get(result.callId);
      const toolName = pairedToolUse?.name ?? toolNames.get(result.callId);

      if (pairedToolUse) {
        const messageIndex = pendingToolMessageIndexes.get(result.callId);
        const messageUuid =
          typeof messageIndex === "number" &&
          messageIndex >= 0 &&
          messageIndex < messages.length
            ? (messages[messageIndex]?.uuid ??
              `${offset}:tool-pair:${messages.length}`)
            : `${offset}:tool-pair:${messages.length}`;
        const completedMessage = createToolMessage(pairedToolUse, messageUuid, {
          content: result.content,
          isError: result.isError,
          timestamp,
        });
        if (
          typeof messageIndex === "number" &&
          messageIndex >= 0 &&
          messageIndex < messages.length
        ) {
          messages[messageIndex] = completedMessage;
        } else {
          pushConversationMessage(messages, completedMessage);
        }
        pendingToolCalls.delete(result.callId);
        pendingToolMessageIndexes.delete(result.callId);
      } else {
        pushConversationMessage(
          messages,
          createToolResultOnlyMessage(
            result.callId,
            result.content,
            `${offset}:tool-result:${messages.length}`,
            timestamp,
            result.isError,
            toolName,
          ),
        );
      }
      continue;
    }
  }

  return messages;
}

async function getFirstUserMessageSnippet(filePath: string): Promise<string> {
  let fileHandle;
  try {
    fileHandle = await open(filePath, "r");
    const stream = fileHandle.createReadStream({ encoding: "utf-8" });

    let firstMessageRole: "user" | "assistant" | null = null;
    let firstUserText: string | null = null;
    let pendingText = "";

    const handleLine = (line: string): string | null => {
      if (!line.trim()) {
        return null;
      }

      const parsed = safeJsonParse(line);
      if (!parsed || typeof parsed !== "object") {
        return null;
      }

      const record = parsed as {
        type?: unknown;
        payload?: unknown;
      };

      if (
        record.type !== "response_item" ||
        !record.payload ||
        typeof record.payload !== "object"
      ) {
        return null;
      }

      const payload = record.payload as Record<string, unknown>;
      if (payload.type !== "message") {
        return null;
      }

      const role = payload.role;
      if (role !== "user" && role !== "assistant") {
        return null;
      }

      const text = extractTextFromPayloadContent(payload.content);
      if (!text) {
        return null;
      }

      if (role === "user" && extractTurnAbortedText(text)) {
        return null;
      }

      if (!firstMessageRole) {
        firstMessageRole = role;
        if (role === "user") {
          firstUserText = text;
        }
        return null;
      }

      if (firstMessageRole === "user" && firstUserText) {
        if (role === "user") {
          return normalizeDisplayText(text);
        }
        return normalizeDisplayText(firstUserText);
      }

      if (role === "user" && !firstUserText) {
        firstUserText = text;
      }
      return null;
    };

    for await (const chunk of stream) {
      pendingText += chunk;

      while (true) {
        const newlineIndex = pendingText.indexOf("\n");
        if (newlineIndex === -1) {
          break;
        }

        const line = pendingText.slice(0, newlineIndex);
        pendingText = pendingText.slice(newlineIndex + 1);
        const result = handleLine(line);
        if (result) {
          return result;
        }
      }
    }

    if (pendingText) {
      const result = handleLine(pendingText);
      if (result) {
        return result;
      }
    }

    if (firstUserText) {
      return normalizeDisplayText(firstUserText);
    }
  } catch {
    // Ignore read errors and fallback to default display value below.
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }

  return "(no prompt text)";
}

export async function loadStorage(): Promise<void> {
  await Promise.all([buildFileIndex(), loadHistoryCache()]);
}

export async function getSessions(): Promise<Session[]> {
  return dedupe("getSessions", async () => {
    const history = historyCache ?? (await loadHistoryCache());

    const sessionIds = new Set<string>([
      ...fileIndex.keys(),
      ...history.keys(),
      ...sessionMetaIndex.keys(),
    ]);

    const sessions: Session[] = [];

    for (const sessionId of sessionIds) {
      let filePath = fileIndex.get(sessionId);
      if (!filePath) {
        filePath = await findSessionFile(sessionId);
      }

      let meta = sessionMetaIndex.get(sessionId);
      if (!meta && filePath) {
        meta = await readSessionMetaFromFile(filePath);
        if (meta) {
          sessionMetaIndex.set(sessionId, meta);
        }
      }

      const historyEntry = history.get(sessionId);

      let timestamp = 0;
      if (historyEntry) {
        timestamp = historyEntry.timestamp * 1000;
      } else if (meta?.timestamp) {
        timestamp = meta.timestamp;
      } else if (filePath) {
        try {
          const fileStat = await stat(filePath);
          timestamp = fileStat.mtimeMs;
        } catch {
          timestamp = 0;
        }
      }

      let display = "";
      const cachedDisplay = sessionDisplayCache.get(sessionId);
      if (cachedDisplay) {
        display = cachedDisplay;
      } else if (filePath) {
        display = await getFirstUserMessageSnippet(filePath);
        sessionDisplayCache.set(sessionId, display);
      } else if (historyEntry) {
        display = normalizeDisplayText(historyEntry.text);
      } else {
        display = "(no prompt text)";
      }

      const project = meta?.cwd ?? "";

      sessions.push({
        id: sessionId,
        display,
        timestamp,
        project,
        projectName: getProjectName(project),
      });
    }

    return sessions.sort((a, b) => b.timestamp - a.timestamp);
  });
}

export async function getProjects(): Promise<string[]> {
  const sessions = await getSessions();
  const projects = new Set<string>();

  for (const session of sessions) {
    if (session.project) {
      projects.add(session.project);
    }
  }

  return [...projects].sort();
}

export async function sessionExists(
  sessionId: string,
): Promise<SessionExistsResponse> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    throw new Error("session id is required");
  }

  let filePath = await findSessionFile(normalizedSessionId);
  if (!filePath) {
    return {
      sessionId: normalizedSessionId,
      exists: false,
    };
  }

  if (await sessionFileExists(filePath)) {
    return {
      sessionId: normalizedSessionId,
      exists: true,
    };
  }

  clearSessionCaches(normalizedSessionId);
  await buildFileIndex();
  filePath = fileIndex.get(normalizedSessionId) ?? null;

  return {
    sessionId: normalizedSessionId,
    exists: !!filePath && (await sessionFileExists(filePath)),
  };
}

export async function deleteSession(
  sessionId: string,
): Promise<DeleteSessionResponse> {
  return dedupe(`deleteSession:${sessionId}`, async () => {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      throw new Error("session id is required");
    }

    const filePaths = await findSessionFilesForDeletion(normalizedSessionId);
    const removedSessionFilePaths: string[] = [];

    for (const filePath of filePaths) {
      if (!(await sessionFileExists(filePath))) {
        continue;
      }

      await rm(filePath, { force: true });
      removedSessionFilePaths.push(filePath);
    }

    const removedHistoryEntries = await pruneJsonlFileBySessionId(
      codexHistoryPath,
      HISTORY_SESSION_ID_KEYS,
      normalizedSessionId,
    );
    const removedSessionIndexEntries = await pruneJsonlFileBySessionId(
      join(codexDir, SESSION_INDEX_FILENAME),
      SESSION_INDEX_ID_KEYS,
      normalizedSessionId,
    );
    const sqlite = await deleteSessionFromSqliteDbs(normalizedSessionId);

    clearSessionCaches(normalizedSessionId);

    const foundAny =
      removedSessionFilePaths.length > 0 ||
      removedHistoryEntries > 0 ||
      removedSessionIndexEntries > 0 ||
      sqlite.threadsDeleted > 0 ||
      sqlite.logsDeleted > 0;
    if (!foundAny) {
      throw new Error(`session not found: ${normalizedSessionId}`);
    }

    return {
      sessionId: normalizedSessionId,
      removedSessionFilePaths,
      removedHistoryEntries,
      removedSessionIndexEntries,
      sqlite,
    };
  });
}

export async function getConversation(
  sessionId: string,
): Promise<ConversationMessage[]> {
  return dedupe(`getConversation:${sessionId}`, async () => {
    const filePath = await findSessionFile(sessionId);

    if (!filePath) {
      return [];
    }

    try {
      const content = await readFile(filePath, "utf-8");
      const result = parseConversationTextChunk(content, 0);
      sessionToolNameIndex.set(sessionId, result.toolNames);
      return result.messages;
    } catch (err) {
      console.error("Error reading conversation:", err);
      return [];
    }
  });
}

export async function getConversationRawChunk(
  sessionId: string,
  fromOffset: number = 0,
  maxBytes: number = 512 * 1024,
): Promise<ConversationRawChunkResponse> {
  const filePath = await findSessionFile(sessionId);

  if (!filePath) {
    return {
      chunkBase64: "",
      nextOffset: 0,
      done: true,
    };
  }

  let fileHandle;
  try {
    const fileStat = await stat(filePath);
    const fileSize = fileStat.size;
    const normalizedMaxBytes =
      Number.isFinite(maxBytes) && maxBytes > 0
        ? Math.floor(maxBytes)
        : 512 * 1024;

    if (fromOffset >= fileSize) {
      return {
        chunkBase64: "",
        nextOffset: fromOffset,
        done: true,
      };
    }

    const byteCount = Math.min(normalizedMaxBytes, fileSize - fromOffset);
    const buffer = Buffer.allocUnsafe(byteCount);

    fileHandle = await open(filePath, "r");
    const { bytesRead } = await fileHandle.read(
      buffer,
      0,
      byteCount,
      fromOffset,
    );
    const nextOffset = fromOffset + bytesRead;

    return {
      chunkBase64: buffer.subarray(0, bytesRead).toString("base64"),
      nextOffset,
      done: nextOffset >= fileSize,
    };
  } catch (err) {
    console.error("Error reading conversation raw chunk:", err);
    return {
      chunkBase64: "",
      nextOffset: fromOffset,
      done: false,
    };
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }
}

export async function getConversationRawWindow(
  sessionId: string,
  beforeOffset?: number,
  maxBytes: number = 512 * 1024,
): Promise<ConversationRawWindowResponse> {
  const filePath = await findSessionFile(sessionId);

  if (!filePath) {
    return {
      chunkBase64: "",
      startOffset: 0,
      endOffset: 0,
      fileSize: 0,
      done: true,
    };
  }

  let fileHandle;
  try {
    const fileStat = await stat(filePath);
    const fileSize = fileStat.size;
    const normalizedMaxBytes =
      Number.isFinite(maxBytes) && maxBytes > 0
        ? Math.floor(maxBytes)
        : 512 * 1024;
    const normalizedBefore =
      Number.isFinite(beforeOffset) && Number(beforeOffset) > 0
        ? Math.min(fileSize, Math.floor(Number(beforeOffset)))
        : fileSize;

    if (normalizedBefore <= 0 || fileSize <= 0) {
      return {
        chunkBase64: "",
        startOffset: 0,
        endOffset: 0,
        fileSize,
        done: true,
      };
    }

    const start = Math.max(0, normalizedBefore - normalizedMaxBytes);
    const byteCount = normalizedBefore - start;
    if (byteCount <= 0) {
      return {
        chunkBase64: "",
        startOffset: normalizedBefore,
        endOffset: normalizedBefore,
        fileSize,
        done: normalizedBefore <= 0,
      };
    }

    const buffer = Buffer.allocUnsafe(byteCount);
    fileHandle = await open(filePath, "r");
    const { bytesRead } = await fileHandle.read(buffer, 0, byteCount, start);
    let sliceStart = 0;
    let sliceEnd = bytesRead;

    if (start > 0) {
      const firstNewline = buffer.indexOf(0x0a, 0);
      if (firstNewline >= 0 && firstNewline + 1 < sliceEnd) {
        sliceStart = firstNewline + 1;
      }
    }

    if (normalizedBefore < fileSize) {
      const lastNewline = buffer.lastIndexOf(0x0a, sliceEnd - 1);
      if (lastNewline >= sliceStart) {
        sliceEnd = lastNewline + 1;
      }
    }

    if (sliceEnd < sliceStart) {
      sliceEnd = sliceStart;
    }

    const startOffset = start + sliceStart;
    const endOffset = start + sliceEnd;
    const normalizedStartOffset =
      endOffset > startOffset ? startOffset : Math.max(0, start);

    return {
      chunkBase64: buffer.subarray(sliceStart, sliceEnd).toString("base64"),
      startOffset: normalizedStartOffset,
      endOffset,
      fileSize,
      done: normalizedStartOffset <= 0,
    };
  } catch (error) {
    console.error("Error reading conversation raw window:", error);
    return {
      chunkBase64: "",
      startOffset: Number.isFinite(beforeOffset) ? Number(beforeOffset) : 0,
      endOffset: Number.isFinite(beforeOffset) ? Number(beforeOffset) : 0,
      fileSize: 0,
      done: false,
    };
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }
}

/**
 * Append synthetic completion records for any unfinished (dangling) turns in
 * a session file. This is a DESTRUCTIVE operation that mutates the session log
 * and must ONLY be triggered by an explicit user action (the "Fix dangling"
 * button in the web UI). It must never be called automatically by server-side
 * polling, thread-state fallback, or any other background logic.
 */
export async function fixDanglingTurns(
  sessionId: string,
): Promise<FixDanglingSessionResponse> {
  return dedupe(`fixDanglingTurns:${sessionId}`, async () => {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      throw new Error("session id is required");
    }

    const filePath = await findSessionFile(normalizedSessionId);
    if (!filePath) {
      throw new Error(`session file not found: ${normalizedSessionId}`);
    }

    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n");
    const { startedTurnIds, startedTurnOrder, endedTurnIds } =
      collectTurnLifecycle(lines);

    const danglingTurnIds = startedTurnOrder.filter(
      (turnId) => !endedTurnIds.has(turnId),
    );

    if (danglingTurnIds.length > 0) {
      const nowMs = Date.now();
      const syntheticLines = danglingTurnIds.map((turnId, index) =>
        JSON.stringify({
          timestamp: new Date(nowMs + index).toISOString(),
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: turnId,
            last_agent_message:
              "[codex-deck] Synthetic completion generated by Fix dangling.",
          },
        }),
      );

      let appendText = syntheticLines.join("\n");
      if (appendText) {
        if (content.length > 0 && !content.endsWith("\n")) {
          appendText = `\n${appendText}`;
        }
        appendText = `${appendText}\n`;
        await appendFile(filePath, appendText, "utf-8");
      }
    }

    return {
      sessionId: normalizedSessionId,
      filePath,
      startedTurnCount: startedTurnIds.size,
      endedTurnCountBefore: endedTurnIds.size,
      endedTurnCountAfter: endedTurnIds.size + danglingTurnIds.length,
      danglingTurnIds,
      appendedTurnIds: danglingTurnIds,
    };
  });
}

export async function getSessionWaitState(
  sessionId: string,
): Promise<CodexSessionWaitStateResponse> {
  return dedupe(`getSessionWaitState:${sessionId}`, async () => {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      throw new Error("session id is required");
    }

    const filePath = await findSessionFile(normalizedSessionId);
    if (!filePath) {
      return {
        sessionId: normalizedSessionId,
        isWaiting: false,
        activeTurnId: null,
        danglingTurnIds: [],
      };
    }

    const cached = sessionWaitStateCache.get(normalizedSessionId);

    try {
      const fileStat = await stat(filePath);
      if (
        cached &&
        cached.filePath === filePath &&
        cached.mtimeMs === fileStat.mtimeMs &&
        cached.size === fileStat.size
      ) {
        return cached.result;
      }

      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n");
      const { startedTurnOrder, endedTurnIds } = collectTurnLifecycle(lines);
      const danglingTurnIds = startedTurnOrder.filter(
        (turnId) => !endedTurnIds.has(turnId),
      );
      const activeTurnId =
        danglingTurnIds.length > 0
          ? danglingTurnIds[danglingTurnIds.length - 1]
          : null;

      const result: CodexSessionWaitStateResponse = {
        sessionId: normalizedSessionId,
        isWaiting: activeTurnId !== null,
        activeTurnId,
        danglingTurnIds,
      };

      sessionWaitStateCache.set(normalizedSessionId, {
        filePath,
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
        result,
      });

      return result;
    } catch {
      if (cached) {
        return cached.result;
      }

      sessionWaitStateCache.delete(normalizedSessionId);
      return {
        sessionId: normalizedSessionId,
        isWaiting: false,
        activeTurnId: null,
        danglingTurnIds: [],
      };
    }
  });
}

export async function getSessionFileStats(
  sessionId: string,
): Promise<SessionFileStats | null> {
  return dedupe(`getSessionFileStats:${sessionId}`, async () => {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      throw new Error("session id is required");
    }

    const filePath = await findSessionFile(normalizedSessionId);
    if (!filePath) {
      return null;
    }

    try {
      const fileStat = await stat(filePath);
      return {
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
      };
    } catch {
      return null;
    }
  });
}

export async function getSessionContext(
  sessionId: string,
): Promise<CodexSessionContextResponse> {
  return dedupe(`getSessionContext:${sessionId}`, async () => {
    const filePath = await findSessionFile(sessionId);
    if (!filePath) {
      return {
        sessionId,
        contextLeftPercent: null,
        usedTokens: null,
        modelContextWindow: null,
        tokenUsage: null,
      };
    }

    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n");

      let latestUsedTokens: number | null = null;
      let latestModelContextWindow: number | null = null;
      let latestTokenUsageSummary: CodexSessionTokenUsage | null = null;

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line || !line.trim()) {
          continue;
        }

        const parsed = safeJsonParse(line);
        if (!parsed || typeof parsed !== "object") {
          continue;
        }

        const record = parsed as { type?: unknown; payload?: unknown };
        if (
          record.type !== "event_msg" ||
          !record.payload ||
          typeof record.payload !== "object"
        ) {
          continue;
        }

        const payload = record.payload as Record<string, unknown>;
        const payloadType =
          typeof payload.type === "string" ? payload.type : "";

        if (payloadType === "token_count") {
          const info = payload.info;
          if (!info || typeof info !== "object") {
            continue;
          }

          const infoRecord = info as Record<string, unknown>;

          if (latestUsedTokens === null) {
            const lastTokenUsage = infoRecord.last_token_usage;
            if (lastTokenUsage && typeof lastTokenUsage === "object") {
              latestUsedTokens = parseFiniteNumber(
                (lastTokenUsage as Record<string, unknown>).total_tokens,
              );
            }
          }

          if (latestUsedTokens === null) {
            const totalTokenUsage = infoRecord.total_token_usage;
            if (totalTokenUsage && typeof totalTokenUsage === "object") {
              latestUsedTokens = parseFiniteNumber(
                (totalTokenUsage as Record<string, unknown>).total_tokens,
              );
            }
          }

          if (latestTokenUsageSummary === null) {
            latestTokenUsageSummary = parseTokenUsageSummary(
              infoRecord.total_token_usage,
            );
          }
          if (latestTokenUsageSummary === null) {
            latestTokenUsageSummary = parseTokenUsageSummary(
              infoRecord.last_token_usage,
            );
          }

          if (latestModelContextWindow === null) {
            latestModelContextWindow = parseFiniteNumber(
              infoRecord.model_context_window,
            );
          }

          if (latestUsedTokens !== null && latestModelContextWindow !== null) {
            break;
          }
          continue;
        }

        if (
          payloadType === "task_started" &&
          latestModelContextWindow === null
        ) {
          latestModelContextWindow = parseFiniteNumber(
            payload.model_context_window,
          );
          if (latestUsedTokens !== null && latestModelContextWindow !== null) {
            break;
          }
        }
      }

      const contextLeftPercent =
        latestModelContextWindow !== null && latestUsedTokens !== null
          ? computeContextLeftPercent(
              latestUsedTokens,
              latestModelContextWindow,
            )
          : latestModelContextWindow !== null
            ? 100
            : null;

      return {
        sessionId,
        contextLeftPercent,
        usedTokens:
          contextLeftPercent === null && latestUsedTokens !== null
            ? latestUsedTokens
            : null,
        modelContextWindow: latestModelContextWindow,
        tokenUsage: latestTokenUsageSummary,
      };
    } catch {
      return {
        sessionId,
        contextLeftPercent: null,
        usedTokens: null,
        modelContextWindow: null,
        tokenUsage: null,
      };
    }
  });
}

export async function getConversationStream(
  sessionId: string,
  fromOffset: number = 0,
  options: ConversationStreamOptions = {},
): Promise<StreamResult> {
  const filePath = await findSessionFile(sessionId);

  if (!filePath) {
    return { messages: [], nextOffset: 0, done: true };
  }

  let fileHandle;
  try {
    if (fromOffset > 0 && !sessionToolNameIndex.has(sessionId)) {
      await getConversation(sessionId);
    }

    const fileStat = await stat(filePath);
    const fileSize = fileStat.size;
    const hasPayloadLimit =
      Number.isFinite(options.maxPayloadBytes) &&
      typeof options.maxPayloadBytes === "number" &&
      options.maxPayloadBytes > 0;
    const maxPayloadBytes = hasPayloadLimit
      ? Math.floor(options.maxPayloadBytes as number)
      : null;

    if (fromOffset >= fileSize) {
      return { messages: [], nextOffset: fromOffset, done: true };
    }

    fileHandle = await open(filePath, "r");
    const stream = fileHandle.createReadStream({
      start: fromOffset,
      encoding: "utf-8",
    });

    const parsedLines: LineWithOffset[] = [];
    let bytesConsumed = 0;
    const existingToolNames =
      fromOffset === 0
        ? new Map<string, string>()
        : (sessionToolNameIndex.get(sessionId) ?? new Map<string, string>());
    let stopReading = false;

    const tryConsumeLine = (
      line: string,
      hasTrailingNewline: boolean,
    ): boolean => {
      const lineBytes =
        Buffer.byteLength(line, "utf-8") + (hasTrailingNewline ? 1 : 0);
      const lineOffset = fromOffset + bytesConsumed;
      let shouldIncludeLine = true;

      if (line.trim()) {
        const parsed = safeJsonParse(line);
        if (parsed === null) {
          console.warn(
            `[codex-deck] stopped conversation stream parse for ${sessionId} at offset ${lineOffset}: invalid JSON line`,
          );
          return false;
        }

        parsedLines.push({
          line,
          offset: lineOffset,
        });

        if (maxPayloadBytes !== null) {
          const probeToolNames = new Map(existingToolNames);
          const candidateMessages = parseCodexConversation(
            parsedLines,
            probeToolNames,
          );
          const candidateOffset = fromOffset + bytesConsumed + lineBytes;
          const candidateNextOffset =
            candidateOffset > fileSize ? fileSize : candidateOffset;
          const candidatePayloadSize = Buffer.byteLength(
            JSON.stringify({
              messages: candidateMessages,
              nextOffset: candidateNextOffset,
              done: candidateNextOffset >= fileSize,
            }),
            "utf-8",
          );

          if (
            candidatePayloadSize > maxPayloadBytes &&
            parsedLines.length > 1
          ) {
            parsedLines.pop();
            shouldIncludeLine = false;
          }
        }
      }

      if (!shouldIncludeLine) {
        return false;
      }

      bytesConsumed += lineBytes;
      return true;
    };

    let pendingText = "";
    for await (const chunk of stream) {
      pendingText += chunk;

      while (true) {
        const newlineIndex = pendingText.indexOf("\n");
        if (newlineIndex === -1) {
          break;
        }

        const line = pendingText.slice(0, newlineIndex);
        pendingText = pendingText.slice(newlineIndex + 1);

        if (!tryConsumeLine(line, true)) {
          pendingText = `${line}\n${pendingText}`;
          stopReading = true;
          break;
        }
      }

      if (stopReading) {
        break;
      }
    }

    if (!stopReading && pendingText && bytesConsumed + fromOffset >= fileSize) {
      tryConsumeLine(pendingText, false);
    }

    const actualOffset = fromOffset + bytesConsumed;
    const nextOffset = actualOffset > fileSize ? fileSize : actualOffset;
    const done = nextOffset >= fileSize;
    const toolNames = existingToolNames;
    const messages = parseCodexConversation(parsedLines, toolNames);
    sessionToolNameIndex.set(sessionId, toolNames);

    return {
      messages,
      nextOffset,
      done,
    };
  } catch (err) {
    console.error("Error reading conversation stream:", err);
    return { messages: [], nextOffset: fromOffset, done: false };
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }
}

export async function getSessionTerminalRuns(
  sessionId: string,
): Promise<SessionTerminalRunsResponse> {
  return dedupe(`getSessionTerminalRuns:${sessionId}`, async () => {
    const filePath = await findSessionFile(sessionId);
    if (!filePath) {
      return {
        sessionId,
        runs: [],
        unavailableReason: "Session file is unavailable.",
      };
    }

    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n");
      const parsedLines: LineWithOffset[] = [];
      let offset = 0;
      for (const line of lines) {
        const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
        if (line.trim()) {
          parsedLines.push({ line, offset });
        }
        offset += lineBytes;
      }

      const runs = parseTerminalRuns(parsedLines).map((run) => ({
        processId: run.processId,
        callId: run.callId,
        command: run.command,
        isRunning: run.isRunning,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        latestActivityAt: run.latestActivityAt,
      }));

      return {
        sessionId,
        runs,
        unavailableReason: null,
      };
    } catch {
      return {
        sessionId,
        runs: [],
        unavailableReason: "Failed to read terminal runs.",
      };
    }
  });
}

export async function getSessionTerminalRunOutput(
  sessionId: string,
  processId: string,
): Promise<SessionTerminalRunOutputResponse | null> {
  const normalizedSessionId = sessionId.trim();
  const normalizedProcessId = processId.trim();
  if (!normalizedSessionId || !normalizedProcessId) {
    return null;
  }

  return dedupe(
    `getSessionTerminalRunOutput:${normalizedSessionId}:${normalizedProcessId}`,
    async () => {
      const filePath = await findSessionFile(normalizedSessionId);
      if (!filePath) {
        return {
          sessionId: normalizedSessionId,
          processId: normalizedProcessId,
          command: "",
          isRunning: false,
          output: "",
          unavailableReason: "Session file is unavailable.",
        };
      }

      try {
        const content = await readFile(filePath, "utf-8");
        const lines = content.split("\n");
        const parsedLines: LineWithOffset[] = [];
        let offset = 0;
        for (const line of lines) {
          const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
          if (line.trim()) {
            parsedLines.push({ line, offset });
          }
          offset += lineBytes;
        }

        const run = parseTerminalRuns(parsedLines).find(
          (item) => item.processId === normalizedProcessId,
        );
        if (!run) {
          return null;
        }

        return {
          sessionId: normalizedSessionId,
          processId: normalizedProcessId,
          command: run.command,
          isRunning: run.isRunning,
          output: run.outputParts.join(""),
          unavailableReason: null,
        };
      } catch {
        return {
          sessionId: normalizedSessionId,
          processId: normalizedProcessId,
          command: "",
          isRunning: false,
          output: "",
          unavailableReason: "Failed to read terminal run output.",
        };
      }
    },
  );
}

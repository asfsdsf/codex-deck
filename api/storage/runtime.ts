export type { CodexBackgroundTerminal } from "../background-terminals";
import type { CodexOperationalNotification } from "../operational-notifications";
export type { CodexOperationalNotification } from "../operational-notifications";
import type { CodexHookRun } from "../hook-runs";
export type { CodexHookRun } from "../hook-runs";
export type { CodexMemoryStatus, CodexThreadMemory } from "../codex-memory";
import type { CodexModelServiceTier } from "../service-tiers";
export type { CodexModelServiceTier } from "../service-tiers";
export type { CodexReviewTarget, CodexReviewResult } from "../codex-review";
import {
  isRolloutFile,
  openRollout,
  statRollout,
  readRolloutText,
  materializeRolloutForWrite,
  plainRolloutPath,
  readRolloutPrefix,
  statRolloutSource,
  resolveRolloutSource,
} from "../rollout-files";
import {
  readSessionSummaryIndex,
  type SessionSummary,
} from "../session-summary-index";
import {
  readdir,
  readFile,
  stat,
  appendFile,
  writeFile,
  rm,
  rename,
} from "fs/promises";
import { basename, isAbsolute, join, resolve } from "path";
import { homedir } from "os";
import { randomUUID } from "node:crypto";
import { mergeGeneratedImage, parseGeneratedImage } from "../generated-images";
export type {
  CodexElicitationRequest,
  CodexElicitationResponse,
} from "../mcp-elicitation";
import { spawnSync } from "node:child_process";
import {
  clearConversationIndexes,
  applyConversationLiveEvent,
  readConversationMessageWindow,
  readConversationMessageUpdates,
  readConversationMessageSnapshot,
} from "../conversation-index";
import {
  ConversationParserState,
  parseConversationTextChunk,
} from "../conversation-parser";
import {
  attachTokenUsageToModelOutputs,
  parseConversationModelMetadata,
  type ConversationModelMetadata,
  getModelOutputTokenUsage,
  isModelOutputMessage,
} from "../conversation-token-usage";
import {
  collectEditableMessagePairs,
  getEditableResponseItem,
  replaceEditableEventMessageText,
} from "../conversation-edit-records";
import { splitPathSegments } from "../path-utils";
import type { ConversationHoverSettings } from "../conversation-hover-settings";
import { getSessionOrigin, type SessionOrigin } from "../session-origins";
export type { SessionOrigin } from "../session-origins";

export interface HistoryEntry {
  sessionId: string;
  timestamp: number;
  text: string;
}

export interface Session {
  id: string;
  display: string;
  createdAt?: number;
  lastUserMessageAt?: number;
  /** Backward-compatible alias for lastUserMessageAt. */
  timestamp: number;
  project: string;
  projectName: string;
  origin?: SessionOrigin;
}

export type SessionContentSearchCommand = "rg" | "ag" | "ack" | "grep";

export interface SessionContentSearchResponse {
  query: string;
  command: SessionContentSearchCommand;
  sessionIds: string[];
}

export interface SessionSearchFileEntry {
  sessionId: string;
  filePath: string;
}

export interface SessionsDeltaResponse {
  version: number;
  isFullSnapshot: boolean;
  sessions: Session[];
  updates: Session[];
  removedSessionIds: string[];
  skillsChangedSessionIds: string[];
  codexAppServerEvents?: CodexAppServerEvent[];
}

export type CodexReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra"
  | (string & {});

export type CodexServiceTier = string;

export interface CodexModelOption {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  hidden: boolean;
  defaultReasoningEffort: CodexReasoningEffort | null;
  supportedReasoningEfforts: CodexReasoningEffort[];
  serviceTiers?: CodexModelServiceTier[];
  defaultServiceTier?: string | null;
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
  /** Null restores the current configured/catalog default. */
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

export type CodexAuthMode =
  | "apiKey"
  | "chatgpt"
  | "chatgptAuthTokens"
  | "agentIdentity";

export interface CodexStatusProviderInfo {
  id: string | null;
  url: string | null;
  apiKeyMasked: string | null;
}

export interface CodexThreadStatusDetails {
  authMode: CodexAuthMode | null;
  fastMode: boolean;
  serviceTier: CodexServiceTier | null;
  provider: CodexStatusProviderInfo | null;
}

export interface CodexTurnError {
  message: string;
  additionalDetails: string | null;
}

export interface CodexThreadStateResponse {
  threadId: string;
  activeTurnId: string | null;
  isGenerating: boolean;
  requestedTurnId: string | null;
  requestedTurnStatus: CodexTurnStatus | null;
  statusDetails?: CodexThreadStatusDetails | null;
}

export type CodexSubAgentActivityKind =
  | "started"
  | "interacted"
  | "interrupted";

export type CodexCollabAgentToolCallStatus =
  | "inProgress"
  | "completed"
  | "failed";

export type CodexCollabAgentTool =
  | "spawnAgent"
  | "sendInput"
  | "resumeAgent"
  | "wait"
  | "closeAgent";

export type CodexCollabAgentStatus =
  | "pendingInit"
  | "running"
  | "interrupted"
  | "completed"
  | "errored"
  | "shutdown"
  | "notFound";

export interface CodexCollabAgentState {
  status: CodexCollabAgentStatus;
  message: string | null;
}

export type CodexAppServerEvent =
  | { type: "background_terminals_changed"; threadId: string; changeId: number }
  | {
      type: "operational_notification";
      threadId: string | null;
      notification: CodexOperationalNotification;
    }
  | ({ type: "hook_run" } & CodexHookRun)
  | {
      type: "user_input_requests_changed" | "elicitation_requests_changed";
      threadId: string;
      requestId: string;
      pending: boolean;
    }
  | {
      type: "item_completed" | "image_generation_updated";
      threadId: string;
      turnId: string;
      itemId: string;
      item: Record<string, unknown>;
    }
  | {
      type: "error";
      threadId: string;
      turnId: string;
      willRetry: boolean;
      error: CodexTurnError | null;
    }
  | {
      type: "assistant_delta";
      threadId: string;
      turnId: string;
      itemId: string;
      delta: string;
    }
  | {
      type: "plan_delta";
      threadId: string;
      turnId: string;
      itemId: string;
      delta: string;
    }
  | {
      type: "reasoning_summary_delta";
      threadId: string;
      turnId: string;
      itemId: string;
      delta: string;
      summaryIndex: number;
    }
  | {
      type: "reasoning_text_delta";
      threadId: string;
      turnId: string;
      itemId: string;
      delta: string;
      contentIndex: number;
    }
  | {
      type: "thread_status";
      threadId: string;
      status: CodexThreadRuntimeStatus;
      turnId: string | null;
    }
  | {
      type: "subagent_activity";
      threadId: string;
      turnId: string | null;
      itemId: string;
      agentThreadId: string;
      agentPath: string;
      kind: CodexSubAgentActivityKind;
    }
  | {
      type: "collab_agent_tool_call";
      threadId: string;
      turnId: string | null;
      itemId: string;
      tool: CodexCollabAgentTool;
      status: CodexCollabAgentToolCallStatus;
      senderThreadId: string;
      receiverThreadIds: string[];
      prompt: string | null;
      model: string | null;
      reasoningEffort: CodexReasoningEffort | null;
      agentsStates: Record<string, CodexCollabAgentState>;
    };

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
  parentThreadId: string | null;
  canAcceptDirectInput: boolean | null;
  agentPath: string | null;
  source: string | null;
  status: CodexThreadRuntimeStatus;
  updatedAt: number | null;
}

export interface CodexThreadNameSetRequest {
  name: string;
}

export interface CodexThreadNameSetResponse {
  ok: boolean;
}

export type CodexThreadGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

export interface CodexThreadGoal {
  threadId: string;
  objective: string;
  status: CodexThreadGoalStatus;
  tokenBudget?: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface CodexThreadGoalSetRequest {
  objective?: string | null;
  status?: CodexThreadGoalStatus | null;
  tokenBudget?: number | null;
}

export interface CodexThreadGoalSetResponse {
  goal: CodexThreadGoal;
}

export interface CodexThreadGoalGetResponse {
  goal: CodexThreadGoal | null;
}

export interface CodexThreadGoalClearResponse {
  cleared: boolean;
}

export interface CodexThreadForkResponse {
  thread: CodexThreadSummary;
}

export type DiffGuideStatus =
  | "starting"
  | "generating"
  | "ready"
  | "unavailable"
  | "failed";

export interface DiffGuideSummary {
  sessionId: string;
  parentSessionId: string;
  projectRoot: string;
  status: DiffGuideStatus;
  error: string | null;
}

export interface DiffGuideStartRequest {
  sourceSessionId: string;
  requestId: string;
  prompt?: string;
  model?: string | null;
  effort?: CodexReasoningEffort | null;
  skillInstallChoice?: "local" | "global" | null;
  retry?: boolean;
}

export type DiffGuideStartResponse =
  | { status: "needs_skill_install"; projectRoot: string }
  | {
      status: "started" | "failed";
      guide: DiffGuideSummary;
      thread: CodexThreadSummary;
      turnId: string | null;
    };

export interface DiffGuideContentResponse {
  guide: DiffGuideSummary;
  html: string | null;
}

export interface DiffGuideSourceResponse {
  path: string;
  side: "left" | "right";
  lineStart: number;
  lines: string[];
  totalLines: number;
  nextLine: number | null;
}

export interface CodexThreadSideStartResponse {
  thread: CodexThreadSummary;
  parentThreadId: string;
}

export interface CodexThreadCompactResponse {
  ok: boolean;
}

export interface CodexThreadArchiveResponse {
  ok: boolean;
}

export interface CodexMemoriesSettingsResponse {
  useMemories: boolean;
  generateMemories: boolean;
}

export interface CodexMemoriesSettingsWriteRequest {
  useMemories: boolean;
  generateMemories: boolean;
  threadId?: string | null;
}

export interface CodexMemoriesSettingsWriteResponse extends CodexMemoriesSettingsResponse {
  ok: boolean;
}

export interface CodexMemoriesResetResponse {
  ok: boolean;
}

export interface CodexThreadAgentListResponse {
  threads: CodexThreadSummary[];
}

export interface CodexAgentWaitConfig {
  minTimeoutMs: number;
  maxTimeoutMs: number;
  defaultTimeoutMs: number;
}

export type CodexAgentAction =
  | "send_message"
  | "followup_task"
  | "wait"
  | "interrupt_agent";

export interface CodexThreadAgentActionRequest {
  action: CodexAgentAction;
  targetThreadId?: string;
  message?: string;
  timeoutMs?: number;
}

export interface CodexThreadAgentActionResponse {
  ok: boolean;
  action: CodexAgentAction;
  controllerThreadId: string;
  targetThreadId: string | null;
  turnId: string | null;
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
  /** Older app-server versions omit this field and use blocking requests. */
  isBlocking?: boolean;
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

export interface CodexHomeDescriptor {
  id: string;
  label: string;
  isMain: boolean;
  available: boolean;
  unavailableReason: string | null;
}

export interface CodexHomesResponse {
  homes: CodexHomeDescriptor[];
  mainHomeId: string;
}

export interface CodexDeckConfigFileResponse {
  path: string;
  content: string;
  revision: string;
  hoverSettings?: ConversationHoverSettings;
}

export interface CodexDeckConfigWriteRequest {
  content: string;
  revision: string;
}

export interface CodexDeckConfigWriteResponse extends CodexDeckConfigFileResponse {
  ok: true;
  appliedKeys: string[];
  restartRequiredKeys: string[];
  homes: CodexHomeDescriptor[];
  mainHomeId: string;
}

export type CodexDeckUpdateMethod = "npm" | "source";

export interface CodexDeckUpdateOutputResponse {
  updateId: string | null;
  output: string;
  truncated: boolean;
  updateInProgress: boolean;
}

export interface CodexDeckUpdateStatusResponse {
  daemonManaged: boolean;
  restartSupported: boolean;
  unavailableReason: string | null;
  currentVersion: string;
  updateMethod: CodexDeckUpdateMethod;
  sourceRoot: string;
  defaultSourceRoot: string;
  daemonStartedAt: string;
  updateInProgress: boolean;
  npm: {
    checked: boolean;
    latestVersion: string | null;
    updateAvailable: boolean | null;
    checkedAt: string | null;
  };
}

export interface CodexDeckUpdateRequest {
  method: CodexDeckUpdateMethod;
  sourceRoot?: string;
}

export interface CodexDeckUpdateResponse {
  ok: true;
  method: CodexDeckUpdateMethod;
  installedVersion: string;
  sourceRoot: string | null;
  restartScheduled: true;
  daemonStartedAt: string;
  message: string;
}

export interface CodexConfigDefaultsResponse {
  model: string | null;
  reasoningEffort: CodexReasoningEffort | null;
  planModeReasoningEffort: CodexReasoningEffort | null;
}

export interface CodexPetAnimationFrame {
  spriteIndex: number;
  delayMs: number;
}

export interface CodexPetAnimation {
  name: string;
  frames: CodexPetAnimationFrame[];
}

export interface CodexPetMetadata {
  id: string;
  displayName: string;
  description: string | null;
  source: "builtin" | "custom" | "disabled";
  spritesheetUrl: string | null;
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
  animations: CodexPetAnimation[];
}

export interface CodexPetsResponse {
  currentPetId: string | null;
  disabledPetId: string;
  pets: CodexPetMetadata[];
}

export interface CodexPetSelectionRequest {
  petId: string;
}

export interface CodexPetSelectionResponse {
  currentPetId: string;
  pet: CodexPetMetadata | null;
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

export interface DeleteSessionOptions {
  /** Defaults to true. Set false to retain the saved diff guide files. */
  deleteDiffGuide?: boolean;
}

export interface DeleteSessionResponse {
  sessionId: string;
  removedSessionFilePaths: string[];
  removedHistoryEntries: number;
  removedSessionIndexEntries: number;
  sqlite: DeleteSessionSqliteResult;
}

export interface EditConversationMessageRequest {
  editId: string;
  expectedText: string;
  text: string;
}

export interface EditConversationMessageThreadHistoryResult {
  dbPath: string | null;
  projectionRowsDeleted: number;
  turnRowsDeleted: number;
  itemRowsDeleted: number;
  realtimeRowsDeleted: number;
  skippedReason: string | null;
  warnings: string[];
}

export interface EditConversationMessageSqliteResult {
  dbPath: string | null;
  threadsUpdated: number;
  skippedReason: string | null;
  warnings: string[];
  threadHistory: EditConversationMessageThreadHistoryResult;
}

export interface EditConversationMessageResponse {
  sessionId: string;
  editId: string;
  role: "user" | "assistant";
  text: string;
  sessionRecordsUpdated: number;
  historyRecordsUpdated: number;
  sqlite: EditConversationMessageSqliteResult;
  appServerRestarted?: boolean;
}

export interface TranslateTextRequest {
  text: string;
  inputLang?: string;
  outputLang?: string;
  /** Start a job whose output can be streamed or polled. */
  stream?: boolean;
}

export interface TranslateTextResponse {
  translatedText: string;
}

export interface TranslateTextProgress extends TranslateTextResponse {
  translationId: string;
  done: boolean;
  error?: string;
}

export interface DeleteTerminalResponse {
  ok: boolean;
  deletedSessionIds: string[];
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

export interface TerminalBootstrapPayload {
  snapshot: TerminalSnapshotResponse;
  artifacts: TerminalSessionArtifactsResponse | null;
}

export type TerminalStreamEvent =
  | {
      terminalId: string;
      seq: number;
      type: "bootstrap";
      snapshot: TerminalSnapshotResponse;
      artifacts: TerminalSessionArtifactsResponse | null;
    }
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
    }
  | {
      terminalId: string;
      seq: number;
      type: "artifacts";
      artifacts: TerminalSessionArtifactsResponse;
    };

export interface TerminalEventsResponse {
  events: TerminalStreamEvent[];
  requiresReset: boolean;
  snapshot: TerminalSnapshotResponse | null;
  bootstrap: TerminalBootstrapPayload | null;
}

export type TerminalSessionMessageActionDecision = "approved" | "rejected";

export interface TerminalSessionPlanStepAction {
  stepId: string;
  decision: TerminalSessionMessageActionDecision;
  reason: string | null;
  updatedAt: string;
}

export interface TerminalSessionPlanStep {
  stepId: string;
  stepGoal: string | null;
  command: string;
  explanation: string | null;
  cwd: string | null;
  shell: string | null;
  risk: "low" | "medium" | "high";
  nextAction: "approve" | "reject" | "provide_input";
  contextNote: string | null;
}

export interface TerminalSessionPlanExecutionFeedback {
  kind: "execution";
  stepId: string;
  updatedAt: string;
  status: "success" | "failed" | "timed_out" | "completed_unknown";
  exitCode: number | null;
  cwdAfter: string | null;
  outputSummary: string | null;
  errorSummary: string | null;
  outputReference: string | null;
}

export interface TerminalSessionPlanRejectionFeedback {
  kind: "rejection";
  stepId: string;
  updatedAt: string;
  decision: "rejected";
  reason: string | null;
}

export type TerminalSessionPlanStepFeedback =
  | TerminalSessionPlanExecutionFeedback
  | TerminalSessionPlanRejectionFeedback;

export type TerminalSessionBlockType =
  | "terminal_snapshot"
  | "ai_terminal_plan"
  | "ai_terminal_need_input"
  | "ai_terminal_complete";

export type TerminalSnapshotCaptureKind = "manual";

export type TerminalSnapshotFormat = "xterm-serialize-v1";

export interface TerminalSerializedSnapshot {
  format: TerminalSnapshotFormat;
  cols: number;
  rows: number;
  data: string;
}

export interface TerminalSessionBlockRecord {
  blockId: string;
  terminalId: string;
  sessionId: string;
  type: TerminalSessionBlockType;
  sequence: number;
  createdAt: string;
  updatedAt: string;
  messageKey: string | null;
  stepId: string | null;
  snapshotPath: string | null;
  snapshotFormat: TerminalSnapshotFormat | null;
  cols: number | null;
  rows: number | null;
  snapshotLength: number | null;
  captureKind: TerminalSnapshotCaptureKind | null;
  leadingMarkdown: string | null;
  trailingMarkdown: string | null;
  rawBlock: string | null;
  contextNote: string | null;
  message: string | null;
  question: string | null;
  steps: TerminalSessionPlanStep[] | null;
  stepActions: TerminalSessionPlanStepAction[] | null;
  stepFeedback: TerminalSessionPlanStepFeedback[] | null;
}

export interface TerminalSessionBlockRecordWithSnapshot extends TerminalSessionBlockRecord {
  snapshot: TerminalSerializedSnapshot | null;
}

export interface TerminalSessionArtifactsManifest {
  terminalId: string;
  createdAt: string;
  updatedAt: string;
  blocks: TerminalSessionBlockRecord[];
}

export type TerminalTimelineEntry =
  | {
      type: "snapshot";
      key: string;
      blockId: string;
      snapshot: TerminalSerializedSnapshot;
    }
  | {
      type: "card";
      key: string;
      messageKey: string;
    };

export interface TerminalPersistFrozenBlockRequest {
  sessionId: string;
  captureKind?: TerminalSnapshotCaptureKind | null;
  messageKey?: string | null;
  snapshot: TerminalSerializedSnapshot;
  stepId?: string | null;
  sequence?: number | null;
}

export interface TerminalPersistFrozenBlockResponse {
  block: TerminalSessionBlockRecord;
}

export type TerminalChatAction = "send" | "init" | "chat-in-session";

export type TerminalChatActionSkillInstallChoice = "local" | "global";

export interface TerminalChatActionRequest {
  action: TerminalChatAction;
  text?: string;
  images?: string[];
  model?: string | null;
  effort?: CodexReasoningEffort | null;
  collaborationMode?: CodexCollaborationModeInput | null;
  skillInstallChoice?: TerminalChatActionSkillInstallChoice | null;
}

export interface TerminalChatActionCompletedResponse {
  status: "completed";
  action: TerminalChatAction;
  terminalId: string;
  sessionId: string;
  boundSessionId: string | null;
  turnId: string | null;
  createdSession: boolean;
}

export interface TerminalChatActionNeedsSkillInstallResponse {
  status: "needs_skill_install";
  action: "init" | "chat-in-session";
  terminalId: string;
  projectRoot: string;
}

export type TerminalChatActionResponse =
  | TerminalChatActionCompletedResponse
  | TerminalChatActionNeedsSkillInstallResponse;

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
  stepActions: TerminalSessionPlanStepAction[];
}

export interface TerminalSessionArtifactsResponse {
  terminalId: string;
  sessionId: string | null;
  manifest: TerminalSessionArtifactsManifest;
  blocks: TerminalSessionBlockRecordWithSnapshot[];
  timelineEntries: TerminalTimelineEntry[];
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

export interface DeleteWorkflowResponse extends WorkflowActionResponse {
  deletedSessionIds: string[];
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
    | "thread_goal"
    | "task_started"
    | "task_complete";
  /** Stable, 1-based logical order within one file generation. */
  sequence?: number;
  itemId?: string;
  streaming?: boolean;
  /** Monotonic version of the latest update, used to ignore stale window responses. */
  revision?: number;
  /** Stable, 1-based visible position; pages contain 100 visible messages. */
  messageNumber?: number;
  uuid?: string;
  parentUuid?: string;
  turnId?: string;
  timestamp?: string;
  sessionId?: string;
  message?: {
    role: string;
    content: string | ContentBlock[];
    /** Distinguish the answer from progress/tool commentary when Codex records it. */
    phase?: "commentary" | "final_answer";
    model?: string;
    reasoningEffort?: CodexReasoningEffort;
    serviceTier?: string;
    usage?: TokenUsage;
  };
  summary?: string;
  repeatCount?: number;
  repeatCountMax?: number;
  rateLimitId?: string | null;
  threadGoal?: CodexThreadGoal;
  editable?: boolean;
  editId?: string;
  editText?: string;
}

export interface ContentBlock {
  type:
    | "text"
    | "image"
    | "image_generation"
    | "thinking"
    | "tool_use"
    | "tool_result"
    | "reasoning"
    | "agent_reasoning"
    | "subagent_activity"
    | "collab_agent_tool_call";
  text?: string;
  image_url?: string;
  generatedImage?: {
    status: string;
    prompt?: string;
    result?: string;
    fileId?: string;
    savedPath?: string;
    failure?: string;
  };
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  timestamp?: string;
  token_usage?: TokenUsage;
  agentThreadId?: string;
  agentPath?: string;
  kind?: CodexSubAgentActivityKind;
  tool?: CodexCollabAgentTool;
  status?: CodexCollabAgentToolCallStatus;
  senderThreadId?: string;
  receiverThreadIds?: string[];
  prompt?: string | null;
  model?: string | null;
  reasoningEffort?: CodexReasoningEffort | null;
  agentsStates?: Record<string, CodexCollabAgentState>;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
  reasoning_output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** Context capacity recorded for this model call, rather than the latest session state. */
  model_context_window?: number;
}

export interface StreamResult {
  messages: ConversationMessage[];
  nextOffset: number;
  done: boolean;
  fileId?: string;
  totalMessages?: number;
}

/** Numbered endpoints use nextOffset as a monotonic revision cursor, not a file byte offset. */
export interface ConversationMessageWindow extends StreamResult {
  /** First logical sequence in this window, or 0 when no older history remains. */
  historyStartSequence: number;
}

export interface ConversationStreamOptions {
  maxPayloadBytes?: number;
  skipToolNameBootstrap?: boolean;
}

export interface ConversationRawChunkResponse {
  chunkBase64: string;
  nextOffset: number;
  done: boolean;
  fileId?: string;
}

export interface ConversationRawWindowResponse {
  chunkBase64: string;
  startOffset: number;
  endOffset: number;
  fileSize: number;
  done: boolean;
  fileId?: string;
}

interface SessionMeta {
  id: string;
  cwd: string;
  timestamp: number;
  archivedAt: number | null;
  origin?: SessionOrigin;
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

interface SessionUserMessageTimestampCacheEntry {
  filePath: string;
  timestamp: number;
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
const THREAD_HISTORY_DB_FILE_REGEX = /^thread_history_(\d+)\.sqlite$/i;
const LEGACY_STATE_DB_FILE = "state.sqlite";
const LEGACY_LOGS_DB_FILE = "logs.sqlite";
const LEGACY_THREAD_HISTORY_DB_FILE = "thread_history.sqlite";
const THREAD_HISTORY_PROJECTION_TABLES = [
  "thread_realtime_items",
  "thread_items",
  "thread_turns",
  "thread_history_projection_state",
] as const;
const HISTORY_SESSION_ID_KEYS = ["session_id", "sessionId", "conversation_id"];
const SESSION_INDEX_ID_KEYS = ["id", "thread_id", "threadId"];

let codexDir = join(homedir(), ".codex");
let codexHistoryPath = join(codexDir, "history.jsonl");
let codexSessionsDir = join(codexDir, "sessions");

const fileIndex = new Map<string, string>();
const sessionMetaIndex = new Map<string, SessionMeta>();
let sessionSummaryIndex = new Map<string, SessionSummary>();
const sessionDisplayCache = new Map<string, string>();
const sessionWaitStateCache = new Map<string, SessionWaitStateCacheEntry>();
const sessionUserMessageTimestampCache = new Map<
  string,
  SessionUserMessageTimestampCacheEntry
>();
let historyCache: Map<string, SessionHistory> | null = null;
let sessionsCache: Session[] | null = null;
let sessionsVersion = 0;

function invalidateSessionsCache(): void {
  sessionsCache = null;
  sessionsVersion += 1;
}

const pendingRequests = new Map<string, Promise<unknown>>();
const pendingSessionIndexUpdates = new Set<Promise<unknown>>();
const sessionEditQueues = new Map<string, Promise<void>>();
const sessionToolNameIndex = new Map<string, Map<string, string>>();
const sessionStreamPendingModelOutputs = new Map<
  string,
  ConversationMessage[]
>();
const sessionStreamModelMetadata = new Map<string, ConversationModelMetadata>();
const sessionStreamFileIds = new Map<string, string>();
// Replay delayed metadata to independent byte-offset readers.
const sessionStreamTokenUsageUpdates = new Map<
  string,
  Map<number, ConversationMessage[]>
>();

export function initStorage(dir?: string): void {
  invalidateSessionsCache();
  sessionDisplayCache.clear();
  clearConversationIndexes();
  sessionStreamPendingModelOutputs.clear();
  sessionStreamModelMetadata.clear();
  sessionStreamFileIds.clear();
  sessionStreamTokenUsageUpdates.clear();
  codexDir = dir ?? join(homedir(), ".codex");
  codexHistoryPath = join(codexDir, "history.jsonl");
  codexSessionsDir = join(codexDir, "sessions");
  sessionWaitStateCache.clear();
  sessionUserMessageTimestampCache.clear();
  sessionSummaryIndex.clear();
}

export function getCodexDir(): string {
  return codexDir;
}

export function getSessionSearchFileEntries(): SessionSearchFileEntry[] {
  return Array.from(fileIndex, ([sessionId, filePath]) => ({
    sessionId,
    filePath,
  }));
}

// Backward-compatible export to avoid breaking existing imports.
export function getClaudeDir(): string {
  return getCodexDir();
}

export function invalidateHistoryCache(): void {
  historyCache = null;
  invalidateSessionsCache();
}

export function addToFileIndex(
  sessionId: string,
  filePath: string,
): Promise<void> {
  invalidateSessionsCache();
  sessionSummaryIndex.delete(plainRolloutPath(filePath));
  fileIndex.set(sessionId, filePath);
  sessionDisplayCache.delete(sessionId);
  sessionWaitStateCache.delete(sessionId);
  sessionUserMessageTimestampCache.delete(sessionId);
  return hydrateSessionMeta(sessionId, filePath);
}

function clearSessionCaches(sessionId: string): void {
  invalidateSessionsCache();
  const indexedPath = fileIndex.get(sessionId);
  if (indexedPath) clearConversationIndexes(indexedPath);
  fileIndex.delete(sessionId);
  sessionMetaIndex.delete(sessionId);
  sessionDisplayCache.delete(sessionId);
  sessionWaitStateCache.delete(sessionId);
  sessionUserMessageTimestampCache.delete(sessionId);
  sessionToolNameIndex.delete(sessionId);
  sessionStreamPendingModelOutputs.delete(sessionId);
  sessionStreamModelMetadata.delete(sessionId);
  sessionStreamFileIds.delete(sessionId);
  sessionStreamTokenUsageUpdates.delete(sessionId);
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
  const normalized = value?.trim() ?? "";
  return normalized ? (normalized as CodexReasoningEffort) : null;
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
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i,
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

function parseOptionalNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

function parseLastTokenUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const inputTokens = parseFiniteNumber(record.input_tokens);
  const outputTokens = parseFiniteNumber(record.output_tokens);
  if (inputTokens === null || outputTokens === null) {
    return undefined;
  }

  const totalTokens = parseFiniteNumber(record.total_tokens);
  const reasoningOutputTokens = parseFiniteNumber(
    record.reasoning_output_tokens,
  );
  const cacheCreationInputTokens =
    parseFiniteNumber(record.cache_creation_input_tokens) ??
    parseFiniteNumber(record.cache_write_input_tokens);
  const cacheReadInputTokens =
    parseFiniteNumber(record.cache_read_input_tokens) ??
    parseFiniteNumber(record.cached_input_tokens);

  return {
    input_tokens: Math.max(0, Math.round(inputTokens)),
    output_tokens: Math.max(0, Math.round(outputTokens)),
    ...(totalTokens !== null
      ? { total_tokens: Math.max(0, Math.round(totalTokens)) }
      : {}),
    ...(reasoningOutputTokens !== null
      ? {
          reasoning_output_tokens: Math.max(
            0,
            Math.round(reasoningOutputTokens),
          ),
        }
      : {}),
    ...(cacheCreationInputTokens !== null
      ? {
          cache_creation_input_tokens: Math.max(
            0,
            Math.round(cacheCreationInputTokens),
          ),
        }
      : {}),
    ...(cacheReadInputTokens !== null
      ? {
          cache_read_input_tokens: Math.max(
            0,
            Math.round(cacheReadInputTokens),
          ),
        }
      : {}),
  };
}

function rememberStreamModelOutputs(
  sessionId: string,
  messages: ConversationMessage[],
): void {
  let pending: ConversationMessage[] = [];
  for (const message of messages) {
    if (message.type === "user" || message.type === "task_started") {
      pending = [];
    } else if (isModelOutputMessage(message)) {
      if (getModelOutputTokenUsage(message)) pending = [];
      else pending.push(message);
    }
  }
  sessionStreamPendingModelOutputs.set(sessionId, pending);
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

  const nestedRecord = nested as Record<string, unknown>;
  const nestedType =
    typeof nestedRecord.type === "string" ? nestedRecord.type : "";
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

function parseSessionMetaLine(
  line: string,
  followingLines: Iterable<string>,
): SessionMeta | null {
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
    origin: getSessionOrigin(record.payload, followingLines),
    cwd:
      typeof record.payload.cwd === "string" ? record.payload.cwd.trim() : "",
    timestamp: parseTimestamp(record.payload.timestamp),
    archivedAt: parseTimestamp(
      (record.payload as { archived_at?: unknown; archivedAt?: unknown })
        .archived_at ??
        (record.payload as { archived_at?: unknown; archivedAt?: unknown })
          .archivedAt,
    ),
  };
}

async function readSessionMetaFromFile(
  filePath: string,
): Promise<SessionMeta | null> {
  try {
    const prefix = await readRolloutPrefix(filePath);
    const [firstLine, ...followingLines] = prefix.toString("utf8").split("\n");
    return firstLine ? parseSessionMetaLine(firstLine, followingLines) : null;
  } catch {
    return null;
  }
}

async function hydrateSessionMeta(
  sessionId: string,
  filePath: string,
): Promise<void> {
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
      if (entry.isFile() && isRolloutFile(entry.name)) {
        output.push(fullPath);
      }
    }
  } catch {
    // Session directory may not exist yet.
  }
}

async function buildFileIndex(invalidateSessionList = true): Promise<void> {
  if (invalidateSessionList) invalidateSessionsCache();
  const nextFileIndex = new Map<string, string>();
  const nextMetaIndex = new Map<string, SessionMeta>();

  const files: string[] = [];
  await collectSessionFiles(codexSessionsDir, files);

  const stateDb = await findVersionedDbPath(
    await resolveSqliteHome(codexDir),
    STATE_DB_FILE_REGEX,
    LEGACY_STATE_DB_FILE,
  );
  const summaries = stateDb
    ? await readSessionSummaryIndex(stateDb)
    : new Map<string, SessionSummary>();
  const availablePaths = new Set(files.map(plainRolloutPath));
  const selectedRollouts = new Map(
    [...summaries.values()]
      .filter(
        (summary) =>
          summary.archivedAt ||
          summary.historyMode === "paginated" ||
          availablePaths.has(plainRolloutPath(summary.path)),
      )
      .map((summary) => [summary.id, plainRolloutPath(summary.path)]),
  );
  for (const summary of summaries.values()) {
    if (summary.archivedAt)
      nextMetaIndex.set(summary.id, {
        id: summary.id,
        cwd: summary.cwd,
        timestamp: summary.createdAt,
        archivedAt: summary.archivedAt,
      });
  }

  for (const filePath of files) {
    const fileSessionId = extractSessionIdFromPath(filePath);

    let sessionId = fileSessionId;
    const summary = summaries.get(plainRolloutPath(filePath));
    const rolloutMeta = await readSessionMetaFromFile(filePath);
    const meta = summary
      ? {
          id: summary.id,
          cwd: summary.cwd,
          timestamp: summary.createdAt,
          archivedAt: summary.archivedAt,
          origin: rolloutMeta?.origin,
        }
      : rolloutMeta;
    if (meta) {
      sessionId = meta.id;
    }

    if (sessionId) {
      // Reverts leave the old immutable source beside the replacement. Codex's
      // current rollout pointer takes precedence over filesystem iteration order.
      const selectedPath = selectedRollouts.get(sessionId);
      if (selectedPath && selectedPath !== plainRolloutPath(filePath)) continue;
      const previous = nextMetaIndex.get(sessionId);
      if (
        !selectedPath &&
        previous &&
        meta &&
        previous.timestamp > meta.timestamp
      )
        continue;
      if (meta) nextMetaIndex.set(sessionId, meta);
      nextFileIndex.set(sessionId, filePath);
    }
  }
  // Publish together so concurrent readers/watch callbacks never see a partial
  // scan and mistake a changed ancestor for a newly discovered active thread.
  fileIndex.clear();
  sessionMetaIndex.clear();
  for (const [id, path] of nextFileIndex) fileIndex.set(id, path);
  for (const [id, meta] of nextMetaIndex) sessionMetaIndex.set(id, meta);
  sessionSummaryIndex = summaries;
  sessionWaitStateCache.clear();
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

async function serializeSessionEdit<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = sessionEditQueues.get(sessionId) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const queued = previous.catch(() => undefined).then(() => gate);
  sessionEditQueues.set(sessionId, queued);

  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (sessionEditQueues.get(sessionId) === queued) {
      sessionEditQueues.delete(sessionId);
    }
  }
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

// history_base.thread_id names an immutable rollout, not the logical thread.
// Reverts retain the thread ID in metadata but use a fresh filename UUID.
// Archived ancestors must stay readable without entering the active session list.
async function findHistoryRollout(rolloutId: string): Promise<string | null> {
  const files: string[] = [];
  await Promise.all([
    collectSessionFiles(codexSessionsDir, files),
    collectSessionFiles(join(codexDir, "archived_sessions"), files),
  ]);
  return (
    files.find((file) => extractSessionIdFromPath(file) === rolloutId) ?? null
  );
}

async function sessionFileExists(filePath: string): Promise<boolean> {
  try {
    const fileStat = await statRolloutSource(filePath);
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
    content = await readRolloutText(filePath, "utf-8");
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

function escapeSqliteText(value: string): string {
  return value.replaceAll("'", "''");
}

function emptyThreadHistoryInvalidationResult(
  dbPath: string | null,
  skippedReason: string,
  warnings: string[] = [],
): EditConversationMessageThreadHistoryResult {
  return {
    dbPath,
    projectionRowsDeleted: 0,
    turnRowsDeleted: 0,
    itemRowsDeleted: 0,
    realtimeRowsDeleted: 0,
    skippedReason,
    warnings,
  };
}

async function invalidateEditedThreadHistoryProjection(
  sessionId: string,
): Promise<EditConversationMessageThreadHistoryResult> {
  const sqliteHome = await resolveSqliteHome(codexDir);
  const dbPath = await findVersionedDbPath(
    sqliteHome,
    THREAD_HISTORY_DB_FILE_REGEX,
    LEGACY_THREAD_HISTORY_DB_FILE,
  );
  if (!dbPath) {
    return emptyThreadHistoryInvalidationResult(
      null,
      "thread history db not found",
    );
  }

  const sqliteVersion = spawnSync("sqlite3", ["-version"], {
    encoding: "utf-8",
  });
  if (sqliteVersion.error || sqliteVersion.status !== 0) {
    const message = sqliteVersion.error
      ? sqliteVersion.error.message
      : (sqliteVersion.stderr?.trim() ?? "sqlite3 command failed");
    return emptyThreadHistoryInvalidationResult(
      dbPath,
      "sqlite3 is unavailable",
      [message],
    );
  }

  let tableNames: Set<string>;
  try {
    const output = runSqliteCommand(
      dbPath,
      `SELECT name FROM sqlite_master
       WHERE type='table'
         AND name IN ('${THREAD_HISTORY_PROJECTION_TABLES.join("','")}');`,
    );
    tableNames = new Set(
      output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) =>
          THREAD_HISTORY_PROJECTION_TABLES.includes(
            line as (typeof THREAD_HISTORY_PROJECTION_TABLES)[number],
          ),
        ),
    );
  } catch (error) {
    return emptyThreadHistoryInvalidationResult(
      dbPath,
      "failed to inspect thread history projection database",
      [error instanceof Error ? error.message : String(error)],
    );
  }

  const availableTables = THREAD_HISTORY_PROJECTION_TABLES.filter((table) =>
    tableNames.has(table),
  );
  if (availableTables.length === 0) {
    return emptyThreadHistoryInvalidationResult(
      dbPath,
      "thread history projection tables not found",
      [`thread history projection tables are missing from ${dbPath}`],
    );
  }

  const warnings: string[] = [];
  const missingTables = THREAD_HISTORY_PROJECTION_TABLES.filter(
    (table) => !tableNames.has(table),
  );
  if (missingTables.length > 0) {
    warnings.push(
      `thread history projection database ${dbPath} is missing tables: ${missingTables.join(", ")}`,
    );
  }

  const escapedSessionId = escapeSqliteText(sessionId);
  const statements = availableTables.map(
    (table) =>
      `DELETE FROM ${table} WHERE thread_id='${escapedSessionId}'; SELECT '${table}|' || changes();`,
  );

  try {
    const output = runSqliteCommand(
      dbPath,
      `BEGIN IMMEDIATE; ${statements.join(" ")} COMMIT;`,
    );
    const deletedRows = new Map<string, number>();
    for (const line of output.split("\n")) {
      const separatorIndex = line.indexOf("|");
      if (separatorIndex < 0) {
        continue;
      }
      const table = line.slice(0, separatorIndex).trim();
      const count = Number.parseInt(line.slice(separatorIndex + 1).trim(), 10);
      if (tableNames.has(table) && Number.isFinite(count)) {
        deletedRows.set(table, count);
      }
    }

    return {
      dbPath,
      projectionRowsDeleted:
        deletedRows.get("thread_history_projection_state") ?? 0,
      turnRowsDeleted: deletedRows.get("thread_turns") ?? 0,
      itemRowsDeleted: deletedRows.get("thread_items") ?? 0,
      realtimeRowsDeleted: deletedRows.get("thread_realtime_items") ?? 0,
      skippedReason: null,
      warnings,
    };
  } catch (error) {
    return emptyThreadHistoryInvalidationResult(
      dbPath,
      "failed to invalidate thread history projection",
      [...warnings, error instanceof Error ? error.message : String(error)],
    );
  }
}

async function updateEditedMessageInSqlite(
  sessionId: string,
  role: "user" | "assistant",
  oldText: string,
  newText: string,
  updateUserMetadata: boolean,
): Promise<Omit<EditConversationMessageSqliteResult, "threadHistory">> {
  const sqliteHome = await resolveSqliteHome(codexDir);
  const stateDbPath = await findVersionedDbPath(
    sqliteHome,
    STATE_DB_FILE_REGEX,
    LEGACY_STATE_DB_FILE,
  );
  if (!stateDbPath) {
    return {
      dbPath: null,
      threadsUpdated: 0,
      skippedReason: "state db not found",
      warnings: [],
    };
  }
  if (role !== "user") {
    return {
      dbPath: stateDbPath,
      threadsUpdated: 0,
      skippedReason: "assistant messages are not stored in the thread database",
      warnings: [],
    };
  }
  if (!updateUserMetadata) {
    return {
      dbPath: stateDbPath,
      threadsUpdated: 0,
      skippedReason:
        "only the first user message is mirrored in the thread database",
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
      threadsUpdated: 0,
      skippedReason: "sqlite3 is unavailable",
      warnings: [message],
    };
  }

  const escapedSessionId = escapeSqliteText(sessionId);
  const escapedOldText = escapeSqliteText(oldText);
  const escapedNewText = escapeSqliteText(newText);
  try {
    const output = runSqliteCommand(
      stateDbPath,
      `UPDATE threads
       SET first_user_message=CASE WHEN first_user_message='${escapedOldText}' THEN '${escapedNewText}' ELSE first_user_message END,
           title=CASE WHEN title='${escapedOldText}' THEN '${escapedNewText}' ELSE title END,
           preview=CASE WHEN preview='${escapedOldText}' THEN '${escapedNewText}' ELSE preview END
       WHERE id='${escapedSessionId}'
         AND (first_user_message='${escapedOldText}' OR title='${escapedOldText}' OR preview='${escapedOldText}');
       SELECT changes();`,
    );
    return {
      dbPath: stateDbPath,
      threadsUpdated: parseChangesResult(output),
      skippedReason: null,
      warnings: [],
    };
  } catch (error) {
    return {
      dbPath: stateDbPath,
      threadsUpdated: 0,
      skippedReason: "failed to update thread database",
      warnings: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function replaceResponseItemText(
  payload: Record<string, unknown>,
  text: string,
): void {
  if (typeof payload.content === "string") {
    payload.content = text;
    return;
  }
  if (!Array.isArray(payload.content)) {
    throw new Error("editable message has no text content");
  }

  let replaced = false;
  payload.content = payload.content.filter((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return true;
    }
    const block = item as Record<string, unknown>;
    if (block.type !== "input_text" && block.type !== "output_text") {
      return true;
    }
    if (replaced) {
      return false;
    }
    block.text = text;
    replaced = true;
    return true;
  });

  if (!replaced) {
    throw new Error("editable message has no text content");
  }
}

async function writeFileAtomically(
  filePath: string,
  content: string,
  mode?: number,
): Promise<void> {
  const tempPath = `${filePath}.codex-deck-edit-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tempPath, content, {
      encoding: "utf-8",
      ...(typeof mode === "number" ? { mode } : {}),
    });
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function updateHistoryMessageRecords(
  sessionId: string,
  oldText: string,
  newText: string,
): Promise<number> {
  let content: string;
  let fileMode: number | undefined;
  try {
    const [loadedContent, fileStat] = await Promise.all([
      readFile(codexHistoryPath, "utf-8"),
      stat(codexHistoryPath),
    ]);
    content = loadedContent;
    fileMode = fileStat.mode;
  } catch {
    return 0;
  }

  let updated = 0;
  const lines = content.split("\n");
  const nextLines = lines.map((line) => {
    if (!line.trim()) {
      return line;
    }
    const parsed = safeJsonParse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return line;
    }
    const record = parsed as Record<string, unknown>;
    const lineSessionId = getJsonRecordValue(record, HISTORY_SESSION_ID_KEYS);
    if (
      lineSessionId !== sessionId ||
      typeof record.text !== "string" ||
      record.text.trim() !== oldText
    ) {
      return line;
    }
    record.text = newText;
    updated += 1;
    return JSON.stringify(record);
  });

  if (updated > 0) {
    await writeFileAtomically(codexHistoryPath, nextLines.join("\n"), fileMode);
    invalidateHistoryCache();
  }
  return updated;
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
  edit?: { editId: string; text: string },
  usage?: TokenUsage,
  modelMetadata?: ConversationModelMetadata,
): ConversationMessage {
  return {
    type: role,
    uuid,
    timestamp,
    message: {
      role,
      content,
      ...(role === "assistant" ? modelMetadata : {}),
      ...(usage ? { usage } : {}),
    },
    ...(edit
      ? {
          editable: true,
          editId: edit.editId,
          editText: edit.text,
        }
      : {}),
  };
}

function createReasoningMessage(
  type: "reasoning" | "agent_reasoning",
  text: string,
  uuid: string,
  timestamp?: string,
  usage?: TokenUsage,
  modelMetadata?: ConversationModelMetadata,
): ConversationMessage {
  return {
    type,
    uuid,
    timestamp,
    message: {
      role: "assistant",
      ...modelMetadata,
      content: [
        {
          type,
          text,
          ...(usage ? { token_usage: usage } : {}),
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

function createThreadGoalMessage(
  goal: CodexThreadGoal,
  uuid: string,
  timestamp?: string,
  turnId?: string,
): ConversationMessage {
  return {
    type: "thread_goal",
    uuid,
    timestamp,
    turnId,
    summary: goalStatusLabel(goal.status),
    threadGoal: goal,
    message: {
      role: "assistant",
      content: goal.objective,
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

function asNullableFiniteNumber(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return parseFiniteNumber(value);
}

function goalStatusLabel(status: CodexThreadGoal["status"]): string {
  if (status === "usageLimited") {
    return "Usage Limited";
  }
  if (status === "budgetLimited") {
    return "Budget Limited";
  }
  return status.slice(0, 1).toUpperCase() + status.slice(1);
}

function parseThreadGoalFromPayload(
  payload: Record<string, unknown>,
): CodexThreadGoal | null {
  const goalValue = payload.goal;
  if (!goalValue || typeof goalValue !== "object" || Array.isArray(goalValue)) {
    return null;
  }

  const goal = goalValue as Record<string, unknown>;
  const threadId = parseOptionalNonEmptyString(goal.threadId ?? goal.thread_id);
  const objective = parseOptionalNonEmptyString(goal.objective);
  const status = parseOptionalNonEmptyString(goal.status);
  const tokensUsed = parseFiniteNumber(goal.tokensUsed ?? goal.tokens_used);
  const timeUsedSeconds = parseFiniteNumber(
    goal.timeUsedSeconds ?? goal.time_used_seconds,
  );
  const createdAt = parseFiniteNumber(goal.createdAt ?? goal.created_at);
  const updatedAt = parseFiniteNumber(goal.updatedAt ?? goal.updated_at);
  if (
    !threadId ||
    !objective ||
    (status !== "active" &&
      status !== "paused" &&
      status !== "blocked" &&
      status !== "usageLimited" &&
      status !== "budgetLimited" &&
      status !== "complete") ||
    tokensUsed === null ||
    timeUsedSeconds === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null;
  }

  const tokenBudget = asNullableFiniteNumber(
    goal.tokenBudget ?? goal.token_budget,
  );
  return {
    threadId,
    objective,
    status,
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    tokensUsed,
    timeUsedSeconds,
    createdAt,
    updatedAt,
  };
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

function normalizeThreadGoalComparableKey(
  message: ConversationMessage,
): string | null {
  if (message.type !== "thread_goal" || !message.threadGoal) {
    return null;
  }
  const goal = message.threadGoal;
  return [
    goal.threadId,
    goal.objective.trim(),
    goal.status,
    goal.tokenBudget ?? "",
    goal.tokensUsed,
    goal.timeUsedSeconds,
  ].join("\u0000");
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

  if (message.type === "thread_goal") {
    const lastMessage = messages[messages.length - 1];
    const lastKey = lastMessage
      ? normalizeThreadGoalComparableKey(lastMessage)
      : null;
    const nextKey = normalizeThreadGoalComparableKey(message);
    if (lastMessage?.type === "thread_goal" && nextKey && nextKey === lastKey) {
      messages[messages.length - 1] = {
        ...lastMessage,
        ...message,
        uuid: message.uuid ?? lastMessage.uuid,
        timestamp: message.timestamp ?? lastMessage.timestamp,
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
  previousModelOutputs: ConversationMessage[] = [],
  onTokenUsageUpdates?: (
    offset: number,
    updates: ConversationMessage[],
  ) => void,
  modelMetadataState?: { metadata: ConversationModelMetadata },
): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  const pendingToolCalls = new Map<string, PendingToolUse>();
  const pendingToolMessageIndexes = new Map<string, number>();
  const toolNames = knownToolNames ?? new Map<string, string>();
  const editableMessagePairs = collectEditableMessagePairs(lines);
  let modelMetadata: ConversationModelMetadata =
    modelMetadataState?.metadata ?? {};

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

    const generatedImage = parseGeneratedImage(
      record.type === "event_msg" &&
        /item_completed|item_started/.test(payloadType)
        ? payload.item
        : payload,
    );
    if (generatedImage) {
      const previous = generatedImage.id
        ? messages.findIndex(
            (m) =>
              Array.isArray(m.message?.content) &&
              m.message.content.some(
                (b) =>
                  b.type === "image_generation" && b.id === generatedImage.id,
              ),
          )
        : -1;
      const message = createChatMessage(
        "assistant",
        [generatedImage],
        `${offset}:image-generation`,
        timestamp,
      );
      if (previous >= 0) {
        const content = messages[previous].message!.content as ContentBlock[];
        message.message!.content = [
          mergeGeneratedImage(
            content.find(
              (b) =>
                b.type === "image_generation" && b.id === generatedImage.id,
            )!,
            generatedImage,
          ),
        ];
        messages[previous] = message;
      } else messages.push(message);
      continue;
    }

    if (record.type === "turn_context") {
      modelMetadata = parseConversationModelMetadata(payload);
      if (modelMetadataState) modelMetadataState.metadata = modelMetadata;
      continue;
    }

    if (record.type === "event_msg") {
      if (payloadType === "thread_goal_updated") {
        const goal = parseThreadGoalFromPayload(payload);
        if (!goal) {
          continue;
        }
        const turnId =
          typeof payload.turn_id === "string" ? payload.turn_id.trim() : "";
        pushConversationMessage(
          messages,
          createThreadGoalMessage(
            goal,
            `${offset}:thread-goal:${messages.length}`,
            timestamp,
            turnId || undefined,
          ),
        );
        continue;
      }

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
        payload.info &&
        typeof payload.info === "object"
      ) {
        const info = payload.info as Record<string, unknown>;
        const usage = parseLastTokenUsage(info.last_token_usage);
        const contextWindow = parseFiniteNumber(info.model_context_window);
        if (usage && contextWindow != null && contextWindow > 0) {
          usage.model_context_window = Math.round(contextWindow);
        }
        if (usage) {
          const combined = [...previousModelOutputs, ...messages];
          attachTokenUsageToModelOutputs(combined, usage);
          const updates: ConversationMessage[] = [];
          for (let index = 0; index < previousModelOutputs.length; index += 1) {
            if (combined[index] !== previousModelOutputs[index]) {
              previousModelOutputs[index] = combined[index];
              updates.push(combined[index]);
            }
          }
          for (let index = 0; index < messages.length; index += 1) {
            messages[index] = combined[previousModelOutputs.length + index];
          }
          if (updates.length) onTokenUsageUpdates?.(offset, updates);
        }
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
          undefined,
          modelMetadata,
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

      const editableRecord = getEditableResponseItem(
        record as Record<string, unknown>,
        offset,
      );

      pushConversationMessage(
        messages,
        createChatMessage(
          role,
          content,
          `${offset}:message:${messages.length}`,
          timestamp,
          editableRecord && editableMessagePairs.has(offset)
            ? {
                editId: editableRecord.editId,
                text: editableRecord.text,
              }
            : undefined,
          parseLastTokenUsage(payload.last_token_usage ?? payload.usage),
          { ...modelMetadata, ...parseConversationModelMetadata(payload) },
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
          parseLastTokenUsage(payload.last_token_usage),
          { ...modelMetadata, ...parseConversationModelMetadata(payload) },
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

async function getFirstUserMessageSnippet(
  filePath: string,
  prefixOnly = false,
): Promise<string> {
  let fileHandle;
  try {
    const stream = prefixOnly
      ? [(await readRolloutPrefix(filePath, 256 * 1024)).toString("utf8")]
      : (fileHandle = await openRollout(filePath, "r")).createReadStream({
          encoding: "utf-8",
        });

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

function toEpochMilliseconds(timestamp: number): number {
  return timestamp > 0 && timestamp < 1e12 ? timestamp * 1000 : timestamp;
}

function getUserMessageTimestampFromLine(line: string): number {
  const parsed = safeJsonParse(line);
  if (!parsed || typeof parsed !== "object") {
    return 0;
  }

  const record = parsed as {
    timestamp?: unknown;
    type?: unknown;
    payload?: Record<string, unknown>;
  };
  if (!record.payload) {
    return 0;
  }

  const isUserMessage =
    (record.type === "event_msg" && record.payload.type === "user_message") ||
    (record.type === "response_item" &&
      record.payload.type === "message" &&
      record.payload.role === "user");
  if (!isUserMessage) {
    return 0;
  }

  return toEpochMilliseconds(parseTimestamp(record.timestamp));
}

async function getLatestUserMessageTimestamp(
  sessionId: string,
  filePath: string,
): Promise<number> {
  const cached = sessionUserMessageTimestampCache.get(sessionId);
  if (cached?.filePath === filePath) {
    return cached.timestamp;
  }

  let fileStat;
  try {
    fileStat = await statRollout(filePath);
  } catch {
    return 0;
  }

  let timestamp = 0;
  let fileHandle;
  try {
    fileHandle = await openRollout(filePath, "r");
    const blockSize = 64 * 1024;
    let position = fileStat.size;
    // Keep byte fragments until a newline is reached. Concatenating and
    // splitting a growing partial string per block makes large tool-output
    // lines quadratic, and can split UTF-8 characters across read boundaries.
    const partialLine: Buffer[] = [];

    while (position > 0 && timestamp === 0) {
      const start = Math.max(0, position - blockSize);
      const buffer = Buffer.alloc(position - start);
      const { bytesRead } = await fileHandle.read(
        buffer,
        0,
        buffer.length,
        start,
      );
      if (bytesRead <= 0) {
        break;
      }

      let lineEnd = bytesRead;
      let index = buffer.lastIndexOf(10, bytesRead - 1);
      while (index >= 0) {
        const fragment = buffer.subarray(index + 1, lineEnd);
        let line: Buffer;
        if (partialLine.length > 0) {
          partialLine.push(fragment);
          line = Buffer.concat(partialLine.reverse());
          partialLine.length = 0;
        } else {
          line = fragment;
        }
        timestamp = getUserMessageTimestampFromLine(line.toString("utf-8"));
        if (timestamp > 0) {
          break;
        }
        lineEnd = index;
        index = index > 0 ? buffer.lastIndexOf(10, index - 1) : -1;
      }
      if (timestamp === 0) {
        partialLine.push(buffer.subarray(0, lineEnd));
        if (start === 0) {
          timestamp = getUserMessageTimestampFromLine(
            Buffer.concat(partialLine.reverse()).toString("utf-8"),
          );
        }
      }

      position = start;
    }
  } catch {
    timestamp = 0;
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }

  sessionUserMessageTimestampCache.set(sessionId, {
    filePath,
    timestamp,
  });
  return timestamp;
}

async function getPrefixUserMessageTimestamp(
  filePath: string,
): Promise<number> {
  try {
    const prefix = await readRolloutPrefix(filePath, 256 * 1024);
    return prefix
      .toString("utf8")
      .split("\n")
      .reduce(
        (latest, line) =>
          Math.max(latest, getUserMessageTimestampFromLine(line)),
        0,
      );
  } catch {
    return 0;
  }
}

export async function loadStorage(): Promise<void> {
  sessionDisplayCache.clear();
  await Promise.all([buildFileIndex(), loadHistoryCache()]);
}

export async function syncSessionFileIndex(
  sessionId: string,
  filePath: string,
): Promise<"updated" | "removed"> {
  const update = updateSessionFileIndex(sessionId, filePath);
  pendingSessionIndexUpdates.add(update);
  try {
    return await update;
  } finally {
    pendingSessionIndexUpdates.delete(update);
  }
}

async function updateSessionFileIndex(
  sessionId: string,
  filePath: string,
): Promise<"updated" | "removed"> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    throw new Error("session id is required");
  }

  const normalizedFilePath = filePath.trim();
  if (normalizedFilePath && (await sessionFileExists(normalizedFilePath))) {
    const currentPath = fileIndex.get(normalizedSessionId);
    if (
      currentPath &&
      plainRolloutPath(currentPath) !== plainRolloutPath(normalizedFilePath)
    ) {
      // A changed ancestor is still owned by the logical thread, but must not
      // replace its selected rollout. Re-read the pointer on a possible revert.
      await buildFileIndex();
      return fileIndex.has(normalizedSessionId) ? "updated" : "removed";
    }
    await addToFileIndex(normalizedSessionId, normalizedFilePath);
    return "updated";
  }

  clearSessionCaches(normalizedSessionId);
  await buildFileIndex();
  const currentPath = fileIndex.get(normalizedSessionId) ?? null;
  if (currentPath && (await sessionFileExists(currentPath))) {
    return "updated";
  }
  return "removed";
}

export async function archiveSession(sessionId: string): Promise<{
  sessionId: string;
  removedHistoryEntries: number;
  removedSessionIndexEntries: number;
}> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    throw new Error("session id is required");
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

  clearSessionCaches(normalizedSessionId);
  invalidateHistoryCache();
  await loadStorage();

  return {
    sessionId: normalizedSessionId,
    removedHistoryEntries,
    removedSessionIndexEntries,
  };
}

export async function getSessions(): Promise<Session[]> {
  return dedupe("getSessions", async () => {
    // Watcher listeners fan out without awaiting one another. Wait for the
    // shared index update before a stream subscriber reads the cached list.
    while (pendingSessionIndexUpdates.size > 0) {
      await Promise.allSettled([...pendingSessionIndexUpdates]);
    }
    if (sessionsCache) return [...sessionsCache];
    const version = sessionsVersion;
    const history = historyCache ?? (await loadHistoryCache());

    // History can retain sessions whose rollout files were removed. Refresh
    // discovery once for the whole listing, rather than rebuilding the index
    // for every missing entry (including on each browser refresh).
    if (
      [...history.keys(), ...sessionMetaIndex.keys()].some(
        (sessionId) => !fileIndex.has(sessionId),
      )
    ) {
      // This listing owns the new snapshot; keep its version so intervening
      // watcher events can still prevent caching a stale result.
      await buildFileIndex(false);
    }

    const sessionIds = [
      ...new Set<string>([
        ...fileIndex.keys(),
        ...history.keys(),
        ...sessionMetaIndex.keys(),
      ]),
    ];

    const readSession = async (sessionId: string): Promise<Session | null> => {
      const filePath = fileIndex.get(sessionId) ?? null;
      // Like native thread/list, summaries must not hydrate transcript history.
      // Resolve representation changes before trusting an immutable summary.
      const source = filePath
        ? await resolveRolloutSource(filePath).catch(() => null)
        : null;
      const compressed = source?.endsWith(".zst") ?? false;
      const summary =
        compressed && filePath
          ? sessionSummaryIndex.get(plainRolloutPath(filePath))
          : undefined;

      let meta: SessionMeta | null = sessionMetaIndex.get(sessionId) ?? null;
      if (!meta && filePath) {
        meta = await readSessionMetaFromFile(filePath);
        if (meta) {
          sessionMetaIndex.set(sessionId, meta);
        }
      }

      if (meta?.archivedAt) {
        return null;
      }

      const historyEntry = history.get(sessionId);
      const historyUserMessageTimestamp = historyEntry
        ? toEpochMilliseconds(historyEntry.timestamp)
        : 0;
      const fileUserMessageTimestamp =
        summary?.recencyAt ??
        (filePath
          ? compressed
            ? await getPrefixUserMessageTimestamp(filePath)
            : await getLatestUserMessageTimestamp(sessionId, filePath)
          : 0);
      const latestUserMessageTimestamp = Math.max(
        historyUserMessageTimestamp,
        fileUserMessageTimestamp,
      );

      let createdAt = meta?.timestamp ?? 0;
      if (createdAt <= 0 && filePath) {
        try {
          const fileStat = await statRolloutSource(filePath);
          createdAt = fileStat.birthtimeMs || fileStat.mtimeMs;
        } catch {
          createdAt = 0;
        }
      }
      if (createdAt <= 0 && historyEntry) {
        createdAt = toEpochMilliseconds(historyEntry.timestamp);
      }

      const lastUserMessageAt = latestUserMessageTimestamp || createdAt;

      let display = "";
      const cachedDisplay = sessionDisplayCache.get(sessionId);
      if (cachedDisplay) {
        display = cachedDisplay;
      } else if (summary?.display) {
        display = normalizeDisplayText(summary.display);
        sessionDisplayCache.set(sessionId, display);
      } else if (filePath) {
        display = await getFirstUserMessageSnippet(filePath, compressed);
        if (display === "(no prompt text)" && historyEntry)
          display = normalizeDisplayText(historyEntry.text);
        sessionDisplayCache.set(sessionId, display);
      } else if (historyEntry) {
        display = normalizeDisplayText(historyEntry.text);
      } else {
        display = "(no prompt text)";
      }

      const project = meta?.cwd ?? "";
      const origin = meta?.origin;

      return {
        id: sessionId,
        display,
        createdAt,
        lastUserMessageAt,
        timestamp: lastUserMessageAt,
        project,
        projectName: getProjectName(project),
        ...(origin ? { origin } : {}),
      };
    };

    const sessions = new Array<Session | null>(sessionIds.length);
    let nextIndex = 0;
    // Bound open files while allowing independent session reads to overlap.
    await Promise.all(
      Array.from({ length: Math.min(8, sessionIds.length) }, async () => {
        while (nextIndex < sessionIds.length) {
          const index = nextIndex++;
          sessions[index] = await readSession(sessionIds[index]);
        }
      }),
    );
    const result = sessions
      .filter((session) => session !== null)
      .sort(
        (a, b) =>
          (b.lastUserMessageAt ?? b.timestamp) -
          (a.lastUserMessageAt ?? a.timestamp),
      );
    // A watcher event during an async read must invalidate this snapshot too.
    if (version === sessionsVersion) sessionsCache = result;
    return result;
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
  options: DeleteSessionOptions = {},
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

    if (options.deleteDiffGuide !== false) {
      const { DiffGuideStore } = await import("../diff-guide-store");
      await new DiffGuideStore(codexDir).remove(normalizedSessionId);
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

export async function editConversationMessage(
  sessionId: string,
  request: EditConversationMessageRequest,
): Promise<EditConversationMessageResponse> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    throw new Error("session id is required");
  }
  const editId = request.editId.trim();
  const expectedText = request.expectedText.trim();
  const text = request.text.trim();
  if (!editId) {
    throw new Error("edit id is required");
  }
  if (!expectedText) {
    throw new Error("expected message text is required");
  }
  if (!text) {
    throw new Error("message text is required");
  }
  if (text.length > 2_000_000) {
    throw new Error("message text is too large");
  }

  return serializeSessionEdit(normalizedSessionId, async () => {
    const waitState = await getSessionWaitState(normalizedSessionId);
    if (waitState.isWaiting) {
      throw new Error("messages cannot be edited while a turn is active");
    }

    const sourcePath = await findSessionFile(normalizedSessionId);
    const filePath = sourcePath
      ? await materializeRolloutForWrite(sourcePath)
      : null;
    if (!filePath) {
      throw new Error(`session file not found: ${normalizedSessionId}`);
    }

    const [content, fileStat] = await Promise.all([
      readRolloutText(filePath, "utf-8"),
      statRollout(filePath),
    ]);
    const rawLines = content.split("\n");
    const lines: Array<{ line: string; offset: number }> = [];
    let offset = 0;
    for (let index = 0; index < rawLines.length; index += 1) {
      const line = rawLines[index];
      lines.push({ line, offset });
      offset += Buffer.byteLength(line, "utf-8");
      if (index < rawLines.length - 1) {
        offset += 1;
      }
    }

    const editableMessagePairs = collectEditableMessagePairs(lines);
    let firstEditableUserIndex: number | null = null;
    let target:
      | {
          index: number;
          record: Record<string, unknown>;
          role: "user" | "assistant";
          text: string;
          eventOffset: number;
        }
      | undefined;

    for (let index = 0; index < lines.length; index += 1) {
      const parsed = safeJsonParse(lines[index].line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      const record = parsed as Record<string, unknown>;
      const editable = getEditableResponseItem(record, lines[index].offset);
      if (!editable) {
        continue;
      }
      const eventOffset = editableMessagePairs.get(lines[index].offset);
      if (eventOffset === undefined) {
        continue;
      }
      if (editable.role === "user" && firstEditableUserIndex === null) {
        firstEditableUserIndex = index;
      }
      if (editable.editId !== editId) {
        continue;
      }
      if (target) {
        throw new Error("edit id matched more than one message");
      }
      target = {
        index,
        record,
        role: editable.role,
        text: editable.text,
        eventOffset,
      };
    }

    if (!target) {
      throw new Error("editable message was not found");
    }
    if (target.text !== expectedText) {
      throw new Error("message changed before the edit was saved");
    }
    if (target.text === text) {
      return {
        sessionId: normalizedSessionId,
        editId,
        role: target.role,
        text,
        sessionRecordsUpdated: 0,
        historyRecordsUpdated: 0,
        sqlite: {
          dbPath: null,
          threadsUpdated: 0,
          skippedReason: "message text is unchanged",
          warnings: [],
          threadHistory: emptyThreadHistoryInvalidationResult(
            null,
            "message text is unchanged",
          ),
        },
      };
    }

    const targetPayload = target.record.payload;
    if (
      !targetPayload ||
      typeof targetPayload !== "object" ||
      Array.isArray(targetPayload)
    ) {
      throw new Error("editable message payload is invalid");
    }
    replaceResponseItemText(targetPayload as Record<string, unknown>, text);
    rawLines[target.index] = JSON.stringify(target.record);
    let sessionRecordsUpdated = 1;

    const eventIndex = lines.findIndex(
      (line) => line.offset === target.eventOffset,
    );
    if (eventIndex >= 0) {
      const parsed = safeJsonParse(lines[eventIndex].line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (replaceEditableEventMessageText(record, text)) {
          rawLines[eventIndex] = JSON.stringify(record);
          sessionRecordsUpdated += 1;
        }
      }
    }

    if (sessionRecordsUpdated < 2) {
      throw new Error("paired message history records were not found");
    }

    const currentContent = await readRolloutText(filePath, "utf-8");
    if (currentContent !== content) {
      throw new Error("session file changed before the edit was saved");
    }
    await writeFileAtomically(filePath, rawLines.join("\n"), fileStat.mode);
    const threadHistory =
      await invalidateEditedThreadHistoryProjection(normalizedSessionId);

    const updatesUserMetadata =
      target.role === "user" && target.index === firstEditableUserIndex;
    const historyRecordsUpdated = updatesUserMetadata
      ? await updateHistoryMessageRecords(
          normalizedSessionId,
          target.text,
          text,
        )
      : 0;
    const threadMetadata = await updateEditedMessageInSqlite(
      normalizedSessionId,
      target.role,
      target.text,
      text,
      updatesUserMetadata,
    );
    const sqlite: EditConversationMessageSqliteResult = {
      ...threadMetadata,
      threadHistory,
    };

    clearSessionCaches(normalizedSessionId);
    await buildFileIndex();

    return {
      sessionId: normalizedSessionId,
      editId,
      role: target.role,
      text,
      sessionRecordsUpdated,
      historyRecordsUpdated,
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
      const messages = await readConversationMessageSnapshot(
        filePath,
        findHistoryRollout,
      );
      rememberStreamModelOutputs(sessionId, messages);
      return messages;
    } catch (err) {
      console.error("Error reading conversation:", err);
      return [];
    }
  });
}

export async function ingestConversationLiveEvent(
  event: CodexAppServerEvent,
): Promise<void> {
  if (
    event.type === "operational_notification" ||
    event.type === "hook_run" ||
    event.type === "background_terminals_changed"
  )
    return;
  const filePath = await findSessionFile(event.threadId);
  if (filePath)
    await applyConversationLiveEvent(filePath, event, findHistoryRollout);
}

export async function getConversationMessageWindow(
  sessionId: string,
  beforeSequence?: number,
): Promise<ConversationMessageWindow> {
  const filePath = await findSessionFile(sessionId);
  return filePath
    ? readConversationMessageWindow(
        filePath,
        beforeSequence,
        findHistoryRollout,
      )
    : {
        messages: [],
        historyStartSequence: 0,
        nextOffset: 0,
        done: true,
        totalMessages: 0,
      };
}

export async function getConversationMessageUpdates(
  sessionId: string,
  fromOffset = 0,
  maxPayloadBytes?: number,
): Promise<StreamResult> {
  const filePath = await findSessionFile(sessionId);
  return filePath
    ? readConversationMessageUpdates(
        filePath,
        fromOffset,
        maxPayloadBytes,
        findHistoryRollout,
      )
    : { messages: [], nextOffset: 0, done: true, totalMessages: 0 };
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
    const fileStat = await statRollout(filePath);
    const fileSize = fileStat.size;
    const fileId = `${fileStat.dev}:${fileStat.ino}`;
    const normalizedMaxBytes =
      Number.isFinite(maxBytes) && maxBytes > 0
        ? Math.floor(maxBytes)
        : 512 * 1024;

    if (fromOffset >= fileSize) {
      return {
        chunkBase64: "",
        nextOffset: fromOffset,
        done: true,
        fileId,
      };
    }

    const byteCount = Math.min(normalizedMaxBytes, fileSize - fromOffset);
    const buffer = Buffer.allocUnsafe(byteCount);

    fileHandle = await openRollout(filePath, "r");
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
      fileId,
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
    const fileStat = await statRollout(filePath);
    const fileSize = fileStat.size;
    const fileId = `${fileStat.dev}:${fileStat.ino}`;
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
        fileId,
      };
    }

    let start = Math.max(0, normalizedBefore - normalizedMaxBytes);
    fileHandle = await openRollout(filePath, "r");
    // Align backwards to the start of a complete JSONL record. A tool result
    // can be larger than the requested window, including multibyte UTF-8.
    let searchEnd = start;
    while (searchEnd > 0) {
      const searchStart = Math.max(0, searchEnd - 64 * 1024);
      const prefix = Buffer.allocUnsafe(searchEnd - searchStart);
      const { bytesRead } = await fileHandle.read(
        prefix,
        0,
        prefix.length,
        searchStart,
      );
      const newline = prefix.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (newline >= 0) {
        start = searchStart + newline + 1;
        break;
      }
      start = searchStart;
      searchEnd = searchStart;
    }
    const byteCount = normalizedBefore - start;
    if (byteCount <= 0) {
      return {
        chunkBase64: "",
        startOffset: normalizedBefore,
        endOffset: normalizedBefore,
        fileSize,
        done: normalizedBefore <= 0,
        fileId,
      };
    }

    const buffer = Buffer.allocUnsafe(byteCount);
    const { bytesRead } = await fileHandle.read(buffer, 0, byteCount, start);
    const sliceStart = 0;
    let sliceEnd = bytesRead;

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

    if (beforeOffset === undefined) {
      // Seed incremental SSE state from the recent window, without reading
      // the entire session just to recover tool names or model token usage.
      const parserState = new ConversationParserState();
      for (const [callId, name] of sessionToolNameIndex.get(sessionId) ?? []) {
        parserState.toolNames.set(callId, name);
      }
      const parsed = parseConversationTextChunk(
        buffer.subarray(sliceStart, sliceEnd).toString("utf-8"),
        startOffset,
        sessionToolNameIndex.get(sessionId),
        parserState,
      );
      sessionStreamModelMetadata.set(sessionId, parserState.modelMetadata);
      sessionToolNameIndex.set(sessionId, parsed.toolNames);
      rememberStreamModelOutputs(sessionId, parsed.messages);
    }

    return {
      chunkBase64: buffer.subarray(sliceStart, sliceEnd).toString("base64"),
      startOffset: normalizedStartOffset,
      endOffset,
      fileSize,
      done: normalizedStartOffset <= 0,
      fileId,
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

    const sourcePath = await findSessionFile(normalizedSessionId);
    const filePath = sourcePath
      ? await materializeRolloutForWrite(sourcePath)
      : null;
    if (!filePath) {
      throw new Error(`session file not found: ${normalizedSessionId}`);
    }

    const content = await readRolloutText(filePath, "utf-8");
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
      const fileStat = await statRollout(filePath);
      if (
        cached &&
        cached.filePath === filePath &&
        cached.mtimeMs === fileStat.mtimeMs &&
        cached.size === fileStat.size
      ) {
        return cached.result;
      }

      const content = await readRolloutText(filePath, "utf-8");
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
      const fileStat = await statRollout(filePath);
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
      const content = await readRolloutText(filePath, "utf-8");
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
    const fileStat = await statRollout(filePath);
    const fileSize = fileStat.size;
    const fileId = `${fileStat.dev}:${fileStat.ino}`;
    const previousFileId = sessionStreamFileIds.get(sessionId);
    if (previousFileId && previousFileId !== fileId) {
      sessionStreamPendingModelOutputs.delete(sessionId);
      sessionStreamModelMetadata.delete(sessionId);
      sessionStreamTokenUsageUpdates.delete(sessionId);
    }
    sessionStreamFileIds.set(sessionId, fileId);
    const hasPayloadLimit =
      Number.isFinite(options.maxPayloadBytes) &&
      typeof options.maxPayloadBytes === "number" &&
      options.maxPayloadBytes > 0;
    const maxPayloadBytes = hasPayloadLimit
      ? Math.floor(options.maxPayloadBytes as number)
      : null;

    if (fromOffset >= fileSize) {
      return { messages: [], nextOffset: fromOffset, done: true, fileId };
    }

    if (
      fromOffset > 0 &&
      !sessionToolNameIndex.has(sessionId) &&
      !options.skipToolNameBootstrap
    ) {
      await getConversation(sessionId);
    }

    fileHandle = await openRollout(filePath, "r");
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
    let nextPayloadProbeLineCount = 1;

    // Probe geometrically rather than reparsing every growing prefix. If a
    // probe exceeds the budget, choose a smaller prefix without splitting
    // the paired event/response records needed for message editing.
    const fitPayload = (candidateEndOffset: number): boolean => {
      if (maxPayloadBytes === null) {
        return true;
      }
      const payloadFits = (
        prefixLength: number,
        endOffset: number,
      ): boolean => {
        const candidateMessages = parseCodexConversation(
          parsedLines.slice(0, prefixLength),
          new Map(existingToolNames),
        );
        return (
          Buffer.byteLength(
            JSON.stringify({
              messages: candidateMessages,
              nextOffset: Math.min(endOffset, fileSize),
              done: endOffset >= fileSize,
            }),
            "utf-8",
          ) <= maxPayloadBytes
        );
      };

      if (
        payloadFits(parsedLines.length, candidateEndOffset) ||
        parsedLines.length === 1
      ) {
        nextPayloadProbeLineCount = parsedLines.length * 2;
        return true;
      }

      const pairs = collectEditableMessagePairs(parsedLines);
      const indexesByOffset = new Map(
        parsedLines.map((entry, index) => [entry.offset, index]),
      );
      const boundaryChanges = new Int32Array(parsedLines.length + 1);
      for (const [responseOffset, eventOffset] of pairs) {
        const responseIndex = indexesByOffset.get(responseOffset)!;
        const eventIndex = indexesByOffset.get(eventOffset)!;
        boundaryChanges[Math.min(responseIndex, eventIndex) + 1] += 1;
        boundaryChanges[Math.max(responseIndex, eventIndex) + 1] -= 1;
      }
      const safePrefixLengths: number[] = [];
      let openPairs = 0;
      for (let index = 1; index <= parsedLines.length; index += 1) {
        openPairs += boundaryChanges[index];
        if (openPairs === 0) {
          safePrefixLengths.push(index);
        }
      }

      let bestIndex = 0;
      let low = 0;
      let high = safePrefixLengths.length - 2;
      while (low <= high) {
        const index = Math.floor((low + high) / 2);
        const prefixLength = safePrefixLengths[index];
        if (payloadFits(prefixLength, parsedLines[prefixLength].offset)) {
          bestIndex = index;
          low = index + 1;
        } else {
          high = index - 1;
        }
      }
      // One indivisible record/pair may exceed the budget. Always make
      // progress, as with a single oversized JSONL record.
      const prefixLength = safePrefixLengths[bestIndex];
      if (prefixLength < parsedLines.length) {
        candidateEndOffset = parsedLines[prefixLength].offset;
        parsedLines.length = prefixLength;
      }
      bytesConsumed = candidateEndOffset - fromOffset;
      return false;
    };

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

        if (parsedLines.length >= nextPayloadProbeLineCount) {
          shouldIncludeLine = fitPayload(lineOffset + lineBytes);
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

    // EOF or malformed trailing input can arrive between geometric probes.
    if (parsedLines.length > 0) {
      fitPayload(fromOffset + bytesConsumed);
    }

    const actualOffset = fromOffset + bytesConsumed;
    const nextOffset = actualOffset > fileSize ? fileSize : actualOffset;
    const done = nextOffset >= fileSize;
    const toolNames = existingToolNames;
    const previousModelOutputs =
      fromOffset === 0
        ? []
        : (sessionStreamPendingModelOutputs.get(sessionId) ?? []).filter(
            (message) => Number(message.uuid?.split(":", 1)[0]) < fromOffset,
          );
    const originals = new Set(previousModelOutputs);
    const replay = sessionStreamTokenUsageUpdates.get(sessionId) ?? new Map();
    const modelMetadataState = {
      metadata:
        fromOffset === 0
          ? {}
          : (sessionStreamModelMetadata.get(sessionId) ?? {}),
    };
    const messages = parseCodexConversation(
      parsedLines,
      toolNames,
      previousModelOutputs,
      (offset, updates) => {
        replay.set(offset, updates);
        // Keep this legacy replay bounded; numbered updates retain revisions.
        if (replay.size > 32) replay.delete(replay.keys().next().value!);
      },
      modelMetadataState,
    );
    sessionStreamModelMetadata.set(sessionId, modelMetadataState.metadata);
    rememberStreamModelOutputs(sessionId, [
      ...previousModelOutputs,
      ...messages,
    ]);
    const updates = previousModelOutputs.filter(
      (message) => !originals.has(message),
    );
    for (const { offset } of parsedLines) {
      updates.push(...(replay.get(offset) ?? []));
    }
    const messageIds = new Set(messages.map((message) => message.uuid));
    for (const update of updates) {
      if (!messageIds.has(update.uuid)) {
        messages.push(update);
        messageIds.add(update.uuid);
      }
    }
    sessionStreamTokenUsageUpdates.set(sessionId, replay);
    sessionToolNameIndex.set(sessionId, toolNames);

    return {
      messages,
      nextOffset,
      done,
      fileId,
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
      const content = await readRolloutText(filePath, "utf-8");
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
        const content = await readRolloutText(filePath, "utf-8");
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

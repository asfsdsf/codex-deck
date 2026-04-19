import {
  memo,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type ChangeEvent as ReactChangeEvent,
  type FormEvent as ReactFormEvent,
  type PointerEvent as ReactPointerEvent,
  type DragEvent as ReactDragEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type RefObject,
} from "react";
import type {
  CodexCollaborationModeOption,
  CodexConfigDefaultsResponse,
  CodexModelOption,
  CodexReasoningEffort,
  CodexSkillMetadata,
  CodexThreadSummary,
  ConversationMessage,
  Session,
  SessionDiffMode,
  SessionDiffResponse,
  SessionFileContentResponse,
  SessionFileTreeNodesResponse,
  SessionSkillsResponse,
  SessionTerminalRunSummary,
  TerminalSessionRoleSummary,
  TerminalSummary,
  WorkflowDaemonStatusResponse,
  WorkflowDetailResponse,
  WorkflowLogResponse,
  WorkflowSessionLookupResponse,
  WorkflowSessionRole,
  WorkflowSummary,
  WorkflowTaskSummary,
} from "@codex-deck/api";
import {
  Copy,
  Check,
  GripVertical,
  Circle,
  CircleDot,
  Search,
  ImagePlus,
  Camera,
  Images,
  X,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Moon,
  Sun,
} from "lucide-react";
import { formatTime, reconcilePendingTurnWithThreadState } from "../utils";
import SessionList from "../components/session-list";
import SessionView, {
  getConversationActivityDetails,
  type SessionSearchStatus,
  type SessionViewHandle,
} from "../components/session-view";
import LatestSessionMessageBox from "../components/latest-session-message-box";
import TerminalView from "../components/terminal-view";
import WorkflowView from "../components/workflow-view";
import DiffPane, { type RightPaneMode } from "../components/diff-pane";
import ProjectSelector from "../components/project-selector";
import ComposerPicker, {
  type ComposerPickerItem,
} from "../components/composer-picker";
import {
  EMPTY_NEW_SESSION_CWD_STATE,
  clearNewSessionCwdForProjectSelection,
  maybeAutoFillNewSessionCwd,
  type NewSessionCwdState,
  setNewSessionCwdFromUserInput,
} from "../new-session-cwd-state";
import SlashCommandPalette from "../components/slash-command-palette";
import SkillSelectorPalette from "../components/skill-selector-palette";
import { usePageVisibility } from "../hooks/use-page-visibility";
import {
  getPathBaseName,
  resolveProjectFileLinkTargetFromHref,
} from "../path-utils";
import { getStableSessionIds } from "../session-ids";
import {
  buildStrictTaskCreateApprovalMessage,
  getStrictTaskCreateDirectiveFromMessages,
  getLatestWorkflowCreatePreviewMessage,
  resolveStrictTaskCreateDraft,
  resolveWorkflowChatSessionPlan,
  type StrictTaskCreateImportedDraft,
} from "../workflow-chat-session";
import { areWorkflowCollectionsVisiblyEquivalent } from "../workflow-list";
import {
  buildEmptyWorkflowCreateRequest,
  isValidWorkflowIdForPrompt,
} from "../workflow-create";
import {
  buildWorkflowSkillInstallMessagePrefix,
  getWorkflowSkillAvailability,
  type WorkflowSkillInstallChoice,
} from "../workflow-skill-install";
import {
  type TerminalSkillInstallChoice,
} from "../api/terminal-skill-install";
import { sendTerminalRestartNoticeToBoundSession } from "../terminal-session-notices";
import {
  resolveSelectedWorkflowSummary,
  resolveWorkflowSelection,
} from "../workflow-selection";
import {
  resolvePaneSlashCommandNavigation,
  resolveRightPaneTarget,
  type CenterViewMode,
  type RightPaneTarget,
} from "../right-pane-routing";
import { findActiveFileMentionToken } from "../file-mentions";
import {
  findActiveSkillSelectorToken,
  getSkillSelectorSuggestions,
  type SkillSelectorOption,
} from "../skill-selector";
import {
  getWorkflowComposerSlashCommands,
  getSlashPaletteCommands,
  parseSlashCommandInvocation,
  parseSlashCommandQuery,
  SESSION_COMPOSER_SLASH_COMMANDS,
  type SlashCommandDefinition,
} from "../slash-commands";
import {
  createRemoteAdminSetupToken,
  createCodexThread,
  deleteWorkflow as deleteWorkflowRequest,
  deleteSession as deleteSessionRequest,
  deleteTerminal as deleteTerminalRequest,
  deleteRemoteAdminSetupToken,
  disconnectRemoteTransport,
  fixDanglingSession,
  getRemoteMachines,
  isRemoteLatencyLoggingEnabled,
  hasSavedRemoteAccount,
  isRemoteAccountAuthenticated,
  getSelectedRemoteMachineId,
  getSessionContext,
  getSessionExists,
  getCodexThreadState,
  getWorkflowSessionRoles as getWorkflowSessionRolesRequest,
  interruptCodexThread,
  isRemoteTransportEnabled,
  listCodexCollaborationModes,
  listCodexModels,
  listRemoteAdminSetupTokens,
  listProjects,
  getWorkflowBySession as getWorkflowBySessionRequest,
  getWorkflowLog as getWorkflowLogRequest,
  getWorkflowDetail as getWorkflowDetailRequest,
  listWorkflows as listWorkflowsRequest,
  createWorkflow as createWorkflowRequest,
  launchWorkflowTask as launchWorkflowTaskRequest,
  bindWorkflowSession as bindWorkflowSessionRequest,
  sendWorkflowControlMessage as sendWorkflowControlMessageRequest,
  startWorkflowDaemon as startWorkflowDaemonRequest,
  stopWorkflowProcesses as stopWorkflowProcessesRequest,
  stopWorkflowDaemon as stopWorkflowDaemonRequest,
  listActiveTerminals,
  createTerminal,
  loginRemoteWithCredentials,
  loginRemoteAdmin,
  logoutRemoteAdmin,
  type RemoteAdminSetupToken,
  refreshRemoteMachines,
  regenerateRemoteAdminSetupToken,
  restoreSavedRemoteAccount,
  rotateRemoteAdminPassword,
  sendCodexMessage,
  sendTerminalChatAction as sendTerminalChatActionRequest,
  setSelectedRemoteMachineId,
  setRemoteLatencyLoggingEnabled,
  notifyWorkflowMutation,
  subscribeConversationStream,
  subscribeRemoteTransport,
  subscribeSessionsStream,
  subscribeTerminalsStream,
  subscribeWorkflowDaemonStatusStream,
  subscribeWorkflowDetailStream,
  subscribeWorkflowsStream,
  type RemoteMachineDescription,
  type RemoteServerTrustPins,
  updateRemoteAdminSetupToken,
  getConversation,
  getCodexConfigDefaults,
  getSessionFileContent,
  getWorkflowProjectFileContent,
  searchSessionFiles,
  getSessionFileTreeNodes,
  getWorkflowProjectFileTreeNodes,
  getSessionDiff,
  getWorkflowProjectDiff,
  getSessionTerminalRuns,
  getSessionTerminalRunOutput,
  getSessionSkills,
  getWorkflowProjectSkills,
  setSessionSkillEnabled,
  setWorkflowProjectSkillEnabled,
  cleanSessionBackgroundTerminalRuns,
  claimTerminalWrite as claimTerminalWriteRequest,
  persistTerminalMessageAction as persistTerminalMessageActionRequest,
  releaseTerminalWrite as releaseTerminalWriteRequest,
  sendTerminalInput as sendTerminalInputRequest,
  setCodexThreadName,
  forkCodexThread,
  compactCodexThread,
  listCodexAgentThreads,
  getCodexThreadSummaries,
  getTerminalSessionRoles as getTerminalSessionRolesRequest,
} from "../api";
import {
  buildAiTerminalRejectionFeedback,
  deriveAiTerminalStepStatesByMessageKey,
  extractConversationMessageText,
  getAiTerminalMessageKey,
  parseAiTerminalMessage,
  type AiTerminalStepDirective,
  type AiTerminalStepState,
} from "../ai-terminal";
import {
  getCollaborationModeRequestValue,
  getEffectiveModelId,
  getEffectiveReasoningEffort,
  getEffortControlLabel,
  getModelControlLabel,
  getModelDisplayName,
} from "../session-config-utils";
import {
  appendPendingUserMessage,
  consumeConfirmedPendingUserMessages,
  removePendingUserMessage,
  updatePendingUserMessageStatus,
  type PendingUserMessage,
} from "../pending-user-messages";
import { mergeDisplayConversationMessages } from "../conversation-message-merge";
import { runApprovedAiTerminalStepInTerminal } from "../ai-terminal-runtime";
import {
  applyResolvedTheme,
  getNextThemePreference,
  getSystemPrefersDark,
  persistThemePreference,
  readStoredThemePreference,
  resolveThemePreference,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemePreference,
} from "../theme";

interface SessionHeaderProps {
  session: Session;
  copied: boolean;
  isMobilePhone: boolean;
  railCollapsedByDefault: boolean;
  conversationSearchOpen: boolean;
  resolvedTheme: ResolvedTheme;
  onCopySessionId: (sessionId: string) => void;
  onCopyProjectPath: (projectPath: string) => void;
  onToggleConversationSearch: () => void;
  onToggleRailCollapsedByDefault: () => void;
  onToggleTheme: () => void;
}

interface ThemeToggleButtonProps {
  resolvedTheme: ResolvedTheme;
  onToggleTheme: () => void;
}

interface SessionSearchBarProps {
  query: string;
  status: SessionSearchStatus;
  inputRef: RefObject<HTMLInputElement | null>;
  onChangeQuery: (value: string) => void;
  onClose: () => void;
  onNavigate: (direction: "previous" | "next") => void;
}

function ThemeToggleButton(props: ThemeToggleButtonProps) {
  const { resolvedTheme, onToggleTheme } = props;
  const switchingTo = resolvedTheme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      onClick={onToggleTheme}
      className="group relative h-8 w-8 shrink-0 rounded border border-zinc-700 bg-zinc-900/70 text-zinc-300 transition-colors hover:bg-zinc-800/80"
      title={`Switch to ${switchingTo} theme`}
      aria-label={`Switch to ${switchingTo} theme`}
    >
      <span className="relative mx-auto block h-4 w-4">
        <Sun
          className={`absolute inset-0 h-4 w-4 transition-all duration-200 ${
            resolvedTheme === "dark"
              ? "scale-100 rotate-0 opacity-100"
              : "scale-75 -rotate-90 opacity-0"
          }`}
        />
        <Moon
          className={`absolute inset-0 h-4 w-4 transition-all duration-200 ${
            resolvedTheme === "light"
              ? "scale-100 rotate-0 opacity-100"
              : "scale-75 rotate-90 opacity-0"
          }`}
        />
      </span>
    </button>
  );
}

function SessionSearchBar(props: SessionSearchBarProps) {
  const { query, status, inputRef, onChangeQuery, onClose, onNavigate } = props;
  const hasMatches = status.totalMatches > 0;
  const hasQuery = query.trim().length > 0;
  const activeLabel =
    hasMatches && status.activeMatchIndex !== null
      ? `${status.activeMatchIndex + 1}/${status.totalMatches}`
      : hasQuery
        ? `0/${status.totalMatches}`
        : "0/0";

  return (
    <div className="rounded-xl border border-zinc-700/60 bg-zinc-950/45 px-3 py-2 shadow-lg shadow-black/20 backdrop-blur-md">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-zinc-700/60 bg-zinc-900/20 px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-zinc-400" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => onChangeQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onNavigate(event.shiftKey ? "previous" : "next");
                return;
              }

              if (event.key === "Escape") {
                event.preventDefault();
                inputRef.current?.blur();
                onClose();
              }
            }}
            placeholder="Search this conversation view"
            className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
            aria-label="Search conversation"
          />
          <span className="shrink-0 text-[11px] font-mono text-zinc-400">
            {activeLabel}
          </span>
        </div>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => onNavigate("previous")}
            disabled={!hasMatches}
            className="h-9 w-9 shrink-0 rounded-lg border border-zinc-700/60 bg-zinc-900/30 text-zinc-300 transition-colors hover:bg-zinc-800/55 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Previous search result"
            title="Previous search result"
          >
            <ChevronUp className="mx-auto h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => onNavigate("next")}
            disabled={!hasMatches}
            className="h-9 w-9 shrink-0 rounded-lg border border-zinc-700/60 bg-zinc-900/30 text-zinc-300 transition-colors hover:bg-zinc-800/55 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Next search result"
            title="Next search result"
          >
            <ChevronDown className="mx-auto h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="h-9 w-9 shrink-0 rounded-lg border border-zinc-700/60 bg-zinc-900/30 text-zinc-300 transition-colors hover:bg-zinc-800/55"
            aria-label="Close search"
            title="Close search"
          >
            <X className="mx-auto h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function getWorkflowSessionRoleLabel(
  role: WorkflowSessionRole | null | undefined,
): string | null {
  if (role === "scheduler") {
    return "scheduler";
  }
  if (role === "task") {
    return "flow task";
  }
  if (role === "bound") {
    return "flow chat";
  }
  return null;
}

function getTerminalSessionRoleLabel(
  role: TerminalSessionRoleSummary | null | undefined,
): string | null {
  if (role?.role === "terminal") {
    return "terminal chat";
  }
  return null;
}

function formatWorkflowStopHint(output: string | null | undefined): string {
  const text = output?.trim() ?? "";
  const match = /\bStopped\s+(\d+)\s+process(?:es)?\b/i.exec(text);
  if (match) {
    const count = Number.parseInt(match[1] ?? "", 10);
    if (Number.isFinite(count)) {
      return count === 1
        ? "Stopped 1 daemon process for this workflow."
        : `Stopped ${count} daemon processes for this workflow.`;
    }
  }
  return text || "Stop request sent.";
}

const REASONING_EFFORTS: CodexReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

const DEFAULT_OPTION_VALUE = "__default__";
const FIX_DANGLING_WAIT_THRESHOLD_MS = 8_000;
const WAIT_STATE_SETTLE_DELAY_MS = 750;
const MESSAGE_BOX_MIN_HEIGHT = 36;
const MESSAGE_BOX_MAX_HEIGHT = 360;
const MESSAGE_BOX_DEFAULT_HEIGHT = 48;
const LEFT_PANE_MIN_WIDTH = 120;
const LEFT_PANE_MAX_WIDTH = 1200;
const LEFT_PANE_DEFAULT_WIDTH = 320;
const RIGHT_PANE_MIN_WIDTH = 120;
const RIGHT_PANE_MAX_WIDTH = 1400;
const RIGHT_PANE_DEFAULT_WIDTH = 520;
const RIGHT_PANE_COLLAPSED_WIDTH = 40;
const MOBILE_RIGHT_PANE_DEFAULT_RATIO = 0.9;
const MOBILE_RIGHT_PANE_MIN_OPEN_WIDTH = 280;
const PLAN_IMPLEMENTATION_MESSAGE = "Implement the plan.";
const INIT_AGENTS_PROMPT = `Generate a file named AGENTS.md that serves as a contributor guide for this repository.
Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section.
Follow the outline below, but adapt as needed - add sections if relevant, and omit those that do not apply to this project.

Document Requirements

- Title the document "Repository Guidelines".
- Use Markdown headings (#, ##, etc.) for structure.
- Keep the document concise. 200-400 words is optimal.
- Keep explanations short, direct, and specific to this repository.
- Provide examples where helpful (commands, directory paths, naming patterns).
- Maintain a professional, instructional tone.

Recommended Sections

Project Structure & Module Organization

- Outline the project structure, including where the source code, tests, and assets are located.

Build, Test, and Development Commands

- List key commands for building, testing, and running locally (e.g., npm test, make build).
- Briefly explain what each command does.

Coding Style & Naming Conventions

- Specify indentation rules, language-specific style preferences, and naming patterns.
- Include any formatting or linting tools used.

Testing Guidelines

- Identify testing frameworks and coverage requirements.
- State test naming conventions and how to run tests.

Commit & Pull Request Guidelines

- Summarize commit message conventions found in the project's Git history.
- Outline pull request requirements (descriptions, linked issues, screenshots, etc.).

(Optional) Add other sections if relevant, such as Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions.`;
const DEFAULT_MODE_KEY = "default";
const SESSION_MODE_STORAGE_KEY = "codex-deck:session-plan-mode:v1";
const MESSAGE_HISTORY_STORAGE_KEY = "codex-deck:message-history:v1";
const TOKEN_COUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const FILE_MENTION_LOADING_ITEM_ID = "__loading__";
const FILE_MENTION_EMPTY_ITEM_ID = "__empty__";
const SKILL_SELECTOR_LOADING_ITEM_ID = "__skill-loading__";
const SKILL_SELECTOR_EMPTY_ITEM_ID = "__skill-empty__";
const SKILL_SELECTOR_ERROR_ITEM_ID = "__skill-error__";
const DAEMON_COMMAND_CONSOLE_LOG_GLOBAL_KEY =
  "__CODEX_DECK_DAEMON_COMMAND_LOG_ENABLED__";

interface CodexDeckDebugWindow extends Window {
  __CODEX_DECK_DAEMON_COMMAND_LOG_ENABLED__?: boolean;
}

function isDaemonCommandConsoleLogEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const debugWindow = window as CodexDeckDebugWindow;
  if (
    typeof debugWindow.__CODEX_DECK_DAEMON_COMMAND_LOG_ENABLED__ !== "boolean"
  ) {
    debugWindow.__CODEX_DECK_DAEMON_COMMAND_LOG_ENABLED__ = true;
  }
  return debugWindow.__CODEX_DECK_DAEMON_COMMAND_LOG_ENABLED__ !== false;
}

function workflowHistorySignature(
  at: string | null,
  type: string,
  details: Record<string, unknown>,
): string {
  return `${at || ""}|${type}|${JSON.stringify(details)}`;
}

function daemonCommandText(details: Record<string, unknown>): string {
  const commandSummary = details.commandSummary;
  if (typeof commandSummary === "string" && commandSummary.trim()) {
    return commandSummary.trim();
  }
  const commandType = details.commandType;
  if (commandType === "exec") {
    return "codex exec <prompt>";
  }
  if (commandType === "resume") {
    return "codex resume <session-id> <prompt>";
  }
  return "(unknown command)";
}

type CollaborationModeKey = string;

interface TokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface PendingTurn {
  sessionId: string;
  turnId: string | null;
}

interface WorkflowCreateChatSnapshot {
  directive: ReturnType<typeof getStrictTaskCreateDirectiveFromMessages>;
  messages: ConversationMessage[];
}

function getWorkflowCreateTurnLifecycleState(
  messages: ConversationMessage[],
  turnId: string,
): "unknown" | "started" | "completed" {
  const normalizedTurnId = turnId.trim();
  if (!normalizedTurnId) {
    return "unknown";
  }

  let sawStart = false;
  for (const message of messages) {
    if ((message.turnId ?? "").trim() !== normalizedTurnId) {
      continue;
    }
    if (message.type === "task_complete" || message.type === "turn_aborted") {
      return "completed";
    }
    if (message.type === "task_started") {
      sawStart = true;
    }
  }

  return sawStart ? "started" : "unknown";
}

interface ResizeState {
  startY: number;
  startHeight: number;
  pointerId: number;
  pointerType: string;
}

interface PaneResizeState {
  target: "left" | "right";
  startX: number;
  startWidth: number;
  pointerId: number;
}

interface HistoryNavigationState {
  index: number | null;
  draftBeforeNavigation: string;
}

interface MessageComposerSubmitPayload {
  text: string;
  images: string[];
}

interface ComposerImageAttachment {
  id: string;
  file: File;
  previewUrl: string;
}

interface MessageComposerProps {
  sessionId: string | null;
  draftResetKey?: string;
  history: string[];
  slashCommands: SlashCommandDefinition[];
  isGeneratingForSelectedSession: boolean;
  isSendingLocked: boolean;
  sendingMessage: boolean;
  stoppingTurn: boolean;
  idlePrimaryActionLabel?: string;
  idlePrimaryActionBusy?: boolean;
  idlePrimaryActionBusyLabel?: string;
  allowIdlePrimaryActionWithoutContent?: boolean;
  onIdlePrimaryAction?:
    | ((payload: MessageComposerSubmitPayload) => Promise<boolean>)
    | null;
  messageBoxHeight: number;
  onResizeMessageBoxStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onSendMessage: (payload: MessageComposerSubmitPayload) => Promise<boolean>;
  onRunSlashCommand: (commandName: string, args: string) => Promise<boolean>;
  onStopConversation: () => Promise<void>;
}

type ComposerSendTrigger = "textarea-enter" | "send-button" | "other";

function createComposerAttachmentId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function createPageClientId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `client-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function createPendingUserMessageId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `pending-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function isSessionUnavailableMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("session not found") ||
    normalized.includes("session file not found") ||
    normalized.includes("thread not found") ||
    normalized.includes("unknown thread") ||
    normalized.includes("thread not loaded") ||
    normalized.includes("no rollout found for thread id")
  );
}

function buildWorkflowChatBootstrapMessage(input: {
  workflowId: string;
  projectRoot: string;
  initialUserMessage: string;
  imageCount: number;
}): string {
  const baseMessage = `(Use skill codex-deck-flow) The workflow ID is ${input.workflowId} and the project path is ${input.projectRoot}. Please read the information of the workflow and do not do other things.`;
  const normalizedUserMessage = input.initialUserMessage.trim();
  if (!normalizedUserMessage && input.imageCount === 0) {
    return baseMessage;
  }

  const parts = [baseMessage];
  parts.push(
    "After loading workflow context, treat the next section as the user's first request in this session.",
  );
  if (input.imageCount > 0) {
    parts.push(
      `The user also attached ${input.imageCount} image${input.imageCount === 1 ? "" : "s"} in this same message. Use them as context for the first request.`,
    );
  }
  if (normalizedUserMessage) {
    parts.push(
      `User first request:\n<user-request>\n${normalizedUserMessage}\n</user-request>`,
    );
  }

  return parts.join("\n\n");
}

function isImageFile(file: File): boolean {
  return typeof file.type === "string" && file.type.startsWith("image/");
}

function getSkillDisplayName(skill: CodexSkillMetadata): string {
  const displayName = skill.interface?.displayName?.trim();
  return displayName || skill.name;
}

function getSkillDescription(skill: CodexSkillMetadata): string {
  return (
    skill.interface?.shortDescription?.trim() ||
    skill.shortDescription?.trim() ||
    skill.description
  );
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string" && result.trim().length > 0) {
        resolve(result);
        return;
      }
      reject(new Error("Failed to read image data"));
    };
    reader.onerror = () => {
      reject(new Error("Failed to read image data"));
    };
    reader.readAsDataURL(file);
  });
}

function dataTransferHasImage(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) {
    return false;
  }

  if (
    Array.from(dataTransfer.items ?? []).some(
      (item) => item.kind === "file" && item.type.startsWith("image/"),
    )
  ) {
    return true;
  }

  return Array.from(dataTransfer.files ?? []).some(isImageFile);
}

function detectMobilePhone(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const mobileNavigator = window.navigator as Navigator & {
    userAgentData?: { mobile?: boolean };
  };
  if (mobileNavigator.userAgentData?.mobile === true) {
    return true;
  }

  const userAgent = mobileNavigator.userAgent || "";
  if (
    /Android.*Mobile|iPhone|iPod|Windows Phone|IEMobile|Opera Mini/i.test(
      userAgent,
    )
  ) {
    return true;
  }
  if (/iPad/i.test(userAgent)) {
    return false;
  }

  const hasTouch = (mobileNavigator.maxTouchPoints ?? 0) > 0;
  const isCoarsePointer =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;
  const shortestViewport = Math.min(window.innerWidth, window.innerHeight);
  return hasTouch && isCoarsePointer && shortestViewport <= 768;
}

function extractMessageText(message: ConversationMessage): string {
  const content = message.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const textParts = content.flatMap((block) => {
    if (block?.type !== "text" || typeof block.text !== "string") {
      return [];
    }
    const text = block.text.trim();
    return text ? [text] : [];
  });
  return textParts.join("\n").trim();
}

function buildWorkflowCreateTasksJson(tasks: WorkflowTaskSummary[]): string {
  return JSON.stringify(
    tasks.map((task) => ({
      id: task.id,
      name: task.name,
      prompt: task.prompt,
      dependsOn: task.dependsOn,
      ...(task.branchName ? { branchName: task.branchName } : {}),
    })),
    null,
    2,
  );
}

function getThreadSummaryDisplay(thread: CodexThreadSummary): string {
  const name = thread.name?.trim();
  if (name) {
    return name;
  }

  const preview = thread.preview.trim();
  if (preview) {
    return preview;
  }

  return "(no prompt text)";
}

function normalizeThreadUpdatedAt(updatedAt: number | null): number {
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) {
    return Date.now();
  }
  return updatedAt >= 1e12 ? updatedAt : updatedAt * 1000;
}

function toSessionFromThreadSummary(thread: CodexThreadSummary): Session {
  const project = thread.cwd.trim();
  return {
    id: thread.threadId,
    display: getThreadSummaryDisplay(thread),
    timestamp: normalizeThreadUpdatedAt(thread.updatedAt),
    project,
    projectName: project ? getPathBaseName(project) : "",
  };
}

function formatThreadStatus(status: CodexThreadSummary["status"]): string {
  switch (status) {
    case "active":
      return "active";
    case "idle":
      return "idle";
    case "systemError":
      return "system error";
    case "notLoaded":
      return "not loaded";
    default:
      return "unknown";
  }
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isFileMentionPlaceholderItem(itemId: string): boolean {
  return (
    itemId === FILE_MENTION_LOADING_ITEM_ID ||
    itemId === FILE_MENTION_EMPTY_ITEM_ID
  );
}

function isSkillSelectorPlaceholderItem(itemId: string): boolean {
  return (
    itemId === SKILL_SELECTOR_LOADING_ITEM_ID ||
    itemId === SKILL_SELECTOR_EMPTY_ITEM_ID ||
    itemId === SKILL_SELECTOR_ERROR_ITEM_ID
  );
}

function openNativeSelectMenu(select: HTMLSelectElement): void {
  select.focus();
  if (
    typeof (select as HTMLSelectElement & { showPicker?: () => void })
      .showPicker === "function"
  ) {
    (
      select as HTMLSelectElement & {
        showPicker: () => void;
      }
    ).showPicker();
    return;
  }
  select.click();
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard API is unavailable.");
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!copied) {
    throw new Error("Failed to copy text.");
  }
}

function loadMessageHistoryMap(): Record<string, string[]> {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(MESSAGE_HISTORY_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const result: Record<string, string[]> = {};
    for (const [sessionId, entries] of Object.entries(parsed)) {
      if (!Array.isArray(entries)) {
        continue;
      }

      const normalized = entries
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      result[sessionId] = normalized;
    }
    return result;
  } catch {
    return {};
  }
}

function persistMessageHistoryMap(value: Record<string, string[]>): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      MESSAGE_HISTORY_STORAGE_KEY,
      JSON.stringify(value),
    );
  } catch {
    // Ignore storage write errors (private mode, quota, etc.)
  }
}

function loadSessionModeMap(): Record<string, CollaborationModeKey> {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.sessionStorage.getItem(SESSION_MODE_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const result: Record<string, CollaborationModeKey> = {};
    for (const [sessionId, modeValue] of Object.entries(parsed)) {
      if (typeof modeValue === "string") {
        const normalizedMode = modeValue.trim();
        if (normalizedMode) {
          result[sessionId] = normalizedMode;
        }
      }
    }
    return result;
  } catch {
    return {};
  }
}

function persistSessionModeMap(
  value: Record<string, CollaborationModeKey>,
): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(
      SESSION_MODE_STORAGE_KEY,
      JSON.stringify(value),
    );
  } catch {
    // Ignore storage write errors (private mode, quota, etc.)
  }
}

function loadRemoteBootstrapConfig(): {
  enabled: boolean;
  serverUrl: string;
  pinnedRealmId: string;
  pinnedOpaqueServerPublicKey: string;
} {
  if (typeof window === "undefined") {
    return {
      enabled: false,
      serverUrl: "",
      pinnedRealmId: "",
      pinnedOpaqueServerPublicKey: "",
    };
  }

  const bootstrap = (
    window as Window & {
      __CODEX_DECK_REMOTE_DEFAULT__?: {
        enabled?: unknown;
        serverUrl?: unknown;
        pinnedRealmId?: unknown;
        pinnedOpaqueServerPublicKey?: unknown;
      };
    }
  ).__CODEX_DECK_REMOTE_DEFAULT__;

  if (!bootstrap || bootstrap.enabled !== true) {
    return {
      enabled: false,
      serverUrl: "",
      pinnedRealmId: "",
      pinnedOpaqueServerPublicKey: "",
    };
  }

  const defaultServerUrl =
    typeof bootstrap.serverUrl === "string" && bootstrap.serverUrl.trim()
      ? bootstrap.serverUrl.trim()
      : window.location.origin;
  const bootstrapLoginUrlFromLocation =
    getRemoteBootstrapLoginUrlFromLocation();

  return {
    enabled: true,
    serverUrl: bootstrapLoginUrlFromLocation ?? defaultServerUrl,
    pinnedRealmId:
      typeof bootstrap.pinnedRealmId === "string" &&
      bootstrap.pinnedRealmId.trim()
        ? bootstrap.pinnedRealmId.trim()
        : "",
    pinnedOpaqueServerPublicKey:
      typeof bootstrap.pinnedOpaqueServerPublicKey === "string" &&
      bootstrap.pinnedOpaqueServerPublicKey.trim()
        ? bootstrap.pinnedOpaqueServerPublicKey.trim()
        : "",
  };
}

const REMOTE_BOOTSTRAP_LOGIN_URL_SERVER_PARAM = "codexdeck_remote_server_url";
const REMOTE_BOOTSTRAP_LOGIN_URL_REALM_PARAM = "codexdeck_remote_realm_id";
const REMOTE_BOOTSTRAP_LOGIN_URL_OPAQUE_KEY_PARAM =
  "codexdeck_remote_opaque_server_key";

function getRemoteBootstrapLoginUrlFromLocation(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const currentUrl = new URL(window.location.href);
    const hasBootstrapParams = [
      REMOTE_BOOTSTRAP_LOGIN_URL_SERVER_PARAM,
      REMOTE_BOOTSTRAP_LOGIN_URL_REALM_PARAM,
      REMOTE_BOOTSTRAP_LOGIN_URL_OPAQUE_KEY_PARAM,
    ].some((param) => {
      const value = currentUrl.searchParams.get(param);
      return typeof value === "string" && value.trim().length > 0;
    });
    if (!hasBootstrapParams) {
      return null;
    }
    return currentUrl.toString();
  } catch {
    return null;
  }
}

function parseRemoteLoginInputUrl(rawInput: string): URL | null {
  const trimmedInput = rawInput.trim();
  if (!trimmedInput) {
    return null;
  }

  const candidates = new Set<string>();
  candidates.add(trimmedInput);

  const unwrappedInput = trimmedInput.replace(/^["']+|["']+$/g, "");
  if (unwrappedInput) {
    candidates.add(unwrappedInput);
    candidates.add(unwrappedInput.replace(/&amp;/gi, "&"));
  }

  const embeddedUrlMatch = unwrappedInput.match(/https?:\/\/[^\s"'<>]+/i);
  if (embeddedUrlMatch?.[0]) {
    candidates.add(embeddedUrlMatch[0]);
  }

  for (const candidate of candidates) {
    try {
      return new URL(candidate);
    } catch {
      // Ignore invalid candidates and try the next one.
    }
  }

  return null;
}

function rawInputIncludesBootstrapPinHints(rawInput: string): boolean {
  const normalized = rawInput.trim().replace(/&amp;/gi, "&");
  if (!normalized) {
    return false;
  }

  const realmHint =
    /codexdeck_remote_realm_id=([^&#\s]+)/i.exec(normalized)?.[1] ?? "";
  const opaqueKeyHint =
    /codexdeck_remote_opaque_server_key=([^&#\s]+)/i.exec(normalized)?.[1] ??
    "";

  return realmHint.trim().length > 0 || opaqueKeyHint.trim().length > 0;
}

function resolveRemoteLoginTarget(
  rawServerInput: string,
  bootstrapDefaults: {
    pinnedRealmId: string;
    pinnedOpaqueServerPublicKey: string;
  },
): { serverUrl: string; pins: RemoteServerTrustPins } {
  const trimmedInput = rawServerInput.trim();
  const defaultRealmId = bootstrapDefaults.pinnedRealmId.trim();
  const defaultOpaqueServerPublicKey =
    bootstrapDefaults.pinnedOpaqueServerPublicKey.trim();
  const defaultPins: RemoteServerTrustPins = {
    realmId: defaultRealmId || null,
    opaqueServerPublicKey: defaultOpaqueServerPublicKey || null,
  };
  if (!trimmedInput) {
    return {
      serverUrl: "",
      pins: defaultPins,
    };
  }

  const parsedInput = parseRemoteLoginInputUrl(trimmedInput);
  if (!parsedInput) {
    return {
      serverUrl: trimmedInput,
      pins: defaultPins,
    };
  }

  const pinnedRealmId =
    parsedInput.searchParams.get(REMOTE_BOOTSTRAP_LOGIN_URL_REALM_PARAM) ||
    defaultRealmId;
  const pinnedOpaqueServerPublicKey =
    parsedInput.searchParams.get(REMOTE_BOOTSTRAP_LOGIN_URL_OPAQUE_KEY_PARAM) ||
    defaultOpaqueServerPublicKey;
  const explicitServerUrl =
    parsedInput.searchParams.get(REMOTE_BOOTSTRAP_LOGIN_URL_SERVER_PARAM) || "";
  const normalizedServerUrl = explicitServerUrl.trim()
    ? explicitServerUrl.trim().replace(/\/+$/, "")
    : `${parsedInput.origin}${parsedInput.pathname === "/" ? "" : parsedInput.pathname}`.replace(
        /\/+$/,
        "",
      );

  return {
    serverUrl: normalizedServerUrl,
    pins: {
      realmId: pinnedRealmId.trim() || null,
      opaqueServerPublicKey: pinnedOpaqueServerPublicKey.trim() || null,
    },
  };
}

function buildRemoteAdminUrl(serverUrl: string): string | null {
  const normalizedServerUrl = serverUrl.trim().replace(/\/+$/, "");
  if (!normalizedServerUrl) {
    return null;
  }

  try {
    return new URL("/admin", normalizedServerUrl).toString();
  } catch {
    return null;
  }
}

function formatAdminTimestamp(timestamp: number | null): string {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return "Never";
  }
  return new Date(timestamp).toLocaleString();
}

interface PasswordFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  autoComplete?: string;
  containerClassName?: string;
  inputClassName?: string;
  disabled?: boolean;
}

function PasswordField(props: PasswordFieldProps) {
  const {
    label,
    value,
    onChange,
    placeholder,
    autoComplete,
    containerClassName = "block space-y-1",
    inputClassName = "w-full rounded border border-zinc-800 bg-zinc-950/80 px-3 py-2 pr-12 text-sm text-zinc-100 focus:outline-none",
    disabled = false,
  } = props;
  const [visible, setVisible] = useState(false);

  return (
    <label className={containerClassName}>
      <span className="text-xs text-zinc-500">{label}</span>
      <div className="relative">
        <input
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          disabled={disabled}
          className={inputClassName}
        />
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 transition-colors hover:text-zinc-200"
          aria-label={visible ? `Hide ${label}` : `Show ${label}`}
          title={visible ? "Hide password" : "Show password"}
        >
          {visible ? (
            <EyeOff className="h-4 w-4" />
          ) : (
            <Eye className="h-4 w-4" />
          )}
        </button>
      </div>
    </label>
  );
}

function RemoteAdminApp({ serverUrl }: { serverUrl: string }) {
  const [password, setPassword] = useState("");
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [tokenLabel, setTokenLabel] = useState("");
  const [tokens, setTokens] = useState<RemoteAdminSetupToken[]>([]);
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [workingTokenId, setWorkingTokenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealedToken, setRevealedToken] = useState<{
    label: string;
    rawToken: string;
  } | null>(null);

  const refreshTokens = useCallback(async () => {
    const nextTokens = await listRemoteAdminSetupTokens(serverUrl);
    setTokens(nextTokens);
    setAuthenticated(true);
  }, [serverUrl]);

  useEffect(() => {
    let cancelled = false;
    void refreshTokens()
      .catch(() => {
        if (!cancelled) {
          setAuthenticated(false);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshTokens]);

  const handleLogin = useCallback(
    async (event: ReactFormEvent) => {
      event.preventDefault();
      if (submitting) {
        return;
      }

      setSubmitting(true);
      setError(null);
      try {
        await loginRemoteAdmin(serverUrl, password);
        await refreshTokens();
        setPassword("");
      } catch (loginError) {
        setAuthenticated(false);
        setError(
          loginError instanceof Error ? loginError.message : String(loginError),
        );
      } finally {
        setSubmitting(false);
      }
    },
    [password, refreshTokens, serverUrl, submitting],
  );

  const handleLogout = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      await logoutRemoteAdmin(serverUrl);
    } catch (logoutError) {
      setError(
        logoutError instanceof Error
          ? logoutError.message
          : String(logoutError),
      );
    } finally {
      setTokens([]);
      setAuthenticated(false);
      setSubmitting(false);
    }
  }, [serverUrl]);

  const handleCreateToken = useCallback(async () => {
    if (submitting) {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const created = await createRemoteAdminSetupToken(serverUrl, tokenLabel);
      setTokenLabel("");
      setRevealedToken({
        label: created.token.label,
        rawToken: created.rawToken,
      });
      await refreshTokens();
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : String(createError),
      );
    } finally {
      setSubmitting(false);
    }
  }, [refreshTokens, serverUrl, submitting, tokenLabel]);

  const handleRenameToken = useCallback(
    async (token: RemoteAdminSetupToken) => {
      const nextLabel =
        typeof window !== "undefined"
          ? window.prompt("Rename setup token", token.label)
          : token.label;
      if (!nextLabel || nextLabel.trim() === token.label) {
        return;
      }

      setWorkingTokenId(token.id);
      setError(null);
      try {
        await updateRemoteAdminSetupToken(serverUrl, token.id, {
          label: nextLabel.trim(),
        });
        await refreshTokens();
      } catch (updateError) {
        setError(
          updateError instanceof Error
            ? updateError.message
            : String(updateError),
        );
      } finally {
        setWorkingTokenId(null);
      }
    },
    [refreshTokens, serverUrl],
  );

  const handleToggleToken = useCallback(
    async (token: RemoteAdminSetupToken) => {
      setWorkingTokenId(token.id);
      setError(null);
      try {
        await updateRemoteAdminSetupToken(serverUrl, token.id, {
          enabled: !token.enabled,
        });
        await refreshTokens();
      } catch (updateError) {
        setError(
          updateError instanceof Error
            ? updateError.message
            : String(updateError),
        );
      } finally {
        setWorkingTokenId(null);
      }
    },
    [refreshTokens, serverUrl],
  );

  const handleRegenerateToken = useCallback(
    async (token: RemoteAdminSetupToken) => {
      setWorkingTokenId(token.id);
      setError(null);
      try {
        const regenerated = await regenerateRemoteAdminSetupToken(
          serverUrl,
          token.id,
        );
        setRevealedToken({
          label: regenerated.token.label,
          rawToken: regenerated.rawToken,
        });
        await refreshTokens();
      } catch (regenerateError) {
        setError(
          regenerateError instanceof Error
            ? regenerateError.message
            : String(regenerateError),
        );
      } finally {
        setWorkingTokenId(null);
      }
    },
    [refreshTokens, serverUrl],
  );

  const handleDeleteToken = useCallback(
    async (token: RemoteAdminSetupToken) => {
      const confirmed =
        typeof window === "undefined"
          ? true
          : window.confirm(`Delete setup token "${token.label}"?`);
      if (!confirmed) {
        return;
      }

      setWorkingTokenId(token.id);
      setError(null);
      try {
        await deleteRemoteAdminSetupToken(serverUrl, token.id);
        await refreshTokens();
      } catch (deleteError) {
        setError(
          deleteError instanceof Error
            ? deleteError.message
            : String(deleteError),
        );
      } finally {
        setWorkingTokenId(null);
      }
    },
    [refreshTokens, serverUrl],
  );

  const handleRotatePassword = useCallback(async () => {
    if (!oldPassword || !newPassword || !confirmNewPassword || submitting) {
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setError("New passwords do not match.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await rotateRemoteAdminPassword(serverUrl, oldPassword, newPassword);
      setOldPassword("");
      setNewPassword("");
      setConfirmNewPassword("");
    } catch (rotateError) {
      setError(
        rotateError instanceof Error
          ? rotateError.message
          : String(rotateError),
      );
    } finally {
      setSubmitting(false);
    }
  }, [confirmNewPassword, newPassword, oldPassword, serverUrl, submitting]);

  if (loading) {
    return (
      <div className="app-viewport-min-height app-viewport-safe-area flex items-center justify-center bg-zinc-950 px-6 text-zinc-100">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 px-6 py-5 text-sm text-zinc-300 shadow-2xl">
          Loading admin console...
        </div>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="app-viewport-min-height app-viewport-safe-area flex items-center justify-center bg-zinc-950 px-6 text-zinc-100">
        <form
          onSubmit={handleLogin}
          className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/80 p-6 shadow-2xl"
        >
          <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">
            codex-deck
          </div>
          <h1 className="mt-3 text-2xl font-semibold text-zinc-50">
            Server Admin
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Log in with the server admin password to manage setup tokens and
            rotate the admin password.
          </p>
          <PasswordField
            label="Admin Password"
            value={password}
            onChange={setPassword}
            placeholder="Enter admin password"
            autoComplete="current-password"
            containerClassName="mt-6 block space-y-1"
          />
          {error && (
            <div className="mt-4 rounded border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-200">
              {error}
            </div>
          )}
          <div className="mt-6 flex items-center justify-between gap-3">
            <a
              href={serverUrl}
              className="text-xs text-zinc-500 transition-colors hover:text-zinc-300"
            >
              Back To App
            </a>
            <button
              type="submit"
              disabled={submitting || password.length === 0}
              className="h-10 rounded border border-cyan-700/60 bg-cyan-700/30 px-4 text-sm text-cyan-50 transition-colors hover:bg-cyan-700/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Working..." : "Login"}
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="app-viewport-min-height app-viewport-safe-area bg-zinc-950 px-6 py-10 text-zinc-100">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">
              codex-deck
            </div>
            <h1 className="mt-2 text-3xl font-semibold text-zinc-50">
              Server Admin
            </h1>
            <p className="mt-2 text-sm text-zinc-400">
              Manage CLI setup tokens and rotate the server admin password.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <a
              href={serverUrl}
              className="h-10 rounded border border-zinc-700 bg-zinc-800/80 px-4 text-sm text-zinc-200 transition-colors hover:bg-zinc-700/80"
            >
              Open App
            </a>
            <button
              type="button"
              onClick={() => {
                void handleLogout();
              }}
              className="h-10 rounded border border-zinc-700 bg-zinc-800/80 px-4 text-sm text-zinc-200 transition-colors hover:bg-zinc-700/80"
            >
              Logout
            </button>
          </div>
        </div>

        {revealedToken && (
          <div className="rounded-xl border border-amber-800/60 bg-amber-950/30 px-4 py-4 text-sm text-amber-100">
            <div className="font-medium uppercase tracking-[0.16em] text-amber-300">
              Copy This Token Now
            </div>
            <div className="mt-2 text-xs text-amber-200">
              {revealedToken.label}
            </div>
            <div className="mt-3 break-all rounded border border-amber-900/50 bg-zinc-950/60 px-3 py-3 font-mono text-xs text-amber-50">
              {revealedToken.rawToken}
            </div>
          </div>
        )}

        {error && (
          <div className="rounded border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-200">
            {error}
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5 shadow-xl">
            <div className="text-sm font-semibold text-zinc-100">
              Setup Tokens
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              Create tokens for CLI bootstrap. Raw token values are shown only
              once when created or regenerated.
            </p>

            <div className="mt-5 flex flex-col gap-3 sm:flex-row">
              <input
                type="text"
                value={tokenLabel}
                onChange={(event) => setTokenLabel(event.target.value)}
                placeholder="Optional token label"
                className="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-950/80 px-3 py-2 text-sm text-zinc-100 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => {
                  void handleCreateToken();
                }}
                disabled={submitting}
                className="h-10 rounded border border-cyan-700/60 bg-cyan-700/30 px-4 text-sm text-cyan-50 transition-colors hover:bg-cyan-700/40 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Create Token
              </button>
            </div>

            <div className="mt-5 space-y-3">
              {tokens.length === 0 ? (
                <div className="rounded border border-zinc-800 bg-zinc-950/40 px-3 py-3 text-sm text-zinc-400">
                  No setup tokens are configured.
                </div>
              ) : (
                tokens.map((token) => (
                  <div
                    key={token.id}
                    className="rounded-xl border border-zinc-800 bg-zinc-950/50 px-4 py-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-zinc-100">
                          {token.label}
                        </div>
                        <div className="mt-1 text-xs text-zinc-500">
                          Last used: {formatAdminTimestamp(token.lastUsedAt)}
                        </div>
                      </div>
                      <div className="text-xs uppercase tracking-[0.16em] text-zinc-500">
                        {token.enabled ? "Enabled" : "Disabled"}
                      </div>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          void handleRenameToken(token);
                        }}
                        disabled={workingTokenId === token.id}
                        className="h-8 rounded border border-zinc-700 bg-zinc-800/80 px-3 text-xs text-zinc-200 transition-colors hover:bg-zinc-700/80 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void handleToggleToken(token);
                        }}
                        disabled={workingTokenId === token.id}
                        className="h-8 rounded border border-zinc-700 bg-zinc-800/80 px-3 text-xs text-zinc-200 transition-colors hover:bg-zinc-700/80 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {token.enabled ? "Disable" : "Enable"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void handleRegenerateToken(token);
                        }}
                        disabled={workingTokenId === token.id}
                        className="h-8 rounded border border-cyan-700/60 bg-cyan-700/30 px-3 text-xs text-cyan-50 transition-colors hover:bg-cyan-700/40 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Regenerate
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void handleDeleteToken(token);
                        }}
                        disabled={workingTokenId === token.id}
                        className="h-8 rounded border border-red-900/50 bg-red-950/30 px-3 text-xs text-red-200 transition-colors hover:bg-red-950/45 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5 shadow-xl">
            <div className="text-sm font-semibold text-zinc-100">
              Rotate Admin Password
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              Rotating the password replaces the current admin session.
            </p>
            <PasswordField
              label="Current Password"
              value={oldPassword}
              onChange={setOldPassword}
              placeholder="Enter the current admin password"
              autoComplete="current-password"
              containerClassName="mt-5 block space-y-1"
            />
            <PasswordField
              label="New Password"
              value={newPassword}
              onChange={setNewPassword}
              placeholder="Enter a new admin password"
              autoComplete="new-password"
              containerClassName="mt-4 block space-y-1"
            />
            <PasswordField
              label="Confirm New Password"
              value={confirmNewPassword}
              onChange={setConfirmNewPassword}
              placeholder="Enter the new password again"
              autoComplete="new-password"
              containerClassName="mt-4 block space-y-1"
            />
            <button
              type="button"
              onClick={() => {
                void handleRotatePassword();
              }}
              disabled={
                submitting ||
                oldPassword.length === 0 ||
                newPassword.length === 0 ||
                confirmNewPassword.length === 0 ||
                newPassword !== confirmNewPassword
              }
              className="mt-4 h-10 rounded border border-cyan-700/60 bg-cyan-700/30 px-4 text-sm text-cyan-50 transition-colors hover:bg-cyan-700/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Rotate Password
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}

const MessageComposer = memo(function MessageComposer(
  props: MessageComposerProps,
) {
  const {
    sessionId,
    draftResetKey,
    history,
    slashCommands,
    isGeneratingForSelectedSession,
    isSendingLocked,
    sendingMessage,
    stoppingTurn,
    idlePrimaryActionLabel,
    idlePrimaryActionBusy = false,
    idlePrimaryActionBusyLabel,
    allowIdlePrimaryActionWithoutContent = false,
    onIdlePrimaryAction,
    messageBoxHeight,
    onResizeMessageBoxStart,
    onSendMessage,
    onRunSlashCommand,
    onStopConversation,
  } = props;
  const composerResetKey = draftResetKey ?? sessionId ?? "";
  const [draft, setDraft] = useState("");
  const [historyNavigation, setHistoryNavigation] =
    useState<HistoryNavigationState>({
      index: null,
      draftBeforeNavigation: "",
    });
  const [imageAttachments, setImageAttachments] = useState<
    ComposerImageAttachment[]
  >([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const [isMobilePhone, setIsMobilePhone] = useState(false);
  const [showMobileAttachMenu, setShowMobileAttachMenu] = useState(false);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [slashPaletteDismissed, setSlashPaletteDismissed] = useState(false);
  const [selectedSlashCommandIndex, setSelectedSlashCommandIndex] = useState(0);
  const [fileMentionResults, setFileMentionResults] = useState<string[]>([]);
  const [fileMentionSearchLoading, setFileMentionSearchLoading] =
    useState(false);
  const [dismissedFileMentionQuery, setDismissedFileMentionQuery] = useState<
    string | null
  >(null);
  const [selectedFileMentionIndex, setSelectedFileMentionIndex] = useState(0);
  const [skillSelectorOptions, setSkillSelectorOptions] = useState<
    SkillSelectorOption[]
  >([]);
  const [skillSelectorLoading, setSkillSelectorLoading] = useState(false);
  const [skillSelectorError, setSkillSelectorError] = useState<string | null>(
    null,
  );
  const [skillSelectorLoadedSessionId, setSkillSelectorLoadedSessionId] =
    useState<string | null>(null);
  const [dismissedSkillSelectorQuery, setDismissedSkillSelectorQuery] =
    useState<string | null>(null);
  const [selectedSkillSelectorIndex, setSelectedSkillSelectorIndex] =
    useState(0);
  const dragDepthRef = useRef(0);
  const imageAttachmentsRef = useRef<ComposerImageAttachment[]>([]);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerContainerRef = useRef<HTMLDivElement | null>(null);
  const fileMentionSearchRequestIdRef = useRef(0);
  const skillSelectorRequestIdRef = useRef(0);

  const clearImageAttachments = useCallback(() => {
    setImageAttachments((current) => {
      for (const attachment of current) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
      return [];
    });
  }, []);

  useEffect(() => {
    imageAttachmentsRef.current = imageAttachments;
  }, [imageAttachments]);

  useEffect(() => {
    setDraft("");
    setHistoryNavigation({
      index: null,
      draftBeforeNavigation: "",
    });
    setCursorPosition(0);
    setSlashPaletteDismissed(false);
    setSelectedSlashCommandIndex(0);
    setDismissedFileMentionQuery(null);
    setSelectedFileMentionIndex(0);
    setFileMentionResults([]);
    setFileMentionSearchLoading(false);
    fileMentionSearchRequestIdRef.current += 1;
    setSkillSelectorOptions([]);
    setSkillSelectorLoading(false);
    setSkillSelectorError(null);
    setSkillSelectorLoadedSessionId(null);
    setDismissedSkillSelectorQuery(null);
    setSelectedSkillSelectorIndex(0);
    skillSelectorRequestIdRef.current += 1;
    clearImageAttachments();
    dragDepthRef.current = 0;
    setIsDragActive(false);
    setShowMobileAttachMenu(false);
  }, [clearImageAttachments, composerResetKey]);

  useEffect(() => {
    const updateMobilePhoneState = () => {
      setIsMobilePhone(detectMobilePhone());
    };

    updateMobilePhoneState();
    window.addEventListener("resize", updateMobilePhoneState);
    window.addEventListener("orientationchange", updateMobilePhoneState);
    return () => {
      window.removeEventListener("resize", updateMobilePhoneState);
      window.removeEventListener("orientationchange", updateMobilePhoneState);
    };
  }, []);

  useEffect(() => {
    return () => {
      for (const attachment of imageAttachmentsRef.current) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    };
  }, []);

  const addImageFiles = useCallback((files: File[]) => {
    const imageFiles = files.filter(isImageFile);
    if (imageFiles.length === 0) {
      return;
    }

    const nextAttachments = imageFiles.map((file) => ({
      id: createComposerAttachmentId(),
      file,
      previewUrl: URL.createObjectURL(file),
    }));
    setImageAttachments((current) => [...current, ...nextAttachments]);
  }, []);

  const removeImageAttachment = useCallback((id: string) => {
    setImageAttachments((current) => {
      const target = current.find((attachment) => attachment.id === id);
      if (target) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return current.filter((attachment) => attachment.id !== id);
    });
  }, []);

  const handleMobileFileInputChange = useCallback(
    (event: ReactChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      if (files.length > 0) {
        addImageFiles(files);
      }
      event.target.value = "";
      setShowMobileAttachMenu(false);
    },
    [addImageFiles],
  );

  const handleOpenCameraPicker = useCallback(() => {
    cameraInputRef.current?.click();
  }, []);

  const handleOpenGalleryPicker = useCallback(() => {
    galleryInputRef.current?.click();
  }, []);

  const handleComposerDragEnter = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!dataTransferHasImage(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      dragDepthRef.current += 1;
      setIsDragActive(true);
    },
    [],
  );

  const handleComposerDragOver = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!dataTransferHasImage(event.dataTransfer)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    [],
  );

  const handleComposerDragLeave = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!isDragActive) {
        return;
      }
      event.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setIsDragActive(false);
      }
    },
    [isDragActive],
  );

  const handleComposerDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!dataTransferHasImage(event.dataTransfer) && !isDragActive) {
        return;
      }
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDragActive(false);
      addImageFiles(Array.from(event.dataTransfer.files ?? []));
    },
    [addImageFiles, isDragActive],
  );

  const handleComposerPaste = useCallback(
    (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.clipboardData.files ?? []).filter(
        isImageFile,
      );
      if (files.length === 0) {
        return;
      }
      addImageFiles(files);
    },
    [addImageFiles],
  );

  const hasDraftText = draft.trim().length > 0;
  const hasMessageContent = hasDraftText || imageAttachments.length > 0;
  const shouldUseStopAction =
    isGeneratingForSelectedSession && !hasMessageContent;
  const hasIdlePrimaryAction = typeof onIdlePrimaryAction === "function";
  const idlePrimaryActionButtonLabel = idlePrimaryActionLabel || "Send";
  const composerBusy = sendingMessage || idlePrimaryActionBusy;

  const normalizedImageFiles = useMemo(
    () => imageAttachments.map((attachment) => attachment.file),
    [imageAttachments],
  );

  const clearAfterSendSuccess = useCallback(() => {
    setDraft("");
    setHistoryNavigation({
      index: null,
      draftBeforeNavigation: "",
    });
    setCursorPosition(0);
    setSlashPaletteDismissed(false);
    setSelectedSlashCommandIndex(0);
    setDismissedFileMentionQuery(null);
    setSelectedFileMentionIndex(0);
    setDismissedSkillSelectorQuery(null);
    setSelectedSkillSelectorIndex(0);
    clearImageAttachments();
  }, [clearImageAttachments]);

  const focusComposerInput = useCallback(() => {
    const applyFocus = () => {
      const textarea = composerTextareaRef.current;
      if (!textarea) {
        return;
      }
      if (textarea.disabled) {
        window.requestAnimationFrame(applyFocus);
        return;
      }
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    };

    window.requestAnimationFrame(applyFocus);
  }, []);

  const activeFileMention = useMemo(
    () => findActiveFileMentionToken(draft, cursorPosition),
    [cursorPosition, draft],
  );
  const fileMentionPaletteItems = useMemo<ComposerPickerItem[]>(() => {
    if (!activeFileMention) {
      return [];
    }

    const normalizedQuery = activeFileMention.query
      .trim()
      .replace(/^["']+/, "");
    if (!normalizedQuery) {
      return [
        {
          id: FILE_MENTION_EMPTY_ITEM_ID,
          label: "Type to search files",
          description: "Continue typing after @",
        },
      ];
    }

    if (fileMentionSearchLoading && fileMentionResults.length === 0) {
      return [
        {
          id: FILE_MENTION_LOADING_ITEM_ID,
          label: "Searching files...",
        },
      ];
    }

    if (!fileMentionSearchLoading && fileMentionResults.length === 0) {
      return [
        {
          id: FILE_MENTION_EMPTY_ITEM_ID,
          label: "No matching files",
          description: "Try another path fragment",
        },
      ];
    }

    return fileMentionResults.map((path) => {
      const slashIndex = path.lastIndexOf("/");
      return {
        id: path,
        label: path,
        description: slashIndex > 0 ? path.slice(0, slashIndex) : "file",
      };
    });
  }, [activeFileMention, fileMentionResults, fileMentionSearchLoading]);
  const activeSkillSelector = useMemo(
    () => findActiveSkillSelectorToken(draft, cursorPosition),
    [cursorPosition, draft],
  );
  const filteredSkillSelectorOptions = useMemo<SkillSelectorOption[]>(() => {
    if (!activeSkillSelector) {
      return [];
    }
    return getSkillSelectorSuggestions(
      activeSkillSelector.query,
      skillSelectorOptions,
    );
  }, [activeSkillSelector, skillSelectorOptions]);
  const skillSelectorPlaceholderItems = useMemo<ComposerPickerItem[]>(() => {
    if (!activeSkillSelector) {
      return [];
    }

    if (skillSelectorLoading && skillSelectorOptions.length === 0) {
      return [
        {
          id: SKILL_SELECTOR_LOADING_ITEM_ID,
          label: "Loading skills...",
        },
      ];
    }

    if (skillSelectorError && skillSelectorOptions.length === 0) {
      return [
        {
          id: SKILL_SELECTOR_ERROR_ITEM_ID,
          label: "Skills unavailable",
          description: skillSelectorError,
        },
      ];
    }

    if (filteredSkillSelectorOptions.length === 0) {
      return [
        {
          id: SKILL_SELECTOR_EMPTY_ITEM_ID,
          label: "No matching skills",
          description: "Try another skill name after $",
        },
      ];
    }

    return [];
  }, [
    activeSkillSelector,
    filteredSkillSelectorOptions.length,
    skillSelectorError,
    skillSelectorLoading,
    skillSelectorOptions.length,
  ]);
  const skillSelectorPaletteSize =
    filteredSkillSelectorOptions.length > 0
      ? filteredSkillSelectorOptions.length
      : skillSelectorPlaceholderItems.length;

  const slashQuery = useMemo(() => parseSlashCommandQuery(draft), [draft]);
  const slashPaletteCommands = useMemo(
    () => getSlashPaletteCommands(draft, slashCommands),
    [draft, slashCommands],
  );
  const showFileMentionPalette =
    !!activeFileMention &&
    dismissedFileMentionQuery !== activeFileMention.query;
  const showSkillSelectorPalette =
    !showFileMentionPalette &&
    !!activeSkillSelector &&
    dismissedSkillSelectorQuery !== activeSkillSelector.query;
  const showSlashPalette =
    !showFileMentionPalette &&
    !showSkillSelectorPalette &&
    !!slashQuery &&
    !slashQuery.hasArguments &&
    slashPaletteCommands.length > 0 &&
    !slashPaletteDismissed;

  useEffect(() => {
    if (!activeFileMention) {
      setFileMentionResults([]);
      setFileMentionSearchLoading(false);
      return;
    }
    if (!sessionId) {
      setFileMentionResults([]);
      setFileMentionSearchLoading(false);
      return;
    }

    const query = activeFileMention.query;
    const normalizedQuery = query.trim().replace(/^["']+/, "");
    const requestId = fileMentionSearchRequestIdRef.current + 1;
    fileMentionSearchRequestIdRef.current = requestId;

    if (!normalizedQuery) {
      setFileMentionResults([]);
      setFileMentionSearchLoading(false);
      return;
    }

    setFileMentionSearchLoading(true);
    searchSessionFiles(sessionId, query, 40)
      .then((response) => {
        if (fileMentionSearchRequestIdRef.current !== requestId) {
          return;
        }
        setFileMentionResults(
          Array.isArray(response.files) ? response.files : [],
        );
      })
      .catch(() => {
        if (fileMentionSearchRequestIdRef.current !== requestId) {
          return;
        }
        setFileMentionResults([]);
      })
      .finally(() => {
        if (fileMentionSearchRequestIdRef.current === requestId) {
          setFileMentionSearchLoading(false);
        }
      });
  }, [activeFileMention, sessionId]);

  useEffect(() => {
    if (!showSkillSelectorPalette) {
      return;
    }
    if (!sessionId) {
      setSkillSelectorLoading(false);
      setSkillSelectorError(null);
      setSkillSelectorOptions([]);
      setSkillSelectorLoadedSessionId(null);
      return;
    }
    if (skillSelectorLoadedSessionId === sessionId) {
      return;
    }

    const requestId = skillSelectorRequestIdRef.current + 1;
    skillSelectorRequestIdRef.current = requestId;
    setSkillSelectorLoading(true);
    setSkillSelectorError(null);

    getSessionSkills(sessionId)
      .then((response) => {
        if (skillSelectorRequestIdRef.current !== requestId) {
          return;
        }
        const options = response.skills
          .filter((skill) => skill.enabled)
          .map((skill) => ({
            name: skill.name,
            displayName: getSkillDisplayName(skill),
            description: getSkillDescription(skill),
          }));
        setSkillSelectorOptions(options);
        setSkillSelectorError(response.unavailableReason);
        setSkillSelectorLoadedSessionId(sessionId);
      })
      .catch((error) => {
        if (skillSelectorRequestIdRef.current !== requestId) {
          return;
        }
        setSkillSelectorOptions([]);
        setSkillSelectorError(
          error instanceof Error ? error.message : String(error),
        );
        setSkillSelectorLoadedSessionId(sessionId);
      })
      .finally(() => {
        if (skillSelectorRequestIdRef.current === requestId) {
          setSkillSelectorLoading(false);
        }
      });
  }, [sessionId, showSkillSelectorPalette, skillSelectorLoadedSessionId]);

  useEffect(() => {
    if (!showSlashPalette) {
      setSelectedSlashCommandIndex(0);
      return;
    }

    setSelectedSlashCommandIndex((current) =>
      Math.min(current, slashPaletteCommands.length - 1),
    );
  }, [showSlashPalette, slashPaletteCommands.length]);

  useEffect(() => {
    if (!showFileMentionPalette) {
      setSelectedFileMentionIndex(0);
      return;
    }

    setSelectedFileMentionIndex((current) =>
      Math.min(current, fileMentionPaletteItems.length - 1),
    );
  }, [showFileMentionPalette, fileMentionPaletteItems.length]);

  useEffect(() => {
    if (!showSkillSelectorPalette) {
      setSelectedSkillSelectorIndex(0);
      return;
    }

    setSelectedSkillSelectorIndex((current) =>
      Math.min(current, Math.max(0, skillSelectorPaletteSize - 1)),
    );
  }, [showSkillSelectorPalette, skillSelectorPaletteSize]);

  useEffect(() => {
    if (
      !showSlashPalette &&
      !showFileMentionPalette &&
      !showSkillSelectorPalette
    ) {
      return;
    }

    const handlePointerDownOutside = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (!composerContainerRef.current?.contains(target)) {
        if (showSlashPalette) {
          setSlashPaletteDismissed(true);
        }
        if (showFileMentionPalette && activeFileMention) {
          setDismissedFileMentionQuery(activeFileMention.query);
        }
        if (showSkillSelectorPalette && activeSkillSelector) {
          setDismissedSkillSelectorQuery(activeSkillSelector.query);
        }
      }
    };

    document.addEventListener("mousedown", handlePointerDownOutside);
    document.addEventListener("touchstart", handlePointerDownOutside);
    return () => {
      document.removeEventListener("mousedown", handlePointerDownOutside);
      document.removeEventListener("touchstart", handlePointerDownOutside);
    };
  }, [
    activeFileMention,
    activeSkillSelector,
    showFileMentionPalette,
    showSkillSelectorPalette,
    showSlashPalette,
  ]);

  const insertSelectedFileMention = useCallback(
    (path: string) => {
      if (!activeFileMention) {
        return;
      }

      const needsQuotes = path.split("").some((char) => /\s/u.test(char));
      const inserted = needsQuotes && !path.includes('"') ? `"${path}"` : path;
      const nextDraft = `${draft.slice(0, activeFileMention.start)}${inserted} ${draft.slice(activeFileMention.end)}`;
      const nextCursor = activeFileMention.start + inserted.length + 1;
      setDraft(nextDraft);
      if (historyNavigation.index !== null) {
        setHistoryNavigation({
          index: null,
          draftBeforeNavigation: "",
        });
      }
      setCursorPosition(nextCursor);
      setDismissedFileMentionQuery(null);
      setSelectedFileMentionIndex(0);

      window.requestAnimationFrame(() => {
        const textarea = composerTextareaRef.current;
        if (!textarea) {
          return;
        }
        textarea.focus();
        textarea.setSelectionRange(nextCursor, nextCursor);
      });
    },
    [activeFileMention, draft, historyNavigation.index],
  );

  const insertSelectedSkillSelector = useCallback(
    (skillName: string) => {
      if (!activeSkillSelector) {
        return;
      }

      const inserted = `$${skillName}`;
      const nextDraft = `${draft.slice(0, activeSkillSelector.start)}${inserted} ${draft.slice(activeSkillSelector.end)}`;
      const nextCursor = activeSkillSelector.start + inserted.length + 1;
      setDraft(nextDraft);
      if (historyNavigation.index !== null) {
        setHistoryNavigation({
          index: null,
          draftBeforeNavigation: "",
        });
      }
      setCursorPosition(nextCursor);
      setDismissedSkillSelectorQuery(null);
      setSelectedSkillSelectorIndex(0);

      window.requestAnimationFrame(() => {
        const textarea = composerTextareaRef.current;
        if (!textarea) {
          return;
        }
        textarea.focus();
        textarea.setSelectionRange(nextCursor, nextCursor);
      });
    },
    [activeSkillSelector, draft, historyNavigation.index],
  );

  const executeSlashCommand = useCallback(
    async (
      command: SlashCommandDefinition,
      args: string,
      options?: { fromPalette?: boolean },
    ): Promise<void> => {
      if (command.name === "/mention") {
        const mentionQuery = args.trim();
        const nextDraft = mentionQuery ? `@${mentionQuery}` : "@";
        setDraft(nextDraft);
        setCursorPosition(nextDraft.length);
        setHistoryNavigation({
          index: null,
          draftBeforeNavigation: "",
        });
        setSlashPaletteDismissed(true);
        setSelectedSlashCommandIndex(0);
        setDismissedFileMentionQuery(null);
        setSelectedFileMentionIndex(0);
        setDismissedSkillSelectorQuery(null);
        setSelectedSkillSelectorIndex(0);

        window.requestAnimationFrame(() => {
          const textarea = composerTextareaRef.current;
          if (!textarea) {
            return;
          }
          textarea.focus();
          textarea.setSelectionRange(nextDraft.length, nextDraft.length);
        });
        return;
      }

      if (options?.fromPalette && command.supportsInlineArgs) {
        const nextDraft = `${command.name} `;
        setDraft(nextDraft);
        setCursorPosition(nextDraft.length);
        setHistoryNavigation({
          index: null,
          draftBeforeNavigation: "",
        });
        setSlashPaletteDismissed(true);
        setSelectedSlashCommandIndex(0);
        return;
      }

      const handled = await onRunSlashCommand(command.name, args);
      if (handled) {
        clearAfterSendSuccess();
      }
    },
    [clearAfterSendSuccess, onRunSlashCommand],
  );

  const handleSendMessage = useCallback(
    async (trigger: ComposerSendTrigger = "other") => {
      if (!hasMessageContent) {
        return;
      }

      let imageDataUrls: string[] = [];
      try {
        imageDataUrls = await Promise.all(
          normalizedImageFiles.map((file) => fileToDataUrl(file)),
        );
      } catch {
        return;
      }

      const sent = await onSendMessage({ text: draft, images: imageDataUrls });
      if (!sent) {
        return;
      }

      clearAfterSendSuccess();
      if (trigger === "textarea-enter" || trigger === "send-button") {
        focusComposerInput();
      }
    },
    [
      clearAfterSendSuccess,
      draft,
      focusComposerInput,
      hasMessageContent,
      normalizedImageFiles,
      onSendMessage,
    ],
  );
  const handleIdlePrimaryAction = useCallback(
    async (trigger: ComposerSendTrigger = "other") => {
      if (!onIdlePrimaryAction) {
        return;
      }

      let imageDataUrls: string[] = [];
      try {
        imageDataUrls = await Promise.all(
          normalizedImageFiles.map((file) => fileToDataUrl(file)),
        );
      } catch {
        return;
      }

      const handled = await onIdlePrimaryAction({
        text: draft,
        images: imageDataUrls,
      });
      if (!handled) {
        return;
      }

      clearAfterSendSuccess();
      if (trigger === "textarea-enter" || trigger === "send-button") {
        focusComposerInput();
      }
    },
    [
      clearAfterSendSuccess,
      draft,
      focusComposerInput,
      normalizedImageFiles,
      onIdlePrimaryAction,
    ],
  );
  const navigateInputHistory = useCallback(
    (direction: "up" | "down") => {
      if (history.length === 0) {
        return;
      }

      if (direction === "up") {
        if (historyNavigation.index === null) {
          const nextDraft = history[history.length - 1];
          setHistoryNavigation({
            index: history.length - 1,
            draftBeforeNavigation: draft,
          });
          setDraft(nextDraft);
          setCursorPosition(nextDraft.length);
          return;
        }

        if (historyNavigation.index > 0) {
          const nextIndex = historyNavigation.index - 1;
          const nextDraft = history[nextIndex];
          setHistoryNavigation((current) => ({
            ...current,
            index: nextIndex,
          }));
          setDraft(nextDraft);
          setCursorPosition(nextDraft.length);
        }
        return;
      }

      if (historyNavigation.index === null) {
        return;
      }

      if (historyNavigation.index < history.length - 1) {
        const nextIndex = historyNavigation.index + 1;
        const nextDraft = history[nextIndex];
        setHistoryNavigation((current) => ({
          ...current,
          index: nextIndex,
        }));
        setDraft(nextDraft);
        setCursorPosition(nextDraft.length);
        return;
      }

      const restoredDraft = historyNavigation.draftBeforeNavigation;
      setHistoryNavigation({
        index: null,
        draftBeforeNavigation: "",
      });
      setDraft(restoredDraft);
      setCursorPosition(restoredDraft.length);
    },
    [draft, history, historyNavigation],
  );

  return (
    <>
      <div
        onPointerDown={onResizeMessageBoxStart}
        className="group flex cursor-ns-resize select-none items-end justify-center touch-action-none pt-1 pb-0.5"
      >
        <div className="w-8 h-0.5 rounded-full bg-zinc-600 group-hover:bg-zinc-400 transition-colors" />
      </div>
      <div className="flex items-end gap-1.5">
        <div
          ref={composerContainerRef}
          className="relative flex-1"
          onDragEnter={handleComposerDragEnter}
          onDragOver={handleComposerDragOver}
          onDragLeave={handleComposerDragLeave}
          onDrop={handleComposerDrop}
        >
          {imageAttachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2 rounded border border-zinc-800 bg-zinc-900/40 p-2">
              {imageAttachments.map((attachment, index) => (
                <div
                  key={attachment.id}
                  className="group relative overflow-hidden rounded-md border border-zinc-700/70 bg-zinc-950"
                >
                  <img
                    src={attachment.previewUrl}
                    alt={`Attached image ${index + 1}`}
                    className="h-20 w-20 object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeImageAttachment(attachment.id)}
                    disabled={isSendingLocked || composerBusy}
                    className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900/85 text-zinc-200 opacity-0 transition-opacity group-hover:opacity-100 disabled:opacity-60"
                    title="Remove image"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {isDragActive && (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded border border-cyan-500/70 bg-cyan-600/10 text-xs text-cyan-200">
              <span className="inline-flex items-center gap-1.5">
                <ImagePlus className="h-3.5 w-3.5" />
                Drop images to attach
              </span>
            </div>
          )}
          {showSlashPalette && (
            <SlashCommandPalette
              commands={slashPaletteCommands}
              selectedIndex={selectedSlashCommandIndex}
              onSelect={(command) => {
                void executeSlashCommand(command, "", { fromPalette: true });
              }}
            />
          )}
          {showFileMentionPalette && (
            <ComposerPicker
              ariaLabel="Project files"
              items={fileMentionPaletteItems}
              selectedIndex={selectedFileMentionIndex}
              onSelect={(item) => {
                if (!isFileMentionPlaceholderItem(item.id)) {
                  insertSelectedFileMention(item.id);
                }
              }}
            />
          )}
          {showSkillSelectorPalette &&
            (filteredSkillSelectorOptions.length > 0 ? (
              <SkillSelectorPalette
                skills={filteredSkillSelectorOptions.map((skill) => ({
                  name: skill.name,
                  description: skill.description ?? undefined,
                }))}
                selectedIndex={selectedSkillSelectorIndex}
                onSelect={(skill) => {
                  insertSelectedSkillSelector(skill.name);
                }}
              />
            ) : (
              <ComposerPicker
                ariaLabel="Skills"
                items={skillSelectorPlaceholderItems}
                selectedIndex={selectedSkillSelectorIndex}
                onSelect={(item) => {
                  if (!isSkillSelectorPlaceholderItem(item.id)) {
                    insertSelectedSkillSelector(item.id);
                  }
                }}
              />
            ))}
          <textarea
            ref={composerTextareaRef}
            value={draft}
            onChange={(event) => {
              const nextDraft = event.target.value;
              if (historyNavigation.index !== null) {
                setHistoryNavigation({
                  index: null,
                  draftBeforeNavigation: "",
                });
              }
              if (slashPaletteDismissed && nextDraft !== draft) {
                setSlashPaletteDismissed(false);
              }
              if (dismissedFileMentionQuery !== null && nextDraft !== draft) {
                setDismissedFileMentionQuery(null);
              }
              if (dismissedSkillSelectorQuery !== null && nextDraft !== draft) {
                setDismissedSkillSelectorQuery(null);
              }
              setDraft(nextDraft);
              setCursorPosition(
                event.target.selectionStart ?? nextDraft.length,
              );
            }}
            onSelect={(event) => {
              setCursorPosition(
                event.currentTarget.selectionStart ??
                  event.currentTarget.value.length,
              );
            }}
            onKeyUp={(event) => {
              setCursorPosition(
                event.currentTarget.selectionStart ??
                  event.currentTarget.value.length,
              );
            }}
            disabled={composerBusy}
            onKeyDown={(event) => {
              if (showFileMentionPalette) {
                if (event.key === "Escape") {
                  event.preventDefault();
                  if (activeFileMention) {
                    setDismissedFileMentionQuery(activeFileMention.query);
                  }
                  return;
                }

                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSelectedFileMentionIndex((current) =>
                    current >= fileMentionPaletteItems.length - 1
                      ? 0
                      : current + 1,
                  );
                  return;
                }

                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSelectedFileMentionIndex((current) =>
                    current <= 0
                      ? fileMentionPaletteItems.length - 1
                      : current - 1,
                  );
                  return;
                }

                if (
                  (event.key === "Enter" || event.key === "Tab") &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  const selectedPath =
                    fileMentionPaletteItems[selectedFileMentionIndex]?.id ??
                    fileMentionPaletteItems[0]?.id;
                  if (!selectedPath) {
                    event.preventDefault();
                    return;
                  }
                  if (isFileMentionPlaceholderItem(selectedPath)) {
                    event.preventDefault();
                    return;
                  }
                  if (selectedPath) {
                    event.preventDefault();
                    insertSelectedFileMention(selectedPath);
                    return;
                  }
                }
              }

              if (showSkillSelectorPalette) {
                if (event.key === "Escape") {
                  event.preventDefault();
                  if (activeSkillSelector) {
                    setDismissedSkillSelectorQuery(activeSkillSelector.query);
                  }
                  return;
                }

                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSelectedSkillSelectorIndex((current) =>
                    current >= skillSelectorPaletteSize - 1 ? 0 : current + 1,
                  );
                  return;
                }

                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSelectedSkillSelectorIndex((current) =>
                    current <= 0 ? skillSelectorPaletteSize - 1 : current - 1,
                  );
                  return;
                }

                if (
                  (event.key === "Enter" || event.key === "Tab") &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  const selectedSkill =
                    filteredSkillSelectorOptions[selectedSkillSelectorIndex]
                      ?.name ?? filteredSkillSelectorOptions[0]?.name;
                  if (selectedSkill) {
                    event.preventDefault();
                    insertSelectedSkillSelector(selectedSkill);
                    return;
                  }

                  const selectedPlaceholderId =
                    skillSelectorPlaceholderItems[selectedSkillSelectorIndex]
                      ?.id ?? skillSelectorPlaceholderItems[0]?.id;
                  if (
                    selectedPlaceholderId &&
                    isSkillSelectorPlaceholderItem(selectedPlaceholderId)
                  ) {
                    event.preventDefault();
                    return;
                  }
                }
              }

              if (showSlashPalette) {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setSlashPaletteDismissed(true);
                  return;
                }

                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSelectedSlashCommandIndex((current) =>
                    current >= slashPaletteCommands.length - 1
                      ? 0
                      : current + 1,
                  );
                  return;
                }

                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSelectedSlashCommandIndex((current) =>
                    current <= 0
                      ? slashPaletteCommands.length - 1
                      : current - 1,
                  );
                  return;
                }

                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  const selectedCommand =
                    slashPaletteCommands[selectedSlashCommandIndex] ??
                    slashPaletteCommands[0];
                  if (selectedCommand) {
                    event.preventDefault();
                    void executeSlashCommand(selectedCommand, "", {
                      fromPalette: true,
                    });
                    return;
                  }
                }
              }

              const selectionStart = event.currentTarget.selectionStart;
              const selectionEnd = event.currentTarget.selectionEnd;
              const hasSelection = selectionStart !== selectionEnd;

              if (event.key === "ArrowUp" && !hasSelection) {
                const isOnFirstLine = !event.currentTarget.value
                  .slice(0, selectionStart)
                  .includes("\n");
                if (isOnFirstLine) {
                  event.preventDefault();
                  navigateInputHistory("up");
                  return;
                }
              }

              if (event.key === "ArrowDown" && !hasSelection) {
                const isOnLastLine = !event.currentTarget.value
                  .slice(selectionStart)
                  .includes("\n");
                if (isOnLastLine) {
                  event.preventDefault();
                  navigateInputHistory("down");
                  return;
                }
              }

              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                const invocation = parseSlashCommandInvocation(
                  draft,
                  slashCommands,
                );
                if (invocation) {
                  void executeSlashCommand(invocation.command, invocation.args);
                  return;
                }
                if (hasIdlePrimaryAction) {
                  void handleIdlePrimaryAction("textarea-enter");
                  return;
                }
                void handleSendMessage("textarea-enter");
              }
            }}
            onPaste={handleComposerPaste}
            placeholder="Message Codex..."
            rows={2}
            style={{ height: `${messageBoxHeight}px` }}
            className="block w-full min-h-[36px] resize-none rounded border border-zinc-800 bg-zinc-900/70 px-3 py-1.5 text-sm text-zinc-200 focus:outline-none"
          />
        </div>
        <div className="relative flex">
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleMobileFileInputChange}
            className="hidden"
          />
          <input
            ref={galleryInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleMobileFileInputChange}
            className="hidden"
          />
          {isMobilePhone && showMobileAttachMenu && (
            <div className="absolute bottom-12 right-0 z-30 min-w-[9rem] rounded-lg border border-zinc-700 bg-zinc-900/95 p-1.5 shadow-xl">
              <button
                type="button"
                onClick={handleOpenCameraPicker}
                disabled={isSendingLocked || composerBusy}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
              >
                <Camera className="h-3.5 w-3.5" />
                Camera
              </button>
              <button
                type="button"
                onClick={handleOpenGalleryPicker}
                disabled={isSendingLocked || composerBusy}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
              >
                <Images className="h-3.5 w-3.5" />
                Photos
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              if (isMobilePhone) {
                setShowMobileAttachMenu((value) => !value);
                return;
              }
              handleOpenGalleryPicker();
            }}
            disabled={isSendingLocked || composerBusy}
            className="flex h-9 w-9 items-center justify-center rounded border border-zinc-700 bg-zinc-900/80 text-zinc-200"
            title="Attach image"
            aria-label="Attach image"
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
              <circle cx="9" cy="10" r="1.6" />
              <path d="M5.5 17.5l4.6-4.8a1 1 0 011.46.02l2.3 2.45a1 1 0 001.45.03l1.6-1.6a1 1 0 011.41 0l2.2 2.2" />
            </svg>
          </button>
        </div>
        <button
          onMouseDown={(event) => {
            if (event.button === 0) {
              event.preventDefault();
            }
          }}
          onClick={() => {
            if (shouldUseStopAction) {
              void onStopConversation();
              return;
            }
            if (hasIdlePrimaryAction) {
              void handleIdlePrimaryAction("send-button");
              return;
            }
            void handleSendMessage("send-button");
          }}
          disabled={
            shouldUseStopAction
              ? stoppingTurn
              : hasIdlePrimaryAction
                ? idlePrimaryActionBusy ||
                  (!allowIdlePrimaryActionWithoutContent && !hasMessageContent)
                : sendingMessage || !hasMessageContent
          }
          className={`flex h-9 items-center justify-center rounded px-3.5 text-sm text-zinc-50 disabled:opacity-50 cursor-pointer ${
            shouldUseStopAction
              ? "bg-red-700/90 hover:bg-red-700"
              : isGeneratingForSelectedSession
                ? "bg-zinc-700/85 hover:bg-zinc-600"
                : "bg-cyan-700/80 hover:bg-cyan-700"
          }`}
        >
          {shouldUseStopAction
            ? stoppingTurn
              ? "Stopping..."
              : "Stop"
            : hasIdlePrimaryAction
              ? idlePrimaryActionBusy
                ? (idlePrimaryActionBusyLabel ??
                  `${idlePrimaryActionButtonLabel}...`)
                : idlePrimaryActionButtonLabel
              : sendingMessage
                ? "Sending..."
                : "Send"}
        </button>
      </div>
    </>
  );
});

export default function CodexDeckApp() {
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const root = document.documentElement;
    let animationFrameId: number | null = null;
    const settleTimeoutIds = new Set<number>();
    const SETTLE_DELAYS_MS = [120, 320];

    const syncViewportMetrics = () => {
      animationFrameId = null;
      const viewport = window.visualViewport;
      const layoutViewportHeight = window.innerHeight;
      const viewportHeight = viewport ? viewport.height : layoutViewportHeight;
      const viewportOffsetTop = viewport ? viewport.offsetTop : 0;
      const viewportOffsetBottom = Math.max(
        0,
        layoutViewportHeight - (viewportHeight + viewportOffsetTop),
      );

      if (Number.isFinite(layoutViewportHeight) && layoutViewportHeight > 0) {
        root.style.setProperty(
          "--app-viewport-height",
          `${Math.round(layoutViewportHeight)}px`,
        );
      }

      root.style.setProperty(
        "--app-viewport-offset-top",
        `${Math.max(0, Math.round(viewportOffsetTop))}px`,
      );
      root.style.setProperty(
        "--app-viewport-offset-bottom",
        `${Math.max(0, Math.round(viewportOffsetBottom))}px`,
      );
    };

    const scheduleViewportSync = () => {
      if (animationFrameId !== null) {
        return;
      }
      animationFrameId = window.requestAnimationFrame(syncViewportMetrics);
    };

    const scheduleViewportSyncWithSettling = () => {
      scheduleViewportSync();
      for (const delayMs of SETTLE_DELAYS_MS) {
        const timeoutId = window.setTimeout(() => {
          settleTimeoutIds.delete(timeoutId);
          scheduleViewportSync();
        }, delayMs);
        settleTimeoutIds.add(timeoutId);
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        scheduleViewportSyncWithSettling();
      }
    };

    scheduleViewportSyncWithSettling();
    window.addEventListener("resize", scheduleViewportSyncWithSettling);
    window.addEventListener(
      "orientationchange",
      scheduleViewportSyncWithSettling,
    );
    window.addEventListener("focus", scheduleViewportSyncWithSettling);
    window.addEventListener("pageshow", scheduleViewportSyncWithSettling);
    document.addEventListener("focusin", scheduleViewportSyncWithSettling);
    document.addEventListener("focusout", scheduleViewportSyncWithSettling);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.visualViewport?.addEventListener("resize", scheduleViewportSync);
    window.visualViewport?.addEventListener("scroll", scheduleViewportSync);

    return () => {
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
      for (const timeoutId of settleTimeoutIds) {
        window.clearTimeout(timeoutId);
      }
      settleTimeoutIds.clear();
      window.removeEventListener("resize", scheduleViewportSyncWithSettling);
      window.removeEventListener(
        "orientationchange",
        scheduleViewportSyncWithSettling,
      );
      window.removeEventListener("focus", scheduleViewportSyncWithSettling);
      window.removeEventListener("pageshow", scheduleViewportSyncWithSettling);
      document.removeEventListener("focusin", scheduleViewportSyncWithSettling);
      document.removeEventListener(
        "focusout",
        scheduleViewportSyncWithSettling,
      );
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.visualViewport?.removeEventListener(
        "resize",
        scheduleViewportSync,
      );
      window.visualViewport?.removeEventListener(
        "scroll",
        scheduleViewportSync,
      );
    };
  }, []);

  const remoteBootstrap = useMemo(() => loadRemoteBootstrapConfig(), []);
  const isAdminRoute = useMemo(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.location.pathname.startsWith("/admin");
  }, []);
  const [themePreference, setThemePreference] = useState<ThemePreference>(() =>
    typeof window === "undefined"
      ? "system"
      : readStoredThemePreference(window.localStorage),
  );
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() =>
    getSystemPrefersDark(),
  );
  const resolvedTheme = useMemo(
    () => resolveThemePreference(themePreference, systemPrefersDark),
    [systemPrefersDark, themePreference],
  );

  useEffect(() => {
    applyResolvedTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    persistThemePreference(window.localStorage, themePreference);
  }, [themePreference]);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleThemeMediaChange = (
      event?: MediaQueryListEvent | MediaQueryList,
    ) => {
      setSystemPrefersDark(event ? event.matches : mediaQuery.matches);
    };

    handleThemeMediaChange(mediaQuery);
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleThemeMediaChange);
      return () => {
        mediaQuery.removeEventListener("change", handleThemeMediaChange);
      };
    }

    mediaQuery.addListener(handleThemeMediaChange);
    return () => {
      mediaQuery.removeListener(handleThemeMediaChange);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== THEME_STORAGE_KEY) {
        return;
      }
      setThemePreference(readStoredThemePreference(window.localStorage));
    };

    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const handleToggleTheme = useCallback(() => {
    setThemePreference((currentPreference) =>
      getNextThemePreference(currentPreference, systemPrefersDark),
    );
  }, [systemPrefersDark]);

  if (isAdminRoute) {
    return (
      <RemoteAdminApp
        serverUrl={
          remoteBootstrap.serverUrl ||
          (typeof window !== "undefined" ? window.location.origin : "")
        }
      />
    );
  }

  const [connectionMode, setConnectionMode] = useState<"local" | "remote">(
    remoteBootstrap.enabled ? "remote" : "local",
  );
  const [remoteServerUrl, setRemoteServerUrl] = useState(
    remoteBootstrap.serverUrl,
  );
  const [remoteUsername, setRemoteUsername] = useState("");
  const [remotePassword, setRemotePassword] = useState("");
  const [connectingRemote, setConnectingRemote] = useState(false);
  const [restoringRemoteLogin, setRestoringRemoteLogin] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [remoteAutoRestoreServerUrl, setRemoteAutoRestoreServerUrl] = useState<
    string | null
  >(null);
  const [remoteMachines, setRemoteMachines] = useState<
    RemoteMachineDescription[]
  >([]);
  const [selectedRemoteMachine, setSelectedRemoteMachine] = useState<
    string | null
  >(null);
  const [remoteLatencyLoggingEnabled, setRemoteLatencyLoggingEnabledState] =
    useState<boolean>(() => isRemoteLatencyLoggingEnabled());

  const [sessions, setSessions] = useState<Session[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [terminals, setTerminals] = useState<TerminalSummary[]>([]);
  const [selectedTerminalProject, setSelectedTerminalProject] = useState<
    string | null
  >(null);
  const [pendingTerminalSelectionId, setPendingTerminalSelectionId] = useState<
    string | null
  >(null);
  const [selectedTerminalId, setSelectedTerminalId] = useState<string | null>(
    null,
  );
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [selectedWorkflowProject, setSelectedWorkflowProject] = useState<
    string | null
  >(null);
  const [selectedWorkflowKey, setSelectedWorkflowKey] = useState<string | null>(
    null,
  );
  const [pendingWorkflowSelectionKey, setPendingWorkflowSelectionKey] =
    useState<string | null>(null);
  const [selectedWorkflowTaskId, setSelectedWorkflowTaskId] = useState<
    string | null
  >(null);
  const [selectedSessionWorkflowMatch, setSelectedSessionWorkflowMatch] =
    useState<WorkflowSessionLookupResponse | null>(null);
  const [sessionWorkflowRolesById, setSessionWorkflowRolesById] = useState<
    Record<string, WorkflowSessionRole | null>
  >({});
  const [sessionTerminalRolesById, setSessionTerminalRolesById] = useState<
    Record<string, TerminalSessionRoleSummary | null>
  >({});
  const [workflowDetail, setWorkflowDetail] =
    useState<WorkflowDetailResponse | null>(null);
  const [workflowDetailLoading, setWorkflowDetailLoading] = useState(false);
  const [workflowDetailError, setWorkflowDetailError] = useState<string | null>(
    null,
  );
  const [workflowLog, setWorkflowLog] = useState<WorkflowLogResponse | null>(
    null,
  );
  const [workflowLogLoading, setWorkflowLogLoading] = useState(false);
  const [workflowLogError, setWorkflowLogError] = useState<string | null>(null);
  const [workflowDaemonStatus, setWorkflowDaemonStatus] =
    useState<WorkflowDaemonStatusResponse | null>(null);
  const [workflowActionBusy, setWorkflowActionBusy] = useState(false);
  const [workflowActionLabel, setWorkflowActionLabel] = useState<string | null>(
    null,
  );
  const [workflowActionResultLabel, setWorkflowActionResultLabel] = useState<
    string | null
  >(null);
  const [workflowActionResultOutput, setWorkflowActionResultOutput] = useState<
    string | null
  >(null);
  const [workflowStopHint, setWorkflowStopHint] = useState<string | null>(null);
  const [showWorkflowCreateModal, setShowWorkflowCreateModal] = useState(false);
  const [showWorkflowIdPromptModal, setShowWorkflowIdPromptModal] =
    useState(false);
  const [workflowSkillInstallPrompt, setWorkflowSkillInstallPrompt] = useState<{
    projectRoot: string;
  } | null>(null);
  const [terminalSkillInstallPrompt, setTerminalSkillInstallPrompt] = useState<{
    projectRoot: string;
  } | null>(null);
  const [terminalBindingBusy, setTerminalBindingBusy] = useState(false);
  const [workflowIdPromptDraft, setWorkflowIdPromptDraft] = useState("");
  const [workflowCreateProjectRoot, setWorkflowCreateProjectRoot] =
    useState("");
  const [workflowCreateTitle, setWorkflowCreateTitle] = useState("");
  const [workflowCreateRequest, setWorkflowCreateRequest] = useState("");
  const [workflowCreateId, setWorkflowCreateId] = useState("");
  const [workflowCreateTargetBranch, setWorkflowCreateTargetBranch] =
    useState("");
  const [workflowCreateTaskCount, setWorkflowCreateTaskCount] = useState("1");
  const [workflowCreateMaxParallel, setWorkflowCreateMaxParallel] =
    useState("1");
  const [workflowCreateTasksJson, setWorkflowCreateTasksJson] = useState("");
  const [workflowCreateSequential, setWorkflowCreateSequential] =
    useState(false);
  const [workflowCreateMode, setWorkflowCreateMode] = useState<
    "chat" | "manual"
  >("chat");
  const [workflowCreateChatSessionId, setWorkflowCreateChatSessionId] =
    useState<string | null>(null);
  const [workflowCreateChatProjectRoot, setWorkflowCreateChatProjectRoot] =
    useState("");
  const [workflowCreateChatInput, setWorkflowCreateChatInput] = useState("");
  const [workflowCreateWaitingDotCount, setWorkflowCreateWaitingDotCount] =
    useState(0);
  const [
    workflowCreateChatPreviewMessage,
    setWorkflowCreateChatPreviewMessage,
  ] = useState<ConversationMessage | null>(null);
  const [workflowCreateChatPendingTurnId, setWorkflowCreateChatPendingTurnId] =
    useState<string | null>(null);
  const [workflowCreateImportedDraft, setWorkflowCreateImportedDraft] =
    useState<StrictTaskCreateImportedDraft | null>(null);
  const [workflowLatestSessionPreview, setWorkflowLatestSessionPreview] =
    useState<{
      sessionId: string | null;
      message: ConversationMessage | null;
    }>({
      sessionId: null,
      message: null,
    });
  const [
    workflowLatestSessionPreviewLoading,
    setWorkflowLatestSessionPreviewLoading,
  ] = useState(false);
  const [terminalEmbeddedMessages, setTerminalEmbeddedMessages] = useState<{
    sessionId: string | null;
    messages: Array<{
      messageKey: string;
      message: ConversationMessage;
    }>;
    persistedStepStatesByMessageKey: Record<
      string,
      Record<string, AiTerminalStepState | undefined>
    >;
  }>({
    sessionId: null,
    messages: [],
    persistedStepStatesByMessageKey: {},
  });
  const [terminalEmbeddedMessagesLoading, setTerminalEmbeddedMessagesLoading] =
    useState(false);
  const terminalEmbeddedRawMessagesRef = useRef<ConversationMessage[]>([]);
  const [centerView, setCenterView] = useState<CenterViewMode>("session");
  const [loading, setLoading] = useState(true);
  const [loadingTerminals, setLoadingTerminals] = useState(true);
  const [loadingWorkflows, setLoadingWorkflows] = useState(true);
  const [isMobilePhone, setIsMobilePhone] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [leftPaneWidth, setLeftPaneWidth] = useState(LEFT_PANE_DEFAULT_WIDTH);
  const [diffPaneCollapsed, setDiffPaneCollapsed] = useState(true);
  const [rightPaneWidth, setRightPaneWidth] = useState(
    RIGHT_PANE_DEFAULT_WIDTH,
  );
  const [selectedPaneMode, setSelectedPaneMode] =
    useState<RightPaneMode>("unstaged");
  const [sessionDiff, setSessionDiff] = useState<SessionDiffResponse | null>(
    null,
  );
  const [sessionFileTreeNodes, setSessionFileTreeNodes] =
    useState<SessionFileTreeNodesResponse | null>(null);
  const [sessionFileTreeLoadingMore, setSessionFileTreeLoadingMore] =
    useState(false);
  const [sessionFileContent, setSessionFileContent] =
    useState<SessionFileContentResponse | null>(null);
  const [selectedDiffFilePath, setSelectedDiffFilePath] = useState<
    string | null
  >(null);
  const [loadingSessionDiff, setLoadingSessionDiff] = useState(false);
  const [sessionDiffError, setSessionDiffError] = useState<string | null>(null);
  const [terminalRuns, setTerminalRuns] = useState<SessionTerminalRunSummary[]>(
    [],
  );
  const [loadingTerminalRuns, setLoadingTerminalRuns] = useState(false);
  const [terminalRunsError, setTerminalRunsError] = useState<string | null>(
    null,
  );
  const [selectedTerminalRunId, setSelectedTerminalRunId] = useState<
    string | null
  >(null);
  const [terminalRunOutput, setTerminalRunOutput] = useState("");
  const [loadingTerminalRunOutput, setLoadingTerminalRunOutput] =
    useState(false);
  const [terminalRunOutputError, setTerminalRunOutputError] = useState<
    string | null
  >(null);
  const [terminalRunOutputIsRunning, setTerminalRunOutputIsRunning] =
    useState(false);
  const [terminalRunsRefreshVersion, setTerminalRunsRefreshVersion] =
    useState(0);
  const [sessionSkills, setSessionSkills] =
    useState<SessionSkillsResponse | null>(null);
  const [loadingSessionSkills, setLoadingSessionSkills] = useState(false);
  const [sessionSkillsError, setSessionSkillsError] = useState<string | null>(
    null,
  );
  const [selectedSkillPath, setSelectedSkillPath] = useState<string | null>(
    null,
  );
  const [updatingSkillPath, setUpdatingSkillPath] = useState<string | null>(
    null,
  );
  const [skillsRefreshVersion, setSkillsRefreshVersion] = useState(0);
  const [loadingSessionFileContent, setLoadingSessionFileContent] =
    useState(false);
  const [sessionFileContentError, setSessionFileContentError] = useState<
    string | null
  >(null);
  const [selectedFileContentPage, setSelectedFileContentPage] = useState(1);
  const [selectedFileTargetLine, setSelectedFileTargetLine] = useState<
    number | null
  >(null);
  const [filePathLinkRevealVersion, setFilePathLinkRevealVersion] = useState(0);
  const [copied, setCopied] = useState(false);
  const [conversationSearchOpen, setConversationSearchOpen] = useState(false);
  const [conversationSearchQuery, setConversationSearchQuery] = useState("");
  const [conversationSearchStatus, setConversationSearchStatus] =
    useState<SessionSearchStatus>({
      totalMatches: 0,
      activeMatchIndex: null,
    });
  const [models, setModels] = useState<CodexModelOption[]>([]);
  const [configDefaults, setConfigDefaults] =
    useState<CodexConfigDefaultsResponse>({
      model: null,
      reasoningEffort: null,
      planModeReasoningEffort: null,
    });
  const [collaborationModes, setCollaborationModes] = useState<
    CodexCollaborationModeOption[]
  >([]);
  const [sessionModeById, setSessionModeById] = useState<
    Record<string, CollaborationModeKey>
  >(() => loadSessionModeMap());
  const [selectedModeKey, setSelectedModeKey] =
    useState<CollaborationModeKey>(DEFAULT_MODE_KEY);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [selectedEffort, setSelectedEffort] = useState<
    CodexReasoningEffort | ""
  >("");
  const [messageHistoryBySession, setMessageHistoryBySession] = useState<
    Record<string, string[]>
  >(() => loadMessageHistoryMap());
  const [pendingUserMessagesBySession, setPendingUserMessagesBySession] =
    useState<Record<string, PendingUserMessage[]>>({});
  const [newSessionCwdState, setNewSessionCwdState] =
    useState<NewSessionCwdState>(EMPTY_NEW_SESSION_CWD_STATE);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [stoppingTurn, setStoppingTurn] = useState(false);
  const [pendingTurn, setPendingTurn] = useState<PendingTurn | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);
  const [interactionError, setInteractionError] = useState<string | null>(null);
  const [commandNotice, setCommandNotice] = useState<string | null>(null);
  const [railCollapsedByDefault, setRailCollapsedByDefault] = useState(true);
  const [threadNameOverrides, setThreadNameOverrides] = useState<
    Record<string, string>
  >({});
  const [fixingDangling, setFixingDangling] = useState(false);
  const [showFixDanglingConfirm, setShowFixDanglingConfirm] = useState(false);
  const [fixDanglingTargetSessionId, setFixDanglingTargetSessionId] = useState<
    string | null
  >(null);
  const [waitSilenceStartedAt, setWaitSilenceStartedAt] = useState<
    number | null
  >(null);
  const [showFixDangling, setShowFixDangling] = useState(false);
  const [deletingSession, setDeletingSession] = useState(false);
  const [deleteSessionTargetId, setDeleteSessionTargetId] = useState<
    string | null
  >(null);
  const [deletingWorkflow, setDeletingWorkflow] = useState(false);
  const [deleteWorkflowTargetId, setDeleteWorkflowTargetId] = useState<
    string | null
  >(null);
  const newSessionCwd = newSessionCwdState.value;
  const [deletingTerminal, setDeletingTerminal] = useState(false);
  const [deleteTerminalTargetId, setDeleteTerminalTargetId] = useState<
    string | null
  >(null);
  const [messageBoxHeight, setMessageBoxHeight] = useState(
    MESSAGE_BOX_DEFAULT_HEIGHT,
  );
  const [contextLeftPercent, setContextLeftPercent] = useState<number | null>(
    null,
  );
  const [contextUsedTokens, setContextUsedTokens] = useState<number | null>(
    null,
  );
  const [contextModelWindow, setContextModelWindow] = useState<number | null>(
    null,
  );
  const isPageVisible = usePageVisibility();
  const remoteAuthenticated = isRemoteAccountAuthenticated();
  const remoteConnected = isRemoteTransportEnabled();
  const remoteLoginBusy = connectingRemote || restoringRemoteLogin;
  const remoteLoginTarget = useMemo(
    () => resolveRemoteLoginTarget(remoteServerUrl, remoteBootstrap),
    [remoteBootstrap, remoteServerUrl],
  );
  const resolvedRemoteServerUrl = remoteLoginTarget.serverUrl;
  const remoteTrustPins = remoteLoginTarget.pins;
  const apiReady = connectionMode === "local" || remoteConnected;
  const [contextRefreshVersion, setContextRefreshVersion] = useState(0);
  const [isTouchResizeOverlayVisible, setIsTouchResizeOverlayVisible] =
    useState(false);
  const [isToolbarCompact, setIsToolbarCompact] = useState(false);
  const [isToolbarControlsExpanded, setIsToolbarControlsExpanded] =
    useState(false);
  const [showCollabModePicker, setShowCollabModePicker] = useState(false);
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renamingSession, setRenamingSession] = useState(false);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [showWorkflowDangerConfirm, setShowWorkflowDangerConfirm] = useState<{
    action: "merge-apply" | "daemon-stop";
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);
  const [loadingAgentThreads, setLoadingAgentThreads] = useState(false);
  const [agentThreadsError, setAgentThreadsError] = useState<string | null>(
    null,
  );
  const [agentThreads, setAgentThreads] = useState<CodexThreadSummary[]>([]);
  const [statusTokenUsage, setStatusTokenUsage] =
    useState<TokenUsageSummary | null>(null);
  const waitSuppressSessionsRef = useRef<Set<string>>(new Set());
  const workflowCreateChatPollTimeoutRef = useRef<number | null>(null);
  const workflowCreateChatPollResolveRef = useRef<(() => void) | null>(null);
  const workflowCreateChatAbortRequestedRef = useRef(false);
  const workflowCreateChatRequestIdRef = useRef(0);
  const workflowCreateChatActiveSessionIdRef = useRef<string | null>(null);
  const workflowSkillInstallPromptResolveRef = useRef<
    ((choice: WorkflowSkillInstallChoice) => void) | null
  >(null);
  const terminalSkillInstallPromptResolveRef = useRef<
    ((choice: TerminalSkillInstallChoice) => void) | null
  >(null);
  const resizeStateRef = useRef<ResizeState | null>(null);
  const paneResizeStateRef = useRef<PaneResizeState | null>(null);
  const leftPaneWidthRef = useRef(leftPaneWidth);
  const rightPaneWidthRef = useRef(rightPaneWidth);
  const sidebarCollapsedRef = useRef(sidebarCollapsed);
  const diffPaneCollapsedRef = useRef(diffPaneCollapsed);
  const pendingFilePathLinkTargetRef = useRef<string | null>(null);
  const resizeScrollLockRef = useRef<{
    bodyTouchAction: string;
    bodyOverflow: string;
    bodyOverscrollBehavior: string;
    htmlTouchAction: string;
    htmlOverflow: string;
    htmlOverscrollBehavior: string;
  } | null>(null);
  const sessionSelectionRequestIdRef = useRef(0);
  const activeWaitSessionRef = useRef<string | null>(null);
  const pendingTurnRef = useRef<PendingTurn | null>(null);
  const toolbarWidthRef = useRef<HTMLDivElement | null>(null);
  const toolbarMeasureRef = useRef<HTMLDivElement | null>(null);
  const modelSelectRef = useRef<HTMLSelectElement | null>(null);
  const compactModelSelectRef = useRef<HTMLSelectElement | null>(null);
  const sessionListSearchInputRef = useRef<HTMLInputElement | null>(null);
  const conversationSearchInputRef = useRef<HTMLInputElement | null>(null);
  const sessionViewRef = useRef<SessionViewHandle | null>(null);
  const commandNoticeTimeoutRef = useRef<number | null>(null);
  const waitStateSyncTimeoutRef = useRef<number | null>(null);
  const pageClientIdRef = useRef(createPageClientId());
  const confirmedComposerUserMessageCountBySessionRef = useRef<
    Record<string, number>
  >({});
  const ignoredPendingConfirmationCountBySessionRef = useRef<
    Record<string, number>
  >({});
  const lastPageVisibilityRef = useRef(isPageVisible);
  const workflowLogRequestIdRef = useRef(0);
  const daemonCommandHistoryLoggedRef = useRef<Map<string, Set<string>>>(
    new Map(),
  );

  const hideConversationSearch = useCallback(() => {
    setConversationSearchOpen(false);
  }, []);

  const resetConversationSearch = useCallback(() => {
    setConversationSearchOpen(false);
    setConversationSearchQuery("");
    setConversationSearchStatus({
      totalMatches: 0,
      activeMatchIndex: null,
    });
  }, []);

  useEffect(() => {
    resetConversationSearch();
  }, [centerView, resetConversationSearch, selectedSession]);

  useEffect(() => {
    if (!conversationSearchOpen) {
      return;
    }

    const animationFrameId = requestAnimationFrame(() => {
      conversationSearchInputRef.current?.focus();
      conversationSearchInputRef.current?.select();
    });

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [conversationSearchOpen]);

  const handleNavigateConversationSearch = useCallback(
    (direction: "previous" | "next") => {
      sessionViewRef.current?.navigateConversationSearchMatch(direction);
    },
    [],
  );

  const handleToggleConversationSearch = useCallback(() => {
    setConversationSearchOpen((current) => !current);
  }, []);

  useEffect(() => {
    const previousVisibility = lastPageVisibilityRef.current;
    if (previousVisibility === isPageVisible) {
      return;
    }

    lastPageVisibilityRef.current = isPageVisible;
    console.log(
      `[codex-deck] page became ${isPageVisible ? "visible" : "invisible"}`,
    );
  }, [isPageVisible]);

  useEffect(() => {
    return subscribeRemoteTransport(() => {
      setRemoteMachines(getRemoteMachines());
      setSelectedRemoteMachine(getSelectedRemoteMachineId());
      setRemoteLatencyLoggingEnabledState(isRemoteLatencyLoggingEnabled());
    });
  }, []);

  useEffect(() => {
    if (!remoteAuthenticated) {
      return;
    }
    void refreshRemoteMachines()
      .then((machines) => {
        setRemoteMachines(machines);
        setSelectedRemoteMachine(getSelectedRemoteMachineId());
      })
      .catch((error) => {
        console.error(error);
      });
  }, [remoteAuthenticated]);

  useEffect(() => {
    setRemoteAutoRestoreServerUrl(null);
  }, [remoteServerUrl]);

  const resetRemoteBrowsingState = useCallback(() => {
    setSessions([]);
    setProjects([]);
    setSelectedProject(null);
    setSelectedSession(null);
    setWorkflows([]);
    setSelectedWorkflowProject(null);
    setSelectedWorkflowKey(null);
    setWorkflowDetail(null);
    setWorkflowLog(null);
    setWorkflowDaemonStatus(null);
    setCenterView("session");
    setLoading(true);
    setLoadingWorkflows(true);
  }, []);

  useEffect(() => {
    if (
      connectionMode !== "remote" ||
      remoteAuthenticated ||
      remoteLoginBusy ||
      resolvedRemoteServerUrl.trim().length === 0 ||
      !hasSavedRemoteAccount(resolvedRemoteServerUrl) ||
      remoteAutoRestoreServerUrl === resolvedRemoteServerUrl
    ) {
      return;
    }

    let cancelled = false;
    setRemoteAutoRestoreServerUrl(resolvedRemoteServerUrl);
    setRestoringRemoteLogin(true);
    setRemoteError(null);
    setInteractionError(null);

    void restoreSavedRemoteAccount(resolvedRemoteServerUrl, remoteTrustPins)
      .then((machines) => {
        if (cancelled || !machines) {
          return;
        }
        setRemoteMachines(machines);
        setSelectedRemoteMachine(getSelectedRemoteMachineId());
        resetRemoteBrowsingState();
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setRemoteError(message);
        setInteractionError(message);
      })
      .finally(() => {
        if (!cancelled) {
          setRestoringRemoteLogin(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    connectionMode,
    remoteAuthenticated,
    remoteLoginBusy,
    remoteAutoRestoreServerUrl,
    resolvedRemoteServerUrl,
    remoteTrustPins,
    resetRemoteBrowsingState,
  ]);

  const showCommandNoticeForDuration = useCallback(
    (message: string, durationMs: number = 2000) => {
      setCommandNotice(message);
      if (commandNoticeTimeoutRef.current !== null) {
        window.clearTimeout(commandNoticeTimeoutRef.current);
      }
      commandNoticeTimeoutRef.current = window.setTimeout(() => {
        setCommandNotice(null);
        commandNoticeTimeoutRef.current = null;
      }, durationMs);
    },
    [],
  );

  const handleLoginRemote = useCallback(async () => {
    if (connectingRemote) {
      return;
    }
    const isFirstLoginToServer =
      resolvedRemoteServerUrl.trim().length > 0 &&
      !hasSavedRemoteAccount(resolvedRemoteServerUrl);
    const hasRealmPin = remoteTrustPins.realmId !== null;
    const hasOpaqueServerKeyPin =
      remoteTrustPins.opaqueServerPublicKey !== null;
    const hasBootstrapPinHintsInRawInput =
      rawInputIncludesBootstrapPinHints(remoteServerUrl);
    const needsTofuConfirm =
      isFirstLoginToServer &&
      !hasRealmPin &&
      !hasOpaqueServerKeyPin &&
      !hasBootstrapPinHintsInRawInput;
    if (needsTofuConfirm) {
      const confirmed =
        typeof window === "undefined"
          ? true
          : window.confirm(
              "First login is using TOFU (no pinned Realm ID / OPAQUE Server Key).\n\nA fake server could be trusted on first contact.\n\nContinue anyway?",
            );
      if (!confirmed) {
        return;
      }
    }

    setConnectingRemote(true);
    setRemoteError(null);
    setInteractionError(null);

    try {
      const machines = await loginRemoteWithCredentials(
        resolvedRemoteServerUrl,
        remoteUsername,
        remotePassword,
        remoteTrustPins,
      );
      setConnectionMode("remote");
      setRemoteAutoRestoreServerUrl(resolvedRemoteServerUrl);
      setRemoteMachines(machines);
      setSelectedRemoteMachine(getSelectedRemoteMachineId());
      setRemotePassword("");
      resetRemoteBrowsingState();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRemoteError(message);
      setInteractionError(message);
    } finally {
      setConnectingRemote(false);
    }
  }, [
    connectingRemote,
    remotePassword,
    resolvedRemoteServerUrl,
    remoteTrustPins,
    remoteUsername,
    resetRemoteBrowsingState,
  ]);

  const handleRemoteLoginSubmit = useCallback(
    (event: ReactFormEvent) => {
      event.preventDefault();
      void handleLoginRemote();
    },
    [handleLoginRemote],
  );

  const handleDisconnectRemote = useCallback(async () => {
    await disconnectRemoteTransport();
    setRemoteMachines([]);
    setSelectedRemoteMachine(null);
    setRemotePassword("");
    setRemoteAutoRestoreServerUrl(null);
    setRemoteError(null);
    setInteractionError(null);
    setConnectionMode("remote");
    resetRemoteBrowsingState();
  }, [resetRemoteBrowsingState]);

  const handleChooseRemoteMachine = useCallback((machineId: string | null) => {
    setSelectedRemoteMachineId(machineId);
    setSelectedRemoteMachine(machineId);
  }, []);

  const handleSelectRemoteMachine = useCallback(
    async (machineId: string | null) => {
      if (machineId === null) {
        handleChooseRemoteMachine(null);
        resetRemoteBrowsingState();
        return;
      }

      const targetMachine = remoteMachines.find(
        (machine) => machine.id === machineId,
      );
      if (!targetMachine) {
        return;
      }

      handleChooseRemoteMachine(machineId);
      resetRemoteBrowsingState();
    },
    [handleChooseRemoteMachine, remoteMachines, resetRemoteBrowsingState],
  );

  const handleToggleRemoteLatencyLogging = useCallback((enabled: boolean) => {
    setRemoteLatencyLoggingEnabled(enabled);
    setRemoteLatencyLoggingEnabledState(enabled);
  }, []);

  const cancelWorkflowCreateChatPolling = useCallback(() => {
    if (workflowCreateChatPollTimeoutRef.current !== null) {
      window.clearTimeout(workflowCreateChatPollTimeoutRef.current);
      workflowCreateChatPollTimeoutRef.current = null;
    }
    const resolve = workflowCreateChatPollResolveRef.current;
    if (resolve) {
      workflowCreateChatPollResolveRef.current = null;
      resolve();
    }
  }, []);

  const isWorkflowCreateChatRequestCurrent = useCallback(
    (requestId: number) =>
      workflowCreateChatRequestIdRef.current === requestId &&
      !workflowCreateChatAbortRequestedRef.current,
    [],
  );

  useEffect(
    () => () => {
      if (commandNoticeTimeoutRef.current !== null) {
        window.clearTimeout(commandNoticeTimeoutRef.current);
      }
      if (waitStateSyncTimeoutRef.current !== null) {
        window.clearTimeout(waitStateSyncTimeoutRef.current);
      }
      cancelWorkflowCreateChatPolling();
    },
    [cancelWorkflowCreateChatPolling],
  );

  const clearScheduledWaitStateSync = useCallback(() => {
    if (waitStateSyncTimeoutRef.current !== null) {
      window.clearTimeout(waitStateSyncTimeoutRef.current);
      waitStateSyncTimeoutRef.current = null;
    }
  }, []);

  const removeSessionFromLocalState = useCallback((sessionId: string) => {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return;
    }

    waitSuppressSessionsRef.current.delete(normalizedSessionId);
    setSessions((current) =>
      current.filter((session) => session.id !== normalizedSessionId),
    );
    setThreadNameOverrides((current) => {
      if (!(normalizedSessionId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[normalizedSessionId];
      return next;
    });
    setMessageHistoryBySession((current) => {
      if (!(normalizedSessionId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[normalizedSessionId];
      return next;
    });
    setPendingUserMessagesBySession((current) => {
      if (!(normalizedSessionId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[normalizedSessionId];
      return next;
    });
    if (
      normalizedSessionId in
      confirmedComposerUserMessageCountBySessionRef.current
    ) {
      delete confirmedComposerUserMessageCountBySessionRef.current[
        normalizedSessionId
      ];
    }
    if (
      normalizedSessionId in ignoredPendingConfirmationCountBySessionRef.current
    ) {
      delete ignoredPendingConfirmationCountBySessionRef.current[
        normalizedSessionId
      ];
    }
    setSessionModeById((current) => {
      if (!(normalizedSessionId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[normalizedSessionId];
      return next;
    });
    setPendingTurn((current) =>
      current?.sessionId === normalizedSessionId ? null : current,
    );
    setDeleteSessionTargetId((current) =>
      current === normalizedSessionId ? null : current,
    );
    setSelectedSession((current) =>
      current === normalizedSessionId ? null : current,
    );
  }, []);

  const notifyDeletedSessionAndCleanup = useCallback(
    (sessionId: string) => {
      if (typeof window !== "undefined") {
        window.alert(
          "This session was deleted. It will be removed from this page.",
        );
      }
      removeSessionFromLocalState(sessionId);
    },
    [removeSessionFromLocalState],
  );

  const notifySessionUnavailable = useCallback(() => {
    if (typeof window !== "undefined") {
      window.alert("This session does not exist.");
    }
  }, []);

  const ensureSessionExistsForUse = useCallback(
    async (sessionId: string): Promise<boolean> => {
      const normalizedSessionId = sessionId.trim();
      if (!normalizedSessionId) {
        return false;
      }

      try {
        const response = await getSessionExists(normalizedSessionId);
        if (response.exists) {
          return true;
        }

        notifySessionUnavailable();
        return false;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isSessionUnavailableMessage(message)) {
          notifySessionUnavailable();
          return false;
        }
        return true;
      }
    },
    [notifySessionUnavailable],
  );

  useEffect(() => {
    const updateMobilePhoneState = () => {
      setIsMobilePhone(detectMobilePhone());
    };

    updateMobilePhoneState();
    window.addEventListener("resize", updateMobilePhoneState);
    window.addEventListener("orientationchange", updateMobilePhoneState);
    return () => {
      window.removeEventListener("resize", updateMobilePhoneState);
      window.removeEventListener("orientationchange", updateMobilePhoneState);
    };
  }, []);

  useEffect(() => {
    if (!isMobilePhone) {
      return;
    }
    if (!sidebarCollapsed && !diffPaneCollapsed) {
      setDiffPaneCollapsed(true);
    }
  }, [isMobilePhone, sidebarCollapsed, diffPaneCollapsed]);

  useEffect(() => {
    pendingTurnRef.current = pendingTurn;
  }, [pendingTurn]);

  useEffect(() => {
    leftPaneWidthRef.current = leftPaneWidth;
  }, [leftPaneWidth]);

  useEffect(() => {
    rightPaneWidthRef.current = rightPaneWidth;
  }, [rightPaneWidth]);

  useEffect(() => {
    sidebarCollapsedRef.current = sidebarCollapsed;
  }, [sidebarCollapsed]);

  useEffect(() => {
    diffPaneCollapsedRef.current = diffPaneCollapsed;
  }, [diffPaneCollapsed]);

  const getMessageBoxMaxHeight = useCallback(() => {
    if (typeof window === "undefined") {
      return MESSAGE_BOX_MAX_HEIGHT;
    }

    const viewportLimited = Math.floor(window.innerHeight * 0.6);
    return Math.max(
      MESSAGE_BOX_MIN_HEIGHT,
      Math.min(MESSAGE_BOX_MAX_HEIGHT, viewportLimited),
    );
  }, []);

  const lockBodyScrollForResize = useCallback(() => {
    if (typeof document === "undefined" || resizeScrollLockRef.current) {
      return;
    }

    resizeScrollLockRef.current = {
      bodyTouchAction: document.body.style.touchAction,
      bodyOverflow: document.body.style.overflow,
      bodyOverscrollBehavior: document.body.style.overscrollBehavior,
      htmlTouchAction: document.documentElement.style.touchAction,
      htmlOverflow: document.documentElement.style.overflow,
      htmlOverscrollBehavior: document.documentElement.style.overscrollBehavior,
    };
    document.body.style.touchAction = "none";
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";
    document.documentElement.style.touchAction = "none";
    document.documentElement.style.overflow = "hidden";
    document.documentElement.style.overscrollBehavior = "none";
  }, []);

  const unlockBodyScrollForResize = useCallback(() => {
    if (typeof document === "undefined" || !resizeScrollLockRef.current) {
      return;
    }

    document.body.style.touchAction =
      resizeScrollLockRef.current.bodyTouchAction;
    document.body.style.overflow = resizeScrollLockRef.current.bodyOverflow;
    document.body.style.overscrollBehavior =
      resizeScrollLockRef.current.bodyOverscrollBehavior;
    document.documentElement.style.touchAction =
      resizeScrollLockRef.current.htmlTouchAction;
    document.documentElement.style.overflow =
      resizeScrollLockRef.current.htmlOverflow;
    document.documentElement.style.overscrollBehavior =
      resizeScrollLockRef.current.htmlOverscrollBehavior;
    resizeScrollLockRef.current = null;
  }, []);

  const handleResizeMessageBoxMoveByClientY = useCallback(
    (clientY: number) => {
      const state = resizeStateRef.current;
      if (!state) {
        return;
      }

      const delta = state.startY - clientY;
      const maxHeight = getMessageBoxMaxHeight();
      const nextHeight = Math.max(
        MESSAGE_BOX_MIN_HEIGHT,
        Math.min(maxHeight, state.startHeight + delta),
      );
      setMessageBoxHeight(nextHeight);
    },
    [getMessageBoxMaxHeight],
  );

  const handleResizeMessageBoxMove = useCallback(
    (event: PointerEvent) => {
      const state = resizeStateRef.current;
      if (!state) {
        return;
      }
      if (event.pointerId !== state.pointerId) {
        return;
      }

      event.preventDefault();
      handleResizeMessageBoxMoveByClientY(event.clientY);
    },
    [handleResizeMessageBoxMoveByClientY],
  );

  const handleWindowTouchMoveWhileResizing = useCallback(
    (event: TouchEvent) => {
      const state = resizeStateRef.current;
      if (!state || state.pointerType !== "touch") {
        return;
      }

      const touch = event.touches[0];
      if (!touch) {
        return;
      }

      event.preventDefault();
      handleResizeMessageBoxMoveByClientY(touch.clientY);
    },
    [handleResizeMessageBoxMoveByClientY],
  );

  const stopResizeMessageBox = useCallback(() => {
    resizeStateRef.current = null;
    setIsTouchResizeOverlayVisible(false);
    unlockBodyScrollForResize();
    window.removeEventListener("pointermove", handleResizeMessageBoxMove);
    window.removeEventListener("pointerup", stopResizeMessageBox);
    window.removeEventListener("pointercancel", stopResizeMessageBox);
    window.removeEventListener("touchmove", handleWindowTouchMoveWhileResizing);
    window.removeEventListener("touchend", stopResizeMessageBox);
    window.removeEventListener("touchcancel", stopResizeMessageBox);
  }, [
    handleResizeMessageBoxMove,
    handleWindowTouchMoveWhileResizing,
    unlockBodyScrollForResize,
  ]);

  const handleResizeMessageBoxStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (event.pointerType !== "touch") {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      if (event.pointerType === "touch") {
        setIsTouchResizeOverlayVisible(true);
        lockBodyScrollForResize();
      }
      resizeStateRef.current = {
        startY: event.clientY,
        startHeight: messageBoxHeight,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
      };
      window.addEventListener("pointermove", handleResizeMessageBoxMove);
      window.addEventListener("pointerup", stopResizeMessageBox);
      window.addEventListener("pointercancel", stopResizeMessageBox);
      window.addEventListener("touchmove", handleWindowTouchMoveWhileResizing, {
        passive: false,
      });
      window.addEventListener("touchend", stopResizeMessageBox);
      window.addEventListener("touchcancel", stopResizeMessageBox);
    },
    [
      handleResizeMessageBoxMove,
      handleWindowTouchMoveWhileResizing,
      lockBodyScrollForResize,
      messageBoxHeight,
      stopResizeMessageBox,
    ],
  );

  const handleTouchResizeOverlayPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = resizeStateRef.current;
      if (!state || state.pointerType !== "touch") {
        return;
      }
      if (event.pointerId !== state.pointerId) {
        return;
      }

      event.preventDefault();
      handleResizeMessageBoxMoveByClientY(event.clientY);
    },
    [handleResizeMessageBoxMoveByClientY],
  );

  const handleTouchResizeOverlayPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = resizeStateRef.current;
      if (!state || state.pointerType !== "touch") {
        return;
      }
      if (event.pointerId !== state.pointerId) {
        return;
      }

      event.preventDefault();
      stopResizeMessageBox();
    },
    [stopResizeMessageBox],
  );

  const handleTouchResizeOverlayPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = resizeStateRef.current;
      if (!state || state.pointerType !== "touch") {
        return;
      }
      if (event.pointerId !== state.pointerId) {
        return;
      }

      event.preventDefault();
      stopResizeMessageBox();
    },
    [stopResizeMessageBox],
  );

  useEffect(
    () => () => {
      stopResizeMessageBox();
    },
    [stopResizeMessageBox],
  );

  useEffect(() => {
    const handleViewportResize = () => {
      const nextMaxHeight = getMessageBoxMaxHeight();
      setMessageBoxHeight((current) => Math.min(current, nextMaxHeight));
    };

    handleViewportResize();
    window.addEventListener("resize", handleViewportResize);
    return () => {
      window.removeEventListener("resize", handleViewportResize);
    };
  }, [getMessageBoxMaxHeight]);

  const getLeftPaneMaxWidth = useCallback(() => {
    if (typeof window === "undefined") {
      return LEFT_PANE_MAX_WIDTH;
    }

    const reservedRight = diffPaneCollapsedRef.current
      ? RIGHT_PANE_COLLAPSED_WIDTH
      : rightPaneWidthRef.current;
    const maxByViewport = window.innerWidth - reservedRight;
    return Math.min(
      LEFT_PANE_MAX_WIDTH,
      Math.max(LEFT_PANE_MIN_WIDTH, maxByViewport),
    );
  }, []);

  const getRightPaneMaxWidth = useCallback(() => {
    if (typeof window === "undefined") {
      return RIGHT_PANE_MAX_WIDTH;
    }

    const reservedLeft = sidebarCollapsedRef.current
      ? 0
      : leftPaneWidthRef.current;
    const maxByViewport = window.innerWidth - reservedLeft;
    return Math.min(
      RIGHT_PANE_MAX_WIDTH,
      Math.max(RIGHT_PANE_MIN_WIDTH, maxByViewport),
    );
  }, []);

  const getMobileRightPaneDefaultWidth = useCallback(() => {
    if (typeof window === "undefined") {
      return RIGHT_PANE_DEFAULT_WIDTH;
    }

    const viewportWidth = window.innerWidth;
    const maxWidth = Math.min(
      RIGHT_PANE_MAX_WIDTH,
      Math.max(RIGHT_PANE_MIN_WIDTH, viewportWidth),
    );
    const preferredWidth = Math.max(
      MOBILE_RIGHT_PANE_MIN_OPEN_WIDTH,
      Math.round(viewportWidth * MOBILE_RIGHT_PANE_DEFAULT_RATIO),
    );

    return clampNumber(preferredWidth, RIGHT_PANE_MIN_WIDTH, maxWidth);
  }, []);

  const handlePaneResizeMove = useCallback(
    (event: PointerEvent) => {
      const state = paneResizeStateRef.current;
      if (!state || event.pointerId !== state.pointerId) {
        return;
      }

      event.preventDefault();
      const deltaX = event.clientX - state.startX;

      if (state.target === "left") {
        const next = clampNumber(
          state.startWidth + deltaX,
          LEFT_PANE_MIN_WIDTH,
          getLeftPaneMaxWidth(),
        );
        setLeftPaneWidth(next);
        return;
      }

      const next = clampNumber(
        state.startWidth - deltaX,
        RIGHT_PANE_MIN_WIDTH,
        getRightPaneMaxWidth(),
      );
      setRightPaneWidth(next);
    },
    [getLeftPaneMaxWidth, getRightPaneMaxWidth],
  );

  const stopPaneResize = useCallback(() => {
    paneResizeStateRef.current = null;
    window.removeEventListener("pointermove", handlePaneResizeMove);
    window.removeEventListener("pointerup", stopPaneResize);
    window.removeEventListener("pointercancel", stopPaneResize);
  }, [handlePaneResizeMove]);

  const startPaneResize = useCallback(
    (
      event: ReactPointerEvent<HTMLDivElement>,
      target: "left" | "right",
      width: number,
    ) => {
      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);

      paneResizeStateRef.current = {
        target,
        startX: event.clientX,
        startWidth: width,
        pointerId: event.pointerId,
      };

      window.addEventListener("pointermove", handlePaneResizeMove);
      window.addEventListener("pointerup", stopPaneResize);
      window.addEventListener("pointercancel", stopPaneResize);
    },
    [handlePaneResizeMove, stopPaneResize],
  );

  const handleLeftPaneResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      startPaneResize(event, "left", leftPaneWidth);
    },
    [startPaneResize, leftPaneWidth],
  );

  const handleRightPaneResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      startPaneResize(event, "right", rightPaneWidth);
    },
    [startPaneResize, rightPaneWidth],
  );

  useEffect(
    () => () => {
      stopPaneResize();
    },
    [stopPaneResize],
  );

  useEffect(() => {
    const clampPaneWidths = () => {
      setLeftPaneWidth((current) =>
        clampNumber(current, LEFT_PANE_MIN_WIDTH, getLeftPaneMaxWidth()),
      );
      setRightPaneWidth((current) =>
        clampNumber(current, RIGHT_PANE_MIN_WIDTH, getRightPaneMaxWidth()),
      );
    };

    clampPaneWidths();
    window.addEventListener("resize", clampPaneWidths);
    return () => {
      window.removeEventListener("resize", clampPaneWidths);
    };
  }, [getLeftPaneMaxWidth, getRightPaneMaxWidth]);

  useEffect(() => {
    setLeftPaneWidth((current) =>
      clampNumber(current, LEFT_PANE_MIN_WIDTH, getLeftPaneMaxWidth()),
    );
    setRightPaneWidth((current) =>
      clampNumber(current, RIGHT_PANE_MIN_WIDTH, getRightPaneMaxWidth()),
    );
  }, [
    sidebarCollapsed,
    diffPaneCollapsed,
    getLeftPaneMaxWidth,
    getRightPaneMaxWidth,
  ]);

  const openLeftPane = useCallback(() => {
    setSidebarCollapsed(false);
    if (isMobilePhone) {
      setDiffPaneCollapsed(true);
    }
  }, [isMobilePhone]);

  const openRightPane = useCallback(() => {
    if (isMobilePhone) {
      setRightPaneWidth((current) => {
        if (current > RIGHT_PANE_MIN_WIDTH + 8) {
          return current;
        }
        return getMobileRightPaneDefaultWidth();
      });
    }
    setDiffPaneCollapsed(false);
    if (isMobilePhone) {
      setSidebarCollapsed(true);
    }
  }, [getMobileRightPaneDefaultWidth, isMobilePhone]);

  const handleCopySessionId = useCallback((sessionId: string) => {
    void copyTextToClipboard(sessionId)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch((error) => {
        setInteractionError(
          error instanceof Error ? error.message : String(error),
        );
      });
  }, []);

  const handleCopyProjectPath = useCallback(
    (projectPath: string) => {
      const normalizedProjectPath = projectPath.trim();
      if (!normalizedProjectPath) {
        return;
      }

      void copyTextToClipboard(normalizedProjectPath)
        .then(() => {
          showCommandNoticeForDuration("Copied project path.");
        })
        .catch((error) => {
          setInteractionError(
            error instanceof Error ? error.message : String(error),
          );
        });
    },
    [showCommandNoticeForDuration],
  );

  const sessionsWithThreadNames = useMemo(
    () =>
      sessions.map((session) => {
        const override = threadNameOverrides[session.id]?.trim();
        const terminalRole = sessionTerminalRolesById[session.id] ?? null;
        return {
          ...session,
          display: override || session.display,
          workflowRoleLabel:
            getTerminalSessionRoleLabel(terminalRole) ??
            getWorkflowSessionRoleLabel(
              sessionWorkflowRolesById[session.id] ?? null,
            ),
        };
      }),
    [
      sessionTerminalRolesById,
      sessionWorkflowRolesById,
      sessions,
      threadNameOverrides,
    ],
  );

  const selectedSessionData = useMemo(() => {
    if (!selectedSession) {
      return null;
    }

    return (
      sessionsWithThreadNames.find((s) => s.id === selectedSession) || null
    );
  }, [sessionsWithThreadNames, selectedSession]);
  const selectedSessionTerminalRole = selectedSession
    ? (sessionTerminalRolesById[selectedSession] ?? null)
    : null;

  const deleteSessionTargetData = useMemo(() => {
    if (!deleteSessionTargetId) {
      return null;
    }

    return (
      sessionsWithThreadNames.find((s) => s.id === deleteSessionTargetId) ||
      null
    );
  }, [sessionsWithThreadNames, deleteSessionTargetId]);

  const deleteTerminalTargetData = useMemo(() => {
    if (!deleteTerminalTargetId) {
      return null;
    }
    return (
      terminals.find((terminal) => terminal.id === deleteTerminalTargetId) ??
      null
    );
  }, [deleteTerminalTargetId, terminals]);

  const deleteWorkflowTargetData = useMemo(() => {
    if (!deleteWorkflowTargetId) {
      return null;
    }
    return (
      workflows.find((workflow) => workflow.key === deleteWorkflowTargetId) ??
      null
    );
  }, [deleteWorkflowTargetId, workflows]);

  const selectedTerminalData = useMemo(() => {
    if (!selectedTerminalId) {
      return null;
    }
    return (
      terminals.find((terminal) => terminal.id === selectedTerminalId) ?? null
    );
  }, [selectedTerminalId, terminals]);

  const workflowProjects = useMemo(
    () =>
      [...new Set(workflows.map((workflow) => workflow.projectRoot))].sort(),
    [workflows],
  );

  const filteredWorkflows = useMemo(() => {
    if (!selectedWorkflowProject) {
      return workflows;
    }
    return workflows.filter(
      (workflow) => workflow.projectRoot === selectedWorkflowProject,
    );
  }, [selectedWorkflowProject, workflows]);

  const workflowListItems = useMemo(
    () =>
      filteredWorkflows.map((workflow) => ({
        id: workflow.key,
        display: `${workflow.title} · ${workflow.status} · ${workflow.taskCounts.success}/${workflow.taskCounts.total} done${workflow.taskCounts.running > 0 ? ` · ${workflow.taskCounts.running} running` : ""}${workflow.taskCounts.failed > 0 ? ` · ${workflow.taskCounts.failed} failed` : ""}`,
        projectName: workflow.projectName,
        timestamp: Date.parse(workflow.updatedAt || "") || 0,
      })),
    [filteredWorkflows],
  );

  const selectedWorkflowSummary = useMemo(() => {
    return resolveSelectedWorkflowSummary(
      workflows,
      selectedWorkflowKey,
      workflowDetail,
    );
  }, [selectedWorkflowKey, workflowDetail, workflows]);

  const selectedSessionWorkflowShortcut = useMemo(() => {
    if (!selectedSessionWorkflowMatch) {
      return null;
    }

    if (selectedSessionWorkflowMatch.role === "task") {
      return {
        label: "Task Workflow",
        title: selectedSessionWorkflowMatch.taskId
          ? `Open workflow ${selectedSessionWorkflowMatch.workflow.title} for task ${selectedSessionWorkflowMatch.taskId}`
          : `Open workflow ${selectedSessionWorkflowMatch.workflow.title} for this task session`,
      };
    }

    if (selectedSessionWorkflowMatch.role === "scheduler") {
      return {
        label: "Main Workflow",
        title: `Open workflow ${selectedSessionWorkflowMatch.workflow.title} for the scheduler session`,
      };
    }

    return {
      label: "Workflow",
      title: `Open workflow ${selectedSessionWorkflowMatch.workflow.title}`,
    };
  }, [selectedSessionWorkflowMatch]);
  const selectedSessionTerminalShortcut = useMemo(() => {
    const terminalId = selectedSessionTerminalRole?.terminalId?.trim() ?? "";
    if (!terminalId) {
      return null;
    }

    const terminal =
      terminals.find(
        (candidate) =>
          candidate.id === terminalId || candidate.terminalId === terminalId,
      ) ?? null;

    return {
      label: "Terminal",
      title: terminal?.display
        ? `Open terminal ${terminal.display}`
        : `Open terminal ${terminalId}`,
    };
  }, [selectedSessionTerminalRole, terminals]);

  const workflowRightPaneProjectPath =
    workflowDetail?.summary.projectRoot ??
    selectedWorkflowSummary?.projectRoot ??
    null;
  const workflowRightPaneWorkflowKey =
    selectedWorkflowKey ??
    workflowDetail?.summary.key ??
    selectedWorkflowSummary?.key ??
    null;

  const workflowComposerSessionId =
    workflowDetail?.boundSessionId ??
    selectedWorkflowSummary?.boundSessionId ??
    null;
  const terminalComposerSessionId =
    selectedTerminalData?.boundSessionId?.trim() || null;
  const latestTerminalPlanMessageKey = useMemo(() => {
    for (
      let index = terminalEmbeddedMessages.messages.length - 1;
      index >= 0;
      index -= 1
    ) {
      const item = terminalEmbeddedMessages.messages[index];
      const parsed = parseAiTerminalMessage(
        extractConversationMessageText(item.message),
      );
      if (parsed?.directive.kind === "plan") {
        return item.messageKey;
      }
    }
    return null;
  }, [terminalEmbeddedMessages]);
  const terminalEmbeddedMessageCards = useMemo(() => {
    return terminalEmbeddedMessages.messages.map((item) => ({
      ...item,
      isActionable: item.messageKey === latestTerminalPlanMessageKey,
      stepStates:
        terminalEmbeddedMessages.persistedStepStatesByMessageKey[item.messageKey],
    }));
  }, [
    latestTerminalPlanMessageKey,
    terminalEmbeddedMessages,
  ]);
  const activeComposerSessionId =
    centerView === "workflow"
      ? workflowComposerSessionId
      : centerView === "terminal"
        ? terminalComposerSessionId
        : selectedSession;
  const activeWaitSessionId =
    centerView === "workflow"
      ? workflowComposerSessionId
      : centerView === "terminal"
        ? terminalComposerSessionId
        : selectedSession;
  const activeComposerSessionData = useMemo(() => {
    if (!activeComposerSessionId) {
      return null;
    }
    return (
      sessionsWithThreadNames.find(
        (session) => session.id === activeComposerSessionId,
      ) ?? null
    );
  }, [activeComposerSessionId, sessionsWithThreadNames]);
  const workflowComposerProjectRoot =
    workflowDetail?.summary.projectRoot ??
    selectedWorkflowSummary?.projectRoot ??
    null;
  const workflowComposerSlashCommands = useMemo(
    () => getWorkflowComposerSlashCommands(workflowComposerSessionId),
    [workflowComposerSessionId],
  );

  const rightPaneTarget = useMemo<RightPaneTarget>(() => {
    return resolveRightPaneTarget({
      centerView,
      selectedSessionId: selectedSession,
      terminalSessionId: terminalComposerSessionId,
      workflowProjectPath: workflowRightPaneProjectPath,
      workflowKey: workflowRightPaneWorkflowKey,
    });
  }, [
    centerView,
    selectedSession,
    terminalComposerSessionId,
    workflowRightPaneProjectPath,
    workflowRightPaneWorkflowKey,
  ]);

  const rightPaneSessionId =
    rightPaneTarget?.kind === "session"
      ? rightPaneTarget.sessionId
      : rightPaneTarget?.kind === "workflow-project"
        ? rightPaneTarget.projectPath
        : null;

  useEffect(() => {
    activeWaitSessionRef.current = activeWaitSessionId;
  }, [activeWaitSessionId]);

  const rightPaneSessionData = useMemo(() => {
    if (!rightPaneSessionId || rightPaneTarget?.kind !== "session") {
      return null;
    }
    return (
      sessionsWithThreadNames.find((s) => s.id === rightPaneSessionId) || null
    );
  }, [rightPaneSessionId, rightPaneTarget, sessionsWithThreadNames]);
  const rightPaneRefreshToken =
    rightPaneTarget?.kind === "session"
      ? rightPaneSessionData?.timestamp
      : (selectedWorkflowSummary?.updatedAt ??
        workflowDetail?.summary.updatedAt ??
        null);
  const rightPaneDataKey =
    rightPaneTarget === null
      ? null
      : `${rightPaneTarget.kind}:${
          rightPaneTarget.kind === "session"
            ? rightPaneTarget.sessionId
            : rightPaneTarget.workflowKey
        }:${selectedPaneMode}`;
  const previousRightPaneDataKeyRef = useRef<string | null>(null);

  const handleChangePaneMode = useCallback((mode: RightPaneMode) => {
    pendingFilePathLinkTargetRef.current = null;
    setSelectedPaneMode(mode);
    setSelectedDiffFilePath(null);
    setSelectedFileTargetLine(null);
    setSessionFileContent(null);
    setSessionFileContentError(null);
    setSelectedFileContentPage(1);

    if (mode === "terminal-flow") {
      setSessionDiff(null);
      setSessionFileTreeNodes(null);
      setSessionFileTreeLoadingMore(false);
      setSessionDiffError(null);
      setLoadingSessionDiff(false);
      setLoadingSessionFileContent(false);
      setSessionSkills(null);
      setLoadingSessionSkills(false);
      setSessionSkillsError(null);
      setSelectedSkillPath(null);
      setUpdatingSkillPath(null);
    } else if (mode === "skills") {
      setSessionDiff(null);
      setSessionFileTreeNodes(null);
      setSessionFileTreeLoadingMore(false);
      setSessionDiffError(null);
      setLoadingSessionDiff(false);
      setLoadingSessionFileContent(false);

      setTerminalRuns([]);
      setLoadingTerminalRuns(false);
      setTerminalRunsError(null);
      setSelectedTerminalRunId(null);
      setTerminalRunOutput("");
      setLoadingTerminalRunOutput(false);
      setTerminalRunOutputError(null);
      setTerminalRunOutputIsRunning(false);
    } else {
      setSessionSkills(null);
      setLoadingSessionSkills(false);
      setSessionSkillsError(null);
      setSelectedSkillPath(null);
      setUpdatingSkillPath(null);

      setTerminalRuns([]);
      setLoadingTerminalRuns(false);
      setTerminalRunsError(null);
      setSelectedTerminalRunId(null);
      setTerminalRunOutput("");
      setLoadingTerminalRunOutput(false);
      setTerminalRunOutputError(null);
      setTerminalRunOutputIsRunning(false);
    }
  }, []);

  const handleSelectDiffFilePath = useCallback((path: string) => {
    pendingFilePathLinkTargetRef.current = null;
    setSelectedDiffFilePath(path);
    setSelectedFileTargetLine(null);
    setSelectedFileContentPage(1);
  }, []);

  const handleOpenFileTreeDirectory = useCallback(
    async (dirPath: string) => {
      if (!rightPaneTarget || sessionFileTreeLoadingMore) {
        return;
      }

      setSessionFileTreeLoadingMore(true);
      setSessionDiffError(null);
      try {
        const response =
          rightPaneTarget.kind === "session"
            ? await getSessionFileTreeNodes(
                rightPaneTarget.sessionId,
                dirPath,
                0,
                600,
              )
            : await getWorkflowProjectFileTreeNodes(
                rightPaneTarget.workflowKey,
                dirPath,
                0,
                600,
              );
        setSessionFileTreeNodes(response);
        setSelectedDiffFilePath((current) => {
          if (!current) {
            return current;
          }
          const stillVisible = response.nodes.some(
            (node) => !node.isDirectory && node.path === current,
          );
          return stillVisible ? current : null;
        });
      } catch (error) {
        setSessionDiffError(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setSessionFileTreeLoadingMore(false);
      }
    },
    [rightPaneTarget, sessionFileTreeLoadingMore],
  );

  const handleLoadMoreFileTreeNodes = useCallback(async () => {
    if (
      !rightPaneTarget ||
      !sessionFileTreeNodes ||
      sessionFileTreeNodes.nextCursor === null ||
      sessionFileTreeLoadingMore
    ) {
      return;
    }

    setSessionFileTreeLoadingMore(true);
    setSessionDiffError(null);
    try {
      const response =
        rightPaneTarget.kind === "session"
          ? await getSessionFileTreeNodes(
              rightPaneTarget.sessionId,
              sessionFileTreeNodes.dir,
              sessionFileTreeNodes.nextCursor,
              600,
            )
          : await getWorkflowProjectFileTreeNodes(
              rightPaneTarget.workflowKey,
              sessionFileTreeNodes.dir,
              sessionFileTreeNodes.nextCursor,
              600,
            );
      setSessionFileTreeNodes((current) => {
        if (!current || current.dir !== response.dir) {
          return response;
        }
        return {
          ...response,
          nodes: [...current.nodes, ...response.nodes],
        };
      });
    } catch (error) {
      setSessionDiffError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setSessionFileTreeLoadingMore(false);
    }
  }, [rightPaneTarget, sessionFileTreeNodes, sessionFileTreeLoadingMore]);

  const handleChangeFileContentPage = useCallback((page: number) => {
    // A file:line jump should focus the line once, but manual paging must win.
    pendingFilePathLinkTargetRef.current = null;
    setSelectedFileTargetLine(null);
    setSelectedFileContentPage(page);
  }, []);

  useEffect(() => {
    pendingFilePathLinkTargetRef.current = null;
  }, [rightPaneSessionId]);

  useEffect(() => {
    if (!rightPaneTarget) {
      previousRightPaneDataKeyRef.current = null;
      setSessionDiff(null);
      setSessionFileTreeNodes(null);
      setSessionFileTreeLoadingMore(false);
      setSessionFileContent(null);
      setSelectedDiffFilePath(null);
      setSessionDiffError(null);
      setSessionFileContentError(null);
      setLoadingSessionDiff(false);
      setLoadingSessionFileContent(false);
      setSelectedFileContentPage(1);
      setSelectedFileTargetLine(null);
      setTerminalRuns([]);
      setLoadingTerminalRuns(false);
      setTerminalRunsError(null);
      setSelectedTerminalRunId(null);
      setTerminalRunOutput("");
      setLoadingTerminalRunOutput(false);
      setTerminalRunOutputError(null);
      setTerminalRunOutputIsRunning(false);
      setSessionSkills(null);
      setLoadingSessionSkills(false);
      setSessionSkillsError(null);
      setSelectedSkillPath(null);
      setUpdatingSkillPath(null);
      return;
    }

    if (selectedPaneMode === "terminal-flow" || selectedPaneMode === "skills") {
      previousRightPaneDataKeyRef.current = null;
      return;
    }

    if (diffPaneCollapsed) {
      previousRightPaneDataKeyRef.current = null;
      return;
    }

    const isHardRightPaneReload =
      previousRightPaneDataKeyRef.current !== rightPaneDataKey;
    previousRightPaneDataKeyRef.current = rightPaneDataKey;
    let cancelled = false;
    setLoadingSessionDiff(true);
    setSessionDiffError(null);
    if (isHardRightPaneReload) {
      setSessionFileContent(null);
      setSessionFileContentError(null);
      setSelectedFileContentPage(1);
    }
    if (isHardRightPaneReload && selectedPaneMode !== "file-tree") {
      setSelectedFileTargetLine(null);
    }

    const loadPromise =
      selectedPaneMode === "file-tree"
        ? (rightPaneTarget.kind === "session"
            ? getSessionFileTreeNodes(rightPaneTarget.sessionId, "", 0, 600)
            : getWorkflowProjectFileTreeNodes(
                rightPaneTarget.workflowKey,
                "",
                0,
                600,
              )
          ).then((response) => {
            if (cancelled) {
              return;
            }
            setSessionDiff(null);
            setSessionFileTreeNodes(response);
            setSelectedDiffFilePath((current) => {
              const pendingFilePathLinkTarget =
                pendingFilePathLinkTargetRef.current;
              if (
                pendingFilePathLinkTarget &&
                current === pendingFilePathLinkTarget
              ) {
                return current;
              }
              if (
                current &&
                response.nodes.some(
                  (node) => !node.isDirectory && node.path === current,
                )
              ) {
                return current;
              }
              const firstFile = response.nodes.find(
                (node) => !node.isDirectory,
              );
              return firstFile?.path ?? null;
            });
          })
        : (rightPaneTarget.kind === "session"
            ? getSessionDiff(
                rightPaneTarget.sessionId,
                selectedPaneMode as Exclude<SessionDiffMode, "file-tree">,
              )
            : getWorkflowProjectDiff(
                rightPaneTarget.workflowKey,
                selectedPaneMode as Exclude<SessionDiffMode, "file-tree">,
              )
          ).then((response) => {
            if (cancelled) {
              return;
            }
            setSessionFileTreeNodes(null);
            setSessionDiff(response);
            setSelectedDiffFilePath((current) => {
              if (
                current &&
                response.files.some((file) => file.path === current)
              ) {
                return current;
              }
              return response.files[0]?.path ?? null;
            });
          });

    loadPromise
      .catch((error) => {
        if (cancelled) {
          return;
        }

        if (isHardRightPaneReload) {
          setSessionDiff(null);
          setSessionFileTreeNodes(null);
          setSelectedDiffFilePath(null);
          setSessionDiffError(
            error instanceof Error ? error.message : String(error),
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingSessionDiff(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    rightPaneTarget,
    selectedPaneMode,
    diffPaneCollapsed,
    rightPaneRefreshToken,
    rightPaneDataKey,
  ]);

  useEffect(() => {
    if (
      !rightPaneTarget ||
      diffPaneCollapsed ||
      selectedPaneMode !== "file-tree" ||
      !selectedDiffFilePath
    ) {
      setSessionFileContent(null);
      setSessionFileContentError(null);
      setLoadingSessionFileContent(false);
      return;
    }

    const shouldPreserveExistingFileContent =
      sessionFileContent?.path === selectedDiffFilePath;
    let cancelled = false;
    setLoadingSessionFileContent(true);
    setSessionFileContentError(null);

    (rightPaneTarget.kind === "session"
      ? getSessionFileContent(
          rightPaneTarget.sessionId,
          selectedDiffFilePath,
          selectedFileContentPage,
        )
      : getWorkflowProjectFileContent(
          rightPaneTarget.workflowKey,
          selectedDiffFilePath,
          selectedFileContentPage,
        )
    )
      .then((response) => {
        if (cancelled) {
          return;
        }
        setSessionFileContent(response);
        if (pendingFilePathLinkTargetRef.current === response.path) {
          pendingFilePathLinkTargetRef.current = null;
        }
        setSelectedFileContentPage(response.page);

        if (
          selectedFileTargetLine !== null &&
          response.paginationMode === "lines" &&
          typeof response.lineStart === "number" &&
          typeof response.lineEnd === "number" &&
          response.lineStart > 0 &&
          response.lineEnd >= response.lineStart
        ) {
          if (
            selectedFileTargetLine < response.lineStart ||
            selectedFileTargetLine > response.lineEnd
          ) {
            const linesPerPage = Math.max(
              1,
              response.lineEnd - response.lineStart + 1,
            );
            const expectedPage = Math.max(
              1,
              Math.floor((selectedFileTargetLine - 1) / linesPerPage) + 1,
            );
            if (expectedPage !== response.page) {
              setSelectedFileContentPage(expectedPage);
            }
          }
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        if (pendingFilePathLinkTargetRef.current === selectedDiffFilePath) {
          pendingFilePathLinkTargetRef.current = null;
        }
        if (!shouldPreserveExistingFileContent) {
          setSessionFileContent(null);
          setSessionFileContentError(
            error instanceof Error ? error.message : String(error),
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingSessionFileContent(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    rightPaneTarget,
    selectedPaneMode,
    selectedDiffFilePath,
    selectedFileContentPage,
    selectedFileTargetLine,
    diffPaneCollapsed,
    rightPaneRefreshToken,
  ]);

  const handleRefreshTerminalRuns = useCallback(() => {
    setTerminalRunsRefreshVersion((value) => value + 1);
  }, []);

  const handleRefreshSkills = useCallback(() => {
    setSkillsRefreshVersion((value) => value + 1);
  }, []);

  const handleToggleSkillEnabled = useCallback(
    async (path: string, enabled: boolean) => {
      if (!rightPaneTarget) {
        return;
      }

      setUpdatingSkillPath(path);
      setSessionSkillsError(null);

      try {
        const response =
          rightPaneTarget.kind === "session"
            ? await setSessionSkillEnabled(rightPaneTarget.sessionId, {
                path,
                enabled,
              })
            : await setWorkflowProjectSkillEnabled(
                rightPaneTarget.workflowKey,
                {
                  path,
                  enabled,
                },
              );
        setSessionSkills((current) => {
          if (!current) {
            return current;
          }
          return {
            ...current,
            skills: current.skills.map((skill) =>
              skill.path === response.path
                ? { ...skill, enabled: response.effectiveEnabled }
                : skill,
            ),
          };
        });
        setSelectedSkillPath(path);
        setSkillsRefreshVersion((value) => value + 1);
      } catch (error) {
        setSessionSkillsError(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setUpdatingSkillPath(null);
      }
    },
    [rightPaneTarget],
  );

  const syncTerminalRunStatus = useCallback(
    (processId: string, isRunning: boolean) => {
      setTerminalRuns((current) =>
        current.map((run) =>
          run.processId === processId ? { ...run, isRunning } : run,
        ),
      );
    },
    [],
  );

  useEffect(() => {
    const requiresSessionMode = selectedPaneMode === "terminal-flow";
    const hasSessionTarget = rightPaneTarget?.kind === "session";

    if (requiresSessionMode && rightPaneTarget && !hasSessionTarget) {
      setTerminalRuns([]);
      setSelectedTerminalRunId(null);
      setTerminalRunsError(
        "Terminal runs are unavailable for workflow project view. Open a workflow session to inspect terminal runs.",
      );
      setLoadingTerminalRuns(false);
      return;
    }

    if (
      !rightPaneTarget ||
      rightPaneTarget.kind !== "session" ||
      diffPaneCollapsed ||
      selectedPaneMode !== "terminal-flow"
    ) {
      setLoadingTerminalRuns(false);
      return;
    }

    let cancelled = false;
    setLoadingTerminalRuns(true);
    setTerminalRunsError(null);

    getSessionTerminalRuns(rightPaneTarget.sessionId)
      .then((response) => {
        if (cancelled) {
          return;
        }
        setTerminalRuns(response.runs);
        setSelectedTerminalRunId((current) => {
          if (
            current &&
            response.runs.some((run) => run.processId === current)
          ) {
            return current;
          }
          return response.runs[0]?.processId ?? null;
        });
        if (response.unavailableReason) {
          setTerminalRunsError(response.unavailableReason);
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setTerminalRuns([]);
        setSelectedTerminalRunId(null);
        setTerminalRunsError(
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingTerminalRuns(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    rightPaneTarget,
    selectedPaneMode,
    diffPaneCollapsed,
    terminalRunsRefreshVersion,
  ]);

  useEffect(() => {
    if (
      !rightPaneTarget ||
      rightPaneTarget.kind !== "session" ||
      diffPaneCollapsed ||
      selectedPaneMode !== "terminal-flow" ||
      !selectedTerminalRunId
    ) {
      setTerminalRunOutput("");
      setTerminalRunOutputError(null);
      setLoadingTerminalRunOutput(false);
      setTerminalRunOutputIsRunning(false);
      return;
    }

    let cancelled = false;
    setLoadingTerminalRunOutput(true);
    setTerminalRunOutputError(null);

    getSessionTerminalRunOutput(
      rightPaneTarget.sessionId,
      selectedTerminalRunId,
    )
      .then((response) => {
        if (cancelled) {
          return;
        }
        setTerminalRunOutput(response.output);
        setTerminalRunOutputIsRunning(response.isRunning);
        syncTerminalRunStatus(selectedTerminalRunId, response.isRunning);
        if (response.unavailableReason) {
          setTerminalRunOutputError(response.unavailableReason);
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setTerminalRunOutput("");
        setTerminalRunOutputIsRunning(false);
        syncTerminalRunStatus(selectedTerminalRunId, false);
        setTerminalRunOutputError(
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingTerminalRunOutput(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    rightPaneTarget,
    selectedPaneMode,
    diffPaneCollapsed,
    selectedTerminalRunId,
    syncTerminalRunStatus,
  ]);

  useEffect(() => {
    if (
      !rightPaneTarget ||
      rightPaneTarget.kind !== "session" ||
      diffPaneCollapsed ||
      selectedPaneMode !== "terminal-flow" ||
      !selectedTerminalRunId ||
      !terminalRunOutputIsRunning ||
      !isPageVisible
    ) {
      return;
    }

    let cancelled = false;
    let inFlight = false;

    const pollOutput = () => {
      if (inFlight) {
        return;
      }
      inFlight = true;

      getSessionTerminalRunOutput(
        rightPaneTarget.sessionId,
        selectedTerminalRunId,
      )
        .then((response) => {
          if (cancelled) {
            return;
          }
          setTerminalRunOutput(response.output);
          setTerminalRunOutputIsRunning(response.isRunning);
          syncTerminalRunStatus(selectedTerminalRunId, response.isRunning);
          setTerminalRunOutputError(response.unavailableReason);
        })
        .catch((error) => {
          if (cancelled) {
            return;
          }
          setTerminalRunOutputIsRunning(false);
          syncTerminalRunStatus(selectedTerminalRunId, false);
          setTerminalRunOutputError(
            error instanceof Error ? error.message : String(error),
          );
        })
        .finally(() => {
          inFlight = false;
        });
    };

    pollOutput();
    const timer = window.setInterval(pollOutput, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    rightPaneTarget,
    selectedPaneMode,
    diffPaneCollapsed,
    selectedTerminalRunId,
    terminalRunOutputIsRunning,
    isPageVisible,
    syncTerminalRunStatus,
  ]);

  useEffect(() => {
    if (
      !rightPaneTarget ||
      diffPaneCollapsed ||
      selectedPaneMode !== "skills"
    ) {
      setLoadingSessionSkills(false);
      return;
    }

    let cancelled = false;
    setLoadingSessionSkills(true);
    setSessionSkillsError(null);

    (rightPaneTarget.kind === "session"
      ? getSessionSkills(rightPaneTarget.sessionId)
      : getWorkflowProjectSkills(rightPaneTarget.workflowKey)
    )
      .then((response) => {
        if (cancelled) {
          return;
        }
        setSessionSkills(response);
        setSelectedSkillPath((current) => {
          if (
            current &&
            response.skills.some((skill) => skill.path === current)
          ) {
            return current;
          }
          return response.skills[0]?.path ?? null;
        });
        if (response.unavailableReason) {
          setSessionSkillsError(response.unavailableReason);
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setSessionSkills(null);
        setSelectedSkillPath(null);
        setSessionSkillsError(
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingSessionSkills(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    rightPaneTarget,
    selectedPaneMode,
    diffPaneCollapsed,
    skillsRefreshVersion,
  ]);

  const syncSessionWaitState = useCallback(
    async (sessionId: string, requestedTurnId?: string | null) => {
      const normalizedSessionId = sessionId.trim();
      if (!normalizedSessionId) {
        return;
      }

      if (waitSuppressSessionsRef.current.has(normalizedSessionId)) {
        return;
      }

      try {
        const state = await getCodexThreadState(
          normalizedSessionId,
          requestedTurnId,
        );
        if (activeWaitSessionRef.current !== normalizedSessionId) {
          return;
        }

        setPendingTurn((current) =>
          reconcilePendingTurnWithThreadState(
            current,
            normalizedSessionId,
            requestedTurnId,
            state,
          ),
        );
      } catch {
        // Ignore transient polling errors.
      }
    },
    [],
  );

  const scheduleSettledWaitStateSync = useCallback(
    (sessionId: string, requestedTurnId?: string | null) => {
      if (typeof window === "undefined") {
        return;
      }

      const normalizedSessionId = sessionId.trim();
      if (!normalizedSessionId) {
        return;
      }

      const normalizedRequestedTurnId =
        typeof requestedTurnId === "string" && requestedTurnId.trim().length > 0
          ? requestedTurnId.trim()
          : null;

      clearScheduledWaitStateSync();
      waitStateSyncTimeoutRef.current = window.setTimeout(() => {
        waitStateSyncTimeoutRef.current = null;
        if (activeWaitSessionRef.current !== normalizedSessionId) {
          return;
        }
        if (
          typeof document !== "undefined" &&
          document.visibilityState !== "visible"
        ) {
          return;
        }
        void syncSessionWaitState(
          normalizedSessionId,
          normalizedRequestedTurnId,
        );
      }, WAIT_STATE_SETTLE_DELAY_MS);
    },
    [clearScheduledWaitStateSync, syncSessionWaitState],
  );

  useEffect(() => {
    if (!apiReady) {
      return;
    }

    listProjects()
      .then(setProjects)
      .catch((error) => {
        console.error(error);
      });
  }, [apiReady]);

  useEffect(() => {
    if (!apiReady) {
      return;
    }

    listActiveTerminals()
      .then((nextTerminals) => {
        setTerminals(nextTerminals);
        setLoadingTerminals(false);
      })
      .catch((error) => {
        console.error(error);
        setLoadingTerminals(false);
      });
  }, [apiReady]);

  useEffect(() => {
    if (!apiReady) {
      return;
    }

    let cancelled = false;

    Promise.all([
      listCodexModels(),
      listCodexCollaborationModes(),
      getCodexConfigDefaults(),
    ])
      .then(([modelsData, collaborationModesData, configDefaultsData]) => {
        if (cancelled) {
          return;
        }

        setModels(modelsData);
        setCollaborationModes(collaborationModesData);
        setConfigDefaults(configDefaultsData);
      })
      .catch((error) => {
        if (!cancelled) {
          setInteractionError(
            error instanceof Error ? error.message : String(error),
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [apiReady]);

  useEffect(() => {
    setNewSessionCwdState((current) =>
      maybeAutoFillNewSessionCwd(current, {
        selectedProject,
        candidates: projects,
      }),
    );
  }, [selectedProject, projects]);

  useEffect(() => {
    setNewSessionCwdState((current) =>
      maybeAutoFillNewSessionCwd(current, {
        selectedProject: selectedTerminalProject,
        candidates: terminals
          .map((terminal) => terminal.project)
          .filter((project) => project.length > 0),
      }),
    );
  }, [selectedTerminalProject, terminals]);

  useEffect(() => {
    if (!activeComposerSessionId) {
      setContextLeftPercent(null);
      setContextUsedTokens(null);
      setContextModelWindow(null);
      setStatusTokenUsage(null);
      return;
    }

    let cancelled = false;
    const delayMs = centerView === "terminal" ? 400 : 0;
    const timer = setTimeout(() => {
      void getSessionContext(activeComposerSessionId)
        .then((context) => {
          if (cancelled) {
            return;
          }
          setContextLeftPercent(context.contextLeftPercent);
          setContextUsedTokens(context.usedTokens);
          setContextModelWindow(context.modelContextWindow);
          setStatusTokenUsage(context.tokenUsage);
        })
        .catch(() => {
          if (cancelled) {
            return;
          }
          setContextLeftPercent(null);
          setContextUsedTokens(null);
          setContextModelWindow(null);
          setStatusTokenUsage(null);
        });
    }, delayMs);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    activeComposerSessionData?.timestamp,
    activeComposerSessionId,
    centerView,
    contextRefreshVersion,
  ]);

  useEffect(() => {
    if (!showStatusModal) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      setShowStatusModal(false);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [showStatusModal]);

  useEffect(() => {
    clearScheduledWaitStateSync();
  }, [selectedSession, clearScheduledWaitStateSync]);

  useEffect(() => {
    if (!showRenameModal) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      if (renamingSession) {
        return;
      }
      setShowRenameModal(false);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [showRenameModal, renamingSession]);

  useEffect(() => {
    if (!showAgentPicker) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      setShowAgentPicker(false);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [showAgentPicker]);

  const handleSessionsFull = useCallback((event: MessageEvent) => {
    const data: Session[] = JSON.parse(event.data);
    setSessions((current) => {
      if (current.length === 0) {
        return data;
      }

      const sessionMap = new Map(
        current.map((session) => [session.id, session]),
      );
      for (const session of data) {
        sessionMap.set(session.id, session);
      }

      return Array.from(sessionMap.values()).sort(
        (left, right) => right.timestamp - left.timestamp,
      );
    });
    setLoading(false);
  }, []);

  const handleSessionsUpdate = useCallback(
    (event: MessageEvent) => {
      const updates: Session[] = JSON.parse(event.data);
      const includesSelectedSession =
        !!selectedSession &&
        updates.some((update) => update.id === selectedSession);

      setSessions((prev) => {
        const sessionMap = new Map(prev.map((s) => [s.id, s]));
        for (const update of updates) {
          sessionMap.set(update.id, update);
        }
        return Array.from(sessionMap.values()).sort(
          (a, b) => b.timestamp - a.timestamp,
        );
      });

      if (includesSelectedSession) {
        setContextRefreshVersion((value) => value + 1);
        if (centerView === "session" && isPageVisible && selectedSession) {
          const requestedTurnId =
            pendingTurnRef.current?.sessionId === selectedSession
              ? pendingTurnRef.current.turnId
              : null;
          void syncSessionWaitState(selectedSession, requestedTurnId);
        }
      }
    },
    [centerView, selectedSession, isPageVisible, syncSessionWaitState],
  );

  const handleSessionsRemoved = useCallback(
    (event: MessageEvent) => {
      const payload = JSON.parse(event.data) as {
        sessionIds?: unknown;
        actorClientId?: unknown;
      };
      const sessionIds = Array.isArray(payload.sessionIds)
        ? payload.sessionIds.filter(
            (sessionId): sessionId is string =>
              typeof sessionId === "string" && sessionId.trim().length > 0,
          )
        : [];

      if (sessionIds.length === 0) {
        return;
      }

      const actorClientId =
        typeof payload.actorClientId === "string"
          ? payload.actorClientId
          : null;
      if (actorClientId !== pageClientIdRef.current) {
        return;
      }

      for (const sessionId of sessionIds) {
        removeSessionFromLocalState(sessionId);
      }
    },
    [removeSessionFromLocalState],
  );

  const handleSkillsChanged = useCallback(
    (event: MessageEvent) => {
      const payload = JSON.parse(event.data) as {
        sessionId?: unknown;
      };
      const sessionId =
        typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
      if (!sessionId) {
        return;
      }

      if (
        rightPaneTarget?.kind !== "session" ||
        rightPaneTarget.sessionId !== sessionId ||
        diffPaneCollapsed ||
        selectedPaneMode !== "skills"
      ) {
        return;
      }

      setSkillsRefreshVersion((value) => value + 1);
    },
    [rightPaneTarget, diffPaneCollapsed, selectedPaneMode],
  );

  const handleSessionsError = useCallback(() => {
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!apiReady || !isPageVisible) {
      return;
    }

    return subscribeSessionsStream({
      onSessions: (sessions) => {
        const event = new MessageEvent("sessions", {
          data: JSON.stringify(sessions),
        });
        handleSessionsFull(event);
      },
      onSessionsUpdate: (sessions) => {
        const event = new MessageEvent("sessionsUpdate", {
          data: JSON.stringify(sessions),
        });
        handleSessionsUpdate(event);
      },
      onSessionsRemoved: (sessionIds) => {
        const event = new MessageEvent("sessionsRemoved", {
          data: JSON.stringify({
            sessionIds,
            actorClientId: pageClientIdRef.current,
          }),
        });
        handleSessionsRemoved(event);
      },
      onSkillsChanged: ({ sessionId }) => {
        const event = new MessageEvent("skillsChanged", {
          data: JSON.stringify({ sessionId }),
        });
        handleSkillsChanged(event);
      },
      onError: handleSessionsError,
    });
  }, [
    apiReady,
    isPageVisible,
    handleSessionsFull,
    handleSessionsRemoved,
    handleSessionsUpdate,
    handleSessionsError,
  ]);

  useEffect(() => {
    if (!apiReady || !isPageVisible) {
      return;
    }

    return subscribeTerminalsStream({
      onTerminals: (nextTerminals) => {
        setTerminals(nextTerminals);
        setLoadingTerminals(false);
      },
      onError: () => {
        setLoadingTerminals(false);
      },
    });
  }, [apiReady, isPageVisible]);

  const { sessionIds, sessionIdsKey } = useMemo(
    () => getStableSessionIds(sessions),
    [sessions],
  );

  const workflowSessionRolesRefreshKey = useMemo(
    () =>
      workflows
        .map(
          (workflow) =>
            `${workflow.key}:${workflow.boundSessionId || ""}:${workflow.schedulerLastSessionId || ""}`,
        )
        .sort()
        .join("|"),
    [workflows],
  );

  useEffect(() => {
    if (sessionIds.length === 0) {
      setThreadNameOverrides({});
      return;
    }

    let cancelled = false;
    getCodexThreadSummaries({ threadIds: sessionIds })
      .then((payload) => {
        if (cancelled) {
          return;
        }

        const namesById = new Map<string, string>();
        for (const thread of payload.threads) {
          const name = thread.name?.trim();
          if (!name) {
            continue;
          }
          namesById.set(thread.threadId, name);
        }

        setThreadNameOverrides((current) => {
          const next: Record<string, string> = {};
          for (const id of sessionIds) {
            const name = namesById.get(id) ?? current[id];
            if (name) {
              next[id] = name;
            }
          }
          return next;
        });
      })
      .catch(() => {
        // Ignore summary refresh failures; session list still works without names.
      });

    return () => {
      cancelled = true;
    };
  }, [sessionIdsKey]);

  useEffect(() => {
    if (sessionIdsKey.length === 0 || workflows.length === 0) {
      setSessionWorkflowRolesById({});
      return;
    }

    if (!apiReady || !isPageVisible) {
      return;
    }

    let cancelled = false;
    getWorkflowSessionRolesRequest(sessionIds)
      .then((roles) => {
        if (cancelled) {
          return;
        }

        const next: Record<string, WorkflowSessionRole | null> = {};
        for (const { sessionId, role } of roles) {
          next[sessionId] = role;
        }
        setSessionWorkflowRolesById(next);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setSessionWorkflowRolesById({});
      });

    return () => {
      cancelled = true;
    };
  }, [
    apiReady,
    isPageVisible,
    sessionIdsKey,
    workflows.length,
    workflowSessionRolesRefreshKey,
  ]);

  useEffect(() => {
    if (sessionIdsKey.length === 0) {
      setSessionTerminalRolesById({});
      return;
    }

    if (!apiReady || !isPageVisible) {
      return;
    }

    let cancelled = false;
    getTerminalSessionRolesRequest(sessionIds)
      .then((roles) => {
        if (cancelled) {
          return;
        }

        const next: Record<string, TerminalSessionRoleSummary | null> = {};
        for (const role of roles) {
          next[role.sessionId] = role;
        }
        setSessionTerminalRolesById(next);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setSessionTerminalRolesById({});
      });

    return () => {
      cancelled = true;
    };
  }, [apiReady, isPageVisible, sessionIds, sessionIdsKey, terminals]);

  const filteredSessions = useMemo(() => {
    if (!selectedProject) {
      return sessionsWithThreadNames;
    }
    return sessionsWithThreadNames.filter((s) => s.project === selectedProject);
  }, [sessionsWithThreadNames, selectedProject]);

  useEffect(() => {
    if (centerView !== "session" || selectedSession) {
      return;
    }

    const firstSessionId = filteredSessions[0]?.id ?? null;
    if (!firstSessionId) {
      return;
    }

    setSelectedSession(firstSessionId);
  }, [centerView, filteredSessions, selectedSession]);

  const terminalProjects = useMemo(
    () => [...new Set(terminals.map((terminal) => terminal.project))].sort(),
    [terminals],
  );

  const filteredTerminals = useMemo(() => {
    if (!selectedTerminalProject) {
      return terminals;
    }
    return terminals.filter(
      (terminal) => terminal.project === selectedTerminalProject,
    );
  }, [terminals, selectedTerminalProject]);

  const terminalListItems = useMemo(
    () =>
      filteredTerminals.map((terminal) => ({
        ...terminal,
        display: terminal.firstCommand?.trim() || terminal.display,
      })),
    [filteredTerminals],
  );

  useEffect(() => {
    const hasPendingSelectedTerminal =
      !!pendingTerminalSelectionId &&
      terminals.some(
        (terminal) =>
          terminal.id === pendingTerminalSelectionId ||
          terminal.terminalId === pendingTerminalSelectionId,
      );

    if (pendingTerminalSelectionId && !hasPendingSelectedTerminal) {
      return;
    }

    if (terminals.length === 0) {
      setSelectedTerminalId(null);
      return;
    }

    if (pendingTerminalSelectionId && hasPendingSelectedTerminal) {
      setPendingTerminalSelectionId(null);
    }

    if (
      selectedTerminalId &&
      terminals.some((terminal) => terminal.id === selectedTerminalId)
    ) {
      return;
    }

    setSelectedTerminalId(terminals[0]?.id ?? null);
  }, [pendingTerminalSelectionId, selectedTerminalId, terminals]);

  useEffect(() => {
    if (!pendingWorkflowSelectionKey) {
      return;
    }

    if (
      selectedWorkflowKey !== pendingWorkflowSelectionKey ||
      workflows.some((workflow) => workflow.key === pendingWorkflowSelectionKey)
    ) {
      setPendingWorkflowSelectionKey(null);
    }
  }, [pendingWorkflowSelectionKey, selectedWorkflowKey, workflows]);

  useEffect(() => {
    const nextSelection = resolveWorkflowSelection({
      workflows,
      selectedWorkflowKey,
      pendingWorkflowKey: pendingWorkflowSelectionKey,
      workflowDetail,
      actionBusy: workflowActionBusy,
    });

    if (nextSelection.shouldClearWorkflowDetail) {
      setSelectedWorkflowKey(null);
      setWorkflowDetail(null);
      return;
    }

    if (nextSelection.nextSelectedWorkflowKey === selectedWorkflowKey) {
      return;
    }

    setSelectedWorkflowKey(nextSelection.nextSelectedWorkflowKey);
  }, [
    pendingWorkflowSelectionKey,
    selectedWorkflowKey,
    workflowActionBusy,
    workflowDetail,
    workflows,
  ]);

  const filteredModels = useMemo(
    () => models.filter((model) => !model.hidden),
    [models],
  );
  const availableModeKeys = useMemo(
    () =>
      new Set(
        collaborationModes
          .map((mode) => mode.mode.trim())
          .filter((mode) => mode.length > 0),
      ),
    [collaborationModes],
  );
  const hasPlanMode = useMemo(
    () => collaborationModes.length === 0 || availableModeKeys.has("plan"),
    [collaborationModes.length, availableModeKeys],
  );
  const normalizeModeKey = useCallback(
    (mode: string | null | undefined): CollaborationModeKey => {
      const normalizedMode = typeof mode === "string" ? mode.trim() : "";
      if (!normalizedMode) {
        return DEFAULT_MODE_KEY;
      }

      if (normalizedMode === "plan" && !hasPlanMode) {
        return DEFAULT_MODE_KEY;
      }

      if (
        collaborationModes.length > 0 &&
        normalizedMode !== DEFAULT_MODE_KEY &&
        !availableModeKeys.has(normalizedMode)
      ) {
        return DEFAULT_MODE_KEY;
      }

      return normalizedMode;
    },
    [availableModeKeys, collaborationModes.length, hasPlanMode],
  );
  const isPlanModeEnabled = selectedModeKey === "plan";
  const isNonDefaultModeEnabled = selectedModeKey !== DEFAULT_MODE_KEY;
  const isCustomModeEnabled = isNonDefaultModeEnabled && !isPlanModeEnabled;
  const selectedModeOption = useMemo(
    () =>
      collaborationModes.find((mode) => mode.mode === selectedModeKey) ?? null,
    [collaborationModes, selectedModeKey],
  );
  const selectedModeLabel = useMemo(() => {
    if (selectedModeOption?.name.trim()) {
      return selectedModeOption.name.trim();
    }
    if (selectedModeKey === "plan") {
      return "Plan";
    }
    if (selectedModeKey === DEFAULT_MODE_KEY) {
      return "Default";
    }
    return selectedModeKey;
  }, [selectedModeKey, selectedModeOption]);
  const modePickerOptions = useMemo(() => {
    const options = new Map<
      string,
      {
        mode: string;
        label: string;
      }
    >();
    options.set(DEFAULT_MODE_KEY, {
      mode: DEFAULT_MODE_KEY,
      label: "Default",
    });
    for (const mode of collaborationModes) {
      const modeKey = mode.mode.trim();
      if (!modeKey || options.has(modeKey)) {
        continue;
      }
      options.set(modeKey, {
        mode: modeKey,
        label: mode.name.trim() || modeKey,
      });
    }
    return [...options.values()];
  }, [collaborationModes]);
  const modeToggleClassName = isPlanModeEnabled
    ? "border-blue-500/50 bg-blue-500/20 text-blue-200 hover:bg-blue-500/25"
    : isCustomModeEnabled
      ? "border-amber-500/50 bg-amber-500/20 text-amber-200 hover:bg-amber-500/25"
      : "border-zinc-800 bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800/80";
  const modeToggleTitle = !hasPlanMode
    ? "Plan mode is unavailable for this session"
    : isCustomModeEnabled
      ? `Current mode: ${selectedModeLabel}`
      : "Toggle Plan mode";

  const getSessionMode = useCallback(
    (sessionId: string | null): CollaborationModeKey => {
      if (!sessionId) {
        return DEFAULT_MODE_KEY;
      }

      return normalizeModeKey(sessionModeById[sessionId] ?? DEFAULT_MODE_KEY);
    },
    [normalizeModeKey, sessionModeById],
  );

  const setSessionMode = useCallback(
    (sessionId: string, mode: CollaborationModeKey) => {
      const normalizedMode = normalizeModeKey(mode);

      setSessionModeById((current) => {
        if (current[sessionId] === normalizedMode) {
          return current;
        }
        return {
          ...current,
          [sessionId]: normalizedMode,
        };
      });

      if (selectedSession === sessionId) {
        setSelectedModeKey(normalizedMode);
      }
    },
    [normalizeModeKey, selectedSession],
  );

  const effortOptions = useMemo(() => {
    const selectedModel =
      filteredModels.find((model) => model.id === selectedModelId) ?? null;

    const effortSet = new Set<CodexReasoningEffort>();

    if (selectedModel && selectedModel.supportedReasoningEfforts.length > 0) {
      for (const effort of selectedModel.supportedReasoningEfforts) {
        effortSet.add(effort);
      }
    } else {
      for (const model of filteredModels) {
        for (const effort of model.supportedReasoningEfforts) {
          effortSet.add(effort);
        }
      }
    }

    if (selectedEffort) {
      effortSet.add(selectedEffort);
    }

    return REASONING_EFFORTS.filter((effort) => effortSet.has(effort));
  }, [filteredModels, selectedModelId, selectedEffort]);
  const effectiveModelId = useMemo(
    () =>
      getEffectiveModelId({
        selectedModelId,
        selectedModeOption,
        configDefaults,
        models,
      }),
    [configDefaults, models, selectedModeOption, selectedModelId],
  );
  const effectiveModelLabel = useMemo(
    () => getModelDisplayName(models, effectiveModelId),
    [effectiveModelId, models],
  );
  const effectiveReasoningEffort = useMemo(
    () =>
      getEffectiveReasoningEffort({
        selectedEffort,
        selectedModeKey,
        selectedModeOption,
        configDefaults,
        models,
        effectiveModelId,
      }),
    [
      configDefaults,
      effectiveModelId,
      models,
      selectedEffort,
      selectedModeKey,
      selectedModeOption,
    ],
  );
  const modelControlLabel = useMemo(
    () => getModelControlLabel(models, effectiveModelId),
    [effectiveModelId, models],
  );
  const effortControlLabel = useMemo(
    () => getEffortControlLabel(effectiveReasoningEffort),
    [effectiveReasoningEffort],
  );

  useEffect(() => {
    if (!selectedEffort) {
      return;
    }

    if (!effortOptions.includes(selectedEffort)) {
      setSelectedEffort("");
    }
  }, [effortOptions, selectedEffort]);

  useEffect(() => {
    setSelectedModeKey((current) => normalizeModeKey(current));
    setSessionModeById((current) => {
      let hasChanges = false;
      const next: Record<string, CollaborationModeKey> = {};
      for (const [sessionId, mode] of Object.entries(current)) {
        const normalizedMode = normalizeModeKey(mode);
        next[sessionId] = normalizedMode;
        if (normalizedMode !== mode) {
          hasChanges = true;
        }
      }
      return hasChanges ? next : current;
    });
  }, [normalizeModeKey]);

  useEffect(() => {
    persistSessionModeMap(sessionModeById);
  }, [sessionModeById]);

  useEffect(() => {
    persistMessageHistoryMap(messageHistoryBySession);
  }, [messageHistoryBySession]);

  useEffect(() => {
    if (!activeComposerSessionId) {
      return;
    }
    setSelectedModeKey(getSessionMode(activeComposerSessionId));
  }, [activeComposerSessionId, getSessionMode]);

  const selectSessionIfAvailable = useCallback(
    (sessionId: string) => {
      const requestId = sessionSelectionRequestIdRef.current + 1;
      sessionSelectionRequestIdRef.current = requestId;

      void (async () => {
        const exists = await ensureSessionExistsForUse(sessionId);
        if (!exists || sessionSelectionRequestIdRef.current !== requestId) {
          return;
        }

        setSelectedSession(sessionId);
        setCenterView("session");
        setInteractionError(null);
        if (isMobilePhone) {
          setSidebarCollapsed(true);
        }
      })();
    },
    [ensureSessionExistsForUse, isMobilePhone],
  );

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      selectSessionIfAvailable(sessionId);
    },
    [selectSessionIfAvailable],
  );

  const handleSelectCodex = useCallback(() => {
    sessionSelectionRequestIdRef.current += 1;
    setCenterView("session");
    setInteractionError(null);
    if (isMobilePhone) {
      setSidebarCollapsed(true);
    }
  }, [isMobilePhone]);

  const handleSelectWorkflow = useCallback(
    (workflowKey?: string) => {
      sessionSelectionRequestIdRef.current += 1;
      if (workflowKey) {
        setSelectedWorkflowKey(workflowKey);
      } else if (!selectedWorkflowKey && workflows.length > 0) {
        setSelectedWorkflowKey(workflows[0]?.key ?? null);
      }
      setCenterView("workflow");
      setInteractionError(null);
      setDiffPaneCollapsed(true);
      if (isMobilePhone) {
        setSidebarCollapsed(true);
      }
    },
    [isMobilePhone, selectedWorkflowKey, workflows],
  );

  const handleOpenWorkflowForSession = useCallback(() => {
    if (!selectedSessionWorkflowMatch) {
      return;
    }
    setSelectedWorkflowProject(
      selectedSessionWorkflowMatch.workflow.projectRoot,
    );
    setSelectedWorkflowTaskId(
      selectedSessionWorkflowMatch.role === "task"
        ? selectedSessionWorkflowMatch.taskId
        : null,
    );
    handleSelectWorkflow(selectedSessionWorkflowMatch.workflow.key);
  }, [handleSelectWorkflow, selectedSessionWorkflowMatch]);

  const handleSelectTerminal = useCallback(
    (terminalId?: string) => {
      setPendingTerminalSelectionId(null);
      if (terminalId) {
        setSelectedTerminalId(terminalId);
      } else if (!selectedTerminalId && terminals.length > 0) {
        setSelectedTerminalId(terminals[0]?.id ?? null);
      }
      setCenterView("terminal");
      setInteractionError(null);
      if (isMobilePhone) {
        setSidebarCollapsed(true);
      }
    },
    [isMobilePhone, selectedTerminalId, terminals],
  );

  const handleOpenTerminalForSession = useCallback(() => {
    const terminalId = selectedSessionTerminalRole?.terminalId?.trim() ?? "";
    if (!terminalId) {
      return;
    }

    const terminal =
      terminals.find(
        (candidate) =>
          candidate.id === terminalId || candidate.terminalId === terminalId,
      ) ?? null;
    if (terminal?.project) {
      setSelectedTerminalProject(terminal.project);
    }
    handleSelectTerminal(terminalId);
  }, [handleSelectTerminal, selectedSessionTerminalRole, terminals]);

  const handleSelectLeftPaneItem = useCallback(
    (id: string) => {
      if (centerView === "terminal") {
        handleSelectTerminal(id);
        return;
      }
      if (centerView === "workflow") {
        handleSelectWorkflow(id);
        return;
      }
      handleSelectSession(id);
    },
    [
      centerView,
      handleSelectSession,
      handleSelectTerminal,
      handleSelectWorkflow,
    ],
  );

  const terminalCwdForCreate =
    newSessionCwd.trim() ||
    selectedTerminalProject?.trim() ||
    selectedTerminalData?.cwd?.trim() ||
    selectedProject?.trim() ||
    selectedSessionData?.project?.trim() ||
    "";

  const sessionCwdForCreate =
    newSessionCwd.trim() ||
    selectedProject?.trim() ||
    selectedSessionData?.project?.trim() ||
    "";

  const handleCreateTerminal = useCallback(
    async (cwdOverride?: string): Promise<boolean> => {
      const normalizedOverride =
        typeof cwdOverride === "string" ? cwdOverride.trim() : "";
      const cwd = normalizedOverride || terminalCwdForCreate;

      if (!cwd) {
        setInteractionError(
          "Set a project path before creating a new terminal.",
        );
        return false;
      }

      setCreatingSession(true);
      setInteractionError(null);

      try {
        const created = await createTerminal({ cwd });
        setPendingTerminalSelectionId(created.terminalId);
        setSelectedTerminalProject(created.cwd);
        setSelectedTerminalId(created.terminalId);
        setCenterView("terminal");
        if (isMobilePhone) {
          setSidebarCollapsed(true);
        }
        return true;
      } catch (error) {
        setInteractionError(
          error instanceof Error ? error.message : String(error),
        );
        return false;
      } finally {
        setCreatingSession(false);
      }
    },
    [isMobilePhone, terminalCwdForCreate],
  );

  const handleCreateSession = useCallback(
    async (cwdOverride?: string): Promise<boolean> => {
      const normalizedOverride =
        typeof cwdOverride === "string" ? cwdOverride.trim() : "";
      const cwd = normalizedOverride || sessionCwdForCreate;

      if (!cwd) {
        setInteractionError(
          "Set a project path before creating a new session.",
        );
        return false;
      }

      setCreatingSession(true);
      setInteractionError(null);

      try {
        const created = await createCodexThread({
          cwd,
          ...(selectedModelId ? { model: selectedModelId } : {}),
          ...(selectedEffort ? { effort: selectedEffort } : {}),
        });

        // A brand-new thread may not have a materialized rollout yet.
        // Suppress wait-state polling until the first user message is sent.
        waitSuppressSessionsRef.current.add(created.threadId);
        setSelectedSession(created.threadId);
        setCenterView("session");
        if (isMobilePhone) {
          setSidebarCollapsed(true);
        }
        return true;
      } catch (error) {
        setInteractionError(
          error instanceof Error ? error.message : String(error),
        );
        return false;
      } finally {
        setCreatingSession(false);
      }
    },
    [sessionCwdForCreate, selectedModelId, selectedEffort, isMobilePhone],
  );

  const upsertSessionInLocalState = useCallback((session: Session) => {
    setSessions((current) => {
      const sessionMap = new Map(current.map((item) => [item.id, item]));
      sessionMap.set(session.id, session);
      return Array.from(sessionMap.values()).sort(
        (left, right) => right.timestamp - left.timestamp,
      );
    });
    if (session.project) {
      setProjects((current) =>
        current.includes(session.project)
          ? current
          : [...current, session.project].sort(),
      );
    }
  }, []);

  const ensureSessionVisibleInLocalState = useCallback(
    async (sessionId: string, projectRoot: string): Promise<void> => {
      const normalizedSessionId = sessionId.trim();
      const normalizedProjectRoot = projectRoot.trim();
      if (!normalizedSessionId) {
        return;
      }

      try {
        const payload = await getCodexThreadSummaries({
          threadIds: [normalizedSessionId],
        });
        const thread = payload.threads.find(
          (item) => item.threadId === normalizedSessionId,
        );
        if (thread) {
          upsertSessionInLocalState(toSessionFromThreadSummary(thread));
          return;
        }
      } catch {
        // Fall back to a minimal local entry so the new session is selectable immediately.
      }

      upsertSessionInLocalState({
        id: normalizedSessionId,
        display: "(new session)",
        timestamp: Date.now(),
        project: normalizedProjectRoot,
        projectName: normalizedProjectRoot
          ? getPathBaseName(normalizedProjectRoot)
          : "",
      });
    },
    [upsertSessionInLocalState],
  );

  const refreshWorkflowSidebar = useCallback(
    async (workflowKey: string | null = selectedWorkflowKey) => {
      setInteractionError(null);
      notifyWorkflowMutation(workflowKey);
    },
    [selectedWorkflowKey],
  );

  const refreshSelectedWorkflow = useCallback(
    async (workflowKey: string | null = selectedWorkflowKey) => {
      setInteractionError(null);
      notifyWorkflowMutation(workflowKey);
      return null;
    },
    [selectedWorkflowKey],
  );

  const resolveWorkflowCreateProjectRoot = useCallback(() => {
    return (
      workflowCreateProjectRoot.trim() ||
      workflowCreateImportedDraft?.projectRoot ||
      workflowCreateChatProjectRoot.trim() ||
      selectedWorkflowSummary?.projectRoot ||
      selectedWorkflowProject ||
      selectedProject ||
      selectedSessionData?.project ||
      ""
    );
  }, [
    selectedProject,
    selectedSessionData?.project,
    selectedWorkflowProject,
    selectedWorkflowSummary?.projectRoot,
    workflowCreateChatProjectRoot,
    workflowCreateImportedDraft?.projectRoot,
    workflowCreateProjectRoot,
  ]);

  const resetWorkflowCreateFields = useCallback(() => {
    setWorkflowCreateTitle("");
    setWorkflowCreateRequest("");
    setWorkflowCreateId("");
    setWorkflowCreateTargetBranch("");
    setWorkflowCreateTaskCount("1");
    setWorkflowCreateMaxParallel("1");
    setWorkflowCreateTasksJson("");
    setWorkflowCreateSequential(false);
  }, []);

  const resetWorkflowCreateChatState = useCallback(() => {
    workflowCreateChatAbortRequestedRef.current = true;
    workflowCreateChatRequestIdRef.current += 1;
    workflowCreateChatActiveSessionIdRef.current = null;
    cancelWorkflowCreateChatPolling();
    setWorkflowCreateMode("chat");
    setWorkflowCreateChatSessionId(null);
    setWorkflowCreateChatProjectRoot("");
    setWorkflowCreateChatInput("");
    setWorkflowCreateChatPreviewMessage(null);
    setWorkflowCreateChatPendingTurnId(null);
    setWorkflowCreateImportedDraft(null);
  }, [cancelWorkflowCreateChatPolling]);

  const closeWorkflowCreateModal = useCallback(
    (options?: { resetFields?: boolean }) => {
      setShowWorkflowCreateModal(false);
      resetWorkflowCreateChatState();
      if (options?.resetFields) {
        resetWorkflowCreateFields();
      }
    },
    [resetWorkflowCreateChatState, resetWorkflowCreateFields],
  );

  const applyWorkflowCreateImportedDraft = useCallback(
    (
      draft: StrictTaskCreateImportedDraft,
      detail: WorkflowDetailResponse,
    ): void => {
      setWorkflowCreateImportedDraft(draft);
      setWorkflowCreateProjectRoot(
        detail.summary.projectRoot || draft.projectRoot,
      );
      setWorkflowCreateTitle(detail.summary.title || draft.workflowId);
      setWorkflowCreateRequest(detail.summary.request || "");
      setWorkflowCreateId(detail.summary.id || draft.workflowId);
      setWorkflowCreateTargetBranch(detail.summary.targetBranch || "");
      setWorkflowCreateTaskCount(String(Math.max(detail.tasks.length, 1)));
      setWorkflowCreateMaxParallel(
        String(
          Math.max(
            1,
            detail.settings.maxParallel ?? detail.summary.maxParallel ?? 1,
          ),
        ),
      );
      setWorkflowCreateTasksJson(buildWorkflowCreateTasksJson(detail.tasks));
      setWorkflowCreateSequential(false);
      setWorkflowCreateMode("manual");
    },
    [],
  );

  const resolveWorkflowCreateImportedDraft = useCallback(
    async (
      projectRoot: string,
      workflowFileName: string,
      requestId?: number,
    ) => {
      const normalizedProjectRoot = projectRoot.trim().replace(/[/\\]+$/, "");
      const workflowList = await listWorkflowsRequest();
      if (
        requestId !== undefined &&
        !isWorkflowCreateChatRequestCurrent(requestId)
      ) {
        return null;
      }
      const importedDraft = resolveStrictTaskCreateDraft(
        workflowList,
        normalizedProjectRoot,
        workflowFileName,
      );
      if (!importedDraft) {
        throw new Error(
          `Could not find workflow draft ${workflowFileName} in ${projectRoot}.`,
        );
      }
      const detail = await getWorkflowDetailRequest(importedDraft.workflowKey);
      if (
        requestId !== undefined &&
        !isWorkflowCreateChatRequestCurrent(requestId)
      ) {
        return null;
      }
      const hydratedDraft: StrictTaskCreateImportedDraft = {
        ...importedDraft,
        boundSessionId: detail.boundSessionId,
      };
      applyWorkflowCreateImportedDraft(hydratedDraft, detail);
      return hydratedDraft;
    },
    [applyWorkflowCreateImportedDraft, isWorkflowCreateChatRequestCurrent],
  );

  const refreshWorkflowCreateChatSnapshot = useCallback(
    async (
      sessionId: string,
      projectRoot: string,
      turnId?: string | null,
      requestId?: number,
    ): Promise<WorkflowCreateChatSnapshot | null> => {
      const messages = await getConversation(sessionId);
      if (
        requestId !== undefined &&
        !isWorkflowCreateChatRequestCurrent(requestId)
      ) {
        return null;
      }
      setWorkflowCreateChatPreviewMessage(
        getLatestWorkflowCreatePreviewMessage(messages),
      );

      const directive = getStrictTaskCreateDirectiveFromMessages(
        messages,
        turnId,
      );
      const snapshot: WorkflowCreateChatSnapshot = { directive, messages };
      if (directive.kind === "request-approve") {
        try {
          await resolveWorkflowCreateImportedDraft(
            projectRoot,
            directive.workflowFileName,
            requestId,
          );
        } catch (error) {
          if (
            requestId !== undefined &&
            !isWorkflowCreateChatRequestCurrent(requestId)
          ) {
            return snapshot;
          }
          setInteractionError(
            error instanceof Error ? error.message : String(error),
          );
        }
      } else {
        if (
          requestId !== undefined &&
          !isWorkflowCreateChatRequestCurrent(requestId)
        ) {
          return snapshot;
        }
        setWorkflowCreateImportedDraft(null);
      }
      return snapshot;
    },
    [isWorkflowCreateChatRequestCurrent, resolveWorkflowCreateImportedDraft],
  );

  const waitForWorkflowCreateChatTurnToSettle = useCallback(
    async (
      sessionId: string,
      projectRoot: string,
      turnId: string,
      requestId: number,
    ) => {
      const normalizedSessionId = sessionId.trim();
      const normalizedProjectRoot = projectRoot.trim();
      const normalizedTurnId = turnId.trim();
      if (!normalizedSessionId || !normalizedProjectRoot || !normalizedTurnId) {
        return;
      }

      let pendingTurnState: PendingTurn | null = {
        sessionId: normalizedSessionId,
        turnId: normalizedTurnId,
      };
      let observedTurnStart = false;

      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (!isWorkflowCreateChatRequestCurrent(requestId)) {
          return;
        }
        try {
          const snapshot = await refreshWorkflowCreateChatSnapshot(
            normalizedSessionId,
            normalizedProjectRoot,
            normalizedTurnId,
            requestId,
          );
          const lifecycleState = snapshot
            ? getWorkflowCreateTurnLifecycleState(
                snapshot.messages,
                normalizedTurnId,
              )
            : "unknown";
          if (lifecycleState === "completed") {
            return;
          }
          if (lifecycleState === "started") {
            observedTurnStart = true;
          }
        } catch {
          // Ignore transient polling errors and keep waiting.
        }

        try {
          const state = await getCodexThreadState(
            normalizedSessionId,
            normalizedTurnId,
          );
          if (
            state.activeTurnId === normalizedTurnId ||
            (state.requestedTurnId === normalizedTurnId &&
              state.requestedTurnStatus === "inProgress")
          ) {
            observedTurnStart = true;
          }
          pendingTurnState = reconcilePendingTurnWithThreadState(
            pendingTurnState,
            normalizedSessionId,
            normalizedTurnId,
            state,
          );
          if (
            state.requestedTurnId === normalizedTurnId &&
            state.requestedTurnStatus !== null &&
            state.requestedTurnStatus !== "inProgress"
          ) {
            return;
          }
          if (observedTurnStart && pendingTurnState === null) {
            return;
          }
        } catch {
          // Ignore transient polling errors and retry.
        }

        await new Promise<void>((resolve) => {
          workflowCreateChatPollResolveRef.current = resolve;
          workflowCreateChatPollTimeoutRef.current = window.setTimeout(() => {
            workflowCreateChatPollTimeoutRef.current = null;
            workflowCreateChatPollResolveRef.current = null;
            resolve();
          }, 1000);
        });
      }

      throw new Error(
        "Timed out while waiting for codex-deck to finish the workflow creation reply.",
      );
    },
    [isWorkflowCreateChatRequestCurrent, refreshWorkflowCreateChatSnapshot],
  );

  const handleSendWorkflowCreateChatMessage = useCallback(async () => {
    const message = workflowCreateChatInput.trim();
    const projectRoot = resolveWorkflowCreateProjectRoot();
    const existingSessionId = workflowCreateChatSessionId?.trim() ?? "";
    const requestId = workflowCreateChatRequestIdRef.current + 1;

    if (!message) {
      setInteractionError("Type a message before sending it to codex-deck.");
      return false;
    }
    if (!projectRoot) {
      setInteractionError(
        "Set a project path before creating a workflow chat.",
      );
      return false;
    }

    workflowCreateChatRequestIdRef.current = requestId;
    workflowCreateChatAbortRequestedRef.current = false;
    workflowCreateChatActiveSessionIdRef.current = existingSessionId || null;
    setWorkflowActionBusy(true);
    setWorkflowActionLabel(
      existingSessionId
        ? "Sending workflow creation message..."
        : "Creating workflow creation chat session...",
    );
    setInteractionError(null);

    try {
      let sessionId = existingSessionId;
      if (!sessionId) {
        const created = await createCodexThread({
          cwd: projectRoot,
          ...(selectedModelId ? { model: selectedModelId } : {}),
          ...(selectedEffort ? { effort: selectedEffort } : {}),
        });
        if (!isWorkflowCreateChatRequestCurrent(requestId)) {
          return false;
        }
        sessionId = created.threadId;
        workflowCreateChatActiveSessionIdRef.current = sessionId;
        setWorkflowCreateChatSessionId(sessionId);
        setWorkflowCreateChatProjectRoot(projectRoot);
        await ensureSessionVisibleInLocalState(sessionId, projectRoot);
        if (!isWorkflowCreateChatRequestCurrent(requestId)) {
          return false;
        }
      }

      const promptText = existingSessionId
        ? message
        : `$codex-deck-flow Strict task creating mode: Please do following tasks: ${message}`;
      const response = await sendCodexMessage(sessionId, {
        input: [{ type: "text", text: promptText }],
        cwd: projectRoot,
        ...(selectedModelId ? { model: selectedModelId } : {}),
        ...(selectedEffort ? { effort: selectedEffort } : {}),
      });
      if (!isWorkflowCreateChatRequestCurrent(requestId)) {
        return false;
      }
      waitSuppressSessionsRef.current.delete(sessionId);
      setWorkflowCreateChatInput("");
      const turnId = response.turnId?.trim() ?? "";
      await refreshWorkflowCreateChatSnapshot(
        sessionId,
        projectRoot,
        turnId || null,
        requestId,
      );
      if (!isWorkflowCreateChatRequestCurrent(requestId)) {
        return false;
      }

      if (turnId) {
        setWorkflowCreateChatPendingTurnId(turnId);
        setWorkflowActionLabel("Waiting for workflow creation reply...");
        await waitForWorkflowCreateChatTurnToSettle(
          sessionId,
          projectRoot,
          turnId,
          requestId,
        );
        if (!isWorkflowCreateChatRequestCurrent(requestId)) {
          return false;
        }
        setWorkflowCreateChatPendingTurnId(null);
        await refreshWorkflowCreateChatSnapshot(
          sessionId,
          projectRoot,
          turnId,
          requestId,
        );
      }
      return true;
    } catch (error) {
      if (!isWorkflowCreateChatRequestCurrent(requestId)) {
        return false;
      }
      setInteractionError(
        error instanceof Error ? error.message : String(error),
      );
      return false;
    } finally {
      if (workflowCreateChatRequestIdRef.current === requestId) {
        setWorkflowActionBusy(false);
        setWorkflowActionLabel(null);
        setWorkflowCreateChatPendingTurnId(null);
      }
    }
  }, [
    ensureSessionVisibleInLocalState,
    isWorkflowCreateChatRequestCurrent,
    refreshWorkflowCreateChatSnapshot,
    resolveWorkflowCreateProjectRoot,
    selectedEffort,
    selectedModelId,
    waitForWorkflowCreateChatTurnToSettle,
    workflowCreateChatInput,
    workflowCreateChatSessionId,
  ]);

  const handleAbortWorkflowCreateChat = useCallback(async () => {
    const sessionId =
      workflowCreateChatActiveSessionIdRef.current?.trim() ??
      workflowCreateChatSessionId?.trim() ??
      "";

    workflowCreateChatAbortRequestedRef.current = true;
    workflowCreateChatRequestIdRef.current += 1;
    cancelWorkflowCreateChatPolling();
    setWorkflowActionBusy(false);
    setWorkflowActionLabel(null);
    setWorkflowCreateChatPendingTurnId(null);
    closeWorkflowCreateModal({ resetFields: true });

    if (!sessionId) {
      return;
    }

    waitSuppressSessionsRef.current.add(sessionId);
    setTimeout(() => {
      waitSuppressSessionsRef.current.delete(sessionId);
    }, 3000);

    try {
      await interruptCodexThread(sessionId);
    } catch (error) {
      setInteractionError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (workflowCreateChatActiveSessionIdRef.current === sessionId) {
        workflowCreateChatActiveSessionIdRef.current = null;
      }
    }
  }, [
    cancelWorkflowCreateChatPolling,
    closeWorkflowCreateModal,
    workflowCreateChatSessionId,
  ]);

  const isWorkflowCreateImportedDraftReview =
    workflowCreateMode === "manual" && !!workflowCreateImportedDraft;
  const isWorkflowCreateChatWaiting =
    workflowCreateMode === "chat" && workflowActionBusy;

  useEffect(() => {
    if (!isWorkflowCreateChatWaiting) {
      setWorkflowCreateWaitingDotCount(0);
      return;
    }

    const timer = window.setInterval(() => {
      setWorkflowCreateWaitingDotCount((current) => (current + 1) % 4);
    }, 420);

    return () => {
      window.clearInterval(timer);
    };
  }, [isWorkflowCreateChatWaiting]);

  useEffect(() => {
    if (!apiReady || !isPageVisible) {
      return;
    }

    let cancelled = false;
    setLoadingWorkflows(true);

    const unsubscribe = subscribeWorkflowsStream({
      onWorkflows: (nextWorkflows) => {
        if (cancelled) {
          return;
        }
        setWorkflows((current) =>
          areWorkflowCollectionsVisiblyEquivalent(current, nextWorkflows)
            ? current
            : nextWorkflows,
        );
        setLoadingWorkflows(false);
      },
      onError: () => {
        if (cancelled) {
          return;
        }
        setLoadingWorkflows(false);
      },
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [apiReady, isPageVisible]);

  useEffect(() => {
    if (!apiReady || !isPageVisible) {
      return;
    }

    let cancelled = false;

    const unsubscribe = subscribeWorkflowDaemonStatusStream({
      onDaemonStatus: (status) => {
        if (cancelled) {
          return;
        }
        setWorkflowDaemonStatus(status);
      },
      onError: () => {
        if (cancelled) {
          return;
        }
        setWorkflowDaemonStatus(null);
      },
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [apiReady, centerView, isPageVisible]);

  useEffect(() => {
    if (!selectedSession) {
      setSelectedSessionWorkflowMatch(null);
      return;
    }

    if (!apiReady || !isPageVisible || centerView !== "session") {
      return;
    }

    let cancelled = false;

    void getWorkflowBySessionRequest(selectedSession)
      .then((match) => {
        if (cancelled) {
          return;
        }
        setSelectedSessionWorkflowMatch(match);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setSelectedSessionWorkflowMatch(null);
      });

    return () => {
      cancelled = true;
    };
  }, [
    apiReady,
    centerView,
    isPageVisible,
    selectedSession,
    workflowSessionRolesRefreshKey,
  ]);

  useEffect(() => {
    if (!selectedWorkflowKey) {
      workflowLogRequestIdRef.current += 1;
      setWorkflowDetailError(null);
      setWorkflowDetailLoading(false);
      setSelectedWorkflowTaskId(null);
      setWorkflowDetail(null);
      setWorkflowLog(null);
      setWorkflowLogError(null);
      setWorkflowLogLoading(false);
      return;
    }

    if (!apiReady || !isPageVisible || centerView !== "workflow") {
      return;
    }

    let cancelled = false;
    setWorkflowDetailLoading(true);
    setWorkflowDetailError(null);

    const unsubscribe = subscribeWorkflowDetailStream(selectedWorkflowKey, {
      onWorkflowDetail: (detail) => {
        if (cancelled) {
          return;
        }
        setWorkflowDetail(detail);
        setSelectedWorkflowTaskId((current) =>
          current && detail.tasks.some((task) => task.id === current)
            ? current
            : (detail.tasks[0]?.id ?? null),
        );
        setWorkflowDetailLoading(false);
      },
      onError: () => {
        if (cancelled) {
          return;
        }
        setWorkflowDetailLoading(false);
        setWorkflowDetailError("Failed to load workflow details.");
      },
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [apiReady, centerView, isPageVisible, selectedWorkflowKey]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const debugWindow = window as CodexDeckDebugWindow;
    if (
      typeof debugWindow.__CODEX_DECK_DAEMON_COMMAND_LOG_ENABLED__ !== "boolean"
    ) {
      debugWindow.__CODEX_DECK_DAEMON_COMMAND_LOG_ENABLED__ = true;
    }
  }, []);

  const logDaemonCommandHistoryEntries = useCallback(
    (
      workflowKey: string,
      history: Array<{
        at: string | null;
        type: string;
        details: Record<string, unknown>;
      }>,
    ) => {
      const loggedByWorkflow = daemonCommandHistoryLoggedRef.current;
      const seenForWorkflow =
        loggedByWorkflow.get(workflowKey) ?? new Set<string>();
      loggedByWorkflow.set(workflowKey, seenForWorkflow);

      for (const entry of history) {
        if (entry.type !== "daemon_command_executed") {
          continue;
        }
        const commandType = entry.details.commandType;
        const commandSummary = entry.details.commandSummary;
        const shouldLogCommand =
          (commandType === "exec" || commandType === "resume") &&
          typeof commandSummary === "string" &&
          commandSummary.trim().length > 0;
        if (!shouldLogCommand) {
          continue;
        }
        const signature = workflowHistorySignature(
          entry.at,
          entry.type,
          entry.details,
        );
        if (seenForWorkflow.has(signature)) {
          continue;
        }
        seenForWorkflow.add(signature);

        if (!isDaemonCommandConsoleLogEnabled()) {
          continue;
        }

        const source =
          typeof entry.details.source === "string" &&
          entry.details.source.trim()
            ? entry.details.source.trim()
            : "daemon";
        const commandText = daemonCommandText(entry.details);
        console.info(
          `[codex-deck-flow daemon command] ${source}: ${commandText}`,
          {
            workflowKey,
            at: entry.at,
            details: entry.details,
            toggle: `window.${DAEMON_COMMAND_CONSOLE_LOG_GLOBAL_KEY}`,
          },
        );
      }
    },
    [],
  );

  useEffect(() => {
    if (!selectedWorkflowKey || !workflowDetail) {
      return;
    }
    logDaemonCommandHistoryEntries(selectedWorkflowKey, workflowDetail.history);
  }, [logDaemonCommandHistoryEntries, selectedWorkflowKey, workflowDetail]);

  useEffect(() => {
    if (!apiReady || !isPageVisible || workflows.length === 0) {
      return;
    }

    let cancelled = false;
    let intervalId: number | null = null;
    let running = false;

    const candidateKeys = Array.from(
      new Set(
        workflows
          .filter(
            (workflow) =>
              workflow.schedulerRunning ||
              workflow.schedulerPendingTrigger ||
              workflow.key === selectedWorkflowKey,
          )
          .map((workflow) => workflow.key),
      ),
    );

    const poll = async () => {
      if (running || cancelled || candidateKeys.length === 0) {
        return;
      }
      running = true;
      try {
        const details = await Promise.all(
          candidateKeys.map(async (workflowKey) => {
            try {
              return await getWorkflowDetailRequest(workflowKey);
            } catch {
              return null;
            }
          }),
        );
        if (cancelled) {
          return;
        }
        for (const detail of details) {
          if (!detail) {
            continue;
          }
          logDaemonCommandHistoryEntries(detail.summary.key, detail.history);
        }
      } finally {
        running = false;
      }
    };

    void poll();
    intervalId = window.setInterval(() => {
      void poll();
    }, 3000);

    return () => {
      cancelled = true;
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [
    apiReady,
    isPageVisible,
    logDaemonCommandHistoryEntries,
    selectedWorkflowKey,
    workflows,
  ]);

  useEffect(() => {
    setWorkflowActionResultLabel(null);
    setWorkflowActionResultOutput(null);
    setWorkflowStopHint(null);
  }, [centerView, selectedWorkflowKey]);

  const handleLoadWorkflowLog = useCallback(
    async (scope: "scheduler" | "task" | "daemon", taskId?: string | null) => {
      if (!selectedWorkflowKey) {
        workflowLogRequestIdRef.current += 1;
        setWorkflowLog(null);
        setWorkflowLogError(null);
        setWorkflowLogLoading(false);
        return;
      }
      const requestId = workflowLogRequestIdRef.current + 1;
      workflowLogRequestIdRef.current = requestId;
      setWorkflowLogLoading(true);
      setWorkflowLogError(null);
      try {
        const log = await getWorkflowLogRequest(selectedWorkflowKey, {
          scope,
          taskId: taskId ?? null,
        });
        if (workflowLogRequestIdRef.current !== requestId) {
          return;
        }
        setWorkflowLog(log);
      } catch (error) {
        if (workflowLogRequestIdRef.current !== requestId) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setWorkflowLogError(message);
      } finally {
        if (workflowLogRequestIdRef.current === requestId) {
          setWorkflowLogLoading(false);
        }
      }
    },
    [selectedWorkflowKey],
  );

  const handleWorkflowAction = useCallback(
    async (
      label: string,
      action: () => Promise<{ output?: string | null } | unknown>,
      options?: {
        refreshLog?: {
          scope: "scheduler" | "task" | "daemon";
          taskId?: string | null;
        };
      },
    ) => {
      setWorkflowActionBusy(true);
      setWorkflowActionLabel(label);
      setWorkflowActionResultLabel(null);
      setWorkflowActionResultOutput(null);
      setWorkflowStopHint(null);
      setInteractionError(null);
      try {
        const result = await action();
        const output =
          result && typeof result === "object" && "output" in result
            ? ((result as { output?: string | null }).output ?? null)
            : null;
        if (options?.refreshLog) {
          await handleLoadWorkflowLog(
            options.refreshLog.scope,
            options.refreshLog.taskId,
          );
        }
        setWorkflowActionResultLabel(label.replace(/\.\.\.$/, ""));
        setWorkflowActionResultOutput(output);
      } catch (error) {
        setInteractionError(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setWorkflowActionBusy(false);
        setWorkflowActionLabel(null);
      }
    },
    [handleLoadWorkflowLog],
  );

  const resolveWorkflowSkillInstallPrompt = useCallback(
    (choice: WorkflowSkillInstallChoice) => {
      const resolve = workflowSkillInstallPromptResolveRef.current;
      workflowSkillInstallPromptResolveRef.current = null;
      setWorkflowSkillInstallPrompt(null);
      resolve?.(choice);
    },
    [],
  );

  useEffect(() => {
    return () => {
      const resolve = workflowSkillInstallPromptResolveRef.current;
      workflowSkillInstallPromptResolveRef.current = null;
      resolve?.("cancel");
    };
  }, []);

  const promptForWorkflowSkillInstall = useCallback(
    (projectRoot: string): Promise<WorkflowSkillInstallChoice> =>
      new Promise((resolve) => {
        workflowSkillInstallPromptResolveRef.current?.("cancel");
        workflowSkillInstallPromptResolveRef.current = resolve;
        setWorkflowSkillInstallPrompt({
          projectRoot,
        });
      }),
    [],
  );

  const resolveWorkflowSkillInstallMessagePrefix = useCallback(
    async (
      workflowKey: string,
      projectRoot: string,
    ): Promise<string | null> => {
      const response = await getWorkflowProjectSkills(workflowKey);
      if (response.unavailableReason) {
        throw new Error(response.unavailableReason);
      }

      const availability = getWorkflowSkillAvailability(
        response.skills,
        projectRoot,
      );
      if (availability.isInstalled) {
        return "";
      }

      const choice = await promptForWorkflowSkillInstall(projectRoot);
      if (choice === "cancel") {
        return null;
      }
      return buildWorkflowSkillInstallMessagePrefix(choice);
    },
    [promptForWorkflowSkillInstall],
  );

  const resolveTerminalSkillInstallPrompt = useCallback(
    (choice: TerminalSkillInstallChoice) => {
      const resolve = terminalSkillInstallPromptResolveRef.current;
      terminalSkillInstallPromptResolveRef.current = null;
      setTerminalSkillInstallPrompt(null);
      resolve?.(choice);
    },
    [],
  );

  useEffect(() => {
    return () => {
      const resolve = terminalSkillInstallPromptResolveRef.current;
      terminalSkillInstallPromptResolveRef.current = null;
      resolve?.("cancel");
    };
  }, []);

  const promptForTerminalSkillInstall = useCallback(
    (projectRoot: string): Promise<TerminalSkillInstallChoice> =>
      new Promise((resolve) => {
        terminalSkillInstallPromptResolveRef.current?.("cancel");
        terminalSkillInstallPromptResolveRef.current = resolve;
        setTerminalSkillInstallPrompt({
          projectRoot,
        });
      }),
    [],
  );

  const initializeWorkflowChatSession = useCallback(
    async (options?: {
      openInSessionView?: boolean;
      initialMessagePayload?: MessageComposerSubmitPayload;
    }): Promise<string | null> => {
      if (!selectedWorkflowKey || !workflowDetail) {
        return null;
      }

      const chatPlan = resolveWorkflowChatSessionPlan(workflowDetail);
      const openWorkflowSession = (sessionId: string) => {
        selectSessionIfAvailable(sessionId);
      };

      setInteractionError(null);

      if (chatPlan.kind === "error") {
        setInteractionError(chatPlan.message);
        return null;
      }

      if (chatPlan.kind === "open-bound-session") {
        await ensureSessionVisibleInLocalState(
          chatPlan.sessionId,
          chatPlan.projectRoot,
        );
        if (options?.openInSessionView) {
          openWorkflowSession(chatPlan.sessionId);
        }
        return chatPlan.sessionId;
      }

      const projectRoot = chatPlan.projectRoot;
      const workflowId = chatPlan.workflowId;
      const initialMessagePayload = options?.initialMessagePayload;
      const normalizedUserFirstMessage =
        initialMessagePayload?.text.trim() ?? "";
      const normalizedImages = (initialMessagePayload?.images ?? []).filter(
        (imageUrl) => imageUrl.trim().length > 0,
      );

      const bootstrapMessage = buildWorkflowChatBootstrapMessage({
        workflowId,
        projectRoot,
        initialUserMessage: normalizedUserFirstMessage,
        imageCount: normalizedImages.length,
      });
      const workflowSkillInstallPrefix =
        await resolveWorkflowSkillInstallMessagePrefix(
          selectedWorkflowKey,
          projectRoot,
        );
      if (workflowSkillInstallPrefix === null) {
        return null;
      }
      const bootstrapMessageWithSkillInstall = `${workflowSkillInstallPrefix}${bootstrapMessage}`;

      setWorkflowActionBusy(true);
      setWorkflowActionLabel("Creating workflow chat session...");
      setWorkflowActionResultLabel(null);
      setWorkflowActionResultOutput(null);

      try {
        const created = await createCodexThread({
          cwd: projectRoot,
          ...(selectedModelId ? { model: selectedModelId } : {}),
          ...(selectedEffort ? { effort: selectedEffort } : {}),
        });
        await ensureSessionVisibleInLocalState(created.threadId, projectRoot);

        setWorkflowActionLabel("Sending workflow chat bootstrap message...");
        const response = await sendCodexMessage(created.threadId, {
          input: [
            {
              type: "text",
              text: bootstrapMessageWithSkillInstall,
            },
            ...normalizedImages.map((url) => ({ type: "image", url }) as const),
          ],
          cwd: projectRoot,
          ...(selectedModelId ? { model: selectedModelId } : {}),
          ...(selectedEffort ? { effort: selectedEffort } : {}),
        });
        waitSuppressSessionsRef.current.delete(created.threadId);
        if (response.turnId) {
          setPendingTurn({
            sessionId: created.threadId,
            turnId: response.turnId,
          });
        }

        setWorkflowActionLabel("Binding workflow session...");
        await bindWorkflowSessionRequest(selectedWorkflowKey, {
          sessionId: created.threadId,
        });
        setSessionMode(created.threadId, normalizeModeKey(selectedModeKey));

        await Promise.all([
          refreshWorkflowSidebar(),
          refreshSelectedWorkflow(selectedWorkflowKey),
        ]);
        if (options?.openInSessionView) {
          openWorkflowSession(created.threadId);
        }
        return created.threadId;
      } catch (error) {
        setInteractionError(
          error instanceof Error ? error.message : String(error),
        );
        return null;
      } finally {
        setWorkflowActionBusy(false);
        setWorkflowActionLabel(null);
      }
    },
    [
      ensureSessionVisibleInLocalState,
      normalizeModeKey,
      refreshSelectedWorkflow,
      refreshWorkflowSidebar,
      selectSessionIfAvailable,
      selectedEffort,
      selectedModelId,
      selectedModeKey,
      selectedWorkflowKey,
      setSessionMode,
      resolveWorkflowSkillInstallMessagePrefix,
      workflowDetail,
    ],
  );

  const handleChatInWorkflowSession = useCallback(async () => {
    await initializeWorkflowChatSession({
      openInSessionView: true,
    });
  }, [initializeWorkflowChatSession]);

  const runTerminalChatAction = useCallback(
    async (input: {
      action: "send" | "init" | "chat-in-session";
      payload?: MessageComposerSubmitPayload;
      collaborationMode?: ReturnType<typeof getCollaborationModeRequestValue>;
    }) => {
      if (!selectedTerminalData) {
        return null;
      }

      const terminalId = selectedTerminalData.terminalId;
      const normalizedImages = (input.payload?.images ?? []).filter(
        (imageUrl) => imageUrl.trim().length > 0,
      );
      let skillInstallChoice: Exclude<TerminalSkillInstallChoice, "cancel"> | null =
        null;

      while (true) {
        const response = await sendTerminalChatActionRequest(terminalId, {
          action: input.action,
          text: input.payload?.text ?? "",
          images: normalizedImages,
          ...(selectedModelId ? { model: selectedModelId } : {}),
          ...(selectedEffort ? { effort: selectedEffort } : {}),
          ...(input.collaborationMode !== undefined
            ? { collaborationMode: input.collaborationMode }
            : {}),
          ...(skillInstallChoice ? { skillInstallChoice } : {}),
        });
        if (response.status === "completed") {
          return response;
        }

        const choice = await promptForTerminalSkillInstall(response.projectRoot);
        if (choice === "cancel") {
          return null;
        }
        skillInstallChoice = choice;
      }
    },
    [
      promptForTerminalSkillInstall,
      selectedEffort,
      selectedModelId,
      selectedTerminalData,
    ],
  );

  const initializeTerminalChatSession = useCallback(
    async (options?: {
      action?: "init" | "chat-in-session";
      openInSessionView?: boolean;
      initialMessagePayload?: MessageComposerSubmitPayload;
    }): Promise<string | null> => {
      if (!selectedTerminalData) {
        return null;
      }

      const action = options?.action ?? "init";
      const terminalId = selectedTerminalData.terminalId;
      const projectRoot = selectedTerminalData.cwd.trim();
      const existingSessionId =
        selectedTerminalData.boundSessionId?.trim() || null;

      const openTerminalSession = (sessionId: string) => {
        selectSessionIfAvailable(sessionId);
      };

      setInteractionError(null);

      if (existingSessionId) {
        await ensureSessionVisibleInLocalState(existingSessionId, projectRoot);
        if (options?.openInSessionView) {
          openTerminalSession(existingSessionId);
        }
        return existingSessionId;
      }

      setTerminalBindingBusy(true);
      try {
        const response = await runTerminalChatAction({
          action,
          payload: options?.initialMessagePayload,
        });
        if (!response) {
          return null;
        }

        if (response.turnId) {
          setPendingTurn({
            sessionId: response.sessionId,
            turnId: response.turnId,
          });
        }
        waitSuppressSessionsRef.current.delete(response.sessionId);
        await ensureSessionVisibleInLocalState(response.sessionId, projectRoot);

        if (response.boundSessionId) {
          setSessionMode(
            response.boundSessionId,
            normalizeModeKey(selectedModeKey),
          );
        }

        setTerminals((current) =>
          current.map((terminal) =>
            terminal.terminalId === terminalId
              ? { ...terminal, boundSessionId: response.boundSessionId }
              : terminal,
          ),
        );

        if (options?.openInSessionView) {
          openTerminalSession(response.sessionId);
        }
        return response.sessionId;
      } catch (error) {
        setInteractionError(
          error instanceof Error ? error.message : String(error),
        );
        return null;
      } finally {
        setTerminalBindingBusy(false);
      }
    },
    [
      ensureSessionVisibleInLocalState,
      normalizeModeKey,
      runTerminalChatAction,
      selectedEffort,
      selectedModeKey,
      selectedTerminalData,
      selectSessionIfAvailable,
      setSessionMode,
    ],
  );

  const handleChatInTerminalSession = useCallback(async () => {
    await initializeTerminalChatSession({
      action: "chat-in-session",
      openInSessionView: true,
    });
  }, [initializeTerminalChatSession]);

  const handleCreateEmptyWorkflowFromPrompt = useCallback(async () => {
    const workflowId = workflowIdPromptDraft.trim();
    if (!isValidWorkflowIdForPrompt(workflowId)) {
      setInteractionError(
        "Workflow ID must contain only letters, numbers, '-' or '_' (no spaces or special characters).",
      );
      return false;
    }

    const projectRoot = resolveWorkflowCreateProjectRoot();
    if (!projectRoot) {
      setInteractionError("Set a project path before creating a new workflow.");
      return false;
    }

    setWorkflowActionBusy(true);
    setWorkflowActionLabel("Creating workflow...");
    setInteractionError(null);
    try {
      const response = await createWorkflowRequest(
        buildEmptyWorkflowCreateRequest(workflowId, projectRoot),
      );
      setShowWorkflowIdPromptModal(false);
      setWorkflowIdPromptDraft("");
      setSelectedWorkflowProject(projectRoot);
      setPendingWorkflowSelectionKey(response.workflowKey);
      await refreshWorkflowSidebar(response.workflowKey);
      setSelectedWorkflowKey(response.workflowKey);
      setCenterView("workflow");
      return true;
    } catch (error) {
      setInteractionError(
        error instanceof Error ? error.message : String(error),
      );
      return false;
    } finally {
      setWorkflowActionBusy(false);
      setWorkflowActionLabel(null);
    }
  }, [
    refreshWorkflowSidebar,
    resolveWorkflowCreateProjectRoot,
    workflowIdPromptDraft,
  ]);

  const handleCreateWorkflow = useCallback(async (): Promise<boolean> => {
    const projectRoot = resolveWorkflowCreateProjectRoot();
    const importedDraft = workflowCreateImportedDraft;

    if (importedDraft) {
      const sessionId = workflowCreateChatSessionId?.trim() ?? "";
      if (!sessionId) {
        setInteractionError(
          "Create a workflow chat session before approving an imported draft.",
        );
        return false;
      }

      setWorkflowActionBusy(true);
      setWorkflowActionLabel("Binding imported workflow draft...");
      setInteractionError(null);
      try {
        const workflowProjectRoot = importedDraft.projectRoot
          .trim()
          .replace(/[/\\]+$/, "");
        const sessionProjectRoot = workflowCreateChatProjectRoot
          .trim()
          .replace(/[/\\]+$/, "");
        if (
          workflowProjectRoot &&
          sessionProjectRoot &&
          workflowProjectRoot !== sessionProjectRoot
        ) {
          throw new Error(
            "The workflow draft project path does not match the workflow chat session project path.",
          );
        }

        await bindWorkflowSessionRequest(importedDraft.workflowKey, {
          sessionId,
        });
        try {
          await sendCodexMessage(sessionId, {
            input: [
              {
                type: "text",
                text: buildStrictTaskCreateApprovalMessage(
                  importedDraft,
                  sessionId,
                ),
              },
            ],
            cwd: importedDraft.projectRoot,
            ...(selectedModelId ? { model: selectedModelId } : {}),
            ...(selectedEffort ? { effort: selectedEffort } : {}),
          });
        } catch (error) {
          try {
            await bindWorkflowSessionRequest(importedDraft.workflowKey, {
              sessionId: importedDraft.boundSessionId ?? null,
            });
          } catch {
            throw new Error(
              `Failed to send the workflow approval message, and restoring the previous workflow binding also failed. Original error: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          throw error;
        }
        waitSuppressSessionsRef.current.delete(sessionId);
        setSelectedWorkflowProject(importedDraft.projectRoot);
        await Promise.all([
          refreshWorkflowSidebar(importedDraft.workflowKey),
          refreshSelectedWorkflow(importedDraft.workflowKey),
        ]);
        setSelectedWorkflowKey(importedDraft.workflowKey);
        setCenterView("workflow");
        closeWorkflowCreateModal({ resetFields: true });
        return true;
      } catch (error) {
        setInteractionError(
          error instanceof Error ? error.message : String(error),
        );
        return false;
      } finally {
        setWorkflowActionBusy(false);
        setWorkflowActionLabel(null);
      }
    }

    const title = workflowCreateTitle.trim();
    const request = workflowCreateRequest.trim();
    if (!title) {
      setInteractionError("Set a workflow title before creating a workflow.");
      return false;
    }
    if (!request) {
      setInteractionError("Set a workflow request before creating a workflow.");
      return false;
    }
    if (!projectRoot) {
      setInteractionError("Set a project path before creating a new workflow.");
      return false;
    }

    setWorkflowActionBusy(true);
    setWorkflowActionLabel("Creating workflow...");
    setInteractionError(null);
    try {
      const response = await createWorkflowRequest({
        title,
        request,
        projectRoot,
        workflowId: workflowCreateId.trim() || null,
        targetBranch: workflowCreateTargetBranch.trim() || null,
        taskCount: workflowCreateTasksJson.trim()
          ? null
          : Math.max(
              1,
              Number.parseInt(workflowCreateTaskCount || "1", 10) || 1,
            ),
        tasksJson: workflowCreateTasksJson.trim() || null,
        sequential: workflowCreateSequential,
        maxParallel: Math.max(
          1,
          Number.parseInt(workflowCreateMaxParallel || "1", 10) || 1,
        ),
      });
      closeWorkflowCreateModal({ resetFields: true });
      setSelectedWorkflowProject(projectRoot);
      setPendingWorkflowSelectionKey(response.workflowKey);
      await refreshWorkflowSidebar(response.workflowKey);
      setSelectedWorkflowKey(response.workflowKey);
      setCenterView("workflow");
      return true;
    } catch (error) {
      setInteractionError(
        error instanceof Error ? error.message : String(error),
      );
      return false;
    } finally {
      setWorkflowActionBusy(false);
      setWorkflowActionLabel(null);
    }
  }, [
    closeWorkflowCreateModal,
    refreshSelectedWorkflow,
    refreshWorkflowSidebar,
    resolveWorkflowCreateProjectRoot,
    selectedEffort,
    selectedModelId,
    workflowCreateChatSessionId,
    workflowCreateId,
    workflowCreateImportedDraft,
    workflowCreateMaxParallel,
    workflowCreateRequest,
    workflowCreateSequential,
    workflowCreateTargetBranch,
    workflowCreateTaskCount,
    workflowCreateTasksJson,
    workflowCreateTitle,
  ]);

  const enqueuePendingUserMessage = useCallback(
    (
      sessionId: string,
      payload: MessageComposerSubmitPayload,
    ): PendingUserMessage["pendingId"] => {
      const pendingId = createPendingUserMessageId();
      const text = payload.text.trim();
      const images = payload.images.filter(
        (imageUrl) =>
          typeof imageUrl === "string" && imageUrl.trim().length > 0,
      );

      setPendingUserMessagesBySession((current) =>
        appendPendingUserMessage(current, sessionId, {
          pendingId,
          text,
          images,
          status: "sending",
        }),
      );

      return pendingId;
    },
    [],
  );

  const markPendingUserMessageAwaitingConfirmation = useCallback(
    (sessionId: string, pendingId: string) => {
      setPendingUserMessagesBySession((current) =>
        updatePendingUserMessageStatus(
          current,
          sessionId,
          pendingId,
          "awaiting_confirmation",
        ),
      );
    },
    [],
  );

  const removePendingUserMessageById = useCallback(
    (sessionId: string, pendingId: string) => {
      setPendingUserMessagesBySession((current) =>
        removePendingUserMessage(current, sessionId, pendingId),
      );
    },
    [],
  );

  const sendMessageText = useCallback(
    async (
      payload: MessageComposerSubmitPayload,
      options?: {
        modeOverride?: CollaborationModeKey;
        sessionIdOverride?: string | null;
        cwdOverride?: string | null;
      },
    ): Promise<boolean> => {
      const sessionId = options?.sessionIdOverride ?? activeComposerSessionId;
      if (!sessionId || sendingMessage) {
        return false;
      }

      const normalizedText = payload.text.trim();
      const normalizedImages = payload.images.filter(
        (imageUrl) =>
          typeof imageUrl === "string" && imageUrl.trim().length > 0,
      );
      const input: Array<
        { type: "text"; text: string } | { type: "image"; url: string }
      > = [
        ...(normalizedText.length > 0
          ? ([{ type: "text", text: normalizedText }] as const)
          : []),
        ...normalizedImages.map((url) => ({ type: "image", url }) as const),
      ];
      if (input.length === 0) {
        return false;
      }

      const requestedMode = options?.modeOverride ?? getSessionMode(sessionId);
      const modeToUse = normalizeModeKey(requestedMode);
      const modeOption =
        collaborationModes.find((mode) => mode.mode === modeToUse) ?? null;
      const effectiveModelIdForRequest = getEffectiveModelId({
        selectedModelId,
        selectedModeOption: modeOption,
        configDefaults,
        models,
      });
      const effectiveReasoningEffortForRequest = getEffectiveReasoningEffort({
        selectedEffort,
        selectedModeKey: modeToUse,
        selectedModeOption: modeOption,
        configDefaults,
        models,
        effectiveModelId: effectiveModelIdForRequest,
      });
      const collaborationMode = getCollaborationModeRequestValue({
        selectedModeKey: modeToUse,
        selectedModeOption: modeOption,
        effectiveModelId: effectiveModelIdForRequest,
        effectiveReasoningEffort: effectiveReasoningEffortForRequest,
      });
      if (modeToUse !== DEFAULT_MODE_KEY && !collaborationMode) {
        setInteractionError(
          "Selected collaboration mode is not ready yet. Wait for model info to load and try again.",
        );
        return false;
      }

      const pendingId = enqueuePendingUserMessage(sessionId, payload);

      setSendingMessage(true);
      setInteractionError(null);
      waitSuppressSessionsRef.current.delete(sessionId);

      try {
        const cwd =
          options?.cwdOverride ??
          (sessionId === activeComposerSessionId
            ? activeComposerSessionData?.project
            : (sessionsWithThreadNames.find(
                (session) => session.id === sessionId,
              )?.project ?? null));
        const response = await sendCodexMessage(sessionId, {
          input,
          ...(cwd ? { cwd } : {}),
          ...(selectedModelId ? { model: selectedModelId } : {}),
          ...(selectedEffort ? { effort: selectedEffort } : {}),
          collaborationMode,
        });

        setSessionMode(sessionId, modeToUse);
        markPendingUserMessageAwaitingConfirmation(sessionId, pendingId);
        setPendingTurn({
          sessionId,
          turnId: response.turnId,
        });
        return true;
      } catch (error) {
        removePendingUserMessageById(sessionId, pendingId);
        const message = error instanceof Error ? error.message : String(error);
        if (isSessionUnavailableMessage(message)) {
          notifySessionUnavailable();
          return false;
        }

        setInteractionError(message);
        return false;
      } finally {
        setSendingMessage(false);
      }
    },
    [
      activeComposerSessionData?.project,
      activeComposerSessionId,
      collaborationModes,
      configDefaults,
      getSessionMode,
      models,
      sendingMessage,
      normalizeModeKey,
      notifySessionUnavailable,
      selectedModelId,
      selectedEffort,
      enqueuePendingUserMessage,
      markPendingUserMessageAwaitingConfirmation,
      removePendingUserMessageById,
      sessionsWithThreadNames,
      setSessionMode,
    ],
  );

  const handleSendMessage = useCallback(
    async (payload: MessageComposerSubmitPayload): Promise<boolean> => {
      const sessionId = selectedSession;
      const normalizedText = payload.text.trim();
      const sent = await sendMessageText(payload);
      if (!sent || !sessionId) {
        return sent;
      }

      if (!normalizedText) {
        return true;
      }

      setMessageHistoryBySession((current) => {
        const sessionHistory = current[sessionId] ?? [];
        return {
          ...current,
          [sessionId]: [...sessionHistory, normalizedText],
        };
      });
      return true;
    },
    [selectedSession, sendMessageText],
  );

  const upsertSessionFromThreadSummary = useCallback(
    (thread: CodexThreadSummary) => {
      const nextSession = toSessionFromThreadSummary(thread);
      setSessions((current) => {
        const sessionMap = new Map(
          current.map((session) => [session.id, session]),
        );
        sessionMap.set(nextSession.id, nextSession);
        return Array.from(sessionMap.values()).sort(
          (left, right) => right.timestamp - left.timestamp,
        );
      });

      const name = thread.name?.trim();
      if (name) {
        setThreadNameOverrides((current) => ({
          ...current,
          [thread.threadId]: name,
        }));
      }
    },
    [],
  );

  const handleRenameThread = useCallback(
    async (threadId: string, rawName: string): Promise<boolean> => {
      const name = rawName.trim();
      if (!name) {
        setInteractionError("Thread name cannot be empty.");
        return false;
      }

      setRenamingSession(true);
      setInteractionError(null);
      try {
        await setCodexThreadName(threadId, { name });
        setThreadNameOverrides((current) => ({
          ...current,
          [threadId]: name,
        }));
        showCommandNoticeForDuration("Renamed current thread.");
        return true;
      } catch (error) {
        setInteractionError(
          error instanceof Error ? error.message : String(error),
        );
        return false;
      } finally {
        setRenamingSession(false);
      }
    },
    [showCommandNoticeForDuration],
  );

  const openAgentPickerFromCommand = useCallback(
    async (threadId: string): Promise<boolean> => {
      setShowAgentPicker(true);
      setLoadingAgentThreads(true);
      setAgentThreadsError(null);

      try {
        const threads = await listCodexAgentThreads(threadId);
        setAgentThreads(threads);
        for (const thread of threads) {
          upsertSessionFromThreadSummary(thread);
        }
        return true;
      } catch (error) {
        setAgentThreads([]);
        setAgentThreadsError(
          error instanceof Error ? error.message : String(error),
        );
        return false;
      } finally {
        setLoadingAgentThreads(false);
      }
    },
    [upsertSessionFromThreadSummary],
  );

  const focusSessionSearchInput = useCallback(() => {
    const focusSearchInput = () => {
      const input = sessionListSearchInputRef.current;
      if (!input) {
        return false;
      }
      input.focus();
      input.select();
      return true;
    };

    if (focusSearchInput()) {
      return;
    }

    window.requestAnimationFrame(() => {
      if (focusSearchInput()) {
        return;
      }
      window.setTimeout(() => {
        focusSearchInput();
      }, 40);
    });
  }, []);

  const openModelSelectorFromCommand = useCallback((): boolean => {
    const openFromRef = (select: HTMLSelectElement | null): boolean => {
      if (!select) {
        return false;
      }
      openNativeSelectMenu(select);
      return true;
    };

    if (isToolbarCompact) {
      if (!isToolbarControlsExpanded) {
        setIsToolbarControlsExpanded(true);
      }

      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const opened = openFromRef(compactModelSelectRef.current);
          if (opened) {
            return;
          }
          window.setTimeout(() => {
            openFromRef(compactModelSelectRef.current);
          }, 50);
        });
      });
      return true;
    }

    if (openFromRef(modelSelectRef.current)) {
      return true;
    }

    window.requestAnimationFrame(() => {
      openFromRef(modelSelectRef.current);
    });
    return true;
  }, [isToolbarCompact, isToolbarControlsExpanded]);

  const applyModeSelection = useCallback(
    (mode: CollaborationModeKey): void => {
      const normalizedMode = normalizeModeKey(mode);
      if (activeComposerSessionId) {
        setSessionMode(activeComposerSessionId, normalizedMode);
        return;
      }
      setSelectedModeKey(normalizedMode);
    },
    [activeComposerSessionId, normalizeModeKey, setSessionMode],
  );

  const handleTogglePlanMode = useCallback(() => {
    if (!hasPlanMode) {
      return;
    }

    if (!activeComposerSessionId) {
      setSelectedModeKey((current) =>
        normalizeModeKey(current === "plan" ? DEFAULT_MODE_KEY : "plan"),
      );
      return;
    }

    setSessionMode(
      activeComposerSessionId,
      selectedModeKey === "plan" ? DEFAULT_MODE_KEY : "plan",
    );
  }, [
    activeComposerSessionId,
    hasPlanMode,
    normalizeModeKey,
    selectedModeKey,
    setSessionMode,
  ]);

  const handleRunSlashCommand = useCallback(
    async (commandName: string, args: string): Promise<boolean> => {
      const normalizedArgs = args.trim();
      const commandSessionId = activeComposerSessionId;
      const commandSessionData = activeComposerSessionData;
      const openPaneForCommand = (
        mode: RightPaneMode,
        refresh?: () => void,
      ) => {
        const navigation = resolvePaneSlashCommandNavigation({
          centerView,
          commandSessionId,
          paneSessionId: activeComposerSessionId,
        });

        if (navigation.preserveCenterView) {
          if (navigation.shouldClearWorkflowTaskSelection) {
            setSelectedWorkflowTaskId(null);
          }
          openRightPane();
          setSelectedPaneMode(mode);
          if (refresh && typeof window !== "undefined") {
            window.setTimeout(() => {
              refresh();
            }, 0);
          }
          return;
        }

        if (navigation.shouldSelectCommandSession && commandSessionId) {
          setSelectedSession(commandSessionId);
        }
        setCenterView("session");
        openRightPane();
        setSelectedPaneMode(mode);
        refresh?.();
      };
      setInteractionError(null);

      if (commandName === "/model") {
        return openModelSelectorFromCommand();
      }

      if (commandName === "/plan") {
        const normalizedLower = normalizedArgs.toLowerCase();
        if (!normalizedLower) {
          if (!hasPlanMode) {
            setInteractionError("Plan mode is unavailable for this session.");
            return false;
          }
          handleTogglePlanMode();
          return true;
        }

        if (normalizedLower !== "on" && normalizedLower !== "off") {
          setInteractionError("Usage: /plan [on|off]");
          return false;
        }

        if (normalizedLower === "on" && !hasPlanMode) {
          setInteractionError("Plan mode is unavailable for this session.");
          return false;
        }

        applyModeSelection(
          normalizedLower === "on" ? "plan" : DEFAULT_MODE_KEY,
        );
        return true;
      }

      if (commandName === "/collab") {
        if (collaborationModes.length === 0) {
          setInteractionError(
            "No collaboration modes are available right now.",
          );
          return false;
        }
        setShowCollabModePicker(true);
        return true;
      }

      if (commandName === "/status") {
        if (!commandSessionId) {
          setInteractionError("Select a session before using /status.");
          return false;
        }
        setShowStatusModal(true);
        return true;
      }

      if (commandName === "/rename") {
        if (!commandSessionId) {
          setInteractionError("Select a session before using /rename.");
          return false;
        }

        if (normalizedArgs) {
          return handleRenameThread(commandSessionId, normalizedArgs);
        }

        setRenameDraft(commandSessionData?.display ?? "");
        setShowRenameModal(true);
        return true;
      }

      if (commandName === "/new" || commandName === "/clear") {
        const preferredCwd =
          selectedTerminalData?.cwd?.trim() ||
          commandSessionData?.project?.trim() ||
          selectedTerminalProject?.trim() ||
          selectedProject?.trim() ||
          newSessionCwd.trim();
        return centerView === "terminal"
          ? handleCreateTerminal(preferredCwd || undefined)
          : handleCreateSession(preferredCwd || undefined);
      }

      if (commandName === "/resume") {
        setCenterView("session");
        openLeftPane();
        focusSessionSearchInput();
        return true;
      }

      if (commandName === "/fork") {
        if (!commandSessionId) {
          setInteractionError("Select a session before using /fork.");
          return false;
        }

        try {
          const result = await forkCodexThread(commandSessionId);
          upsertSessionFromThreadSummary(result.thread);
          setSelectedSession(result.thread.threadId);
          setCenterView("session");
          showCommandNoticeForDuration("Forked current thread.");
          return true;
        } catch (error) {
          setInteractionError(
            error instanceof Error ? error.message : String(error),
          );
          return false;
        }
      }

      if (commandName === "/init") {
        if (!commandSessionId) {
          setInteractionError("Select a session before using /init.");
          return false;
        }

        try {
          const searchResult = await searchSessionFiles(
            commandSessionId,
            "AGENTS.md",
            10,
          );
          const hasAgentsFile = searchResult.files.some(
            (path) => path === "AGENTS.md",
          );
          if (hasAgentsFile) {
            showCommandNoticeForDuration(
              "AGENTS.md already exists here. Skipping /init.",
            );
            return true;
          }

          return sendMessageText(
            {
              text: INIT_AGENTS_PROMPT,
              images: [],
            },
            {
              sessionIdOverride: commandSessionId,
              cwdOverride: commandSessionData?.project ?? null,
            },
          );
        } catch (error) {
          setInteractionError(
            error instanceof Error ? error.message : String(error),
          );
          return false;
        }
      }

      if (commandName === "/compact") {
        if (!commandSessionId) {
          setInteractionError("Select a session before using /compact.");
          return false;
        }

        if (
          pendingTurnRef.current?.sessionId === commandSessionId &&
          pendingTurnRef.current
        ) {
          setInteractionError(
            "'/compact' is disabled while a task is in progress.",
          );
          return false;
        }

        try {
          // Mirror Codex CLI behavior: clear token usage immediately on /compact.
          setContextLeftPercent(null);
          setContextUsedTokens(null);
          setStatusTokenUsage(null);

          await compactCodexThread(commandSessionId);
          setPendingTurn((current) => {
            if (current?.sessionId === commandSessionId) {
              return current;
            }
            return {
              sessionId: commandSessionId,
              turnId: null,
            };
          });
          showCommandNoticeForDuration("Compaction started.");
          void syncSessionWaitState(commandSessionId);
          return true;
        } catch (error) {
          setInteractionError(
            error instanceof Error ? error.message : String(error),
          );
          return false;
        }
      }

      if (commandName === "/agent") {
        if (!commandSessionId) {
          setInteractionError("Select a session before using /agent.");
          return false;
        }
        return openAgentPickerFromCommand(commandSessionId);
      }

      if (commandName === "/review") {
        if (!commandSessionId) {
          setInteractionError("Select a session before using /review.");
          return false;
        }

        const reviewPrompt =
          normalizedArgs || "Review my current changes and find issues.";
        const sent = await sendMessageText(
          {
            text: reviewPrompt,
            images: [],
          },
          {
            sessionIdOverride: commandSessionId,
            cwdOverride: commandSessionData?.project ?? null,
          },
        );
        if (sent) {
          openPaneForCommand("unstaged");
        }
        return sent;
      }

      if (commandName === "/diff") {
        if (!commandSessionId) {
          setInteractionError("Select a session before using /diff.");
          return false;
        }
        openPaneForCommand("unstaged");
        return true;
      }

      if (commandName === "/skills") {
        if (!commandSessionId) {
          setInteractionError("Select a session before using /skills.");
          return false;
        }
        openPaneForCommand("skills", handleRefreshSkills);
        return true;
      }

      if (commandName === "/ps") {
        if (!commandSessionId) {
          setInteractionError("Select a session before using /ps.");
          return false;
        }
        openPaneForCommand("terminal-flow", handleRefreshTerminalRuns);
        return true;
      }

      if (commandName === "/clean") {
        if (!commandSessionId) {
          setInteractionError("Select a session before using /clean.");
          return false;
        }

        try {
          await cleanSessionBackgroundTerminalRuns(commandSessionId);
          openPaneForCommand("terminal-flow", handleRefreshTerminalRuns);
          showCommandNoticeForDuration("Stopping all background terminals.");
          return true;
        } catch (error) {
          setInteractionError(
            error instanceof Error ? error.message : String(error),
          );
          return false;
        }
      }

      if (commandName === "/copy") {
        if (!commandSessionId) {
          setInteractionError("Select a session before using /copy.");
          return false;
        }

        try {
          const messages = await getConversation(commandSessionId);
          let latestAssistantText = "";
          for (let index = messages.length - 1; index >= 0; index -= 1) {
            const message = messages[index];
            if (message?.type !== "assistant") {
              continue;
            }
            const text = extractMessageText(message);
            if (text) {
              latestAssistantText = text;
              break;
            }
          }

          if (!latestAssistantText) {
            setInteractionError("No assistant message available to copy.");
            return false;
          }

          await copyTextToClipboard(latestAssistantText);
          showCommandNoticeForDuration("Copied latest assistant message.");
          return true;
        } catch (error) {
          setInteractionError(
            error instanceof Error ? error.message : String(error),
          );
          return false;
        }
      }

      return false;
    },
    [
      selectedSessionData?.project,
      selectedSessionData?.display,
      selectedTerminalData?.cwd,
      selectedTerminalProject,
      selectedProject,
      newSessionCwd,
      centerView,
      activeComposerSessionData,
      activeComposerSessionId,
      openModelSelectorFromCommand,
      hasPlanMode,
      handleTogglePlanMode,
      applyModeSelection,
      openLeftPane,
      openRightPane,
      showCommandNoticeForDuration,
      collaborationModes.length,
      handleCreateTerminal,
      handleCreateSession,
      focusSessionSearchInput,
      handleRefreshTerminalRuns,
      handleRefreshSkills,
      handleRenameThread,
      openAgentPickerFromCommand,
      upsertSessionFromThreadSummary,
      syncSessionWaitState,
      sendMessageText,
    ],
  );

  const handleConfirmRename = useCallback(async () => {
    if (!activeComposerSessionId) {
      return;
    }

    const renamed = await handleRenameThread(
      activeComposerSessionId,
      renameDraft,
    );
    if (!renamed) {
      return;
    }

    setShowRenameModal(false);
  }, [activeComposerSessionId, handleRenameThread, renameDraft]);

  const handleSelectAgentThread = useCallback(
    (thread: CodexThreadSummary) => {
      upsertSessionFromThreadSummary(thread);
      setSelectedSession(thread.threadId);
      setCenterView("session");
      setShowAgentPicker(false);
      setAgentThreadsError(null);
    },
    [upsertSessionFromThreadSummary],
  );

  const handlePlanProposalAction = useCallback(
    async (sessionId: string, action: "implement" | "stay") => {
      if (!selectedSession || sessionId !== selectedSession) {
        return;
      }

      if (action === "stay") {
        const nextMode = hasPlanMode ? "plan" : DEFAULT_MODE_KEY;
        setSessionMode(sessionId, nextMode);
        if (nextMode === "plan") {
          showCommandNoticeForDuration(
            "Staying in Plan mode. Continue by typing your next planning prompt.",
          );
        } else {
          showCommandNoticeForDuration(
            "Plan mode unavailable. Continue in Default mode.",
          );
        }
        return;
      }

      await sendMessageText(
        {
          text: PLAN_IMPLEMENTATION_MESSAGE,
          images: [],
        },
        {
          modeOverride: DEFAULT_MODE_KEY,
        },
      );
    },
    [
      selectedSession,
      hasPlanMode,
      sendMessageText,
      setSessionMode,
      showCommandNoticeForDuration,
    ],
  );

  const handleFilePathLinkClick = useCallback(
    (href: string): boolean => {
      const projectCandidates: string[] = [];
      const seenProjects = new Set<string>();
      const registerProjectCandidate = (value: string | null | undefined) => {
        const normalized = value?.trim() ?? "";
        if (!normalized || seenProjects.has(normalized)) {
          return;
        }
        seenProjects.add(normalized);
        projectCandidates.push(normalized);
      };

      registerProjectCandidate(selectedSessionData?.project);
      registerProjectCandidate(selectedProject);
      for (const session of sessions) {
        registerProjectCandidate(session.project);
      }

      let target = null;
      for (const projectPath of projectCandidates) {
        const resolved = resolveProjectFileLinkTargetFromHref(
          href,
          projectPath,
        );
        if (resolved) {
          target = resolved;
          break;
        }
      }

      if (!target) {
        return false;
      }

      pendingFilePathLinkTargetRef.current = target.path;
      setFilePathLinkRevealVersion((current) => current + 1);
      openRightPane();
      setSelectedPaneMode("file-tree");
      setSelectedDiffFilePath(target.path);
      setSelectedFileTargetLine(target.line);
      setSelectedFileContentPage(1);
      setSessionDiffError(null);
      setSessionFileContentError(null);
      return true;
    },
    [openRightPane, selectedSessionData?.project, selectedProject, sessions],
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const listener = (event: Event) => {
      const customEvent = event as CustomEvent<{ href?: unknown }>;
      const hrefValue = customEvent.detail?.href;
      if (typeof hrefValue !== "string" || hrefValue.trim().length === 0) {
        return;
      }
      handleFilePathLinkClick(hrefValue);
    };

    window.addEventListener("codex-deck:file-path-link-click", listener);
    return () => {
      window.removeEventListener("codex-deck:file-path-link-click", listener);
    };
  }, [handleFilePathLinkClick]);

  const handleToolbarTogglePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.pointerType === "mouse") {
        // Keep focus on the composer textarea so Enter submits the message.
        event.preventDefault();
      }
    },
    [],
  );

  const stopConversationForSession = useCallback(
    async (sessionId: string | null) => {
      if (!sessionId || pendingTurn?.sessionId !== sessionId || stoppingTurn) {
        return;
      }

      const targetSessionId = sessionId;
      waitSuppressSessionsRef.current.add(targetSessionId);
      setTimeout(() => {
        waitSuppressSessionsRef.current.delete(targetSessionId);
      }, 3000);
      setPendingUserMessagesBySession((current) => {
        const existing = current[targetSessionId] ?? [];
        if (existing.length > 0) {
          ignoredPendingConfirmationCountBySessionRef.current[targetSessionId] =
            (ignoredPendingConfirmationCountBySessionRef.current[
              targetSessionId
            ] ?? 0) + existing.length;
        }
        if (!(targetSessionId in current)) {
          return current;
        }
        const next = { ...current };
        delete next[targetSessionId];
        return next;
      });
      // Always unlock UI immediately on manual stop, even if interrupt request is slow.
      setPendingTurn(null);
      setStoppingTurn(true);
      setInteractionError(null);

      void (async () => {
        try {
          await interruptCodexThread(targetSessionId);
        } catch (error) {
          setInteractionError(
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          setStoppingTurn(false);
        }
      })();
    },
    [pendingTurn, stoppingTurn],
  );

  const handleStopConversation = useCallback(async () => {
    if (!selectedSession) {
      return;
    }
    await stopConversationForSession(selectedSession);
  }, [selectedSession, stopConversationForSession]);

  useEffect(() => {
    if (!selectedSession || !isPageVisible || centerView !== "session") {
      return;
    }

    const requestedTurnId =
      pendingTurnRef.current?.sessionId === selectedSession
        ? pendingTurnRef.current.turnId
        : null;

    void syncSessionWaitState(selectedSession, requestedTurnId);
  }, [centerView, selectedSession, isPageVisible, syncSessionWaitState]);

  const isGeneratingForSelectedSession =
    !!selectedSession && pendingTurn?.sessionId === selectedSession;
  const isSendingLocked = sendingMessage;
  const isGeneratingForWorkflowComposer =
    !!workflowComposerSessionId &&
    pendingTurn?.sessionId === workflowComposerSessionId;
  const isWorkflowComposerLocked = sendingMessage || workflowActionBusy;
  const isGeneratingForTerminalComposer =
    !!terminalComposerSessionId &&
    pendingTurn?.sessionId === terminalComposerSessionId;
  const isGeneratingForActiveWaitSession =
    !!activeWaitSessionId && pendingTurn?.sessionId === activeWaitSessionId;
  const isTerminalComposerLocked = sendingMessage || terminalBindingBusy;

  const handleWorkflowComposerSendMessage = useCallback(
    async (payload: MessageComposerSubmitPayload): Promise<boolean> => {
      if (!workflowComposerSessionId) {
        return false;
      }

      const sent = await sendMessageText(payload, {
        sessionIdOverride: workflowComposerSessionId,
        cwdOverride: workflowComposerProjectRoot,
      });
      if (!sent) {
        return false;
      }

      const normalizedText = payload.text.trim();
      if (!normalizedText) {
        return true;
      }

      setMessageHistoryBySession((current) => {
        const sessionHistory = current[workflowComposerSessionId] ?? [];
        return {
          ...current,
          [workflowComposerSessionId]: [...sessionHistory, normalizedText],
        };
      });
      return true;
    },
    [sendMessageText, workflowComposerProjectRoot, workflowComposerSessionId],
  );

  const handleTerminalComposerSendMessage = useCallback(
    async (payload: MessageComposerSubmitPayload): Promise<boolean> => {
      if (!terminalComposerSessionId || !selectedTerminalData) {
        return false;
      }

      const normalizedText = payload.text.trim();
      const normalizedImages = payload.images.filter(
        (imageUrl) =>
          typeof imageUrl === "string" && imageUrl.trim().length > 0,
      );
      if (!normalizedText && normalizedImages.length === 0) {
        return false;
      }

      const requestedMode = getSessionMode(terminalComposerSessionId);
      const modeToUse = normalizeModeKey(requestedMode);
      const modeOption =
        collaborationModes.find((mode) => mode.mode === modeToUse) ?? null;
      const effectiveModelIdForRequest = getEffectiveModelId({
        selectedModelId,
        selectedModeOption: modeOption,
        configDefaults,
        models,
      });
      const effectiveReasoningEffortForRequest = getEffectiveReasoningEffort({
        selectedEffort,
        selectedModeKey: modeToUse,
        selectedModeOption: modeOption,
        configDefaults,
        models,
        effectiveModelId: effectiveModelIdForRequest,
      });
      const collaborationMode = getCollaborationModeRequestValue({
        selectedModeKey: modeToUse,
        selectedModeOption: modeOption,
        effectiveModelId: effectiveModelIdForRequest,
        effectiveReasoningEffort: effectiveReasoningEffortForRequest,
      });
      if (modeToUse !== DEFAULT_MODE_KEY && !collaborationMode) {
        setInteractionError(
          "Selected collaboration mode is not ready yet. Wait for model info to load and try again.",
        );
        return false;
      }

      const pendingId = enqueuePendingUserMessage(terminalComposerSessionId, payload);
      setSendingMessage(true);
      setInteractionError(null);
      waitSuppressSessionsRef.current.delete(terminalComposerSessionId);

      try {
        const response = await runTerminalChatAction({
          action: "send",
          payload,
          collaborationMode,
        });
        if (!response) {
          removePendingUserMessageById(terminalComposerSessionId, pendingId);
          return false;
        }

        setSessionMode(terminalComposerSessionId, modeToUse);
        markPendingUserMessageAwaitingConfirmation(
          terminalComposerSessionId,
          pendingId,
        );
        if (response.turnId) {
          setPendingTurn({
            sessionId: terminalComposerSessionId,
            turnId: response.turnId,
          });
        }

        if (normalizedText) {
          setMessageHistoryBySession((current) => {
            const sessionHistory = current[terminalComposerSessionId] ?? [];
            return {
              ...current,
              [terminalComposerSessionId]: [...sessionHistory, normalizedText],
            };
          });
        }
        return true;
      } catch (error) {
        removePendingUserMessageById(terminalComposerSessionId, pendingId);
        const message = error instanceof Error ? error.message : String(error);
        if (isSessionUnavailableMessage(message)) {
          notifySessionUnavailable();
          return false;
        }
        setInteractionError(message);
        return false;
      } finally {
        setSendingMessage(false);
      }
    },
    [
      collaborationModes,
      configDefaults,
      enqueuePendingUserMessage,
      getSessionMode,
      markPendingUserMessageAwaitingConfirmation,
      models,
      normalizeModeKey,
      notifySessionUnavailable,
      removePendingUserMessageById,
      runTerminalChatAction,
      selectedTerminalData,
      selectedEffort,
      selectedModelId,
      setSessionMode,
      terminalComposerSessionId,
    ],
  );

  const handleTerminalRestarted = useCallback(() => {
    void sendTerminalRestartNoticeToBoundSession({
      boundSessionId: terminalComposerSessionId,
      cwd: selectedTerminalData?.cwd ?? null,
      sendMessage: sendMessageText,
    }).catch((error) => {
      setInteractionError(
        error instanceof Error ? error.message : String(error),
      );
    });
  }, [selectedTerminalData?.cwd, sendMessageText, terminalComposerSessionId]);

  const handleWorkflowComposerInit = useCallback(
    async (payload: MessageComposerSubmitPayload): Promise<boolean> => {
      const sessionId = await initializeWorkflowChatSession({
        openInSessionView: false,
        initialMessagePayload: payload,
      });
      return Boolean(sessionId);
    },
    [initializeWorkflowChatSession],
  );

  const handleTerminalComposerInit = useCallback(
    async (payload: MessageComposerSubmitPayload): Promise<boolean> => {
      const sessionId = await initializeTerminalChatSession({
        action: "init",
        openInSessionView: false,
        initialMessagePayload: payload,
      });
      return Boolean(sessionId);
    },
    [initializeTerminalChatSession],
  );

  const handleStopWorkflowComposerConversation = useCallback(async () => {
    await stopConversationForSession(workflowComposerSessionId);
  }, [stopConversationForSession, workflowComposerSessionId]);

  const handleStopTerminalComposerConversation = useCallback(async () => {
    await stopConversationForSession(terminalComposerSessionId);
  }, [stopConversationForSession, terminalComposerSessionId]);

  const handleApproveAiTerminalStep = useCallback(
    async (input: {
      sessionId: string;
      terminalId: string;
      messageKey: string;
      step: AiTerminalStepDirective;
    }): Promise<boolean> => {
      setInteractionError(null);

      try {
        const { actionPersistError } = await runApprovedAiTerminalStepInTerminal(
          input,
          {
            claimTerminalWrite: claimTerminalWriteRequest,
            persistTerminalMessageAction: persistTerminalMessageActionRequest,
            releaseTerminalWrite: releaseTerminalWriteRequest,
            sendTerminalInput: sendTerminalInputRequest,
          },
        );

        if (actionPersistError) {
          setInteractionError(
            `Command was approved, but the approval was not saved: ${actionPersistError}`,
          );
        }
        return true;
      } catch (error) {
        setInteractionError(
          error instanceof Error ? error.message : String(error),
        );
        return false;
      }
    },
    [
      claimTerminalWriteRequest,
      persistTerminalMessageActionRequest,
      releaseTerminalWriteRequest,
      sendTerminalInputRequest,
    ],
  );

  const handleRejectAiTerminalStep = useCallback(
    async (input: {
      sessionId: string;
      terminalId: string;
      messageKey: string;
      step: AiTerminalStepDirective;
      reason: string;
    }): Promise<boolean> => {
      setInteractionError(null);

      let actionPersistError: string | null = null;
      try {
        await persistTerminalMessageActionRequest(input.terminalId, {
          sessionId: input.sessionId,
          messageKey: input.messageKey,
          stepId: input.step.stepId,
          decision: "rejected",
          reason: input.reason,
        });
      } catch (persistError) {
        actionPersistError =
          persistError instanceof Error
            ? persistError.message
            : String(persistError);
      }

      const sent = await sendMessageText(
        {
          text: buildAiTerminalRejectionFeedback({
            stepId: input.step.stepId,
            reason: input.reason,
          }),
          images: [],
        },
        {
          sessionIdOverride: input.sessionId,
          cwdOverride:
            input.step.cwd?.trim() || selectedSessionData?.project || null,
        },
      );
      if (!sent) {
        setInteractionError(
          "Failed to send the terminal step rejection back to the session.",
        );
        return false;
      } else if (actionPersistError) {
        setInteractionError(
          `Step was rejected, but the rejection was not saved: ${actionPersistError}`,
        );
      }
      return true;
    },
    [
      persistTerminalMessageActionRequest,
      selectedSessionData?.project,
      sendMessageText,
    ],
  );

  useEffect(() => {
    if (!activeWaitSessionId || !isGeneratingForActiveWaitSession) {
      setWaitSilenceStartedAt(null);
      setShowFixDangling(false);
      setShowFixDanglingConfirm(false);
      setFixDanglingTargetSessionId(null);
      setFixingDangling(false);
      return;
    }

    setWaitSilenceStartedAt(Date.now());
    setShowFixDangling(false);
  }, [activeWaitSessionId, isGeneratingForActiveWaitSession]);

  useEffect(() => {
    if (!isGeneratingForActiveWaitSession || waitSilenceStartedAt === null) {
      return;
    }

    const elapsed = Date.now() - waitSilenceStartedAt;
    if (elapsed >= FIX_DANGLING_WAIT_THRESHOLD_MS) {
      setShowFixDangling(true);
      return;
    }

    const timeout = setTimeout(() => {
      setShowFixDangling(true);
    }, FIX_DANGLING_WAIT_THRESHOLD_MS - elapsed);

    return () => {
      clearTimeout(timeout);
    };
  }, [isGeneratingForActiveWaitSession, waitSilenceStartedAt]);

  const handleConversationActivity = useCallback(
    (
      sessionId: string,
      details?: {
        hasVisibleMessageIncrease: boolean;
        phase: "bootstrap" | "incremental";
        done: boolean;
        turnLifecycleEvents?: Array<{
          type: "task_started" | "task_complete" | "turn_aborted";
          turnId: string | null;
        }>;
      },
    ) => {
      if (!activeWaitSessionId || sessionId !== activeWaitSessionId) {
        return;
      }

      const turnLifecycleEvents = details?.turnLifecycleEvents ?? [];

      // Process turn lifecycle events — this is the primary signal
      if (turnLifecycleEvents.length > 0) {
        for (const event of turnLifecycleEvents) {
          if (event.type === "task_started") {
            setPendingTurn(() => {
              return { sessionId, turnId: event.turnId };
            });
          } else if (
            event.type === "task_complete" ||
            event.type === "turn_aborted"
          ) {
            setPendingTurn((current) =>
              current?.sessionId === sessionId ? null : current,
            );
          }
        }
      }

      if (
        details?.phase === "incremental" &&
        details.done &&
        (details.hasVisibleMessageIncrease || turnLifecycleEvents.length > 0)
      ) {
        const requestedTurnId =
          pendingTurnRef.current?.sessionId === sessionId
            ? pendingTurnRef.current.turnId
            : (turnLifecycleEvents[turnLifecycleEvents.length - 1]?.turnId ??
              null);
        scheduleSettledWaitStateSync(sessionId, requestedTurnId);
      }

      // Reset wait silence timer on visible message activity
      if (
        activeWaitSessionId === sessionId &&
        pendingTurnRef.current?.sessionId === sessionId &&
        details?.hasVisibleMessageIncrease
      ) {
        setWaitSilenceStartedAt(Date.now());
        setShowFixDangling(false);
      }
    },
    [activeWaitSessionId, scheduleSettledWaitStateSync],
  );

  const handleTerminalEmbeddedMessagesBatch = useCallback(
    (
      sessionId: string,
      newMessages: ConversationMessage[],
      batch?: ConversationStreamBatch,
    ) => {
      terminalEmbeddedRawMessagesRef.current = mergeDisplayConversationMessages(
        terminalEmbeddedRawMessagesRef.current,
        newMessages,
        batch?.insertion ?? "append",
      );
      const mergedMessages = terminalEmbeddedRawMessagesRef.current;
      const persistedStepStatesByMessageKey =
        deriveAiTerminalStepStatesByMessageKey(mergedMessages, {
          getMessage: (message) => message,
          getMessageKey: (message, _messageIndex, planIndex) =>
            getAiTerminalMessageKey(message) ??
            `terminal-ai:${sessionId}:${planIndex}`,
        });
      setTerminalEmbeddedMessages({
        sessionId,
        messages: mergedMessages
          .filter((message) => {
            if (message.type !== "assistant") {
              return false;
            }
            return (
              parseAiTerminalMessage(
                extractConversationMessageText(message),
              ) !== null
            );
          })
          .map((message, index) => ({
            messageKey:
              getAiTerminalMessageKey(message) ??
              `terminal-ai:${sessionId}:${index}`,
            message,
          })),
        persistedStepStatesByMessageKey,
      });
      setTerminalEmbeddedMessagesLoading(false);
      handleConversationActivity(sessionId, {
        ...getConversationActivityDetails(
          newMessages,
          batch?.phase ?? "incremental",
          batch?.insertion ?? "append",
        ),
        phase: batch?.phase ?? "incremental",
        done: batch?.done ?? true,
      });
    },
    [
      deriveAiTerminalStepStatesByMessageKey,
      extractConversationMessageText,
      getAiTerminalMessageKey,
      handleConversationActivity,
      parseAiTerminalMessage,
    ],
  );

  const handleTerminalEmbeddedMessagesHeartbeat = useCallback(() => {
    setTerminalEmbeddedMessagesLoading(false);
  }, []);

  useEffect(() => {
    const normalizedSessionId = workflowComposerSessionId?.trim() ?? "";
    if (centerView !== "workflow" || !normalizedSessionId) {
      setWorkflowLatestSessionPreview({
        sessionId: null,
        message: null,
      });
      setWorkflowLatestSessionPreviewLoading(false);
      return;
    }

    if (!isPageVisible) {
      setWorkflowLatestSessionPreviewLoading(false);
      return;
    }

    let mergedMessages: ConversationMessage[] = [];
    setWorkflowLatestSessionPreviewLoading(true);
    setWorkflowLatestSessionPreview((current) =>
      current.sessionId === normalizedSessionId
        ? current
        : {
            sessionId: normalizedSessionId,
            message: null,
          },
    );

    const requestedTurnId =
      pendingTurnRef.current?.sessionId === normalizedSessionId
        ? pendingTurnRef.current.turnId
        : null;
    void syncSessionWaitState(normalizedSessionId, requestedTurnId);

    return subscribeConversationStream(
      normalizedSessionId,
      {
        onMessages: (newMessages, batch) => {
          mergedMessages = mergeDisplayConversationMessages(
            mergedMessages,
            newMessages,
            batch?.insertion ?? "append",
          );
          setWorkflowLatestSessionPreview({
            sessionId: normalizedSessionId,
            message: getLatestWorkflowCreatePreviewMessage(mergedMessages),
          });
          setWorkflowLatestSessionPreviewLoading(false);
          handleConversationActivity(normalizedSessionId, {
            ...getConversationActivityDetails(
              newMessages,
              batch?.phase ?? "incremental",
              batch?.insertion ?? "append",
            ),
            phase: batch?.phase ?? "incremental",
            done: batch?.done ?? true,
          });
        },
        onHeartbeat: () => {
          setWorkflowLatestSessionPreviewLoading(false);
        },
        onError: () => {
          setWorkflowLatestSessionPreviewLoading(false);
        },
      },
      {
        initialOffset: 0,
      },
    );
  }, [
    centerView,
    handleConversationActivity,
    isPageVisible,
    syncSessionWaitState,
    workflowComposerSessionId,
  ]);

  useEffect(() => {
    const normalizedSessionId = terminalComposerSessionId?.trim() ?? "";
    if (centerView !== "terminal" || !normalizedSessionId) {
      terminalEmbeddedRawMessagesRef.current = [];
      setTerminalEmbeddedMessages({
        sessionId: null,
        messages: [],
        persistedStepStatesByMessageKey: {},
      });
      setTerminalEmbeddedMessagesLoading(false);
      return;
    }

    if (!isPageVisible) {
      setTerminalEmbeddedMessagesLoading(false);
      return;
    }

    terminalEmbeddedRawMessagesRef.current = [];
    setTerminalEmbeddedMessagesLoading(true);
    setTerminalEmbeddedMessages((current) =>
      current.sessionId === normalizedSessionId
        ? current
        : {
            sessionId: normalizedSessionId,
            messages: [],
            persistedStepStatesByMessageKey: {},
          },
    );

    const requestedTurnId =
      pendingTurnRef.current?.sessionId === normalizedSessionId
        ? pendingTurnRef.current.turnId
        : null;
    const timer = setTimeout(() => {
      void syncSessionWaitState(normalizedSessionId, requestedTurnId);
    }, 400);

    const unsubscribe = subscribeConversationStream(
      normalizedSessionId,
      {
        onMessages: (newMessages, batch) => {
          handleTerminalEmbeddedMessagesBatch(
            normalizedSessionId,
            newMessages,
            batch,
          );
        },
        onHeartbeat: handleTerminalEmbeddedMessagesHeartbeat,
        onError: handleTerminalEmbeddedMessagesHeartbeat,
      },
      {
        initialOffset: 0,
      },
    );

    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [
    centerView,
    handleTerminalEmbeddedMessagesBatch,
    handleTerminalEmbeddedMessagesHeartbeat,
    isPageVisible,
    syncSessionWaitState,
    terminalComposerSessionId,
  ]);

  const handleMessageHistoryChange = useCallback(
    (
      sessionId: string,
      history: string[],
      confirmedUserMessageCount: number,
    ) => {
      setMessageHistoryBySession((current) => {
        const existing = current[sessionId] ?? [];
        if (
          existing.length === history.length &&
          existing.every((value, index) => value === history[index])
        ) {
          return current;
        }

        return {
          ...current,
          [sessionId]: history,
        };
      });

      const previousCount =
        confirmedComposerUserMessageCountBySessionRef.current[sessionId] ?? 0;
      const normalizedCount =
        Number.isFinite(confirmedUserMessageCount) &&
        confirmedUserMessageCount >= 0
          ? Math.floor(confirmedUserMessageCount)
          : previousCount;
      confirmedComposerUserMessageCountBySessionRef.current[sessionId] =
        normalizedCount;

      const confirmedDelta = normalizedCount - previousCount;
      let pendingDeltaToConsume = confirmedDelta;
      const ignoredPendingConfirmations =
        ignoredPendingConfirmationCountBySessionRef.current[sessionId] ?? 0;
      if (ignoredPendingConfirmations > 0 && pendingDeltaToConsume > 0) {
        const ignoredNow = Math.min(
          ignoredPendingConfirmations,
          pendingDeltaToConsume,
        );
        const remainingIgnored = ignoredPendingConfirmations - ignoredNow;
        if (remainingIgnored > 0) {
          ignoredPendingConfirmationCountBySessionRef.current[sessionId] =
            remainingIgnored;
        } else {
          delete ignoredPendingConfirmationCountBySessionRef.current[sessionId];
        }
        pendingDeltaToConsume -= ignoredNow;
      }

      if (pendingDeltaToConsume > 0) {
        setPendingUserMessagesBySession((current) =>
          consumeConfirmedPendingUserMessages(
            current,
            sessionId,
            pendingDeltaToConsume,
          ),
        );
      }
    },
    [],
  );

  const handleStreamConnect = useCallback(
    (sessionId: string) => {
      if (!selectedSession || sessionId !== selectedSession) {
        return;
      }
      const requestedTurnId =
        pendingTurnRef.current?.sessionId === sessionId
          ? pendingTurnRef.current.turnId
          : null;
      void syncSessionWaitState(sessionId, requestedTurnId);
    },
    [selectedSession, syncSessionWaitState],
  );

  const handleFixDangling = useCallback(() => {
    if (!activeWaitSessionId || fixingDangling) {
      return;
    }

    setFixDanglingTargetSessionId(activeWaitSessionId);
    setShowFixDanglingConfirm(true);
  }, [activeWaitSessionId, fixingDangling]);

  const handleRequestDeleteSession = useCallback((sessionId: string) => {
    setDeleteSessionTargetId(sessionId);
    setInteractionError(null);
  }, []);

  const handleRequestDeleteTerminal = useCallback((terminalId: string) => {
    setDeleteTerminalTargetId(terminalId);
    setInteractionError(null);
  }, []);

  const handleRequestDeleteWorkflow = useCallback((workflowKey: string) => {
    setDeleteWorkflowTargetId(workflowKey);
    setInteractionError(null);
  }, []);

  const handleRequestDeleteLeftPaneItem = useMemo(() => {
    if (centerView === "terminal") {
      return handleRequestDeleteTerminal;
    }
    if (centerView === "workflow") {
      return handleRequestDeleteWorkflow;
    }
    return handleRequestDeleteSession;
  }, [
    centerView,
    handleRequestDeleteSession,
    handleRequestDeleteTerminal,
    handleRequestDeleteWorkflow,
  ]);

  const handleConfirmDeleteSession = useCallback(async () => {
    if (!deleteSessionTargetId || deletingSession) {
      return;
    }

    setDeletingSession(true);
    setInteractionError(null);

    try {
      const response = await deleteSessionRequest(
        deleteSessionTargetId,
        pageClientIdRef.current,
      );
      removeSessionFromLocalState(response.sessionId);
      setDeleteSessionTargetId(null);
      showCommandNoticeForDuration("Deleted session.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isSessionUnavailableMessage(message)) {
        notifyDeletedSessionAndCleanup(deleteSessionTargetId);
        setDeleteSessionTargetId(null);
      } else {
        setInteractionError(message);
      }
    } finally {
      setDeletingSession(false);
    }
  }, [
    deleteSessionTargetId,
    deletingSession,
    removeSessionFromLocalState,
    showCommandNoticeForDuration,
    notifyDeletedSessionAndCleanup,
  ]);

  const handleConfirmDeleteTerminal = useCallback(async () => {
    if (!deleteTerminalTargetId || deletingTerminal) {
      return;
    }

    setDeletingTerminal(true);
    setInteractionError(null);

    try {
      await deleteTerminalRequest(deleteTerminalTargetId);
      setTerminals((current) =>
        current.filter((terminal) => terminal.id !== deleteTerminalTargetId),
      );
      if (selectedTerminalId === deleteTerminalTargetId) {
        setSelectedTerminalId(null);
      }
      setDeleteTerminalTargetId(null);
      showCommandNoticeForDuration("Terminated terminal.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("terminal not found")) {
        setTerminals((current) =>
          current.filter((terminal) => terminal.id !== deleteTerminalTargetId),
        );
        if (selectedTerminalId === deleteTerminalTargetId) {
          setSelectedTerminalId(null);
        }
        setDeleteTerminalTargetId(null);
      } else {
        setInteractionError(message);
      }
    } finally {
      setDeletingTerminal(false);
    }
  }, [
    deleteTerminalTargetId,
    deletingTerminal,
    selectedTerminalId,
    showCommandNoticeForDuration,
  ]);

  const handleConfirmDeleteWorkflow = useCallback(async () => {
    if (!deleteWorkflowTargetId || deletingWorkflow || workflowActionBusy) {
      return;
    }

    setDeletingWorkflow(true);
    setInteractionError(null);

    try {
      await deleteWorkflowRequest(deleteWorkflowTargetId);
      setWorkflows((current) =>
        current.filter((workflow) => workflow.key !== deleteWorkflowTargetId),
      );
      if (selectedWorkflowKey === deleteWorkflowTargetId) {
        setSelectedWorkflowKey(null);
      }
      setDeleteWorkflowTargetId(null);
      showCommandNoticeForDuration("Deleted workflow.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("workflow not found")) {
        setWorkflows((current) =>
          current.filter((workflow) => workflow.key !== deleteWorkflowTargetId),
        );
        if (selectedWorkflowKey === deleteWorkflowTargetId) {
          setSelectedWorkflowKey(null);
        }
        setDeleteWorkflowTargetId(null);
      } else {
        setInteractionError(message);
      }
    } finally {
      setDeletingWorkflow(false);
    }
  }, [
    deleteWorkflowTargetId,
    deletingWorkflow,
    selectedWorkflowKey,
    showCommandNoticeForDuration,
    workflowActionBusy,
  ]);

  // Fix dangling: triggered ONLY by the user clicking the "Fix dangling"
  // confirmation button. Must never be called automatically.
  const handleConfirmFixDangling = useCallback(async () => {
    if (!fixDanglingTargetSessionId || fixingDangling) {
      return;
    }
    const targetSessionId = fixDanglingTargetSessionId;

    setShowFixDanglingConfirm(false);
    setFixingDangling(true);
    setInteractionError(null);
    try {
      await fixDanglingSession(targetSessionId);
      setWaitSilenceStartedAt(Date.now());
      setShowFixDangling(false);
      setPendingTurn((current) =>
        current?.sessionId === targetSessionId ? null : current,
      );
      waitSuppressSessionsRef.current.delete(targetSessionId);
    } catch (error) {
      setInteractionError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setFixingDangling(false);
      setFixDanglingTargetSessionId(null);
    }
  }, [fixDanglingTargetSessionId, fixingDangling]);

  const newSessionPlaceholder =
    (centerView === "terminal" ? terminalCwdForCreate : sessionCwdForCreate) ||
    "/path/to/project/";
  const contextWindowText =
    typeof contextLeftPercent === "number"
      ? `${Math.max(0, Math.min(100, Math.round(contextLeftPercent)))}% context left`
      : typeof contextUsedTokens === "number"
        ? `${TOKEN_COUNT_FORMATTER.format(Math.max(0, Math.round(contextUsedTokens)))} used`
        : "100% context left";

  const updateToolbarCompactState = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }
    const toolbarWidthElement = toolbarWidthRef.current;
    const toolbarMeasureElement = toolbarMeasureRef.current;
    if (!toolbarWidthElement || !toolbarMeasureElement) {
      return;
    }

    const measuredChildren = Array.from(toolbarMeasureElement.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    );
    if (measuredChildren.length === 0) {
      return;
    }

    const style = window.getComputedStyle(toolbarMeasureElement);
    const gapText =
      style.columnGap && style.columnGap !== "normal" ? style.columnGap : "0";
    const gap = Number.parseFloat(gapText) || 0;
    const requiredWidth =
      measuredChildren.reduce(
        (sum, child) => sum + child.getBoundingClientRect().width,
        0,
      ) +
      gap * Math.max(0, measuredChildren.length - 1);
    const availableWidth = toolbarWidthElement.clientWidth;
    const shouldBeCompact = requiredWidth > availableWidth + 0.5;

    setIsToolbarCompact((current) =>
      current === shouldBeCompact ? current : shouldBeCompact,
    );
    if (!shouldBeCompact) {
      setIsToolbarControlsExpanded(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedSession) {
      setIsToolbarCompact(false);
      setIsToolbarControlsExpanded(false);
      return;
    }

    const frame = window.requestAnimationFrame(updateToolbarCompactState);
    if (typeof ResizeObserver === "undefined") {
      return () => {
        window.cancelAnimationFrame(frame);
      };
    }

    const observer = new ResizeObserver(() => {
      updateToolbarCompactState();
    });
    if (toolbarWidthRef.current) {
      observer.observe(toolbarWidthRef.current);
    }
    if (toolbarMeasureRef.current) {
      observer.observe(toolbarMeasureRef.current);
    }

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [
    selectedSession,
    contextWindowText,
    filteredModels,
    effectiveModelId,
    effectiveReasoningEffort,
    selectedModelId,
    effortOptions,
    selectedEffort,
    hasPlanMode,
    isPlanModeEnabled,
    updateToolbarCompactState,
  ]);

  useEffect(() => {
    setIsToolbarControlsExpanded(false);
  }, [selectedSession]);

  useEffect(() => {
    setShowCollabModePicker(false);
    setShowStatusModal(false);
    setStatusTokenUsage(null);
  }, [selectedSession]);

  const handleSelectCollaborationMode = useCallback(
    (mode: CollaborationModeKey) => {
      applyModeSelection(mode);
      setShowCollabModePicker(false);
    },
    [applyModeSelection],
  );

  const remoteHasSavedBrowserLogin =
    resolvedRemoteServerUrl.trim().length > 0 &&
    hasSavedRemoteAccount(resolvedRemoteServerUrl);
  const remoteAdminUrl = buildRemoteAdminUrl(resolvedRemoteServerUrl);

  if (connectionMode === "remote" && !remoteConnected) {
    return (
      <div className="app-viewport-min-height app-viewport-safe-area flex items-center justify-center bg-zinc-950 px-6 text-zinc-100">
        <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/80 p-6 shadow-2xl">
          <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">
            codex-deck
          </div>
          <h1 className="mt-3 text-2xl font-semibold text-zinc-50">
            Remote Mode
          </h1>
          {!remoteAuthenticated ? (
            <form id="remote-login-form" onSubmit={handleRemoteLoginSubmit}>
              <p className="mt-2 text-sm text-zinc-400">
                Log in with the same username and password that the target CLI
                uses when it registers with this server.
              </p>

              <div className="mt-6 space-y-3">
                <label className="block space-y-1">
                  <span className="text-xs text-zinc-500">Server URL</span>
                  <input
                    value={remoteServerUrl}
                    onChange={(event) => setRemoteServerUrl(event.target.value)}
                    placeholder="https://server.example.com"
                    className="w-full rounded border border-zinc-800 bg-zinc-950/80 px-3 py-2 text-sm text-zinc-100 focus:outline-none"
                  />
                  <span className="text-[11px] text-zinc-500">
                    You can paste the first-login URL printed by the CLI.
                  </span>
                </label>
                <label className="block space-y-1">
                  <span className="text-xs text-zinc-500">Username</span>
                  <input
                    value={remoteUsername}
                    onChange={(event) => setRemoteUsername(event.target.value)}
                    placeholder="CLI login username"
                    className="w-full rounded border border-zinc-800 bg-zinc-950/80 px-3 py-2 text-sm text-zinc-100 focus:outline-none"
                  />
                </label>
                <PasswordField
                  label="Password"
                  value={remotePassword}
                  onChange={setRemotePassword}
                  placeholder="CLI login password"
                  autoComplete="current-password"
                />
              </div>

              <label className="mt-4 inline-flex items-center gap-2 text-xs text-zinc-400">
                <input
                  type="checkbox"
                  checked={remoteLatencyLoggingEnabled}
                  onChange={(event) =>
                    handleToggleRemoteLatencyLogging(event.target.checked)
                  }
                  className="h-3.5 w-3.5 rounded border border-zinc-700 bg-zinc-950"
                />
                Browser remote latency logs
              </label>

              {remoteHasSavedBrowserLogin && (
                <div className="mt-4 rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-400">
                  Saved remote credentials exist for this server and will be
                  reused automatically if still valid.
                </div>
              )}
            </form>
          ) : (
            <div className="mt-6 rounded border border-zinc-800 bg-zinc-950/40 px-3 py-3 text-sm text-zinc-400">
              No CLIs are registered for this remote login yet. Start the CLI
              with `--remote-setup-token`, `--remote-username`, and
              `--remote-password`.
            </div>
          )}

          {remoteError && (
            <div className="mt-4 rounded border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-200">
              {remoteError}
            </div>
          )}

          <div className="mt-6 flex items-center justify-between gap-3">
            <a
              href={remoteAdminUrl ?? undefined}
              aria-disabled={remoteAdminUrl ? undefined : true}
              className={`inline-flex h-10 items-center rounded border px-4 text-sm transition-colors ${
                remoteAdminUrl
                  ? "border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
                  : "cursor-not-allowed border-zinc-900 bg-zinc-950 text-zinc-600 pointer-events-none"
              }`}
            >
              Open Admin
            </a>
            {!remoteAuthenticated ? (
              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  form="remote-login-form"
                  disabled={
                    connectingRemote ||
                    resolvedRemoteServerUrl.trim().length === 0 ||
                    remoteUsername.trim().length === 0 ||
                    remotePassword.length === 0
                  }
                  className="h-10 rounded border border-cyan-700/60 bg-cyan-700/30 px-4 text-sm text-cyan-50 transition-colors hover:bg-cyan-700/40 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {connectingRemote ? "Working..." : "Login"}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  void handleDisconnectRemote();
                }}
                className="h-10 rounded border border-zinc-700 bg-zinc-800/80 px-4 text-sm text-zinc-200 transition-colors hover:bg-zinc-700/80"
              >
                Logout
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const renderComposerFooter = (input: {
    sessionId: string | null;
    draftResetKey?: string;
    history: string[];
    slashCommands: SlashCommandDefinition[];
    isGeneratingForSession: boolean;
    isSendingLocked: boolean;
    sendingMessage: boolean;
    stoppingTurn: boolean;
    onSendMessage: (payload: MessageComposerSubmitPayload) => Promise<boolean>;
    onRunSlashCommand: (commandName: string, args: string) => Promise<boolean>;
    onStopConversation: () => Promise<void>;
    idlePrimaryActionLabel?: string;
    idlePrimaryActionBusy?: boolean;
    idlePrimaryActionBusyLabel?: string;
    allowIdlePrimaryActionWithoutContent?: boolean;
    onIdlePrimaryAction?:
      | ((payload: MessageComposerSubmitPayload) => Promise<boolean>)
      | null;
  }) => (
    <>
      <div className="border-t border-zinc-800/60 bg-zinc-950 px-2.5 py-2">
        <div ref={toolbarWidthRef} className="relative">
          <div
            ref={toolbarMeasureRef}
            aria-hidden="true"
            className="pointer-events-none invisible absolute left-0 top-0 flex items-center gap-2 whitespace-nowrap"
          >
            <button
              type="button"
              disabled
              tabIndex={-1}
              className={`h-8 px-2.5 text-xs rounded border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${modeToggleClassName}`}
            >
              <span className="inline-flex items-center gap-1.5">
                {isNonDefaultModeEnabled ? (
                  <CircleDot className="h-3.5 w-3.5" />
                ) : (
                  <Circle className="h-3.5 w-3.5" />
                )}
                Plan
              </span>
            </button>
            <select
              value={selectedModelId || DEFAULT_OPTION_VALUE}
              onChange={() => {}}
              disabled
              tabIndex={-1}
              className="h-8 min-w-[160px] bg-zinc-900/70 text-zinc-300 text-xs rounded border border-zinc-800 px-2.5 focus:outline-none"
            >
              <option value={selectedModelId || DEFAULT_OPTION_VALUE}>
                {selectedModelId
                  ? (filteredModels.find(
                      (model) => model.id === selectedModelId,
                    )?.displayName ?? selectedModelId)
                  : modelControlLabel}
              </option>
            </select>
            <select
              value={selectedEffort || DEFAULT_OPTION_VALUE}
              onChange={() => {}}
              disabled
              tabIndex={-1}
              className="h-8 min-w-[140px] bg-zinc-900/70 text-zinc-300 text-xs rounded border border-zinc-800 px-2.5 focus:outline-none"
            >
              <option value={selectedEffort || DEFAULT_OPTION_VALUE}>
                {selectedEffort || effortControlLabel}
              </option>
            </select>
            <span className="text-xs text-zinc-500 whitespace-nowrap">
              {contextWindowText}
            </span>
          </div>

          {isToolbarCompact ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  setIsToolbarControlsExpanded((current) => !current)
                }
                className="inline-flex h-8 w-8 items-center justify-center rounded border border-zinc-800 bg-zinc-900/70 text-zinc-300 transition-colors hover:bg-zinc-800/80"
                aria-label={
                  isToolbarControlsExpanded ? "Hide controls" : "Show controls"
                }
                aria-expanded={isToolbarControlsExpanded}
              >
                <svg
                  viewBox="0 0 20 20"
                  aria-hidden="true"
                  className={`h-3.5 w-3.5 transition-transform ${
                    isToolbarControlsExpanded ? "rotate-180" : ""
                  }`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M4 12l6-6 6 6" />
                </svg>
              </button>
              <button
                type="button"
                onPointerDown={handleToolbarTogglePointerDown}
                onClick={handleTogglePlanMode}
                disabled={!hasPlanMode}
                className={`h-8 px-2.5 text-xs rounded border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${modeToggleClassName}`}
                title={modeToggleTitle}
              >
                <span className="inline-flex items-center gap-1.5">
                  {isNonDefaultModeEnabled ? (
                    <CircleDot className="h-3.5 w-3.5" />
                  ) : (
                    <Circle className="h-3.5 w-3.5" />
                  )}
                  Plan
                </span>
              </button>
              <span className="ml-auto text-xs text-zinc-500">
                {contextWindowText}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onPointerDown={handleToolbarTogglePointerDown}
                onClick={handleTogglePlanMode}
                disabled={!hasPlanMode}
                className={`h-8 px-2.5 text-xs rounded border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${modeToggleClassName}`}
                title={modeToggleTitle}
              >
                <span className="inline-flex items-center gap-1.5">
                  {isNonDefaultModeEnabled ? (
                    <CircleDot className="h-3.5 w-3.5" />
                  ) : (
                    <Circle className="h-3.5 w-3.5" />
                  )}
                  Plan
                </span>
              </button>
              <select
                ref={modelSelectRef}
                value={selectedModelId || DEFAULT_OPTION_VALUE}
                onChange={(event) => {
                  const value = event.target.value;
                  setSelectedModelId(
                    value === DEFAULT_OPTION_VALUE ? "" : value,
                  );
                }}
                className="h-8 min-w-[160px] bg-zinc-900/70 text-zinc-300 text-xs rounded border border-zinc-800 px-2.5 focus:outline-none"
              >
                <option value={DEFAULT_OPTION_VALUE}>
                  {modelControlLabel}
                </option>
                {filteredModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName}
                  </option>
                ))}
              </select>
              <select
                value={selectedEffort || DEFAULT_OPTION_VALUE}
                onChange={(event) => {
                  const value = event.target.value;
                  setSelectedEffort(
                    value === DEFAULT_OPTION_VALUE
                      ? ""
                      : (value as CodexReasoningEffort),
                  );
                }}
                className="h-8 min-w-[140px] bg-zinc-900/70 text-zinc-300 text-xs rounded border border-zinc-800 px-2.5 focus:outline-none"
              >
                <option value={DEFAULT_OPTION_VALUE}>
                  {effortControlLabel}
                </option>
                {effortOptions.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
              <span className="ml-auto text-xs text-zinc-500">
                {contextWindowText}
              </span>
            </div>
          )}
        </div>

        {isToolbarCompact && isToolbarControlsExpanded && (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <select
              ref={compactModelSelectRef}
              value={selectedModelId || DEFAULT_OPTION_VALUE}
              onChange={(event) => {
                const value = event.target.value;
                setSelectedModelId(value === DEFAULT_OPTION_VALUE ? "" : value);
              }}
              className="h-8 min-w-[160px] bg-zinc-900/70 text-zinc-300 text-xs rounded border border-zinc-800 px-2.5 focus:outline-none"
            >
              <option value={DEFAULT_OPTION_VALUE}>{modelControlLabel}</option>
              {filteredModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName}
                </option>
              ))}
            </select>
            <select
              value={selectedEffort || DEFAULT_OPTION_VALUE}
              onChange={(event) => {
                const value = event.target.value;
                setSelectedEffort(
                  value === DEFAULT_OPTION_VALUE
                    ? ""
                    : (value as CodexReasoningEffort),
                );
              }}
              className="h-8 min-w-[140px] bg-zinc-900/70 text-zinc-300 text-xs rounded border border-zinc-800 px-2.5 focus:outline-none"
            >
              <option value={DEFAULT_OPTION_VALUE}>{effortControlLabel}</option>
              {effortOptions.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <MessageComposer
        sessionId={input.sessionId}
        draftResetKey={input.draftResetKey}
        history={input.history}
        slashCommands={input.slashCommands}
        isGeneratingForSelectedSession={input.isGeneratingForSession}
        isSendingLocked={input.isSendingLocked}
        sendingMessage={input.sendingMessage}
        stoppingTurn={input.stoppingTurn}
        idlePrimaryActionLabel={input.idlePrimaryActionLabel}
        idlePrimaryActionBusy={input.idlePrimaryActionBusy}
        idlePrimaryActionBusyLabel={input.idlePrimaryActionBusyLabel}
        allowIdlePrimaryActionWithoutContent={
          input.allowIdlePrimaryActionWithoutContent
        }
        onIdlePrimaryAction={input.onIdlePrimaryAction}
        messageBoxHeight={messageBoxHeight}
        onResizeMessageBoxStart={handleResizeMessageBoxStart}
        onSendMessage={input.onSendMessage}
        onRunSlashCommand={input.onRunSlashCommand}
        onStopConversation={input.onStopConversation}
      />
    </>
  );

  function SessionHeader(props: SessionHeaderProps) {
    const {
      session,
      copied,
      isMobilePhone,
      railCollapsedByDefault,
      conversationSearchOpen,
      resolvedTheme,
      onCopySessionId,
      onCopyProjectPath,
      onToggleConversationSearch,
      onToggleRailCollapsedByDefault,
      onToggleTheme,
    } = props;

    return (
      <>
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <button
            type="button"
            onClick={onToggleRailCollapsedByDefault}
            className={`h-8 shrink-0 rounded border px-2.5 text-[11px] font-medium transition-colors ${
              railCollapsedByDefault
                ? "border-cyan-500/40 bg-cyan-500/15 text-cyan-100 hover:bg-cyan-500/20"
                : "border-zinc-700 bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800/80"
            }`}
            title={
              railCollapsedByDefault
                ? "Switch all rails to block mode"
                : "Switch all rails to collapsed text mode"
            }
          >
            {railCollapsedByDefault ? "Text Mode" : "Block Mode"}
          </button>
          <span className="text-sm text-zinc-300 truncate max-w-xs">
            {session.display}
          </span>
          {session.project ? (
            <button
              type="button"
              onClick={() => onCopyProjectPath(session.project)}
              className="max-w-[14rem] shrink-0 truncate text-left text-xs text-zinc-600 transition-colors hover:text-zinc-300"
              title={`Copy project path: ${session.project}`}
              aria-label="Copy project path"
            >
              {session.projectName || getPathBaseName(session.project)}
            </button>
          ) : (
            <span className="text-xs text-zinc-600 shrink-0">
              {session.projectName}
            </span>
          )}
          <span className="text-xs text-zinc-600 shrink-0">
            {formatTime(session.timestamp)}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onToggleConversationSearch}
            className={`h-8 w-8 shrink-0 rounded border transition-colors cursor-pointer ${
              conversationSearchOpen
                ? "border-cyan-500/50 bg-cyan-500/16 text-cyan-100 hover:bg-cyan-500/22"
                : "border-zinc-700 bg-zinc-800/70 text-zinc-300 hover:bg-zinc-700/80"
            }`}
            title={
              conversationSearchOpen
                ? "Hide conversation search"
                : "Search this conversation"
            }
            aria-label={
              conversationSearchOpen
                ? "Hide conversation search"
                : "Search this conversation"
            }
          >
            <Search className="mx-auto h-3.5 w-3.5" />
          </button>
          <ThemeToggleButton
            resolvedTheme={resolvedTheme}
            onToggleTheme={onToggleTheme}
          />
          {!isMobilePhone && (
            <button
              onClick={() => onCopySessionId(session.id)}
              className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded transition-colors cursor-pointer shrink-0"
              title="Copy session ID to clipboard"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-green-500" />
                  <span className="text-green-500">Copied!</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy ID</span>
                </>
              )}
            </button>
          )}
        </div>
      </>
    );
  }

  return (
    <div className="app-viewport-height app-viewport-safe-area flex bg-zinc-950 text-zinc-100">
      {!sidebarCollapsed && (
        <aside
          className="pane-left relative shrink-0 border-r border-zinc-800/60 flex flex-col bg-zinc-950"
          style={{ width: `${leftPaneWidth}px` }}
        >
          <div className="pane-header-left border-b border-zinc-800/60">
            <div className="flex min-h-[50px] items-center gap-2 px-4 py-2">
              <button
                type="button"
                onClick={() => setSidebarCollapsed(true)}
                className="h-8 w-8 shrink-0 rounded border border-zinc-700 bg-zinc-900/70 text-zinc-300 transition-colors hover:bg-zinc-800/80"
                aria-label="Collapse left pane"
                title="Collapse left pane"
              >
                <ChevronLeft className="mx-auto h-4 w-4" />
              </button>
              <div className="flex min-w-0 flex-1 items-center justify-between gap-2 overflow-hidden rounded border border-zinc-800 bg-zinc-900/60 px-2 py-2">
                <div className="shrink-0 text-[11px] uppercase tracking-[0.16em] text-zinc-500">
                  {remoteConnected ? "Remote" : "Local"}
                </div>
                <div className="flex min-w-0 items-center justify-end gap-1.5 overflow-hidden">
                  {remoteConnected && (
                    <button
                      type="button"
                      onClick={() => {
                        void handleDisconnectRemote();
                      }}
                      className="h-7 min-w-0 max-w-full shrink truncate rounded border border-zinc-700 bg-zinc-800/80 px-2 text-[11px] text-zinc-200 transition-colors hover:bg-zinc-700/80"
                      title="Log out from remote mode"
                    >
                      Logout
                    </button>
                  )}
                  {!remoteConnected && (
                    <button
                      type="button"
                      onClick={() => {
                        setConnectionMode("remote");
                        setRemoteError(null);
                        setRemoteAutoRestoreServerUrl(null);
                      }}
                      className="h-7 min-w-0 max-w-full shrink truncate rounded border border-zinc-700 bg-zinc-800/80 px-2 text-[11px] text-zinc-200 transition-colors hover:bg-zinc-700/80"
                      title="Remote Login"
                    >
                      Remote Login
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-2 px-3 pb-3">
              {remoteConnected && remoteMachines.length > 0 && (
                <label className="block">
                  <select
                    value={selectedRemoteMachine || ""}
                    onChange={(event) =>
                      handleSelectRemoteMachine(event.target.value || null)
                    }
                    className="w-full h-9 bg-zinc-900/70 text-zinc-300 text-xs rounded border border-zinc-800 px-2.5 focus:outline-none"
                  >
                    {remoteMachines.map((machine) => (
                      <option key={machine.id} value={machine.id}>
                        {machine.metadata
                          ? `${machine.metadata.label} · ${machine.metadata.host}`
                          : machine.id}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <div className="grid grid-cols-3 items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleSelectTerminal()}
                  className={`rounded border px-2.5 py-2 text-left text-xs transition-colors ${
                    centerView === "terminal"
                      ? "border-cyan-500/50 bg-cyan-700/30 text-cyan-100"
                      : "border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:bg-zinc-800/70"
                  }`}
                >
                  Terminal
                </button>
                <button
                  type="button"
                  onClick={handleSelectCodex}
                  className={`rounded border px-2.5 py-2 text-left text-xs transition-colors ${
                    centerView === "session"
                      ? "border-cyan-500/50 bg-cyan-700/30 text-cyan-100"
                      : "border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:bg-zinc-800/70"
                  }`}
                >
                  Codex
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectWorkflow()}
                  className={`rounded border px-2.5 py-2 text-left text-xs transition-colors ${
                    centerView === "workflow"
                      ? "border-cyan-500/50 bg-cyan-700/30 text-cyan-100"
                      : "border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:bg-zinc-800/70"
                  }`}
                >
                  Workflow
                </button>
              </div>

              <label
                htmlFor={"select-project"}
                className="block w-full min-w-0"
              >
                <ProjectSelector
                  buttonId="select-project"
                  projects={
                    centerView === "terminal"
                      ? terminalProjects
                      : centerView === "workflow"
                        ? workflowProjects
                        : projects
                  }
                  selectedProject={
                    centerView === "terminal"
                      ? selectedTerminalProject
                      : centerView === "workflow"
                        ? selectedWorkflowProject
                        : selectedProject
                  }
                  allLabel={
                    centerView === "terminal"
                      ? "All terminals"
                      : centerView === "workflow"
                        ? "All workflows"
                        : "All Projects"
                  }
                  searchPlaceholder={
                    centerView === "terminal"
                      ? "Type to narrow terminals..."
                      : centerView === "workflow"
                        ? "Type to narrow workflows..."
                        : "Type to narrow projects..."
                  }
                  ariaLabel={
                    centerView === "terminal"
                      ? "Terminals"
                      : centerView === "workflow"
                        ? "Workflows"
                        : "Projects"
                  }
                  noMatchLabel={
                    centerView === "terminal"
                      ? "No terminals match this search."
                      : centerView === "workflow"
                        ? "No workflows match this search."
                        : "No projects match this search."
                  }
                  onSelectProject={(project) => {
                    if (centerView === "terminal") {
                      setSelectedTerminalProject(project);
                    } else if (centerView === "workflow") {
                      setSelectedWorkflowProject(project);
                      setSelectedWorkflowKey(null);
                    } else {
                      setSelectedProject(project);
                    }
                    setNewSessionCwdState(
                      clearNewSessionCwdForProjectSelection(),
                    );
                  }}
                />
              </label>

              {centerView === "workflow" ? (
                <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                  <input
                    type="text"
                    value={workflowCreateProjectRoot}
                    onChange={(event) =>
                      setWorkflowCreateProjectRoot(event.target.value)
                    }
                    placeholder={
                      selectedWorkflowSummary?.projectRoot ||
                      selectedWorkflowProject ||
                      "Project path"
                    }
                    className="project-path-placeholder-tail min-w-0 flex-1 h-9 bg-zinc-900/70 text-zinc-200 text-xs rounded border border-zinc-800 px-2.5 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setInteractionError(null);
                      setWorkflowIdPromptDraft("");
                      setShowWorkflowIdPromptModal(true);
                    }}
                    disabled={workflowActionBusy}
                    className="h-9 rounded bg-cyan-700/80 px-3 text-xs text-zinc-50 transition-colors hover:bg-cyan-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    New Workflow
                  </button>
                </div>
              ) : (
                <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                  <input
                    type="text"
                    value={newSessionCwd}
                    onChange={(event) =>
                      setNewSessionCwdState(
                        setNewSessionCwdFromUserInput(event.target.value),
                      )
                    }
                    placeholder={newSessionPlaceholder}
                    className="project-path-placeholder-tail min-w-0 flex-1 h-9 bg-zinc-900/70 text-zinc-200 text-xs rounded border border-zinc-800 px-2.5 focus:outline-none"
                  />
                  <button
                    onClick={() => {
                      void (centerView === "terminal"
                        ? handleCreateTerminal()
                        : handleCreateSession());
                    }}
                    disabled={creatingSession}
                    className="h-9 min-w-0 max-w-full shrink truncate rounded bg-cyan-700/80 px-3 text-xs text-zinc-50 hover:bg-cyan-700 disabled:opacity-50 cursor-pointer"
                    title={
                      centerView === "terminal"
                        ? "Start a new terminal"
                        : "Start a new Codex session"
                    }
                  >
                    {creatingSession
                      ? "Creating..."
                      : centerView === "terminal"
                        ? "New Terminal"
                        : "New Session"}
                  </button>
                </div>
              )}
            </div>
          </div>

          <SessionList
            sessions={
              centerView === "terminal"
                ? terminalListItems
                : centerView === "workflow"
                  ? workflowListItems
                  : filteredSessions
            }
            selectedSession={
              centerView === "terminal"
                ? selectedTerminalId
                : centerView === "workflow"
                  ? selectedWorkflowKey
                  : selectedSession
            }
            onSelectSession={handleSelectLeftPaneItem}
            onRequestDeleteSession={handleRequestDeleteLeftPaneItem}
            loading={
              centerView === "terminal"
                ? loadingTerminals
                : centerView === "workflow"
                  ? loadingWorkflows
                  : loading
            }
            searchInputRef={sessionListSearchInputRef}
            emptyLabel={
              centerView === "terminal"
                ? "No active terminals found"
                : centerView === "workflow"
                  ? "No workflows found"
                  : "No sessions found"
            }
            noMatchLabel={
              centerView === "terminal"
                ? "No terminals match"
                : centerView === "workflow"
                  ? "No workflows match"
                  : "No sessions match"
            }
            countLabel={
              centerView === "terminal"
                ? "terminal"
                : centerView === "workflow"
                  ? "workflow"
                  : "session"
            }
            deleteButtonLabel={
              centerView === "terminal"
                ? "Terminate terminal"
                : centerView === "workflow"
                  ? "Delete workflow"
                  : "Delete session"
            }
            searchControls={null}
          />
          <div
            role="separator"
            aria-label="Resize left pane"
            aria-orientation="vertical"
            onPointerDown={handleLeftPaneResizeStart}
            className={
              isMobilePhone
                ? "absolute top-1/2 right-0 z-20 -translate-y-1/2 translate-x-1/2 cursor-col-resize touch-none"
                : "absolute top-0 right-0 z-20 h-full w-2 translate-x-1/2 cursor-col-resize touch-none"
            }
          >
            {isMobilePhone && (
              <div className="flex h-10 w-6 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900/95 text-zinc-400 shadow-lg">
                <GripVertical className="h-4 w-4" />
              </div>
            )}
          </div>
        </aside>
      )}

      <main className="flex-1 overflow-hidden bg-zinc-950 flex flex-col">
        <div className="pane-header-center border-b border-zinc-800/60 px-4 py-2">
          <div className="flex min-h-[34px] items-center gap-3">
            {sidebarCollapsed && (
              <button
                type="button"
                onClick={openLeftPane}
                className="h-8 w-8 shrink-0 rounded border border-zinc-700 bg-zinc-900/70 text-zinc-300 transition-colors hover:bg-zinc-800/80"
                aria-label="Expand left pane"
                title="Expand left pane"
              >
                <ChevronRight className="mx-auto h-4 w-4" />
              </button>
            )}
            {centerView === "terminal" ? (
              <>
                <div className="min-w-0 flex-1 text-sm text-zinc-300">
                  {selectedTerminalData?.cwd?.trim() ? (
                    <button
                      type="button"
                      onClick={() =>
                        handleCopyProjectPath(selectedTerminalData.cwd)
                      }
                      className="max-w-full truncate text-left text-sm text-zinc-300 transition-colors hover:text-zinc-100"
                      title={`Copy project path: ${selectedTerminalData.cwd}`}
                      aria-label="Copy project path"
                    >
                      {selectedTerminalData.display || "Terminal"}
                    </button>
                  ) : (
                    selectedTerminalData?.display || "Terminal"
                  )}
                </div>
                <ThemeToggleButton
                  resolvedTheme={resolvedTheme}
                  onToggleTheme={handleToggleTheme}
                />
              </>
            ) : centerView === "workflow" ? (
              <>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-zinc-100">
                    {selectedWorkflowSummary?.title || "Workflow"}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                    {workflowRightPaneProjectPath ? (
                      <button
                        type="button"
                        onClick={() =>
                          handleCopyProjectPath(workflowRightPaneProjectPath)
                        }
                        className="max-w-[18rem] truncate text-left transition-colors hover:text-zinc-300"
                        title={`Copy project path: ${workflowRightPaneProjectPath}`}
                        aria-label="Copy project path"
                      >
                        {selectedWorkflowSummary?.projectName ||
                          getPathBaseName(workflowRightPaneProjectPath)}
                      </button>
                    ) : (
                      <span>
                        {selectedWorkflowSummary?.projectName ||
                          "No workflow selected"}
                      </span>
                    )}
                    {selectedWorkflowSummary ? (
                      <span>{selectedWorkflowSummary.status}</span>
                    ) : null}
                    {workflowDaemonStatus?.state ? (
                      <span>{`daemon ${workflowDaemonStatus.state}`}</span>
                    ) : null}
                  </div>
                </div>
                <ThemeToggleButton
                  resolvedTheme={resolvedTheme}
                  onToggleTheme={handleToggleTheme}
                />
              </>
            ) : selectedSessionData ? (
              <SessionHeader
                session={selectedSessionData}
                copied={copied}
                isMobilePhone={isMobilePhone}
                railCollapsedByDefault={railCollapsedByDefault}
                conversationSearchOpen={conversationSearchOpen}
                resolvedTheme={resolvedTheme}
                onCopySessionId={handleCopySessionId}
                onCopyProjectPath={handleCopyProjectPath}
                onToggleConversationSearch={handleToggleConversationSearch}
                onToggleRailCollapsedByDefault={() =>
                  setRailCollapsedByDefault((current) => !current)
                }
                onToggleTheme={handleToggleTheme}
              />
            ) : (
              <>
                <div className="flex-1" />
                <ThemeToggleButton
                  resolvedTheme={resolvedTheme}
                  onToggleTheme={handleToggleTheme}
                />
              </>
            )}
            {diffPaneCollapsed && (
              <button
                type="button"
                onClick={openRightPane}
                className="h-8 w-8 shrink-0 rounded border border-zinc-700 bg-zinc-900/70 text-zinc-300 transition-colors hover:bg-zinc-800/80"
                aria-label="Expand right pane"
                title="Expand right pane"
              >
                <ChevronLeft className="mx-auto h-4 w-4" />
              </button>
            )}
          </div>
          {centerView === "session" &&
            selectedSessionData &&
            conversationSearchOpen && (
              <div className="pt-2">
                <SessionSearchBar
                  query={conversationSearchQuery}
                  status={conversationSearchStatus}
                  inputRef={conversationSearchInputRef}
                  onChangeQuery={setConversationSearchQuery}
                  onClose={hideConversationSearch}
                  onNavigate={handleNavigateConversationSearch}
                />
              </div>
            )}
        </div>

        {interactionError && (
          <div className="px-4 py-2 text-xs text-red-300 bg-red-950/40 border-b border-red-900/50">
            {interactionError}
          </div>
        )}
        {commandNotice && (
          <div className="px-4 py-2 text-xs text-emerald-200 bg-emerald-950/40 border-b border-emerald-900/50">
            {commandNotice}
          </div>
        )}

        {showCollabModePicker && (
          <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/55 p-4 sm:items-center">
            <div className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900/95 shadow-2xl backdrop-blur">
              <div className="border-b border-zinc-800 px-4 py-3">
                <div className="text-sm font-semibold text-zinc-100">
                  Collaboration Mode
                </div>
                <div className="mt-1 text-xs text-zinc-400">
                  Choose the mode used for the next message.
                </div>
              </div>
              <div className="max-h-72 space-y-2 overflow-y-auto p-4">
                {modePickerOptions.map((option) => {
                  const isSelected = selectedModeKey === option.mode;
                  return (
                    <button
                      key={option.mode}
                      type="button"
                      onClick={() => handleSelectCollaborationMode(option.mode)}
                      className={`flex w-full items-center justify-between rounded border px-3 py-2 text-left text-sm transition-colors ${
                        isSelected
                          ? "border-blue-500/50 bg-blue-500/20 text-blue-100"
                          : "border-zinc-800 bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800/80"
                      }`}
                    >
                      <span>{option.label}</span>
                      {isSelected ? (
                        <CircleDot className="h-4 w-4" />
                      ) : (
                        <Circle className="h-4 w-4 text-zinc-600" />
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="flex justify-end border-t border-zinc-800 px-4 py-3">
                <button
                  type="button"
                  onClick={() => setShowCollabModePicker(false)}
                  className="h-8 rounded border border-zinc-700 bg-zinc-800/80 px-3 text-xs text-zinc-200 transition-colors hover:bg-zinc-700/80"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {showStatusModal && (
          <div
            className="fixed inset-0 z-40 flex items-end justify-center bg-black/55 p-4 sm:items-center"
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                setShowStatusModal(false);
              }
            }}
          >
            <div className="w-full max-w-lg rounded-xl border border-zinc-700 bg-zinc-900/95 shadow-2xl backdrop-blur">
              <div className="border-b border-zinc-800 px-4 py-3">
                <div className="text-sm font-semibold text-zinc-100">
                  Session Status
                </div>
              </div>
              <div className="space-y-2 p-4 text-xs text-zinc-300">
                <div className="flex justify-between gap-3">
                  <span className="text-zinc-500">Model</span>
                  <span className="text-right">
                    {effectiveModelLabel || "Unavailable"}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-zinc-500">Reasoning effort</span>
                  <span className="text-right">
                    {effectiveReasoningEffort || "Unavailable"}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-zinc-500">Collaboration mode</span>
                  <span className="text-right">{selectedModeLabel}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-zinc-500">Context</span>
                  <span className="text-right">{contextWindowText}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-zinc-500">Model context window</span>
                  <span className="text-right">
                    {typeof contextModelWindow === "number"
                      ? TOKEN_COUNT_FORMATTER.format(contextModelWindow)
                      : "Unavailable"}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-zinc-500">Token usage</span>
                  <span className="text-right">
                    {statusTokenUsage
                      ? `${TOKEN_COUNT_FORMATTER.format(statusTokenUsage.totalTokens)} total (${TOKEN_COUNT_FORMATTER.format(statusTokenUsage.inputTokens)} input + ${TOKEN_COUNT_FORMATTER.format(statusTokenUsage.outputTokens)} output)`
                      : "Unavailable"}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-zinc-500">Project path</span>
                  <span className="max-w-[70%] break-all text-right">
                    {activeComposerSessionData?.project || "Unavailable"}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-zinc-500">Thread ID</span>
                  <span className="max-w-[70%] break-all text-right">
                    {activeComposerSessionId || "Unavailable"}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-zinc-500">Session ID</span>
                  <span className="max-w-[70%] break-all text-right">
                    {activeComposerSessionId || "Unavailable"}
                  </span>
                </div>
              </div>
              <div className="flex justify-end border-t border-zinc-800 px-4 py-3">
                <button
                  type="button"
                  onClick={() => setShowStatusModal(false)}
                  className="h-8 rounded border border-zinc-700 bg-zinc-800/80 px-3 text-xs text-zinc-200 transition-colors hover:bg-zinc-700/80"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {showRenameModal && (
          <div
            className="fixed inset-0 z-40 flex items-end justify-center bg-black/55 p-4 sm:items-center"
            onClick={(event) => {
              if (event.target !== event.currentTarget || renamingSession) {
                return;
              }
              setShowRenameModal(false);
            }}
          >
            <div className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900/95 shadow-2xl backdrop-blur">
              <div className="border-b border-zinc-800 px-4 py-3">
                <div className="text-sm font-semibold text-zinc-100">
                  Rename Thread
                </div>
              </div>
              <div className="space-y-3 p-4">
                <input
                  value={renameDraft}
                  onChange={(event) => {
                    setRenameDraft(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || renamingSession) {
                      return;
                    }
                    event.preventDefault();
                    void handleConfirmRename();
                  }}
                  disabled={renamingSession}
                  autoFocus
                  placeholder="Enter a new thread name"
                  className="w-full rounded border border-zinc-700 bg-zinc-900/70 px-3 py-2 text-sm text-zinc-100 focus:outline-none"
                />
              </div>
              <div className="flex justify-end gap-2 border-t border-zinc-800 px-4 py-3">
                <button
                  type="button"
                  onClick={() => {
                    setShowRenameModal(false);
                  }}
                  disabled={renamingSession}
                  className="h-8 rounded border border-zinc-700 bg-zinc-800/80 px-3 text-xs text-zinc-200 transition-colors hover:bg-zinc-700/80 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void handleConfirmRename();
                  }}
                  disabled={renamingSession}
                  className="h-8 rounded border border-blue-600/70 bg-blue-600/30 px-3 text-xs text-blue-100 transition-colors hover:bg-blue-600/40 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {renamingSession ? "Renaming..." : "Rename"}
                </button>
              </div>
            </div>
          </div>
        )}

        {showAgentPicker && (
          <div
            className="fixed inset-0 z-40 flex items-end justify-center bg-black/55 p-4 sm:items-center"
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                setShowAgentPicker(false);
              }
            }}
          >
            <div className="w-full max-w-xl rounded-xl border border-zinc-700 bg-zinc-900/95 shadow-2xl backdrop-blur">
              <div className="border-b border-zinc-800 px-4 py-3">
                <div className="text-sm font-semibold text-zinc-100">
                  Multi-agents
                </div>
                <div className="mt-1 text-xs text-zinc-400">
                  Select an agent thread to watch.
                </div>
              </div>
              <div className="max-h-80 space-y-2 overflow-y-auto p-4">
                {loadingAgentThreads ? (
                  <div className="rounded border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-xs text-zinc-400">
                    Loading agent threads...
                  </div>
                ) : agentThreads.length === 0 ? (
                  <div className="rounded border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-xs text-zinc-400">
                    {agentThreadsError || "No agents available yet."}
                  </div>
                ) : (
                  agentThreads.map((thread) => {
                    const label =
                      thread.name?.trim() ||
                      thread.agentNickname?.trim() ||
                      thread.preview.trim() ||
                      thread.threadId;
                    const subtitleParts = [
                      thread.agentRole?.trim() || null,
                      thread.agentNickname?.trim() || null,
                      formatThreadStatus(thread.status),
                    ].filter((value): value is string => !!value);
                    const isCurrent = selectedSession === thread.threadId;

                    return (
                      <button
                        key={thread.threadId}
                        type="button"
                        onClick={() => {
                          handleSelectAgentThread(thread);
                        }}
                        className={`w-full rounded border px-3 py-2 text-left transition-colors ${
                          isCurrent
                            ? "border-blue-500/50 bg-blue-500/20 text-blue-100"
                            : "border-zinc-800 bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800/80"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm">{label}</span>
                          {isCurrent ? (
                            <CircleDot className="h-4 w-4 shrink-0" />
                          ) : (
                            <Circle className="h-4 w-4 shrink-0 text-zinc-600" />
                          )}
                        </div>
                        <div className="mt-1 text-[11px] text-zinc-400">
                          {subtitleParts.join(" | ")}
                        </div>
                        <div className="mt-1 break-all text-[11px] text-zinc-500">
                          {thread.threadId}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
              <div className="flex justify-end border-t border-zinc-800 px-4 py-3">
                <button
                  type="button"
                  onClick={() => setShowAgentPicker(false)}
                  className="h-8 rounded border border-zinc-700 bg-zinc-800/80 px-3 text-xs text-zinc-200 transition-colors hover:bg-zinc-700/80"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {deleteSessionTargetId && (
          <div className="fixed right-4 bottom-4 z-50 w-[min(30rem,calc(100vw-2rem))] rounded-xl border border-red-700/60 bg-zinc-900/95 shadow-2xl backdrop-blur">
            <div className="px-4 py-3">
              <div className="text-sm font-semibold text-red-200">
                Delete this session?
              </div>
              <p className="mt-2 text-xs leading-relaxed text-zinc-300">
                This will delete the session rollout file, remove matching
                registry entries, and remove related state-db records.
              </p>
              <p className="mt-2 break-all text-[11px] text-zinc-500">
                {deleteSessionTargetData?.display ?? deleteSessionTargetId}
              </p>
              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDeleteSessionTargetId(null)}
                  disabled={deletingSession}
                  className="h-8 rounded border border-zinc-700 bg-zinc-800/80 px-3 text-xs text-zinc-200 transition-colors hover:bg-zinc-700/80 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void handleConfirmDeleteSession();
                  }}
                  disabled={deletingSession}
                  className="h-8 rounded border border-red-600/70 bg-red-700/25 px-3 text-xs text-red-100 transition-colors hover:bg-red-700/35 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {deletingSession ? "Deleting..." : "Delete"}
                </button>
              </div>
            </div>
          </div>
        )}

        {deleteWorkflowTargetId && (
          <div className="fixed right-4 bottom-4 z-50 w-[min(30rem,calc(100vw-2rem))] rounded-xl border border-red-700/60 bg-zinc-900/95 shadow-2xl backdrop-blur">
            <div className="px-4 py-3">
              <div className="text-sm font-semibold text-red-200">
                Delete this workflow?
              </div>
              <p className="mt-2 text-xs leading-relaxed text-zinc-300">
                This will delete the workflow file, remove mirrored registry and
                session-index entries, and clean up related codex-deck task
                worktrees and branches when they belong to this workflow.
              </p>
              <p className="mt-2 break-all text-[11px] text-zinc-500">
                {deleteWorkflowTargetData?.title ?? deleteWorkflowTargetId}
              </p>
              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDeleteWorkflowTargetId(null)}
                  disabled={deletingWorkflow || workflowActionBusy}
                  className="h-8 rounded border border-zinc-700 bg-zinc-800/80 px-3 text-xs text-zinc-200 transition-colors hover:bg-zinc-700/80 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void handleConfirmDeleteWorkflow();
                  }}
                  disabled={deletingWorkflow || workflowActionBusy}
                  className="h-8 rounded border border-red-600/70 bg-red-700/25 px-3 text-xs text-red-100 transition-colors hover:bg-red-700/35 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {deletingWorkflow ? "Deleting..." : "Delete"}
                </button>
              </div>
            </div>
          </div>
        )}

        {deleteTerminalTargetId && (
          <div className="fixed right-4 bottom-4 z-50 w-[min(30rem,calc(100vw-2rem))] rounded-xl border border-red-700/60 bg-zinc-900/95 shadow-2xl backdrop-blur">
            <div className="px-4 py-3">
              <div className="text-sm font-semibold text-red-200">
                Terminate this terminal?
              </div>
              <p className="mt-2 text-xs leading-relaxed text-zinc-300">
                This will terminate the terminal process and remove it from the
                shared terminal list.
              </p>
              <p className="mt-2 break-all text-[11px] text-zinc-500">
                {deleteTerminalTargetData?.cwd ?? deleteTerminalTargetId}
              </p>
              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDeleteTerminalTargetId(null)}
                  disabled={deletingTerminal}
                  className="h-8 rounded border border-zinc-700 bg-zinc-800/80 px-3 text-xs text-zinc-200 transition-colors hover:bg-zinc-700/80 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void handleConfirmDeleteTerminal();
                  }}
                  disabled={deletingTerminal}
                  className="h-8 rounded border border-red-600/70 bg-red-700/25 px-3 text-xs text-red-100 transition-colors hover:bg-red-700/35 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {deletingTerminal ? "Terminating..." : "Terminate"}
                </button>
              </div>
            </div>
          </div>
        )}

        {showFixDanglingConfirm && fixDanglingTargetSessionId && (
          <div className="fixed right-4 bottom-4 z-50 w-[min(30rem,calc(100vw-2rem))] rounded-xl border border-amber-700/60 bg-zinc-900/95 shadow-2xl backdrop-blur">
            <div className="px-4 py-3">
              <div className="text-sm font-semibold text-amber-200">
                Fix dangling turns?
              </div>
              <p className="mt-2 text-xs leading-relaxed text-zinc-300">
                Warning: this will modify the session file by appending
                synthetic ended-turn events.
              </p>
              <p className="mt-2 text-xs leading-relaxed text-zinc-300">
                Proceed only if no other Codex instance is interacting with this
                session.
              </p>
              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowFixDanglingConfirm(false);
                    setFixDanglingTargetSessionId(null);
                  }}
                  disabled={fixingDangling}
                  className="h-8 rounded border border-zinc-700 bg-zinc-800/80 px-3 text-xs text-zinc-200 transition-colors hover:bg-zinc-700/80 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void handleConfirmFixDangling();
                  }}
                  disabled={fixingDangling}
                  className="h-8 rounded border border-amber-600/70 bg-amber-700/25 px-3 text-xs text-amber-100 transition-colors hover:bg-amber-700/35 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {fixingDangling ? "Fixing..." : "Proceed"}
                </button>
              </div>
            </div>
          </div>
        )}

        {showWorkflowDangerConfirm && (
          <div className="fixed right-4 bottom-4 z-50 w-[min(30rem,calc(100vw-2rem))] rounded-xl border border-red-700/60 bg-zinc-900/95 shadow-2xl backdrop-blur">
            <div className="px-4 py-3">
              <div className="text-sm font-semibold text-red-200">
                {showWorkflowDangerConfirm.title}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-zinc-300">
                {showWorkflowDangerConfirm.message}
              </p>
              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowWorkflowDangerConfirm(null)}
                  disabled={workflowActionBusy}
                  className="h-8 rounded border border-zinc-700 bg-zinc-800/80 px-3 text-xs text-zinc-200 transition-colors hover:bg-zinc-700/80 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const confirm = showWorkflowDangerConfirm;
                    setShowWorkflowDangerConfirm(null);
                    confirm?.onConfirm();
                  }}
                  disabled={workflowActionBusy}
                  className="h-8 rounded border border-red-600/70 bg-red-700/25 px-3 text-xs text-red-100 transition-colors hover:bg-red-700/35 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {workflowActionBusy ? "Working..." : "Proceed"}
                </button>
              </div>
            </div>
          </div>
        )}

        {showWorkflowIdPromptModal && (
          <div
            className="fixed inset-0 z-40 flex items-end justify-center bg-black/55 p-4 sm:items-center"
            onClick={(event) => {
              if (event.target !== event.currentTarget || workflowActionBusy) {
                return;
              }
              setShowWorkflowIdPromptModal(false);
            }}
          >
            <div className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900/95 shadow-2xl backdrop-blur">
              <div className="border-b border-zinc-800 px-4 py-3">
                <div className="text-sm font-semibold text-zinc-100">
                  New Workflow
                </div>
                <div className="mt-1 text-xs text-zinc-400">
                  Enter a workflow ID to create an empty workflow draft.
                </div>
              </div>
              <div className="space-y-3 p-4">
                <label className="space-y-1 text-xs text-zinc-400">
                  <span>Workflow ID</span>
                  <input
                    value={workflowIdPromptDraft}
                    onChange={(event) =>
                      setWorkflowIdPromptDraft(event.target.value)
                    }
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" || workflowActionBusy) {
                        return;
                      }
                      event.preventDefault();
                      void handleCreateEmptyWorkflowFromPrompt();
                    }}
                    disabled={workflowActionBusy}
                    autoFocus
                    className="w-full rounded border border-zinc-700 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-100 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    placeholder="Example: feature-delivery"
                  />
                </label>
                <label className="space-y-1 text-xs text-zinc-400">
                  <span>Project Path</span>
                  <textarea
                    value={resolveWorkflowCreateProjectRoot()}
                    readOnly
                    rows={1}
                    wrap="off"
                    className="w-full resize-none overflow-x-auto overflow-y-hidden rounded border border-dashed border-zinc-800/70 bg-zinc-950/40 px-3 py-1.5 text-xs text-zinc-400 focus:outline-none font-mono cursor-default caret-transparent"
                    placeholder="No project path selected"
                  />
                </label>
                <div className="text-[11px] text-zinc-500">
                  Allowed characters: letters, numbers, "-" and "_".
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t border-zinc-800 px-4 py-3">
                <button
                  type="button"
                  onClick={() => setShowWorkflowIdPromptModal(false)}
                  disabled={workflowActionBusy}
                  className="h-8 rounded border border-zinc-700 bg-zinc-800/80 px-3 text-xs text-zinc-200 transition-colors hover:bg-zinc-700/80 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void handleCreateEmptyWorkflowFromPrompt();
                  }}
                  disabled={workflowActionBusy}
                  className="h-8 rounded border border-cyan-600/70 bg-cyan-600/20 px-3 text-xs text-cyan-100 transition-colors hover:bg-cyan-600/30 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {workflowActionBusy ? "Creating..." : "Create empty workflow"}
                </button>
              </div>
            </div>
          </div>
        )}

        {workflowSkillInstallPrompt && (
          <div
            className="fixed inset-0 z-40 flex items-end justify-center bg-black/55 p-4 sm:items-center"
            onClick={(event) => {
              if (event.target !== event.currentTarget) {
                return;
              }
              resolveWorkflowSkillInstallPrompt("cancel");
            }}
          >
            <div className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900/95 shadow-2xl backdrop-blur">
              <div className="border-b border-zinc-800 px-4 py-3">
                <div className="text-sm font-semibold text-zinc-100">
                  Install codex-deck-flow skill?
                </div>
                <div className="mt-1 text-xs text-zinc-400">
                  This workflow needs the `codex-deck-flow` skill before
                  creating and binding its first chat session.
                </div>
              </div>
              <div className="space-y-3 p-4">
                <label className="space-y-1 text-xs text-zinc-400">
                  <span>Project Path</span>
                  <textarea
                    value={workflowSkillInstallPrompt.projectRoot}
                    readOnly
                    rows={1}
                    wrap="off"
                    className="w-full resize-none overflow-x-auto overflow-y-hidden rounded border border-dashed border-zinc-800/70 bg-zinc-950/40 px-3 py-1.5 text-xs text-zinc-400 focus:outline-none font-mono cursor-default caret-transparent"
                  />
                </label>
                <div className="text-xs leading-relaxed text-zinc-300">
                  Choose where to install the skill before sending the workflow
                  bootstrap message.
                </div>
              </div>
              <div className="flex flex-wrap justify-end gap-2 border-t border-zinc-800 px-4 py-3">
                <button
                  type="button"
                  onClick={() => resolveWorkflowSkillInstallPrompt("cancel")}
                  className="h-8 rounded border border-zinc-700 bg-zinc-800/80 px-3 text-xs text-zinc-200 transition-colors hover:bg-zinc-700/80"
                >
                  Cancel init
                </button>
                <button
                  type="button"
                  onClick={() => resolveWorkflowSkillInstallPrompt("global")}
                  className="h-8 rounded border border-amber-600/70 bg-amber-600/15 px-3 text-xs text-amber-100 transition-colors hover:bg-amber-600/25"
                >
                  Install globally
                </button>
                <button
                  type="button"
                  onClick={() => resolveWorkflowSkillInstallPrompt("local")}
                  className="h-8 rounded border border-cyan-600/70 bg-cyan-600/20 px-3 text-xs text-cyan-100 transition-colors hover:bg-cyan-600/30"
                >
                  Install locally
                </button>
              </div>
            </div>
          </div>
        )}

        {terminalSkillInstallPrompt && (
          <div
            className="fixed inset-0 z-40 flex items-end justify-center bg-black/55 p-4 sm:items-center"
            onClick={(event) => {
              if (event.target !== event.currentTarget) {
                return;
              }
              resolveTerminalSkillInstallPrompt("cancel");
            }}
          >
            <div className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900/95 shadow-2xl backdrop-blur">
              <div className="border-b border-zinc-800 px-4 py-3">
                <div className="text-sm font-semibold text-zinc-100">
                  Install codex-deck-terminal skill?
                </div>
                <div className="mt-1 text-xs text-zinc-400">
                  Terminal chat init needs the `codex-deck-terminal` skill
                  before sending the first bound-session message.
                </div>
              </div>
              <div className="space-y-3 p-4">
                <label className="space-y-1 text-xs text-zinc-400">
                  <span>Project Path</span>
                  <textarea
                    value={terminalSkillInstallPrompt.projectRoot}
                    readOnly
                    rows={1}
                    wrap="off"
                    className="w-full resize-none overflow-x-auto overflow-y-hidden rounded border border-dashed border-zinc-800/70 bg-zinc-950/40 px-3 py-1.5 text-xs text-zinc-400 focus:outline-none font-mono cursor-default caret-transparent"
                  />
                </label>
                <div className="text-xs leading-relaxed text-zinc-300">
                  Choose where to install the skill before sending the terminal
                  bootstrap message.
                </div>
              </div>
              <div className="flex flex-wrap justify-end gap-2 border-t border-zinc-800 px-4 py-3">
                <button
                  type="button"
                  onClick={() => resolveTerminalSkillInstallPrompt("cancel")}
                  className="h-8 rounded border border-zinc-700 bg-zinc-800/80 px-3 text-xs text-zinc-200 transition-colors hover:bg-zinc-700/80"
                >
                  Cancel init
                </button>
                <button
                  type="button"
                  onClick={() => resolveTerminalSkillInstallPrompt("global")}
                  className="h-8 rounded border border-amber-600/70 bg-amber-600/15 px-3 text-xs text-amber-100 transition-colors hover:bg-amber-600/25"
                >
                  Install globally
                </button>
                <button
                  type="button"
                  onClick={() => resolveTerminalSkillInstallPrompt("local")}
                  className="h-8 rounded border border-cyan-600/70 bg-cyan-600/20 px-3 text-xs text-cyan-100 transition-colors hover:bg-cyan-600/30"
                >
                  Install locally
                </button>
              </div>
            </div>
          </div>
        )}

        {showWorkflowCreateModal && (
          <div
            className="fixed inset-0 z-40 flex items-end justify-center bg-black/55 p-4 sm:items-center"
            onClick={(event) => {
              if (
                event.target !== event.currentTarget ||
                workflowActionBusy ||
                isWorkflowCreateImportedDraftReview
              ) {
                return;
              }
              closeWorkflowCreateModal({ resetFields: true });
            }}
          >
            <div className="flex h-[min(40rem,calc(100vh-2rem))] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900/95 shadow-2xl backdrop-blur">
              <div className="border-b border-zinc-800 px-4 py-3">
                <div className="text-sm font-semibold text-zinc-100">
                  New Workflow
                </div>
                <div className="mt-1 text-xs text-zinc-400">
                  Create a codex-deck-flow workflow in the current repository.
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setWorkflowCreateMode("chat")}
                    disabled={workflowActionBusy}
                    className={`rounded border px-3 py-1.5 text-xs transition-colors ${
                      workflowCreateMode === "chat"
                        ? "border-cyan-500/70 bg-cyan-600/20 text-cyan-100"
                        : "border-zinc-700 bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800/80"
                    } disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    Chat to create workflow
                  </button>
                  <button
                    type="button"
                    onClick={() => setWorkflowCreateMode("manual")}
                    disabled={workflowActionBusy}
                    className={`rounded border px-3 py-1.5 text-xs transition-colors ${
                      workflowCreateMode === "manual"
                        ? "border-cyan-500/70 bg-cyan-600/20 text-cyan-100"
                        : "border-zinc-700 bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800/80"
                    } disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    Manually create workflow
                  </button>
                </div>
              </div>
              {workflowCreateMode === "chat" ? (
                <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-xs leading-relaxed text-zinc-300">
                    Chat with codex-deck-flow to draft a workflow.
                  </div>
                  <label className="space-y-1 text-xs text-zinc-400">
                    <span>Message</span>
                    {isWorkflowCreateChatWaiting ? (
                      <div
                        aria-live="polite"
                        className="flex h-28 w-full items-start rounded border border-zinc-700 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-100"
                      >
                        <div className="workflow-create-waiting-content flex items-center gap-2.5 pt-0.5">
                          <span className="thinking-dot shrink-0" />
                          <span className="text-zinc-200">
                            {`Waiting for codex-deck-flow reply and creating workflow${".".repeat(workflowCreateWaitingDotCount)}`}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <textarea
                        value={workflowCreateChatInput}
                        onChange={(event) =>
                          setWorkflowCreateChatInput(event.target.value)
                        }
                        rows={4}
                        className="h-28 w-full resize-none overflow-y-auto rounded border border-zinc-700 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-100 focus:outline-none"
                        placeholder="Describe the workflow you want codex-deck-flow to create"
                      />
                    )}
                  </label>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        if (workflowActionBusy) {
                          void handleAbortWorkflowCreateChat();
                          return;
                        }
                        closeWorkflowCreateModal({ resetFields: true });
                      }}
                      className={`h-8 rounded border px-3 text-xs transition-colors ${
                        workflowActionBusy
                          ? "border-red-600/70 bg-red-700/25 text-red-100 hover:bg-red-700/35"
                          : "border-zinc-700 bg-zinc-800/80 text-zinc-200 hover:bg-zinc-700/80"
                      }`}
                    >
                      {workflowActionBusy ? "Abort" : "Cancel"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void handleSendWorkflowCreateChatMessage();
                      }}
                      disabled={
                        workflowActionBusy || !workflowCreateChatInput.trim()
                      }
                      className="h-8 rounded border border-cyan-600/70 bg-cyan-600/20 px-3 text-xs text-cyan-100 transition-colors hover:bg-cyan-600/30 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {workflowActionBusy && workflowCreateMode === "chat"
                        ? "Sending..."
                        : "Send"}
                    </button>
                  </div>
                  <LatestSessionMessageBox
                    message={workflowCreateChatPreviewMessage}
                    sessionId={workflowCreateChatSessionId}
                    emptyText={
                      workflowCreateChatPendingTurnId
                        ? "Waiting for codex-deck-flow reply..."
                        : workflowCreateChatSessionId
                          ? "No assistant reply matched the current workflow-creation turn yet."
                          : "No session messages yet."
                    }
                    onFilePathLinkClick={handleFilePathLinkClick}
                  />
                </div>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    <div className="grid gap-3 md:grid-cols-2">
                      {workflowCreateImportedDraft ? (
                        <div className="rounded-lg border border-cyan-700/40 bg-cyan-950/20 px-3 py-2 text-xs leading-relaxed text-cyan-100 md:col-span-2">
                          This workflow draft already exists at{" "}
                          {workflowCreateImportedDraft.workflowPath}. The fields
                          below are read-only for review. Create Workflow will
                          bind the chat session and approve the existing draft
                          instead of creating another workflow file.
                        </div>
                      ) : null}
                      <label className="space-y-1 text-xs text-zinc-400 md:col-span-2">
                        <span>Title</span>
                        <input
                          value={workflowCreateTitle}
                          onChange={(event) =>
                            setWorkflowCreateTitle(event.target.value)
                          }
                          disabled={!!workflowCreateImportedDraft}
                          className="w-full rounded border border-zinc-700 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-100 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                          placeholder="Workflow title"
                        />
                      </label>
                      <label className="space-y-1 text-xs text-zinc-400 md:col-span-2">
                        <span>Request</span>
                        <textarea
                          value={workflowCreateRequest}
                          onChange={(event) =>
                            setWorkflowCreateRequest(event.target.value)
                          }
                          rows={5}
                          disabled={!!workflowCreateImportedDraft}
                          className="h-40 w-full resize-none overflow-y-auto rounded border border-zinc-700 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-100 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                          placeholder="Describe the workflow goal"
                        />
                      </label>
                      <label className="space-y-1 text-xs text-zinc-400">
                        <span>Workflow ID</span>
                        <input
                          value={workflowCreateId}
                          onChange={(event) =>
                            setWorkflowCreateId(event.target.value)
                          }
                          disabled={!!workflowCreateImportedDraft}
                          className="w-full rounded border border-zinc-700 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-100 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                          placeholder="Optional"
                        />
                      </label>
                      <label className="space-y-1 text-xs text-zinc-400">
                        <span>Target branch</span>
                        <input
                          value={workflowCreateTargetBranch}
                          onChange={(event) =>
                            setWorkflowCreateTargetBranch(event.target.value)
                          }
                          disabled={!!workflowCreateImportedDraft}
                          className="w-full rounded border border-zinc-700 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-100 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                          placeholder="Optional; current branch by default"
                        />
                      </label>
                      <label className="space-y-1 text-xs text-zinc-400">
                        <span>Task count</span>
                        <input
                          value={workflowCreateTaskCount}
                          onChange={(event) =>
                            setWorkflowCreateTaskCount(event.target.value)
                          }
                          disabled={!!workflowCreateImportedDraft}
                          className="w-full rounded border border-zinc-700 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-100 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                          placeholder="1"
                        />
                      </label>
                      <label className="space-y-1 text-xs text-zinc-400">
                        <span>Max parallel</span>
                        <input
                          value={workflowCreateMaxParallel}
                          onChange={(event) =>
                            setWorkflowCreateMaxParallel(event.target.value)
                          }
                          disabled={!!workflowCreateImportedDraft}
                          className="w-full rounded border border-zinc-700 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-100 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                          placeholder="1"
                        />
                      </label>
                      <label className="space-y-1 text-xs text-zinc-400 md:col-span-2">
                        <span>Authored tasks JSON</span>
                        <textarea
                          value={workflowCreateTasksJson}
                          onChange={(event) =>
                            setWorkflowCreateTasksJson(event.target.value)
                          }
                          rows={8}
                          disabled={!!workflowCreateImportedDraft}
                          className="h-52 w-full resize-none overflow-y-auto rounded border border-zinc-700 bg-zinc-950/70 px-3 py-2 font-mono text-xs text-zinc-100 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                          placeholder="Optional JSON array of tasks"
                        />
                      </label>
                      <label className="inline-flex items-center gap-2 text-xs text-zinc-300 md:col-span-2">
                        <input
                          type="checkbox"
                          checked={workflowCreateSequential}
                          onChange={(event) =>
                            setWorkflowCreateSequential(event.target.checked)
                          }
                          disabled={!!workflowCreateImportedDraft}
                          className="h-4 w-4 rounded border-zinc-700 bg-zinc-950 disabled:cursor-not-allowed disabled:opacity-60"
                        />
                        Create default tasks as a sequential dependency chain
                      </label>
                    </div>
                  </div>
                  <div className="flex justify-end gap-2 border-t border-zinc-800 px-4 py-3">
                    <button
                      type="button"
                      onClick={() =>
                        closeWorkflowCreateModal({ resetFields: true })
                      }
                      disabled={workflowActionBusy}
                      className={`h-8 rounded border px-3 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                        workflowCreateImportedDraft
                          ? "border-red-600/70 bg-red-700/25 text-red-100 hover:bg-red-700/35"
                          : "border-zinc-700 bg-zinc-800/80 text-zinc-200 hover:bg-zinc-700/80"
                      }`}
                    >
                      {workflowCreateImportedDraft ? "Abort" : "Cancel"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void handleCreateWorkflow();
                      }}
                      disabled={workflowActionBusy}
                      className="h-8 rounded border border-cyan-600/70 bg-cyan-600/20 px-3 text-xs text-cyan-100 transition-colors hover:bg-cyan-600/30 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {workflowActionBusy ? "Creating..." : "Create workflow"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="flex-1 overflow-hidden">
          {centerView === "workflow" ? (
            <div className="h-full flex flex-col">
              <div className="relative flex-1 overflow-hidden">
                <WorkflowView
                  workflow={workflowDetail}
                  daemonStatus={workflowDaemonStatus}
                  selectedTaskId={selectedWorkflowTaskId}
                  latestBoundSessionMessage={
                    workflowLatestSessionPreview.sessionId ===
                    workflowComposerSessionId
                      ? workflowLatestSessionPreview.message
                      : null
                  }
                  latestBoundSessionMessageLoading={
                    workflowLatestSessionPreviewLoading
                  }
                  loading={workflowDetailLoading || loadingWorkflows}
                  error={workflowDetailError}
                  logData={workflowLog}
                  logLoading={workflowLogLoading}
                  logError={workflowLogError}
                  actionBusy={workflowActionBusy}
                  actionLabel={workflowActionLabel}
                  actionResultLabel={workflowActionResultLabel}
                  actionResultOutput={workflowActionResultOutput}
                  stopAllHint={workflowStopHint}
                  onChatInSession={() => {
                    void handleChatInWorkflowSession();
                  }}
                  onStopAllWorkflowProcesses={() => {
                    if (!selectedWorkflowKey) {
                      return;
                    }
                    void handleWorkflowAction(
                      "Stopping workflow processes...",
                      async () => {
                        if (isGeneratingForWorkflowComposer) {
                          await handleStopWorkflowComposerConversation();
                        }
                        const result =
                          await stopWorkflowProcessesRequest(
                            selectedWorkflowKey,
                          );
                        setWorkflowStopHint(
                          formatWorkflowStopHint(result.output),
                        );
                        return result;
                      },
                    );
                  }}
                  onOpenSession={(sessionId) => {
                    handleSelectSession(sessionId);
                  }}
                  onSelectTask={setSelectedWorkflowTaskId}
                  onLaunchTask={(taskId) => {
                    if (!selectedWorkflowKey) {
                      return;
                    }
                    setSelectedWorkflowTaskId(taskId);
                    void handleWorkflowAction("Launching task...", () =>
                      launchWorkflowTaskRequest(selectedWorkflowKey, taskId),
                    );
                  }}
                  onLoadLog={(scope, taskId) => {
                    if (taskId) {
                      setSelectedWorkflowTaskId(taskId);
                    }
                    void handleLoadWorkflowLog(scope, taskId);
                  }}
                  onStartDaemon={() => {
                    void handleWorkflowAction("Starting daemon...", () =>
                      startWorkflowDaemonRequest(),
                    );
                  }}
                  onStopDaemon={() => {
                    setShowWorkflowDangerConfirm({
                      action: "daemon-stop",
                      title: "Stop codex-deck-flow daemon?",
                      message:
                        "This stops the shared codex-deck-flow daemon for the current CODEX_HOME.",
                      onConfirm: () => {
                        void handleWorkflowAction("Stopping daemon...", () =>
                          stopWorkflowDaemonRequest(),
                        );
                      },
                    });
                  }}
                  onSendControlMessage={(input) => {
                    if (!selectedWorkflowKey) {
                      return;
                    }
                    void handleWorkflowAction(
                      "Sending control message...",
                      () =>
                        sendWorkflowControlMessageRequest(
                          selectedWorkflowKey,
                          input,
                        ),
                    );
                  }}
                  onFilePathLinkClick={handleFilePathLinkClick}
                />
                {isGeneratingForWorkflowComposer && (
                  <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex items-end justify-between gap-3 px-3">
                    <div className="inline-flex items-center gap-2 rounded border border-zinc-700/55 bg-zinc-900/72 px-2.5 py-1.5 text-sm text-zinc-200 shadow-lg">
                      <span className="thinking-dot" />
                      <span className="thinking-label">Chating...</span>
                    </div>
                  </div>
                )}
              </div>
              {selectedWorkflowSummary || workflowDetail
                ? renderComposerFooter({
                    sessionId: workflowComposerSessionId,
                    draftResetKey: selectedWorkflowKey ?? undefined,
                    history: workflowComposerSessionId
                      ? (messageHistoryBySession[workflowComposerSessionId] ??
                        [])
                      : [],
                    slashCommands: workflowComposerSlashCommands,
                    isGeneratingForSession: isGeneratingForWorkflowComposer,
                    isSendingLocked: isWorkflowComposerLocked,
                    sendingMessage,
                    stoppingTurn,
                    idlePrimaryActionLabel: workflowComposerSessionId
                      ? undefined
                      : "Init",
                    idlePrimaryActionBusy: workflowActionBusy,
                    idlePrimaryActionBusyLabel: "Initializing...",
                    allowIdlePrimaryActionWithoutContent:
                      !workflowComposerSessionId,
                    onIdlePrimaryAction: workflowComposerSessionId
                      ? null
                      : handleWorkflowComposerInit,
                    onSendMessage: handleWorkflowComposerSendMessage,
                    onRunSlashCommand: handleRunSlashCommand,
                    onStopConversation: handleStopWorkflowComposerConversation,
                  })
                : null}
            </div>
          ) : centerView === "terminal" ? (
            <div className="h-full min-h-0 flex flex-col">
              <div className="relative flex min-h-0 flex-1 flex-col">
                {selectedTerminalId ? (
                  <div className="min-h-0 flex-1">
                    <TerminalView
                      terminalId={selectedTerminalId}
                      resolvedTheme={resolvedTheme}
                      boundSessionId={terminalComposerSessionId}
                      embeddedMessages={
                        terminalEmbeddedMessages.sessionId ===
                        terminalComposerSessionId
                          ? terminalEmbeddedMessageCards
                          : []
                      }
                      embeddedMessagesLoading={terminalEmbeddedMessagesLoading}
                      chatBusy={terminalBindingBusy}
                    onChatInSession={() => {
                      void handleChatInTerminalSession();
                    }}
                    onTerminalRestarted={handleTerminalRestarted}
                    onFilePathLinkClick={handleFilePathLinkClick}
                    onApproveAiTerminalStep={handleApproveAiTerminalStep}
                    onRejectAiTerminalStep={handleRejectAiTerminalStep}
                  />
                </div>
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-zinc-500">
                    No active terminal selected.
                  </div>
                )}
                {isGeneratingForTerminalComposer && (
                  <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex items-end justify-between gap-3 px-3">
                    <div className="inline-flex items-center gap-2 rounded border border-zinc-700/55 bg-zinc-900/72 px-2.5 py-1.5 text-sm text-zinc-200 shadow-lg">
                      <span className="thinking-dot" />
                      <span className="thinking-label">Chating...</span>
                    </div>
                    {showFixDangling && (
                      <div className="pointer-events-auto flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            handleFixDangling();
                          }}
                          disabled={fixingDangling}
                          className="rounded border border-amber-600/50 bg-amber-700/12 px-2.5 py-1 text-[11px] text-amber-200 shadow-lg transition-colors hover:bg-amber-700/24 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {fixingDangling ? "Fixing..." : "Fix dangling"}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
              {selectedTerminalData
                ? renderComposerFooter({
                    sessionId: terminalComposerSessionId,
                    draftResetKey: selectedTerminalId ?? undefined,
                    history: terminalComposerSessionId
                      ? (messageHistoryBySession[terminalComposerSessionId] ??
                        [])
                      : [],
                    slashCommands: SESSION_COMPOSER_SLASH_COMMANDS,
                    isGeneratingForSession: isGeneratingForTerminalComposer,
                    isSendingLocked: isTerminalComposerLocked,
                    sendingMessage,
                    stoppingTurn,
                    idlePrimaryActionLabel: terminalComposerSessionId
                      ? undefined
                      : "Init",
                    idlePrimaryActionBusy: terminalBindingBusy,
                    idlePrimaryActionBusyLabel: "Initializing...",
                    allowIdlePrimaryActionWithoutContent:
                      !terminalComposerSessionId,
                    onIdlePrimaryAction: terminalComposerSessionId
                      ? null
                      : handleTerminalComposerInit,
                    onSendMessage: handleTerminalComposerSendMessage,
                    onRunSlashCommand: handleRunSlashCommand,
                    onStopConversation: handleStopTerminalComposerConversation,
                  })
                : null}
            </div>
          ) : selectedSession ? (
            <div className="h-full flex flex-col">
              <div className="relative flex-1 overflow-hidden">
                <SessionView
                  ref={sessionViewRef}
                  sessionId={selectedSession}
                  projectPath={selectedSessionData?.project ?? null}
                  pendingUserMessages={
                    pendingUserMessagesBySession[selectedSession] ?? []
                  }
                  railCollapsedByDefault={railCollapsedByDefault}
                  conversationSearchOpen={conversationSearchOpen}
                  conversationSearchQuery={conversationSearchQuery}
                  workflowShortcut={
                    selectedSessionWorkflowShortcut
                      ? {
                          label: selectedSessionWorkflowShortcut.label,
                          title: selectedSessionWorkflowShortcut.title,
                          onClick: handleOpenWorkflowForSession,
                        }
                      : null
                  }
                  terminalShortcut={
                    selectedSessionTerminalShortcut
                      ? {
                          label: selectedSessionTerminalShortcut.label,
                          title: selectedSessionTerminalShortcut.title,
                          onClick: handleOpenTerminalForSession,
                        }
                      : null
                  }
                  latestButtonBottomOffsetPx={
                    isGeneratingForSelectedSession && showFixDangling
                      ? 56
                      : undefined
                  }
                  onPlanAction={handlePlanProposalAction}
                  onFilePathLinkClick={handleFilePathLinkClick}
                  onMessageHistoryChange={handleMessageHistoryChange}
                  onConversationActivity={handleConversationActivity}
                  onConversationSearchStatusChange={setConversationSearchStatus}
                  onStreamConnect={handleStreamConnect}
                  aiTerminalTerminalId={
                    selectedSessionTerminalRole?.terminalId ?? null
                  }
                  onApproveAiTerminalStep={handleApproveAiTerminalStep}
                  onRejectAiTerminalStep={handleRejectAiTerminalStep}
                />
                {isGeneratingForSelectedSession && (
                  <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex items-end justify-between gap-3 px-3">
                    <div className="inline-flex items-center gap-2 rounded border border-zinc-700/55 bg-zinc-900/72 px-2.5 py-1.5 text-sm text-zinc-200 shadow-lg">
                      <span className="thinking-dot" />
                      <span className="thinking-label">Working...</span>
                    </div>
                    {showFixDangling && (
                      <div className="pointer-events-auto flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            handleFixDangling();
                          }}
                          disabled={fixingDangling}
                          className="rounded border border-amber-600/50 bg-amber-700/12 px-2.5 py-1 text-[11px] text-amber-200 shadow-lg transition-colors hover:bg-amber-700/24 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {fixingDangling ? "Fixing..." : "Fix dangling"}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {renderComposerFooter({
                sessionId: selectedSession,
                history: messageHistoryBySession[selectedSession] ?? [],
                slashCommands: SESSION_COMPOSER_SLASH_COMMANDS,
                isGeneratingForSession: isGeneratingForSelectedSession,
                isSendingLocked,
                sendingMessage,
                stoppingTurn,
                onSendMessage: handleSendMessage,
                onRunSlashCommand: handleRunSlashCommand,
                onStopConversation: handleStopConversation,
              })}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-zinc-600">
              <div className="text-center">
                <div className="text-base mb-2 text-zinc-500">
                  Select a session
                </div>
                <div className="text-sm text-zinc-600">
                  Choose a session from the list to view the conversation
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
      <DiffPane
        collapsed={diffPaneCollapsed}
        revealFileListVersion={filePathLinkRevealVersion}
        isMobilePhone={isMobilePhone}
        mode={selectedPaneMode}
        sessionId={rightPaneSessionId}
        width={rightPaneWidth}
        loading={loadingSessionDiff}
        error={sessionDiffError}
        diffData={sessionDiff}
        fileTreeNodesData={sessionFileTreeNodes}
        fileTreeLoadingMore={sessionFileTreeLoadingMore}
        fileContent={sessionFileContent}
        fileContentLoading={loadingSessionFileContent}
        fileContentError={sessionFileContentError}
        fileContentPage={selectedFileContentPage}
        selectedFilePath={selectedDiffFilePath}
        targetLineNumber={selectedFileTargetLine}
        terminalRuns={terminalRuns}
        terminalRunsLoading={loadingTerminalRuns}
        terminalRunsError={terminalRunsError}
        selectedTerminalRunId={selectedTerminalRunId}
        terminalRunOutput={terminalRunOutput}
        terminalRunOutputLoading={loadingTerminalRunOutput}
        terminalRunOutputError={terminalRunOutputError}
        skillsData={sessionSkills}
        skillsLoading={loadingSessionSkills}
        skillsError={sessionSkillsError}
        selectedSkillPath={selectedSkillPath}
        updatingSkillPath={updatingSkillPath}
        onToggleCollapsed={() => setDiffPaneCollapsed((current) => !current)}
        onResizeStart={handleRightPaneResizeStart}
        onChangeMode={handleChangePaneMode}
        onSelectFilePath={handleSelectDiffFilePath}
        onOpenFileTreeDirectory={handleOpenFileTreeDirectory}
        onLoadMoreFileTreeNodes={handleLoadMoreFileTreeNodes}
        onChangeFileContentPage={handleChangeFileContentPage}
        onSelectTerminalRun={setSelectedTerminalRunId}
        onRefreshTerminalRuns={handleRefreshTerminalRuns}
        onSelectSkillPath={setSelectedSkillPath}
        onToggleSkillEnabled={handleToggleSkillEnabled}
        onRefreshSkills={handleRefreshSkills}
      />
      {isTouchResizeOverlayVisible && (
        <div
          className="fixed inset-0 z-[70] touch-none"
          onPointerMove={handleTouchResizeOverlayPointerMove}
          onPointerUp={handleTouchResizeOverlayPointerUp}
          onPointerCancel={handleTouchResizeOverlayPointerCancel}
        />
      )}
    </div>
  );
}

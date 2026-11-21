import BackgroundTerminals from "./background-terminals";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ChevronRight,
  ChevronDown,
  Check,
  FileDiff,
  GripVertical,
  Files,
  GitBranch,
  Sparkles,
  Terminal,
  Zap,
  X,
  WrapText,
  MoreHorizontal,
} from "lucide-react";
import type {
  CodexSkillMetadata,
  SessionDiffFile,
  SessionDiffResponse,
  SessionFileContentResponse,
  SessionHooksResponse,
  SessionFileTreeNodesResponse,
  SessionGitActionRequest,
  SessionGitStatusResponse,
  SessionSkillsResponse,
  SessionTerminalRunSummary,
} from "@codex-deck/api";
import HooksPane from "./hooks-pane";
import { PatchTextRenderer, SourceCodeRenderer } from "./patch-text-renderer";
import { AnsiText } from "./tool-renderers/ansi-text";
import { isMarkdownPath } from "../path-utils";
import RightPaneGuide from "./right-pane-guide";
import DocumentMarkdown from "./document-markdown";
import RightPaneTab from "./right-pane-tab";
import GitHistory from "./git-history";
import { RightPaneIcon } from "./deepseek/right-pane-icons";
import WorkspaceFileTree, {
  type FileSort,
  type FileTreeCache,
} from "./workspace-file-tree";
import { FileTypeIcon } from "./deepseek/FileTypeIcon";
import type { CodexThreadSummary } from "@codex-deck/api";
import {
  applySessionGitAction,
  applyWorkflowProjectGitAction,
  getSessionDiff,
  getSessionGitStatus,
  getWorkflowProjectDiff,
  getWorkflowProjectGitStatus,
  searchSessionFiles,
  searchWorkflowProjectFiles,
  getSessionFileContent,
  getWorkflowProjectFileContent,
  saveWorkspaceFile,
  uploadWorkspaceFile,
} from "../api";
import { subscribeCodexRuntimeEvents } from "../codex-runtime-events";

const EMPTY_REFRESH = () => {};

export type RightPaneMode =
  | "home"
  | "files"
  | "file-preview"
  | "git"
  | "tasks"
  | "skills"
  | "hooks";

interface DiffPaneProps {
  runtimeScopeKey?: string;
  collapsed: boolean;
  revealFileListVersion: number;
  isMobilePhone: boolean;
  mode: RightPaneMode;
  sessionId: string | null;
  /** Actual Codex thread ID; null for workflow project targets. */
  threadId: string | null;
  width: number;
  loading: boolean;
  error: string | null;
  diffData: SessionDiffResponse | null;
  fileTreeNodesData: SessionFileTreeNodesResponse | null;
  fileTreeLoadingMore: boolean;
  fileContent: SessionFileContentResponse | null;
  fileContentLoading: boolean;
  fileContentError: string | null;
  fileContentPage: number;
  selectedFilePath: string | null;
  targetLineNumber: number | null;
  terminalRuns: SessionTerminalRunSummary[];
  terminalRunsLoading: boolean;
  terminalRunsError: string | null;
  selectedTerminalRunId: string | null;
  terminalRunOutput: string;
  terminalRunOutputLoading: boolean;
  terminalRunOutputError: string | null;
  hooksData: SessionHooksResponse | null;
  hooksLoading: boolean;
  hooksError: string | null;
  selectedHookKey: string | null;
  updatingHookKey: string | null;
  skillsData: SessionSkillsResponse | null;
  skillsLoading: boolean;
  skillsError: string | null;
  selectedSkillPath: string | null;
  updatingSkillPath: string | null;
  onToggleCollapsed: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onChangeMode: (mode: RightPaneMode) => void;
  onSelectFilePath: (path: string) => void;
  onOpenFileTreeDirectory: (dirPath: string) => void;
  onLoadMoreFileTreeNodes: () => void;
  onRefreshFiles: () => void;
  onChangeFileContentPage: (page: number) => void;
  onSelectTerminalRun: (processId: string) => void;
  onRefreshTerminalRuns: () => void;
  onSelectHookKey: (key: string) => void;
  onToggleHookEnabled: (
    hook: SessionHooksResponse["hooks"][number],
    enabled: boolean,
  ) => void;
  onTrustHook: (hook: SessionHooksResponse["hooks"][number]) => void;
  onTrustAllHooks: () => void;
  onRefreshHooks: () => void;
  onSelectSkillPath: (path: string) => void;
  onToggleSkillEnabled: (path: string, enabled: boolean) => void;
  onRefreshSkills: () => void;
  agentThreads?: CodexThreadSummary[];
  agentThreadsLoading?: boolean;
  agentThreadsError?: string | null;
  onRefreshAgentThreads?: () => void;
  onOpenAgentThread?: (threadId: string) => void;
  workspacePath?: string | null;
  workflowKey?: string | null;
}

function EmptyState(props: { text: string; children?: ReactNode }) {
  return (
    <div className="right-pane__empty">
      <span>{props.text}</span>
      {props.children}
    </div>
  );
}

function statusIconTone(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized.startsWith("a") || normalized.includes("add")) {
    return "text-emerald-300";
  }
  if (normalized.startsWith("d") || normalized.includes("delete")) {
    return "text-rose-300";
  }
  if (
    normalized.startsWith("r") ||
    normalized.includes("rename") ||
    normalized.includes("move")
  ) {
    return "text-sky-300";
  }
  return "text-amber-300";
}

function getTailTruncatedPath(path: string, maxChars = 84): string {
  if (path.length <= maxChars) {
    return path;
  }

  return `...${path.slice(-(maxChars - 3))}`;
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

function DiffStatusIcon(props: { status: string }) {
  return <FileDiff className={`h-3.5 w-3.5 ${statusIconTone(props.status)}`} />;
}

function renderDiffContent(file: SessionDiffFile | null) {
  if (!file) {
    return <EmptyState text="Select a file to inspect its diff." />;
  }

  if (!file.diff.trim()) {
    return <EmptyState text="No patch text is available for this file." />;
  }

  return (
    <div className="overflow-auto h-full">
      <div className="min-w-max text-[11px]">
        <PatchTextRenderer
          raw={file.diff}
          filePathHint={file.path}
          maxHeightClassName="max-h-none"
        />
      </div>
    </div>
  );
}

function renderTerminalOutput(
  selectedTerminalRunId: string | null,
  output: string,
  loading: boolean,
  error: string | null,
) {
  if (!selectedTerminalRunId) {
    return <EmptyState text="Select a task to inspect its output." />;
  }

  if (loading) {
    return <EmptyState text="Loading task output..." />;
  }

  if (error) {
    return <EmptyState text={error} />;
  }

  if (!output.trim()) {
    return <EmptyState text="No task output captured yet." />;
  }

  return (
    <div className="h-full overflow-auto p-3">
      <pre className="text-[11px] leading-5 text-zinc-200 whitespace-pre-wrap break-words font-mono">
        <AnsiText text={output} />
      </pre>
    </div>
  );
}

function renderSkillDetails(
  skill: CodexSkillMetadata | null,
  updatingSkillPath: string | null,
  onToggleSkillEnabled: (path: string, enabled: boolean) => void,
) {
  if (!skill) {
    return <EmptyState text="Select a skill to inspect its details." />;
  }

  const description = getSkillDescription(skill);
  const isToggling = updatingSkillPath === skill.path;

  return (
    <div className="h-full overflow-auto p-4 sm:p-5">
      <div className="mx-auto max-w-2xl space-y-4">
        <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {getSkillDisplayName(skill)}
            </h2>
            <div className="mt-1 text-xs text-zinc-500">{skill.name}</div>
            <p className="mt-3 whitespace-pre-wrap text-xs leading-5 text-zinc-700 dark:text-zinc-300">
              {description}
            </p>
          </div>
        </section>
        <section className="grid gap-x-5 gap-y-3 rounded-2xl border border-zinc-200 bg-white p-4 text-[11px] text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 sm:grid-cols-2">
          <div>
            <span className="text-zinc-500">Scope</span>
            <div className="mt-1 capitalize">{skill.scope}</div>
          </div>
          <div>
            <span className="text-zinc-500">Status</span>
            <div className="mt-1">
              <span
                className={`rounded-full px-2 py-0.5 font-medium ${skill.enabled ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-rose-500/10 text-rose-700 dark:text-rose-300"}`}
              >
                {skill.enabled ? "Enabled" : "Disabled"}
              </span>
            </div>
          </div>
          <div className="min-w-0 sm:col-span-2">
            <span className="text-zinc-500">Path</span>
            <div className="mt-1 break-all">{skill.path}</div>
          </div>
        </section>
        {skill.interface?.defaultPrompt ? (
          <section className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h3 className="mb-2 text-[11px] font-medium text-zinc-500">
              Default prompt
            </h3>
            <pre className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-[11px] leading-5 text-zinc-700 whitespace-pre-wrap break-words font-mono dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
              {skill.interface.defaultPrompt}
            </pre>
          </section>
        ) : null}
        {skill.dependencies?.tools.length ? (
          <section className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h3 className="mb-2 text-[11px] font-medium text-zinc-500">
              Dependencies
            </h3>
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950">
              {skill.dependencies.tools.map((tool) => (
                <div
                  key={`${tool.type}:${tool.value}`}
                  className="text-[11px] text-zinc-300 leading-5 break-all"
                >
                  {tool.type}: {tool.value}
                </div>
              ))}
            </div>
          </section>
        ) : null}
        <button
          type="button"
          onClick={() => onToggleSkillEnabled(skill.path, !skill.enabled)}
          disabled={isToggling}
          className={`h-9 rounded-xl border px-3.5 text-xs font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
            skill.enabled
              ? "border-rose-600/60 bg-rose-700/20 text-rose-200 hover:bg-rose-700/30"
              : "border-emerald-600/60 bg-emerald-700/20 text-emerald-200 hover:bg-emerald-700/30"
          }`}
        >
          {isToggling
            ? "Saving..."
            : skill.enabled
              ? "Disable skill"
              : "Enable skill"}
        </button>
      </div>
    </div>
  );
}

function renderFileContent(
  selectedFilePath: string | null,
  fileContent: SessionFileContentResponse | null,
  loading: boolean,
  error: string | null,
  fileContentPage: number,
  targetLineNumber: number | null,
  onChangePage: (page: number) => void,
  showSource = false,
  onOpenPath?: (href: string) => boolean,
  resolveImage?: (href: string) => Promise<string | null>,
) {
  if (!selectedFilePath) {
    return <EmptyState text="Select a file to preview its content." />;
  }

  const hasMatchingFileContent =
    fileContent !== null && fileContent.path === selectedFilePath;

  if (loading && !hasMatchingFileContent) {
    return <EmptyState text="Loading file content..." />;
  }

  if (error && !hasMatchingFileContent) {
    return <EmptyState text={error} />;
  }

  if (!hasMatchingFileContent || !fileContent) {
    return <EmptyState text="File content is unavailable." />;
  }

  if (fileContent.unavailableReason) {
    return <EmptyState text={fileContent.unavailableReason} />;
  }

  if (fileContent.previewKind === "image") {
    if (!fileContent.previewDataUrl) {
      return (
        <EmptyState
          text={
            fileContent.previewUnavailableReason ??
            "Image preview is unavailable."
          }
        />
      );
    }

    return (
      <div
        className="h-full overflow-auto p-4"
        style={{ background: "var(--app-artifact-preview-backdrop)" }}
      >
        <img
          src={fileContent.previewDataUrl}
          alt={selectedFilePath}
          className="mx-auto block max-w-full rounded-lg border border-zinc-700/80 bg-white/95 shadow-[0_20px_60px_rgba(0,0,0,0.45)]"
        />
      </div>
    );
  }

  if (fileContent.previewKind === "pdf") {
    if (!fileContent.previewDataUrl) {
      return (
        <EmptyState
          text={
            fileContent.previewUnavailableReason ??
            "PDF preview is unavailable."
          }
        />
      );
    }

    return (
      <div className="h-full min-h-0 bg-zinc-950 p-3">
        <object
          data={fileContent.previewDataUrl}
          type={fileContent.previewMediaType ?? "application/pdf"}
          className="h-full w-full rounded-lg border border-zinc-800 bg-white"
          aria-label={selectedFilePath}
        >
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-zinc-400">
            <span>
              PDF preview is not supported in this browser.{" "}
              <a
                href={fileContent.previewDataUrl}
                target="_blank"
                rel="noreferrer"
                className="text-sky-300 underline underline-offset-2"
              >
                Open the PDF
              </a>
              .
            </span>
          </div>
        </object>
      </div>
    );
  }

  if (fileContent.isBinary) {
    return <EmptyState text="Binary files are not previewed." />;
  }

  if (isMarkdownPath(selectedFilePath) && !showSource) {
    return (
      <div className="right-pane__document-scroll">
        <DocumentMarkdown
          content={fileContent.content}
          onOpenPath={onOpenPath}
          resolveImage={resolveImage}
        />
        {fileContent.totalPages > 1 ? (
          <FileContentPager
            page={fileContent.page}
            totalPages={fileContent.totalPages}
            canGoPrev={fileContent.page > 1}
            canGoNext={fileContent.page < fileContent.totalPages}
            onChangePage={onChangePage}
          />
        ) : null}
      </div>
    );
  }

  const page = fileContent.page || fileContentPage;
  const totalPages = Math.max(fileContent.totalPages || 1, 1);
  const canGoPrev = page > 1;
  const canGoNext = page < totalPages;
  const canFocusLine =
    targetLineNumber !== null &&
    fileContent.paginationMode === "lines" &&
    typeof fileContent.lineStart === "number" &&
    typeof fileContent.lineEnd === "number" &&
    fileContent.lineStart > 0 &&
    targetLineNumber >= fileContent.lineStart &&
    targetLineNumber <= fileContent.lineEnd;

  return (
    <div className="relative h-full min-h-0 overflow-hidden">
      <div className="h-full min-h-0">
        <SourceCodeRenderer
          content={fileContent.content}
          filePathHint={selectedFilePath}
          firstLineNumber={
            fileContent.paginationMode === "lines" &&
            typeof fileContent.lineStart === "number" &&
            fileContent.lineStart > 0
              ? fileContent.lineStart
              : null
          }
          focusLineNumber={canFocusLine ? targetLineNumber : null}
          maxHeightClassName={totalPages > 1 ? "h-full !pb-12" : "h-full"}
        />
      </div>
      {totalPages > 1 ? (
        <FileContentPager
          page={page}
          totalPages={totalPages}
          canGoPrev={canGoPrev}
          canGoNext={canGoNext}
          onChangePage={onChangePage}
        />
      ) : null}
    </div>
  );
}

function FileContentPager(props: {
  page: number;
  totalPages: number;
  canGoPrev: boolean;
  canGoNext: boolean;
  onChangePage: (page: number) => void;
}) {
  const { page, totalPages, canGoPrev, canGoNext, onChangePage } = props;
  const [pageInputValue, setPageInputValue] = useState(String(page));
  const pageDigits = Math.max(String(totalPages).length, 2);

  useEffect(() => {
    setPageInputValue(String(page));
  }, [page]);

  const applyManualPageInput = useCallback(() => {
    const parsed = Number.parseInt(pageInputValue.trim(), 10);
    const nextPage = Number.isFinite(parsed)
      ? Math.min(Math.max(parsed, 1), totalPages)
      : page;

    setPageInputValue(String(nextPage));
    if (nextPage !== page) {
      onChangePage(nextPage);
    }
  }, [onChangePage, page, pageInputValue, totalPages]);

  return (
    <div className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2 rounded-lg px-2 py-1">
      <div className="flex items-center justify-center gap-2">
        <button
          type="button"
          onClick={() => canGoPrev && onChangePage(page - 1)}
          disabled={!canGoPrev}
          className="h-7 min-w-[30px] px-2 inline-flex items-center justify-center rounded border border-zinc-500/90 bg-zinc-900/55 text-[14px] font-black leading-none text-zinc-50 hover:bg-zinc-800/55 disabled:border-zinc-700/60 disabled:bg-zinc-900/55 disabled:text-zinc-50 disabled:opacity-100 disabled:cursor-not-allowed"
          style={{
            WebkitTextFillColor: "var(--app-page-control-foreground)",
            color: "var(--app-page-control-foreground)",
          }}
          aria-label="Previous page"
        >
          <span
            style={{
              color: "var(--app-page-control-foreground)",
              WebkitTextFillColor: "var(--app-page-control-foreground)",
              opacity: canGoPrev ? 1 : 0.45,
            }}
          >
            &lt;
          </span>
        </button>
        <div
          className="h-7 px-3 inline-flex items-center justify-center rounded border border-zinc-700/70 bg-zinc-900/60 text-[11px] font-mono font-bold text-zinc-50 tabular-nums"
          style={{ minWidth: `${pageDigits * 2 + 6}ch` }}
        >
          <input
            type="text"
            inputMode="numeric"
            value={pageInputValue}
            onChange={(event) => {
              const digits = event.target.value.replace(/\D+/g, "");
              setPageInputValue(digits);
            }}
            onBlur={applyManualPageInput}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                applyManualPageInput();
              }
            }}
            className="border-0 bg-transparent p-0 text-right text-zinc-50 outline-none"
            style={{ width: `${pageDigits}ch` }}
            aria-label="Current page"
          />
          <span className="px-1 text-zinc-400">/</span>
          <span style={{ width: `${pageDigits}ch` }} className="text-left">
            {totalPages}
          </span>
        </div>
        <button
          type="button"
          onClick={() => canGoNext && onChangePage(page + 1)}
          disabled={!canGoNext}
          className="h-7 min-w-[30px] px-2 inline-flex items-center justify-center rounded border border-zinc-500/90 bg-zinc-900/55 text-[14px] font-black leading-none text-zinc-50 hover:bg-zinc-800/55 disabled:border-zinc-700/60 disabled:bg-zinc-900/55 disabled:text-zinc-50 disabled:opacity-100 disabled:cursor-not-allowed"
          style={{
            WebkitTextFillColor: "var(--app-page-control-foreground)",
            color: "var(--app-page-control-foreground)",
          }}
          aria-label="Next page"
        >
          <span
            style={{
              color: "var(--app-page-control-foreground)",
              WebkitTextFillColor: "var(--app-page-control-foreground)",
              opacity: canGoNext ? 1 : 0.45,
            }}
          >
            &gt;
          </span>
        </button>
      </div>
    </div>
  );
}

type PaneTabKey = RightPaneMode | `file:${string}`;

interface PaneContentProps extends DiffPaneProps {
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onSplitPane?: () => void;
  onEmptyPane?: () => void;
  hideChrome?: boolean;
  canSplit?: boolean;
}

function DiffPaneContent(props: PaneContentProps) {
  const {
    collapsed,
    revealFileListVersion,
    mode,
    sessionId,
    loading,
    error,
    diffData,
    fileTreeNodesData,
    fileTreeLoadingMore,
    fileContent,
    fileContentLoading,
    fileContentError,
    fileContentPage,
    selectedFilePath,
    targetLineNumber,
    terminalRuns,
    terminalRunsLoading,
    terminalRunsError,
    selectedTerminalRunId,
    terminalRunOutput,
    terminalRunOutputLoading,
    terminalRunOutputError,
    hooksData,
    hooksLoading,
    hooksError,
    selectedHookKey,
    updatingHookKey,
    skillsData,
    skillsLoading,
    skillsError,
    selectedSkillPath,
    updatingSkillPath,
    onToggleCollapsed,
    onChangeMode,
    onSelectFilePath,
    onLoadMoreFileTreeNodes,
    onRefreshFiles,
    onChangeFileContentPage,
    onSelectTerminalRun,
    onRefreshTerminalRuns,
    onSelectHookKey,
    onToggleHookEnabled,
    onTrustHook,
    onTrustAllHooks,
    onRefreshHooks,
    onSelectSkillPath,
    onToggleSkillEnabled,
    onRefreshSkills,
    agentThreads = [],
    agentThreadsLoading = false,
    agentThreadsError = null,
    onRefreshAgentThreads = EMPTY_REFRESH,
    onOpenAgentThread = EMPTY_REFRESH,
  } = props;

  const isHomeMode = mode === "home";
  const isFileTreeMode = mode === "files";
  const isGitMode = mode === "git";
  const isTerminalRunMode = mode === "tasks";
  const isHooksMode = mode === "hooks";
  const isSkillsMode = mode === "skills";
  const [isFileListVisible, setIsFileListVisible] = useState(true);
  const [isSelectedFilePreviewOpen, setIsSelectedFilePreviewOpen] = useState(
    () => selectedFilePath !== null,
  );
  const [fileFilter, setFileFilter] = useState("");
  const [openTabs, setOpenTabs] = useState<PaneTabKey[]>(() => [mode]);
  const [isGitSessionView, setIsGitSessionView] = useState(false);
  const [isGitChangesExpanded, setIsGitChangesExpanded] = useState(true);
  const [isGitSectionExpanded, setIsGitSectionExpanded] = useState(true);
  const [isGraphExpanded, setIsGraphExpanded] = useState(true);
  const [gitBranchFilter, setGitBranchFilter] = useState("all");
  const [gitActionsOpen, setGitActionsOpen] = useState(false);
  const gitMenuRef = useRef<HTMLDivElement>(null);
  const [fileSort, setFileSort] = useState<FileSort>("name");
  const [foldersFirst, setFoldersFirst] = useState(true);
  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false);
  const [showFileSource, setShowFileSource] = useState(false);
  const [wrapFileSource, setWrapFileSource] = useState(false);
  const [filePathInput, setFilePathInput] = useState(selectedFilePath ?? "");
  const [editingFile, setEditingFile] = useState(false);
  const [fileDrafts, setFileDrafts] = useState<
    Record<string, { base: string; content: string }>
  >({});
  const [fileSaveErrors, setFileSaveErrors] = useState<Record<string, string>>(
    {},
  );
  const [savingFile, setSavingFile] = useState<string | null>(null);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const fileTreeCache = useRef<FileTreeCache | null>(null);
  const uploadFilesRef = useRef<HTMLInputElement>(null);
  const uploadFolderRef = useRef<HTMLInputElement>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const isFullscreen = props.fullscreen ?? false;
  const [isBackgroundCommandsOpen, setIsBackgroundCommandsOpen] =
    useState(false);
  const [fileSearchResults, setFileSearchResults] = useState<string[] | null>(
    null,
  );
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [gitSessionDiff, setGitSessionDiff] =
    useState<SessionDiffResponse | null>(null);
  const [gitSessionDiffError, setGitSessionDiffError] = useState<string | null>(
    null,
  );
  const [gitSessionDiffLoading, setGitSessionDiffLoading] = useState(false);
  const [gitStatus, setGitStatus] = useState<SessionGitStatusResponse | null>(
    null,
  );
  const [gitWorkingDiff, setGitWorkingDiff] =
    useState<SessionDiffResponse | null>(null);
  const [gitStatusLoading, setGitStatusLoading] = useState(false);
  const [gitStatusError, setGitStatusError] = useState<string | null>(null);
  const [gitActionLoading, setGitActionLoading] = useState(false);
  const [gitActionError, setGitActionError] = useState<string | null>(null);
  const [gitCommitMessage, setGitCommitMessage] = useState("");
  const [gitRefreshVersion, setGitRefreshVersion] = useState(0);

  useEffect(() => {
    setFilePathInput(selectedFilePath ?? "");
    setShowFileSource(targetLineNumber !== null);
    setEditingFile(false);
  }, [selectedFilePath, targetLineNumber]);

  useEffect(() => {
    if (!fileContent || fileContent.totalPages !== 1) return;
    setFileDrafts((current) => {
      const draft = current[fileContent.path];
      if (
        !draft ||
        draft.base !== draft.content ||
        draft.base === fileContent.content
      )
        return current;
      return {
        ...current,
        [fileContent.path]: {
          base: fileContent.content,
          content: fileContent.content,
        },
      };
    });
  }, [fileContent]);

  useEffect(
    () =>
      subscribeCodexRuntimeEvents((event) => {
        if (
          !event ||
          (event.type === "workspace_files_changed" &&
            event.projectPath ===
              (fileTreeNodesData?.projectPath ?? props.workspacePath))
        ) {
          onRefreshFiles();
          setGitRefreshVersion((value) => value + 1);
        }
      }),
    [fileTreeNodesData?.projectPath, props.workspacePath, onRefreshFiles],
  );

  useEffect(() => {
    function dismiss(event: PointerEvent | KeyboardEvent) {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") {
          setIsSortMenuOpen(false);
          setGitActionsOpen(false);
        }
      } else {
        if (!sortMenuRef.current?.contains(event.target as Node))
          setIsSortMenuOpen(false);
        if (!gitMenuRef.current?.contains(event.target as Node))
          setGitActionsOpen(false);
      }
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismiss);
    };
  }, []);

  useEffect(() => {
    setOpenTabs((current) =>
      current.includes(mode) ? current : [...current, mode],
    );
  }, [mode]);

  useEffect(() => {
    setIsFileListVisible(true);
  }, [revealFileListVersion]);

  useEffect(() => {
    if (mode !== "files" || !selectedFilePath) return;
    setIsSelectedFilePreviewOpen(true);
    const key: PaneTabKey = `file:${selectedFilePath}`;
    setOpenTabs((current) => [
      ...new Set([
        ...current.filter((tab) => tab !== "home"),
        "files" as const,
        key,
      ]),
    ]);
  }, [selectedFilePath]);

  useEffect(() => {
    const query = fileFilter.trim();
    if (!query || !sessionId || !isFileTreeMode) {
      setFileSearchResults(null);
      return;
    }
    if (!props.threadId && !props.workflowKey) {
      setFileSearchResults([]);
      return;
    }
    setFileSearchResults(null);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (
        props.threadId
          ? searchSessionFiles(props.threadId, query, 80)
          : searchWorkflowProjectFiles(props.workflowKey as string, query, 80)
      )
        .then((result) => {
          if (!cancelled) setFileSearchResults(result.files);
        })
        .catch(() => {
          if (!cancelled) setFileSearchResults([]);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    fileFilter,
    isFileTreeMode,
    props.threadId,
    props.workflowKey,
    sessionId,
  ]);

  useEffect(() => {
    if (!isTerminalRunMode || !props.threadId || props.threadId !== sessionId) {
      return;
    }
    onRefreshAgentThreads();
  }, [isTerminalRunMode, onRefreshAgentThreads, props.threadId, sessionId]);

  useEffect(() => {
    if (!isGitMode || !isGitSessionView) return;
    if (!props.threadId || props.threadId !== sessionId) {
      setGitSessionDiff({
        sessionId: sessionId ?? "",
        mode: "last-turn",
        projectPath: diffData?.projectPath ?? null,
        turnId: null,
        files: [],
        unavailableReason:
          "Session changes are available when this pane is linked to a Codex thread.",
      });
      setGitSessionDiffError(null);
      setGitSessionDiffLoading(false);
      return;
    }
    let cancelled = false;
    setGitSessionDiffLoading(true);
    setGitSessionDiffError(null);
    void getSessionDiff(props.threadId, "last-turn")
      .then((result) => {
        if (!cancelled) setGitSessionDiff(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setGitSessionDiff(null);
          setGitSessionDiffError(
            error instanceof Error ? error.message : String(error),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setGitSessionDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    diffData?.projectPath,
    isGitMode,
    isGitSessionView,
    props.threadId,
    sessionId,
  ]);

  useEffect(() => {
    if (!isGitMode && !isFileTreeMode) return;
    if (!props.threadId && !props.workflowKey) {
      setGitStatus(null);
      setGitStatusError("Select a project to inspect its Git status.");
      setGitStatusLoading(false);
      return;
    }
    let cancelled = false;
    setGitStatusLoading(true);
    setGitStatusError(null);
    const statusRequest = props.threadId
      ? getSessionGitStatus(
          props.threadId,
          gitBranchFilter === "current",
          isGitMode,
        )
      : getWorkflowProjectGitStatus(
          props.workflowKey as string,
          gitBranchFilter === "current",
          isGitMode,
        );
    const diffRequest = !isGitMode
      ? Promise.resolve(null)
      : props.threadId
        ? getSessionDiff(props.threadId, "working-tree")
        : getWorkflowProjectDiff(props.workflowKey as string, "working-tree");
    void Promise.all([statusRequest, diffRequest])
      .then(([status, gitDiff]) => {
        if (cancelled) return;
        setGitStatus(status);
        setGitWorkingDiff(gitDiff);
        setGitStatusError(status.unavailableReason);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setGitStatus(null);
          setGitWorkingDiff(null);
          setGitStatusError(
            error instanceof Error ? error.message : String(error),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setGitStatusLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    gitRefreshVersion,
    gitBranchFilter,
    isGitMode,
    isFileTreeMode,
    fileTreeNodesData,
    props.threadId,
    props.workflowKey,
  ]);

  const runGitAction = useCallback(
    async (request: SessionGitActionRequest) => {
      setGitActionLoading(true);
      setGitActionError(null);
      try {
        const result = props.threadId
          ? await applySessionGitAction(props.threadId, request)
          : props.workflowKey
            ? await applyWorkflowProjectGitAction(props.workflowKey, request)
            : null;
        if (!result) return;
        setGitStatus(result.status);
        const diff = props.threadId
          ? await getSessionDiff(props.threadId, "working-tree")
          : await getWorkflowProjectDiff(
              props.workflowKey as string,
              "working-tree",
            );
        setGitWorkingDiff(diff);
        if (request.action === "commit") setGitCommitMessage("");
        setGitRefreshVersion((value) => value + 1);
      } catch (error) {
        setGitActionError(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setGitActionLoading(false);
      }
    },
    [props.threadId, props.workflowKey],
  );

  if (collapsed) {
    return null;
  }

  const selectedTerminalRun =
    terminalRuns.find((run) => run.processId === selectedTerminalRunId) ?? null;
  const skills = skillsData?.skills ?? [];
  const selectedSkill =
    skills.find((skill) => skill.path === selectedSkillPath) ?? null;
  const selectedFileLabel = (() => {
    if (isTerminalRunMode) {
      if (!selectedTerminalRun) {
        return "Task output";
      }
      return `${selectedTerminalRun.command} (${selectedTerminalRun.processId})`;
    }

    if (isSkillsMode) {
      return selectedSkill
        ? getSkillDisplayName(selectedSkill)
        : "Skill details";
    }

    if (isHooksMode) {
      return selectedHookKey ?? "Hook details";
    }

    if (!selectedFilePath) {
      return isFileTreeMode
        ? "Workspace files"
        : isGitMode
          ? "Working tree"
          : "Diff";
    }

    if (
      isFileTreeMode &&
      fileContent &&
      fileContent.path === selectedFilePath &&
      fileContent.paginationMode === "lines" &&
      typeof fileContent.lineStart === "number" &&
      typeof fileContent.lineEnd === "number" &&
      fileContent.lineStart > 0 &&
      fileContent.lineEnd >= fileContent.lineStart
    ) {
      return `${selectedFilePath}:${fileContent.lineStart}:${fileContent.lineEnd}`;
    }

    return selectedFilePath;
  })();
  const hasLoadedPaneData =
    isHomeMode ||
    (isFileTreeMode ? fileTreeNodesData !== null : diffData !== null);
  const showBlockingPaneLoading = loading && !hasLoadedPaneData;
  const showBlockingPaneError = error !== null && !hasLoadedPaneData;
  const activeTabKey: PaneTabKey =
    isFileTreeMode && isSelectedFilePreviewOpen && selectedFilePath
      ? `file:${selectedFilePath}`
      : mode;
  const currentTabs = [...new Set([...openTabs, activeTabKey])];
  function activateTab(key: PaneTabKey) {
    if (key.startsWith("file:")) {
      onSelectFilePath(key.slice(5));
      setIsSelectedFilePreviewOpen(true);
      onChangeMode("files");
    } else {
      setIsSelectedFilePreviewOpen(false);
      onChangeMode(key as RightPaneMode);
    }
  }
  const displayDiffData = isGitMode
    ? isGitSessionView
      ? gitSessionDiff
      : (gitWorkingDiff ?? diffData)
    : diffData;
  const displayDiffFiles = displayDiffData?.files ?? [];
  const directAgentThreads = agentThreads
    .filter((thread) => thread.parentThreadId === sessionId)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const selectedTask =
    directAgentThreads.find((thread) => thread.threadId === selectedTaskId) ??
    null;
  const workspaceLabel =
    fileTreeNodesData?.projectPath?.split(/[\\/]/).filter(Boolean).at(-1) ??
    props.workspacePath?.split(/[\\/]/).filter(Boolean).at(-1) ??
    "Workspace";
  async function uploadFiles(files: FileList | null) {
    if (!files?.length || uploadBusy) return;
    setUploadBusy(true);
    setUploadError(null);
    try {
      for (const file of Array.from(files)) {
        if (file.size > 8 * 1024 * 1024)
          throw new Error(`${file.name} is larger than 8 MB.`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 32768)
          binary += String.fromCharCode(
            ...bytes.subarray(offset, offset + 32768),
          );
        await uploadWorkspaceFile(
          props,
          file.webkitRelativePath || file.name,
          btoa(binary),
        );
      }
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploadBusy(false);
      onRefreshFiles();
    }
  }
  const draft = selectedFilePath ? fileDrafts[selectedFilePath] : undefined;
  const canEditFile =
    fileContent?.path === selectedFilePath &&
    !fileContent?.isBinary &&
    fileContent?.totalPages === 1 &&
    !fileContent?.unavailableReason;
  const dirtyFile = Boolean(draft && draft.base !== draft.content);
  async function saveFile() {
    if (!selectedFilePath || !draft || !dirtyFile || savingFile) return;
    const path = selectedFilePath;
    const saved = draft.content;
    setSavingFile(path);
    setFileSaveErrors((current) => ({ ...current, [path]: "" }));
    try {
      await saveWorkspaceFile(props, path, saved, draft.base);
      setFileDrafts((current) => ({
        ...current,
        [path]: { base: saved, content: current[path]?.content ?? saved },
      }));
      onRefreshFiles();
    } catch (error) {
      setFileSaveErrors((current) => ({
        ...current,
        [path]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setSavingFile(null);
    }
  }

  const resolveWorkspacePath = (href: string) => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) return null;
    let path: string;
    try {
      path = decodeURIComponent(href.split(/[?#]/)[0]);
    } catch {
      return null;
    }
    const parts = path.startsWith("/")
      ? []
      : (selectedFilePath ?? "").split("/").slice(0, -1);
    for (const part of path.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!parts.length) return null;
        parts.pop();
      } else parts.push(part);
    }
    return parts.join("/") || null;
  };
  const openLinkedFile = (href: string) => {
    const path = resolveWorkspacePath(href);
    if (!path) return false;
    onSelectFilePath(path);
    setIsSelectedFilePreviewOpen(true);
    return true;
  };
  const fileTree = (
    <WorkspaceFileTree
      data={fileTreeNodesData}
      scopeKey={props.runtimeScopeKey ?? sessionId ?? ""}
      threadId={props.threadId}
      workflowKey={props.workflowKey}
      selectedPath={selectedFilePath}
      changes={gitStatus?.changes}
      cache={fileTreeCache}
      searchResults={fileFilter.trim() ? fileSearchResults : null}
      sort={fileSort}
      foldersFirst={foldersFirst}
      onSelectFile={(path) => {
        onSelectFilePath(path);
        setIsSelectedFilePreviewOpen(true);
        setIsFileListVisible(false);
      }}
      onLoadMore={onLoadMoreFileTreeNodes}
      loadingMore={fileTreeLoadingMore}
    />
  );

  return (
    <section className="right-pane__dock">
      <div
        className="right-pane__header"
        role="tablist"
        aria-label="Right sidebar tabs"
        data-mode={mode}
      >
        <div className="right-pane__tab-scroll">
          {currentTabs.map((key) => {
            const filePath = key.startsWith("file:") ? key.slice(5) : null;
            const tab = filePath ? "file-preview" : (key as RightPaneMode);
            const active = key === activeTabKey;
            const label = filePath
              ? (filePath.split("/").at(-1) ?? filePath)
              : tab === "home"
                ? "Start"
                : tab[0].toUpperCase() + tab.slice(1);
            const icon =
              tab === "files" ? (
                <FileTypeIcon kind="folder" size={16} />
              ) : filePath ? (
                <FileTypeIcon path={filePath} size={16} />
              ) : tab === "home" || tab === "git" || tab === "tasks" ? (
                <RightPaneIcon
                  name={tab === "home" ? "start" : tab}
                  className={`right-pane__tab-icon right-pane__tab-icon--${tab}`}
                />
              ) : tab === "skills" ? (
                <Sparkles className="right-pane__tab-icon" />
              ) : (
                <Zap className="right-pane__tab-icon" />
              );
            return (
              <RightPaneTab
                key={key}
                label={label}
                kind={key}
                active={active}
                quiet={tab === "home" && currentTabs.length === 1}
                icon={icon}
                onSelect={() => activateTab(key)}
                onClose={
                  tab === "home" && currentTabs.length === 1
                    ? undefined
                    : () => {
                        const next = currentTabs.filter(
                          (entry) => entry !== key,
                        );
                        setOpenTabs(next);
                        if (active) {
                          const fallback =
                            next[
                              Math.min(
                                currentTabs.indexOf(key),
                                next.length - 1,
                              )
                            ];
                          if (fallback) activateTab(fallback);
                          else {
                            setIsSelectedFilePreviewOpen(false);
                            props.onEmptyPane?.();
                            onChangeMode("home");
                          }
                        }
                      }
                }
              />
            );
          })}
        </div>
        {mode !== "home" ? (
          <button
            type="button"
            className="right-pane__icon-button"
            aria-label="New tab"
            title="New tab"
            onClick={() => {
              setIsSelectedFilePreviewOpen(false);
              onChangeMode("home");
            }}
          >
            <RightPaneIcon name="new-tab" />
          </button>
        ) : null}
        <div className="right-pane__fill" />
        <div className="right-pane__chrome">
          <button
            type="button"
            className="right-pane__icon-button"
            aria-label="Split"
            disabled={!props.canSplit}
            title={
              props.canSplit ? "Split" : "Not enough room for another pane"
            }
            onClick={props.onSplitPane}
          >
            <RightPaneIcon name="split" />
          </button>
          <button
            type="button"
            className="right-pane__icon-button"
            hidden={props.hideChrome}
            aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            aria-pressed={isFullscreen}
            title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            onClick={props.onToggleFullscreen}
          >
            <RightPaneIcon name="fullscreen" />
          </button>
          <button
            type="button"
            className="right-pane__icon-button"
            onClick={onToggleCollapsed}
            hidden={props.hideChrome}
            aria-label="Collapse right sidebar"
            title="Collapse right sidebar"
          >
            <RightPaneIcon name="collapse-right-sidebar" />
          </button>
        </div>
      </div>

      {isHomeMode ? (
        <RightPaneGuide
          onOpen={(nextMode) => {
            setOpenTabs((current) => [
              ...current.filter((tab) => tab !== "home"),
              ...(current.includes(nextMode) ? [] : [nextMode]),
            ]);
            setIsSelectedFilePreviewOpen(false);
            onChangeMode(nextMode);
          }}
        />
      ) : !sessionId ? (
        <EmptyState text="Select a session to view this pane." />
      ) : isFileTreeMode ? (
        <>
          <input
            ref={uploadFilesRef}
            type="file"
            multiple
            hidden
            aria-label="Upload file selection"
            onChange={(event) => {
              void uploadFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <input
            ref={uploadFolderRef}
            type="file"
            multiple
            hidden
            {...{ webkitdirectory: "" }}
            aria-label="Upload folder selection"
            onChange={(event) => {
              void uploadFiles(event.target.files);
              event.target.value = "";
            }}
          />
          {isSelectedFilePreviewOpen ? (
            <div className="right-pane__preview-toolbar">
              <form
                className="right-pane__path-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const input = filePathInput.trim().replaceAll("\\", "/");
                  const root = (
                    fileTreeNodesData?.projectPath ??
                    props.workspacePath ??
                    ""
                  )
                    .replaceAll("\\", "/")
                    .replace(/\/$/, "");
                  if (input)
                    onSelectFilePath(
                      root && input.startsWith(root + "/")
                        ? input.slice(root.length + 1)
                        : input,
                    );
                }}
              >
                <input
                  value={filePathInput}
                  onChange={(event) => setFilePathInput(event.target.value)}
                  aria-label={
                    selectedFilePath
                      ? `${fileTreeNodesData?.projectPath ?? props.workspacePath ?? ""}/${selectedFilePath}`
                      : "File path"
                  }
                  title={selectedFilePath ?? "File path"}
                  placeholder="File path (relative to the session directory or absolute), Enter to open"
                />
              </form>
              {selectedFilePath && !fileContent?.isBinary ? (
                <div className="right-pane__preview-modes">
                  <button
                    type="button"
                    aria-pressed={!showFileSource}
                    onClick={() => setShowFileSource(false)}
                  >
                    {isMarkdownPath(selectedFilePath) ? "Preview" : "Code"}
                  </button>
                  <button
                    type="button"
                    aria-pressed={showFileSource}
                    onClick={() => {
                      setShowFileSource(true);
                      setEditingFile(true);
                    }}
                    disabled={!canEditFile}
                  >
                    Edit
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="right-pane__icon-button"
                  aria-label="Wrap lines"
                  aria-pressed={wrapFileSource}
                  title="Wrap lines"
                  onClick={() => setWrapFileSource(!wrapFileSource)}
                >
                  <WrapText />
                </button>
              )}
              <button
                type="button"
                className="right-pane__icon-button"
                aria-label="Save"
                title={
                  !canEditFile
                    ? "Only complete text files can be edited"
                    : dirtyFile
                      ? "Save (Cmd/Ctrl+S)"
                      : "Saved"
                }
                disabled={!dirtyFile || savingFile !== null || !canEditFile}
                onClick={() => void saveFile()}
              >
                <Check />
              </button>
              <button
                type="button"
                className="right-pane__icon-button"
                aria-label="Refresh"
                title="Refresh"
                onClick={() => {
                  if (
                    dirtyFile &&
                    !window.confirm(
                      "Discard unsaved changes and reload this file?",
                    )
                  )
                    return;
                  if (selectedFilePath) {
                    setFileDrafts((current) => {
                      const next = { ...current };
                      delete next[selectedFilePath];
                      return next;
                    });
                    setFileSaveErrors((current) => ({
                      ...current,
                      [selectedFilePath]: "",
                    }));
                  }
                  onRefreshFiles();
                }}
              >
                <RightPaneIcon name="refresh" />
              </button>
              <button
                type="button"
                className="right-pane__icon-button"
                aria-label="File tree panel"
                title="File tree panel"
                aria-pressed={isFileListVisible}
                onClick={() => setIsFileListVisible(!isFileListVisible)}
              >
                <RightPaneIcon name="upload-folder" />
              </button>
            </div>
          ) : (
            <div className="right-pane__page-toolbar">
              <label className="right-pane__search">
                <input
                  type="search"
                  value={fileFilter}
                  onChange={(event) => setFileFilter(event.target.value)}
                  placeholder="Search files by name…"
                  aria-label="Search files by name…"
                />
              </label>
              <button
                type="button"
                className="right-pane__icon-button"
                onClick={onRefreshFiles}
                aria-label="Refresh"
                title="Refresh"
              >
                <RightPaneIcon name="refresh" />
              </button>
              <div className="right-pane__menu-anchor" ref={sortMenuRef}>
                <button
                  type="button"
                  className="right-pane__icon-button"
                  aria-label="Sort"
                  title="Sort"
                  aria-haspopup="menu"
                  aria-expanded={isSortMenuOpen}
                  onClick={() => setIsSortMenuOpen(!isSortMenuOpen)}
                >
                  <RightPaneIcon name="sort" />
                </button>
                {isSortMenuOpen ? (
                  <div className="right-pane__menu" role="menu">
                    {(
                      [
                        ["name", "Sort by name"],
                        ["type", "Sort by type"],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={fileSort === value}
                        key={value}
                        onClick={() => {
                          setFileSort(value);
                          setIsSortMenuOpen(false);
                        }}
                      >
                        <span>{label}</span>
                        {fileSort === value ? <Check /> : null}
                      </button>
                    ))}
                    <hr />
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={foldersFirst}
                      onClick={() => {
                        setFoldersFirst(!foldersFirst);
                        setIsSortMenuOpen(false);
                      }}
                    >
                      <span>Folders first</span>
                      {foldersFirst ? <Check /> : null}
                    </button>
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="right-pane__icon-button"
                disabled={uploadBusy}
                onClick={() => uploadFilesRef.current?.click()}
                title="Upload files"
                aria-label="Upload files"
              >
                <RightPaneIcon name="upload-files" />
              </button>
              <button
                type="button"
                className="right-pane__icon-button"
                disabled={uploadBusy}
                onClick={() => uploadFolderRef.current?.click()}
                title="Upload folder"
                aria-label="Upload folder"
              >
                <RightPaneIcon name="upload-folder" />
              </button>
            </div>
          )}
          {uploadError ? (
            <div role="alert" className="right-pane__file-error">
              {uploadError}
            </div>
          ) : null}
          {isSelectedFilePreviewOpen ? (
            <div
              className="right-pane__preview-content"
              data-wrap-source={wrapFileSource}
            >
              <div className="right-pane__preview-body">
                {selectedFilePath && fileSaveErrors[selectedFilePath] ? (
                  <div role="alert" className="right-pane__file-error">
                    {fileSaveErrors[selectedFilePath]}
                  </div>
                ) : null}
                {showFileSource && editingFile && canEditFile ? (
                  <textarea
                    className="right-pane__file-editor"
                    aria-label="Edit file"
                    spellCheck={false}
                    value={draft?.content ?? fileContent?.content ?? ""}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (selectedFilePath)
                        setFileDrafts((current) => ({
                          ...current,
                          [selectedFilePath]: {
                            base:
                              current[selectedFilePath]?.base ??
                              fileContent?.content ??
                              "",
                            content: value,
                          },
                        }));
                    }}
                    onKeyDown={(event) => {
                      if (
                        (event.metaKey || event.ctrlKey) &&
                        event.key.toLowerCase() === "s"
                      ) {
                        event.preventDefault();
                        void saveFile();
                      }
                    }}
                  />
                ) : (
                  renderFileContent(
                    selectedFilePath,
                    fileContent,
                    fileContentLoading,
                    fileContentError,
                    fileContentPage,
                    targetLineNumber,
                    onChangeFileContentPage,
                    showFileSource,
                    openLinkedFile,
                    async (href) => {
                      const path = resolveWorkspacePath(href);
                      if (!path) return null;
                      const result = props.threadId
                        ? await getSessionFileContent(props.threadId, path)
                        : props.workflowKey
                          ? await getWorkflowProjectFileContent(
                              props.workflowKey,
                              path,
                            )
                          : null;
                      return result?.previewDataUrl ?? null;
                    },
                  )
                )}
              </div>
              {isFileListVisible ? (
                <div className="right-pane__preview-navigator">{fileTree}</div>
              ) : null}
            </div>
          ) : showBlockingPaneLoading && !fileTreeNodesData ? (
            <EmptyState text="Loading files…" />
          ) : showBlockingPaneError && !fileTreeNodesData ? (
            <EmptyState text={error ?? "Could not load workspace files."} />
          ) : fileTreeNodesData?.unavailableReason ? (
            <EmptyState text={fileTreeNodesData.unavailableReason} />
          ) : fileFilter.trim() && fileSearchResults === null ? (
            <EmptyState text="Searching files…" />
          ) : fileFilter.trim() && fileSearchResults?.length === 0 ? (
            <EmptyState text="No files match your search." />
          ) : (
            fileTree
          )}
        </>
      ) : isGitMode ? (
        <>
          <div
            className="right-pane__subtabs"
            role="tablist"
            aria-label="Git view"
          >
            <button
              type="button"
              role="tab"
              className="right-pane__subtab"
              aria-selected={!isGitSessionView}
              onClick={() => setIsGitSessionView(false)}
            >
              Git
            </button>
            <button
              type="button"
              role="tab"
              className="right-pane__subtab"
              aria-selected={isGitSessionView}
              onClick={() => setIsGitSessionView(true)}
            >
              Session
            </button>
          </div>
          {isGitSessionView ? (
            gitSessionDiffLoading ? (
              <EmptyState text="Loading session changes…" />
            ) : gitSessionDiffError ? (
              <EmptyState text={gitSessionDiffError} />
            ) : gitSessionDiff?.unavailableReason ? (
              <EmptyState text={gitSessionDiff.unavailableReason} />
            ) : (gitSessionDiff?.files.length ?? 0) === 0 ? (
              <EmptyState text="No session changes." />
            ) : (
              <div className="right-pane__diff-list">
                {gitSessionDiff?.files.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    className="right-pane__diff-row"
                    aria-current={file.path === selectedFilePath}
                    onClick={() => onSelectFilePath(file.path)}
                  >
                    <DiffStatusIcon status={file.status} />
                    <span className="right-pane__tree-name">{file.path}</span>
                  </button>
                ))}
              </div>
            )
          ) : gitStatusLoading && !gitStatus ? (
            <EmptyState text="Loading Git changes…" />
          ) : gitStatusError ? (
            <EmptyState text={gitStatusError} />
          ) : (
            <div
              className="right-pane-inspector right-pane-inspector--git"
              data-changes-open={isGitSectionExpanded}
            >
              <div className="right-pane__git-toolbar">
                <button
                  type="button"
                  className="right-pane__disclosure"
                  aria-label="Changes"
                  aria-expanded={isGitSectionExpanded}
                  onClick={() => setIsGitSectionExpanded(!isGitSectionExpanded)}
                >
                  {isGitSectionExpanded ? <ChevronDown /> : <ChevronRight />}
                  <span>Changes</span>
                </button>
                <button
                  type="button"
                  className="right-pane__icon-button right-pane__commit-action"
                  disabled={
                    gitActionLoading ||
                    !gitCommitMessage.trim() ||
                    !gitStatus?.changes.some(
                      (change) =>
                        change.indexStatus !== " " &&
                        change.indexStatus !== "?",
                    )
                  }
                  onClick={() =>
                    void runGitAction({
                      action: "commit",
                      message: gitCommitMessage,
                    })
                  }
                  aria-label="Commit"
                  title="Commit staged changes"
                >
                  <Check aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="right-pane__icon-button"
                  disabled={gitStatusLoading || gitActionLoading}
                  onClick={() => setGitRefreshVersion((version) => version + 1)}
                  aria-label="Refresh"
                  title="Refresh Git changes"
                >
                  <RightPaneIcon name="refresh" />
                </button>
                <div className="right-pane__menu-anchor" ref={gitMenuRef}>
                  <button
                    type="button"
                    className="right-pane__icon-button"
                    aria-label="More Actions"
                    title="More Actions"
                    aria-haspopup="menu"
                    aria-expanded={gitActionsOpen}
                    onClick={() => setGitActionsOpen(!gitActionsOpen)}
                  >
                    <MoreHorizontal />
                  </button>
                  {gitActionsOpen ? (
                    <div className="right-pane__menu" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        disabled={
                          gitActionLoading || !gitStatus?.changes.length
                        }
                        onClick={() => {
                          setGitActionsOpen(false);
                          void runGitAction({
                            action: "stage",
                            paths:
                              gitStatus?.changes.map((change) => change.path) ??
                              [],
                          });
                        }}
                      >
                        Stage all changes
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={
                          gitActionLoading ||
                          !gitStatus?.changes.some(
                            (change) =>
                              change.indexStatus.trim() && !change.untracked,
                          )
                        }
                        onClick={() => {
                          setGitActionsOpen(false);
                          void runGitAction({
                            action: "unstage",
                            paths:
                              gitStatus?.changes
                                .filter(
                                  (change) =>
                                    change.indexStatus.trim() &&
                                    !change.untracked,
                                )
                                .map((change) => change.path) ?? [],
                          });
                        }}
                      >
                        Unstage all changes
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
              <form
                className="right-pane__commit-form"
                onKeyDown={(event) => {
                  if (
                    (event.metaKey || event.ctrlKey) &&
                    event.key === "Enter"
                  ) {
                    event.preventDefault();
                    if (gitCommitMessage.trim() && !gitActionLoading)
                      void runGitAction({
                        action: "commit",
                        message: gitCommitMessage,
                      });
                  }
                }}
                onSubmit={(event) => {
                  event.preventDefault();
                  void runGitAction({
                    action: "commit",
                    message: gitCommitMessage,
                  });
                }}
              >
                <input
                  value={gitCommitMessage}
                  onChange={(event) => setGitCommitMessage(event.target.value)}
                  placeholder={
                    'Message (Cmd+Enter to commit on "' +
                    (gitStatus?.branch || "current branch") +
                    '")'
                  }
                  aria-label="Commit message"
                />
                <button
                  type="button"
                  className="right-pane__icon-button"
                  aria-label="Generate commit message"
                  title="Generate commit message"
                  disabled
                >
                  <Sparkles aria-hidden="true" />
                </button>
              </form>
              {gitActionError ? (
                <div className="right-pane__git-error" role="alert">
                  {gitActionError}
                </div>
              ) : null}
              <div className="right-pane__section-heading">
                <button
                  type="button"
                  className="right-pane__icon-button"
                  aria-label="Collapse changed files"
                  aria-expanded={isGitChangesExpanded}
                  onClick={() =>
                    setIsGitChangesExpanded((expanded) => !expanded)
                  }
                >
                  {isGitChangesExpanded ? (
                    <ChevronDown aria-hidden="true" />
                  ) : (
                    <ChevronRight aria-hidden="true" />
                  )}
                </button>
                <span>Changes</span>
                <span className="right-pane__count">
                  {gitStatus?.changes.length ?? 0}
                </span>
                <button
                  type="button"
                  className="right-pane__count ml-auto"
                  disabled={gitActionLoading || !gitStatus?.changes.length}
                  onClick={() =>
                    void runGitAction({
                      action: "stage",
                      paths:
                        gitStatus?.changes.map((change) => change.path) ?? [],
                    })
                  }
                >
                  Stage all
                </button>
              </div>
              {isGitChangesExpanded ? (
                <div className="right-pane__git-changes">
                  {gitStatus?.changes.length ? (
                    gitStatus.changes.map((change) => {
                      const path = change.path;
                      const staged =
                        change.indexStatus !== " " &&
                        change.indexStatus !== "?";
                      const selected = path === selectedFilePath;
                      const file = displayDiffFiles.find(
                        (entry) => entry.path === path,
                      );
                      return (
                        <div className="right-pane__git-change" key={path}>
                          <div className="right-pane__git-file-row">
                            <button
                              type="button"
                              className="right-pane__git-file"
                              aria-current={selected}
                              title={path}
                              onClick={() => onSelectFilePath(path)}
                            >
                              <FileDiff
                                aria-hidden="true"
                                className={statusIconTone(
                                  change.untracked
                                    ? "A"
                                    : staged
                                      ? change.indexStatus
                                      : change.worktreeStatus,
                                )}
                              />
                              <span className="right-pane__tree-name">
                                {path}
                              </span>
                              <span className="right-pane__git-status">
                                {change.untracked
                                  ? "U"
                                  : change.indexStatus.trim() +
                                    change.worktreeStatus.trim()}
                              </span>
                            </button>
                            <button
                              type="button"
                              className="right-pane__git-stage"
                              disabled={gitActionLoading}
                              aria-label={
                                staged ? "Unstage " + path : "Stage " + path
                              }
                              title={staged ? "Unstage" : "Stage"}
                              onClick={() =>
                                void runGitAction({
                                  action: staged ? "unstage" : "stage",
                                  paths: [path],
                                })
                              }
                            >
                              {staged ? (
                                <X aria-hidden="true" />
                              ) : (
                                <RightPaneIcon name="new-tab" />
                              )}
                            </button>
                          </div>
                          {selected && file ? (
                            <div className="right-pane__git-file-preview">
                              {renderDiffContent(file)}
                            </div>
                          ) : null}
                        </div>
                      );
                    })
                  ) : (
                    <div className="right-pane__git-empty">No changes</div>
                  )}
                </div>
              ) : null}
              <button
                type="button"
                className="right-pane__section-heading right-pane__graph-heading"
                aria-expanded={isGraphExpanded}
                onClick={() => setIsGraphExpanded(!isGraphExpanded)}
              >
                {isGraphExpanded ? <ChevronDown /> : <ChevronRight />}
                <span>Graph</span>
              </button>
              {isGraphExpanded ? (
                <div
                  className="right-pane__graph-area"
                  role="region"
                  aria-label="Graph"
                >
                  <div className="right-pane__graph-filter">
                    <select
                      aria-label="Branch filter"
                      value={gitBranchFilter}
                      onChange={(event) =>
                        setGitBranchFilter(event.target.value)
                      }
                    >
                      <option value="all">All branches</option>
                      <option value="current">Current branch</option>
                    </select>
                  </div>
                  {gitStatus?.graph.length ? (
                    <GitHistory lines={gitStatus.graph} />
                  ) : (
                    <div className="right-pane__git-empty">No commits yet.</div>
                  )}
                </div>
              ) : null}
              <div className="right-pane__branch-footer">
                <GitBranch aria-hidden="true" />
                <span>{gitStatus?.branch || "No branch"}</span>
                <span className="right-pane__count">
                  {gitStatus?.upstream
                    ? gitStatus.ahead +
                      " ahead · " +
                      gitStatus.behind +
                      " behind"
                    : "No upstream"}
                </span>
              </div>
            </div>
          )}
        </>
      ) : isTerminalRunMode ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="right-pane__page-row">
            <strong>Tasks</strong>
            <span>·</span>
            <span>{workspaceLabel}</span>
            <span className="right-pane__fill" />
            <button
              type="button"
              className="right-pane__icon-button"
              aria-label="Refresh"
              title="Refresh"
              onClick={onRefreshAgentThreads}
            >
              <RightPaneIcon name="refresh" />
            </button>
          </div>
          {agentThreadsError ? (
            <div className="right-pane__task-empty">
              <span>{agentThreadsError}</span>
            </div>
          ) : !props.threadId && terminalRunsError ? (
            <div className="right-pane__task-empty">
              <span>{terminalRunsError}</span>
            </div>
          ) : agentThreadsLoading ? (
            <div className="right-pane__task-empty">
              <span>Loading subagents…</span>
            </div>
          ) : directAgentThreads.length === 0 ? (
            <div className="right-pane__task-empty">
              <span>No subagents</span>
              <span>
                Subagents spawned under the main agent will appear here
              </span>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1">
              <div className="right-pane__task-list" role="list">
                {directAgentThreads.map((thread) => (
                  <button
                    key={thread.threadId}
                    type="button"
                    className="right-pane__task-row"
                    role="listitem"
                    aria-current={selectedTaskId === thread.threadId}
                    onClick={() => setSelectedTaskId(thread.threadId)}
                  >
                    <span
                      className="right-pane__task-status"
                      data-running={thread.status === "active"}
                      aria-hidden="true"
                    />
                    <span className="right-pane__task-name">
                      {thread.name ||
                        thread.agentNickname ||
                        thread.agentRole ||
                        thread.preview ||
                        "Subagent"}
                    </span>
                    <span className="right-pane__count">
                      {thread.status === "active" ? "running" : thread.status}
                    </span>
                  </button>
                ))}
              </div>
              <div className="right-pane__task-list">
                {selectedTask ? (
                  <article className="space-y-3 p-4">
                    <div className="flex items-start gap-3">
                      <span
                        className="right-pane__task-status mt-1.5"
                        data-running={selectedTask.status === "active"}
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <h2 className="text-sm font-medium">
                          {selectedTask.name ||
                            selectedTask.agentNickname ||
                            selectedTask.agentRole ||
                            "Subagent"}
                        </h2>
                        <p className="mt-1 text-xs text-zinc-500">
                          {selectedTask.agentRole || "Subagent"} ·{" "}
                          {selectedTask.status}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="right-pane__icon-button"
                        onClick={() => onOpenAgentThread(selectedTask.threadId)}
                        aria-label="Open subagent conversation"
                        title="Open conversation"
                      >
                        <Files aria-hidden="true" />
                      </button>
                    </div>
                    <p className="whitespace-pre-wrap break-words text-xs leading-5 text-zinc-500">
                      {selectedTask.preview ||
                        "This subagent has not sent a message yet."}
                    </p>
                  </article>
                ) : (
                  <EmptyState text="Select a subagent to view its details." />
                )}
              </div>
            </div>
          )}
          {props.threadId ? (
            <details
              hidden={!isBackgroundCommandsOpen}
              className="right-pane__background-commands"
              open={isBackgroundCommandsOpen}
              onToggle={(event) =>
                setIsBackgroundCommandsOpen(event.currentTarget.open)
              }
            >
              <summary>Background commands ({terminalRuns.length})</summary>
              <BackgroundTerminals
                key={props.runtimeScopeKey + ":" + props.threadId}
                threadId={props.threadId}
                onChange={onRefreshTerminalRuns}
              />
              <button
                type="button"
                onClick={() => setIsBackgroundCommandsOpen(false)}
              >
                Back to tasks
              </button>
              {terminalRunsLoading ? (
                <EmptyState text="Loading commands…" />
              ) : terminalRunsError ? (
                <EmptyState text={terminalRunsError} />
              ) : (
                terminalRuns.map((run) => (
                  <button
                    key={run.processId}
                    type="button"
                    className="right-pane__task-row"
                    onClick={() => onSelectTerminalRun(run.processId)}
                  >
                    <Terminal aria-hidden="true" />
                    <span className="right-pane__task-name">
                      {getTailTruncatedPath(run.command)}
                    </span>
                    <span className="right-pane__count">
                      {run.isRunning ? "running" : "done"}
                    </span>
                  </button>
                ))
              )}
              {selectedTerminalRun
                ? renderTerminalOutput(
                    selectedTerminalRunId,
                    terminalRunOutput,
                    terminalRunOutputLoading,
                    terminalRunOutputError,
                  )
                : null}
            </details>
          ) : null}
        </div>
      ) : isHooksMode ? (
        <div className="right-pane-inspector">
          <HooksPane
            key={props.runtimeScopeKey + ":" + sessionId}
            threadId={props.threadId}
            hooksData={hooksData}
            hooksLoading={hooksLoading}
            hooksError={hooksError}
            selectedHookKey={selectedHookKey}
            updatingHookKey={updatingHookKey}
            isFileListVisible={isFileListVisible}
            selectedFileLabel={selectedFileLabel}
            onRefreshHooks={onRefreshHooks}
            onSelectHookKey={onSelectHookKey}
            onToggleHookEnabled={onToggleHookEnabled}
            onTrustHook={onTrustHook}
            onTrustAllHooks={onTrustAllHooks}
          />
        </div>
      ) : isSkillsMode ? (
        skillsLoading ? (
          <EmptyState text="Loading skills…" />
        ) : skillsError ? (
          <EmptyState text={skillsError} />
        ) : (
          <div className="right-pane-inspector flex min-h-0 flex-1 flex-col">
            <div className="right-pane__page-row">
              <Sparkles aria-hidden="true" className="h-4 w-4 text-zinc-400" />
              <strong>Skills</strong>
              <span className="right-pane__fill" />
              <span>{skills.length} skills</span>
              <button
                type="button"
                className="right-pane__icon-button"
                aria-label="Refresh skills"
                onClick={onRefreshSkills}
              >
                <RightPaneIcon name="refresh" />
              </button>
            </div>
            {skills.length ? (
              <div className="right-pane__skill-list">
                {skills.map((skill) => (
                  <button
                    key={skill.path}
                    type="button"
                    className="right-pane__skill-row"
                    aria-current={skill.path === selectedSkillPath}
                    onClick={() => onSelectSkillPath(skill.path)}
                  >
                    <Sparkles
                      aria-hidden="true"
                      className="h-4 w-4 text-violet-500"
                    />
                    <span className="right-pane__skill-name">
                      {getSkillDisplayName(skill)}
                    </span>
                    <span className="right-pane__count">
                      {skill.enabled ? "enabled" : "disabled"}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <EmptyState text="No skills available." />
            )}
            {renderSkillDetails(
              selectedSkill,
              updatingSkillPath,
              onToggleSkillEnabled,
            )}
          </div>
        )
      ) : (
        <EmptyState text="Select an item to view its details." />
      )}
    </section>
  );
}

/** A split pane has its own file selection and page, rather than changing its neighbour. */
function SecondaryPane(props: PaneContentProps) {
  const [mode, setMode] = useState<RightPaneMode>("home");
  const [path, setPath] = useState<string | null>(null);
  const [content, setContent] = useState<SessionFileContentResponse | null>(
    null,
  );
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const request = props.threadId
      ? getSessionFileContent(props.threadId, path, page)
      : props.workflowKey
        ? getWorkflowProjectFileContent(props.workflowKey, path, page)
        : Promise.resolve(null);
    void request
      .then((result) => {
        if (!cancelled) setContent(result);
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, page, props.threadId, props.workflowKey, props.fileTreeNodesData]);
  return (
    <DiffPaneContent
      {...props}
      mode={mode}
      onChangeMode={setMode}
      selectedFilePath={path}
      onSelectFilePath={(next) => {
        setPath(next);
        setPage(1);
      }}
      fileContent={content}
      fileContentLoading={loading}
      fileContentError={error}
      fileContentPage={page}
      onChangeFileContentPage={setPage}
      targetLineNumber={null}
    />
  );
}

export default function DiffPane(props: DiffPaneProps) {
  const [split, setSplit] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fraction, setFraction] = useState(0.5);
  const container = useRef<HTMLDivElement>(null);
  const [measuredWidth, setMeasuredWidth] = useState(props.width);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setMeasuredWidth(entry.contentRect.width),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.collapsed]);
  useEffect(() => {
    setSplit(false);
  }, [props.runtimeScopeKey, props.sessionId]);
  if (props.collapsed) return null;
  const contentProps: PaneContentProps = {
    ...props,
    fullscreen,
    onToggleFullscreen: () => setFullscreen((value) => !value),
    canSplit: !split && (fullscreen || measuredWidth >= 560),
    onSplitPane: () => setSplit(true),
    onEmptyPane: () => setSplit(false),
  };
  return (
    <aside
      className="pane-right relative shrink-0 flex flex-col"
      style={{ width: `${props.width}px` }}
      data-fullscreen={fullscreen}
    >
      <div
        role="separator"
        aria-label="Resize right pane"
        aria-orientation="vertical"
        onPointerDown={props.onResizeStart}
        className={
          props.isMobilePhone
            ? "absolute top-1/2 left-0 z-20 -translate-x-1/2 -translate-y-1/2 cursor-col-resize touch-none"
            : "absolute top-0 left-0 z-20 h-full w-2 -translate-x-1/2 cursor-col-resize touch-none"
        }
      >
        {props.isMobilePhone ? (
          <div className="right-pane__mobile-grip">
            <GripVertical />
          </div>
        ) : null}
      </div>
      <div
        ref={container}
        className="right-pane__dock-layout"
        data-split={split}
        style={{
          gridTemplateColumns: split
            ? `minmax(0, ${fraction}fr) 0px minmax(0, ${1 - fraction}fr)`
            : "minmax(0, 1fr)",
        }}
      >
        <DiffPaneContent
          {...contentProps}
          key={props.runtimeScopeKey ?? props.sessionId}
          hideChrome={split}
        />
        {split ? (
          <>
            <div
              role="separator"
              aria-label="Resize sidebar split"
              aria-orientation="vertical"
              tabIndex={0}
              className="right-pane__split-divider"
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.preventDefault();
                  setFraction((value) =>
                    Math.max(
                      0.2,
                      Math.min(
                        0.8,
                        value + (event.key === "ArrowLeft" ? -0.05 : 0.05),
                      ),
                    ),
                  );
                }
              }}
              onPointerDown={(event) => {
                const target = event.currentTarget;
                target.setPointerCapture(event.pointerId);
                const move = (pointer: PointerEvent) => {
                  const rect = container.current?.getBoundingClientRect();
                  if (rect)
                    setFraction(
                      Math.max(
                        0.2,
                        Math.min(
                          0.8,
                          (pointer.clientX - rect.left) / rect.width,
                        ),
                      ),
                    );
                };
                const end = () => {
                  target.removeEventListener("pointermove", move);
                  target.removeEventListener("pointerup", end);
                  target.removeEventListener("pointercancel", end);
                };
                target.addEventListener("pointermove", move);
                target.addEventListener("pointerup", end);
                target.addEventListener("pointercancel", end);
              }}
            />
            <SecondaryPane
              {...contentProps}
              key={props.runtimeScopeKey ?? props.sessionId}
              canSplit={false}
            />
          </>
        ) : null}
      </div>
    </aside>
  );
}

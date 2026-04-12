import {
  useCallback,
  useEffect,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ChevronRight,
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileDiff,
  FileImage,
  FileText,
  FileVideo,
  FolderClosed,
  FolderOpen,
  GripVertical,
  List,
  RefreshCw,
  Sparkles,
  Terminal,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  CodexSkillMetadata,
  SessionDiffFile,
  SessionDiffMode,
  SessionDiffResponse,
  SessionFileContentResponse,
  SessionFileTreeNodesResponse,
  SessionSkillsResponse,
  SessionTerminalRunSummary,
} from "@codex-deck/api";
import { PatchTextRenderer, SourceCodeRenderer } from "./patch-text-renderer";
import { AnsiText } from "./tool-renderers/ansi-text";
import { isMarkdownPath } from "../path-utils";

export type RightPaneMode = SessionDiffMode | "terminal-flow" | "skills";

interface DiffPaneProps {
  collapsed: boolean;
  revealFileListVersion: number;
  isMobilePhone: boolean;
  mode: RightPaneMode;
  sessionId: string | null;
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
  onChangeFileContentPage: (page: number) => void;
  onSelectTerminalRun: (processId: string) => void;
  onRefreshTerminalRuns: () => void;
  onSelectSkillPath: (path: string) => void;
  onToggleSkillEnabled: (path: string, enabled: boolean) => void;
  onRefreshSkills: () => void;
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

function getTreeFileBadge(
  path: string,
): { label: string; className: string } | null {
  if (isMarkdownPath(path)) {
    return {
      label: "MD",
      className:
        "bg-emerald-500/16 text-emerald-200 border border-emerald-400/30",
    };
  }

  if (PDF_EXTENSIONS.has(getFileExtension(path))) {
    return {
      label: "PDF",
      className: "bg-rose-500/16 text-rose-200 border border-rose-400/30",
    };
  }

  return null;
}

type TreeFileIconStyle = {
  Icon: LucideIcon;
  iconClassName: string;
  containerClassName: string;
};

const CODE_EXTENSIONS = new Set([
  "c",
  "cc",
  "cpp",
  "cs",
  "css",
  "go",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "jsx",
  "kt",
  "mjs",
  "mts",
  "php",
  "ps1",
  "py",
  "rb",
  "rs",
  "sass",
  "scala",
  "scss",
  "sh",
  "sql",
  "swift",
  "ts",
  "tsx",
  "vue",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);

const CONFIG_EXTENSIONS = new Set([
  "conf",
  "env",
  "gitignore",
  "ini",
  "json",
  "jsonc",
  "lock",
  "toml",
]);

const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
]);

const PDF_EXTENSIONS = new Set(["pdf"]);

const AUDIO_EXTENSIONS = new Set(["aac", "flac", "m4a", "mp3", "ogg", "wav"]);

const VIDEO_EXTENSIONS = new Set(["mkv", "mov", "mp4", "webm"]);

const ARCHIVE_EXTENSIONS = new Set([
  "7z",
  "bz2",
  "gz",
  "rar",
  "tar",
  "tgz",
  "xz",
  "zip",
]);

const CODE_FILENAMES = new Set([
  "dockerfile",
  "makefile",
  "justfile",
  "gemfile",
  "rakefile",
]);

const CONFIG_FILENAMES = new Set([
  ".editorconfig",
  ".env",
  ".env.example",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.json",
  ".npmrc",
  ".nvmrc",
  ".prettierrc",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "vite.config.ts",
]);

function getFileExtension(path: string): string {
  const fileName = path.split("/").pop()?.toLowerCase() ?? "";
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
    return "";
  }
  return fileName.slice(dotIndex + 1);
}

function getTreeFileIconStyle(path: string): TreeFileIconStyle {
  if (isMarkdownPath(path)) {
    return {
      Icon: FileText,
      iconClassName: "text-emerald-200",
      containerClassName: "border-emerald-400/30 bg-emerald-500/12",
    };
  }

  const fileName = path.split("/").pop()?.toLowerCase() ?? "";
  const extension = getFileExtension(path);

  if (IMAGE_EXTENSIONS.has(extension)) {
    return {
      Icon: FileImage,
      iconClassName: "text-fuchsia-200",
      containerClassName: "border-fuchsia-400/30 bg-fuchsia-500/12",
    };
  }

  if (PDF_EXTENSIONS.has(extension)) {
    return {
      Icon: FileText,
      iconClassName: "text-rose-200",
      containerClassName: "border-rose-400/30 bg-rose-500/12",
    };
  }

  if (AUDIO_EXTENSIONS.has(extension)) {
    return {
      Icon: FileAudio,
      iconClassName: "text-violet-200",
      containerClassName: "border-violet-400/30 bg-violet-500/12",
    };
  }

  if (VIDEO_EXTENSIONS.has(extension)) {
    return {
      Icon: FileVideo,
      iconClassName: "text-violet-200",
      containerClassName: "border-violet-400/30 bg-violet-500/12",
    };
  }

  if (ARCHIVE_EXTENSIONS.has(extension)) {
    return {
      Icon: FileArchive,
      iconClassName: "text-orange-200",
      containerClassName: "border-orange-400/30 bg-orange-500/12",
    };
  }

  if (CONFIG_EXTENSIONS.has(extension) || CONFIG_FILENAMES.has(fileName)) {
    return {
      Icon: FileText,
      iconClassName: "text-cyan-200",
      containerClassName: "border-cyan-400/30 bg-cyan-500/12",
    };
  }

  if (CODE_EXTENSIONS.has(extension) || CODE_FILENAMES.has(fileName)) {
    return {
      Icon: FileCode2,
      iconClassName: "text-sky-200",
      containerClassName: "border-sky-400/30 bg-sky-500/12",
    };
  }

  return {
    Icon: File,
    iconClassName: "text-zinc-300",
    containerClassName: "border-zinc-500/30 bg-zinc-500/10",
  };
}

function getDirectoryIconStyle(isExpanded: boolean): TreeFileIconStyle {
  if (isExpanded) {
    return {
      Icon: FolderOpen,
      iconClassName: "text-amber-100",
      containerClassName: "border-amber-300/40 bg-amber-400/16",
    };
  }
  return {
    Icon: FolderClosed,
    iconClassName: "text-amber-200",
    containerClassName: "border-amber-400/30 bg-amber-500/10",
  };
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

function EmptyState(props: { text: string }) {
  return (
    <div className="h-full flex items-center justify-center px-4 text-center text-xs text-zinc-500">
      {props.text}
    </div>
  );
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
    return <EmptyState text="Select a terminal run to inspect its output." />;
  }

  if (loading) {
    return <EmptyState text="Loading terminal output..." />;
  }

  if (error) {
    return <EmptyState text={error} />;
  }

  if (!output.trim()) {
    return <EmptyState text="No terminal output captured yet." />;
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
    <div className="h-full overflow-auto p-3">
      <div className="space-y-3">
        <div>
          <div className="text-sm text-zinc-100">
            {getSkillDisplayName(skill)}
          </div>
          <div className="mt-1 text-xs text-zinc-500">{skill.name}</div>
        </div>
        <div className="text-xs leading-5 text-zinc-300 whitespace-pre-wrap">
          {description}
        </div>
        <div className="text-[11px] text-zinc-400 space-y-1">
          <div>
            <span className="text-zinc-500">Path:</span> {skill.path}
          </div>
          <div>
            <span className="text-zinc-500">Scope:</span> {skill.scope}
          </div>
          <div>
            <span className="text-zinc-500">Status:</span>{" "}
            {skill.enabled ? "enabled" : "disabled"}
          </div>
        </div>
        {skill.interface?.defaultPrompt ? (
          <div>
            <div className="text-[11px] text-zinc-500 mb-1">Default prompt</div>
            <pre className="rounded border border-zinc-800 bg-zinc-900/60 p-2 text-[11px] leading-5 text-zinc-300 whitespace-pre-wrap break-words font-mono">
              {skill.interface.defaultPrompt}
            </pre>
          </div>
        ) : null}
        {skill.dependencies?.tools.length ? (
          <div>
            <div className="text-[11px] text-zinc-500 mb-1">Dependencies</div>
            <div className="rounded border border-zinc-800 bg-zinc-900/40 p-2">
              {skill.dependencies.tools.map((tool) => (
                <div
                  key={`${tool.type}:${tool.value}`}
                  className="text-[11px] text-zinc-300 leading-5 break-all"
                >
                  {tool.type}: {tool.value}
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => onToggleSkillEnabled(skill.path, !skill.enabled)}
          disabled={isToggling}
          className={`h-8 rounded border px-3 text-xs transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
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
) {
  if (!selectedFilePath) {
    return <EmptyState text="Select a file to preview its content." />;
  }

  if (loading) {
    return <EmptyState text="Loading file content..." />;
  }

  if (error) {
    return <EmptyState text={error} />;
  }

  if (!fileContent || fileContent.path !== selectedFilePath) {
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
      <div className="h-full overflow-auto bg-[radial-gradient(circle_at_top,_rgba(244,244,245,0.12),_rgba(9,9,11,0.96)_60%)] p-4">
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
          className="h-7 min-w-[30px] px-2 inline-flex items-center justify-center rounded border border-zinc-500/90 bg-zinc-900/55 text-[14px] font-black leading-none text-white hover:bg-zinc-800/55 disabled:border-zinc-700/60 disabled:bg-zinc-900/55 disabled:text-white disabled:opacity-100 disabled:cursor-not-allowed"
          style={{ WebkitTextFillColor: "#ffffff", color: "#ffffff" }}
          aria-label="Previous page"
        >
          <span
            style={{
              color: "#ffffff",
              WebkitTextFillColor: "#ffffff",
              opacity: canGoPrev ? 1 : 0.45,
            }}
          >
            &lt;
          </span>
        </button>
        <div
          className="h-7 px-3 inline-flex items-center justify-center rounded border border-zinc-700/70 bg-zinc-900/60 text-[11px] font-mono font-bold text-white tabular-nums"
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
            className="border-0 bg-transparent p-0 text-right text-white outline-none"
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
          className="h-7 min-w-[30px] px-2 inline-flex items-center justify-center rounded border border-zinc-500/90 bg-zinc-900/55 text-[14px] font-black leading-none text-white hover:bg-zinc-800/55 disabled:border-zinc-700/60 disabled:bg-zinc-900/55 disabled:text-white disabled:opacity-100 disabled:cursor-not-allowed"
          style={{ WebkitTextFillColor: "#ffffff", color: "#ffffff" }}
          aria-label="Next page"
        >
          <span
            style={{
              color: "#ffffff",
              WebkitTextFillColor: "#ffffff",
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

function FileTreeListEntry(props: {
  node: { name: string; path: string; isDirectory: boolean };
  selectedFilePath: string | null;
  onOpenDirectory: (path: string) => void;
  onSelectFilePath: (path: string) => void;
}) {
  const { node, selectedFilePath, onOpenDirectory, onSelectFilePath } = props;
  const isSelected = !node.isDirectory && selectedFilePath === node.path;
  const fileBadge = !node.isDirectory ? getTreeFileBadge(node.path) : null;
  const fileIconStyle = !node.isDirectory
    ? getTreeFileIconStyle(node.path)
    : null;
  const directoryIconStyle = node.isDirectory
    ? getDirectoryIconStyle(false)
    : null;
  const FileIcon = fileIconStyle?.Icon;
  const DirectoryIcon = directoryIconStyle?.Icon;

  if (node.isDirectory) {
    return (
      <>
        <button
          type="button"
          onClick={() => onOpenDirectory(node.path)}
          className="w-full text-left py-1 text-[11px] text-zinc-300 hover:bg-zinc-900/50"
          style={{ paddingLeft: "10px", paddingRight: "10px" }}
        >
          <span className="inline-flex items-center gap-1.5">
            <ChevronRight className="h-3.5 w-3.5 text-zinc-500" />
            {DirectoryIcon ? (
              <span
                className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border ${directoryIconStyle?.containerClassName ?? ""}`}
              >
                <DirectoryIcon
                  className={`h-3.5 w-3.5 ${directoryIconStyle?.iconClassName ?? "text-zinc-400"}`}
                />
              </span>
            ) : null}
            <span>{node.name}</span>
          </span>
        </button>
      </>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelectFilePath(node.path)}
      className={`w-full text-left py-1 text-[11px] hover:bg-zinc-900/50 ${
        isSelected ? "bg-zinc-900/60 text-zinc-100" : "text-zinc-300"
      }`}
      style={{ paddingLeft: "29px", paddingRight: "10px" }}
      title={node.path}
    >
      <span className="inline-flex min-w-0 items-center gap-1.5">
        {FileIcon ? (
          <span
            className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border ${fileIconStyle?.containerClassName ?? ""}`}
          >
            <FileIcon
              className={`h-3.5 w-3.5 ${fileIconStyle?.iconClassName ?? "text-zinc-400"}`}
            />
          </span>
        ) : null}
        <span className="truncate">{node.name}</span>
        {fileBadge ? (
          <span
            className={`ml-1 inline-flex shrink-0 items-center rounded px-1 py-0 text-[9px] font-semibold tracking-wide ${fileBadge.className}`}
          >
            {fileBadge.label}
          </span>
        ) : null}
      </span>
    </button>
  );
}

export default function DiffPane(props: DiffPaneProps) {
  const {
    collapsed,
    revealFileListVersion,
    isMobilePhone,
    mode,
    sessionId,
    width,
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
    skillsData,
    skillsLoading,
    skillsError,
    selectedSkillPath,
    updatingSkillPath,
    onToggleCollapsed,
    onResizeStart,
    onChangeMode,
    onSelectFilePath,
    onOpenFileTreeDirectory,
    onLoadMoreFileTreeNodes,
    onChangeFileContentPage,
    onSelectTerminalRun,
    onRefreshTerminalRuns,
    onSelectSkillPath,
    onToggleSkillEnabled,
    onRefreshSkills,
  } = props;

  const isFileTreeMode = mode === "file-tree";
  const isTerminalRunMode = mode === "terminal-flow";
  const isSkillsMode = mode === "skills";
  const [isFileListVisible, setIsFileListVisible] = useState(true);

  useEffect(() => {
    setIsFileListVisible(true);
  }, [revealFileListVersion]);

  if (collapsed) {
    return null;
  }

  const diffFiles = diffData?.files ?? [];
  const selectedDiffFile =
    diffFiles.find((file) => file.path === selectedFilePath) ?? null;
  const selectedTerminalRun =
    terminalRuns.find((run) => run.processId === selectedTerminalRunId) ?? null;
  const skills = skillsData?.skills ?? [];
  const selectedSkill =
    skills.find((skill) => skill.path === selectedSkillPath) ?? null;
  const topStatusText = isTerminalRunMode
    ? `${terminalRuns.length} runs`
    : isSkillsMode
      ? `${skills.length} skills`
      : isFileTreeMode
        ? `${fileTreeNodesData?.nodes.length ?? 0}${
            fileTreeNodesData?.nextCursor !== null ? "+" : ""
          } entries`
        : diffData?.mode === "last-turn" && diffData.turnId
          ? `Turn ${diffData.turnId}`
          : `${diffFiles.length} files`;
  const fileTreeDirLabel = (() => {
    if (!isFileTreeMode) {
      return "";
    }
    const dir = fileTreeNodesData?.dir?.trim() ?? "";
    return dir ? `/${dir}` : "/";
  })();
  const selectedFileLabel = (() => {
    if (isTerminalRunMode) {
      if (!selectedTerminalRun) {
        return "Terminal output";
      }
      return `${selectedTerminalRun.command} (${selectedTerminalRun.processId})`;
    }

    if (isSkillsMode) {
      return selectedSkill
        ? getSkillDisplayName(selectedSkill)
        : "Skill details";
    }

    if (!selectedFilePath) {
      return isFileTreeMode ? "File" : "Diff";
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

  return (
    <aside
      className="relative shrink-0 border-l border-zinc-800/60 bg-zinc-950 flex flex-col"
      style={{ width: `${width}px` }}
    >
      <div
        role="separator"
        aria-label="Resize right pane"
        aria-orientation="vertical"
        onPointerDown={onResizeStart}
        className={
          isMobilePhone
            ? "absolute top-1/2 left-0 z-20 -translate-x-1/2 -translate-y-1/2 cursor-col-resize touch-none"
            : "absolute top-0 left-0 z-20 h-full w-2 -translate-x-1/2 cursor-col-resize touch-none"
        }
      >
        {isMobilePhone && (
          <div className="flex h-10 w-6 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900/95 text-zinc-400 shadow-lg">
            <GripVertical className="h-4 w-4" />
          </div>
        )}
      </div>
      <div className="h-[50px] border-b border-zinc-800/60 px-3 flex items-center gap-2 overflow-hidden">
        <div className="min-w-0 flex flex-1 items-center gap-2">
          <button
            type="button"
            onClick={() => setIsFileListVisible((current) => !current)}
            className={`h-8 w-8 shrink-0 rounded border text-zinc-300 transition-colors ${
              isFileListVisible
                ? "border-zinc-600 bg-zinc-800/80 hover:bg-zinc-700/80"
                : "border-zinc-700 bg-zinc-900/70 hover:bg-zinc-800/80"
            }`}
            aria-label={
              isFileListVisible ? "Hide list panel" : "Show list panel"
            }
            title={isFileListVisible ? "Hide list panel" : "Show list panel"}
          >
            <List className="h-4 w-4 mx-auto" />
          </button>
          <select
            value={mode}
            onChange={(event) =>
              onChangeMode(event.target.value as RightPaneMode)
            }
            className="h-8 min-w-0 flex-1 bg-zinc-900/70 text-zinc-300 text-xs rounded border border-zinc-800 px-2 focus:outline-none"
          >
            <option value="unstaged">Unstaged</option>
            <option value="staged">Staged</option>
            <option value="last-turn">Last turn</option>
            <option value="file-tree">File tree</option>
            <option value="terminal-flow">Terminal run</option>
            <option value="skills">Skills</option>
          </select>
        </div>
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="h-8 w-8 shrink-0 rounded border border-zinc-700 bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800/80 transition-colors"
          aria-label="Collapse diff pane"
          title="Collapse diff pane"
        >
          <ChevronRight className="h-4 w-4 mx-auto" />
        </button>
      </div>

      {!sessionId ? (
        <EmptyState text="Select a session to view this pane." />
      ) : isTerminalRunMode ? (
        terminalRunsLoading ? (
          <EmptyState text="Loading terminal runs..." />
        ) : terminalRunsError ? (
          <EmptyState text={terminalRunsError} />
        ) : (
          <div className="flex-1 min-h-0 flex">
            {isFileListVisible ? (
              <div className="w-52 border-r border-zinc-800/60 overflow-y-auto">
                <div className="px-3 py-2 border-b border-zinc-800/60 text-[11px] text-zinc-500 flex items-center justify-between gap-2">
                  <span>{topStatusText}</span>
                  <button
                    type="button"
                    onClick={onRefreshTerminalRuns}
                    className="h-6 w-6 shrink-0 rounded border border-zinc-700 bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800/80 transition-colors"
                    aria-label="Refresh terminal runs"
                    title="Refresh terminal runs"
                  >
                    <RefreshCw className="h-3.5 w-3.5 mx-auto" />
                  </button>
                </div>
                {terminalRuns.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-zinc-500">
                    No terminal runs.
                  </div>
                ) : (
                  terminalRuns.map((run) => {
                    const active = run.processId === selectedTerminalRunId;
                    return (
                      <button
                        key={run.processId}
                        type="button"
                        onClick={() => onSelectTerminalRun(run.processId)}
                        className={`w-full text-left px-3 py-2 border-b border-zinc-900 hover:bg-zinc-900/50 transition-colors ${
                          active ? "bg-zinc-900/60" : ""
                        }`}
                        title={`${run.command} (${run.processId})`}
                      >
                        <div className="text-[11px] leading-4 text-zinc-200 break-all overflow-hidden [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
                          {getTailTruncatedPath(run.command)}
                        </div>
                        <div className="mt-1 flex items-center gap-1 text-[10px] text-zinc-500">
                          <span>{run.processId}</span>
                          <span>•</span>
                          <span>{run.isRunning ? "running" : "completed"}</span>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            ) : null}

            <div className="flex-1 min-w-0 flex flex-col">
              <div className="h-9 px-3 border-b border-zinc-800/60 flex items-center gap-2">
                <Terminal className="h-3.5 w-3.5 text-zinc-400" />
                <span className="text-xs text-zinc-300 truncate">
                  {selectedFileLabel}
                </span>
              </div>
              <div className="flex-1 min-h-0">
                {renderTerminalOutput(
                  selectedTerminalRunId,
                  terminalRunOutput,
                  terminalRunOutputLoading,
                  terminalRunOutputError,
                )}
              </div>
            </div>
          </div>
        )
      ) : isSkillsMode ? (
        skillsLoading ? (
          <EmptyState text="Loading skills..." />
        ) : skillsError ? (
          <EmptyState text={skillsError} />
        ) : (
          <div className="flex-1 min-h-0 flex">
            {isFileListVisible ? (
              <div className="w-52 border-r border-zinc-800/60 overflow-y-auto">
                <div className="px-3 py-2 border-b border-zinc-800/60 text-[11px] text-zinc-500 flex items-center justify-between gap-2">
                  <span>{topStatusText}</span>
                  <button
                    type="button"
                    onClick={onRefreshSkills}
                    className="h-6 w-6 shrink-0 rounded border border-zinc-700 bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800/80 transition-colors"
                    aria-label="Refresh skills"
                    title="Refresh skills"
                  >
                    <RefreshCw className="h-3.5 w-3.5 mx-auto" />
                  </button>
                </div>
                {skillsData?.errors.length ? (
                  <div className="px-3 py-2 border-b border-zinc-900 text-[10px] text-amber-300">
                    {skillsData.errors.length} invalid skill
                    {skillsData.errors.length === 1 ? "" : "s"} skipped
                  </div>
                ) : null}
                {skills.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-zinc-500">
                    No skills available.
                  </div>
                ) : (
                  skills.map((skill) => {
                    const active = skill.path === selectedSkillPath;
                    return (
                      <button
                        key={skill.path}
                        type="button"
                        onClick={() => onSelectSkillPath(skill.path)}
                        className={`w-full text-left px-3 py-2 border-b border-zinc-900 hover:bg-zinc-900/50 transition-colors ${
                          active ? "bg-zinc-900/60" : ""
                        }`}
                        title={`${skill.name} (${skill.scope})`}
                      >
                        <div className="text-[11px] leading-4 text-zinc-200 truncate">
                          {getSkillDisplayName(skill)}
                        </div>
                        <div className="mt-1 flex items-center gap-1 text-[10px] text-zinc-500">
                          <span
                            className={
                              skill.enabled
                                ? "text-emerald-300"
                                : "text-rose-300"
                            }
                          >
                            {skill.enabled ? "enabled" : "disabled"}
                          </span>
                          <span>•</span>
                          <span>{skill.scope}</span>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            ) : null}

            <div className="flex-1 min-w-0 flex flex-col">
              <div className="h-9 px-3 border-b border-zinc-800/60 flex items-center gap-2">
                <Sparkles className="h-3.5 w-3.5 text-zinc-400" />
                <span className="text-xs text-zinc-300 truncate">
                  {selectedFileLabel}
                </span>
              </div>
              <div className="flex-1 min-h-0">
                {renderSkillDetails(
                  selectedSkill,
                  updatingSkillPath,
                  onToggleSkillEnabled,
                )}
              </div>
            </div>
          </div>
        )
      ) : loading ? (
        <EmptyState
          text={isFileTreeMode ? "Loading file tree..." : "Loading diffs..."}
        />
      ) : error ? (
        <EmptyState text={error} />
      ) : isFileTreeMode && fileTreeNodesData?.unavailableReason ? (
        <EmptyState text={fileTreeNodesData.unavailableReason} />
      ) : !isFileTreeMode && diffData?.unavailableReason ? (
        <EmptyState text={diffData.unavailableReason} />
      ) : (
        <div className="flex-1 min-h-0 flex">
          {isFileListVisible ? (
            <div className="w-52 border-r border-zinc-800/60 overflow-y-auto">
              <div className="px-3 py-2 border-b border-zinc-800/60 text-[11px] text-zinc-500 space-y-2">
                <div>{topStatusText}</div>
                {isFileTreeMode ? (
                  <div className="space-y-1">
                    <div
                      className="text-[10px] text-zinc-400 truncate"
                      title={fileTreeDirLabel}
                    >
                      {fileTreeDirLabel}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const currentDir = fileTreeNodesData?.dir?.trim() ?? "";
                        if (!currentDir) {
                          return;
                        }
                        const parentDir =
                          currentDir.split("/").slice(0, -1).join("/") || "";
                        onOpenFileTreeDirectory(parentDir);
                      }}
                      disabled={!fileTreeNodesData?.dir}
                      className="h-6 rounded border border-zinc-700 bg-zinc-900/70 px-2 text-[10px] text-zinc-300 hover:bg-zinc-800/80 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Up
                    </button>
                  </div>
                ) : null}
              </div>
              {isFileTreeMode ? (
                !fileTreeNodesData || fileTreeNodesData.nodes.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-zinc-500">
                    No files found.
                  </div>
                ) : (
                  <>
                    {fileTreeNodesData.nodes.map((node) => (
                      <FileTreeListEntry
                        key={node.path}
                        node={node}
                        selectedFilePath={selectedFilePath}
                        onOpenDirectory={onOpenFileTreeDirectory}
                        onSelectFilePath={onSelectFilePath}
                      />
                    ))}
                    {fileTreeNodesData.nextCursor !== null ? (
                      <div className="px-3 py-2 border-t border-zinc-900">
                        <button
                          type="button"
                          onClick={onLoadMoreFileTreeNodes}
                          disabled={fileTreeLoadingMore}
                          className="w-full h-7 rounded border border-zinc-700 bg-zinc-900/70 text-[11px] text-zinc-300 hover:bg-zinc-800/80 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {fileTreeLoadingMore ? "Loading..." : "Load more"}
                        </button>
                      </div>
                    ) : null}
                  </>
                )
              ) : diffFiles.length === 0 ? (
                <div className="px-3 py-3 text-xs text-zinc-500">
                  No file changes.
                </div>
              ) : (
                diffFiles.map((file) => {
                  const active = file.path === selectedFilePath;
                  return (
                    <button
                      key={file.path}
                      type="button"
                      onClick={() => onSelectFilePath(file.path)}
                      title={`${file.status} ${file.path}`}
                      className={`w-full text-left px-3 py-2 border-b border-zinc-900 hover:bg-zinc-900/50 transition-colors ${
                        active ? "bg-zinc-900/60" : ""
                      }`}
                    >
                      <div className="grid grid-cols-[1fr_auto] items-end gap-x-2">
                        <span className="text-[11px] leading-4 text-zinc-200 break-all overflow-hidden [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
                          {getTailTruncatedPath(file.path)}
                        </span>
                        <span className="mb-0.5 shrink-0" aria-hidden="true">
                          <DiffStatusIcon status={file.status} />
                        </span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          ) : null}

          <div className="flex-1 min-w-0 flex flex-col">
            <div className="h-9 px-3 border-b border-zinc-800/60 flex items-center gap-2">
              <FileDiff className="h-3.5 w-3.5 text-zinc-400" />
              <span className="text-xs text-zinc-300 truncate">
                {selectedFileLabel}
              </span>
            </div>
            <div className="flex-1 min-h-0">
              {isFileTreeMode
                ? renderFileContent(
                    selectedFilePath,
                    fileContent,
                    fileContentLoading,
                    fileContentError,
                    fileContentPage,
                    targetLineNumber,
                    onChangeFileContentPage,
                  )
                : renderDiffContent(selectedDiffFile)}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

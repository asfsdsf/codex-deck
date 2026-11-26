import { useState, useEffect, useRef, useCallback } from "react";
import type {
  SessionFileContentResponse,
  SessionGitStatusResponse,
} from "@codex-deck/api";
import { Check, WrapText } from "lucide-react";
import {
  searchSessionFiles,
  searchWorkflowProjectFiles,
  getSessionFileContent,
  getWorkflowProjectFileContent,
  uploadWorkspaceFile,
  saveWorkspaceFile,
  getSessionGitStatus,
  getWorkflowProjectGitStatus,
} from "../../web/api";
import { isMarkdownPath } from "../../web/path-utils";
import { subscribeCodexRuntimeEvents } from "../../web/codex-runtime-events";
import { SourceCodeRenderer } from "../../web/components/patch-text-renderer";
import DocumentMarkdown from "../../web/components/document-markdown";
import WorkspaceFileTree, {
  type FileSort,
  type FileTreeCache,
} from "../../web/components/workspace-file-tree";
import { RightPaneIcon } from "../../web/components/deepseek/right-pane-icons";
import EmptyState from "../right-pane/empty-state";
import { useDismissMenu } from "../right-pane/use-dismiss-menu";
import type { RightPaneToolProps } from "../right-pane/types";

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
export default function FilesView(props: RightPaneToolProps) {
  const {
    fileLinkOpenVersion,
    sessionId,
    error,
    fileTreeNodesData,
    fileTreeLoadingMore,
    fileContent,
    fileContentLoading,
    fileContentError,
    fileContentPage,
    selectedFilePath,
    targetLineNumber,
    onSelectFilePath,
    onLoadMoreFileTreeNodes,
    onRefreshFiles,
    onChangeFileContentPage,
    previewOpen: isSelectedFilePreviewOpen,
    setPreviewOpen: setIsSelectedFilePreviewOpen,
  } = props;
  const isFileTreeMode = props.mode === "files";
  const [isFileListVisible, setIsFileListVisible] = useState(false);
  const [fileFilter, setFileFilter] = useState("");
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
  const [fileSearchResults, setFileSearchResults] = useState<string[] | null>(
    null,
  );
  const [gitStatus, setGitStatus] = useState<SessionGitStatusResponse | null>(
    null,
  );
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
  useDismissMenu(sortMenuRef, setIsSortMenuOpen);
  useEffect(
    () =>
      subscribeCodexRuntimeEvents((event) => {
        if (
          !event ||
          (event.type === "workspace_files_changed" &&
            event.projectPath ===
              (fileTreeNodesData?.projectPath ?? props.workspacePath))
        ) {
          if (isFileTreeMode) onRefreshFiles();
        }
      }),
    [
      isFileTreeMode,
      fileTreeNodesData?.projectPath,
      props.workspacePath,
      onRefreshFiles,
    ],
  );
  useEffect(() => {
    setIsFileListVisible(false);
  }, [fileLinkOpenVersion]);
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
    if (!isFileTreeMode) return;
    let current = true;
    const request = props.threadId
      ? getSessionGitStatus(props.threadId, false, false)
      : props.workflowKey
        ? getWorkflowProjectGitStatus(props.workflowKey, false, false)
        : Promise.resolve(null);
    void request.then(
      (status) => {
        if (current) setGitStatus(status);
      },
      () => {
        if (current) setGitStatus(null);
      },
    );
    return () => {
      current = false;
    };
  }, [isFileTreeMode, props.threadId, props.workflowKey, fileTreeNodesData]);
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
    setIsFileListVisible(false);
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
  if (!isFileTreeMode) return null;
  return (
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
                !window.confirm("Discard unsaved changes and reload this file?")
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
      ) : props.loading && !fileTreeNodesData ? (
        <EmptyState text="Loading files…" />
      ) : error && !fileTreeNodesData ? (
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
  );
}

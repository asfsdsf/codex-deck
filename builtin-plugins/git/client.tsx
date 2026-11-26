import { useState, useRef, useCallback, useEffect } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileDiff,
  GitBranch,
  MoreHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import type {
  SessionDiffFile,
  SessionDiffResponse,
  SessionGitStatusResponse,
  SessionGitActionRequest,
} from "@codex-deck/api";
import {
  applySessionGitAction,
  applyWorkflowProjectGitAction,
  getSessionDiff,
  getWorkflowProjectDiff,
  getSessionGitStatus,
  getWorkflowProjectGitStatus,
} from "../../web/api";
import { subscribeCodexRuntimeEvents } from "../../web/codex-runtime-events";
import { RightPaneIcon } from "../../web/components/deepseek/right-pane-icons";
import GitHistory from "../../web/components/git-history";
import { PatchTextRenderer } from "../../web/components/patch-text-renderer";
import EmptyState from "../right-pane/empty-state";
import { useDismissMenu } from "../right-pane/use-dismiss-menu";
import type { RightPaneToolProps } from "../right-pane/types";
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
export default function GitView(props: RightPaneToolProps) {
  const {
    sessionId,
    diffData,
    fileTreeNodesData,
    selectedFilePath,
    onSelectFilePath,
  } = props;
  const isGitMode = props.mode === "git";
  const [isGitSessionView, setIsGitSessionView] = useState(false);
  const [isGitChangesExpanded, setIsGitChangesExpanded] = useState(true);
  const [isGitSectionExpanded, setIsGitSectionExpanded] = useState(true);
  const [isGraphExpanded, setIsGraphExpanded] = useState(true);
  const [gitBranchFilter, setGitBranchFilter] = useState("all");
  const [gitActionsOpen, setGitActionsOpen] = useState(false);
  const gitMenuRef = useRef<HTMLDivElement>(null);
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
  useDismissMenu(gitMenuRef, setGitActionsOpen);
  useEffect(
    () =>
      subscribeCodexRuntimeEvents((event) => {
        if (
          isGitMode &&
          (!event ||
            (event.type === "workspace_files_changed" &&
              event.projectPath === props.workspacePath))
        )
          setGitRefreshVersion((value) => value + 1);
      }),
    [isGitMode, props.workspacePath],
  );
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
    if (!isGitMode) return;
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
    const diffRequest = props.threadId
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
  const displayDiffFiles =
    (isGitSessionView ? gitSessionDiff : (gitWorkingDiff ?? diffData))?.files ??
    [];
  if (!isGitMode) return null;
  return (
    <>
      <div className="right-pane__subtabs" role="tablist" aria-label="Git view">
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
                    change.indexStatus !== " " && change.indexStatus !== "?",
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
                    disabled={gitActionLoading || !gitStatus?.changes.length}
                    onClick={() => {
                      setGitActionsOpen(false);
                      void runGitAction({
                        action: "stage",
                        paths:
                          gitStatus?.changes.map((change) => change.path) ?? [],
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
                                change.indexStatus.trim() && !change.untracked,
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
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
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
              onClick={() => setIsGitChangesExpanded((expanded) => !expanded)}
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
                  paths: gitStatus?.changes.map((change) => change.path) ?? [],
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
                    change.indexStatus !== " " && change.indexStatus !== "?";
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
                          <span className="right-pane__tree-name">{path}</span>
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
                  onChange={(event) => setGitBranchFilter(event.target.value)}
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
                ? gitStatus.ahead + " ahead · " + gitStatus.behind + " behind"
                : "No upstream"}
            </span>
          </div>
        </div>
      )}
    </>
  );
}

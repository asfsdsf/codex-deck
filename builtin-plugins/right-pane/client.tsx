import { useEffect, useRef, useState } from "react";
import { GripVertical } from "lucide-react";
import {
  getSessionFileContent,
  getWorkflowProjectFileContent,
} from "../../web/api";
import type { SessionFileContentResponse } from "@codex-deck/api";
import RightPaneTab from "../../web/components/right-pane-tab";
import { FileTypeIcon } from "../../web/components/deepseek/FileTypeIcon";
import { RightPaneIcon } from "../../web/components/deepseek/right-pane-icons";
import DeckPluginRuntime from "../../web/components/deck-plugin-runtime";
import RightPaneGuide, { ToolIcon } from "./guide";
import EmptyState from "./empty-state";
import { toolViews } from "./tool-views";
import type { RightPaneProps as DiffPaneProps, RightPaneMode } from "./types";
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
    mode,
    sessionId,
    selectedFilePath,
    onSelectFilePath,
    onChangeMode,
    onToggleCollapsed,
    fileLinkOpenVersion,
    entries,
  } = props;
  const isFileTreeMode = mode === "files";
  const isFullscreen = props.fullscreen;
  const [isSelectedFilePreviewOpen, setIsSelectedFilePreviewOpen] = useState(
    () => selectedFilePath !== null,
  );
  const [openTabs, setOpenTabs] = useState<PaneTabKey[]>(() => [mode]);
  const entryForTab = (key: string) =>
    entries.find(
      (entry) => entry.key === (key.startsWith("file:") ? "files" : key),
    );
  useEffect(() => {
    setOpenTabs((current) =>
      current.filter(
        (key) =>
          key === "home" ||
          entries.some(
            (entry) => entry.key === (key.startsWith("file:") ? "files" : key),
          ),
      ),
    );
    if (mode !== "home" && !entries.some((entry) => entry.key === mode))
      onChangeMode("home");
  }, [entries, mode, onChangeMode]);
  useEffect(() => {
    setOpenTabs((current) =>
      current.includes(mode) ? current : [...current, mode],
    );
  }, [mode]);
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
  }, [selectedFilePath, fileLinkOpenVersion]);
  const activeTabKey: PaneTabKey =
    isFileTreeMode && isSelectedFilePreviewOpen && selectedFilePath
      ? `file:${selectedFilePath}`
      : mode;
  const currentTabs = [
    ...new Set([
      ...openTabs.filter((key) => key === "home" || entryForTab(key)),
      activeTabKey,
    ]),
  ];
  function activateTab(key: PaneTabKey) {
    if (key.startsWith("file:")) {
      onChangeMode("files");
      onSelectFilePath(key.slice(5));
      setIsSelectedFilePreviewOpen(true);
    } else {
      setIsSelectedFilePreviewOpen(false);
      onChangeMode(key as RightPaneMode);
    }
  }
  const entry = entryForTab(mode);
  const Tool = entry?.builtin ? toolViews[entry.key] : undefined;
  const toolProps = {
    ...props,
    previewOpen: isSelectedFilePreviewOpen,
    setPreviewOpen: setIsSelectedFilePreviewOpen,
  };
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
                : (entries.find((entry) => entry.key === tab)?.view.title ??
                  tab);
            const icon = filePath ? (
              <FileTypeIcon path={filePath} size={16} />
            ) : tab === "home" ? (
              <RightPaneIcon name="start" className="right-pane__tab-icon" />
            ) : (
              <ToolIcon mode={tab} size={16} />
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
                    ? props.onEmptyPane
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
      {mode === "home" || !entry ? (
        <RightPaneGuide
          entries={entries}
          onBrowse={props.onBrowsePlugins}
          onCreate={props.onCreatePlugin}
          onOpen={(nextMode) => {
            setOpenTabs((current) => [
              ...current.filter((tab) => tab !== "home"),
              ...(current.includes(nextMode) ? [] : [nextMode]),
            ]);
            setIsSelectedFilePreviewOpen(false);
            onChangeMode(nextMode);
          }}
        />
      ) : !entry.builtin ? (
        <DeckPluginRuntime
          key={`${props.homeId}:${entry.key}`}
          embedded
          fillPane
          pluginId={entry.pluginId}
          viewId={entry.view.id}
          homeId={props.homeId}
          context={{
            threadId: props.threadId,
            cwd: props.workspacePath ?? null,
          }}
          onClose={() => onChangeMode("home")}
        />
      ) : !sessionId ? (
        <EmptyState text="Select a session to view this pane." />
      ) : Tool && mode !== "files" && mode !== "git" ? (
        <Tool {...toolProps} />
      ) : null}
      {sessionId &&
        ["files", "git"].map((key) => {
          const RetainedTool = toolViews[key];
          return RetainedTool &&
            entries.some((entry) => entry.key === key) &&
            currentTabs.some(
              (tab) =>
                tab === key || (key === "files" && tab.startsWith("file:")),
            ) ? (
            <RetainedTool key={key} {...toolProps} />
          ) : null;
        })}
    </section>
  );
}
/** A split pane has its own file selection and page, rather than changing its neighbour. */
function SecondaryPane(props: PaneContentProps) {
  const [mode, setMode] = useState<RightPaneMode>("home");
  const onModeChange = props.onSecondaryModeChange;
  useEffect(() => {
    onModeChange?.(mode);
    return () => onModeChange?.(null);
  }, [mode, onModeChange]);
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
      fileLinkOpenVersion={0}
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
    onEmptyPane: split ? () => setSplit(false) : undefined,
  };
  return (
    <aside
      aria-label="Right pane"
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

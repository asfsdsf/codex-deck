import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { LoaderCircle } from "lucide-react";
import type {
  SessionFileTreeNodesResponse,
  SessionGitChange,
} from "@codex-deck/api";
import {
  getSessionFileTreeNodes,
  getWorkflowProjectFileTreeNodes,
} from "../api";
import { FileTypeIcon } from "./deepseek/FileTypeIcon";

type TreeNode = SessionFileTreeNodesResponse["nodes"][number];
export type FileSort = "name" | "type";
export interface FileTreeCache {
  scopeKey: string;
  expanded: string[];
  directories: Record<string, SessionFileTreeNodesResponse>;
}

export default function WorkspaceFileTree({
  data,
  scopeKey,
  threadId,
  workflowKey,
  selectedPath,
  searchResults,
  sort,
  foldersFirst,
  onSelectFile,
  onLoadMore,
  loadingMore,
  changes = [],
  cache,
}: {
  data: SessionFileTreeNodesResponse | null;
  scopeKey: string;
  threadId: string | null;
  workflowKey?: string | null;
  selectedPath: string | null;
  searchResults: string[] | null;
  sort: FileSort;
  foldersFirst: boolean;
  onSelectFile: (path: string) => void;
  onLoadMore: () => void;
  loadingMore: boolean;
  changes?: SessionGitChange[];
  cache: MutableRefObject<FileTreeCache | null>;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(
    () =>
      new Set(
        cache.current?.scopeKey === scopeKey ? cache.current.expanded : [""],
      ),
  );
  const [directories, setDirectories] = useState<
    Record<string, SessionFileTreeNodesResponse>
  >(() =>
    cache.current?.scopeKey === scopeKey ? cache.current.directories : {},
  );
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    if (cache.current?.scopeKey !== scopeKey) {
      setExpanded(new Set([""]));
      setDirectories({});
    }
    setErrors({});
    setPending(new Set());
    return () => {
      generation.current++;
    };
  }, [scopeKey, data?.projectPath]);
  useEffect(() => {
    cache.current = { scopeKey, expanded: [...expanded], directories };
  }, [scopeKey, expanded, directories, cache]);
  const previousData = useRef(data);
  useEffect(() => {
    if (!data || previousData.current === data) return;
    previousData.current = data;
    generation.current++;
    setPending(new Set());
    for (const path of expanded)
      if (path) void loadDirectory(path, false, true);
  }, [data]);

  async function loadDirectory(path: string, append = false, force = false) {
    if (pending.has(path) && !force) return;
    const epoch = generation.current;
    setPending((state) => new Set(state).add(path));
    try {
      const cursor = append ? (directories[path]?.nextCursor ?? 0) : 0;
      const result = threadId
        ? await getSessionFileTreeNodes(threadId, path, cursor, 600)
        : workflowKey
          ? await getWorkflowProjectFileTreeNodes(
              workflowKey,
              path,
              cursor,
              600,
            )
          : null;
      if (!result || epoch !== generation.current) return;
      if (result.unavailableReason) throw new Error(result.unavailableReason);
      setDirectories((state) => ({
        ...state,
        [path]: {
          ...result,
          nodes: append
            ? [...(state[path]?.nodes ?? []), ...result.nodes]
            : result.nodes,
        },
      }));
      setErrors((state) => ({ ...state, [path]: "" }));
    } catch (error) {
      if (epoch === generation.current)
        setErrors((state) => ({ ...state, [path]: String(error) }));
    } finally {
      if (epoch === generation.current)
        setPending((state) => {
          const next = new Set(state);
          next.delete(path);
          return next;
        });
    }
  }

  function toggle(path: string) {
    if (!expanded.has(path) && !directories[path] && path !== "")
      void loadDirectory(path);
    setExpanded((state) => {
      const next = new Set(state);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }
  function sorted(nodes: TreeNode[]) {
    return nodes
      .filter((node) => node.name !== ".DS_Store")
      .sort((a, b) => {
        if (foldersFirst && a.isDirectory !== b.isDirectory)
          return a.isDirectory ? -1 : 1;
        if (sort === "type") {
          const ext = (node: TreeNode) =>
            node.isDirectory
              ? ""
              : (node.name.split(".").slice(1).at(-1) ?? "");
          const order = ext(a).localeCompare(ext(b));
          if (order) return order;
        }
        return a.name.localeCompare(b.name, undefined, {
          numeric: true,
          sensitivity: "base",
        });
      });
  }
  function rows(nodes: TreeNode[], depth: number) {
    return (
      <ul role="group" className="right-pane__tree-level">
        {sorted(nodes).map((node) => (
          <li key={node.path} role="none">
            <button
              type="button"
              role="treeitem"
              aria-level={depth + 1}
              aria-expanded={
                node.isDirectory ? expanded.has(node.path) : undefined
              }
              aria-selected={
                !node.isDirectory ? selectedPath === node.path : undefined
              }
              className="right-pane__tree-row"
              data-directory={node.isDirectory}
              data-hidden={node.name.startsWith(".")}
              data-git-tone={
                node.isDirectory
                  ? changes.some((change) =>
                      change.path.startsWith(node.path + "/"),
                    )
                    ? "directory"
                    : undefined
                  : changes.some((change) => change.path === node.path)
                    ? "modified"
                    : undefined
              }
              style={{ paddingLeft: 8 + depth * 18 }}
              title={node.path}
              onClick={() =>
                node.isDirectory ? toggle(node.path) : onSelectFile(node.path)
              }
            >
              <FileTypeIcon
                {...(node.isDirectory
                  ? { kind: "folder" as const }
                  : { path: node.path })}
                size={14}
              />
              <span className="right-pane__tree-name">
                {searchResults ? node.path : node.name}
              </span>
              {pending.has(node.path) ? (
                <LoaderCircle className="animate-spin" />
              ) : null}
            </button>
            {node.isDirectory && expanded.has(node.path) ? (
              <>
                {errors[node.path] ? (
                  <button
                    className="right-pane__tree-error"
                    type="button"
                    onClick={() => void loadDirectory(node.path)}
                  >
                    {errors[node.path]} · Retry
                  </button>
                ) : null}
                {directories[node.path]
                  ? rows(directories[node.path].nodes, depth + 1)
                  : null}
                {directories[node.path]?.nextCursor != null ? (
                  <button
                    type="button"
                    className="right-pane__tree-more"
                    onClick={() => void loadDirectory(node.path, true)}
                  >
                    Load more
                  </button>
                ) : null}
              </>
            ) : null}
          </li>
        ))}
      </ul>
    );
  }
  const rootLabel =
    data?.projectPath?.split(/[\\/]/).filter(Boolean).at(-1) ?? "Workspace";
  return (
    <div className="right-pane__tree" role="tree" aria-label="Workspace files">
      {searchResults ? (
        rows(
          searchResults.map((path) => ({
            path,
            name: path.split("/").at(-1) ?? path,
            isDirectory: false,
          })),
          0,
        )
      ) : (
        <>
          <button
            type="button"
            role="treeitem"
            aria-level={1}
            aria-expanded={expanded.has("")}
            className="right-pane__tree-row right-pane__tree-root"
            data-changed={changes.length > 0}
            title={data?.projectPath ?? rootLabel}
            onClick={() => toggle("")}
          >
            <FileTypeIcon kind="folder" size={14} />
            <span className="right-pane__tree-name">{rootLabel}</span>
          </button>
          {expanded.has("") ? rows(data?.nodes ?? [], 1) : null}
          {data?.nextCursor != null ? (
            <button
              className="right-pane__tree-more"
              type="button"
              disabled={loadingMore}
              onClick={onLoadMore}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

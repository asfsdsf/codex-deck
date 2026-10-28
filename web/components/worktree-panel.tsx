import { useCallback, useState } from "react";
import type {
  CodexWorktreeEntry,
  CodexWorktreeMode,
  CodexWorktreeStartResult,
} from "@codex-deck/api";
import {
  getCodexWorktrees,
  removeCodexWorktree,
  startCodexWorktree,
} from "../api";
import { useNativeSnapshot } from "../hooks/use-native-snapshot";

function updatedAgo(updatedAt: number | null): string {
  if (!updatedAt) return "unknown";
  const seconds = Math.max(
    0,
    Math.floor(Date.now() / 1000) -
      (updatedAt > 1e12 ? Math.floor(updatedAt / 1000) : updatedAt),
  );
  if (seconds < 60) return "just now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

const MENU: Array<{
  mode: CodexWorktreeMode | "browse";
  label: string;
  description: string;
}> = [
  {
    mode: "fork",
    label: "Continue current conversation",
    description: "Preserve this conversation in the new checkout",
  },
  {
    mode: "new",
    label: "Start new conversation",
    description: "Open a fresh conversation in the new checkout",
  },
  {
    mode: "browse",
    label: "Browse worktrees",
    description: "Resume an owner thread or copy a working directory",
  },
];

const itemClass =
  "block w-full rounded-lg border border-zinc-700 bg-zinc-950/40 p-3 text-left hover:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60";

function WorktreeBrowser({
  threadId,
  cwd,
  onResume,
  onBack,
}: {
  threadId: string;
  cwd: string | null;
  onResume: (threadId: string) => void;
  onBack: () => void;
}) {
  const load = useCallback(
    () => getCodexWorktrees(threadId, cwd),
    [threadId, cwd],
  );
  const { data, loading, error, refresh } = useNativeSnapshot(
    "worktrees",
    null,
    load,
  );
  const [selected, setSelected] = useState<CodexWorktreeEntry | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const title = (entry: CodexWorktreeEntry) =>
    entry.owner.status === "resumable" && entry.owner.title
      ? entry.owner.title
      : entry.cwd;
  const describe = (entry: CodexWorktreeEntry) =>
    entry.owner.status === "resumable"
      ? `updated ${updatedAgo(entry.owner.updatedAt)} · ${entry.cwd}`
      : `${entry.owner.status === "none" ? "No attached thread" : "Owner thread unavailable"} · ${entry.cwd}`;
  const copy = async (entry: CodexWorktreeEntry) => {
    try {
      await navigator.clipboard.writeText(entry.cwd);
      setMessage("Copied worktree working directory.");
    } catch {
      setMessage("Copy failed; select the path shown above instead.");
    }
  };
  const remove = async (entry: CodexWorktreeEntry) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await removeCodexWorktree(threadId, entry.root, cwd);
      setMessage(result.message);
      setSelected(null);
      refresh();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  if (selected) {
    return (
      <div className="space-y-3 text-sm">
        <div>
          <h3 className="break-words font-semibold text-zinc-100">
            {selected.owner.status === "resumable" && selected.owner.title
              ? `Worktree: ${selected.owner.title}`
              : "Worktree"}
          </h3>
          <p className="select-all break-all text-xs text-zinc-400">
            {selected.cwd}
          </p>
          <p className="mt-1 break-all text-[11px] text-zinc-500">
            {selected.branch ? `${selected.branch} · ` : ""}
            {selected.headSha.slice(0, 12)}
          </p>
        </div>
        {confirmDelete ? (
          <section
            role="alertdialog"
            aria-label="Delete this worktree?"
            className="space-y-2 rounded-lg border border-red-500/50 bg-red-950/30 p-3"
          >
            <h4 className="font-semibold text-zinc-100">
              Delete this worktree?
            </h4>
            <p className="break-all text-xs text-zinc-400">{selected.root}</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="min-h-9 rounded border border-zinc-700 px-3 py-1"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void remove(selected)}
                title="Keeps thread history; may disrupt other sessions"
                className="min-h-9 rounded bg-red-600 px-3 py-1 text-white disabled:opacity-50"
              >
                {busy ? "Deleting…" : "Delete worktree"}
              </button>
            </div>
            <p className="text-xs text-zinc-400">
              Keeps thread history; may disrupt other sessions
            </p>
          </section>
        ) : (
          <div className="space-y-2">
            {selected.owner.status === "resumable" &&
              selected.ownerThreadId && (
                <button
                  type="button"
                  className={itemClass}
                  onClick={() => onResume(selected.ownerThreadId!)}
                >
                  Resume owner thread
                </button>
              )}
            <button
              type="button"
              className={itemClass}
              onClick={() => void copy(selected)}
            >
              Copy working directory
            </button>
            <button
              type="button"
              className={itemClass}
              disabled={selected.isCurrent}
              onClick={() => setConfirmDelete(true)}
            >
              Delete worktree
              {selected.isCurrent && (
                <span className="mt-1 block text-xs text-amber-300">
                  Switch to another checkout before deleting this one
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                setSelected(null);
                setMessage("");
              }}
              className="min-h-9 rounded border border-zinc-700 px-3 py-1"
            >
              Back to worktrees
            </button>
          </div>
        )}
        {message && (
          <p role="status" className="break-words text-amber-300">
            {message}
          </p>
        )}
      </div>
    );
  }

  const needle = query.trim().toLowerCase();
  const entries = (data?.entries ?? []).filter(
    (entry) =>
      !needle || `${title(entry)} ${entry.cwd}`.toLowerCase().includes(needle),
  );
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-zinc-100">Managed worktrees</h3>
        <button
          type="button"
          onClick={onBack}
          className="min-h-9 rounded border border-zinc-700 px-3 py-1"
        >
          Back
        </button>
      </div>
      {loading && !data && <p role="status">Loading worktrees…</p>}
      {error && (
        <p role="alert" className="break-words text-red-400">
          Cannot list managed worktrees: {error}
        </p>
      )}
      {data && (
        <p className="text-zinc-400">
          {data.entries.length
            ? "Select a worktree to resume, copy its path, or delete it"
            : "No worktrees in this repository's configured pool"}
        </p>
      )}
      {data && data.entries.length > 0 && (
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search worktrees"
          aria-label="Search worktrees"
          className="min-h-9 w-full rounded border border-zinc-700 bg-zinc-950 px-2 text-zinc-100"
        />
      )}
      <ul className="space-y-2">
        {entries.map((entry) => (
          <li key={entry.root}>
            <button
              type="button"
              className={itemClass}
              onClick={() => {
                setSelected(entry);
                setMessage("");
              }}
            >
              <span className="flex flex-wrap items-center gap-2 break-all font-semibold text-zinc-100">
                {title(entry)}
                {entry.isCurrent && (
                  <span className="rounded bg-cyan-900/60 px-1.5 py-0.5 text-[11px] font-medium text-cyan-200">
                    Current
                  </span>
                )}
              </span>
              <span className="mt-1 block break-all text-xs text-zinc-400">
                {describe(entry)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {data && (
        <p className="break-all text-[11px] text-zinc-500">Pool: {data.root}</p>
      )}
      {message && (
        <p role="status" className="break-words text-amber-300">
          {message}
        </p>
      )}
    </div>
  );
}

/** Upstream `/worktree` menu for the bound conversation. */
export default function WorktreePanel({
  threadId,
  cwd,
  onStarted,
  onResume,
}: {
  threadId: string;
  cwd: string | null;
  onStarted: (result: CodexWorktreeStartResult) => void;
  onResume: (threadId: string) => void;
}) {
  const [view, setView] = useState<"menu" | "browse">("menu");
  const [creating, setCreating] = useState<CodexWorktreeMode | null>(null);
  const [error, setError] = useState("");
  const start = async (mode: CodexWorktreeMode) => {
    if (creating) return;
    setCreating(mode);
    setError("");
    try {
      onStarted(await startCodexWorktree(threadId, mode, cwd));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCreating(null);
    }
  };
  if (view === "browse")
    return (
      <WorktreeBrowser
        threadId={threadId}
        cwd={cwd}
        onResume={onResume}
        onBack={() => setView("menu")}
      />
    );
  return (
    <div className="space-y-3 text-sm">
      <p className="text-zinc-400">
        Managed worktrees are separate checkouts of this repository on the Codex
        Deck host, shared with the Codex CLI and desktop app.
      </p>
      {MENU.map((item) => (
        <button
          key={item.mode}
          type="button"
          disabled={!!creating}
          className={itemClass}
          onClick={() =>
            item.mode === "browse" ? setView("browse") : void start(item.mode)
          }
        >
          <span className="block font-semibold text-zinc-100">
            {item.label}
          </span>
          <span className="mt-1 block text-xs text-zinc-400">
            {creating === item.mode ? "Creating worktree…" : item.description}
          </span>
        </button>
      ))}
      {error && (
        <p
          role="alert"
          className="whitespace-pre-wrap break-words text-red-400"
        >
          {error}
        </p>
      )}
    </div>
  );
}

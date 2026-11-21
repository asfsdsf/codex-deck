import { useEffect, useId, useState } from "react";
import { ChevronRight, CircleAlert } from "lucide-react";
import type { CodexOperationalNotification } from "@codex-deck/api";
import { getCodexOperationalNotifications } from "../api";
import { subscribeCodexRuntimeEvents } from "../codex-runtime-events";
import "./operational-notices.css";

function merge(
  current: CodexOperationalNotification[],
  added: CodexOperationalNotification[],
) {
  const entries = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of added) {
    if (entry.method === "item/mcpToolCall/progress")
      for (const [id, old] of entries) {
        if (
          old.method === entry.method &&
          old.threadId === entry.threadId &&
          old.turnId === entry.turnId &&
          old.itemId === entry.itemId
        )
          entries.delete(id);
      }
    entries.set(entry.id, entry);
  }
  return [...entries.values()]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-256);
}
export default function OperationalNotices({
  threadId,
}: {
  threadId: string | null;
}) {
  const [notices, setNotices] = useState<CodexOperationalNotification[]>([]);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState("");
  const [collapsed, setCollapsed] = useState(true);
  const noticesId = useId();
  useEffect(() => {
    let active = true;
    // Buffer only until the snapshot settles, with the same bound as the UI.
    let updates: CodexOperationalNotification[] | null = [];
    const unsubscribe = subscribeCodexRuntimeEvents((event) => {
      if (!event) {
        setVersion((v) => v + 1);
        return;
      }
      if (
        event.type !== "operational_notification" ||
        (event.threadId && event.threadId !== threadId)
      )
        return;
      if (updates) updates = merge(updates, [event.notification]);
      setNotices((current) => merge(current, [event.notification]));
    });
    void getCodexOperationalNotifications(threadId).then(
      ({ notifications }) => {
        if (active) {
          setNotices(merge(notifications, updates ?? []));
          setError("");
          updates = null;
        }
      },
      (error) => {
        updates = null;
        if (active) setError(String(error.message || error));
      },
    );
    return () => {
      active = false;
      updates = null;
      unsubscribe();
    };
  }, [threadId, version]);
  if (!notices.length && !error) return null;
  return (
    <div
      data-conversation-chrome
      data-collapsed={collapsed}
      className="operational-notices"
    >
      <button
        type="button"
        aria-label={
          collapsed
            ? `Show Codex notices (${notices.length})`
            : "Collapse Codex notices"
        }
        title={
          collapsed
            ? `Show Codex notices (${notices.length})`
            : "Collapse Codex notices"
        }
        aria-controls={noticesId}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
        className="operational-notices-toggle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
      >
        <ChevronRight
          className="operational-notices-arrow size-4"
          aria-hidden="true"
        />
        <CircleAlert
          className="operational-notices-alert size-6"
          aria-hidden="true"
        />
      </button>
      <div
        className="operational-notices-content"
        inert={collapsed}
        aria-hidden={collapsed}
      >
        <details
          id={noticesId}
          aria-label="Codex operational notices"
          className="min-h-11 border-b border-zinc-800 py-2 pl-3 pr-12 text-xs text-zinc-300"
        >
          <summary className="cursor-pointer break-words line-clamp-2">
            Codex notices ({notices.length})
            {notices.length ? ` · ${notices.at(-1)?.summary}` : ""}
          </summary>
          <div className="mt-2 max-h-60 space-y-2 overflow-auto">
            {error && <p role="status">Could not refresh notices: {error}</p>}
            <button
              type="button"
              className="rounded border border-zinc-700 px-2 py-1"
              onClick={() => setVersion((v) => v + 1)}
            >
              Refresh notices
            </button>
            {[...notices].reverse().map((notice) => (
              <details
                key={notice.id}
                className="rounded border border-zinc-700 p-2"
              >
                <summary className="cursor-pointer whitespace-pre-wrap break-words">
                  {notice.summary}
                </summary>
                <p className="mt-1 break-all text-zinc-500">
                  {notice.method} ·{" "}
                  {notice.threadId ? "Current thread" : "All threads"} ·{" "}
                  {new Date(notice.timestamp).toLocaleTimeString()}
                </p>
                <pre className="mt-2 whitespace-pre-wrap break-words">
                  {JSON.stringify(notice.details, null, 2)}
                </pre>
              </details>
            ))}
            <p className="text-zinc-500">
              Recent notices received by this Deck process.
            </p>
          </div>
        </details>
      </div>
    </div>
  );
}

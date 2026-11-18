import { Plus, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { CodexThreadSummary, Session } from "@codex-deck/api";
import { listCodexSideThreads } from "../api";
import { useNativeSnapshot } from "../hooks/use-native-snapshot";

function sideChatLabel(
  thread: CodexThreadSummary | undefined,
  session?: Session,
) {
  const name = thread?.name || session?.display || thread?.preview;
  if (
    !name ||
    name.startsWith("Side conversation boundary.") ||
    name === "(no prompt text)"
  ) {
    return "Side chat";
  }
  return name;
}

export default function SideChatTabs({
  parentId,
  activeId,
  sessions,
  onSelect,
  onStart,
  onDelete,
}: {
  parentId: string;
  activeId: string;
  sessions: Session[];
  onSelect: (id: string, thread?: CodexThreadSummary) => void;
  onStart: () => Promise<void>;
  onDelete: (id: string, thread?: CodexThreadSummary) => void;
}) {
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [starting, setStarting] = useState(false);
  const load = useCallback(() => listCodexSideThreads(parentId), [parentId]);
  const { data, refresh } = useNativeSnapshot("side-chats", parentId, load);
  const localIds = sessions
    .map((session) => session.id)
    .sort()
    .join(",");
  useEffect(() => refresh(), [localIds, refresh]);

  const tabs = new Map(
    sessions.map((session) => [
      session.id,
      {
        id: session.id,
        label: sideChatLabel(undefined, session),
        thread: undefined as CodexThreadSummary | undefined,
      },
    ]),
  );
  for (const thread of data?.threads ?? []) {
    tabs.set(thread.threadId, {
      id: thread.threadId,
      label: sideChatLabel(
        thread,
        sessions.find((session) => session.id === thread.threadId),
      ),
      thread,
    });
  }
  const allTabs = [...tabs.values()];
  const openTabs = allTabs.filter(
    ({ id }) => id === activeId || !closed.has(id),
  );
  const closedTabs = allTabs.filter(
    ({ id }) => id !== activeId && closed.has(id),
  );
  if (!allTabs.length && activeId === parentId) return null;

  const tabClass = "min-h-8 rounded px-2 text-xs hover:bg-zinc-500/15";
  return (
    <nav
      aria-label="Side chats"
      className="flex min-w-0 shrink-0 flex-wrap items-center gap-1 border-b border-zinc-500/20 px-2 py-1 text-zinc-800 dark:text-zinc-200"
    >
      <button
        type="button"
        className={tabClass}
        aria-current={activeId === parentId ? "page" : undefined}
        onClick={() => onSelect(parentId)}
      >
        Main conversation
      </button>
      {openTabs.map(({ id, label, thread }) => (
        <div
          key={id}
          className={`inline-flex min-w-0 max-w-full items-center rounded border ${
            activeId === id
              ? "border-sky-500/50 bg-sky-500/10"
              : "border-zinc-500/25"
          }`}
        >
          <button
            type="button"
            className={`${tabClass} max-w-44 truncate`}
            title={label}
            aria-current={activeId === id ? "page" : undefined}
            onClick={() => onSelect(id, thread)}
          >
            {label}
          </button>
          <button
            type="button"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded hover:bg-zinc-500/15"
            aria-label={`Close ${label}`}
            onClick={() => {
              setClosed((current) => new Set(current).add(id));
              if (activeId === id) onSelect(parentId);
            }}
          >
            <X size={14} />
          </button>
        </div>
      ))}
      {closedTabs.length > 0 && (
        <select
          aria-label="Reopen side chat"
          className="max-w-44 truncate rounded border border-zinc-500/25 bg-white py-1.5 pl-1.5 text-xs dark:bg-zinc-900"
          value=""
          onChange={(event) => {
            const id = event.target.value;
            setClosed((current) => {
              const next = new Set(current);
              next.delete(id);
              return next;
            });
            onSelect(id, tabs.get(id)?.thread);
          }}
        >
          <option value="" disabled>
            Reopen side chat
          </option>
          {closedTabs.map(({ id, label }) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        aria-label="New side chat"
        disabled={starting}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded hover:bg-zinc-500/15 disabled:opacity-50"
        onClick={() => {
          setStarting(true);
          void onStart().finally(() => setStarting(false));
        }}
      >
        <Plus size={15} />
      </button>
      {activeId !== parentId && (
        <button
          type="button"
          className={`${tabClass} ml-auto text-red-700 dark:text-red-300`}
          onClick={() => onDelete(activeId, tabs.get(activeId)?.thread)}
        >
          Delete side chat
        </button>
      )}
    </nav>
  );
}

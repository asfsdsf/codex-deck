import {
  useState,
  useMemo,
  memo,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { formatTime } from "../utils";

interface SessionListItem {
  id: string;
  display: string;
  projectName: string;
  timestamp: number;
  workflowRoleLabel?: string | null;
}

interface SessionListProps {
  sessions: SessionListItem[];
  selectedSession: string | null;
  onSelectSession: (sessionId: string) => void;
  onRequestDeleteSession?: (sessionId: string) => void;
  loading?: boolean;
  searchInputRef?: RefObject<HTMLInputElement | null>;
  emptyLabel?: string;
  noMatchLabel?: string;
  countLabel?: string;
  deleteButtonLabel?: string;
  searchControls?: ReactNode;
  searchPlaceholder?: string;
}

const SessionList = memo(function SessionList(props: SessionListProps) {
  const {
    sessions,
    selectedSession,
    onSelectSession,
    onRequestDeleteSession,
    loading,
    searchInputRef,
    emptyLabel = "No sessions found",
    noMatchLabel = "No sessions match",
    countLabel = "session",
    deleteButtonLabel = "Delete session",
    searchControls,
    searchPlaceholder = "Search...",
  } = props;
  const [search, setSearch] = useState("");
  const parentRef = useRef<HTMLDivElement>(null);

  const filteredSessions = useMemo(() => {
    if (!search.trim()) {
      return sessions;
    }
    const query = search.toLowerCase();
    return sessions.filter(
      (s) =>
        s.display.toLowerCase().includes(query) ||
        s.projectName.toLowerCase().includes(query),
    );
  }, [sessions, search]);

  const virtualizer = useVirtualizer({
    count: filteredSessions.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 76,
    overscan: 10,
    measureElement: (element) => element.getBoundingClientRect().height,
  });

  return (
    <div className="session-list-surface h-full overflow-hidden bg-zinc-950 flex flex-col">
      <div className="px-3 py-2 border-b border-zinc-800/60 space-y-2">
        <div className="flex min-w-0 items-center gap-2 text-zinc-500">
          {searchControls ? (
            <div className="flex shrink-0 items-center gap-2">
              {searchControls}
            </div>
          ) : null}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <svg
              className="w-4 h-4 flex-shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <input
              ref={searchInputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className="min-w-0 flex-1 bg-transparent text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="text-zinc-600 hover:text-zinc-400 transition-colors"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      <div ref={parentRef} className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <svg
              className="w-5 h-5 text-zinc-600 animate-spin"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
          </div>
        ) : filteredSessions.length === 0 ? (
          <p className="py-8 text-center text-xs text-zinc-600">
            {search ? noMatchLabel : emptyLabel}
          </p>
        ) : (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const session = filteredSessions[virtualItem.index];
              return (
                <div
                  key={session.id}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                  className={`overflow-hidden border-b border-zinc-800/40 ${
                    virtualItem.index === 0
                      ? "border-t border-t-zinc-800/40"
                      : ""
                  }`}
                >
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => onSelectSession(session.id)}
                      className={`block w-full px-3 py-3.5 ${onRequestDeleteSession ? "pr-12" : "pr-3"} text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-400/60 ${
                        selectedSession === session.id
                          ? "bg-cyan-700/30"
                          : "hover:bg-zinc-900/60"
                      }`}
                      aria-current={
                        selectedSession === session.id ? "page" : undefined
                      }
                    >
                      <div className="mb-1 flex items-center justify-between">
                        <span className="text-[10px] text-zinc-500 font-medium">
                          {session.projectName}
                        </span>
                        <span className="text-[10px] text-zinc-600">
                          {formatTime(session.timestamp)}
                        </span>
                      </div>
                      <p className="text-[12px] text-zinc-300 leading-snug line-clamp-2 break-words">
                        {session.workflowRoleLabel ? (
                          <span className="mr-1.5 inline-flex rounded border border-cyan-500/35 bg-cyan-500/10 px-1.5 py-0.5 align-middle text-[10px] font-medium tracking-[0.01em] text-cyan-200">
                            {session.workflowRoleLabel}
                          </span>
                        ) : null}
                        <span>{session.display}</span>
                      </p>
                    </button>
                    {onRequestDeleteSession && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onRequestDeleteSession(session.id);
                        }}
                        className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-md border border-zinc-800/80 bg-zinc-950/40 text-zinc-500 transition-colors hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60"
                        aria-label={`${deleteButtonLabel} ${session.id}`}
                        title={deleteButtonLabel}
                      >
                        <svg
                          className="h-4 w-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.75}
                            d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m3 0-.7 11.1A2 2 0 0115.3 20H8.7a2 2 0 01-1.99-1.9L6 7m4 4v5m4-5v5"
                          />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="px-3 py-2 border-t border-zinc-800/60">
        <div className="text-[10px] text-zinc-600 text-center">
          {sessions.length} {countLabel}
          {sessions.length !== 1 ? "s" : ""}
        </div>
      </div>
    </div>
  );
});

export default SessionList;

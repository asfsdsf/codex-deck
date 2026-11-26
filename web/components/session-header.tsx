import type { RefObject } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Moon,
  Search,
  Sun,
  X,
} from "lucide-react";
import type { Session } from "@codex-deck/api";
import type { SessionSearchStatus } from "./session-view";
import type { ResolvedTheme } from "../theme";
import { getPathBaseName } from "../path-utils";
import { formatTime } from "../utils";

export interface SessionHeaderProps {
  session: Session;
  copied: boolean;
  isMobilePhone: boolean;
  railCollapsedByDefault: boolean;
  conversationSearchOpen: boolean;
  resolvedTheme: ResolvedTheme;
  onCopySessionId: (sessionId: string) => void;
  onCopyProjectPath?: (projectPath: string) => void;
  onToggleConversationSearch: () => void;
  onToggleRailCollapsedByDefault: () => void;
  onToggleTheme: () => void;
}

interface ThemeToggleButtonProps {
  resolvedTheme: ResolvedTheme;
  onToggleTheme: () => void;
}

interface SessionSearchBarProps {
  query: string;
  status: SessionSearchStatus;
  inputRef: RefObject<HTMLInputElement | null>;
  onChangeQuery: (value: string) => void;
  onClose: () => void;
  onNavigate: (direction: "previous" | "next") => void;
}

export function ThemeToggleButton(props: ThemeToggleButtonProps) {
  const { resolvedTheme, onToggleTheme } = props;
  const switchingTo = resolvedTheme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      onClick={onToggleTheme}
      className="group relative h-8 w-8 shrink-0 rounded-lg text-zinc-400 transition-colors hover:bg-zinc-800/70 hover:text-zinc-100"
      title={`Switch to ${switchingTo} theme`}
      aria-label={`Switch to ${switchingTo} theme`}
    >
      <span className="relative mx-auto block h-4 w-4">
        <Sun
          className={`absolute inset-0 h-4 w-4 transition-all duration-200 ${
            resolvedTheme === "dark"
              ? "scale-100 rotate-0 opacity-100"
              : "scale-75 -rotate-90 opacity-0"
          }`}
        />
        <Moon
          className={`absolute inset-0 h-4 w-4 transition-all duration-200 ${
            resolvedTheme === "light"
              ? "scale-100 rotate-0 opacity-100"
              : "scale-75 rotate-90 opacity-0"
          }`}
        />
      </span>
    </button>
  );
}

export function SessionSearchBar(props: SessionSearchBarProps) {
  const { query, status, inputRef, onChangeQuery, onClose, onNavigate } = props;
  const hasMatches = status.totalMatches > 0;
  const hasQuery = query.trim().length > 0;
  const activeLabel =
    hasMatches && status.activeMatchIndex !== null
      ? `${status.activeMatchIndex + 1}/${status.totalMatches}`
      : hasQuery
        ? `0/${status.totalMatches}`
        : "0/0";

  return (
    <div className="rounded-xl border border-zinc-700/60 bg-zinc-950/45 px-3 py-2 shadow-lg shadow-black/20 backdrop-blur-md">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-zinc-700/60 bg-zinc-900/20 px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-zinc-400" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => onChangeQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onNavigate(event.shiftKey ? "previous" : "next");
                return;
              }

              if (event.key === "Escape") {
                event.preventDefault();
                inputRef.current?.blur();
                onClose();
              }
            }}
            placeholder="Search this conversation view"
            className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
            aria-label="Search conversation"
          />
          <span className="shrink-0 text-[11px] font-mono text-zinc-400">
            {activeLabel}
          </span>
        </div>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => onNavigate("previous")}
            disabled={!hasMatches}
            className="h-9 w-9 shrink-0 rounded-lg border border-zinc-700/60 bg-zinc-900/30 text-zinc-300 transition-colors hover:bg-zinc-800/55 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Previous search result"
            title="Previous search result"
          >
            <ChevronUp className="mx-auto h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => onNavigate("next")}
            disabled={!hasMatches}
            className="h-9 w-9 shrink-0 rounded-lg border border-zinc-700/60 bg-zinc-900/30 text-zinc-300 transition-colors hover:bg-zinc-800/55 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Next search result"
            title="Next search result"
          >
            <ChevronDown className="mx-auto h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="h-9 w-9 shrink-0 rounded-lg border border-zinc-700/60 bg-zinc-900/30 text-zinc-300 transition-colors hover:bg-zinc-800/55"
            aria-label="Close search"
            title="Close search"
          >
            <X className="mx-auto h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

export function SessionHeader(props: SessionHeaderProps) {
  const {
    session,
    copied,
    isMobilePhone,
    railCollapsedByDefault,
    conversationSearchOpen,
    resolvedTheme,
    onCopySessionId,
    onCopyProjectPath,
    onToggleConversationSearch,
    onToggleRailCollapsedByDefault,
    onToggleTheme,
  } = props;

  return (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        <button
          type="button"
          onClick={onToggleRailCollapsedByDefault}
          className={`h-7 shrink-0 rounded-lg px-2.5 text-[11px] font-medium transition-colors ${
            railCollapsedByDefault
              ? "bg-zinc-800 text-zinc-100 hover:bg-zinc-700/80"
              : "text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-100"
          }`}
          title={
            railCollapsedByDefault
              ? "Switch all rails to block mode"
              : "Switch all rails to collapsed text mode"
          }
        >
          {railCollapsedByDefault ? "Text Mode" : "Block Mode"}
        </button>
        <span className="min-w-0 truncate text-[14px] font-medium text-zinc-100 max-w-md">
          {session.display}
        </span>
        {session.project ? (
          <button
            type="button"
            onClick={() => onCopyProjectPath?.(session.project)}
            className="inline-flex h-6 min-w-0 max-w-[14rem] shrink items-center gap-1 rounded-md bg-zinc-800/60 px-2 text-left text-[11px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            title={`Copy project path: ${session.project}`}
            aria-label="Copy project path"
          >
            <span className="min-w-0 truncate">
              {session.projectName || getPathBaseName(session.project)}
            </span>
            <Copy aria-hidden="true" className="h-3 w-3 shrink-0" />
          </button>
        ) : (
          <span className="text-xs text-zinc-600 shrink-0">
            {session.projectName}
          </span>
        )}
        <span className="text-xs text-zinc-600 shrink-0">
          {session.timestamp ? formatTime(session.timestamp) : null}
        </span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={onToggleConversationSearch}
          className={`h-8 w-8 shrink-0 rounded-lg transition-colors cursor-pointer ${
            conversationSearchOpen
              ? "bg-zinc-800 text-zinc-100 hover:bg-zinc-700/80"
              : "text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-100"
          }`}
          title={
            conversationSearchOpen
              ? "Hide conversation search"
              : "Search this conversation"
          }
          aria-label={
            conversationSearchOpen
              ? "Hide conversation search"
              : "Search this conversation"
          }
        >
          <Search className="mx-auto h-3.5 w-3.5" />
        </button>
        <ThemeToggleButton
          resolvedTheme={resolvedTheme}
          onToggleTheme={onToggleTheme}
        />
        {session.id && (
          <button
            onClick={() => onCopySessionId(session.id)}
            className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-800/70 hover:text-zinc-100 cursor-pointer shrink-0"
            title="Copy session ID to clipboard"
            aria-label={copied ? "Copied!" : "Copy ID"}
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-green-500" />
                {!isMobilePhone && (
                  <span className="text-green-500">Copied!</span>
                )}
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                {!isMobilePhone && <span>Copy ID</span>}
              </>
            )}
          </button>
        )}
      </div>
    </>
  );
}

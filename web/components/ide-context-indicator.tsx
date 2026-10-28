import type { CodexIdeContextSummary } from "@codex-deck/api";
import { Code2, RefreshCw, X } from "lucide-react";
import { formatIdeContextSummary } from "../ide-context";

interface IdeContextIndicatorProps {
  summary: CodexIdeContextSummary | null;
  checking: boolean;
  onRefresh: () => void;
  onDisable: () => void;
}

/** Composer badge for Codex CLI `/ide`: what the next message will include. */
export function IdeContextIndicator(props: IdeContextIndicatorProps) {
  const { summary, checking, onRefresh, onDisable } = props;
  const detail = formatIdeContextSummary(summary);
  const activePath = summary?.activeFile?.path;
  return (
    <div
      className="mx-3 mt-2 flex min-w-0 items-center gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-xs text-cyan-200"
      role="status"
      aria-label="IDE context"
    >
      <Code2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="shrink-0 font-medium">IDE context</span>
      <span
        className="min-w-0 flex-1 truncate text-cyan-100/80"
        title={activePath ? `${activePath} — ${detail}` : detail}
      >
        {detail}
      </span>
      <button
        type="button"
        onClick={onRefresh}
        disabled={checking}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-cyan-200 transition-colors hover:bg-cyan-500/15 disabled:opacity-50"
        title="Refresh IDE context"
        aria-label="Refresh IDE context"
      >
        <RefreshCw
          className={`h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`}
        />
      </button>
      <button
        type="button"
        onClick={onDisable}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-cyan-200 transition-colors hover:bg-cyan-500/15"
        title="Turn off IDE context"
        aria-label="Turn off IDE context"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

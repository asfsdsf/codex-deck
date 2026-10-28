import { useRef, useState } from "react";
import type { CodexThreadRevertResult } from "@codex-deck/api";
import { revertCodexThread } from "../api";
import CenteredConfirmDialog from "./centered-confirm-dialog";

/**
 * Confirms `thread/revert` before the selected prompt's turn. Matches the
 * upstream TUI backtrack: later turns are dropped and the prompt returns to
 * the composer for editing. Workspace files are never reverted.
 */
export default function ConversationRewindDialog({
  sessionId,
  turnId,
  promptPreview,
  onCancel,
  onRewound,
}: {
  sessionId: string;
  turnId: string;
  promptPreview: string;
  onCancel: () => void;
  onRewound: (result: CodexThreadRevertResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards double submission before React re-renders the disabled button.
  const inFlight = useRef(false);

  const confirm = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      onRewound(await revertCodexThread(sessionId, turnId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <CenteredConfirmDialog
      tone="warning"
      title="Rewind the conversation to this prompt?"
      message="This removes this turn and every later turn from the conversation history, then puts this prompt back in the composer so you can edit and resend it."
    >
      <p
        className="mt-2 rounded border border-amber-700/50 bg-amber-950/40 px-2.5 py-1.5 text-xs leading-relaxed text-amber-100"
        data-rewind-files-warning
      >
        Workspace files are not reverted. Changes Codex already made to files
        stay on disk; undo them separately (for example with git) if needed.
      </p>
      {promptPreview && (
        <p className="mt-2 line-clamp-4 whitespace-pre-wrap break-words rounded border border-zinc-700/70 bg-zinc-950/40 px-2.5 py-1.5 text-[11px] text-zinc-400">
          {promptPreview}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 break-words text-xs text-rose-300">
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="h-9 rounded border border-zinc-700 bg-zinc-800/80 px-3 text-xs text-zinc-200 transition-colors hover:bg-zinc-700/80 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void confirm()}
          disabled={busy}
          className="h-9 rounded border border-amber-600/70 bg-amber-700/25 px-3 text-xs text-amber-100 transition-colors hover:bg-amber-700/35 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Rewinding..." : "Rewind"}
        </button>
      </div>
    </CenteredConfirmDialog>
  );
}

import { useEffect, useRef, useState } from "react";
import type { CodexReviewResult, CodexReviewTarget } from "@codex-deck/api";
import { parseReviewTarget } from "../../api/codex-review";
import { startCodexReview } from "../api";

export default function ReviewModal({
  threadId,
  instructions = "",
  onClose,
  onStarted,
}: {
  threadId: string;
  instructions?: string;
  onClose: () => void;
  onStarted: (result: CodexReviewResult) => void;
}) {
  const [type, setType] = useState<CodexReviewTarget["type"]>(
    instructions ? "custom" : "uncommittedChanges",
  );
  const [value, setValue] = useState(instructions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !inFlight.current) onClose();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);
  const submit = async () => {
    if (inFlight.current) return;
    try {
      const target = parseReviewTarget({
        type,
        branch: value,
        sha: value,
        instructions: value,
      });
      inFlight.current = true;
      setBusy(true);
      setError(null);
      const result = await startCodexReview(threadId, target);
      onStarted(result);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 p-4 sm:items-center"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-title"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="max-h-[90dvh] w-full max-w-lg space-y-4 overflow-auto rounded-xl border border-zinc-700 bg-zinc-900 p-4 text-zinc-100 shadow-2xl"
      >
        <h2 id="review-title" className="font-semibold">
          Start code review
        </h2>
        <label className="block space-y-1 text-sm">
          <span>Review target</span>
          <select
            autoFocus
            disabled={busy}
            value={type}
            onChange={(event) => {
              setType(event.target.value as CodexReviewTarget["type"]);
              setValue("");
            }}
            className="w-full rounded border border-zinc-700 bg-zinc-950 p-2"
          >
            <option value="uncommittedChanges">
              Working tree (staged, unstaged, and untracked)
            </option>
            <option value="baseBranch">Compare with base branch</option>
            <option value="commit">Specific commit</option>
            <option value="custom">Custom instructions</option>
          </select>
        </label>
        {type !== "uncommittedChanges" && (
          <label className="block space-y-1 text-sm">
            <span>
              {type === "baseBranch"
                ? "Base branch"
                : type === "commit"
                  ? "Commit SHA"
                  : "Review instructions"}
            </span>
            <textarea
              required
              disabled={busy}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              rows={type === "custom" ? 5 : 2}
              className="w-full rounded border border-zinc-700 bg-zinc-950 p-2"
            />
          </label>
        )}
        {error && (
          <p role="alert" className="break-words text-sm text-red-400">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded border border-zinc-700 px-3 py-2 text-sm disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            disabled={busy}
            className="rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50"
          >
            {busy ? "Starting…" : "Start review"}
          </button>
        </div>
      </form>
    </div>
  );
}

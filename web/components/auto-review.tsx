import { useCallback, useState } from "react";
import type { CodexGuardianReview } from "@codex-deck/api";
import { approveCodexAutoReviewDenial, getCodexAutoReview } from "../api";
import { useNativeSnapshot } from "../hooks/use-native-snapshot";

const STRICT_REVIEW_MESSAGE =
  "This request requires additional safety checks, some tool calls might take extra time";
const RETRY_APPROVED_MESSAGE =
  "Approval recorded for one retry of the selected auto-review denial.";
const RETRY_APPROVED_HINT =
  "The model will see the approval context; the retry still goes through auto-review.";
const NO_RATIONALE = "Auto-review did not include a rationale";

/** Upstream history wording for terminal auto-review decisions. */
export function describeAutoReviewDecision(
  review: CodexGuardianReview,
): string {
  const isCommand =
    review.action.type === "command" || review.action.type === "execve";
  const subject = isCommand
    ? `codex to run ${review.summary}`
    : review.action.type === "applyPatch"
      ? `codex to apply a patch (${review.summary})`
      : `codex: ${review.summary}`;
  switch (review.status) {
    case "inProgress":
      return review.summary;
    case "approved":
      return `Request approved for ${subject}`;
    case "denied":
      return `Request denied for ${subject}`;
    case "timedOut":
      return `Auto-review timed out for ${subject}`;
    default:
      return `Auto-review stopped for ${subject}`;
  }
}

const STATUS_STYLE: Record<CodexGuardianReview["status"], string> = {
  inProgress: "border-cyan-700/60 bg-cyan-950/20",
  approved: "border-emerald-700/50 bg-emerald-950/20",
  denied: "border-red-700/60 bg-red-950/20",
  timedOut: "border-amber-700/60 bg-amber-950/20",
  aborted: "border-zinc-700 bg-zinc-900/40",
};

function ReviewMeta({ review }: { review: CodexGuardianReview }) {
  const parts = [
    review.riskLevel ? `Risk: ${review.riskLevel}` : null,
    review.userAuthorization
      ? `User authorization: ${review.userAuthorization}`
      : null,
    review.completedAtMs
      ? `${Math.max(0, Math.round((review.completedAtMs - review.startedAtMs) / 100) / 10)}s`
      : null,
  ].filter(Boolean);
  return parts.length ? (
    <span className="block text-[11px] text-zinc-500">{parts.join(" · ")}</span>
  ) : null;
}

/**
 * Live auto-review (Guardian) progress and decisions for the conversation,
 * rendered next to pending approvals. Retained by the Deck backend so reloads
 * and other tabs see the same activity.
 */
export function AutoReviewActivity({ sessionId }: { sessionId: string }) {
  const load = useCallback(() => getCodexAutoReview(sessionId), [sessionId]);
  const { data, setData } = useNativeSnapshot("guardian", sessionId, load);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  if (!data) return null;
  const pending = data.reviews.filter(
    (review) => review.status === "inProgress",
  );
  const latestTurn = data.reviews.at(-1)?.turnId;
  const recent = data.reviews
    .filter(
      (review) =>
        review.status !== "inProgress" && review.turnId === latestTurn,
    )
    .slice(-5);
  if (!pending.length && !recent.length && !data.strictReview && !message)
    return null;
  const approve = async (review: CodexGuardianReview) => {
    if (busy) return;
    setBusy(review.reviewId);
    try {
      setData(await approveCodexAutoReviewDenial(sessionId, review.reviewId));
      setMessage(`${RETRY_APPROVED_MESSAGE} ${RETRY_APPROVED_HINT}`);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section
      aria-label="Auto-review activity"
      className="mt-4 space-y-2 text-xs text-zinc-300"
    >
      {data.strictReview && (
        <p className="rounded-lg border border-amber-700/60 bg-amber-950/20 px-3 py-2 text-amber-200">
          {STRICT_REVIEW_MESSAGE}
        </p>
      )}
      {pending.length > 0 && (
        <div
          role="status"
          className={`rounded-lg border px-3 py-2 ${STATUS_STYLE.inProgress}`}
        >
          <span className="block font-semibold text-zinc-100">
            {pending.length === 1
              ? "Reviewing approval request"
              : `Reviewing ${pending.length} approval requests`}
          </span>
          {pending.slice(0, 3).map((review) => (
            <span key={review.reviewId} className="block break-all">
              {pending.length > 1 ? "• " : ""}
              {review.summary}
            </span>
          ))}
          {pending.length > 3 && (
            <span className="block">+{pending.length - 3} more</span>
          )}
        </div>
      )}
      {recent.map((review) => (
        <div
          key={review.reviewId}
          className={`rounded-lg border px-3 py-2 ${STATUS_STYLE[review.status]}`}
        >
          <span className="block break-all font-medium text-zinc-100">
            {review.status === "denied"
              ? "✗ "
              : review.status === "approved"
                ? "✓ "
                : ""}
            {describeAutoReviewDecision(review)}
          </span>
          {review.rationale && (
            <span className="mt-0.5 block whitespace-pre-wrap break-words text-zinc-400">
              {review.rationale}
            </span>
          )}
          <ReviewMeta review={review} />
          {review.status === "denied" &&
            (review.retryApprovedAt ? (
              <span className="mt-1 block text-[11px] text-emerald-300">
                One retry approved.
              </span>
            ) : (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => void approve(review)}
                className="mt-2 min-h-8 rounded border border-zinc-600 px-2.5 py-1 text-zinc-100 hover:border-zinc-400 disabled:opacity-50"
              >
                {busy === review.reviewId ? "Approving…" : "Approve one retry"}
              </button>
            ))}
        </div>
      ))}
      {message && (
        <p role="status" className="break-words text-amber-300">
          {message}
        </p>
      )}
    </section>
  );
}

/** Upstream `/approve` picker: "Auto-review Denials". */
export function AutoReviewDenials({
  threadId,
  onApproved,
}: {
  threadId: string;
  onApproved?: (message: string) => void;
}) {
  const load = useCallback(() => getCodexAutoReview(threadId), [threadId]);
  const { data, loading, error, setData } = useNativeSnapshot(
    "guardian",
    threadId,
    load,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const approve = async (review: CodexGuardianReview) => {
    if (busy) return;
    setBusy(review.reviewId);
    setMessage("");
    try {
      setData(await approveCodexAutoReviewDenial(threadId, review.reviewId));
      setMessage(`${RETRY_APPROVED_MESSAGE} ${RETRY_APPROVED_HINT}`);
      onApproved?.(RETRY_APPROVED_MESSAGE);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };
  const needle = query.trim().toLowerCase();
  const denials = (data?.denials ?? []).filter(
    (review) =>
      !needle ||
      `${review.summary} ${review.rationale ?? ""}`
        .toLowerCase()
        .includes(needle),
  );
  return (
    <div className="space-y-3 text-sm">
      {loading && !data && <p role="status">Loading auto-review denials…</p>}
      {error && (
        <p role="alert" className="break-words text-red-400">
          {error}
        </p>
      )}
      {data && data.denials.length === 0 && (
        <div className="space-y-1">
          <p>No recent auto-review denials in this thread.</p>
          <p className="text-xs text-zinc-400">
            Denials are recorded after auto-review rejects an action.
          </p>
        </div>
      )}
      {data && data.denials.length > 0 && (
        <>
          <p className="text-zinc-400">Select a denied action to approve.</p>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search denials"
            aria-label="Search denials"
            className="min-h-9 w-full rounded border border-zinc-700 bg-zinc-950 px-2 text-zinc-100"
          />
          <ul className="space-y-2">
            {denials.map((review) => (
              <li key={review.reviewId}>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => void approve(review)}
                  className="block w-full rounded-lg border border-zinc-700 bg-zinc-950/40 p-3 text-left hover:border-zinc-500 disabled:opacity-60"
                >
                  <span className="block break-all font-mono text-xs text-zinc-100">
                    {review.summary}
                  </span>
                  <span className="mt-1 block whitespace-pre-wrap break-words text-xs text-zinc-400">
                    {review.rationale || NO_RATIONALE}
                  </span>
                  <ReviewMeta review={review} />
                  {busy === review.reviewId && (
                    <span className="mt-1 block text-xs text-cyan-300">
                      Approving…
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {message && (
        <p role="status" className="break-words text-amber-300">
          {message}
        </p>
      )}
    </div>
  );
}

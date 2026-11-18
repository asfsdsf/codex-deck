import { useCallback, useEffect, useState } from "react";
import type {
  RealtimeTranscriptEntry,
  RealtimeVoiceHistoryPage,
} from "@codex-deck/api";
import { useNativeSnapshot } from "../hooks/use-native-snapshot";
import { getVoiceHistory } from "../voice/voice-api";
import { mergeVoiceHistory } from "../voice/voice-history";

export default function VoiceHistory({
  threadId,
  live,
}: {
  threadId: string;
  live: RealtimeTranscriptEntry[];
}) {
  const load = useCallback(() => getVoiceHistory(threadId), [threadId]);
  const { data, refresh } = useNativeSnapshot("voice-history", threadId, load);
  const [pages, setPages] = useState<RealtimeVoiceHistoryPage | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const page = pages ?? data;
  const entries = mergeVoiceHistory(page?.data ?? [], live);

  const pendingSnapshot =
    data?.coverage === "pending" ? data.snapshotEnd : null;
  useEffect(() => {
    if (pendingSnapshot === null) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) refresh();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [pendingSnapshot, refresh]);

  if (
    !page ||
    page.coverage === "unsupported" ||
    (!page.data.length && !page.nextCursor && page.coverage === "ready")
  ) {
    return null;
  }

  const loadMore = async () => {
    if (!page.nextCursor || loadingMore) return;
    setError("");
    setLoadingMore(true);
    try {
      const next = await getVoiceHistory(threadId, {
        cursor: page.nextCursor,
        snapshotEnd: page.snapshotEnd,
      });
      if (next.coverage !== "ready") {
        setError(
          next.coverage === "pending"
            ? "Codex is still saving this history page. Try again shortly."
            : "This voice history snapshot is no longer available.",
        );
        return;
      }
      if (next.nextCursor === page.nextCursor) {
        throw new Error("Codex returned a repeated voice history cursor.");
      }
      setPages({ ...next, data: [...page.data, ...next.data] });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingMore(false);
    }
  };

  const newerSnapshot =
    pages &&
    data?.coverage === "ready" &&
    data.snapshotEnd !== pages.snapshotEnd;
  return (
    <details className="mx-auto mb-2 w-full max-w-4xl rounded-lg border border-zinc-500/30 bg-zinc-50 px-3 py-2 text-xs text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
      <summary className="cursor-pointer font-medium">
        Saved voice history
      </summary>
      {page.coverage === "pending" && (
        <p role="status" className="mt-2">
          Codex is saving the voice history…
        </p>
      )}
      {entries.length > 0 && (
        <ol
          aria-label="Voice history transcript"
          className="mt-2 max-h-52 space-y-2 overflow-y-auto overscroll-contain pr-1"
        >
          {entries.map((entry) => (
            <li key={entry.key} className="break-words">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-semibold">{entry.label}</span>
                {entry.at !== null && (
                  <time className="text-zinc-600 dark:text-zinc-400">
                    {new Date(entry.at).toLocaleString()}
                  </time>
                )}
              </div>
              <p className={entry.pending ? "italic" : undefined}>
                {entry.text}
              </p>
            </li>
          ))}
        </ol>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {page.nextCursor && (
          <button
            type="button"
            className="min-h-8 rounded border border-zinc-500/35 px-2 hover:bg-zinc-500/10 disabled:opacity-50"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? "Loading…" : "Load more voice history"}
          </button>
        )}
        {(newerSnapshot || error) && (
          <button
            type="button"
            className="min-h-8 rounded border border-zinc-500/35 px-2 hover:bg-zinc-500/10"
            disabled={loadingMore}
            onClick={() => {
              setPages(null);
              setError("");
              refresh();
            }}
          >
            Refresh voice history
          </button>
        )}
      </div>
      {error && (
        <p className="mt-2 text-red-700 dark:text-red-300" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}

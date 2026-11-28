import { useCallback, useEffect, useState } from "react";
import { ChevronRight, History } from "lucide-react";
import type {
  RealtimeTranscriptEntry,
  RealtimeVoiceHistoryPage,
} from "@codex-deck/api";
import { useNativeSnapshot } from "../hooks/use-native-snapshot";
import { getVoiceHistory } from "../voice/voice-api";
import { mergeVoiceHistory } from "../voice/voice-history";
import VoiceTranscript from "./voice-transcript";

const smallButton =
  "inline-flex min-h-8 items-center rounded-full border border-zinc-700 px-3 text-xs text-zinc-200 transition-colors hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60 disabled:opacity-50";

/**
 * Past voice calls for the conversation: Codex's saved realtime history,
 * merged with the last call's captions. Collapsed by default so it stays a
 * single quiet line above the composer.
 */
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
  // Older Codex builds cannot save voice history; keep the last call's
  // captions instead of losing them when the call ends.
  const unsupported = page?.coverage === "unsupported";
  const entries = mergeVoiceHistory(
    unsupported ? [] : (page?.data ?? []),
    live,
  );

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
    (entries.length === 0 &&
      (unsupported || (!page.nextCursor && page.coverage === "ready")))
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
  const spoken = entries.filter((entry) => entry.role !== "note").length;
  return (
    <details className="group mx-auto mb-2 w-full max-w-4xl rounded-2xl border border-zinc-800 bg-zinc-900/60 text-xs text-zinc-300">
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-2xl px-3 py-1.5 hover:bg-zinc-800/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform group-open:rotate-90 motion-reduce:transition-none"
        />
        <History aria-hidden="true" className="h-3.5 w-3.5 text-zinc-500" />
        <span className="font-medium text-zinc-200">Voice history</span>
        {spoken > 0 && (
          <span className="text-zinc-500">
            {spoken} {spoken === 1 ? "line" : "lines"}
          </span>
        )}
        {page.coverage === "pending" && (
          <span role="status" className="text-zinc-500">
            · saving…
          </span>
        )}
      </summary>
      <div className="border-t border-zinc-800 px-3 pb-3 pt-2">
        {unsupported && (
          <p className="mb-2 text-zinc-500">
            This Codex version does not save voice history; showing the last
            call only.
          </p>
        )}
        <VoiceTranscript
          label="Voice history transcript"
          showTimes
          lines={entries.map((entry) => ({
            key: entry.key,
            role: entry.role,
            text: entry.text,
            pending: entry.pending,
            at: entry.at,
            label: entry.label,
          }))}
        />
        {(page.nextCursor || newerSnapshot || error) && (
          <div className="mt-2 flex flex-wrap gap-2">
            {page.nextCursor && (
              <button
                type="button"
                className={smallButton}
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            )}
            {(newerSnapshot || error) && (
              <button
                type="button"
                className={smallButton}
                disabled={loadingMore}
                onClick={() => {
                  setPages(null);
                  setError("");
                  refresh();
                }}
              >
                Refresh
              </button>
            )}
          </div>
        )}
        {error && (
          <p className="mt-2 text-red-300" role="alert">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}

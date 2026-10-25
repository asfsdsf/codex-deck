import { useCallback, useEffect, useRef, useState } from "react";
import { getCodexRecap, startCodexRecap } from "../api";
import { useNativeSnapshot } from "../hooks/use-native-snapshot";
import { MarkdownRenderer } from "./markdown-renderer";

export default function ConversationRecapView({
  threadId,
}: {
  threadId: string;
}) {
  const load = useCallback(() => getCodexRecap(threadId), [threadId]);
  const { data, error, refresh } = useNativeSnapshot("recap", threadId, load);
  const started = useRef(false);
  const [starting, setStarting] = useState(true);
  const [startError, setStartError] = useState("");
  const start = useCallback(async () => {
    setStarting(true);
    setStartError("");
    try {
      await startCodexRecap(threadId);
      refresh();
    } catch (reason) {
      setStartError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setStarting(false);
    }
  }, [threadId, refresh]);
  useEffect(() => {
    if (!started.current) {
      started.current = true;
      void start();
    }
  }, [start]);
  const recap = data?.recap;
  return (
    <div className="space-y-4 text-sm">
      {(starting || recap?.status === "generating") && (
        <p role="status" className="animate-pulse text-cyan-300">
          {recap?.phase || "Preparing summary"}…
        </p>
      )}
      {(startError || error || recap?.error) && (
        <p role="alert" className="break-words text-red-400">
          {startError || error || recap?.error}
        </p>
      )}
      {recap?.summary && (
        <div className="rounded-lg border border-zinc-700 bg-zinc-950/40 p-4">
          <MarkdownRenderer content={recap.summary} />
          {recap.nextAction && (
            <div className="mt-3 border-t border-zinc-700 pt-3">
              <p className="mb-1 text-xs font-semibold text-cyan-300">
                Next action
              </p>
              <MarkdownRenderer content={recap.nextAction} />
            </div>
          )}
        </div>
      )}
      <p className="text-xs text-zinc-400">
        Generated from an excerpt of visible conversation text. Recaps remain
        available while this Deck process is running.
      </p>
      <div className="flex gap-2">
        <button
          disabled={starting || recap?.status === "generating"}
          onClick={() => void start()}
          className="rounded border border-zinc-700 px-3 py-2 disabled:opacity-50"
        >
          Generate again
        </button>
        <button
          onClick={refresh}
          className="rounded border border-zinc-700 px-3 py-2"
        >
          Refresh recap
        </button>
      </div>
    </div>
  );
}

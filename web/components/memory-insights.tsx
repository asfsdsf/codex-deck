import { useEffect, useState } from "react";
import { getCodexMemoryStatus, getCodexThreadMemory } from "../api";
import type { CodexMemoryStatus } from "@codex-deck/api";

export default function MemoryInsights({
  threadId,
}: {
  threadId: string | null;
}) {
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<CodexMemoryStatus | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [statusError, setStatusError] = useState("");
  const [summaryError, setSummaryError] = useState("");
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [loadingSummary, setLoadingSummary] = useState(true);
  useEffect(() => {
    let active = true;
    setStatus(null);
    setSummary(null);
    setStatusError("");
    setSummaryError("");
    setLoadingStatus(true);
    setLoadingSummary(!!threadId);
    void getCodexMemoryStatus()
      .then(
        (value) => {
          if (active) setStatus(value);
        },
        (error) => {
          if (active) setStatusError(String(error.message || error));
        },
      )
      .finally(() => {
        if (active) setLoadingStatus(false);
      });
    if (threadId)
      void getCodexThreadMemory(threadId)
        .then(
          (value) => {
            if (active) setSummary(value.summary);
          },
          (error) => {
            if (active) setSummaryError(String(error.message || error));
          },
        )
        .finally(() => {
          if (active) setLoadingSummary(false);
        });
    return () => {
      active = false;
    };
  }, [threadId, version]);
  return (
    <section
      className="space-y-2 rounded border border-zinc-700 p-3 text-xs text-zinc-300"
      aria-label="Memory insights"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium text-zinc-100">
          Memory readiness and summary
        </h3>
        <button
          type="button"
          onClick={() => setVersion((v) => v + 1)}
          disabled={loadingStatus || loadingSummary}
          className="rounded border border-zinc-700 px-2 py-1 disabled:opacity-50"
        >
          Refresh
        </button>
      </div>
      <p role="status">
        {loadingStatus
          ? "Loading readiness…"
          : statusError ||
            (status
              ? `Memory v2: ${status.v2Ready ? "ready" : "not ready"} · ${status.v2ConsolidatedThreads} consolidated threads`
              : "Readiness unavailable")}
      </p>
      <h4 className="font-medium text-zinc-100">Current thread summary</h4>
      <div className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded border border-zinc-800 p-2">
        {!threadId
          ? "Select a conversation to read its memory summary."
          : loadingSummary
            ? "Loading summary…"
            : summaryError ||
              summary ||
              "No summary available. Memory use may be disabled or the selected summary is missing."}
      </div>
    </section>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiffGuideSummary, DiffGuideStartResponse } from "@codex-deck/api";
import { getDiffGuide, retryDiffGuide, translateText } from "../api";
import { prepareDiffGuideHtml } from "../diff-guide-html";
import {
  createDiffGuideFrameToken,
  createDiffGuideTranslationBridge,
} from "../diff-guide-translation";

export function DiffGuideViewer({
  guide,
  onClose,
  onStarted,
  onGuideChange,
  theme,
}: {
  guide: DiffGuideSummary;
  onClose: () => void;
  onStarted: (response: DiffGuideStartResponse) => void;
  onGuideChange: (guide: DiffGuideSummary) => void;
  theme: "light" | "dark";
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [revision, setRevision] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const requestGeneration = useRef(0);
  const frameDocument = useMemo(() => {
    if (!html) return null;
    const token = createDiffGuideFrameToken();
    return { token, html: prepareDiffGuideHtml(html, theme, token) };
  }, [html, theme, revision, guide.sessionId]);

  useEffect(() => {
    if (!frameDocument || error) return;
    const bridge = createDiffGuideTranslationBridge({
      getFrameWindow: () => iframeRef.current?.contentWindow ?? null,
      token: frameDocument.token,
      translate: translateText,
    });
    window.addEventListener("message", bridge.onMessage);
    return () => {
      window.removeEventListener("message", bridge.onMessage);
      bridge.dispose();
    };
  }, [frameDocument, error]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      requestGeneration.current += 1;
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKey);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  useEffect(() => {
    const generation = ++requestGeneration.current;
    setError(null);
    setLoading(true);
    getDiffGuide(guide.sessionId)
      .then((response) => {
        if (requestGeneration.current !== generation) return;
        onGuideChange(response.guide);
        setHtml(response.html);
        if (response.guide.status === "ready" && !response.html)
          setError("The guide is no longer available. Refresh to check again.");
      })
      .catch((cause) => {
        if (requestGeneration.current === generation)
          setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (requestGeneration.current === generation) setLoading(false);
      });
    return () => {
      requestGeneration.current += 1;
    };
  }, [guide.sessionId, guide.status, revision, onGuideChange]);

  const retry = useCallback(async () => {
    setRetrying(true);
    setError(null);
    const generation = requestGeneration.current;
    try {
      const response = await retryDiffGuide(guide.sessionId);
      if (requestGeneration.current === generation) onStarted(response);
    } catch (cause) {
      if (requestGeneration.current === generation)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRetrying(false);
    }
  }, [guide.sessionId, onStarted]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Diff guide"
      className="fixed inset-0 z-50 flex flex-col bg-zinc-950 text-zinc-100"
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2 sm:px-5">
        <div className="min-w-0">
          <span className="font-semibold">Diff guide</span>
          <span className="ml-2 text-xs text-zinc-500">
            {guide.status === "ready"
              ? "Ready"
              : guide.status === "generating"
                ? "Generating…"
                : "Guide pending"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setRevision((value) => value + 1)}
            disabled={loading}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm disabled:opacity-50"
          >
            Refresh
          </button>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100"
          >
            Close
          </button>
        </div>
      </div>
      {html && !error ? (
        <iframe
          ref={iframeRef}
          title="Generated Git diff guide"
          srcDoc={frameDocument?.html}
          sandbox="allow-scripts allow-downloads"
          referrerPolicy="no-referrer"
          style={{ colorScheme: theme }}
          className="min-h-0 w-full flex-1 border-0"
        />
      ) : (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="max-w-lg space-y-4 text-center" role="status">
            <p>
              {loading
                ? "Loading guide…"
                : (error ??
                  guide.error ??
                  (guide.status === "generating" || guide.status === "starting"
                    ? "The guide is being generated. You can close this viewer and continue reading the conversation."
                    : "No completed guide is available. Check the conversation for details."))}
            </p>
            {!loading &&
              ["failed", "unavailable", "starting"].includes(guide.status) && (
                <button
                  type="button"
                  disabled={retrying}
                  onClick={() => {
                    void retry();
                  }}
                  className="rounded-lg border border-violet-400/50 bg-violet-600/20 px-4 py-2 text-sm text-violet-100 disabled:opacity-50"
                >
                  {retrying ? "Retrying…" : "Retry generation in this session"}
                </button>
              )}
            <p className="text-xs text-zinc-500">
              The embedded guide supports comment export. Browser comment
              storage may be unavailable in this isolated viewer.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export function DiffSkillInstallDialog({
  projectRoot,
  onChoice,
}: {
  projectRoot: string;
  onChoice: (choice: "local" | "global" | "cancel") => void;
}) {
  const localRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    localRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onChoice("cancel");
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
      previousFocus?.focus();
    };
  }, [onChoice]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 p-4 sm:items-center"
      onClick={(event) => {
        if (event.target === event.currentTarget) onChoice("cancel");
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Install codex-deck-diff skill"
        className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-4 text-zinc-100 shadow-2xl"
      >
        <h2 className="text-sm font-semibold">
          Install codex-deck-diff skill?
        </h2>
        <p className="mt-2 text-sm text-zinc-400">
          Choose where to install the skill before creating the diff session.
        </p>
        <p className="mt-3 break-all rounded border border-dashed border-zinc-800 bg-zinc-950/40 p-2 font-mono text-xs text-zinc-400">
          {projectRoot}
        </p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() => onChoice("cancel")}
            className="rounded border border-zinc-700 px-3 py-2 text-xs"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onChoice("global")}
            className="rounded border border-violet-400 px-3 py-2 text-xs text-violet-200"
          >
            Install globally
          </button>
          <button
            ref={localRef}
            type="button"
            onClick={() => onChoice("local")}
            className="rounded border border-violet-400/50 bg-violet-600/20 px-3 py-2 text-xs text-violet-100"
          >
            Install locally
          </button>
        </div>
      </div>
    </div>
  );
}

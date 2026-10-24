import { useEffect, useRef, useState } from "react";
import { Check, Copy, Languages, Loader2 } from "lucide-react";
import type { ConversationMessage } from "@codex-deck/api";
import { getConversation } from "../api";
import { getCompletedTaskAnswer } from "../task-answer";
import { useBlockTranslation } from "../hooks/use-block-translation";
import { SafeMarkdown } from "./safe-markdown";

async function copyText(load: () => Promise<string>): Promise<void> {
  // Safari requires the clipboard call during the click, before the history request resolves.
  const text = load();
  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": text.then(
            (value) => new Blob([value], { type: "text/plain" }),
          ),
        }),
      ]);
      return;
    } catch {
      // Fall through for browsers without ClipboardItem promises or clipboard permissions.
    }
  }
  const value = await text;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const focused = document.activeElement;
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    try {
      textarea.focus({ preventScroll: true });
      textarea.select();
      textarea.setSelectionRange(0, value.length);
      if (!document.execCommand("copy"))
        throw new Error(
          "Could not copy the text. Try again in a browser with clipboard access.",
        );
    } finally {
      textarea.remove();
      if (focused instanceof HTMLElement)
        focused.focus({ preventScroll: true });
    }
  }
}

type AnswerAction = "copy" | "translate" | "copy-translation";

export function TaskAnswerActions({
  sessionId,
  completion,
  onFilePathLinkClick,
}: {
  sessionId: string;
  completion: ConversationMessage;
  onFilePathLinkClick?: (href: string) => boolean;
}) {
  const [answerSource, setAnswerSource] = useState<string | null>(null);
  const [loading, setLoading] = useState<AnswerAction | null>(null);
  const [copied, setCopied] = useState<AnswerAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [translateOnLoad, setTranslateOnLoad] = useState(false);
  const translation = useBlockTranslation(answerSource, "en", "zh");
  const mounted = useRef(true);
  const copiedTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(copiedTimeout.current);
    };
  }, []);
  useEffect(() => {
    if (translateOnLoad && answerSource) {
      setTranslateOnLoad(false);
      translation.toggle();
    }
  }, [translateOnLoad, answerSource, translation.toggle]);

  const loadAnswer = async () => {
    const answer = getCompletedTaskAnswer(
      await getConversation(sessionId),
      completion,
    );
    if (!answer)
      throw new Error("No assistant answer is available for this task.");
    if (mounted.current) setAnswerSource(answer);
    return answer;
  };

  const run = async (action: AnswerAction) => {
    if (loading) return;
    if (
      action === "copy-translation" &&
      (translation.status !== "ready" || !translation.translated)
    )
      return;
    setLoading(action);
    setError(null);
    try {
      if (action !== "translate") {
        const translated = translation.translated;
        await copyText(
          action === "copy-translation" ? async () => translated! : loadAnswer,
        );
        if (mounted.current) {
          setCopied(action);
          clearTimeout(copiedTimeout.current);
          copiedTimeout.current = setTimeout(() => setCopied(null), 1500);
        }
      } else {
        await loadAnswer();
        if (mounted.current) {
          setTranslateOnLoad(true);
        }
      }
    } catch (error) {
      if (mounted.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mounted.current) setLoading(null);
    }
  };
  const busy = loading !== null || translation.status === "loading";
  const buttonClass =
    "inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-zinc-800/60 hover:text-zinc-200 disabled:cursor-wait disabled:opacity-60";

  return (
    <div className="mt-2 min-w-0" data-task-answer-actions>
      <div
        className="flex flex-wrap items-center gap-1"
        role="group"
        aria-label="Completed task actions"
      >
        <button
          type="button"
          className={buttonClass}
          title="Copy the entire answer"
          aria-label="Copy entire answer"
          disabled={busy}
          onClick={() => void run("copy")}
        >
          {loading === "copy" ? (
            <Loader2 size={14} className="animate-spin" />
          ) : copied === "copy" ? (
            <Check size={14} />
          ) : (
            <Copy size={14} />
          )}
          {copied === "copy" ? "Copied!" : "Copy answer"}
        </button>
        <button
          type="button"
          className={buttonClass}
          title={
            translation.showing
              ? "Hide answer translation"
              : "Translate the entire answer to Chinese"
          }
          aria-label={
            translation.showing
              ? "Hide answer translation"
              : "Translate entire answer to Chinese"
          }
          aria-pressed={translation.showing}
          disabled={busy}
          onClick={() => {
            if (answerSource) translation.toggle();
            else void run("translate");
          }}
        >
          {loading === "translate" || translation.status === "loading" ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Languages size={14} />
          )}
          {translation.showing ? "Hide translation" : "Translate all"}
        </button>
        {translation.showing && translation.translated !== null && (
          <button
            type="button"
            className={buttonClass}
            title="Copy the entire translated answer"
            aria-label="Copy entire translation"
            disabled={busy || translation.status !== "ready"}
            onClick={() => void run("copy-translation")}
          >
            {loading === "copy-translation" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : copied === "copy-translation" ? (
              <Check size={14} />
            ) : (
              <Copy size={14} />
            )}
            {copied === "copy-translation" ? "Copied!" : "Copy translation"}
          </button>
        )}
      </div>
      {(error || translation.error) && (
        <p role="alert" className="mt-1 text-xs text-rose-400">
          {error ?? `Translation failed: ${translation.error}`}
        </p>
      )}
      {translation.showing && translation.translated !== null && (
        <div className="mt-2 overflow-hidden rounded-xl border border-zinc-800/60 bg-zinc-900/40 p-4 text-zinc-100">
          <div
            role="region"
            aria-label="Translated answer"
            aria-busy={translation.status === "loading"}
          >
            <SafeMarkdown
              content={translation.translated}
              onFilePathLinkClick={onFilePathLinkClick}
            />
          </div>
        </div>
      )}
    </div>
  );
}

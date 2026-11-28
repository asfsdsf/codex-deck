import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";

export interface VoiceTranscriptLine {
  key: string;
  /** "note" is a non-speech event such as "Started a turn". */
  role: "user" | "assistant" | "note";
  text: string;
  pending: boolean;
  at: number | null;
  /** Shown instead of the default speaker for notes. */
  label?: string;
}

const STICK_THRESHOLD_PX = 24;
const TIME_GAP_MS = 10 * 60_000;

function timeLabel(at: number, previous: number | null): string | null {
  if (previous !== null && at - previous < TIME_GAP_MS) return null;
  const date = new Date(at);
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

/**
 * Voice captions styled like the conversation: what you said in a bubble,
 * Codex's replies as plain text. It follows new lines only while you are at
 * the bottom, so scrolling back to read is not interrupted.
 */
export default function VoiceTranscript({
  lines,
  label,
  emptyHint,
  showTimes = false,
  className = "",
}: {
  lines: readonly VoiceTranscriptLine[];
  label: string;
  emptyHint?: string;
  showTimes?: boolean;
  className?: string;
}) {
  const list = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const [behind, setBehind] = useState(false);
  const last = lines.at(-1);

  useLayoutEffect(() => {
    const node = list.current;
    if (!node) return;
    if (stick.current) node.scrollTop = node.scrollHeight;
    else setBehind(true);
  }, [lines.length, last?.text, last?.pending]);

  useEffect(() => {
    if (lines.length === 0) {
      stick.current = true;
      setBehind(false);
    }
  }, [lines.length]);

  if (lines.length === 0)
    return emptyHint ? (
      <p className={`px-1 py-3 text-center text-xs text-zinc-500 ${className}`}>
        {emptyHint}
      </p>
    ) : null;

  let previousAt: number | null = null;
  return (
    <div className={`relative ${className}`}>
      <ol
        ref={list}
        aria-label={label}
        tabIndex={0}
        onScroll={(event) => {
          const node = event.currentTarget;
          const atBottom =
            node.scrollHeight - node.scrollTop - node.clientHeight <
            STICK_THRESHOLD_PX;
          stick.current = atBottom;
          if (atBottom) setBehind(false);
        }}
        className="max-h-[min(14rem,30dvh)] space-y-2 overflow-y-auto overscroll-contain px-1 py-1 text-sm leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50 rounded-lg"
      >
        {lines.map((line) => {
          const stamp =
            showTimes && line.at !== null
              ? timeLabel(line.at, previousAt)
              : null;
          if (line.at !== null) previousAt = line.at;
          return (
            <li key={line.key} className="break-words">
              {stamp && (
                <div className="mb-2 mt-1 flex items-center gap-2 text-[11px] text-zinc-500">
                  <span className="h-px flex-1 bg-zinc-800" />
                  <time dateTime={new Date(line.at ?? 0).toISOString()}>
                    {stamp}
                  </time>
                  <span className="h-px flex-1 bg-zinc-800" />
                </div>
              )}
              {line.role === "user" ? (
                <div className="flex justify-end pl-8">
                  <p
                    className={`message-user-bubble max-w-full whitespace-pre-wrap rounded-2xl rounded-br-md px-3 py-1.5 text-zinc-100 ${
                      line.pending ? "opacity-75" : ""
                    }`}
                  >
                    <span className="sr-only">You said: </span>
                    {line.text}
                    {line.pending && <Caret tone="user" />}
                  </p>
                </div>
              ) : line.role === "assistant" ? (
                <p
                  className={`whitespace-pre-wrap pr-8 text-zinc-200 ${
                    line.pending ? "opacity-75" : ""
                  }`}
                >
                  <span className="sr-only">Codex said: </span>
                  {line.text}
                  {line.pending && <Caret tone="codex" />}
                </p>
              ) : (
                <p className="flex flex-wrap items-baseline gap-x-1.5 text-xs text-zinc-500">
                  <span className="font-medium text-zinc-400">
                    {line.label ?? "Note"}
                  </span>
                  <span className="min-w-0 whitespace-pre-wrap">
                    {line.text}
                  </span>
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {behind && (
        <button
          type="button"
          onClick={() => {
            const node = list.current;
            if (node) node.scrollTop = node.scrollHeight;
            stick.current = true;
            setBehind(false);
          }}
          className="absolute bottom-2 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[11px] text-zinc-200 shadow-lg hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60"
        >
          <ArrowDown className="h-3 w-3" />
          Latest
        </button>
      )}
    </div>
  );
}

function Caret({ tone }: { tone: "user" | "codex" }) {
  return (
    <span
      aria-hidden="true"
      className={`ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] animate-pulse rounded-full motion-reduce:animate-none ${
        tone === "user" ? "bg-cyan-400" : "bg-fuchsia-400"
      }`}
    />
  );
}

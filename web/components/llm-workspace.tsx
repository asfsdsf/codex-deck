import { useEffect, useRef, useState, type ReactNode } from "react";
import { MessageSquarePlus, Send, Settings } from "lucide-react";
import type {
  CodexHomeDescriptor,
  LlmConversation,
  LlmConversationSummary,
} from "@codex-deck/api";
import { requestJson } from "../transport";
import { createWakeablePollingSubscription } from "../transport/shared";
import { useEventSource } from "../hooks/use-event-source";
import { usePageVisibility } from "../hooks/use-page-visibility";
import { MarkdownRenderer } from "./markdown-renderer";
import { newIdempotencyKey } from "../codex-projects-view";

function newConversationId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // getRandomValues also works when a phone opens the app over LAN HTTP.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export function LlmWorkspace({
  provider,
  selector,
  onSettings,
  remote,
}: {
  provider: CodexHomeDescriptor;
  selector: ReactNode;
  onSettings: () => void;
  remote: boolean;
}) {
  const base =
    "/api/codex-homes/providers/" +
    encodeURIComponent(provider.id.slice("llm:".length));
  const [list, setList] = useState<LlmConversationSummary[]>([]);
  const [id, setId] = useState(newConversationId);
  const [isDraft, setIsDraft] = useState(true);
  const [conversation, setConversation] = useState<LlmConversation | null>(
    null,
  );
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0);
  const visible = usePageVisibility();
  const wake = useRef<() => void>(() => {});
  const request = useRef<{
    message: string;
    count: number;
    requestId: string;
  } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const latestTurn = conversation?.turns.at(-1);
  const pending = latestTurn && !latestTurn.assistant && !latestTurn.error;

  useEffect(() => {
    if (!visible) return;
    let active = true;
    const subscription = createWakeablePollingSubscription(
      async () => {
        try {
          const [items, detail] = await Promise.all([
            requestJson<LlmConversationSummary[]>(base + "/conversations"),
            isDraft
              ? Promise.resolve(null)
              : requestJson<LlmConversation>(base + "/conversations/" + id),
          ]);
          if (active) {
            setList(items);
            setConversation(detail);
            setLoadError("");
          }
        } catch (e) {
          if (active) setLoadError(e instanceof Error ? e.message : String(e));
        }
      },
      remote ? 3000 : 60_000,
    );
    wake.current = subscription.wake;
    return () => {
      active = false;
      subscription.unsubscribe();
      wake.current = () => {};
    };
  }, [base, id, isDraft, visible, remote, retry]);

  useEventSource(base + "/stream", {
    enabled: !remote && visible,
    events: [{ eventName: "change", onMessage: () => wake.current() }],
  });
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [id, latestTurn?.requestId, latestTurn?.assistant, latestTurn?.error]);

  function select(nextId: string, draft: boolean) {
    if (sending || nextId === id) return;
    setId(nextId);
    setIsDraft(draft);
    setConversation(null);
    setMessage("");
    setSendError("");
    setLoadError("");
    request.current = null;
  }

  const canSend =
    !sending && !pending && (isDraft || !!conversation) && !!message.trim();
  async function send() {
    if (!canSend) return;
    const count = conversation?.turns.length ?? 0;
    if (
      request.current?.message !== message ||
      request.current.count !== count
    ) {
      request.current = { message, count, requestId: newIdempotencyKey() };
    }
    setSending(true);
    setSendError("");
    const turn = {
      user: message,
      startedAt: Date.now(),
      requestId: request.current.requestId,
    };
    try {
      await requestJson(base + "/conversations/" + id, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          expectedTurns: count,
          requestId: turn.requestId,
        }),
      });
      setConversation({
        id,
        updatedAt: turn.startedAt,
        title: conversation?.title ?? message.slice(0, 100),
        turns: [...(conversation?.turns ?? []), turn],
      });
      setIsDraft(false);
      setMessage("");
      request.current = null;
      setRetry((n) => n + 1);
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
      wake.current();
    } finally {
      setSending(false);
    }
  }
  return (
    <div className="app-viewport-height app-viewport-safe-area flex flex-col bg-zinc-950 text-zinc-100 md:flex-row">
      <aside className="flex shrink-0 flex-col gap-3 border-b border-zinc-800 bg-zinc-900/60 p-3 md:w-64 md:border-b-0 md:border-r">
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">{selector}</div>
          <button
            aria-label="Codex Deck settings"
            title="Codex Deck settings"
            onClick={onSettings}
            className="h-8 w-8 rounded text-zinc-400 hover:bg-zinc-800"
          >
            <Settings className="mx-auto h-4 w-4" />
          </button>
        </div>
        <button
          onClick={() => select(newConversationId(), true)}
          disabled={sending}
          className="flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800"
        >
          <MessageSquarePlus size={16} />
          New conversation
        </button>
        <nav
          aria-label="Conversation history"
          className="hidden min-h-0 space-y-1 overflow-y-auto md:block"
        >
          {list.map((item) => (
            <button
              key={item.id}
              aria-current={item.id === id}
              disabled={sending}
              onClick={() => select(item.id, false)}
              className="block w-full truncate rounded px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-800 aria-[current=true]:bg-zinc-800"
            >
              {item.title}
            </button>
          ))}
        </nav>
        <select
          aria-label="Conversation history"
          className="rounded border border-zinc-700 bg-zinc-950 p-2 text-sm md:hidden"
          disabled={sending}
          value={isDraft ? "" : id}
          onChange={(e) => select(e.target.value, false)}
        >
          <option value="" disabled>
            Conversation history
          </option>
          {list.map((item) => (
            <option value={item.id} key={item.id}>
              {item.title}
            </option>
          ))}
        </select>
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="border-b border-zinc-800 px-5 py-3">
          <h1 className="truncate text-sm font-semibold">
            {conversation?.title ??
              (isDraft ? "New conversation" : "Conversation")}
          </h1>
          <p className="truncate text-xs text-zinc-400">
            {provider.label} / {provider.model}
          </p>
          {!isDraft && (
            <p
              className="select-all break-all font-mono text-xs text-zinc-500"
              title="Conversation ID"
            >
              {id}
            </p>
          )}
        </header>
        {loadError && (
          <p role="alert" className="px-4 py-2 text-sm text-red-400">
            {loadError}{" "}
            <button
              className="underline"
              onClick={() => setRetry((n) => n + 1)}
            >
              Retry
            </button>
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="mx-auto max-w-3xl space-y-6">
            {!isDraft && !conversation && !loadError && (
              <p className="text-sm text-zinc-400">Loading conversation...</p>
            )}
            {conversation?.turns.map((turn) => (
              <div key={turn.requestId} className="space-y-3">
                <div className="ml-auto w-fit max-w-[90%] whitespace-pre-wrap break-words rounded-lg bg-zinc-800 px-4 py-2.5 text-sm">
                  {turn.user}
                </div>
                {turn.assistant ? (
                  <MarkdownRenderer
                    content={turn.assistant}
                    className="break-words text-sm"
                  />
                ) : turn.error ? (
                  <p role="alert" className="text-sm text-red-400">
                    {turn.error}
                  </p>
                ) : (
                  <p role="status" className="text-sm text-zinc-400">
                    Waiting for reply...
                  </p>
                )}
              </div>
            ))}
            <div ref={bottom} />
          </div>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="mx-auto w-full max-w-3xl p-3"
        >
          {sendError && (
            <p role="alert" className="mb-2 text-sm text-red-400">
              {sendError}
            </p>
          )}
          <div className="flex items-end gap-2 rounded-lg border border-zinc-700 bg-zinc-900 p-2 focus-within:border-cyan-500">
            <textarea
              aria-label="Message"
              placeholder="Message"
              rows={2}
              value={message}
              disabled={sending || (!isDraft && !conversation)}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void send();
                }
              }}
              className="min-w-0 flex-1 resize-none bg-transparent p-1 text-sm outline-none"
            />
            <button
              aria-label="Send message"
              title="Send message"
              disabled={!canSend}
              className="rounded bg-cyan-600 p-2 text-white disabled:bg-zinc-800 disabled:text-zinc-500"
            >
              <Send size={16} />
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}

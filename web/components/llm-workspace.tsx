import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { MessageSquarePlus } from "lucide-react";
import LeftPane from "../../builtin-plugins/left-pane/client";
import type {
  CodexHomeDescriptor,
  ConversationMessage,
  LlmConversation,
  LlmConversationSummary,
} from "@codex-deck/api";
import { requestJson } from "../transport";
import { createWakeablePollingSubscription } from "../transport/shared";
import { useEventSource } from "../hooks/use-event-source";
import { usePageVisibility } from "../hooks/use-page-visibility";
import SessionView, {
  type SessionSearchStatus,
  type SessionViewHandle,
} from "./session-view";
import {
  SessionHeader,
  SessionSearchBar,
  type SessionHeaderProps,
} from "./session-header";
import ConversationCanvas from "./conversation-canvas";
import MessageComposer from "./message-composer";
import CodexValuePicker from "./codex-value-picker";
import { REASONING_EFFORTS } from "../reasoning-efforts";
import {
  DEFAULT_CONVERSATION_HOVER_SETTINGS,
  resolveConversationHoverSettings,
} from "../../api/conversation-hover-settings";
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
  leftPane,
  remote,
  header,
  composerSize,
  expandRightPane,
  viewMode,
  onViewModeChange,
}: {
  provider: CodexHomeDescriptor;
  leftPane: Pick<
    ComponentProps<typeof LeftPane>,
    | "collapsed"
    | "width"
    | "isMobilePhone"
    | "onExpand"
    | "onCollapse"
    | "onResize"
    | "onSettings"
    | "onBrowse"
    | "connection"
    | "home"
    | "machine"
  >;
  remote: boolean;
  expandRightPane: ReactNode;
  viewMode: boolean;
  onViewModeChange: (enabled: boolean) => void;
  header: Pick<
    SessionHeaderProps,
    | "copied"
    | "onCopySessionId"
    | "isMobilePhone"
    | "resolvedTheme"
    | "onToggleTheme"
    | "railCollapsedByDefault"
    | "onToggleRailCollapsedByDefault"
  >;
  composerSize: Pick<
    ComponentProps<typeof MessageComposer>,
    "messageBoxHeight" | "onResizeMessageBoxStart"
  >;
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
  const [effort, setEffort] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<SessionSearchStatus>({
    totalMatches: 0,
    activeMatchIndex: null,
  });
  const view = useRef<SessionViewHandle>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [hoverSettings, setHoverSettings] = useState(
    DEFAULT_CONVERSATION_HOVER_SETTINGS,
  );
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
    effort: string;
  } | null>(null);
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
    events: [
      { eventName: "change", onMessage: () => wake.current() },
      {
        eventName: "hoverSettings",
        onMessage: (event) =>
          setHoverSettings(
            resolveConversationHoverSettings(JSON.parse(event.data)),
          ),
      },
    ],
  });
  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
  }, [searchOpen]);
  const messages = useMemo(() => {
    const result: ConversationMessage[] = [];
    for (const turn of conversation?.turns ?? []) {
      const metadata = {
        sessionId: id,
        turnId: turn.requestId,
        timestamp: new Date(turn.startedAt).toISOString(),
      };
      result.push({
        ...metadata,
        type: "user",
        uuid: turn.requestId + "-user",
        message: { role: "user", content: turn.user },
      });
      if (turn.thinking)
        result.push({
          ...metadata,
          type: "reasoning",
          uuid: turn.requestId + "-thinking",
          message: {
            role: "assistant",
            model: turn.model,
            reasoningEffort: turn.reasoningEffort,
            content: [{ type: "thinking", thinking: turn.thinking }],
          },
        });
      if (turn.assistant || turn.error)
        result.push({
          ...metadata,
          type: turn.error ? "system_error" : "assistant",
          uuid: turn.requestId + "-reply",
          message: {
            role: "assistant",
            content: turn.assistant ?? turn.error!,
            phase: "final_answer",
            model: turn.model,
            reasoningEffort: turn.reasoningEffort,
          },
        });
    }
    return result;
  }, [conversation, id]);

  function select(nextId: string, draft: boolean) {
    if (sending || nextId === id) return;
    if (leftPane.isMobilePhone) leftPane.onCollapse();
    setId(nextId);
    setIsDraft(draft);
    setConversation(null);
    setEffort("");
    setSearchOpen(false);
    setQuery("");
    onViewModeChange(false);
    setSendError("");
    setLoadError("");
    request.current = null;
  }

  async function send({ text: message }: { text: string }) {
    if (sending || pending || (!isDraft && !conversation) || !message.trim())
      return false;
    const count = conversation?.turns.length ?? 0;
    if (
      request.current?.message !== message ||
      request.current.count !== count ||
      request.current.effort !== effort
    ) {
      request.current = {
        message,
        count,
        effort,
        requestId: newIdempotencyKey(),
      };
    }
    setSending(true);
    setSendError("");
    const turn = {
      user: message,
      startedAt: Date.now(),
      requestId: request.current.requestId,
      model: provider.model,
      reasoningEffort: effort || provider.reasoningEffort,
    };
    try {
      await requestJson(base + "/conversations/" + id, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          expectedTurns: count,
          requestId: turn.requestId,
          reasoningEffort: effort || undefined,
        }),
      });
      setConversation({
        id,
        updatedAt: turn.startedAt,
        title: conversation?.title ?? message.slice(0, 100),
        turns: [...(conversation?.turns ?? []), turn],
      });
      setIsDraft(false);
      request.current = null;
      setRetry((n) => n + 1);
      return true;
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
      wake.current();
      return false;
    } finally {
      setSending(false);
    }
  }
  const { collapsed } = leftPane;
  const newConversation = (
    <button
      type="button"
      aria-label="New conversation"
      title="New conversation"
      onClick={() => select(newConversationId(), true)}
      disabled={sending}
      className={
        collapsed
          ? "flex h-9 w-full items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-800"
          : "flex w-full items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800"
      }
    >
      <MessageSquarePlus size={16} />
      {!collapsed && "New conversation"}
    </button>
  );
  return (
    <>
      <LeftPane
        {...leftPane}
        controls={newConversation}
        railActions={newConversation}
      >
        <nav
          aria-label="Conversation history"
          className="h-full space-y-1 overflow-y-auto px-2"
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
      </LeftPane>
      <main className="pane-main flex min-h-0 min-w-0 flex-1 flex-col">
        <header
          data-conversation-chrome
          className="pane-header-center border-b border-zinc-800 px-3 py-2"
        >
          <select
            aria-label="Conversation history"
            className="mb-1 w-full rounded border border-zinc-700 bg-zinc-950 p-1 text-sm md:hidden"
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
          <div className="flex min-w-0 items-center gap-2">
            <SessionHeader
              {...header}
              session={{
                id: isDraft ? "" : id,
                display:
                  conversation?.title ??
                  (isDraft ? "New conversation" : "Conversation"),
                project: "",
                projectName: "",
                timestamp: conversation?.updatedAt ?? 0,
              }}
              conversationSearchOpen={searchOpen}
              onToggleConversationSearch={() => setSearchOpen((open) => !open)}
            />
            {expandRightPane}
          </div>
          {!isDraft && (
            <p
              title="Conversation ID"
              className="mt-1 select-all break-all font-mono text-[11px] text-zinc-500"
            >
              {id}
            </p>
          )}
          {searchOpen && (
            <SessionSearchBar
              query={query}
              status={status}
              inputRef={searchInput}
              onChangeQuery={setQuery}
              onClose={() => setSearchOpen(false)}
              onNavigate={(direction) =>
                view.current?.navigateConversationSearchMatch(direction)
              }
            />
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
        <ConversationCanvas
          viewMode={viewMode}
          onViewModeChange={onViewModeChange}
        >
          {!isDraft && !conversation ? (
            <p role="status" className="p-4 text-sm text-zinc-400">
              Loading conversation...
            </p>
          ) : (
            !isDraft && (
              <SessionView
                key={id}
                ref={view}
                sessionId={id}
                suppliedMessages={messages}
                suppliedHoverSettings={remote ? undefined : hoverSettings}
                railCollapsedByDefault={header.railCollapsedByDefault}
                conversationSearchOpen={searchOpen}
                conversationSearchQuery={query}
                onConversationSearchStatusChange={setStatus}
              />
            )
          )}
        </ConversationCanvas>
        <div className="composer-shell shrink-0 bg-zinc-950 px-3 pb-3 pt-1 md:px-5">
          {pending && (
            <p
              role="status"
              className="mx-auto mb-1 max-w-4xl text-sm text-zinc-400"
            >
              Waiting for reply...
            </p>
          )}
          {sendError && (
            <p
              role="alert"
              className="mx-auto mb-1 max-w-4xl text-sm text-red-400"
            >
              {sendError}
            </p>
          )}
          <div className="composer-card relative mx-auto w-full max-w-4xl">
            <MessageComposer
              key={id}
              {...composerSize}
              textOnly
              sessionId={null}
              draftResetKey={id}
              history={conversation?.turns.map((turn) => turn.user) ?? []}
              slashCommands={[]}
              inputDisabled={!isDraft && !conversation}
              isSendingLocked={!!pending || (!isDraft && !conversation)}
              isGeneratingForSelectedSession={false}
              sendingMessage={sending}
              stoppingTurn={false}
              onSendMessage={send}
            />
            <div className="composer-toolbar flex min-w-0 items-center gap-2 pl-3 pb-2 pt-1 pr-[calc(var(--composer-actions-width,6.5rem)+1rem)]">
              <span
                className="min-w-0 truncate text-xs text-zinc-400"
                title={provider.model}
              >
                {provider.model}
              </span>
              <CodexValuePicker
                value={effort}
                defaultLabel={
                  provider.reasoningEffort
                    ? "Effort: " + provider.reasoningEffort + " (default)"
                    : "Reasoning effort"
                }
                options={REASONING_EFFORTS.map((value) => ({
                  value,
                  label: value,
                }))}
                inputAriaLabel="Reasoning effort"
                inputPlaceholder="Search or enter a reasoning mode"
                onChange={setEffort}
                disabled={sending}
              />
            </div>
          </div>
        </div>
      </main>
    </>
  );
}

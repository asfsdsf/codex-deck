import type { ConversationMessage, TerminalSummary } from "@codex-deck/api";
import { Bot, Link2, MessageSquarePlus } from "lucide-react";
import LatestSessionMessageBox from "./latest-session-message-box";
import type { ResolvedTheme } from "../theme";

interface AiTerminalPanelProps {
  terminal: TerminalSummary;
  boundSessionId: string | null;
  latestSessionMessage: ConversationMessage | null;
  latestSessionMessageLoading: boolean;
  chatBusy?: boolean;
  resolvedTheme: ResolvedTheme;
  onChatInSession: () => void;
  onOpenSession: (sessionId: string) => void;
  onFilePathLinkClick?: (href: string) => boolean;
}

export default function AiTerminalPanel(props: AiTerminalPanelProps) {
  const {
    terminal,
    boundSessionId,
    latestSessionMessage,
    latestSessionMessageLoading,
    chatBusy,
    resolvedTheme,
    onChatInSession,
    onOpenSession,
    onFilePathLinkClick,
  } = props;

  const panelClassName =
    resolvedTheme === "light"
      ? "border-zinc-200 bg-white/95 text-zinc-900"
      : "border-zinc-800/70 bg-zinc-950/92 text-zinc-100";

  const emptyText = latestSessionMessageLoading
    ? "Loading latest message..."
    : boundSessionId
      ? "No assistant reply yet for this terminal chat session."
      : "This terminal is not bound to a chat session yet. Use Chat in session or Init to create one.";

  return (
    <aside
      className={`flex min-h-0 flex-col border-t lg:border-l lg:border-t-0 ${panelClassName} ${
        resolvedTheme === "light" ? "" : "shadow-2xl shadow-black/20"
      } w-full lg:w-[25rem]`}
    >
      <div className="flex items-center justify-between gap-3 border-b border-inherit px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Bot className="h-4 w-4 shrink-0" />
            <span className="truncate">AI Terminal</span>
          </div>
          <div className="mt-1 text-xs text-zinc-500">Terminal {terminal.terminalId}</div>
        </div>
        <button
          type="button"
          onClick={onChatInSession}
          disabled={chatBusy === true}
          className="inline-flex h-8 items-center gap-1.5 rounded border border-cyan-600/70 bg-cyan-600/20 px-2.5 text-[11px] text-cyan-100 transition-colors hover:bg-cyan-600/30 disabled:cursor-not-allowed disabled:opacity-55"
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
          Chat in session
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="rounded-2xl border border-zinc-800/60 bg-zinc-900/30 p-3 text-xs text-zinc-400">
          <div className="truncate">{terminal.cwd}</div>
          <div className="mt-1 truncate">
            {terminal.shell} {boundSessionId ? `· bound to ${boundSessionId}` : "· unbound"}
          </div>
        </div>

        <div className="mt-4 min-h-0">
          <LatestSessionMessageBox
            message={latestSessionMessage}
            sessionId={boundSessionId}
            emptyText={emptyText}
            onFilePathLinkClick={onFilePathLinkClick}
            containerClassName="flex min-h-0 flex-col space-y-1 text-xs text-zinc-400"
            viewportClassName="min-h-[220px]"
          />
        </div>
      </div>

      {boundSessionId ? (
        <div className="border-t border-inherit px-4 py-3">
          <button
            type="button"
            onClick={() => onOpenSession(boundSessionId)}
            className="inline-flex h-8 items-center gap-1.5 rounded border border-zinc-700 bg-zinc-900/60 px-2.5 text-xs text-zinc-200 transition-colors hover:bg-zinc-800/70"
          >
            <Link2 className="h-3.5 w-3.5" />
            Open bound session
          </button>
        </div>
      ) : null}
    </aside>
  );
}

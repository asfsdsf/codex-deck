import type { ConversationMessage } from "@codex-deck/api";
import MessageBlock from "./message-block";

interface LatestSessionMessageBoxProps {
  message: ConversationMessage | null;
  sessionId?: string | null;
  emptyText: string;
  onFilePathLinkClick?: (href: string) => boolean;
  containerClassName?: string;
  viewportClassName?: string;
}

export default function LatestSessionMessageBox(
  props: LatestSessionMessageBoxProps,
) {
  return (
    <div
      className={
        props.containerClassName ??
        "flex min-h-0 flex-1 flex-col space-y-1 text-xs text-zinc-400"
      }
    >
      <div className="flex items-center justify-between gap-3">
        <span>Latest session message</span>
        {props.sessionId ? (
          <span className="text-[11px] text-zinc-500">
            Session {props.sessionId}
          </span>
        ) : null}
      </div>
      <div
        className={`min-h-0 flex-1 overflow-y-auto rounded border border-zinc-800 bg-zinc-950/70 px-3 py-2 ${
          props.viewportClassName ?? ""
        }`}
      >
        {props.message ? (
          <MessageBlock
            message={props.message}
            onFilePathLinkClick={props.onFilePathLinkClick}
          />
        ) : (
          <div className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-zinc-200">
            {props.emptyText}
          </div>
        )}
      </div>
    </div>
  );
}

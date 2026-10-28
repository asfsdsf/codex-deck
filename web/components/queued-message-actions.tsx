import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { PendingUserMessage } from "../pending-user-messages";
import { sharedQueueCaption } from "../shared-message-queue";

const buttonClass =
  "inline-flex min-h-7 items-center rounded border px-2.5 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-60";
const neutralButtonClass = `${buttonClass} border-zinc-500/50 bg-zinc-800/40 text-zinc-300 hover:bg-zinc-700/50`;

/**
 * Actions under a queued message. Shared (server) queue items can also be
 * edited and reordered; local fallback items support send now and cancel.
 */
export default function QueuedMessageActions(props: {
  message: PendingUserMessage;
  turnActive: boolean;
  sendingNow: boolean;
  busy: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onSendNow?: (() => void) | null;
  onCancel?: (() => void) | null;
  onEdit?: ((text: string) => Promise<boolean>) | null;
  onMove?: ((direction: "up" | "down") => void) | null;
}) {
  const { message, turnActive, sendingNow, busy } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const [saving, setSaving] = useState(false);
  const shared = !!message.sharedQueueId;

  if (editing && props.onEdit) {
    const save = async () => {
      if (!draft.trim()) return;
      setSaving(true);
      try {
        if (await props.onEdit!(draft)) setEditing(false);
      } finally {
        setSaving(false);
      }
    };
    return (
      <div className="mt-1 flex flex-col gap-2">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setEditing(false);
            } else if (
              event.key === "Enter" &&
              (event.metaKey || event.ctrlKey)
            ) {
              event.preventDefault();
              void save();
            }
          }}
          rows={3}
          aria-label="Edit queued message"
          className="w-full resize-y rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
        />
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() => setEditing(false)}
            disabled={saving}
            className={neutralButtonClass}
          >
            Discard
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !draft.trim()}
            className={`${buttonClass} border-indigo-400/40 bg-indigo-600/20 text-indigo-200 hover:bg-indigo-600/35`}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-1 flex flex-wrap items-center justify-end gap-2">
      <span className="text-[11px] text-zinc-500">
        {shared
          ? sharedQueueCaption({ turnActive })
          : "Queued — sends when the current turn finishes"}
      </span>
      {props.onMove ? (
        <span className="inline-flex gap-1">
          <button
            type="button"
            disabled={busy || !props.canMoveUp}
            onClick={() => props.onMove?.("up")}
            title="Move up in the queue"
            aria-label="Move up in the queue"
            className={`${neutralButtonClass} px-1.5`}
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={busy || !props.canMoveDown}
            onClick={() => props.onMove?.("down")}
            title="Move down in the queue"
            aria-label="Move down in the queue"
            className={`${neutralButtonClass} px-1.5`}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </span>
      ) : null}
      {props.onEdit ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setDraft(message.text);
            setEditing(true);
          }}
          className={neutralButtonClass}
        >
          Edit
        </button>
      ) : null}
      {props.onSendNow ? (
        <button
          type="button"
          disabled={busy}
          onClick={props.onSendNow}
          title={
            turnActive
              ? "Interrupt the running turn and send this message now"
              : "Send this message now"
          }
          className={`${buttonClass} border-indigo-400/40 bg-indigo-600/20 text-indigo-200 hover:bg-indigo-600/35`}
        >
          {sendingNow ? "Sending..." : "Send now"}
        </button>
      ) : null}
      {props.onCancel ? (
        <button
          type="button"
          disabled={sendingNow}
          onClick={props.onCancel}
          className={neutralButtonClass}
        >
          Cancel
        </button>
      ) : null}
    </div>
  );
}

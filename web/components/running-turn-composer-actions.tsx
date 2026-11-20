import { ListPlus, Square } from "lucide-react";
import {
  RUNNING_TURN_INTERRUPT_LABEL,
  RUNNING_TURN_QUEUE_LABEL,
  runningTurnComposerHint,
} from "../running-turn-send";

/**
 * Shown above the composer textarea while a turn runs and the draft has
 * content: the primary button steers, these buttons queue or interrupt.
 */
export default function RunningTurnComposerActions(props: {
  touch: boolean;
  disabled: boolean;
  onQueue?: (() => void) | null;
  onInterruptAndSend?: (() => void) | null;
}) {
  const { touch, disabled, onQueue, onInterruptAndSend } = props;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pt-2 text-[11px] text-zinc-500">
      <span className="min-w-0 flex-1">
        {runningTurnComposerHint({ canQueue: !!onQueue, touch })}
      </span>
      {onQueue ? (
        <button
          type="button"
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onQueue}
          title="Queue this message to send after the running turn (Tab)"
          className="inline-flex min-h-7 items-center gap-1 rounded-full border border-zinc-700/70 px-2.5 py-1 text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ListPlus className="h-3.5 w-3.5" aria-hidden="true" />
          {RUNNING_TURN_QUEUE_LABEL}
        </button>
      ) : null}
      {onInterruptAndSend ? (
        <button
          type="button"
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onInterruptAndSend}
          title="Stop the running turn and send this message as a new turn"
          className="inline-flex min-h-7 items-center gap-1 rounded-full border border-amber-500/40 px-2.5 py-1 text-amber-200 transition-colors hover:bg-amber-500/15 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Square className="h-2.5 w-2.5 fill-current" aria-hidden="true" />
          {RUNNING_TURN_INTERRUPT_LABEL}
        </button>
      ) : null}
    </div>
  );
}

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Mic, MicOff, Settings2, Square, Volume2, X } from "lucide-react";
import type {
  RealtimeTranscriptEntry,
  RealtimeVoiceSnapshot,
} from "@codex-deck/api";
import { useNativeSnapshot } from "../hooks/use-native-snapshot";
import { getVoiceSnapshot } from "../voice/voice-api";
import {
  getVoiceController,
  type VoiceLocalState,
} from "../voice/voice-controller";
import {
  describeEndedVoiceSession,
  isLiveVoicePhase,
} from "../voice/voice-support";

const ENDED_VISIBLE_MS = 30 * 60_000;
const EMPTY_SNAPSHOT: RealtimeVoiceSnapshot = {
  session: null,
  answerSdp: null,
};

function localStatusLabel(state: VoiceLocalState): string {
  switch (state.status) {
    case "preparing":
      return "Requesting microphone…";
    case "negotiating":
      return "Connecting voice…";
    case "connected":
      return state.muted ? "Voice on · microphone muted" : "Listening";
    case "stopping":
      return "Stopping voice…";
    default:
      return "";
  }
}

function Transcript({ entries }: { entries: RealtimeTranscriptEntry[] }) {
  const list = useRef<HTMLOListElement>(null);
  const last = entries.at(-1);
  useEffect(() => {
    const node = list.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries.length, last?.text]);
  if (entries.length === 0) return null;
  return (
    <ol
      ref={list}
      aria-label="Voice transcript"
      aria-live="polite"
      className="mt-2 max-h-40 space-y-1 overflow-y-auto overscroll-contain pr-1"
    >
      {entries.map((entry) => (
        <li key={entry.id} className="break-words leading-relaxed">
          <span
            className={`mr-1.5 font-semibold ${
              entry.role === "user" ? "text-cyan-300" : "text-zinc-300"
            }`}
          >
            {entry.role === "user" ? "You" : "Codex"}
          </span>
          <span
            className={entry.final ? "text-zinc-200" : "italic text-zinc-400"}
          >
            {entry.text}
            {!entry.final && "…"}
          </span>
        </li>
      ))}
    </ol>
  );
}

const buttonClass =
  "inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900 px-2.5 text-xs text-zinc-200 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Voice state for the conversation bound to the composer: this page's live
 * call, a call owned by another device, or the outcome of the last call.
 */
export default function VoiceSessionBar({
  threadId,
  onOpenSettings,
}: {
  threadId: string | null;
  onOpenSettings: (threadId: string) => void;
}) {
  const controller = getVoiceController();
  const local = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );
  const load = useCallback(
    () =>
      threadId
        ? getVoiceSnapshot(threadId, controller.clientId)
        : Promise.resolve(EMPTY_SNAPSHOT),
    [controller, threadId],
  );
  const { data } = useNativeSnapshot("voice", threadId, load);
  const session =
    data?.session && data.session.threadId === threadId ? data.session : null;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (threadId) controller.observe(threadId, session);
  }, [controller, threadId, session]);

  if (!threadId) return null;

  const ownedHere = local.status !== "idle" && local.threadId === threadId;
  const ownedElsewhere = local.status !== "idle" && local.threadId !== threadId;
  const otherDevice =
    !ownedHere &&
    !!session &&
    isLiveVoicePhase(session.phase) &&
    session.ownerClientId !== controller.clientId;
  const localError =
    local.status === "idle" && local.error && local.errorThreadId === threadId
      ? local.error
      : null;
  const ended =
    !ownedHere &&
    !otherDevice &&
    !!session &&
    !isLiveVoicePhase(session.phase) &&
    session.voiceSessionId !== dismissed &&
    Date.now() - session.updatedAt < ENDED_VISIBLE_MS &&
    (session.transcript.length > 0 || !!session.error)
      ? session
      : null;

  const stopHere = async () => {
    setBusy(true);
    try {
      await controller.stopThread(threadId);
    } finally {
      setBusy(false);
    }
  };

  const settingsButton = (
    <button
      type="button"
      className={buttonClass}
      onClick={() => onOpenSettings(threadId)}
      title="Voice settings"
      aria-label="Voice settings"
    >
      <Settings2 className="h-3.5 w-3.5" />
    </button>
  );

  if (ownedHere) {
    const live = local.status === "connected";
    return (
      <section
        aria-label="Voice conversation"
        className="mx-auto mb-2 w-full max-w-4xl rounded-xl border border-emerald-800/60 bg-zinc-900/80 px-3 py-2 text-xs text-zinc-200"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span
              aria-hidden="true"
              className={`h-2 w-2 shrink-0 rounded-full ${
                live && !local.muted
                  ? "animate-pulse bg-emerald-400"
                  : "bg-amber-400"
              }`}
            />
            <span role="status" className="truncate font-medium">
              {localStatusLabel(local)}
            </span>
            {session?.voice && (
              <span className="truncate text-zinc-400">· {session.voice}</span>
            )}
          </span>
          {local.playbackBlocked && (
            <button
              type="button"
              className={`${buttonClass} border-amber-700/70 text-amber-200`}
              onClick={() => void controller.resumePlayback()}
            >
              <Volume2 className="h-3.5 w-3.5" />
              Tap to hear Codex
            </button>
          )}
          <button
            type="button"
            className={buttonClass}
            disabled={local.status === "stopping"}
            onClick={() => controller.toggleMute()}
            aria-pressed={local.muted}
          >
            {local.muted ? (
              <MicOff className="h-3.5 w-3.5" />
            ) : (
              <Mic className="h-3.5 w-3.5" />
            )}
            {local.muted ? "Unmute" : "Mute"}
          </button>
          <button
            type="button"
            className={`${buttonClass} border-red-800/70 text-red-200`}
            disabled={local.status === "stopping"}
            onClick={() => void controller.stop()}
          >
            <Square className="h-3 w-3" />
            Stop
          </button>
          {settingsButton}
        </div>
        <Transcript entries={session?.transcript ?? []} />
        {live && (session?.transcript.length ?? 0) === 0 && (
          <p className="mt-1 text-zinc-400">
            Speak to Codex. Requests it works on appear in the conversation.
          </p>
        )}
      </section>
    );
  }

  if (otherDevice && session) {
    return (
      <section
        aria-label="Voice conversation"
        className="mx-auto mb-2 w-full max-w-4xl rounded-xl border border-cyan-800/50 bg-zinc-900/80 px-3 py-2 text-xs text-zinc-200"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span role="status" className="min-w-0 flex-1 break-words">
            {session.phase === "stopping"
              ? "Voice is stopping…"
              : session.ownerClientId
                ? "Voice session active on another device."
                : "Voice session active in another Codex client."}
          </span>
          <button
            type="button"
            className={`${buttonClass} border-red-800/70 text-red-200`}
            disabled={busy || session.phase === "stopping"}
            onClick={() => void stopHere()}
          >
            <Square className="h-3 w-3" />
            Stop for everyone
          </button>
        </div>
        <Transcript entries={session.transcript} />
      </section>
    );
  }

  if (ownedElsewhere) {
    return (
      <section
        aria-label="Voice conversation"
        className="mx-auto mb-2 flex w-full max-w-4xl flex-wrap items-center gap-2 rounded-xl border border-emerald-800/60 bg-zinc-900/80 px-3 py-2 text-xs text-zinc-200"
      >
        <span role="status" className="min-w-0 flex-1 break-words">
          Voice is running in another conversation on this page.
        </span>
        <button
          type="button"
          className={`${buttonClass} border-red-800/70 text-red-200`}
          disabled={local.status === "stopping"}
          onClick={() => void controller.stop()}
        >
          <Square className="h-3 w-3" />
          Stop voice
        </button>
      </section>
    );
  }

  if (localError || ended) {
    const message =
      localError ??
      (ended ? describeEndedVoiceSession(ended, controller.clientId) : "");
    const failed = !!localError || ended?.phase === "failed";
    return (
      <section
        aria-label="Voice conversation"
        className={`mx-auto mb-2 w-full max-w-4xl rounded-xl border px-3 py-2 text-xs ${
          failed
            ? "border-red-900/50 bg-red-950/30 text-red-200"
            : "border-zinc-800 bg-zinc-900/70 text-zinc-300"
        }`}
      >
        <div className="flex items-start gap-2">
          <p
            role={failed ? "alert" : "status"}
            className="min-w-0 flex-1 break-words"
          >
            {message}
          </p>
          {settingsButton}
          <button
            type="button"
            className={buttonClass}
            aria-label="Dismiss voice notice"
            onClick={() => {
              controller.clearError();
              if (session && !isLiveVoicePhase(session.phase))
                setDismissed(session.voiceSessionId);
            }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {ended && <Transcript entries={ended.transcript} />}
      </section>
    );
  }

  return null;
}

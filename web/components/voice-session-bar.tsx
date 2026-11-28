import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  ChevronDown,
  ExternalLink,
  Loader2,
  Mic,
  MicOff,
  PhoneOff,
  RotateCcw,
  Settings2,
  Volume2,
  WifiOff,
  X,
} from "lucide-react";
import type {
  RealtimeTranscriptEntry,
  RealtimeVoiceSessionView,
  RealtimeVoiceSnapshot,
} from "@codex-deck/api";
import { useNativeSnapshot } from "../hooks/use-native-snapshot";
import { getVoiceSnapshot } from "../voice/voice-api";
import {
  getVoiceController,
  type VoiceLocalState,
} from "../voice/voice-controller";
import {
  QUIET_IMPULSE,
  type VoiceImpulseActivity,
} from "../voice/voice-impulse";
import {
  deriveVoiceActivity,
  describeEndedVoiceSession,
  describeVoiceActivity,
  describeVoiceError,
  formatVoiceDuration,
  isLiveVoicePhase,
  isVoiceMuteShortcut,
  voiceMuteShortcutLabel,
  type VoiceActivity,
  type VoiceErrorKind,
} from "../voice/voice-support";
import VoiceHistory from "./voice-history";
import VoiceImpulse from "./voice-impulse";
import VoiceTranscript, { type VoiceTranscriptLine } from "./voice-transcript";

const ENDED_VISIBLE_MS = 30 * 60_000;
const TRANSCRIPT_OPEN_KEY = "codex-deck:voice-transcript-open";
const EMPTY_SNAPSHOT: RealtimeVoiceSnapshot = {
  session: null,
  answerSdp: null,
};
const EMPTY_TRANSCRIPT: RealtimeTranscriptEntry[] = [];

const panelClass =
  "mx-auto mb-2 w-full max-w-4xl rounded-[1.25rem] border bg-[var(--app-surface-composer)] text-zinc-200 shadow-sm";
const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60";
const iconButton = `inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;
const pillButton = `inline-flex h-10 min-w-10 shrink-0 items-center justify-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;
const endButton = `${pillButton} border-red-500/40 bg-red-500/15 text-red-200 hover:bg-red-500/25`;
const neutralButton = `${pillButton} border-zinc-700 bg-zinc-900 text-zinc-100 hover:bg-zinc-800`;
const smallPill = `inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors disabled:opacity-50 ${focusRing}`;

function platformName(): string {
  if (typeof navigator === "undefined") return "";
  const data = (navigator as { userAgentData?: { platform?: string } })
    .userAgentData;
  return data?.platform || navigator.platform || navigator.userAgent || "";
}

function readTranscriptOpen(): boolean {
  try {
    return window.localStorage.getItem(TRANSCRIPT_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeTranscriptOpen(open: boolean) {
  try {
    window.localStorage.setItem(TRANSCRIPT_OPEN_KEY, open ? "1" : "0");
  } catch {
    // storage unavailable; the choice lasts for this page
  }
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** Mute shortcut (F9 like the TUI, or Alt/Option+M), installed once per page. */
let shortcutUsers = 0;
function handleShortcut(event: KeyboardEvent) {
  if (event.defaultPrevented || event.repeat || !isVoiceMuteShortcut(event))
    return;
  const controller = getVoiceController();
  const { status } = controller.getState();
  if (status !== "connected" && status !== "negotiating") return;
  if (controller.toggleMute()) event.preventDefault();
}
function useVoiceMuteShortcut() {
  useEffect(() => {
    if (shortcutUsers++ === 0)
      window.addEventListener("keydown", handleShortcut);
    return () => {
      if (--shortcutUsers === 0)
        window.removeEventListener("keydown", handleShortcut);
    };
  }, []);
}

function toLines(entries: readonly RealtimeTranscriptEntry[]) {
  return entries
    .filter((entry) => entry.text.trim())
    .map<VoiceTranscriptLine>((entry) => ({
      key: entry.id,
      role: entry.role === "user" ? "user" : "assistant",
      text: entry.text,
      pending: !entry.final,
      at: entry.at,
    }));
}

/** When this page first saw the latest caption (drives "Thinking"). */
function useLastEntryAge(
  transcript: readonly RealtimeTranscriptEntry[],
  now: number,
): number | null {
  const last = transcript.at(-1);
  const key = last ? `${last.id}:${last.final}` : null;
  const seenAt = useMemo(() => Date.now(), [key]);
  return key ? Math.max(0, now - seenAt) : null;
}

/**
 * Mic state at a glance, as in the TUI strip: a red dot while the microphone
 * is live, a hollow ring while muted, a spinner while connecting.
 */
function VoiceMarker({
  activity,
  remote = false,
}: {
  activity: VoiceActivity;
  remote?: boolean;
}) {
  if (
    activity === "connecting" ||
    activity === "requesting-microphone" ||
    activity === "stopping"
  )
    return (
      <Loader2
        aria-hidden="true"
        className="h-4 w-4 shrink-0 animate-spin text-cyan-400 motion-reduce:animate-none"
      />
    );
  if (activity === "muted")
    return (
      <span
        aria-hidden="true"
        className="flex h-4 w-4 shrink-0 items-center justify-center"
      >
        <span className="h-2.5 w-2.5 rounded-full border-2 border-zinc-500" />
      </span>
    );
  const dot = remote ? "bg-cyan-400" : "bg-red-500";
  return (
    <span
      aria-hidden="true"
      className="relative flex h-4 w-4 shrink-0 items-center justify-center"
    >
      {activity === "hearing-you" && (
        <span
          className={`absolute inline-flex h-4 w-4 animate-ping rounded-full opacity-60 motion-reduce:animate-none ${dot}`}
        />
      )}
      <span className={`relative h-2.5 w-2.5 rounded-full ${dot}`} />
    </span>
  );
}

function Headline({
  activity,
  label,
  detail,
  open,
  controls,
  onToggle,
}: {
  activity: VoiceActivity;
  label: string;
  detail: ReactNode;
  open: boolean;
  controls: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      title={open ? "Hide captions" : "Show captions"}
      className={`group flex min-w-0 flex-1 items-center gap-2.5 rounded-xl py-1 pl-1 pr-2 text-left transition-colors hover:bg-zinc-800/40 ${focusRing}`}
    >
      <VoiceMarker activity={activity} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-zinc-100">
            {label}
          </span>
          {(activity === "working" || activity === "thinking") && (
            <span aria-hidden="true" className="thinking-dot shrink-0" />
          )}
        </span>
        <span className="block truncate text-xs text-zinc-400">{detail}</span>
      </span>
      <ChevronDown
        aria-hidden="true"
        className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform motion-reduce:transition-none ${
          open ? "rotate-180" : ""
        }`}
      />
    </button>
  );
}

function LiveCall({
  local,
  session,
  working,
  shortcut,
  open,
  onToggleOpen,
  onOpenSettings,
}: {
  local: VoiceLocalState;
  session: RealtimeVoiceSessionView | null;
  working: boolean;
  shortcut: string;
  open: boolean;
  onToggleOpen: () => void;
  onOpenSettings: () => void;
}) {
  const controller = getVoiceController();
  const transcript = session?.transcript ?? EMPTY_TRANSCRIPT;
  const connected = local.status === "connected";
  const now = useNow(local.status !== "idle");
  const lastEntryAgeMs = useLastEntryAge(transcript, now);
  const [impulse, setImpulse] = useState<VoiceImpulseActivity>(QUIET_IMPULSE);
  const levels = useCallback(() => controller.levels(), [controller]);
  const transcriptId = useId();

  const activity = deriveVoiceActivity({
    status: local.status,
    muted: local.muted,
    userSpeaking: impulse.userSpeaking,
    codexSpeaking: impulse.codexSpeaking,
    transcript,
    working,
    lastEntryAgeMs,
  });
  const { label, hint } = describeVoiceActivity(activity, {
    shortcut,
    mutedSpeech: impulse.mutedSpeech,
  });
  const detail = [
    hint,
    connected && local.connectedAt
      ? formatVoiceDuration(now - local.connectedAt)
      : null,
    session?.voice ?? null,
  ]
    .filter(Boolean)
    .join(" · ");
  const connecting =
    local.status === "preparing" || local.status === "negotiating";
  const canMute =
    local.status === "connected" || local.status === "negotiating";

  return (
    <section
      aria-label="Voice conversation"
      className={`${panelClass} border-[color:var(--app-border-composer)]`}
    >
      <p className="sr-only" role="status" aria-live="polite">
        {local.status === "preparing"
          ? "Requesting microphone"
          : local.status === "negotiating"
            ? "Connecting voice"
            : local.status === "stopping"
              ? "Ending voice call"
              : local.muted
                ? "Voice connected. Microphone muted."
                : "Voice connected. Listening."}
      </p>
      {/* Phones: headline on its own row, then meters beside the controls.
          Wider: headline beside the controls, meters underneath. */}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-2 pb-2 pt-2 sm:gap-x-2 sm:px-3">
        <div className="flex min-w-0 basis-full sm:basis-auto sm:flex-1">
          <Headline
            activity={activity}
            label={label}
            detail={detail}
            open={open}
            controls={transcriptId}
            onToggle={onToggleOpen}
          />
        </div>
        <div className="flex min-h-7 min-w-0 flex-1 items-center justify-between gap-3 pl-1 sm:order-last sm:basis-full sm:pl-2">
          <VoiceImpulse
            levels={levels}
            running={connected}
            muted={local.muted}
            onActivity={setImpulse}
          />
          <span className="hidden shrink-0 text-[11px] text-zinc-500 md:inline">
            <kbd className="font-sans">{shortcut}</kbd>{" "}
            {local.muted ? "unmute" : "mute"} · /voice stop
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          <button
            type="button"
            className={`${iconButton} max-[359px]:hidden`}
            onClick={onOpenSettings}
            title="Voice settings"
            aria-label="Voice settings"
          >
            <Settings2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={
              local.muted
                ? `${pillButton} border-amber-500/40 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25`
                : neutralButton
            }
            disabled={!canMute}
            onClick={() => controller.toggleMute()}
            aria-pressed={local.muted}
            aria-label={local.muted ? "Unmute microphone" : "Mute microphone"}
            title={`${local.muted ? "Unmute" : "Mute"} (${shortcut} or F9)`}
          >
            {local.muted ? (
              <MicOff className="h-4 w-4" />
            ) : (
              <Mic className="h-4 w-4" />
            )}
            <span className="hidden sm:inline">
              {local.muted ? "Unmute" : "Mute"}
            </span>
          </button>
          <button
            type="button"
            className={endButton}
            disabled={local.status === "stopping"}
            onClick={() => void controller.stop()}
            aria-label={
              connecting ? "Cancel voice connection" : "End voice conversation"
            }
            title={connecting ? "Cancel" : "End call (/voice stop)"}
          >
            <PhoneOff className="h-4 w-4" />
            <span className="hidden sm:inline">
              {connecting ? "Cancel" : "End"}
            </span>
          </button>
        </div>
      </div>
      {local.playbackBlocked && (
        <div
          role="alert"
          className="mx-2 mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 sm:mx-3"
        >
          <Volume2 aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">
            Your browser paused Codex&apos;s voice.
          </span>
          <button
            type="button"
            className={`${smallPill} border-amber-500/40 bg-amber-500/15 hover:bg-amber-500/25`}
            onClick={() => void controller.resumePlayback()}
          >
            Turn on sound
          </button>
        </div>
      )}
      <div
        id={transcriptId}
        hidden={!open}
        className="border-t border-zinc-800 px-2 py-2 sm:px-3"
      >
        <VoiceTranscript
          label="Voice captions"
          lines={toLines(transcript)}
          emptyHint={
            connected
              ? "Start talking. Captions appear here; work Codex does shows up in the conversation."
              : "Captions appear here once voice connects."
          }
        />
      </div>
    </section>
  );
}

function RemoteCall({
  session,
  working,
  open,
  onToggleOpen,
  ownedBy,
}: {
  session: RealtimeVoiceSessionView;
  working: boolean;
  open: boolean;
  onToggleOpen: () => void;
  ownedBy: string;
}) {
  const controller = getVoiceController();
  const [busy, setBusy] = useState(false);
  const now = useNow(true);
  const lastEntryAgeMs = useLastEntryAge(session.transcript, now);
  const transcriptId = useId();
  const stopping = session.phase === "stopping";
  const activity = deriveVoiceActivity({
    status: stopping
      ? "stopping"
      : session.phase === "starting"
        ? "negotiating"
        : "remote",
    muted: false,
    userSpeaking: false,
    codexSpeaking: false,
    transcript: session.transcript,
    working,
    lastEntryAgeMs,
  });
  const { label } = describeVoiceActivity(activity, {
    shortcut: "",
    remote: true,
  });
  const detail = [
    ownedBy,
    session.phase === "active"
      ? formatVoiceDuration(now - session.startedAt)
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section
      aria-label="Voice conversation"
      className={`${panelClass} border-cyan-500/30`}
    >
      <div className="flex items-center gap-2 px-2 py-2 sm:px-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={transcriptId}
          onClick={onToggleOpen}
          className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-xl py-1 pl-1 pr-2 text-left hover:bg-zinc-800/40 ${focusRing}`}
        >
          <VoiceMarker activity={activity} remote />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-zinc-100">
              {label}
            </span>
            <span className="block truncate text-xs text-zinc-400">
              {detail}
            </span>
          </span>
          <ChevronDown
            aria-hidden="true"
            className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform motion-reduce:transition-none ${
              open ? "rotate-180" : ""
            }`}
          />
        </button>
        <button
          type="button"
          className={endButton}
          disabled={busy || stopping}
          onClick={async () => {
            setBusy(true);
            try {
              await controller.stopThread(session.threadId);
            } finally {
              setBusy(false);
            }
          }}
          aria-label="End voice for everyone"
          title="End the call on every device"
        >
          <PhoneOff className="h-4 w-4" />
          <span className="hidden sm:inline">End for everyone</span>
        </button>
      </div>
      <div
        id={transcriptId}
        hidden={!open}
        className="border-t border-zinc-800 px-2 py-2 sm:px-3"
      >
        <VoiceTranscript
          label="Voice captions"
          lines={toLines(session.transcript)}
          emptyHint="Captions from the call appear here."
        />
      </div>
    </section>
  );
}

function Notice({
  tone,
  kind,
  title,
  message,
  actions,
  onDismiss,
}: {
  tone: "error" | "warning" | "info";
  kind: VoiceErrorKind | null;
  title: string;
  message: string;
  actions: ReactNode;
  onDismiss: () => void;
}) {
  const Icon =
    kind === "permission" ||
    kind === "no-microphone" ||
    kind === "microphone-busy"
      ? MicOff
      : kind === "connection"
        ? WifiOff
        : kind === "ended"
          ? PhoneOff
          : AlertTriangle;
  const toneClass =
    tone === "error"
      ? "border-red-500/30"
      : tone === "warning"
        ? "border-amber-500/30"
        : "border-[color:var(--app-border-composer)]";
  const iconClass =
    tone === "error"
      ? "bg-red-500/15 text-red-300"
      : tone === "warning"
        ? "bg-amber-500/15 text-amber-300"
        : "bg-zinc-800 text-zinc-400";
  return (
    <section
      aria-label="Voice conversation"
      className={`${panelClass} ${toneClass}`}
    >
      <div className="flex items-start gap-3 px-3 py-2.5">
        <span
          aria-hidden="true"
          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${iconClass}`}
        >
          <Icon className="h-4 w-4" />
        </span>
        <div
          role={tone === "info" ? "status" : "alert"}
          className="min-w-0 flex-1"
        >
          <p className="text-sm font-medium text-zinc-100">{title}</p>
          <p className="mt-0.5 break-words text-xs leading-relaxed text-zinc-400">
            {message}
          </p>
          {actions && (
            <div className="mt-2 flex flex-wrap gap-2">{actions}</div>
          )}
        </div>
        <button
          type="button"
          className={`${iconButton} -mr-1 -mt-1 h-8 w-8`}
          aria-label="Dismiss voice notice"
          onClick={onDismiss}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </section>
  );
}

/**
 * Voice state for the conversation bound to the composer: this page's live
 * call, a call owned by another device, a call this page runs in another
 * conversation, or why the last call stopped.
 */
export default function VoiceSessionBar({
  threadId,
  working = false,
  onOpenSettings,
  onStartVoice,
  describeThread,
  onOpenThread,
}: {
  threadId: string | null;
  /** A turn is running in this conversation. */
  working?: boolean;
  onOpenSettings: (threadId: string) => void;
  /** Start voice again (runs /voice so the usual checks apply). */
  onStartVoice?: () => void;
  describeThread?: (threadId: string) => string | null;
  onOpenThread?: (threadId: string) => void;
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
  const [open, setOpen] = useState(readTranscriptOpen);
  const shortcut = useMemo(() => voiceMuteShortcutLabel(platformName()), []);
  useVoiceMuteShortcut();

  useEffect(() => {
    if (threadId) controller.observe(threadId, session);
  }, [controller, threadId, session]);

  if (!threadId) return null;

  const toggleOpen = () =>
    setOpen((value) => {
      writeTranscriptOpen(!value);
      return !value;
    });
  const history = (
    <VoiceHistory
      key={threadId}
      threadId={threadId}
      live={session?.transcript ?? EMPTY_TRANSCRIPT}
    />
  );
  const ownedHere = local.status !== "idle" && local.threadId === threadId;
  const ownedElsewhere = local.status !== "idle" && local.threadId !== threadId;
  const otherDevice =
    !ownedHere &&
    !!session &&
    isLiveVoicePhase(session.phase) &&
    session.ownerClientId !== controller.clientId;

  if (ownedHere)
    return (
      <LiveCall
        local={local}
        session={session}
        working={working}
        shortcut={shortcut}
        open={open}
        onToggleOpen={toggleOpen}
        onOpenSettings={() => onOpenSettings(threadId)}
      />
    );

  if (otherDevice && session)
    return (
      <RemoteCall
        session={session}
        working={working}
        open={open}
        onToggleOpen={toggleOpen}
        ownedBy={
          session.ownerClientId
            ? "Live on another device"
            : "Live in another Codex client"
        }
      />
    );

  if (ownedElsewhere && local.threadId) {
    const otherThread = local.threadId;
    const title = describeThread?.(otherThread)?.trim();
    const connected = local.status === "connected";
    return (
      <>
        <section
          aria-label="Voice conversation"
          className={`${panelClass} flex items-center gap-1.5 border-[color:var(--app-border-composer)] px-2 py-1.5 sm:px-3`}
        >
          <VoiceMarker
            activity={
              !connected ? "connecting" : local.muted ? "muted" : "listening"
            }
          />
          <p
            role="status"
            className="min-w-0 flex-1 truncate pl-1 text-xs text-zinc-400"
          >
            <span className="font-medium text-zinc-100">
              {connected ? "Voice is live" : "Voice is connecting"}
            </span>{" "}
            {title ? `in “${title}”` : "in another conversation"}
          </p>
          {onOpenThread && (
            <button
              type="button"
              className={`${smallPill} border-zinc-700 text-zinc-200 hover:bg-zinc-800`}
              onClick={() => onOpenThread(otherThread)}
            >
              <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
              <span className="max-sm:sr-only">Open</span>
            </button>
          )}
          <button
            type="button"
            className={`${iconButton} h-9 w-9 ${local.muted ? "text-amber-300" : ""}`}
            disabled={!connected}
            onClick={() => controller.toggleMute()}
            aria-pressed={local.muted}
            aria-label={local.muted ? "Unmute microphone" : "Mute microphone"}
            title={`${local.muted ? "Unmute" : "Mute"} (${shortcut} or F9)`}
          >
            {local.muted ? (
              <MicOff className="h-4 w-4" />
            ) : (
              <Mic className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            className={`${endButton} h-9 min-w-9 px-2.5`}
            disabled={local.status === "stopping"}
            onClick={() => void controller.stop()}
            aria-label="End voice conversation"
            title="End call"
          >
            <PhoneOff className="h-4 w-4" />
          </button>
        </section>
        {history}
      </>
    );
  }

  const localError =
    local.status === "idle" && local.error && local.errorThreadId === threadId
      ? local.error
      : null;
  // Only explain endings you did not cause yourself; a normal hang-up from
  // this page needs no notice (the captions stay in Voice history).
  const ended =
    !localError &&
    !!session &&
    !isLiveVoicePhase(session.phase) &&
    session.voiceSessionId !== dismissed &&
    Date.now() - session.updatedAt < ENDED_VISIBLE_MS &&
    (session.phase === "failed" ||
      (session.ownerClientId === controller.clientId &&
        session.stoppedByClientId !== controller.clientId))
      ? session
      : null;

  if (localError || ended) {
    const kind: VoiceErrorKind | null = localError
      ? local.errorKind
      : ended?.phase === "failed"
        ? "service"
        : "ended";
    const presentation = describeVoiceError(kind);
    const message =
      localError ??
      (ended ? describeEndedVoiceSession(ended, controller.clientId) : "");
    const title =
      kind === "ended" && /another device/i.test(message)
        ? "Voice ended on another device"
        : presentation.title;
    const tone =
      kind === "unsupported" || kind === "conflict"
        ? "warning"
        : kind === "ended"
          ? "info"
          : "error";
    const dismiss = () => {
      controller.clearError();
      if (session && !isLiveVoicePhase(session.phase))
        setDismissed(session.voiceSessionId);
    };
    return (
      <>
        <Notice
          tone={tone}
          kind={kind}
          title={title}
          message={message}
          onDismiss={dismiss}
          actions={
            <>
              {presentation.retry && onStartVoice && (
                <button
                  type="button"
                  className={`${smallPill} border-cyan-500/40 bg-cyan-500/15 text-cyan-100 hover:bg-cyan-500/25`}
                  onClick={() => {
                    dismiss();
                    onStartVoice();
                  }}
                >
                  <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
                  {kind === "ended" ? "Start again" : "Try again"}
                </button>
              )}
              {presentation.chooseMicrophone && (
                <button
                  type="button"
                  className={`${smallPill} border-zinc-700 text-zinc-200 hover:bg-zinc-800`}
                  onClick={() => onOpenSettings(threadId)}
                >
                  <Settings2 aria-hidden="true" className="h-3.5 w-3.5" />
                  Choose microphone
                </button>
              )}
            </>
          }
        />
        {history}
      </>
    );
  }

  return history;
}

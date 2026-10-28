import { useCallback, useEffect, useRef, useState } from "react";
import { AudioLines, Circle, Square, X } from "lucide-react";
import {
  audioAttachmentMimeType,
  describeMicrophoneError,
  MAX_AUDIO_ATTACHMENT_BYTES,
  readVoiceEnvironment,
  voiceUnavailableReason,
  withAudioMimeType,
} from "../voice/voice-support";

export interface AudioAttachment {
  id: string;
  name: string;
  /** data:audio/... URL sent as a `{ type: "audio" }` user input. */
  dataUrl: string;
}

function createId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Failed to read audio data"));
    reader.onerror = () => reject(new Error("Failed to read audio data"));
    reader.readAsDataURL(blob);
  });
}

export function useAudioAttachments() {
  const [attachments, setAttachments] = useState<AudioAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const addBlobs = useCallback(
    async (entries: Array<{ blob: Blob; name: string }>) => {
      setError(null);
      for (const { blob, name } of entries) {
        const mime = audioAttachmentMimeType({ name, type: blob.type });
        if (!mime) {
          setError(
            `${name} is not a supported audio format. Use wav, mp3, m4a, webm, or ogg.`,
          );
          continue;
        }
        if (blob.size > MAX_AUDIO_ATTACHMENT_BYTES) {
          setError(`${name} is larger than 20 MB.`);
          continue;
        }
        try {
          const dataUrl = withAudioMimeType(await readAsDataUrl(blob), mime);
          setAttachments((current) => [
            ...current,
            { id: createId(), name, dataUrl },
          ]);
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      }
    },
    [],
  );
  const remove = useCallback((id: string) => {
    setAttachments((current) => current.filter((entry) => entry.id !== id));
  }, []);
  const clear = useCallback(() => {
    setAttachments([]);
    setError(null);
  }, []);
  return { attachments, error, setError, addBlobs, remove, clear };
}

export function AudioAttachmentList({
  attachments,
  disabled,
  onRemove,
}: {
  attachments: AudioAttachment[];
  disabled?: boolean;
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-2">
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className="flex max-w-full items-center gap-2 rounded-lg border border-zinc-700/70 bg-zinc-950 px-2 py-1"
        >
          <AudioLines className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
          <span className="max-w-[10rem] truncate text-xs text-zinc-300">
            {attachment.name}
          </span>
          <audio
            controls
            preload="metadata"
            src={attachment.dataUrl}
            aria-label={`Attached audio ${attachment.name}`}
            className="h-8 w-40 max-w-[45vw]"
          />
          <button
            type="button"
            onClick={() => onRemove(attachment.id)}
            disabled={disabled}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-zinc-200 disabled:opacity-60"
            title="Remove audio"
            aria-label={`Remove audio ${attachment.name}`}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

function pickRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported?.(type)) return type;
  }
  return undefined;
}

/**
 * Attach an audio file or record a clip. Shown only for Codex conversations;
 * disabled with a visible reason when the selected model has no audio input.
 */
export function AudioAttachButton({
  unavailableReason,
  disabled,
  onAdd,
  onError,
}: {
  unavailableReason: string | null;
  disabled?: boolean;
  onAdd: (entries: Array<{ blob: Blob; name: string }>) => void;
  onError: (message: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const [open, setOpen] = useState(false);
  const [recording, setRecording] = useState(false);

  useEffect(
    () => () => {
      const active = recorder.current;
      if (active && active.state !== "inactive") active.stop();
    },
    [],
  );

  const recordUnavailable =
    voiceUnavailableReason({
      ...readVoiceEnvironment(),
      hasPeerConnection: true,
    }) ??
    (typeof MediaRecorder === "undefined"
      ? "This browser cannot record audio clips."
      : null);

  const startRecording = async () => {
    onError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      onError(describeMicrophoneError(error).replace("run /voice", "record"));
      return;
    }
    const mimeType = pickRecorderMimeType();
    const next = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    const chunks: Blob[] = [];
    next.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    next.onstop = () => {
      for (const track of stream.getTracks()) track.stop();
      recorder.current = null;
      setRecording(false);
      const type = next.mimeType || mimeType || "audio/webm";
      const blob = new Blob(chunks, { type });
      if (blob.size === 0) return;
      const extension = type.includes("mp4") ? "m4a" : "webm";
      const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, "");
      onAdd([{ blob, name: `recording-${stamp}.${extension}` }]);
    };
    recorder.current = next;
    next.start();
    setRecording(true);
    setOpen(false);
  };

  if (recording) {
    return (
      <button
        type="button"
        onClick={() => recorder.current?.stop()}
        className="flex h-8 items-center gap-1 rounded-full border border-red-800/70 px-2 text-xs text-red-200 transition-colors hover:bg-zinc-800"
        title="Stop recording"
        aria-label="Stop recording audio clip"
      >
        <Square className="h-3 w-3" />
        <span className="animate-pulse">Rec</span>
      </button>
    );
  }

  return (
    <div className="relative flex">
      <input
        ref={input}
        type="file"
        accept="audio/*,.wav,.mp3,.m4a,.webm,.ogg"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          setOpen(false);
          if (files.length)
            onAdd(files.map((file) => ({ blob: file, name: file.name })));
        }}
      />
      {open && (
        <div className="absolute bottom-10 right-0 z-30 w-[min(16rem,80vw)] rounded-xl border border-zinc-700/70 bg-zinc-900 p-1.5 text-xs shadow-xl">
          {unavailableReason ? (
            <p role="status" className="break-words p-2 text-zinc-300">
              {unavailableReason}
            </p>
          ) : (
            <>
              <button
                type="button"
                onClick={() => input.current?.click()}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-zinc-200 hover:bg-zinc-800"
              >
                <AudioLines className="h-3.5 w-3.5" />
                Attach audio file
              </button>
              <button
                type="button"
                onClick={() => void startRecording()}
                disabled={!!recordUnavailable}
                title={recordUnavailable ?? undefined}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
              >
                <Circle className="h-3.5 w-3.5 text-red-400" />
                Record a clip
              </button>
              {recordUnavailable && (
                <p className="break-words px-2.5 pb-1 text-zinc-400">
                  {recordUnavailable}
                </p>
              )}
            </>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-expanded={open}
        className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-zinc-800 disabled:opacity-40 ${
          unavailableReason
            ? "text-zinc-600"
            : "text-zinc-400 hover:text-zinc-100"
        }`}
        title={unavailableReason ?? "Attach audio"}
        aria-label={
          unavailableReason
            ? "Attach audio (unavailable for this model)"
            : "Attach audio"
        }
      >
        <AudioLines className="h-[18px] w-[18px]" />
      </button>
    </div>
  );
}

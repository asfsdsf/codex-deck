import { useCallback, useEffect, useState } from "react";
import { useNativeSnapshot } from "../hooks/use-native-snapshot";
import { getVoiceCatalog, setVoicePreference } from "../voice/voice-api";
import { getVoiceController } from "../voice/voice-controller";
import {
  readPreferredMicrophone,
  writePreferredMicrophone,
} from "../voice/voice-media";

interface MicrophoneOption {
  deviceId: string;
  label: string;
}

async function listMicrophones(): Promise<MicrophoneOption[]> {
  if (typeof navigator.mediaDevices?.enumerateDevices !== "function") return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === "audioinput" && device.deviceId)
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `Microphone ${index + 1}`,
    }));
}

/** `/voice settings`: voice (shared Codex config) and microphone (this device). */
export default function VoiceSettings({
  threadId,
}: {
  threadId: string | null;
}) {
  const load = useCallback(() => getVoiceCatalog(threadId), [threadId]);
  // Subscribe without a thread so live transcript updates do not reload.
  const { data, loading, error, setData } = useNativeSnapshot(
    "voice",
    null,
    load,
  );
  const unavailable = getVoiceController().unavailableReason();
  const [saving, setSaving] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [microphones, setMicrophones] = useState<MicrophoneOption[]>([]);
  const [microphone, setMicrophone] = useState<string>(
    () => readPreferredMicrophone() ?? "",
  );

  useEffect(() => {
    let active = true;
    const refresh = () =>
      void listMicrophones()
        .then((next) => {
          if (active) setMicrophones(next);
        })
        .catch(() => {});
    refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => {
      active = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
    };
  }, []);

  const selected = data?.configuredVoice ?? data?.defaultVoice ?? null;
  const save = async (voice: string | null) => {
    setSaving(voice ?? "");
    setMessage("");
    try {
      const result = await setVoicePreference(voice, threadId);
      setData({
        voices: result.voices,
        defaultVoice: result.defaultVoice,
        configuredVoice: result.configuredVoice,
      });
      setMessage(
        result.warning ||
          "Voice saved. Applies to your next voice conversation.",
      );
    } catch (reason) {
      setMessage(
        `Failed to save voice: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    } finally {
      setSaving(null);
    }
  };

  const unlabeled = microphones.some((entry) =>
    /^Microphone \d+$/.test(entry.label),
  );

  return (
    <div className="space-y-4 text-sm">
      {unavailable && (
        <p
          role="alert"
          className="break-words rounded-lg border border-amber-800/60 bg-amber-950/30 p-3 text-amber-200"
        >
          {unavailable}
        </p>
      )}
      <section className="space-y-2">
        <h3 className="font-semibold">Voice</h3>
        <p className="text-zinc-400">
          Saved to your Codex configuration as <code>realtime.voice</code>.
          Applies to your next voice conversation.
        </p>
        {loading && !data && <p role="status">Loading voices…</p>}
        {error && (
          <p role="alert" className="break-words text-red-400">
            {error}
          </p>
        )}
        {data && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {data.voices.map((voice) => {
              const current = voice === selected;
              return (
                <button
                  key={voice}
                  type="button"
                  aria-pressed={current}
                  disabled={saving !== null}
                  onClick={() => void save(voice)}
                  className={`min-h-10 rounded-lg border px-3 py-2 text-left capitalize transition-colors disabled:opacity-60 ${
                    current
                      ? "border-cyan-600 bg-cyan-600/15 text-cyan-100"
                      : "border-zinc-700 bg-zinc-950/40 text-zinc-200 hover:bg-zinc-800"
                  }`}
                >
                  {voice}
                  {voice === data.defaultVoice && (
                    <span className="ml-1 text-xs normal-case text-zinc-400">
                      (default)
                    </span>
                  )}
                  {saving === voice && (
                    <span className="ml-1 text-xs normal-case">…</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        {data?.configuredVoice && (
          <button
            type="button"
            disabled={saving !== null}
            onClick={() => void save(null)}
            className="rounded border border-zinc-700 px-3 py-2 disabled:opacity-50"
          >
            Use the server default voice
          </button>
        )}
        {message && (
          <p role="status" className="break-words text-amber-300">
            {message}
          </p>
        )}
      </section>
      <section className="space-y-2">
        <h3 className="font-semibold">Microphone</h3>
        <p className="text-zinc-400">
          Remembered on this browser only. Applies to your next voice
          conversation.
        </p>
        <select
          aria-label="Microphone"
          value={microphone}
          onChange={(event) => {
            setMicrophone(event.target.value);
            writePreferredMicrophone(event.target.value || null);
          }}
          className="h-10 w-full rounded border border-zinc-700 bg-zinc-950 px-2 text-zinc-200"
        >
          <option value="">System default</option>
          {microphones.map((entry) => (
            <option key={entry.deviceId} value={entry.deviceId}>
              {entry.label}
            </option>
          ))}
        </select>
        {unlabeled && (
          <p className="text-xs text-zinc-400">
            Device names appear after you allow microphone access once.
          </p>
        )}
      </section>
    </div>
  );
}

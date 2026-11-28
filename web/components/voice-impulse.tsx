import { memo, useEffect, useRef, useState } from "react";
import type { VoiceLevels } from "../voice/voice-media";
import {
  QUIET_IMPULSE,
  sameImpulseActivity,
  VOICE_METER_FRAMES,
  VOICE_METER_INTERVAL_MS,
  VoiceImpulseHistory,
  type VoiceImpulseActivity,
} from "../voice/voice-impulse";

const EMPTY = Array.from({ length: VOICE_METER_FRAMES }, () => 0);

const ImpulseRow = memo(function ImpulseRow({
  label,
  samples,
  tone,
  dimmed,
}: {
  label: string;
  samples: readonly number[];
  tone: "mic" | "codex";
  dimmed: boolean;
}) {
  const on = tone === "mic" ? "bg-cyan-400" : "bg-fuchsia-400";
  return (
    <span className="flex items-center gap-1.5">
      <span className="w-8 text-right font-mono text-[10px] uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      <span className="flex h-4 items-end gap-[2px]">
        {samples.map((intensity, index) => (
          <span
            key={index}
            className={`w-[3px] rounded-full transition-[height] duration-75 ease-out motion-reduce:transition-none ${
              intensity > 0 && !dimmed ? on : "bg-zinc-600/70"
            }`}
            // ▁ for silence up to █ for full scale, like the TUI glyphs.
            style={{
              height: `${dimmed ? 12.5 : 12.5 + intensity * 87.5}%`,
            }}
          />
        ))}
      </span>
    </span>
  );
});

/**
 * Live microphone and Codex amplitude, sampled every 100 ms from the page's
 * call media. Reports held speaking state so the headline can follow it.
 */
export default function VoiceImpulse({
  levels,
  running,
  muted,
  onActivity,
}: {
  levels: () => VoiceLevels;
  /** Media is connected and producing audio. */
  running: boolean;
  muted: boolean;
  onActivity: (activity: VoiceImpulseActivity) => void;
}) {
  const [samples, setSamples] = useState<{
    mic: readonly number[];
    codex: readonly number[];
  }>({ mic: EMPTY, codex: EMPTY });
  const report = useRef(onActivity);
  report.current = onActivity;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  useEffect(() => {
    if (!running) {
      setSamples({ mic: EMPTY, codex: EMPTY });
      report.current(QUIET_IMPULSE);
      return;
    }
    const history = new VoiceImpulseHistory();
    let last: VoiceImpulseActivity = QUIET_IMPULSE;
    let micPeak = 0;
    let codexPeak = 0;
    let nextSample = performance.now() + VOICE_METER_INTERVAL_MS;
    let frame = 0;
    // Read every frame (each read covers ~43 ms) and keep the 100 ms peak,
    // like the TUI's take_peaks().
    const tick = (now: number) => {
      const current = levels();
      micPeak = Math.max(micPeak, current.input);
      codexPeak = Math.max(codexPeak, current.output);
      if (now >= nextSample) {
        nextSample = now + VOICE_METER_INTERVAL_MS;
        const activity = history.push(
          micPeak,
          codexPeak,
          mutedRef.current,
          Date.now(),
        );
        micPeak = 0;
        codexPeak = 0;
        setSamples({ mic: [...history.mic], codex: [...history.codex] });
        if (!sameImpulseActivity(activity, last)) {
          last = activity;
          report.current(activity);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      report.current(QUIET_IMPULSE);
    };
  }, [levels, running]);

  return (
    // The meters are decoration for sighted users; the headline carries the
    // state for assistive tech. Reduced motion hides them, like the TUI.
    <span
      aria-hidden="true"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 motion-reduce:hidden"
    >
      <ImpulseRow
        label="mic"
        samples={samples.mic}
        tone="mic"
        dimmed={muted || !running}
      />
      <ImpulseRow
        label="codex"
        samples={samples.codex}
        tone="codex"
        dimmed={!running}
      />
    </span>
  );
}

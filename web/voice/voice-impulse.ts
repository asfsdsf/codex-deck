/**
 * The voice "impulse": rolling microphone and Codex amplitude histories, the
 * web counterpart of the Codex TUI voice strip (`mic ▁▂▃▅▇  codex ▁▃▅▂▁`).
 * Calibration matches the TUI: i16 peaks below 512 are noise, 8192 is full
 * scale, one sample every 100 ms, and Codex counts as speaking for 500 ms
 * after its last audible sample.
 */

export const VOICE_METER_INTERVAL_MS = 100;
export const VOICE_METER_FRAMES = 16;
export const VOICE_SPEAKER_HOLD_MS = 500;
const NOISE_FLOOR = 512 / 32768;
const FULL_SCALE = 8192 / 32768;

/** 0..1 intensity for a 0..1 peak amplitude (TUI `audio_meter_intensity`). */
export function voiceMeterIntensity(peak: number): number {
  if (!(peak > NOISE_FLOOR)) return 0;
  return Math.min(1, (peak - NOISE_FLOOR) / (FULL_SCALE - NOISE_FLOOR));
}

/** 0..5 segment level (TUI `audio_meter_level`); above 0 means audible. */
export function voiceMeterLevel(peak: number): number {
  return Math.ceil(voiceMeterIntensity(peak) * 5);
}

export interface VoiceImpulseActivity {
  /** The user is audibly talking (and not muted). */
  userSpeaking: boolean;
  /** The user is talking while muted, so Codex cannot hear them. */
  mutedSpeech: boolean;
  /** Codex's voice is playing. */
  codexSpeaking: boolean;
}

export const QUIET_IMPULSE: VoiceImpulseActivity = {
  userSpeaking: false,
  mutedSpeech: false,
  codexSpeaking: false,
};

export class VoiceImpulseHistory {
  public readonly mic: number[];
  public readonly codex: number[];
  private userUntil = 0;
  private mutedUntil = 0;
  private codexUntil = 0;

  public constructor(private readonly frames = VOICE_METER_FRAMES) {
    this.mic = Array.from({ length: frames }, () => 0);
    this.codex = Array.from({ length: frames }, () => 0);
  }

  /** Record one 100 ms sample of peaks; returns the held speaking state. */
  public push(
    micPeak: number,
    codexPeak: number,
    muted: boolean,
    now: number,
  ): VoiceImpulseActivity {
    const mic = voiceMeterIntensity(micPeak);
    const codex = voiceMeterIntensity(codexPeak);
    // Like the TUI, a muted microphone draws a flat line.
    this.mic.push(muted ? 0 : mic);
    this.codex.push(codex);
    if (this.mic.length > this.frames) this.mic.shift();
    if (this.codex.length > this.frames) this.codex.shift();
    if (mic > 0) {
      if (muted) this.mutedUntil = now + VOICE_SPEAKER_HOLD_MS;
      else this.userUntil = now + VOICE_SPEAKER_HOLD_MS;
    }
    if (codex > 0) this.codexUntil = now + VOICE_SPEAKER_HOLD_MS;
    return {
      userSpeaking: !muted && now < this.userUntil,
      mutedSpeech: muted && now < this.mutedUntil,
      codexSpeaking: now < this.codexUntil,
    };
  }
}

export function sameImpulseActivity(
  left: VoiceImpulseActivity,
  right: VoiceImpulseActivity,
): boolean {
  return (
    left.userSpeaking === right.userSpeaking &&
    left.mutedSpeech === right.mutedSpeech &&
    left.codexSpeaking === right.codexSpeaking
  );
}

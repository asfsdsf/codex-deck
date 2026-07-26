/**
 * Notification chime for sessions that finish generating while the page is
 * visible. Sessions that settle while the tab is hidden must stay silent,
 * even after the tab becomes visible again — so a chime is only played for
 * sessions that were observed still running while the page was visible.
 */

export interface SettleChimeTracker {
  /** Record that this session was seen running while the page was visible. */
  noteRunning: (sessionId: string) => void;
  /**
   * Consume the session's eligibility. Returns true when the session was
   * observed running while visible (and should chime now that it settled).
   */
  consumeSettled: (sessionId: string) => boolean;
  /** Drop all eligibility, called when the page becomes hidden. */
  clear: () => void;
}

export function createSettleChimeTracker(): SettleChimeTracker {
  const runningWhileVisible = new Set<string>();

  return {
    noteRunning: (sessionId: string) => {
      const normalized = sessionId.trim();
      if (normalized) {
        runningWhileVisible.add(normalized);
      }
    },
    consumeSettled: (sessionId: string) => {
      const normalized = sessionId.trim();
      if (!normalized || !runningWhileVisible.has(normalized)) {
        return false;
      }
      runningWhileVisible.delete(normalized);
      return true;
    },
    clear: () => {
      runningWhileVisible.clear();
    },
  };
}

interface WebkitAudioWindow extends Window {
  webkitAudioContext?: typeof AudioContext;
}

let sharedAudioContext: AudioContext | null = null;

export function playSessionSettleChime(): void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }
  if (document.visibilityState !== "visible") {
    return;
  }

  const AudioContextCtor =
    window.AudioContext ?? (window as WebkitAudioWindow).webkitAudioContext;
  if (!AudioContextCtor) {
    return;
  }

  try {
    sharedAudioContext ??= new AudioContextCtor();
    const context = sharedAudioContext;
    if (context.state === "suspended") {
      // Browsers block audio until the first user gesture; resume is
      // best-effort and the chime simply stays silent while blocked.
      void context.resume().catch(() => {});
    }

    const startAt = context.currentTime + 0.02;
    const gain = context.createGain();
    gain.connect(context.destination);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(0.08, startAt + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.7);

    const notes = [
      { frequency: 880, offset: 0 },
      { frequency: 1318.51, offset: 0.16 },
    ];
    for (const note of notes) {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = note.frequency;
      oscillator.connect(gain);
      oscillator.start(startAt + note.offset);
      oscillator.stop(startAt + note.offset + 0.5);
    }
  } catch {
    // Audio failures must never break session status tracking.
  }
}

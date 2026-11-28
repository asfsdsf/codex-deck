/**
 * Browser media for realtime voice. The page creates the WebRTC offer with a
 * microphone track and the `oai-events` data channel (the channel name the
 * upstream voice host uses), and plays the model's remote audio track.
 */

export type VoiceMediaConnectionState =
  | "connecting"
  | "connected"
  | "failed"
  | "closed";

/**
 * Peak sample amplitude (0..1 of full scale) since the previous read, like
 * the Codex TUI's microphone/speaker peaks.
 */
export interface VoiceLevels {
  /** Microphone peak, measured even while muted (to warn "you are muted"). */
  input: number;
  /** Peak of Codex's voice coming back from the call. */
  output: number;
}

export const SILENT_LEVELS: VoiceLevels = { input: 0, output: 0 };

export interface VoiceMediaSession {
  readonly offerSdp: string;
  applyAnswer(sdp: string): Promise<void>;
  setMuted(muted: boolean): void;
  /** Current audio levels; cheap enough to call every animation frame. */
  levels(): VoiceLevels;
  /** Retry remote playback from a user gesture (iOS/Safari autoplay rules). */
  resumePlayback(): Promise<boolean>;
  close(): void;
}

export interface VoiceMediaCallbacks {
  onConnectionState: (state: VoiceMediaConnectionState) => void;
  onPlaybackBlocked: (blocked: boolean) => void;
}

export interface VoiceMediaFactory {
  create(
    options: { microphoneId?: string | null },
    callbacks: VoiceMediaCallbacks,
  ): Promise<VoiceMediaSession>;
}

export const REALTIME_EVENTS_CHANNEL = "oai-events";
const ICE_GATHERING_TIMEOUT_MS = 2_500;

interface LevelMeter {
  attach(stream: MediaStream): void;
  read(): number;
}

/**
 * Web Audio meters for the microphone and the remote voice. Metering is
 * best effort: when the browser refuses (old Safari, suspended context), the
 * levels stay at zero and the UI falls back to transcript-driven activity.
 */
function createMeters() {
  const AudioContextClass: typeof AudioContext | undefined =
    typeof window === "undefined"
      ? undefined
      : (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext);
  let context: AudioContext | null = null;
  try {
    // Created inside the click that starts voice so iOS lets it run.
    context = AudioContextClass ? new AudioContextClass() : null;
    void context?.resume().catch(() => {});
  } catch {
    context = null;
  }
  const meter = (): LevelMeter => {
    let analyser: AnalyserNode | null = null;
    let buffer: Float32Array<ArrayBuffer> | null = null;
    let attached: { stream: MediaStream; source: AudioNode } | null = null;
    return {
      // Follows the stream that is actually playing: a later `track` event
      // (renegotiation) replaces the metered stream.
      attach(stream) {
        if (!context || attached?.stream === stream) return;
        try {
          attached?.source.disconnect();
        } catch {
          // already disconnected
        }
        attached = null;
        analyser = null;
        try {
          const source = context.createMediaStreamSource(stream);
          const node = context.createAnalyser();
          // ~43 ms window at 48 kHz, so frame-rate reads see every peak.
          node.fftSize = 2048;
          // Some engines only pull analysers that reach the destination;
          // a zero gain keeps the path silent.
          const mute = context.createGain();
          mute.gain.value = 0;
          source.connect(node);
          node.connect(mute);
          mute.connect(context.destination);
          analyser = node;
          attached = { stream, source };
          buffer = new Float32Array(new ArrayBuffer(node.fftSize * 4));
        } catch {
          analyser = null;
        }
      },
      read() {
        if (!analyser || !buffer) return 0;
        analyser.getFloatTimeDomainData(buffer);
        let peak = 0;
        for (const sample of buffer) {
          const magnitude = Math.abs(sample);
          if (magnitude > peak) peak = magnitude;
        }
        return Math.min(1, peak);
      },
    };
  };
  return {
    input: meter(),
    output: meter(),
    resume() {
      if (context?.state === "suspended") void context.resume().catch(() => {});
    },
    close() {
      void context?.close().catch(() => {});
      context = null;
    },
  };
}

function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => {
      if (peer.iceGatheringState === "complete") done();
    };
    // Host candidates are enough for the realtime backend; do not wait long
    // for slow STUN/mDNS gathering.
    const timer = setTimeout(done, ICE_GATHERING_TIMEOUT_MS);
    peer.addEventListener("icegatheringstatechange", check);
  });
}

export const browserVoiceMediaFactory: VoiceMediaFactory = {
  async create(options, callbacks) {
    // Create and "unlock" the audio element first so playback is tied to the
    // user gesture that started voice.
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("playsinline", "");
    audio.style.display = "none";
    document.body.appendChild(audio);
    void audio.play().catch(() => {});
    const meters = createMeters();

    let stream: MediaStream | null = null;
    // Metering uses a clone so it keeps hearing the user while muted.
    let meterStream: MediaStream | null = null;
    let peer: RTCPeerConnection | null = null;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      for (const track of stream?.getTracks() ?? []) track.stop();
      for (const track of meterStream?.getTracks() ?? []) track.stop();
      meters.close();
      try {
        peer?.close();
      } catch {
        // already closed
      }
      audio.pause();
      audio.srcObject = null;
      audio.remove();
    };
    try {
      const constraints = (deviceId?: string | null) => ({
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      try {
        stream = await navigator.mediaDevices.getUserMedia(
          constraints(options.microphoneId),
        );
      } catch (error) {
        // A remembered microphone may have been unplugged; use the default.
        if (
          !options.microphoneId ||
          (error as { name?: string })?.name !== "OverconstrainedError"
        )
          throw error;
        stream = await navigator.mediaDevices.getUserMedia(constraints(null));
      }
      try {
        meterStream = stream.clone();
        meters.input.attach(meterStream);
      } catch {
        meterStream = null;
      }
      peer = new RTCPeerConnection();
      const activePeer = peer;
      for (const track of stream.getAudioTracks())
        activePeer.addTrack(track, stream);
      activePeer.createDataChannel(REALTIME_EVENTS_CHANNEL);
      activePeer.addEventListener("track", (event) => {
        const remote = event.streams[0] ?? new MediaStream([event.track]);
        audio.srcObject = remote;
        meters.output.attach(remote);
        audio
          .play()
          .then(() => callbacks.onPlaybackBlocked(false))
          .catch(() => callbacks.onPlaybackBlocked(true));
      });
      activePeer.addEventListener("connectionstatechange", () => {
        if (closed) return;
        const state = activePeer.connectionState;
        if (state === "connected") callbacks.onConnectionState("connected");
        else if (state === "failed") callbacks.onConnectionState("failed");
        else if (state === "closed") callbacks.onConnectionState("closed");
        else callbacks.onConnectionState("connecting");
      });
      const offer = await activePeer.createOffer();
      await activePeer.setLocalDescription(offer);
      await waitForIceGathering(activePeer);
      const offerSdp = activePeer.localDescription?.sdp || offer.sdp || "";
      if (!offerSdp)
        throw new Error("The browser did not produce an SDP offer.");
      const microphone = stream;
      return {
        offerSdp,
        async applyAnswer(sdp) {
          await activePeer.setRemoteDescription({ type: "answer", sdp });
        },
        setMuted(muted) {
          for (const track of microphone.getAudioTracks())
            track.enabled = !muted;
        },
        levels() {
          return { input: meters.input.read(), output: meters.output.read() };
        },
        async resumePlayback() {
          meters.resume();
          try {
            await audio.play();
            callbacks.onPlaybackBlocked(false);
            return true;
          } catch {
            callbacks.onPlaybackBlocked(true);
            return false;
          }
        },
        close,
      };
    } catch (error) {
      close();
      throw error;
    }
  },
};

const MICROPHONE_STORAGE_KEY = "codex-deck:voice-microphone";

/** Microphone choice is per browser/device, so it lives in local storage. */
export function readPreferredMicrophone(): string | null {
  try {
    return window.localStorage.getItem(MICROPHONE_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

export function writePreferredMicrophone(deviceId: string | null): void {
  try {
    if (deviceId) window.localStorage.setItem(MICROPHONE_STORAGE_KEY, deviceId);
    else window.localStorage.removeItem(MICROPHONE_STORAGE_KEY);
  } catch {
    // storage unavailable (private mode); the choice applies to this page only
  }
}

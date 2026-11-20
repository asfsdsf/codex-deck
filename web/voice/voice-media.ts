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

export interface VoiceMediaSession {
  readonly offerSdp: string;
  applyAnswer(sdp: string): Promise<void>;
  setMuted(muted: boolean): void;
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

    let stream: MediaStream | null = null;
    let peer: RTCPeerConnection | null = null;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      for (const track of stream?.getTracks() ?? []) track.stop();
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
      peer = new RTCPeerConnection();
      const activePeer = peer;
      for (const track of stream.getAudioTracks())
        activePeer.addTrack(track, stream);
      activePeer.createDataChannel(REALTIME_EVENTS_CHANNEL);
      activePeer.addEventListener("track", (event) => {
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
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
        async resumePlayback() {
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

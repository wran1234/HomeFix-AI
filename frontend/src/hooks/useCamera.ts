import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { encodePcm16Base64 } from "../audio/pcm16";
import { auditMediaStream, ensureTracksEnabled, type MediaGateStatus } from "../media/gate";

interface UseCameraReturn {
  videoRef: React.RefObject<HTMLVideoElement>;
  isReady: boolean;
  error: string | null;
  /** False if browser/device only gave video (mic unavailable). */
  hasAudioTrack: boolean;
  /** Last auditable state — updated on a timer, visibility, and focus */
  mediaGate: MediaGateStatus;
  /** Re-check stream and re-enable tracks; returns fresh status (use before Begin). */
  assertMediaReady: () => MediaGateStatus;
  startCapture: (fps: number, onFrame: (b64: string) => void) => void;
  stopCapture: () => void;
  startLiveAudio: (onPcmBase64: (data: string) => void) => Promise<void>;
  stopLiveAudio: () => void;
}

type AudioGraph = {
  ctx: AudioContext | null;
  source: MediaStreamAudioSourceNode | null;
  processor: ScriptProcessorNode | null;
  gain: GainNode | null;
};

const emptyGraph = (): AudioGraph => ({
  ctx: null,
  source: null,
  processor: null,
  gain: null,
});

const GATE_POLL_MS = 2000;

const initialGate: MediaGateStatus = {
  videoOk: false,
  audioOk: false,
  warning: "Waiting for camera and microphone…",
};

function pickVideoConstraints(): MediaTrackConstraints {
  return {
    facingMode: { ideal: "environment" },
    width: { ideal: 1280, max: 1920 },
    height: { ideal: 720, max: 1080 },
  };
}

async function openCameraStream(audio: boolean): Promise<MediaStream> {
  const v = pickVideoConstraints();
  const audioConstraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  };
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: v,
      audio: audio ? audioConstraints : false,
    });
  } catch {
    /* fall through */
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: audio ? audioConstraints : false,
    });
  } catch {
    /* fall through */
  }
  return navigator.mediaDevices.getUserMedia({
    video: true,
    audio: audio ? audioConstraints : false,
  });
}

/**
 * `sharedAudioContextRef` should be the same AudioContext you `resume()` on the user's tap
 * (Begin session). Otherwise the capture context starts in a later effect and stays suspended,
 * so the mic never reaches Gemini.
 *
 * `sessionPhase` — when the mounted `<video>` node changes (e.g. Start → Inspecting), iOS Safari
 * needs a synchronous re-bind + play() before paint; pass `phase` from App while the session runs.
 */
export function useCamera(
  enabled: boolean = true,
  playNonce: number = 0,
  sharedAudioContextRef?: RefObject<AudioContext | null>,
  sessionPhase: string = ""
): UseCameraReturn {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasAudioTrack, setHasAudioTrack] = useState(false);
  const [mediaGate, setMediaGate] = useState<MediaGateStatus>(initialGate);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const gatePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioGraphRef = useRef<AudioGraph>(emptyGraph());

  const stopLiveAudio = useCallback(() => {
    const g = audioGraphRef.current;
    try {
      g.processor?.disconnect();
      g.gain?.disconnect();
      g.source?.disconnect();
      void g.ctx?.close();
    } catch {
      /* ignore */
    }
    audioGraphRef.current = emptyGraph();
  }, []);

  useEffect(() => {
    if (!enabled) {
      stopLiveAudio();
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      workerRef.current?.terminate();
      workerRef.current = null;
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      setIsReady(false);
      setError(null);
      setHasAudioTrack(false);
      setMediaGate(initialGate);
      if (gatePollRef.current) {
        clearInterval(gatePollRef.current);
        gatePollRef.current = null;
      }
      return;
    }

    let stream: MediaStream | undefined;

    const runGate = () => {
      ensureTracksEnabled(streamRef.current);
      setMediaGate(auditMediaStream(streamRef.current));
    };

    async function init() {
      try {
        stream = await openCameraStream(true);
      } catch {
        setError(
          "Camera and microphone are both required. Allow them in your browser settings, then reload this page."
        );
        setMediaGate({
          videoOk: false,
          audioOk: false,
          warning: "Allow camera and microphone for this site.",
        });
        return;
      }

      streamRef.current = stream;
      ensureTracksEnabled(stream);
      setHasAudioTrack(stream.getAudioTracks().length > 0);
      setMediaGate(auditMediaStream(stream));

      const onTrackEnded = () => runGate();
      stream.getTracks().forEach((t) => t.addEventListener("ended", onTrackEnded));

      const el = videoRef.current;
      if (el) {
        el.srcObject = stream;
        el.setAttribute("playsinline", "true");
        el.setAttribute("webkit-playsinline", "true");
        el.muted = true;
        el.onloadedmetadata = () => {
          setIsReady(true);
          runGate();
          el.play().catch(() => void el.play());
        };
        el.play().catch(() => void el.play());
      }
    }

    init();

    try {
      workerRef.current = new Worker(
        new URL("../workers/frameCapture.worker.ts", import.meta.url),
        { type: "module" }
      );
    } catch {
      workerRef.current = null;
    }

    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      ensureTracksEnabled(streamRef.current);
      setMediaGate(auditMediaStream(streamRef.current));
      const v = videoRef.current;
      if (v?.srcObject) void v.play();
    };
    const onFocus = () => {
      ensureTracksEnabled(streamRef.current);
      setMediaGate(auditMediaStream(streamRef.current));
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);

    gatePollRef.current = window.setInterval(() => {
      ensureTracksEnabled(streamRef.current);
      setMediaGate(auditMediaStream(streamRef.current));
    }, GATE_POLL_MS);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      if (gatePollRef.current) {
        clearInterval(gatePollRef.current);
        gatePollRef.current = null;
      }
      stopLiveAudio();
      stream?.getTracks().forEach((t) => t.stop());
      workerRef.current?.terminate();
      workerRef.current = null;
      streamRef.current = null;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [enabled, stopLiveAudio]);

  const assertMediaReady = useCallback((): MediaGateStatus => {
    ensureTracksEnabled(streamRef.current);
    const next = auditMediaStream(streamRef.current);
    setMediaGate(next);
    return next;
  }, []);

  const startLiveAudio = useCallback(
    async (onPcmBase64: (data: string) => void) => {
      stopLiveAudio();
      const stream = streamRef.current;
      if (!stream?.getAudioTracks().length) return;

      ensureTracksEnabled(stream);
      setMediaGate(auditMediaStream(stream));

      const actx = sharedAudioContextRef?.current ?? new AudioContext();

      // Resume the context BEFORE connecting nodes — some browsers won't pull
      // audio from a MediaStreamSource connected to a suspended context.
      try {
        await actx.resume();
      } catch {
        /* ignore */
      }

      const source = actx.createMediaStreamSource(stream);
      const processor = actx.createScriptProcessor(4096, 1, 1);
      const gain = actx.createGain();
      gain.gain.value = 0;

      processor.onaudioprocess = (e) => {
        const ch = e.inputBuffer.getChannelData(0);
        const copy = new Float32Array(ch.length);
        copy.set(ch);
        onPcmBase64(encodePcm16Base64(copy, actx.sampleRate));
      };

      source.connect(processor);
      processor.connect(gain);
      gain.connect(actx.destination);

      audioGraphRef.current = { ctx: actx, source, processor, gain };
    },
    [stopLiveAudio, sharedAudioContextRef]
  );

  const startCapture = useCallback((fps: number, onFrame: (b64: string) => void) => {
    if (intervalRef.current) clearInterval(intervalRef.current);

    ensureTracksEnabled(streamRef.current);
    setMediaGate(auditMediaStream(streamRef.current));

    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext("2d")!;
    const worker = workerRef.current;
    const video = videoRef.current;

    if (!video) return;

    const ms = Math.max(33, Math.floor(1000 / fps));

    if (worker) {
      worker.onmessage = (e) => onFrame(e.data as string);
      intervalRef.current = setInterval(() => {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          ctx.drawImage(video, 0, 0, 640, 480);
          const imageData = ctx.getImageData(0, 0, 640, 480);
          worker.postMessage({ imageData, width: 640, height: 480 }, [imageData.data.buffer]);
        }
      }, ms);
      return;
    }

    intervalRef.current = setInterval(() => {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        ctx.drawImage(video, 0, 0, 640, 480);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.6);
        const b64 = dataUrl.split(",")[1];
        if (b64) onFrame(b64);
      }
    }, ms);
  }, []);

  // Re-attach + play before paint whenever the <video> DOM node or phase changes (critical on iOS Safari).
  useLayoutEffect(() => {
    if (!enabled) return;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;

    video.setAttribute("playsinline", "true");
    video.setAttribute("webkit-playsinline", "true");
    video.muted = true;

    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }

    const kickPlay = () => {
      video.play().catch(() => {
        requestAnimationFrame(() => {
          video.play().catch(() => {});
        });
      });
    };
    kickPlay();
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      video.addEventListener("loadeddata", kickPlay, { once: true });
    }
  }, [enabled, playNonce, sessionPhase]);

  // User tapped “Begin session” — extra play attempts after layout (Safari + overlay stacks).
  useEffect(() => {
    if (!enabled || playNonce <= 0) return;
    const video = videoRef.current;
    if (!video?.srcObject) return;
    const id = window.setTimeout(() => {
      video.play().catch(() => {});
    }, 120);
    return () => clearTimeout(id);
  }, [enabled, playNonce, sessionPhase]);

  const stopCapture = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  return {
    videoRef,
    isReady,
    error,
    hasAudioTrack,
    mediaGate,
    assertMediaReady,
    startCapture,
    stopCapture,
    startLiveAudio,
    stopLiveAudio,
  };
}

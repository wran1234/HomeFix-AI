import { useCallback, useEffect, useRef, useState } from "react";
import { encodePcm16Base64 } from "../audio/pcm16";

interface UseCameraReturn {
  videoRef: React.RefObject<HTMLVideoElement>;
  isReady: boolean;
  error: string | null;
  /** False if browser/device only gave video (mic unavailable). */
  hasAudioTrack: boolean;
  startCapture: (fps: number, onFrame: (b64: string) => void) => void;
  stopCapture: () => void;
  startLiveAudio: (onPcmBase64: (data: string) => void) => void;
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

/** When `enabled` is false, camera and worker stay off (e.g. marketing landing page). */
export function useCamera(enabled: boolean = true): UseCameraReturn {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasAudioTrack, setHasAudioTrack] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
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
      return;
    }

    let stream: MediaStream;

    async function init() {
      const videoConstraints: MediaTrackConstraints = {
        facingMode: "environment",
        width: 640,
        height: 480,
      };
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      };

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: audioConstraints,
        });
      } catch {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: videoConstraints,
            audio: false,
          });
        } catch {
          setError("Camera access is required for a live session. Allow the camera when prompted.");
          return;
        }
      }

      streamRef.current = stream;
      setHasAudioTrack(stream.getAudioTracks().length > 0);

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => setIsReady(true);
      }
    }

    init();

    workerRef.current = new Worker(
      new URL("../workers/frameCapture.worker.ts", import.meta.url),
      { type: "module" }
    );

    return () => {
      stopLiveAudio();
      stream?.getTracks().forEach((t) => t.stop());
      workerRef.current?.terminate();
      workerRef.current = null;
      streamRef.current = null;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [enabled, stopLiveAudio]);

  const startLiveAudio = useCallback(
    (onPcmBase64: (data: string) => void) => {
      stopLiveAudio();
      const stream = streamRef.current;
      if (!stream?.getAudioTracks().length) return;

      const actx = new AudioContext();
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

      void actx.resume();

      audioGraphRef.current = { ctx: actx, source, processor, gain };
    },
    [stopLiveAudio]
  );

  const startCapture = useCallback((fps: number, onFrame: (b64: string) => void) => {
    if (intervalRef.current) clearInterval(intervalRef.current);

    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext("2d")!;
    const worker = workerRef.current;
    const video = videoRef.current;

    if (!video || !worker) return;

    worker.onmessage = (e) => onFrame(e.data as string);

    intervalRef.current = setInterval(() => {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        ctx.drawImage(video, 0, 0, 640, 480);
        const imageData = ctx.getImageData(0, 0, 640, 480);
        worker.postMessage({ imageData, width: 640, height: 480 }, [imageData.data.buffer]);
      }
    }, Math.floor(1000 / fps));
  }, []);

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
    startCapture,
    stopCapture,
    startLiveAudio,
    stopLiveAudio,
  };
}

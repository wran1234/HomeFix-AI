import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { AppPhase } from "../types";

/** Gemini Live native audio: 16-bit LE PCM mono (see Live API / Vertex native audio docs). */
const LIVE_SPEECH_PCM_HZ = 24_000;

async function speechBase64ToAudioBuffer(ctx: AudioContext, b64: string): Promise<AudioBuffer> {
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);

  try {
    const slice = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return await ctx.decodeAudioData(slice);
  } catch {
    let byteLen = buf.byteLength;
    if (byteLen % 2 !== 0) byteLen -= 1;
    const sampleCount = byteLen >> 1;
    const pcm = new Int16Array(buf.buffer, buf.byteOffset, sampleCount);
    const float32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) float32[i] = pcm[i] / 32768;
    const audioBuf = ctx.createBuffer(1, float32.length, LIVE_SPEECH_PCM_HZ);
    audioBuf.copyToChannel(float32, 0);
    return audioBuf;
  }
}

/**
 * Gemini sends many small `speech` messages. Starting every chunk at `ctx.currentTime`
 * overlaps buffers and leaves gaps — this schedules chunks back-to-back on the timeline.
 */
export function useLiveSpeechPlayback(
  audioCtxRef: RefObject<AudioContext | null>,
  setIsSpeaking: (v: boolean) => void,
  phase: AppPhase
): (b64: string) => void {
  const chainRef = useRef(Promise.resolve());
  const nextStartRef = useRef<number | null>(null);
  const activeRef = useRef(0);

  useEffect(() => {
    nextStartRef.current = null;
    chainRef.current = Promise.resolve();
  }, [phase]);

  return useCallback(
    (b64: string) => {
      const ctx = audioCtxRef.current;
      if (!ctx) return;

      chainRef.current = chainRef.current
        .then(async () => {
          await ctx.resume().catch(() => {});
          const audioBuf = await speechBase64ToAudioBuffer(ctx, b64);
          const now = ctx.currentTime;
          let t = nextStartRef.current ?? now;
          if (t < now) t = now;

          const src = ctx.createBufferSource();
          src.buffer = audioBuf;
          src.connect(ctx.destination);

          activeRef.current += 1;
          if (activeRef.current === 1) setIsSpeaking(true);
          src.onended = () => {
            activeRef.current = Math.max(0, activeRef.current - 1);
            if (activeRef.current === 0) setIsSpeaking(false);
          };

          src.start(t);
          nextStartRef.current = t + audioBuf.duration;
        })
        .catch(() => {});
    },
    [audioCtxRef, setIsSpeaking]
  );
}

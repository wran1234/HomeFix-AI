import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { AppPhase } from "../types";

/** Gemini Live native audio: 16-bit LE PCM mono (see Live API / Vertex native audio docs). */
const LIVE_SPEECH_PCM_HZ = 24_000;

/** Bound queued chunks so long sessions cannot grow unbounded browser RAM. */
const MAX_SPEECH_QUEUE = 200;

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
 * Schedules Gemini speech chunks on the AudioContext timeline (gapless).
 * Uses a FIFO queue + one async pump — avoids an unbounded Promise chain (browser OOM on long calls).
 */
export function useLiveSpeechPlayback(
  audioCtxRef: RefObject<AudioContext | null>,
  setIsSpeaking: (v: boolean) => void,
  phase: AppPhase
): (b64: string) => void {
  const queueRef = useRef<string[]>([]);
  const pumpingRef = useRef(false);
  const nextStartRef = useRef<number | null>(null);
  const activeRef = useRef(0);
  const setSpeakingRef = useRef(setIsSpeaking);
  setSpeakingRef.current = setIsSpeaking;

  useEffect(() => {
    queueRef.current = [];
    nextStartRef.current = null;
    pumpingRef.current = false;
  }, [phase]);

  const runPump = useCallback(async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const ctx = audioCtxRef.current;
        if (!ctx) break;
        const b64 = queueRef.current.shift()!;
        try {
          await ctx.resume().catch(() => {});
          const audioBuf = await speechBase64ToAudioBuffer(ctx, b64);
          const now = ctx.currentTime;
          let t = nextStartRef.current ?? now;
          if (t < now) t = now;

          const src = ctx.createBufferSource();
          src.buffer = audioBuf;
          src.connect(ctx.destination);

          activeRef.current += 1;
          if (activeRef.current === 1) setSpeakingRef.current(true);
          src.onended = () => {
            activeRef.current = Math.max(0, activeRef.current - 1);
            if (activeRef.current === 0) setSpeakingRef.current(false);
          };

          src.start(t);
          nextStartRef.current = t + audioBuf.duration;
        } catch {
          /* skip bad chunk */
        }
      }
    } finally {
      pumpingRef.current = false;
      if (queueRef.current.length > 0 && audioCtxRef.current) {
        void runPump();
      }
    }
  }, [audioCtxRef]);

  return useCallback(
    (b64: string) => {
      if (queueRef.current.length >= MAX_SPEECH_QUEUE) {
        queueRef.current.shift();
      }
      queueRef.current.push(b64);
      void runPump();
    },
    [runPump]
  );
}

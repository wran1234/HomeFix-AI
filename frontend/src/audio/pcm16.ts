/** Downsample mono float samples toward 16 kHz (Gemini Live mic input). */
export function downsampleFloat32(buffer: Float32Array, inputRate: number, outRate: number): Float32Array {
  if (outRate >= inputRate || buffer.length === 0) return buffer;
  const ratio = inputRate / outRate;
  const outLen = Math.max(1, Math.floor(buffer.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), buffer.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += buffer[j];
    out[i] = sum / (end - start || 1);
  }
  return out;
}

export function floatTo16BitPCM(float32: Float32Array): Int16Array {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? (s * 0x8000) | 0 : (s * 0x7fff) | 0;
  }
  return out;
}

const GEMINI_INPUT_RATE = 16000;

/** Float32 mono @ inputRate → Int16 PCM @ 16 kHz little-endian, as base64. */
export function encodePcm16Base64(samples: Float32Array, inputSampleRate: number): string {
  const atTarget =
    inputSampleRate === GEMINI_INPUT_RATE
      ? samples
      : downsampleFloat32(samples, inputSampleRate, GEMINI_INPUT_RATE);
  const pcm = floatTo16BitPCM(atTarget);
  const bytes = new Uint8Array(pcm.buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

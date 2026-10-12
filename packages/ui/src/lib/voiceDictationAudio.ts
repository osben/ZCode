/** Sample rate for voice dictation: matches the transcription input of services/voice-dictation (16 kHz mono). */
export const VOICE_SAMPLE_RATE = 16000;

/** Recordings shorter than this are treated as accidental taps (quick press-release) and are not transcribed. */
export const VOICE_MIN_RECORDING_MS = 250;

export function concatFloat32Chunks(chunks: readonly Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/** Float samples ([-1, 1]) to little-endian PCM16 bytes; out-of-range values are clamped first. */
export function float32ToPcm16Le(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(i * 2, Math.round(value), true);
  }
  return bytes;
}

/** Peak level in [0, 1], used for the volume indicator while recording and microphone testing. */
export function peakLevel(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const magnitude = Math.abs(samples[i] ?? 0);
    if (magnitude > peak) peak = magnitude;
  }
  return Math.min(1, peak);
}

export function samplesToMilliseconds(sampleCount: number): number {
  return (sampleCount / VOICE_SAMPLE_RATE) * 1000;
}

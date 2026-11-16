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

/** A chunk peak at or below this maps to the waveform's silence floor (-50 dBFS). */
export const VOICE_WAVE_SILENCE_PEAK = 10 ** (-50 / 20);

/**
 * Waveform bar height input: a recorder chunk peak in [0, 1] mapped to 0..1 over −50…−10 dBFS.
 * Silence pins to 0; clipping pins to 1.
 */
export function peakToWaveformLevel(peak: number): number {
  if (peak <= 0) return 0;
  const decibels = 20 * Math.log10(peak);
  return Math.min(1, Math.max(0, (decibels + 50) / 40));
}

export interface VoiceRecordingPeakStats {
  /** Number of recorder chunks observed this session. */
  chunks: number;
  /** Highest chunk peak this session, 0 when every chunk was digital silence. */
  maxPeak: number;
}

/** Outcome of the stop-time silence check, ordered by specificity. */
export type VoiceSilenceOutcome = "ok" | "digitalSilence" | "tooQuiet";

/**
 * Classifies a finished recording from its per-chunk peak statistics: all-zero capture means the
 * microphone delivered no signal at all (permission off or wrong device), a sub-−50 dBFS peak means
 * real but unusably quiet input. `tooQuiet` only applies once at least one chunk arrived.
 */
export function classifyRecordingSilence(stats: VoiceRecordingPeakStats): VoiceSilenceOutcome {
  if (stats.chunks > 0 && stats.maxPeak === 0) return "digitalSilence";
  if (stats.chunks > 0 && stats.maxPeak < VOICE_WAVE_SILENCE_PEAK) return "tooQuiet";
  return "ok";
}

export function samplesToMilliseconds(sampleCount: number): number {
  return (sampleCount / VOICE_SAMPLE_RATE) * 1000;
}

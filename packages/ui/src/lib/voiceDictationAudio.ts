/** 语音输入使用的采样率：与 services/voice-dictation 的转写输入保持一致（16 kHz 单声道）。 */
export const VOICE_SAMPLE_RATE = 16000;

/** 短于该时长的录音视为误触（例如快速按下又松开），不送去转写。 */
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

/** 浮点采样（[-1, 1]）转 PCM16 小端字节；超出范围的值先截断。 */
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

/** 峰值电平，范围 [0, 1]，用于录音时的音量指示与麦克风测试。 */
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

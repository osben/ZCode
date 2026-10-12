import { VOICE_SAMPLE_RATE, concatFloat32Chunks, peakLevel } from "./voiceDictationAudio.js";

export interface VoiceRecorderStartOptions {
  /** Microphone deviceId; when absent or the device does not exist, the system default input is used. */
  deviceId?: string | null;
  onLevel?: (level: number) => void;
  onChunk?: (samples: Float32Array) => void;
  /** Disable full-clip retention when the caller streams every PCM chunk live. */
  collectSamples?: boolean;
}

const MICROPHONE_CONSTRAINTS = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
} as const;

/**
 * Microphone capture: collects Float32 samples at 16 kHz mono and hands them to transcription in
 * one shot on stop. Uses ScriptProcessorNode rather than AudioWorklet to skip loading a separate
 * worklet module; output is routed through a zero-gain node to destination, only driving the
 * callbacks, never playing the microphone back.
 */
export class VoiceDictationRecorder {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private mute: GainNode | null = null;
  private chunks: Float32Array[] = [];

  get isRecording(): boolean {
    return this.stream !== null;
  }

  async start(options: VoiceRecorderStartOptions = {}): Promise<void> {
    if (this.stream) throw new Error("voice recorder is already running");
    const stream = await requestMicrophone(options.deviceId);
    try {
      const context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
      await context.resume();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const mute = context.createGain();
      mute.gain.value = 0;
      processor.onaudioprocess = (event) => {
        if (this.processor !== processor) return;
        const copy = new Float32Array(event.inputBuffer.getChannelData(0));
        if (options.collectSamples !== false) this.chunks.push(copy);
        options.onLevel?.(peakLevel(copy));
        options.onChunk?.(copy);
      };
      source.connect(processor);
      processor.connect(mute);
      mute.connect(context.destination);

      this.stream = stream;
      this.context = context;
      this.source = source;
      this.processor = processor;
      this.mute = mute;
      this.chunks = [];
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      throw error;
    }
  }

  /** Ends capture and returns all samples; returns an empty array when not recording. */
  stop(): Float32Array {
    const samples = concatFloat32Chunks(this.chunks);
    this.teardown();
    return samples;
  }

  cancel(): void {
    this.teardown();
  }

  private teardown(): void {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.mute?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context?.close();
    this.stream = null;
    this.context = null;
    this.source = null;
    this.processor = null;
    this.mute = null;
    this.chunks = [];
  }
}

async function requestMicrophone(deviceId: string | null | undefined): Promise<MediaStream> {
  if (deviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...MICROPHONE_CONSTRAINTS, deviceId: { exact: deviceId } },
      });
    } catch (error) {
      // Fall back to the system default input when the saved device has been unplugged, instead of
      // breaking voice input entirely.
      if (!(error instanceof DOMException) || error.name !== "OverconstrainedError") throw error;
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: MICROPHONE_CONSTRAINTS });
}

/** Lists all audio input devices the system currently exposes (including virtual inputs); authorization is required to obtain device names. */
export async function listAudioInputDevices(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return filterAudioInputDevices(devices);
}

export function filterAudioInputDevices(devices: readonly MediaDeviceInfo[]): MediaDeviceInfo[] {
  return devices.filter((device) => device.kind === "audioinput" && device.deviceId !== "default");
}

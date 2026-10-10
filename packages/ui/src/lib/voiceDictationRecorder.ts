import { VOICE_SAMPLE_RATE, concatFloat32Chunks, peakLevel } from "./voiceDictationAudio.js";

export interface VoiceRecorderStartOptions {
  /** 麦克风 deviceId；缺省或设备不存在时使用系统默认输入。 */
  deviceId?: string | null;
  onLevel?: (level: number) => void;
}

const MICROPHONE_CONSTRAINTS = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
} as const;

/**
 * 麦克风采集：以 16 kHz 单声道收集 Float32 采样，停止时一次性交给转写。
 * 使用 ScriptProcessorNode 而非 AudioWorklet，省去单独的 worklet 模块加载；
 * 输出经零增益节点接到 destination，只用于驱动回调，不会回放麦克风声音。
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
        this.chunks.push(copy);
        options.onLevel?.(peakLevel(copy));
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

  /** 结束采集并返回全部采样；未在采集时返回空数组。 */
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
      // 已保存的设备被拔掉时回退到系统默认输入，而不是让整个语音输入失效。
      if (!(error instanceof DOMException) || error.name !== "OverconstrainedError") throw error;
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: MICROPHONE_CONSTRAINTS });
}

/** 列出音频输入设备；需要先获得麦克风授权才能拿到设备名称。 */
export async function listAudioInputDevices(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === "audioinput");
}

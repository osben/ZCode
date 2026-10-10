import { TranscribeModel } from "transcribe-cpp";
import type { VoiceModelStore } from "./voiceModelStore.js";

export interface VoiceTranscriptionResult {
  text: string;
  language: string;
}

export interface VoiceEngineModel {
  transcribe(
    samples: Float32Array,
    options: { language?: string },
  ): Promise<VoiceTranscriptionResult>;
  dispose(): void;
}

export interface VoiceTranscriberOptions {
  store: VoiceModelStore;
  loadEngine?: (modelPath: string) => Promise<VoiceEngineModel>;
}

/**
 * 当前加载模型的唯一所有者。加载、转写、卸载共用一个队列串行执行，
 * 避免转写过程中模型被替换或释放。
 */
export class VoiceTranscriber {
  private readonly store: VoiceModelStore;
  private readonly loadEngine: (modelPath: string) => Promise<VoiceEngineModel>;
  private loaded: { id: string; engine: VoiceEngineModel } | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: VoiceTranscriberOptions) {
    this.store = options.store;
    this.loadEngine = options.loadEngine ?? loadTranscribeCppEngine;
  }

  get loadedModelId(): string | null {
    return this.loaded?.id ?? null;
  }

  load(id: string): Promise<void> {
    return this.enqueue(() => this.ensureLoaded(id));
  }

  /** 按需加载 `modelId` 后转写；加载与转写在同一队列项内完成，避免中间被卸载或替换。 */
  transcribe(
    modelId: string,
    samples: Float32Array,
    options: { language?: string } = {},
  ): Promise<VoiceTranscriptionResult> {
    return this.enqueue(async () => {
      if (samples.length === 0) return { text: "", language: "" };
      await this.ensureLoaded(modelId);
      return this.loaded!.engine.transcribe(samples, options);
    });
  }

  unload(): Promise<void> {
    return this.enqueue(async () => {
      this.disposeLoaded();
    });
  }

  private async ensureLoaded(id: string): Promise<void> {
    if (this.loaded?.id === id) return;
    this.disposeLoaded();
    const modelPath = await this.store.getReadyModelPath(id);
    const engine = await this.loadEngine(modelPath);
    this.loaded = { id, engine };
  }

  private disposeLoaded(): void {
    this.loaded?.engine.dispose();
    this.loaded = null;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/**
 * 把渲染端送来的 16 kHz 单声道 PCM16 小端字节转换为 Float32 采样（范围 [-1, 1)）。
 * 字节长度必须是 2 的倍数，否则说明数据被截断。
 */
export function decodePcm16LeToFloat32(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 2 !== 0) {
    throw new Error("PCM16 buffer length must be even");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(bytes.byteLength / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(i * 2, true) / 32768;
  }
  return samples;
}

async function loadTranscribeCppEngine(modelPath: string): Promise<VoiceEngineModel> {
  const model = await TranscribeModel.load(modelPath);
  return {
    transcribe: async (samples, options) => {
      const result = await model.transcribe(samples, {
        language: options.language,
        timestamps: "none",
      });
      return { text: result.text.trim(), language: result.language };
    },
    dispose: () => model.dispose(),
  };
}

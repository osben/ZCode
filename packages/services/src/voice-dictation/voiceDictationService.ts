import { join } from "node:path";
import { getZCodeDataRootDir } from "../paths.js";
import {
  IVoiceDictationService,
  type VoiceModelListItem,
  type VoiceTranscriptionRequest,
  type VoiceTranscriptionResponse,
} from "./voiceDictation.js";
import { VoiceModelStore } from "./voiceModelStore.js";
import { VoiceTranscriber, decodePcm16LeToFloat32 } from "./voiceTranscriber.js";

/** 模型闲置超过该时长后卸载，释放数百 MB 的推理内存；下次转写会按需重新加载。 */
export const VOICE_MODEL_IDLE_UNLOAD_MS = 5 * 60 * 1000;

export interface VoiceDictationServiceOptions {
  store: VoiceModelStore;
  transcriber: VoiceTranscriber;
  idleUnloadMs?: number;
}

/**
 * 语音输入的 Node 实现：把模型存储与转写器组合为 RPC 面。
 * 模型状态归 VoiceModelStore、已加载模型归 VoiceTranscriber；这里只负责空闲卸载计时。
 */
export class VoiceDictationService implements IVoiceDictationService {
  private readonly store: VoiceModelStore;
  private readonly transcriber: VoiceTranscriber;
  private readonly idleUnloadMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: VoiceDictationServiceOptions) {
    this.store = options.store;
    this.transcriber = options.transcriber;
    this.idleUnloadMs = options.idleUnloadMs ?? VOICE_MODEL_IDLE_UNLOAD_MS;
  }

  listModels(): Promise<VoiceModelListItem[]> {
    return this.store.list();
  }

  downloadModel(modelId: string): Promise<void> {
    return this.store.download(modelId);
  }

  async cancelDownload(modelId: string): Promise<void> {
    this.store.cancelDownload(modelId);
  }

  async removeModel(modelId: string): Promise<void> {
    if (this.transcriber.loadedModelId === modelId) {
      await this.transcriber.unload();
    }
    await this.store.remove(modelId);
  }

  async transcribe(request: VoiceTranscriptionRequest): Promise<VoiceTranscriptionResponse> {
    this.clearIdleTimer();
    try {
      const result = await this.transcriber.transcribe(
        request.modelId,
        decodePcm16LeToFloat32(request.pcm),
        { language: normalizeLanguage(request.language) },
      );
      return { text: result.text, language: result.language };
    } finally {
      this.scheduleIdleUnload();
    }
  }

  private scheduleIdleUnload(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.transcriber.unload();
    }, this.idleUnloadMs);
    // 空闲计时器不应阻止进程退出。
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

/** `auto`、空串都交给模型自动识别；其余值按语言码透传。 */
function normalizeLanguage(language: string | undefined): string | undefined {
  const trimmed = language?.trim();
  return trimmed && trimmed !== "auto" ? trimmed : undefined;
}

export function createVoiceDictationService(): VoiceDictationService {
  const store = new VoiceModelStore({
    getModelsDir: () => join(getZCodeDataRootDir(), "voice-models"),
  });
  const transcriber = new VoiceTranscriber({ store });
  return new VoiceDictationService({ store, transcriber });
}

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { VoiceModelIdleUnloadMinutes } from "@zcode/shared";
import { getZCodeDataRootDir } from "../paths.js";
import {
  IVoiceDictationService,
  type VoiceModelListItem,
  type VoiceDictationRuntimeState,
  type VoiceTranscriptionRequest,
  type VoiceTranscriptionResponse,
  type VoiceTranscriptionPreview,
  type VoiceStreamRequest,
} from "./voiceDictation.js";
import { VoiceModelStore } from "./voiceModelStore.js";
import { VoiceTranscriber, decodePcm16LeToFloat32 } from "./voiceTranscriber.js";

/** 模型闲置超过该时长后卸载，释放数百 MB 的推理内存；下次转写会按需重新加载。 */
export const VOICE_MODEL_IDLE_UNLOAD_MS = 5 * 60 * 1000;
const logger = createServiceLogger("voice-dictation");

export interface VoiceDictationServiceOptions {
  store: VoiceModelStore;
  transcriber: VoiceTranscriber;
  idleUnloadMs?: number;
}

/**
 * 语音输入的 Node 实现：把模型存储与转写器组合为 RPC 面。
 * 模型状态归 VoiceModelStore、模型和 stream lease 归 VoiceTranscriber；本服务负责 RPC stream id 与空闲卸载。
 */
export class VoiceDictationService implements IVoiceDictationService {
  private readonly store: VoiceModelStore;
  private readonly transcriber: VoiceTranscriber;
  private idleUnloadMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private activeStreamId: string | null = null;

  constructor(options: VoiceDictationServiceOptions) {
    this.store = options.store;
    this.transcriber = options.transcriber;
    this.idleUnloadMs = options.idleUnloadMs ?? VOICE_MODEL_IDLE_UNLOAD_MS;
  }

  listModels(): Promise<VoiceModelListItem[]> {
    return this.store.list();
  }

  async getRuntimeState(): Promise<VoiceDictationRuntimeState> {
    return {
      loadedModelId: this.transcriber.loadedModelId,
      activeModelId: this.transcriber.activeModelId,
      activePhase: this.transcriber.activePhase,
    };
  }

  async setIdleUnloadMinutes(minutes: VoiceModelIdleUnloadMinutes): Promise<void> {
    this.idleUnloadMs = minutes * 60_000;
    if (this.idleTimer) this.scheduleIdleUnload();
  }

  downloadModel(modelId: string): Promise<void> {
    return this.store.download(modelId);
  }

  async cancelDownload(modelId: string): Promise<void> {
    this.store.cancelDownload(modelId);
  }

  async removeModel(modelId: string): Promise<void> {
    if (this.activeStreamId && this.transcriber.activeModelId === modelId) {
      await this.cancelStream(this.activeStreamId);
    }
    if (this.transcriber.loadedModelId === modelId || this.transcriber.activeModelId === modelId) {
      this.clearIdleTimer();
      await this.transcriber.unload();
      // A running transcription can schedule its idle timer just before queued unload completes.
      this.clearIdleTimer();
    }
    await this.store.remove(modelId);
  }

  async transcribe(request: VoiceTranscriptionRequest): Promise<VoiceTranscriptionResponse> {
    if (this.activeStreamId) {
      throw new Error("voice transcription is unavailable while a dictation stream is active");
    }
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

  async beginStream(request: VoiceStreamRequest): Promise<string | null> {
    if (this.activeStreamId) throw new Error("a voice dictation stream is already active");
    this.clearIdleTimer();
    const streamId = randomUUID();
    this.activeStreamId = streamId;
    try {
      const started = await this.transcriber.beginStream(request.modelId, {
        language: normalizeLanguage(request.language),
      });
      if (this.activeStreamId !== streamId) {
        if (started) await this.transcriber.cancelStream();
        return null;
      }
      if (!started) {
        this.activeStreamId = null;
        this.scheduleIdleUnload();
        return null;
      }
      return streamId;
    } catch (error) {
      if (this.activeStreamId === streamId) this.activeStreamId = null;
      throw error;
    }
  }

  async feedStream(streamId: string, pcm: Uint8Array): Promise<VoiceTranscriptionPreview> {
    this.assertActiveStream(streamId);
    return this.transcriber.feedStream(decodePcm16LeToFloat32(pcm));
  }

  async finalizeStream(streamId: string): Promise<VoiceTranscriptionResponse> {
    this.assertActiveStream(streamId);
    try {
      const result = await this.transcriber.finalizeStream();
      return { text: result.text, language: result.language };
    } finally {
      this.activeStreamId = null;
      this.scheduleIdleUnload();
    }
  }

  async cancelStream(streamId: string): Promise<void> {
    this.assertActiveStream(streamId);
    this.activeStreamId = null;
    try {
      await this.transcriber.cancelStream();
    } finally {
      this.scheduleIdleUnload();
    }
  }

  private scheduleIdleUnload(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.transcriber.unload().catch((error: unknown) => {
        logger.warn(undefined, "voice model idle unload failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
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

  private assertActiveStream(streamId: string): void {
    if (!this.activeStreamId || this.activeStreamId !== streamId) {
      throw new Error("voice dictation stream is not active");
    }
  }
}

/** `auto`、空串都交给模型自动识别；其余值按语言码透传。 */
function normalizeLanguage(language: string | undefined): string | undefined {
  const trimmed = language?.trim();
  return trimmed && trimmed !== "auto" ? trimmed : undefined;
}

export function createVoiceDictationService(
  options: { fetchImpl?: typeof fetch } = {},
): VoiceDictationService {
  const store = new VoiceModelStore({
    getModelsDir: () => join(getZCodeDataRootDir(), "voice-models"),
    handyModelDirs: getHandyModelDirectories(),
    // 模型下载必须走 host 统一网络栈（代理、自签证书），否则依赖代理访问 huggingface.co 的用户无法下载。
    fetchImpl: options.fetchImpl,
  });
  const transcriber = new VoiceTranscriber({ store });
  return new VoiceDictationService({ store, transcriber });
}

/** Handy's documented default model directory; custom Handy data roots are not discoverable here. */
export function getHandyModelDirectories(
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
  appData = process.env.APPDATA,
): string[] {
  if (platform === "darwin") {
    return [join(home, "Library", "Application Support", "com.pais.handy", "models")];
  }
  if (platform === "win32") {
    return appData ? [join(appData, "com.pais.handy", "models")] : [];
  }
  if (platform === "linux") {
    return [join(home, ".config", "com.pais.handy", "models")];
  }
  return [];
}

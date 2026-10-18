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
  type VoicePostProcessAvailability,
  type VoicePostProcessRequest,
  type VoicePostProcessResponse,
  type VoiceStreamRequest,
  type VoiceWarmUpRequest,
} from "./voiceDictation.js";
import { VoicePostProcessor, ZCODE_APPLE_FM_HELPER_ENV } from "./voicePostProcessor.js";
import { VoiceModelStore } from "./voiceModelStore.js";
import { VoiceTranscriber, decodePcm16LeToFloat32 } from "./voiceTranscriber.js";

/** Unloads the model after it sits idle for this long, freeing hundreds of MB of inference memory; the next transcription reloads it on demand. */
export const VOICE_MODEL_IDLE_UNLOAD_MS = 5 * 60 * 1000;
const logger = createServiceLogger("voice-dictation");

export interface VoiceDictationServiceOptions {
  store: VoiceModelStore;
  transcriber: VoiceTranscriber;
  idleUnloadMs?: number;
  /** Post-processing provider; without one the feature reports itself unavailable. */
  postProcessor?: VoicePostProcessor;
}

/**
 * Node implementation for voice input: combines the model store and transcriber into an RPC surface.
 * Model state belongs to VoiceModelStore, and models and stream leases belong to VoiceTranscriber; this service owns RPC stream IDs and idle unloading.
 */
export class VoiceDictationService implements IVoiceDictationService {
  private readonly store: VoiceModelStore;
  private readonly transcriber: VoiceTranscriber;
  private readonly postProcessor: VoicePostProcessor;
  private idleUnloadMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private activeStreamId: string | null = null;

  constructor(options: VoiceDictationServiceOptions) {
    this.store = options.store;
    this.transcriber = options.transcriber;
    this.postProcessor = options.postProcessor ?? new VoicePostProcessor({ helperPath: undefined });
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

  async warmUp(request: VoiceWarmUpRequest): Promise<void> {
    // Never load or swap a model under a live stream.
    if (this.activeStreamId) return;
    // The countdown is only touched once the load succeeded, so a failed warm-up cannot strand an
    // already loaded model without its idle timer.
    await this.transcriber.load(request.modelId);
    if (!this.activeStreamId) this.scheduleIdleUnload();
  }

  getPostProcessAvailability(): Promise<VoicePostProcessAvailability> {
    return this.postProcessor.getAvailability();
  }

  postProcess(request: VoicePostProcessRequest): Promise<VoicePostProcessResponse> {
    return this.postProcessor.postProcess(request);
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
      if (this.activeStreamId === streamId) {
        this.activeStreamId = null;
        // Inside beginStream the load may already have succeeded while stream initialization threw; the idle timer was cleared on entry,
        // so skipping the reschedule would leave the loaded native model resident in memory and bypass the idle-unload policy (same as the !started branch).
        this.scheduleIdleUnload();
      }
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
    // The idle timer must not keep the process alive.
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

/** `auto` and empty strings both defer to the model's automatic detection; other values pass through as language codes. */
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
    // Model downloads must go through the host's unified network stack (proxy, self-signed certificates); otherwise users who need a proxy to reach huggingface.co cannot download.
    fetchImpl: options.fetchImpl,
  });
  const transcriber = new VoiceTranscriber({ store });
  const postProcessor = new VoicePostProcessor({
    helperPath: process.env[ZCODE_APPLE_FM_HELPER_ENV]?.trim() || undefined,
  });
  return new VoiceDictationService({ store, transcriber, postProcessor });
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

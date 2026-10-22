import { ServiceChannels } from "@zcode/shared";
import type { VoiceModelIdleUnloadMinutes } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { VoiceModelDescriptor } from "./voiceModelCatalog.js";

export type VoiceModelState =
  | { status: "not_downloaded" }
  | { status: "downloading"; downloadedBytes: number; totalBytes: number }
  | { status: "ready"; path: string; sizeBytes: number; source: "zcode" | "handy" };

export interface VoiceModelListItem {
  descriptor: VoiceModelDescriptor;
  state: VoiceModelState;
}

export interface VoiceTranscriptionRequest {
  modelId: string;
  /** 16 kHz mono PCM16 little-endian bytes. */
  pcm: Uint8Array;
  /** Omitted or `auto` means the model detects the language automatically. */
  language?: string;
}

export interface VoiceTranscriptionResponse {
  text: string;
  language: string;
}

export interface VoiceTranscriptionPreview {
  committed: string;
  tentative: string;
}

export interface VoiceStreamRequest {
  modelId: string;
  language?: string;
}

export interface VoiceWarmUpRequest {
  modelId: string;
}

export type VoicePostProcessProvider = "apple-fm";

export type VoicePostProcessAvailability =
  | { status: "available" }
  | {
      status: "unavailable";
      reason:
        | "unsupportedPlatform"
        | "helperMissing"
        | "deviceNotEligible"
        | "appleIntelligenceNotEnabled"
        | "modelNotReady"
        | "unsupportedOS"
        | "unknown";
    };

export interface VoicePostProcessRequest {
  /** The raw transcript. */
  text: string;
  /** User prompt; `{{text}}` is replaced by the transcript (see voicePostProcessPrompt.ts). */
  prompt: string;
  /** Defaults to the only provider, the on-device system model. */
  provider?: VoicePostProcessProvider;
}

export interface VoicePostProcessResponse {
  text: string;
}

export interface VoiceDictationRuntimeState {
  loadedModelId: string | null;
  activeModelId: string | null;
  activePhase: "loading" | "transcribing" | "streaming" | null;
}

export interface IVoiceDictationService {
  listModels(): Promise<VoiceModelListItem[]>;
  getRuntimeState(): Promise<VoiceDictationRuntimeState>;
  setIdleUnloadMinutes(minutes: VoiceModelIdleUnloadMinutes): Promise<void>;
  /**
   * Loads the model in the background so the first recording does not wait for it, and restarts its
   * idle-unload countdown. A no-op while a dictation stream is active, and a silent no-op when the
   * model is not ready (not downloaded or still downloading); it rejects only for a real load failure.
   */
  warmUp(request: VoiceWarmUpRequest): Promise<void>;
  /** Whether the post-processing provider can run on this machine (and why not, when it cannot). */
  getPostProcessAvailability(): Promise<VoicePostProcessAvailability>;
  /** Rewrites a transcript with the provider; rejects on any failure so the caller can fall back to the raw text. */
  postProcess(request: VoicePostProcessRequest): Promise<VoicePostProcessResponse>;
  /** Download progress is read via listModels()'s downloading state; repeated calls for the same model share one task. */
  downloadModel(modelId: string): Promise<void>;
  cancelDownload(modelId: string): Promise<void>;
  removeModel(modelId: string): Promise<void>;
  transcribe(request: VoiceTranscriptionRequest): Promise<VoiceTranscriptionResponse>;
  /** Starts a supported local stream, or returns null when the loaded model lacks a compatible stream slot. */
  beginStream(request: VoiceStreamRequest): Promise<string | null>;
  feedStream(streamId: string, pcm: Uint8Array): Promise<VoiceTranscriptionPreview>;
  finalizeStream(streamId: string): Promise<VoiceTranscriptionResponse>;
  cancelStream(streamId: string): Promise<void>;
}

export const IVoiceDictationService = createServiceDescriptor<IVoiceDictationService>(
  ServiceChannels.VoiceDictation,
);

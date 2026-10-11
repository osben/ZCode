import { ServiceChannels } from "@zcode/shared";
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
  /** 16 kHz 单声道 PCM16 小端字节。 */
  pcm: Uint8Array;
  /** 缺省或 `auto` 表示由模型自动识别语言。 */
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

export interface VoiceDictationRuntimeState {
  loadedModelId: string | null;
  activeModelId: string | null;
  activePhase: "loading" | "transcribing" | "streaming" | null;
  idleUnloadAt: number | null;
}

export interface IVoiceDictationService {
  listModels(): Promise<VoiceModelListItem[]>;
  getRuntimeState(): Promise<VoiceDictationRuntimeState>;
  /** 下载进度通过 listModels() 的 downloading 状态读取；同一模型重复调用共享同一任务。 */
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

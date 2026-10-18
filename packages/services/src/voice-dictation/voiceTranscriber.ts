import type { FamilyExtension, Stream } from "transcribe-cpp";
import { toNativeLanguage } from "./voiceModelLanguages.js";
import type { VoiceModelStore } from "./voiceModelStore.js";
import type { VoiceTranscriptionPreview } from "./voiceDictation.js";

export interface VoiceTranscriptionResult {
  text: string;
  language: string;
}

/** Stream-slot extensions tried in order; the first one the loaded model accepts is used. */
const STREAM_FAMILY_KINDS = ["parakeet_buffered", "parakeet"] as const;
export type VoiceStreamFamilyKind = (typeof STREAM_FAMILY_KINDS)[number];

/**
 * Chooses the stream family from what the loaded model declares: none when it cannot stream, otherwise
 * the first stream extension it accepts. Hard-coding one family silently kept parakeet-unified (buffered
 * only) on the one-shot path, while Nemotron accepts only `parakeet`.
 */
export function selectStreamFamily(model: {
  supportsStreaming: boolean;
  accepts(family: { kind: VoiceStreamFamilyKind }): boolean;
}): VoiceStreamFamilyKind | null {
  if (!model.supportsStreaming) return null;
  return STREAM_FAMILY_KINDS.find((kind) => model.accepts({ kind })) ?? null;
}

export interface VoiceEngineModel {
  transcribe(
    samples: Float32Array,
    options: { language?: string },
  ): Promise<VoiceTranscriptionResult>;
  supportsStreaming?(): boolean;
  beginStream?(options: { language?: string }): Promise<boolean>;
  feedStream?(samples: Float32Array): Promise<VoiceTranscriptionPreview>;
  finalizeStream?(): Promise<VoiceTranscriptionResult>;
  cancelStream?(): void;
  dispose(): void;
}

export interface VoiceTranscriberOptions {
  store: VoiceModelStore;
  loadEngine?: (modelPath: string) => Promise<VoiceEngineModel>;
}

/**
 * Sole owner of the currently loaded model and the active stream lease. Loading, transcription, stream
 * operations, and unloading all execute serially through one queue, preventing the model from being
 * replaced or released mid-computation.
 */
export class VoiceTranscriber {
  private readonly store: VoiceModelStore;
  private readonly loadEngine: (modelPath: string) => Promise<VoiceEngineModel>;
  private loaded: { id: string; engine: VoiceEngineModel } | null = null;
  private activeModelIdValue: string | null = null;
  private activePhaseValue: "loading" | "transcribing" | "streaming" | null = null;
  private activeStreamModelId: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: VoiceTranscriberOptions) {
    this.store = options.store;
    this.loadEngine = options.loadEngine ?? loadTranscribeCppEngine;
  }

  get loadedModelId(): string | null {
    return this.loaded?.id ?? null;
  }

  get activeModelId(): string | null {
    return this.activeModelIdValue;
  }

  get activePhase(): "loading" | "transcribing" | "streaming" | null {
    return this.activePhaseValue;
  }

  load(id: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.activeStreamModelId)
        throw new Error("cannot load a model while a voice stream is active");
      // Report the load in the runtime snapshot so the UI can show a warm-up as loading.
      this.activeModelIdValue = id;
      this.activePhaseValue = "loading";
      try {
        await this.ensureLoaded(id);
      } finally {
        this.activeModelIdValue = null;
        this.activePhaseValue = null;
      }
    });
  }

  /** Loads `modelId` on demand and then transcribes; load and transcription complete within one queue item so they cannot be unloaded or swapped in between. */
  transcribe(
    modelId: string,
    samples: Float32Array,
    options: { language?: string } = {},
  ): Promise<VoiceTranscriptionResult> {
    return this.enqueue(async () => {
      if (this.activeStreamModelId) {
        throw new Error("voice transcription is unavailable while a stream is active");
      }
      if (samples.length === 0) return { text: "", language: "" };
      this.activeModelIdValue = modelId;
      this.activePhaseValue = "loading";
      try {
        await this.ensureLoaded(modelId);
        this.activePhaseValue = "transcribing";
        return await this.loaded!.engine.transcribe(samples, {
          language: toNativeLanguage(this.store.findDescriptor(modelId), options.language),
        });
      } finally {
        this.activeModelIdValue = null;
        this.activePhaseValue = null;
      }
    });
  }

  beginStream(modelId: string, options: { language?: string } = {}): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.activeStreamModelId) throw new Error("a voice dictation stream is already active");
      this.activeModelIdValue = modelId;
      this.activePhaseValue = "loading";
      try {
        await this.ensureLoaded(modelId);
        const engine = this.loaded!.engine;
        if (
          !engine.supportsStreaming?.() ||
          !engine.beginStream ||
          !engine.feedStream ||
          !engine.finalizeStream ||
          !engine.cancelStream
        ) {
          return false;
        }
        const started = await engine.beginStream({
          language: toNativeLanguage(this.store.findDescriptor(modelId), options.language),
        });
        if (!started) return false;
        this.activeStreamModelId = modelId;
        this.activePhaseValue = "streaming";
        return true;
      } finally {
        if (!this.activeStreamModelId) {
          this.activeModelIdValue = null;
          this.activePhaseValue = null;
        }
      }
    });
  }

  feedStream(samples: Float32Array): Promise<VoiceTranscriptionPreview> {
    return this.enqueue(async () => {
      const engine = this.getActiveStreamEngine();
      return engine.feedStream!(samples);
    });
  }

  finalizeStream(): Promise<VoiceTranscriptionResult> {
    return this.enqueue(async () => {
      const engine = this.getActiveStreamEngine();
      try {
        return await engine.finalizeStream!();
      } finally {
        this.clearActiveStream();
      }
    });
  }

  cancelStream(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.activeStreamModelId) return;
      try {
        this.loaded?.engine.cancelStream?.();
      } finally {
        this.clearActiveStream();
      }
    });
  }

  unload(): Promise<void> {
    return this.enqueue(async () => {
      if (this.activeStreamModelId) {
        this.loaded?.engine.cancelStream?.();
        this.clearActiveStream();
      }
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
    if (this.activeStreamModelId) this.clearActiveStream();
  }

  private getActiveStreamEngine(): VoiceEngineModel {
    if (!this.activeStreamModelId || !this.loaded?.engine.feedStream) {
      throw new Error("voice dictation stream is not active");
    }
    return this.loaded.engine;
  }

  private clearActiveStream(): void {
    this.activeStreamModelId = null;
    this.activeModelIdValue = null;
    this.activePhaseValue = null;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/**
 * Converts the renderer's 16 kHz mono PCM16 little-endian bytes into Float32 samples (range [-1, 1)).
 * The byte length must be a multiple of 2; otherwise the data was truncated.
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
  // transcribe-cpp's dependency koffi loads platform native libraries during module evaluation; the import must be deferred until a model is actually loaded,
  // otherwise hosts without the matching platform binary (remote server, CI containers) crash on the startup import chain.
  const { TranscribeModel } = await import("transcribe-cpp");
  const model = await TranscribeModel.load(modelPath);
  const session = model.createSession();
  let stream: Stream | null = null;
  const streamFamily = selectStreamFamily({
    supportsStreaming: model.capabilities.supportsStreaming,
    accepts: (family) => model.accepts(family as FamilyExtension),
  });
  const supportsStreaming = () => streamFamily !== null;
  return {
    transcribe: async (samples, options) => {
      const result = await model.transcribe(samples, {
        language: options.language,
        timestamps: "none",
      });
      return { text: result.text.trim(), language: result.language };
    },
    supportsStreaming,
    beginStream: async (options) => {
      if (!streamFamily) return false;
      stream = await session.stream({
        language: options.language,
        timestamps: "none",
        commitPolicy: "stable_prefix",
        family: { kind: streamFamily },
      });
      return true;
    },
    feedStream: async (samples) => {
      if (!stream) throw new Error("voice dictation stream is not active");
      await stream.feed(samples);
      return { ...stream.text };
    },
    finalizeStream: async () => {
      if (!stream) throw new Error("voice dictation stream is not active");
      const current = stream;
      try {
        await current.finalize();
        const result = current.snapshot;
        return { text: result.text.trim(), language: result.language };
      } finally {
        current.reset();
        stream = null;
      }
    },
    cancelStream: () => {
      stream?.reset();
      stream = null;
    },
    dispose: () => {
      stream?.reset();
      stream = null;
      session.dispose();
      model.dispose();
    },
  };
}

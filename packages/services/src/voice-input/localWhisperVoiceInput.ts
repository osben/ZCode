import { Emitter } from "@zcode/rpc";
import type { IVoiceDictationService } from "#src/voice-dictation/voiceDictation.js";
import type {
  IVoiceInputService,
  VoiceInputErrorCode,
  VoiceInputEvent,
} from "#src/voice-input/contract.js";

/**
 * Local-whisper adapter for the composer voice-input contract (specs/voice-dictation-v2.md
 * "Track F"): the upstream UI (capsule, permission guide, voice-text span) drives the fork's
 * on-device whisper engine instead of the zcode-server ASR, so dictation needs no login and no
 * audio leaves the machine.
 *
 * One session at a time, like the cloud service: a new start cancels the previous attempt.
 * Audio arriving before `started` is buffered and fed in order once the stream is live, so the
 * first words are not lost to model load. Whisper models without streaming support simply emit
 * no `result` events — the UI tolerates that (the voice text appears with `completed`).
 */
export function createLocalWhisperVoiceInput(
  voiceDictation: IVoiceDictationService,
): IVoiceInputService & { dispose(): void } {
  const emitter = new Emitter<VoiceInputEvent>();
  const onEvent = emitter.event;

  interface Session {
    attemptId: string;
    streamId: string | null;
    /** Chunks that arrived before beginStream resolved; fed in order once live. */
    pending: Uint8Array[];
    finished: boolean;
    /** Echoed to the one-shot transcribe on finish (params carry them only on start). */
    modelId: string;
    quant?: string;
    language?: string;
  }
  let session: Session | null = null;

  const emit = (attempt: Session, event: VoiceInputEvent) => {
    if (session !== attempt || attempt.finished) return;
    if (event.type === "completed" || event.type === "error") attempt.finished = true;
    emitter.fire(event);
  };

  const release = (attempt: Session) => {
    if (session === attempt) session = null;
  };

  const fail = (attempt: Session, code: Parameters<typeof mapError>[0]) => {
    emit(attempt, { attemptId: attempt.attemptId, type: "error", code: mapError(code) });
    release(attempt);
  };

  return {
    onEvent,

    async start(params) {
      const previous = session;
      if (previous) await this.cancel({ attemptId: previous.attemptId });

      const attempt: Session = {
        attemptId: params.attemptId,
        streamId: null,
        pending: [],
        finished: false,
        modelId: params.model?.modelId ?? "",
        quant: params.model?.quant,
        language: params.language,
      };
      session = attempt;
      try {
        const streamId = await voiceDictation.beginStream({
          modelId: params.model?.modelId ?? "",
          quant: params.model?.quant,
          // The fork hook sends one resolved language code (or "auto"); the cloud pair
          // zh-CN/en-US never reaches this adapter.
          language: params.language,
        });
        if (session !== attempt) return; // cancelled while loading
        if (streamId === null) {
          // The loaded model cannot stream: fall back to one-shot by keeping streamId null;
          // audio is retained by... it is not — feed the one-shot path via transcribe on finish
          // is impossible without retained audio, so buffer chunks until finish and transcribe.
          attempt.streamId = null;
          emit(attempt, { attemptId: attempt.attemptId, type: "started" });
          return;
        }
        attempt.streamId = streamId;
        emit(attempt, { attemptId: attempt.attemptId, type: "started" });
        // Feed anything captured during the load in order.
        const buffered = attempt.pending;
        attempt.pending = [];
        for (const chunk of buffered) {
          await this.sendAudio({ attemptId: attempt.attemptId, chunk });
        }
      } catch (error) {
        fail(attempt, error as unknown);
      }
    },

    async sendAudio(params) {
      const attempt = session;
      if (!attempt || attempt.attemptId !== params.attemptId) return;
      if (attempt.streamId === null) {
        // Either still loading (buffer) or a one-shot model (retain until finish).
        attempt.pending.push(params.chunk);
        return;
      }
      try {
        const preview = await voiceDictation.feedStream(attempt.streamId, params.chunk);
        if (preview.committed) {
          emit(attempt, {
            attemptId: attempt.attemptId,
            type: "result",
            text: preview.committed,
          });
        }
      } catch (error) {
        fail(attempt, error as unknown);
      }
    },

    async finish(params) {
      const attempt = session;
      if (!attempt || attempt.attemptId !== params.attemptId) return;
      try {
        let text: string;
        if (attempt.streamId !== null) {
          const result = await voiceDictation.finalizeStream(attempt.streamId);
          text = result.text;
        } else {
          // One-shot model: transcribe the retained chunks in one call.
          const merged = mergeChunks(attempt.pending);
          const result = await voiceDictation.transcribe({
            modelId: attempt.modelId,
            quant: attempt.quant,
            pcm: merged,
            language: attempt.language,
          });
          text = result.text;
        }
        emit(attempt, { attemptId: attempt.attemptId, type: "completed", text });
        release(attempt);
      } catch (error) {
        fail(attempt, error as unknown);
      }
    },

    async cancel(params) {
      const attempt = session;
      if (!attempt || attempt.attemptId !== params.attemptId) return;
      release(attempt);
      attempt.finished = true;
      if (attempt.streamId !== null) {
        try {
          await voiceDictation.cancelStream(attempt.streamId);
        } catch {
          // Cancellation is best-effort; the transcriber lease clears either way.
        }
      }
    },

    dispose() {
      session = null;
      emitter.dispose();
    },
  };
}

function mergeChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** Maps adapter-path failures onto the upstream UI failure codes (plus the fork `no_model`). */
function mapError(error: unknown): VoiceInputErrorCode {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error ?? "");
  if (/not ready|unknown voice model/i.test(message)) return "no_model";
  return "failed";
}

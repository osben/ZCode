import assert from "node:assert/strict";
import test from "node:test";
import type { IVoiceDictationService } from "../src/voice-dictation/voiceDictation.js";
import { createLocalWhisperVoiceInput } from "../src/voice-input/localWhisperVoiceInput.js";
import type { VoiceInputEvent } from "../src/voice-input/contract.js";

interface DictationCalls {
  beginStream: { modelId: string; quant?: string; language?: string }[];
  fedChunks: Uint8Array[];
  finalized: number;
  cancelled: number;
  transcribed: Uint8Array[];
}

function makeDictation(options: { stream: boolean; finalText?: string } = { stream: true }) {
  const calls: DictationCalls = {
    beginStream: [],
    fedChunks: [],
    finalized: 0,
    cancelled: 0,
    transcribed: [],
  };
  const dictation = {
    beginStream: async (request: { modelId: string; quant?: string; language?: string }) => {
      calls.beginStream.push(request);
      return options.stream ? `stream-${calls.beginStream.length}` : null;
    },
    feedStream: async (streamId: string, pcm: Uint8Array) => {
      assert.equal(streamId, "stream-1");
      calls.fedChunks.push(pcm);
      return { committed: "hello", tentative: "the" };
    },
    finalizeStream: async () => {
      calls.finalized += 1;
      return { text: options.finalText ?? "hello there", language: "en" };
    },
    cancelStream: async () => {
      calls.cancelled += 1;
    },
    transcribe: async (request: { pcm: Uint8Array }) => {
      calls.transcribed.push(request.pcm);
      return { text: options.finalText ?? "one-shot text", language: "en" };
    },
  } as unknown as IVoiceDictationService;
  return { dictation, calls };
}

function record(service: ReturnType<typeof createLocalWhisperVoiceInput>) {
  const events: VoiceInputEvent[] = [];
  service.onEvent((event) => events.push(event));
  return events;
}

test("streaming model: started, buffered audio feeds in order, result previews, completed", async () => {
  const { dictation, calls } = makeDictation({ stream: true });
  const service = createLocalWhisperVoiceInput(dictation);
  const events = record(service);

  // Audio that arrives before started is buffered and fed in order after the stream is live.
  const startPromise = service.start({
    attemptId: "a1",
    language: "uk",
    model: { modelId: "model-x", quant: "Q5_K_M" },
  });
  await service.sendAudio({ attemptId: "a1", chunk: new Uint8Array([1, 2]) });
  await startPromise;
  await service.sendAudio({ attemptId: "a1", chunk: new Uint8Array([3, 4]) });
  await service.finish({ attemptId: "a1" });

  assert.deepEqual(calls.beginStream, [{ modelId: "model-x", quant: "Q5_K_M", language: "uk" }]);
  assert.deepEqual(
    calls.fedChunks.map((chunk) => Array.from(chunk)),
    [
      [1, 2],
      [3, 4],
    ],
  );
  assert.equal(calls.finalized, 1);
  assert.equal(calls.transcribed.length, 0);
  assert.deepEqual(
    events.map((event) => event.type),
    // Both the buffered chunk and the live chunk each produce a preview snapshot.
    ["started", "result", "result", "completed"],
  );
  const completed = events.at(-1);
  assert.equal(completed?.type, "completed");
  if (completed?.type === "completed") assert.equal(completed.text, "hello there");
  service.dispose();
});

test("one-shot model: audio retained, finish transcribes it in a single call", async () => {
  const { dictation, calls } = makeDictation({ stream: false });
  const service = createLocalWhisperVoiceInput(dictation);
  const events = record(service);

  await service.start({ attemptId: "a2", language: "auto", model: { modelId: "whisper" } });
  await service.sendAudio({ attemptId: "a2", chunk: new Uint8Array([9, 9, 9]) });
  await service.finish({ attemptId: "a2" });

  assert.equal(calls.fedChunks.length, 0);
  assert.equal(calls.finalized, 0);
  assert.deepEqual(
    calls.transcribed.map((chunk) => Array.from(chunk)),
    [[9, 9, 9]],
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["started", "completed"],
  );
  service.dispose();
});

test("cancel stops the stream and emits nothing further for the attempt", async () => {
  const { dictation, calls } = makeDictation({ stream: true });
  const service = createLocalWhisperVoiceInput(dictation);
  const events = record(service);

  await service.start({ attemptId: "a3", language: "en" });
  await service.sendAudio({ attemptId: "a3", chunk: new Uint8Array([7]) });
  await service.cancel({ attemptId: "a3" });
  // A late finish after cancel must not resurrect the attempt.
  await service.finish({ attemptId: "a3" });

  assert.equal(calls.cancelled, 1);
  assert.equal(calls.finalized, 0);
  assert.deepEqual(
    events.map((event) => event.type),
    ["started", "result"],
  );
  service.dispose();
});

test("a new start cancels the previous attempt; unknown model maps to no_model", async () => {
  const { dictation, calls } = makeDictation({ stream: true });
  const service = createLocalWhisperVoiceInput(dictation);
  const events = record(service);

  await service.start({ attemptId: "a4", language: "en" });
  await service.start({ attemptId: "a5", language: "en" });

  assert.equal(calls.cancelled, 1);
  assert.deepEqual(
    events.filter((event) => event.type === "error"),
    [],
  );
  service.dispose();

  const missing = makeDictation({ stream: true });
  const failing = {
    ...missing.dictation,
    beginStream: async () => {
      throw new Error("voice model model-z is not ready (not_downloaded)");
    },
  } as unknown as IVoiceDictationService;
  const service2 = createLocalWhisperVoiceInput(failing);
  const events2 = record(service2);
  await service2.start({ attemptId: "a6", language: "en", model: { modelId: "model-z" } });
  assert.deepEqual(
    events2.map((event) => (event.type === "error" ? event.code : event.type)),
    ["no_model"],
  );
  service2.dispose();
});

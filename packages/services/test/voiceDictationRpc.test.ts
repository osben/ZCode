import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChannelClient, ChannelServer, Emitter, ProxyChannel, VSBuffer } from "@zcode/rpc";
import { IVoiceDictationService } from "../src/voice-dictation/voiceDictation.js";
import { VoiceDictationService } from "../src/voice-dictation/voiceDictationService.js";
import { VoiceModelStore } from "../src/voice-dictation/voiceModelStore.js";
import {
  VoiceTranscriber,
  type VoiceEngineModel,
} from "../src/voice-dictation/voiceTranscriber.js";
import { VOICE_MODEL_CATALOG } from "../src/voice-dictation/voiceModelCatalog.js";

test("voice dictation service round-trips PCM bytes and model list over the RPC channel", async () => {
  const dir = await mkdtemp(join(tmpdir(), "voice-rpc-test-"));
  try {
    const descriptor = VOICE_MODEL_CATALOG[0];
    const modelDir = join(dir, descriptor.id);
    await mkdir(modelDir, { recursive: true });
    await writeFile(join(modelDir, descriptor.fileName), Buffer.alloc(descriptor.sizeBytes));

    const received: Array<{ isUint8Array: boolean; length: number; language?: string }> = [];
    const engine: VoiceEngineModel = {
      transcribe: async (samples, options) => {
        received.push({ isUint8Array: true, length: samples.length, language: options.language });
        return { text: "round trip", language: "en" };
      },
      supportsStreaming: () => true,
      beginStream: async () => true,
      feedStream: async (samples) => {
        assert.equal(samples.length, 320);
        return { committed: "live ", tentative: "text" };
      },
      finalizeStream: async () => ({ text: "live text", language: "en" }),
      cancelStream: () => undefined,
      dispose: () => undefined,
    };
    const store = new VoiceModelStore({ getModelsDir: () => dir });
    const service = new VoiceDictationService({
      store,
      transcriber: new VoiceTranscriber({ store, loadEngine: async () => engine }),
      idleUnloadMs: 60_000,
    });

    // Both ends connect through an in-memory event bus, behaving like the IPC channel: messages are serialized as VSBuffer.
    const toServer = new Emitter<VSBuffer>();
    const toClient = new Emitter<VSBuffer>();
    const serverProtocol = {
      send: (buffer: VSBuffer) => toClient.fire(buffer),
      onMessage: toServer.event,
    };
    const clientProtocol = {
      send: (buffer: VSBuffer) => toServer.fire(buffer),
      onMessage: toClient.event,
    };
    // The client must subscribe before the server: ChannelServer sends the Initialize handshake immediately on construction.
    const client = new ChannelClient(clientProtocol);
    const server = new ChannelServer(serverProtocol, "test");
    server.registerChannel(
      IVoiceDictationService.channelName,
      ProxyChannel.fromService(service as unknown as Record<string, unknown>),
    );
    const remote = ProxyChannel.toService<IVoiceDictationService>(
      client.getChannel(IVoiceDictationService.channelName),
    );

    const models = await remote.listModels();
    assert.equal(
      models.find((item) => item.descriptor.id === descriptor.id)?.state.status,
      "ready",
    );

    // 320 samples = 640 bytes of PCM16; after the RPC round-trip it should still be a Uint8Array and decode fully.
    const pcm = new Uint8Array(640);
    const result = await remote.transcribe({ modelId: descriptor.id, pcm, language: "auto" });

    assert.deepEqual(result, { text: "round trip", language: "en" });
    assert.deepEqual(received, [{ isUint8Array: true, length: 320, language: undefined }]);
    const runtime = await remote.getRuntimeState();
    assert.equal(runtime.loadedModelId, descriptor.id);
    assert.equal(runtime.activeModelId, null);
    assert.equal(runtime.activePhase, null);
    assert.equal(runtime.loadedModelId, descriptor.id);
    await remote.setIdleUnloadMinutes(10);

    const streamId = await remote.beginStream({ modelId: descriptor.id, language: "en" });
    assert.ok(streamId);
    assert.deepEqual(await remote.feedStream(streamId, pcm), {
      committed: "live ",
      tentative: "text",
    });
    assert.deepEqual(await remote.finalizeStream(streamId), {
      text: "live text",
      language: "en",
    });
    assert.equal((await remote.getRuntimeState()).activePhase, null);

    server.dispose();
    client.dispose();
    await service.removeModel(descriptor.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

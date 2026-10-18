import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getHandyModelDirectories,
  VoiceDictationService,
} from "../src/voice-dictation/voiceDictationService.js";
import {
  VoiceModelDownloadError,
  VoiceModelStore,
  buildModelUrl,
} from "../src/voice-dictation/voiceModelStore.js";
import type { VoiceModelDescriptor } from "../src/voice-dictation/voiceModelCatalog.js";
import {
  VoiceTranscriber,
  decodePcm16LeToFloat32,
  selectStreamFamily,
  type VoiceEngineModel,
} from "../src/voice-dictation/voiceTranscriber.js";

const MODEL_BYTES = Buffer.from("fake-gguf-payload-".repeat(4096));
const MODEL_SHA256 = createHash("sha256").update(MODEL_BYTES).digest("hex");

function makeDescriptor(overrides: Partial<VoiceModelDescriptor> = {}): VoiceModelDescriptor {
  return {
    id: "test-model",
    name: "Test model",
    description: "fixture",
    family: "test",
    languages: ["en"],
    streaming: false,
    license: "mit",
    huggingFaceRepo: "owner/repo",
    revision: "abc123",
    fileName: "model.gguf",
    sizeBytes: MODEL_BYTES.length,
    sha256: MODEL_SHA256,
    ...overrides,
  };
}

interface FixtureServer {
  base: string;
  close: () => Promise<void>;
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<FixtureServer> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function serveModel(bytes: Buffer = MODEL_BYTES) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === `/owner/repo/resolve/abc123/model.gguf`) {
      res.writeHead(200, { "content-length": bytes.length });
      res.end(bytes);
      return;
    }
    res.writeHead(404);
    res.end();
  };
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "voice-model-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Places a file matching the directory's expected size into the models directory, skipping the network download. */
async function installFakeModel(
  modelsDir: string,
  descriptor: VoiceModelDescriptor,
): Promise<void> {
  const dir = join(modelsDir, descriptor.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, descriptor.fileName), Buffer.alloc(descriptor.sizeBytes));
}

async function listPartFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string) => {
    if (!existsSync(current)) return;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".part")) found.push(full);
    }
  };
  await walk(dir);
  return found;
}

function makeStore(
  modelsDir: string,
  options: {
    catalog?: VoiceModelDescriptor[];
    sources?: string[];
    handyModelDirs?: string[];
  } = {},
) {
  return new VoiceModelStore({
    getModelsDir: () => modelsDir,
    catalog: options.catalog ?? [makeDescriptor()],
    sources: options.sources,
    handyModelDirs: options.handyModelDirs,
  });
}

async function installHandyModel(
  modelsDir: string,
  descriptor: VoiceModelDescriptor,
  bytes: Buffer = MODEL_BYTES,
): Promise<string> {
  await mkdir(modelsDir, { recursive: true });
  const path = join(modelsDir, descriptor.fileName);
  await writeFile(path, bytes);
  return path;
}

test("buildModelUrl pins the catalog revision", () => {
  const url = buildModelUrl("https://huggingface.co/", makeDescriptor());
  assert.equal(url, "https://huggingface.co/owner/repo/resolve/abc123/model.gguf");
});

test("Handy discovery uses only its documented default directory for each desktop OS", () => {
  assert.deepEqual(getHandyModelDirectories("darwin", "/Users/example", undefined), [
    "/Users/example/Library/Application Support/com.pais.handy/models",
  ]);
  assert.deepEqual(
    getHandyModelDirectories("win32", "C:/Users/example", "C:/Users/example/AppData/Roaming"),
    ["C:/Users/example/AppData/Roaming/com.pais.handy/models"],
  );
  assert.deepEqual(getHandyModelDirectories("linux", "/home/example", undefined), [
    "/home/example/.config/com.pais.handy/models",
  ]);
  assert.deepEqual(getHandyModelDirectories("win32", "C:/Users/example", undefined), []);
});

test("download verifies sha256 and marks the model ready", async () => {
  await withTempDir(async (dir) => {
    const source = await startServer(serveModel());
    try {
      const store = makeStore(dir, { sources: [source.base] });
      assert.equal((await store.getState("test-model")).status, "not_downloaded");

      await store.download("test-model");

      assert.equal((await store.getState("test-model")).status, "ready");
      const path = await store.getReadyModelPath("test-model");
      assert.deepEqual(await readFile(path), MODEL_BYTES);
      assert.deepEqual(await listPartFiles(dir), []);
    } finally {
      await source.close();
    }
  });
});

test("discovers a matching Handy model and returns its read-only path", async () => {
  await withTempDir(async (dir) => {
    const managedDir = join(dir, "zcode");
    const handyDir = join(dir, "handy", "models");
    const descriptor = makeDescriptor();
    const handyPath = await installHandyModel(handyDir, descriptor);
    const store = makeStore(managedDir, { handyModelDirs: [handyDir] });

    assert.deepEqual(await store.getState(descriptor.id), {
      status: "ready",
      path: handyPath,
      sizeBytes: MODEL_BYTES.length,
      source: "handy",
    });
    assert.equal(await store.getReadyModelPath(descriptor.id), handyPath);
  });
});

test("does not treat a Handy file with a wrong checksum as installed", async () => {
  await withTempDir(async (dir) => {
    const handyDir = join(dir, "handy", "models");
    const descriptor = makeDescriptor();
    await installHandyModel(handyDir, descriptor, Buffer.alloc(MODEL_BYTES.length, 1));
    const store = makeStore(join(dir, "zcode"), { handyModelDirs: [handyDir] });

    assert.deepEqual(await store.getState(descriptor.id), { status: "not_downloaded" });
  });
});

test("prefers ZCode's verified model when the same model is also in Handy", async () => {
  await withTempDir(async (dir) => {
    const source = await startServer(serveModel());
    const handyDir = join(dir, "handy", "models");
    const descriptor = makeDescriptor();
    await installHandyModel(handyDir, descriptor);
    try {
      const store = makeStore(join(dir, "zcode"), {
        handyModelDirs: [handyDir],
        sources: [source.base],
      });
      await store.download(descriptor.id);

      const state = await store.getState(descriptor.id);
      assert.equal(state.status, "ready");
      if (state.status === "ready") {
        assert.equal(state.source, "zcode");
        assert.equal(state.path, join(dir, "zcode", descriptor.id, descriptor.fileName));
      }
    } finally {
      await source.close();
    }
  });
});

test("removing a model never deletes the Handy-owned file", async () => {
  await withTempDir(async (dir) => {
    const handyDir = join(dir, "handy", "models");
    const descriptor = makeDescriptor();
    const handyPath = await installHandyModel(handyDir, descriptor);
    const store = makeStore(join(dir, "zcode"), { handyModelDirs: [handyDir] });

    await store.remove(descriptor.id);

    assert.deepEqual(await readFile(handyPath), MODEL_BYTES);
    assert.equal((await store.getState(descriptor.id)).status, "ready");
  });
});

test("checksum mismatch is rejected and leaves no installed or partial file", async () => {
  await withTempDir(async (dir) => {
    const source = await startServer(serveModel());
    try {
      const store = makeStore(dir, {
        catalog: [makeDescriptor({ sha256: "0".repeat(64) })],
        sources: [source.base],
      });

      await assert.rejects(store.download("test-model"), (error: unknown) => {
        assert.ok(error instanceof VoiceModelDownloadError);
        assert.equal(error.reason, "checksum_mismatch");
        return true;
      });

      assert.equal((await store.getState("test-model")).status, "not_downloaded");
      assert.deepEqual(await listPartFiles(dir), []);
    } finally {
      await source.close();
    }
  });
});

test("size mismatch is rejected before checksum", async () => {
  await withTempDir(async (dir) => {
    const source = await startServer(serveModel());
    try {
      const store = makeStore(dir, {
        catalog: [makeDescriptor({ sizeBytes: MODEL_BYTES.length + 1 })],
        sources: [source.base],
      });

      await assert.rejects(store.download("test-model"), (error: unknown) => {
        assert.ok(error instanceof VoiceModelDownloadError);
        assert.equal(error.reason, "size_mismatch");
        return true;
      });
    } finally {
      await source.close();
    }
  });
});

test("falls back to the next source when the first returns an HTTP error", async () => {
  await withTempDir(async (dir) => {
    const broken = await startServer((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    const healthy = await startServer(serveModel());
    try {
      const store = makeStore(dir, { sources: [broken.base, healthy.base] });

      await store.download("test-model");

      assert.equal((await store.getState("test-model")).status, "ready");
    } finally {
      await broken.close();
      await healthy.close();
    }
  });
});

test("reports the last HTTP error when every source fails", async () => {
  await withTempDir(async (dir) => {
    const broken = await startServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    try {
      const store = makeStore(dir, { sources: [broken.base] });

      await assert.rejects(store.download("test-model"), (error: unknown) => {
        assert.ok(error instanceof VoiceModelDownloadError);
        assert.equal(error.reason, "http_status");
        return true;
      });
    } finally {
      await broken.close();
    }
  });
});

test("cancelling a download removes the partial file", async () => {
  await withTempDir(async (dir) => {
    const source = await startServer((req, res) => {
      if (req.url !== `/owner/repo/resolve/abc123/model.gguf`) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-length": MODEL_BYTES.length });
      // Send half the data first and keep the connection open, simulating a slow download.
      res.write(MODEL_BYTES.subarray(0, MODEL_BYTES.length / 2));
    });
    try {
      const store = makeStore(dir, { sources: [source.base] });

      const pending = store.download("test-model");
      const started = Date.now();
      while (Date.now() - started < 5000) {
        const state = await store.getState("test-model");
        if (state.status === "downloading" && state.downloadedBytes > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      store.cancelDownload("test-model");

      await assert.rejects(pending, (error: unknown) => {
        assert.ok(error instanceof VoiceModelDownloadError);
        assert.equal(error.reason, "cancelled");
        return true;
      });
      assert.equal((await store.getState("test-model")).status, "not_downloaded");
      assert.deepEqual(await listPartFiles(dir), []);
    } finally {
      await source.close();
    }
  });
});

test("concurrent download calls share one in-flight task", async () => {
  await withTempDir(async (dir) => {
    let requests = 0;
    const source = await startServer((req, res) => {
      requests += 1;
      serveModel()(req, res);
    });
    try {
      const store = makeStore(dir, { sources: [source.base] });

      const first = store.download("test-model");
      const second = store.download("test-model");
      assert.equal(first, second);
      await first;

      assert.equal(requests, 1);
    } finally {
      await source.close();
    }
  });
});

test("remove deletes an installed model", async () => {
  await withTempDir(async (dir) => {
    const source = await startServer(serveModel());
    try {
      const store = makeStore(dir, { sources: [source.base] });
      await store.download("test-model");

      await store.remove("test-model");

      assert.equal((await store.getState("test-model")).status, "not_downloaded");
    } finally {
      await source.close();
    }
  });
});

test("list reports ready and not-downloaded models", async () => {
  await withTempDir(async (dir) => {
    const catalog = [makeDescriptor({ id: "a" }), makeDescriptor({ id: "b", fileName: "b.gguf" })];
    await installFakeModel(dir, catalog[0]);
    const store = makeStore(dir, { catalog });

    const items = await store.list();

    assert.deepEqual(
      items.map((item) => [item.descriptor.id, item.state.status]),
      [
        ["a", "ready"],
        ["b", "not_downloaded"],
      ],
    );
  });
});

test("unknown model ids are rejected", async () => {
  await withTempDir(async (dir) => {
    const store = makeStore(dir);
    await assert.rejects(store.getState("missing"), /unknown voice model/);
  });
});

test("transcriber refuses to transcribe a model that is not installed", async () => {
  await withTempDir(async (dir) => {
    const transcriber = new VoiceTranscriber({
      store: makeStore(dir),
      loadEngine: async () => {
        throw new Error("should not load");
      },
    });
    await assert.rejects(
      transcriber.transcribe("test-model", new Float32Array(16)),
      /is not ready/,
    );
  });
});

test("transcriber loads on demand, serializes work and disposes on unload", async () => {
  await withTempDir(async (dir) => {
    const descriptor = makeDescriptor();
    await installFakeModel(dir, descriptor);
    const store = makeStore(dir);

    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engine: VoiceEngineModel = {
      transcribe: async (samples, options) => {
        events.push(`transcribe:start:${samples.length}:${options.language ?? "auto"}`);
        await gate;
        events.push("transcribe:end");
        return { text: "hello", language: "en" };
      },
      dispose: () => events.push("dispose"),
    };
    const transcriber = new VoiceTranscriber({
      store,
      loadEngine: async (path) => {
        events.push(`load:${path.endsWith("model.gguf")}`);
        return engine;
      },
    });

    const pending = transcriber.transcribe("test-model", new Float32Array(8), { language: "en" });
    const unloading = transcriber.unload();
    release();

    assert.deepEqual(await pending, { text: "hello", language: "en" });
    await unloading;
    assert.equal(transcriber.loadedModelId, null);
    assert.deepEqual(events, ["load:true", "transcribe:start:8:en", "transcribe:end", "dispose"]);
  });
});

test("transcriber returns empty text for empty audio without loading", async () => {
  await withTempDir(async (dir) => {
    const transcriber = new VoiceTranscriber({
      store: makeStore(dir),
      loadEngine: async () => {
        throw new Error("should not load");
      },
    });
    assert.deepEqual(await transcriber.transcribe("test-model", new Float32Array(0)), {
      text: "",
      language: "",
    });
  });
});

test("decodePcm16LeToFloat32 converts little-endian samples", () => {
  const bytes = new Uint8Array(6);
  const view = new DataView(bytes.buffer);
  view.setInt16(0, 0, true);
  view.setInt16(2, 16384, true);
  view.setInt16(4, -32768, true);

  assert.deepEqual(Array.from(decodePcm16LeToFloat32(bytes)), [0, 0.5, -1]);
});

test("decodePcm16LeToFloat32 rejects truncated buffers", () => {
  assert.throws(() => decodePcm16LeToFloat32(new Uint8Array(3)), /must be even/);
});

function makeFakeEngine(calls: Array<{ language?: string }>): VoiceEngineModel {
  return {
    transcribe: async (_samples, options) => {
      calls.push({ language: options.language });
      return { text: " hi there ", language: "en" };
    },
    dispose: () => undefined,
  };
}

test("service normalizes 'auto' to model auto-detection and decodes PCM16", async () => {
  await withTempDir(async (dir) => {
    await installFakeModel(dir, makeDescriptor());
    const calls: Array<{ language?: string }> = [];
    const service = new VoiceDictationService({
      store: makeStore(dir),
      transcriber: new VoiceTranscriber({
        store: makeStore(dir),
        loadEngine: async () => makeFakeEngine(calls),
      }),
      idleUnloadMs: 60_000,
    });

    const result = await service.transcribe({
      modelId: "test-model",
      pcm: new Uint8Array(3200),
      language: "auto",
    });

    assert.deepEqual(result, { text: " hi there ", language: "en" });
    assert.deepEqual(calls, [{ language: undefined }]);
    await service.removeModel("test-model");
  });
});

test("service passes an explicit language code through", async () => {
  await withTempDir(async (dir) => {
    await installFakeModel(dir, makeDescriptor());
    const calls: Array<{ language?: string }> = [];
    const store = makeStore(dir);
    const service = new VoiceDictationService({
      store,
      transcriber: new VoiceTranscriber({ store, loadEngine: async () => makeFakeEngine(calls) }),
      idleUnloadMs: 60_000,
    });

    await service.transcribe({ modelId: "test-model", pcm: new Uint8Array(2), language: "ru" });

    assert.deepEqual(calls, [{ language: "ru" }]);
    await service.removeModel("test-model");
  });
});

test("service streams ordered PCM updates and finalizes one transcript", async () => {
  await withTempDir(async (dir) => {
    const descriptor = makeDescriptor({ family: "parakeet", streaming: true });
    await installFakeModel(dir, descriptor);
    const store = makeStore(dir, { catalog: [descriptor] });
    const seen: number[] = [];
    const engine: VoiceEngineModel = {
      transcribe: async () => ({ text: "one-shot", language: "en" }),
      supportsStreaming: () => true,
      beginStream: async (options) => {
        assert.equal(options.language, "en");
        return true;
      },
      feedStream: async (samples) => {
        seen.push(samples.length);
        return { committed: "hello ", tentative: "there" };
      },
      finalizeStream: async () => ({ text: "hello there", language: "en" }),
      cancelStream: () => undefined,
      dispose: () => undefined,
    };
    const service = new VoiceDictationService({
      store,
      transcriber: new VoiceTranscriber({ store, loadEngine: async () => engine }),
      idleUnloadMs: 60_000,
    });

    const streamId = await service.beginStream({ modelId: descriptor.id, language: "en" });
    assert.ok(streamId);
    assert.equal((await service.getRuntimeState()).activePhase, "streaming");
    assert.deepEqual(await service.feedStream(streamId, new Uint8Array(640)), {
      committed: "hello ",
      tentative: "there",
    });
    assert.deepEqual(seen, [320]);
    assert.deepEqual(await service.finalizeStream(streamId), {
      text: "hello there",
      language: "en",
    });
    assert.equal((await service.getRuntimeState()).activeModelId, null);
    assert.equal((await service.getRuntimeState()).loadedModelId, descriptor.id);
    await service.removeModel(descriptor.id);
  });
});

test("service declines streaming when the loaded runtime does not support it", async () => {
  await withTempDir(async (dir) => {
    const descriptor = makeDescriptor({ family: "parakeet", streaming: true });
    await installFakeModel(dir, descriptor);
    const store = makeStore(dir, { catalog: [descriptor] });
    const calls: Array<{ language?: string }> = [];
    const service = new VoiceDictationService({
      store,
      transcriber: new VoiceTranscriber({ store, loadEngine: async () => makeFakeEngine(calls) }),
      idleUnloadMs: 60_000,
    });

    assert.equal(await service.beginStream({ modelId: descriptor.id }), null);
    assert.deepEqual(await service.transcribe({ modelId: descriptor.id, pcm: new Uint8Array(2) }), {
      text: " hi there ",
      language: "en",
    });
    assert.deepEqual(calls, [{ language: undefined }]);
    await service.removeModel(descriptor.id);
  });
});

test("beginStream failure reschedules idle unload so a loaded model is not left resident", async () => {
  await withTempDir(async (dir) => {
    const descriptor = makeDescriptor({ family: "parakeet", streaming: true });
    await installFakeModel(dir, descriptor);
    const store = makeStore(dir, { catalog: [descriptor] });
    let disposeCount = 0;
    const engine: VoiceEngineModel = {
      ...makeFakeEngine([]),
      supportsStreaming: () => true,
      // Load succeeded (ensureLoaded finished) and only then stream init failed: exactly the path the catch branch must cover.
      // Полная стрим-поверхность обязательна, иначе транскрайбер отклонит streaming до вызова beginStream.
      beginStream: async () => {
        throw new Error("stream slot init failed");
      },
      feedStream: async () => ({ committed: "", tentative: "" }),
      finalizeStream: async () => ({ text: "", language: "" }),
      cancelStream: () => undefined,
      dispose: () => {
        disposeCount += 1;
      },
    };
    const service = new VoiceDictationService({
      store,
      transcriber: new VoiceTranscriber({ store, loadEngine: async () => engine }),
      idleUnloadMs: 5,
    });

    await assert.rejects(
      service.beginStream({ modelId: descriptor.id }),
      /stream slot init failed/,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(disposeCount, 1);
  });
});

test("service rejects overlapping stream ownership and stale stream ids", async () => {
  await withTempDir(async (dir) => {
    const descriptor = makeDescriptor({ family: "parakeet", streaming: true });
    await installFakeModel(dir, descriptor);
    const store = makeStore(dir, { catalog: [descriptor] });
    const engine: VoiceEngineModel = {
      ...makeFakeEngine([]),
      supportsStreaming: () => true,
      beginStream: async () => true,
      feedStream: async () => ({ committed: "", tentative: "" }),
      finalizeStream: async () => ({ text: "done", language: "en" }),
      cancelStream: () => undefined,
    };
    const service = new VoiceDictationService({
      store,
      transcriber: new VoiceTranscriber({ store, loadEngine: async () => engine }),
      idleUnloadMs: 60_000,
    });

    const streamId = await service.beginStream({ modelId: descriptor.id });
    assert.ok(streamId);
    await assert.rejects(service.beginStream({ modelId: descriptor.id }), /already active/);
    await assert.rejects(
      service.transcribe({ modelId: descriptor.id, pcm: new Uint8Array(2) }),
      /stream is active/,
    );
    await assert.rejects(service.feedStream("stale-stream", new Uint8Array(2)), /not active/);
    await service.cancelStream(streamId);
    assert.equal((await service.getRuntimeState()).activeModelId, null);
    await service.removeModel(descriptor.id);
  });
});

test("removing a model while its stream is starting leaves no stale stream lease", async () => {
  await withTempDir(async (dir) => {
    const descriptor = makeDescriptor({ family: "parakeet", streaming: true });
    await installFakeModel(dir, descriptor);
    const store = makeStore(dir, { catalog: [descriptor] });
    let markBeginStarted!: () => void;
    let releaseBegin!: () => void;
    const beginStarted = new Promise<void>((resolve) => {
      markBeginStarted = resolve;
    });
    const beginGate = new Promise<void>((resolve) => {
      releaseBegin = resolve;
    });
    const engine: VoiceEngineModel = {
      ...makeFakeEngine([]),
      supportsStreaming: () => true,
      beginStream: async () => {
        markBeginStarted();
        await beginGate;
        return true;
      },
      feedStream: async () => ({ committed: "", tentative: "" }),
      finalizeStream: async () => ({ text: "done", language: "en" }),
      cancelStream: () => undefined,
    };
    const service = new VoiceDictationService({
      store,
      transcriber: new VoiceTranscriber({ store, loadEngine: async () => engine }),
      idleUnloadMs: 60_000,
    });

    const starting = service.beginStream({ modelId: descriptor.id });
    await beginStarted;
    const removing = service.removeModel(descriptor.id);
    releaseBegin();

    assert.equal(await starting, null);
    await removing;
    assert.deepEqual(await service.getRuntimeState(), {
      loadedModelId: null,
      activeModelId: null,
      activePhase: null,
    });
  });
});

test("service unloads an idle model after the configured timeout", async () => {
  await withTempDir(async (dir) => {
    await installFakeModel(dir, makeDescriptor());
    const store = makeStore(dir);
    const transcriber = new VoiceTranscriber({
      store,
      loadEngine: async () => makeFakeEngine([]),
    });
    const service = new VoiceDictationService({ store, transcriber, idleUnloadMs: 20 });

    await service.transcribe({ modelId: "test-model", pcm: new Uint8Array(2) });
    assert.equal(transcriber.loadedModelId, "test-model");
    const runtimeBeforeExpiry = await service.getRuntimeState();
    assert.equal(runtimeBeforeExpiry.loadedModelId, "test-model");
    assert.equal(runtimeBeforeExpiry.activeModelId, null);
    assert.equal(runtimeBeforeExpiry.activePhase, null);

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(transcriber.loadedModelId, null);
    assert.deepEqual(await service.getRuntimeState(), {
      loadedModelId: null,
      activeModelId: null,
      activePhase: null,
    });
  });
});

test("changing the idle-unload delay reschedules the current idle model", async () => {
  await withTempDir(async (dir) => {
    await installFakeModel(dir, makeDescriptor());
    const store = makeStore(dir);
    const transcriber = new VoiceTranscriber({
      store,
      loadEngine: async () => makeFakeEngine([]),
    });
    const service = new VoiceDictationService({ store, transcriber, idleUnloadMs: 20 });

    await service.transcribe({ modelId: "test-model", pcm: new Uint8Array(2) });
    await service.setIdleUnloadMinutes(1);
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(transcriber.loadedModelId, "test-model");
    await service.removeModel("test-model");
  });
});

test("service runtime state identifies the model while transcription is active", async () => {
  await withTempDir(async (dir) => {
    await installFakeModel(dir, makeDescriptor());
    const store = makeStore(dir);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let markLoadingStarted!: () => void;
    const loadingStarted = new Promise<void>((resolve) => {
      markLoadingStarted = resolve;
    });
    let finishLoading!: () => void;
    const loading = new Promise<void>((resolve) => {
      finishLoading = resolve;
    });
    let finishTranscription!: () => void;
    const paused = new Promise<void>((resolve) => {
      finishTranscription = resolve;
    });
    const service = new VoiceDictationService({
      store,
      transcriber: new VoiceTranscriber({
        store,
        loadEngine: async () => {
          markLoadingStarted();
          await loading;
          return {
            transcribe: async () => {
              markStarted();
              await paused;
              return { text: "done", language: "en" };
            },
            dispose: () => undefined,
          };
        },
      }),
      idleUnloadMs: 60_000,
    });

    assert.deepEqual(await service.getRuntimeState(), {
      loadedModelId: null,
      activeModelId: null,
      activePhase: null,
    });

    const pending = service.transcribe({ modelId: "test-model", pcm: new Uint8Array(2) });
    await loadingStarted;
    assert.deepEqual(await service.getRuntimeState(), {
      loadedModelId: null,
      activeModelId: "test-model",
      activePhase: "loading",
    });

    finishLoading();
    await started;
    assert.deepEqual(await service.getRuntimeState(), {
      loadedModelId: "test-model",
      activeModelId: "test-model",
      activePhase: "transcribing",
    });

    finishTranscription();
    await pending;
    assert.equal((await service.getRuntimeState()).activeModelId, null);
    await service.removeModel("test-model");
  });
});

test("service removes a loaded model by unloading it first", async () => {
  await withTempDir(async (dir) => {
    await installFakeModel(dir, makeDescriptor());
    const store = makeStore(dir);
    const transcriber = new VoiceTranscriber({
      store,
      loadEngine: async () => makeFakeEngine([]),
    });
    const service = new VoiceDictationService({ store, transcriber, idleUnloadMs: 60_000 });
    await service.transcribe({ modelId: "test-model", pcm: new Uint8Array(2) });

    await service.removeModel("test-model");

    assert.equal(transcriber.loadedModelId, null);
    assert.deepEqual(await service.getRuntimeState(), {
      loadedModelId: null,
      activeModelId: null,
      activePhase: null,
    });
    assert.equal((await store.getState("test-model")).status, "not_downloaded");
  });
});

// Real-model end-to-end verification: requires an explicitly provided downloaded GGUF and a 16 kHz mono WAV; skipped otherwise.
const e2eModelPath = process.env.ZCODE_VOICE_E2E_MODEL;
const e2eWavPath = process.env.ZCODE_VOICE_E2E_WAV;
test(
  "real whisper-tiny transcribes a sample utterance",
  {
    skip:
      !e2eModelPath || !e2eWavPath ? "set ZCODE_VOICE_E2E_MODEL and ZCODE_VOICE_E2E_WAV" : false,
  },
  async () => {
    const samples = decodeWavToFloat32(await readFile(e2eWavPath!));
    const { TranscribeModel } = await import("transcribe-cpp");
    const model = await TranscribeModel.load(e2eModelPath!);
    try {
      const result = await model.transcribe(samples, { timestamps: "none" });
      assert.match(result.text.toLowerCase(), /fellow americans/);
      assert.equal(result.language, "en");
    } finally {
      model.dispose();
    }
  },
);

function decodeWavToFloat32(buffer: Buffer): Float32Array {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "data") {
      const start = offset + 8;
      const count = Math.min(size, buffer.length - start) / 2;
      const out = new Float32Array(count);
      for (let i = 0; i < count; i += 1) out[i] = buffer.readInt16LE(start + i * 2) / 32768;
      return out;
    }
    offset += 8 + size + (size & 1);
  }
  throw new Error("WAV data chunk not found");
}

const fakeFamilyModel = (supportsStreaming: boolean, accepted: readonly string[]) => ({
  supportsStreaming,
  accepts: (family: { kind: string }) => accepted.includes(family.kind),
});

test("selectStreamFamily picks the family each runtime-probed model declares", () => {
  // Observed with transcribe-cpp 0.3.1: parakeet-unified accepts only parakeet_buffered.
  assert.equal(
    selectStreamFamily(fakeFamilyModel(true, ["parakeet_buffered"])),
    "parakeet_buffered",
  );
  // Observed: both Nemotron streaming models accept only the parakeet extension.
  assert.equal(selectStreamFamily(fakeFamilyModel(true, ["parakeet"])), "parakeet");
  assert.equal(
    selectStreamFamily(fakeFamilyModel(true, ["parakeet", "parakeet_buffered"])),
    "parakeet_buffered",
  );
});

test("selectStreamFamily stays one-shot when the model cannot stream or accepts no family", () => {
  // Observed: parakeet-tdt and canary report supportsStreaming false and accept neither family.
  assert.equal(selectStreamFamily(fakeFamilyModel(false, [])), null);
  assert.equal(selectStreamFamily(fakeFamilyModel(false, ["parakeet"])), null);
  assert.equal(selectStreamFamily(fakeFamilyModel(true, ["voxtral"])), null);
});

test("transcriber resolves the engine language from the model's locale map for one-shot and streams", async () => {
  await withTempDir(async (dir) => {
    const descriptor = makeDescriptor({
      streaming: true,
      languages: ["uk", "ru", "en"],
      languageLocales: { uk: "uk-UA", ru: "ru-RU", en: "en-US" },
    });
    await installFakeModel(dir, descriptor);
    const store = makeStore(dir, { catalog: [descriptor] });
    const seen: Array<string | undefined> = [];
    const engine: VoiceEngineModel = {
      transcribe: async (_samples, options) => {
        seen.push(options.language);
        return { text: "x", language: "uk" };
      },
      supportsStreaming: () => true,
      beginStream: async (options) => {
        seen.push(options.language);
        return true;
      },
      feedStream: async () => ({ committed: "", tentative: "" }),
      finalizeStream: async () => ({ text: "x", language: "uk" }),
      cancelStream: () => undefined,
      dispose: () => undefined,
    };
    const transcriber = new VoiceTranscriber({ store, loadEngine: async () => engine });
    const samples = new Float32Array(160);

    await transcriber.transcribe(descriptor.id, samples, { language: "uk" });
    await transcriber.transcribe(descriptor.id, samples, {});
    assert.equal(await transcriber.beginStream(descriptor.id, { language: "ru" }), true);
    await transcriber.cancelStream();
    assert.equal(await transcriber.beginStream(descriptor.id, {}), true);
    await transcriber.cancelStream();

    assert.deepEqual(seen, ["uk-UA", undefined, "ru-RU", undefined]);
    await transcriber.unload();
  });
});

test("transcriber passes bare codes through for models without a locale map", async () => {
  await withTempDir(async (dir) => {
    const descriptor = makeDescriptor();
    await installFakeModel(dir, descriptor);
    const store = makeStore(dir, { catalog: [descriptor] });
    const calls: Array<{ language?: string }> = [];
    const transcriber = new VoiceTranscriber({
      store,
      loadEngine: async () => makeFakeEngine(calls),
    });
    await transcriber.transcribe(descriptor.id, new Float32Array(160), { language: "uk" });
    assert.deepEqual(calls, [{ language: "uk" }]);
    await transcriber.unload();
  });
});

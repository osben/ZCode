import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VoiceDictationService } from "../src/voice-dictation/voiceDictationService.js";
import {
  VoiceModelDownloadError,
  VoiceModelStore,
  buildModelUrl,
} from "../src/voice-dictation/voiceModelStore.js";
import type { VoiceModelDescriptor } from "../src/voice-dictation/voiceModelCatalog.js";
import {
  VoiceTranscriber,
  decodePcm16LeToFloat32,
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
    languageCount: 1,
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

/** 在模型目录中放置一个与目录大小一致的文件，跳过网络下载。 */
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
  options: { catalog?: VoiceModelDescriptor[]; sources?: string[] } = {},
) {
  return new VoiceModelStore({
    getModelsDir: () => modelsDir,
    catalog: options.catalog ?? [makeDescriptor()],
    sources: options.sources,
  });
}

test("buildModelUrl pins the catalog revision", () => {
  const url = buildModelUrl("https://huggingface.co/", makeDescriptor());
  assert.equal(url, "https://huggingface.co/owner/repo/resolve/abc123/model.gguf");
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
      // 先发送一半数据并保持连接，模拟慢速下载。
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

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(transcriber.loadedModelId, null);
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
    assert.equal((await store.getState("test-model")).status, "not_downloaded");
  });
});

// 真实模型端到端验证：需要显式提供已下载的 GGUF 与 16 kHz 单声道 WAV，否则跳过。
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

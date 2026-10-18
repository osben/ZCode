import { describe, expect, it, vi } from "vitest";
import {
  FileSystemPortError,
  LSP_PREFERENCES_FILE_NAME,
  type FileSystemPort,
  type Logger,
} from "@zcode/contracts";
import { createLspPreferencesStore } from "../src/app/lsp-preferences.js";

const ROOT = "/storage/cli";
const FILE = `${ROOT}/${LSP_PREFERENCES_FILE_NAME}`;

interface FakeFs {
  files: Map<string, string>;
  writes: Array<{ path: string; content: string; atomic?: boolean; createParents?: boolean }>;
  readTextFile: ReturnType<typeof vi.fn>;
  writeTextFile: ReturnType<typeof vi.fn>;
}

function createFakeFs(initial?: string): FakeFs {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set(FILE, initial);
  const writes: FakeFs["writes"] = [];
  const fs: FakeFs = {
    files,
    writes,
    readTextFile: vi.fn(async ({ path }: { path: string }) => {
      const content = files.get(path);
      if (content === undefined) {
        throw new FileSystemPortError({ code: "not_found", path, message: "missing" });
      }
      return { path, content, encoding: "utf8", bytesRead: content.length, sizeBytes: content.length, truncated: false };
    }),
    writeTextFile: vi.fn(async (request: { path: string; content: string; atomic?: boolean; createParents?: boolean }) => {
      writes.push(request);
      files.set(request.path, request.content);
      return { path: request.path, bytesWritten: request.content.length };
    }),
  };
  return fs;
}

function createLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
}

function storeWith(fs: FakeFs, logger?: Logger) {
  return createLspPreferencesStore({
    fileSystem: fs as unknown as FileSystemPort,
    cliStorageRoot: ROOT,
    logger,
  });
}

describe("LspPreferencesStore", () => {
  it("returns defaults silently when the sidecar is missing", async () => {
    const fs = createFakeFs();
    const logger = createLogger();
    const store = storeWith(fs, logger);

    await expect(store.load()).resolves.toEqual({
      version: 1,
      enabled: true,
      diagnosticsAfterEdit: {},
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("falls back to defaults with a warning for invalid JSON and schema mismatches", async () => {
    for (const content of ["{not json", JSON.stringify({ version: 2, enabled: false })]) {
      const fs = createFakeFs(content);
      const logger = createLogger();
      const store = storeWith(fs, logger);

      await expect(store.load()).resolves.toMatchObject({ enabled: true, diagnosticsAfterEdit: {} });
      expect(logger.warn).toHaveBeenCalledTimes(1);
    }
  });

  it("does not throw when the file cannot be read", async () => {
    const fs = createFakeFs();
    fs.readTextFile.mockRejectedValueOnce(
      new FileSystemPortError({ code: "permission_denied", path: FILE, message: "denied" }),
    );
    const logger = createLogger();
    const store = storeWith(fs, logger);

    await expect(store.load()).resolves.toMatchObject({ enabled: true });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("loads a valid sidecar", async () => {
    const fs = createFakeFs(
      JSON.stringify({ version: 1, enabled: false, diagnosticsAfterEdit: { "p/ts": false } }),
    );
    const store = storeWith(fs);

    await expect(store.load()).resolves.toEqual({
      version: 1,
      enabled: false,
      diagnosticsAfterEdit: { "p/ts": false },
    });
    expect(store.get().enabled).toBe(false);
  });

  it("merges patches, removes overrides on null, and writes atomically", async () => {
    const fs = createFakeFs(
      JSON.stringify({ version: 1, enabled: true, diagnosticsAfterEdit: { "p/ts": false, "p/py": true } }),
    );
    const store = storeWith(fs);
    await store.load();

    const next = await store.update({
      diagnosticsAfterEdit: { "p/ts": null, "p/go": false },
    });

    expect(next).toEqual({
      version: 1,
      enabled: true,
      diagnosticsAfterEdit: { "p/py": true, "p/go": false },
    });
    expect(store.get()).toEqual(next);
    expect(fs.writes).toHaveLength(1);
    expect(fs.writes[0]).toMatchObject({
      path: FILE,
      atomic: true,
      createParents: true,
    });
    expect(JSON.parse(fs.writes[0]!.content)).toEqual(next);
  });

  it("serializes concurrent updates so each patch merges onto the previous result", async () => {
    const fs = createFakeFs();
    const store = storeWith(fs);
    await store.load();

    const writeOrder: string[] = [];
    const originalWrite = fs.writeTextFile.getMockImplementation()!;
    fs.writeTextFile.mockImplementation(async (request) => {
      const parsed = JSON.parse(request.content) as { enabled: boolean };
      writeOrder.push(`start:${parsed.enabled}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const result = await originalWrite(request);
      writeOrder.push(`end:${parsed.enabled}`);
      return result;
    });

    const first = store.update({ enabled: false, diagnosticsAfterEdit: { "p/ts": false } });
    const second = store.update({ enabled: true });
    const [a, b] = await Promise.all([first, second]);

    expect(writeOrder).toEqual(["start:false", "end:false", "start:true", "end:true"]);
    expect(a.diagnosticsAfterEdit).toEqual({ "p/ts": false });
    expect(b).toEqual({ version: 1, enabled: true, diagnosticsAfterEdit: { "p/ts": false } });
  });

  it("keeps the previous state when a write fails and notifies subscribers only on success", async () => {
    const fs = createFakeFs();
    const store = storeWith(fs);
    await store.load();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    fs.writeTextFile.mockRejectedValueOnce(new Error("disk full"));
    await expect(store.update({ enabled: false })).rejects.toThrow("disk full");
    expect(store.get().enabled).toBe(true);
    expect(listener).not.toHaveBeenCalled();

    await store.update({ enabled: false });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0]).toMatchObject({ enabled: false });

    unsubscribe();
    await store.update({ enabled: true });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("LspPreferencesStore update without a prior load", () => {
  // Regression: update() merged the patch onto the in-memory defaults when load() had not run in this
  // process, so a stored `enabled: false` and per-server overrides were overwritten on disk.
  it("merges the patch onto the stored sidecar, keeping fields the patch does not mention", async () => {
    const stored = JSON.stringify({
      version: 1,
      enabled: false,
      diagnosticsAfterEdit: { "p/ts": false, "p/py": true },
    });
    const fs = createFakeFs(stored);
    const store = storeWith(fs);

    const next = await store.update({ diagnosticsAfterEdit: { "p/go": false } });

    expect(next).toEqual({
      version: 1,
      enabled: false,
      diagnosticsAfterEdit: { "p/ts": false, "p/py": true, "p/go": false },
    });
    expect(JSON.parse(fs.files.get(FILE)!)).toEqual(next);
  });

  it("fails the write instead of replacing an unreadable sidecar with defaults", async () => {
    const fs = createFakeFs("{}");
    fs.readTextFile.mockRejectedValueOnce(new Error("EACCES"));
    const store = storeWith(fs);

    await expect(store.update({ enabled: false })).rejects.toThrow("EACCES");
    expect(fs.writeTextFile).not.toHaveBeenCalled();
  });
});

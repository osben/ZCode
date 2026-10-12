import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  VOICE_MODEL_CATALOG,
  findVoiceModelDescriptor,
  type VoiceModelDescriptor,
} from "./voiceModelCatalog.js";
import type { VoiceModelListItem, VoiceModelState } from "./voiceDictation.js";

const logger = createServiceLogger("voice-dictation");

export const DEFAULT_VOICE_MODEL_SOURCES: readonly string[] = ["https://huggingface.co"];

export type VoiceModelDownloadFailureReason =
  | "cancelled"
  | "http_status"
  | "network"
  | "size_mismatch"
  | "checksum_mismatch";

export class VoiceModelDownloadError extends Error {
  constructor(
    readonly reason: VoiceModelDownloadFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "VoiceModelDownloadError";
  }
}

export interface VoiceModelStoreOptions {
  /** Model root directory; re-evaluated on each access to follow data-directory setting changes. */
  getModelsDir: () => string;
  /** Read-only model roots owned by another application. */
  handyModelDirs?: readonly string[];
  catalog?: readonly VoiceModelDescriptor[];
  /** Download sources, tried in order; each source's URL looks like `${source}/${repo}/resolve/${revision}/${file}`. */
  sources?: readonly string[];
  fetchImpl?: typeof fetch;
}

interface ActiveDownload {
  controller: AbortController;
  downloadedBytes: number;
  totalBytes: number;
  promise: Promise<void>;
}

/**
 * Sole state owner for voice models: installed files on disk and in-progress downloads are maintained only here.
 * Files are written to `.part` first and atomically renamed to the final name only after size and sha256 verification, so the `ready` state always refers to a complete file.
 */
export class VoiceModelStore {
  private readonly getModelsDir: () => string;
  private readonly catalog: readonly VoiceModelDescriptor[];
  private readonly handyModelDirs: readonly string[];
  private readonly sources: readonly string[];
  private readonly fetchImpl: typeof fetch;
  private readonly active = new Map<string, ActiveDownload>();
  private readonly handyHashCache = new Map<string, Promise<string>>();

  constructor(options: VoiceModelStoreOptions) {
    this.getModelsDir = options.getModelsDir;
    this.handyModelDirs = options.handyModelDirs ?? [];
    this.catalog = options.catalog ?? VOICE_MODEL_CATALOG;
    this.sources = options.sources ?? DEFAULT_VOICE_MODEL_SOURCES;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async list(): Promise<VoiceModelListItem[]> {
    return Promise.all(
      this.catalog.map(async (descriptor) => ({
        descriptor,
        state: await this.getState(descriptor.id),
      })),
    );
  }

  async getState(id: string): Promise<VoiceModelState> {
    const descriptor = this.requireDescriptor(id);
    const inFlight = this.active.get(id);
    if (inFlight) {
      return {
        status: "downloading",
        downloadedBytes: inFlight.downloadedBytes,
        totalBytes: inFlight.totalBytes,
      };
    }
    const path = this.modelFilePath(descriptor);
    try {
      const info = await stat(path);
      // The listing only checks size; full sha256 was verified at download time, avoiding reading hundreds of MB every time settings opens.
      if (info.isFile() && info.size === descriptor.sizeBytes) {
        return { status: "ready", path, sizeBytes: info.size, source: "zcode" };
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    for (const handyDir of this.handyModelDirs) {
      const handyPath = join(handyDir, descriptor.fileName);
      try {
        const info = await stat(handyPath);
        if (!info.isFile() || info.size !== descriptor.sizeBytes) continue;

        const cacheKey = `${handyPath}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;
        let digest = this.handyHashCache.get(cacheKey);
        if (!digest) {
          digest = hashFileSha256(handyPath);
          this.handyHashCache.set(cacheKey, digest);
        }
        try {
          const verified = (await digest) === descriptor.sha256;
          const latestInfo = await stat(handyPath);
          if (verified && sameFileVersion(info, latestInfo)) {
            return {
              status: "ready",
              path: handyPath,
              sizeBytes: info.size,
              source: "handy",
            };
          }
        } catch (error) {
          this.handyHashCache.delete(cacheKey);
          if (!isNotFound(error)) throw error;
        }
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    return { status: "not_downloaded" };
  }

  /** Returns the installed model's file path; throws when the model is not ready, so callers should download first. */
  async getReadyModelPath(id: string): Promise<string> {
    const state = await this.getState(id);
    if (state.status !== "ready") {
      throw new Error(`voice model ${id} is not ready (${state.status})`);
    }
    return state.path;
  }

  /** Concurrent calls for the same model share a single download task. */
  download(id: string): Promise<void> {
    const descriptor = this.requireDescriptor(id);
    const inFlight = this.active.get(id);
    if (inFlight) return inFlight.promise;

    const controller = new AbortController();
    const entry: ActiveDownload = {
      controller,
      downloadedBytes: 0,
      totalBytes: descriptor.sizeBytes,
      promise: Promise.resolve(),
    };
    entry.promise = this.runDownload(descriptor, entry).finally(() => {
      if (this.active.get(id) === entry) this.active.delete(id);
    });
    this.active.set(id, entry);
    return entry.promise;
  }

  cancelDownload(id: string): void {
    this.active.get(id)?.controller.abort();
  }

  /** Removes installed files; cancels and waits for an in-progress download first. */
  async remove(id: string): Promise<void> {
    const descriptor = this.requireDescriptor(id);
    const inFlight = this.active.get(id);
    if (inFlight) {
      inFlight.controller.abort();
      await inFlight.promise.catch(() => undefined);
    }
    await rm(this.modelDir(descriptor), { recursive: true, force: true });
    logger.info(undefined, "voice model removed", { id });
  }

  private async runDownload(
    descriptor: VoiceModelDescriptor,
    entry: ActiveDownload,
  ): Promise<void> {
    const dir = this.modelDir(descriptor);
    const finalPath = this.modelFilePath(descriptor);
    // Each download task uses a unique temp name: different windows each own a VoiceModelStore process, and sharing `${finalPath}.part`
    // would overwrite each other's bytes, while one side's failure cleanup would delete the other's half-written file and break the rename.
    const partPath = `${finalPath}.${randomUUID()}.part`;
    await mkdir(dir, { recursive: true });

    let lastError: unknown;
    for (const source of this.sources) {
      if (entry.controller.signal.aborted) break;
      const url = buildModelUrl(source, descriptor);
      try {
        await this.fetchToPartFile(url, partPath, descriptor, entry);
        try {
          await rename(partPath, finalPath);
        } catch (error) {
          // Another window's VoiceModelStore process may just have verified and installed the same model; Windows
          // rename does not overwrite an existing target. When the target is already a same-size file (sha256-verified
          // at download time), treat it as success and clean up this task's leftover .part instead of reporting a false failure.
          const installed = await stat(finalPath).then(
            (info) => info.isFile() && info.size === descriptor.sizeBytes,
            () => false,
          );
          if (!installed) throw error;
          await rm(partPath, { force: true });
        }
        logger.info(undefined, "voice model downloaded", { id: descriptor.id, source });
        return;
      } catch (error) {
        lastError = error;
        // Files that fail verification are always discarded; erroneous content must never remain at the final path.
        await rm(partPath, { force: true });
        if (error instanceof VoiceModelDownloadError && error.reason === "cancelled") break;
        logger.warn(undefined, "voice model download source failed", {
          id: descriptor.id,
          source,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (lastError instanceof VoiceModelDownloadError) throw lastError;
    if (entry.controller.signal.aborted) {
      throw new VoiceModelDownloadError("cancelled", `download of ${descriptor.id} was cancelled`);
    }
    throw new VoiceModelDownloadError(
      "network",
      `download of ${descriptor.id} failed from all sources: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  private async fetchToPartFile(
    url: string,
    partPath: string,
    descriptor: VoiceModelDescriptor,
    entry: ActiveDownload,
  ): Promise<void> {
    const signal = entry.controller.signal;
    entry.downloadedBytes = 0;

    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal, redirect: "follow" });
    } catch (error) {
      if (signal.aborted) {
        throw new VoiceModelDownloadError(
          "cancelled",
          `download of ${descriptor.id} was cancelled`,
        );
      }
      throw new VoiceModelDownloadError(
        "network",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!response.ok || !response.body) {
      throw new VoiceModelDownloadError("http_status", `HTTP ${response.status} for ${url}`);
    }

    const hash = createHash("sha256");
    try {
      // Use pipeline instead of hand-written write/drain: the write stream's error events (ENOSPC/EACCES) must be consumed,
      // otherwise an unlistened error crashes the Desktop Host process outright; pipeline also handles backpressure and cancellation.
      await pipeline(
        Readable.fromWeb(response.body as WebReadableStream),
        async function* (source) {
          for await (const chunk of source) {
            const buffer = chunk as Buffer;
            hash.update(buffer);
            entry.downloadedBytes += buffer.length;
            yield buffer;
          }
        },
        createWriteStream(partPath),
        { signal },
      );
    } catch (error) {
      if (signal.aborted) {
        throw new VoiceModelDownloadError(
          "cancelled",
          `download of ${descriptor.id} was cancelled`,
        );
      }
      throw new VoiceModelDownloadError(
        "network",
        error instanceof Error ? error.message : String(error),
      );
    }

    if (entry.downloadedBytes !== descriptor.sizeBytes) {
      throw new VoiceModelDownloadError(
        "size_mismatch",
        `${descriptor.id}: expected ${descriptor.sizeBytes} bytes, got ${entry.downloadedBytes}`,
      );
    }
    const digest = hash.digest("hex");
    if (digest !== descriptor.sha256) {
      throw new VoiceModelDownloadError("checksum_mismatch", `${descriptor.id}: sha256 mismatch`);
    }
  }

  private requireDescriptor(id: string): VoiceModelDescriptor {
    const descriptor = findVoiceModelDescriptor(id, this.catalog);
    if (!descriptor) throw new Error(`unknown voice model: ${id}`);
    return descriptor;
  }

  private modelDir(descriptor: VoiceModelDescriptor): string {
    return join(this.getModelsDir(), descriptor.id);
  }

  private modelFilePath(descriptor: VoiceModelDescriptor): string {
    return join(this.modelDir(descriptor), descriptor.fileName);
  }
}

export function buildModelUrl(source: string, descriptor: VoiceModelDescriptor): string {
  // CodeQL flags backtracking regexes on library input; this hand-written loop strips trailing slashes equivalently with linear complexity.
  let base = source;
  while (base.endsWith("/")) base = base.slice(0, -1);
  return `${base}/${descriptor.huggingFaceRepo}/resolve/${descriptor.revision}/${descriptor.fileName}`;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function sameFileVersion(
  first: Awaited<ReturnType<typeof stat>>,
  second: Awaited<ReturnType<typeof stat>>,
): boolean {
  return (
    second.isFile() &&
    first.size === second.size &&
    first.mtimeMs === second.mtimeMs &&
    first.ctimeMs === second.ctimeMs &&
    first.ino === second.ino
  );
}

async function hashFileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

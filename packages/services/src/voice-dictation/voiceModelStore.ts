import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
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
  /** 模型根目录；每次访问时求值，跟随数据目录设置变化。 */
  getModelsDir: () => string;
  catalog?: readonly VoiceModelDescriptor[];
  /** 下载源，按顺序尝试；每个源的 URL 形如 `${source}/${repo}/resolve/${revision}/${file}`。 */
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
 * 语音模型的唯一状态所有者：磁盘上的已安装文件与进行中的下载都只在这里维护。
 * 文件先写入 `.part`，大小与 sha256 校验通过后才原子重命名为最终文件，因此 `ready` 状态总是完整文件。
 */
export class VoiceModelStore {
  private readonly getModelsDir: () => string;
  private readonly catalog: readonly VoiceModelDescriptor[];
  private readonly sources: readonly string[];
  private readonly fetchImpl: typeof fetch;
  private readonly active = new Map<string, ActiveDownload>();

  constructor(options: VoiceModelStoreOptions) {
    this.getModelsDir = options.getModelsDir;
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
      // 列表只做大小检查，完整 sha256 在下载时已经验证过，避免每次打开设置都读取数百 MB 文件。
      if (info.isFile() && info.size === descriptor.sizeBytes) {
        return { status: "ready", path, sizeBytes: info.size };
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    return { status: "not_downloaded" };
  }

  /** 返回已安装模型的文件路径；模型未就绪时抛错，调用方应先下载。 */
  async getReadyModelPath(id: string): Promise<string> {
    const state = await this.getState(id);
    if (state.status !== "ready") {
      throw new Error(`voice model ${id} is not ready (${state.status})`);
    }
    return state.path;
  }

  /** 同一模型的并发调用共享同一个下载任务。 */
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

  /** 删除已安装文件；若正在下载则先取消并等待下载结束。 */
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
    const partPath = `${finalPath}.part`;
    await mkdir(dir, { recursive: true });

    let lastError: unknown;
    for (const source of this.sources) {
      if (entry.controller.signal.aborted) break;
      const url = buildModelUrl(source, descriptor);
      try {
        await this.fetchToPartFile(url, partPath, descriptor, entry);
        await rename(partPath, finalPath);
        logger.info(undefined, "voice model downloaded", { id: descriptor.id, source });
        return;
      } catch (error) {
        lastError = error;
        // 校验失败的文件一律丢弃，不能让错误内容留在最终路径上。
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
    const writer = createWriteStream(partPath);
    try {
      for await (const chunk of Readable.fromWeb(response.body as WebReadableStream)) {
        const buffer = chunk as Buffer;
        hash.update(buffer);
        entry.downloadedBytes += buffer.length;
        if (!writer.write(buffer)) {
          await new Promise<void>((resolve) => writer.once("drain", resolve));
        }
      }
      writer.end();
      await finished(writer);
    } catch (error) {
      writer.destroy();
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
  return `${source.replace(/\/+$/, "")}/${descriptor.huggingFaceRepo}/resolve/${descriptor.revision}/${descriptor.fileName}`;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  writeFile,
  rename,
  rm,
  readdir,
  readFile,
  stat,
} from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { acquireFileLock, atomicWritePrivateTextFile } from "@zcode/shared/node";
import { isInjectedFsFaultError, maybeThrowInjectedFsFault } from "./fsFaultInjection.js";

const DEFAULT_RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1600, 3200] as const;
const DEFAULT_LOCK_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;
const DEFAULT_LOCK_OWNERLESS_GRACE_MS = 100;
const DEFAULT_LOCK_MAX_WAIT_MS = 8_000;
const DEFAULT_TEMP_FILE_STALE_MS = 60_000;

export interface AtomicWriteTextOptions {
  renameRetryDelaysMs?: readonly number[];
  lockRetryDelaysMs?: readonly number[];
  lockOwnerlessGraceMs?: number;
  lockMaxWaitMs?: number;
  tempFileStaleMs?: number;
  useFileLock?: boolean;
  beforeRename?: () => void | Promise<void>;
  runRename?: (renameFile: () => Promise<void>) => Promise<void>;
}

export async function withAtomicFileLock<T>(
  filePath: string,
  task: () => Promise<T>,
  options?: Pick<
    AtomicWriteTextOptions,
    "lockRetryDelaysMs" | "lockOwnerlessGraceMs" | "lockMaxWaitMs"
  >,
): Promise<T> {
  const releaseLock = await acquireFileLock(
    filePath,
    options?.lockRetryDelaysMs ?? DEFAULT_LOCK_RETRY_DELAYS_MS,
    options?.lockOwnerlessGraceMs ?? DEFAULT_LOCK_OWNERLESS_GRACE_MS,
    options?.lockMaxWaitMs ?? DEFAULT_LOCK_MAX_WAIT_MS,
  );
  try {
    return await task();
  } finally {
    await releaseLock();
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** Whether the path itself exists (lstat, not following symlinks: a dangling symlink also counts as existing). Other errors are rethrown as they are. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

/**
 * A temporary file in the same directory (starts with `.`, which scans skip) + rename atomically replaces the target file; when mode is passed, the original file's permission bits are kept.
 * The temporary file is written with `wx`, so it never overwrites an existing file; on failure the temporary file is deleted. No locking and no retries.
 */
export async function writeFileAtomically(
  path: string,
  content: Uint8Array,
  mode?: number,
): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, content, { flag: "wx" });
    if (mode !== undefined) await chmod(temp, mode & 0o777);
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

function isRetryableAtomicRenameError(error: unknown): boolean {
  if (isInjectedFsFaultError(error)) {
    return false;
  }
  const code = getErrorCode(error);
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

async function renameWithRetry(
  tempFile: string,
  filePath: string,
  retryDelaysMs: readonly number[] = DEFAULT_RENAME_RETRY_DELAYS_MS,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      maybeThrowInjectedFsFault({ operation: "rename", path: filePath });
      await rename(tempFile, filePath);
      return;
    } catch (error) {
      const retryDelayMs = retryDelaysMs[attempt];
      if (retryDelayMs === undefined || !isRetryableAtomicRenameError(error)) {
        throw error;
      }

      await sleep(retryDelayMs);
    }
  }
}

async function cleanupStaleTempFilesForTarget(
  filePath: string,
  excludeTempFile: string,
  staleMs: number,
): Promise<void> {
  const dir = dirname(filePath);
  const targetBasename = basename(filePath);
  const tempPrefix = `${targetBasename}.`;
  const now = Date.now();

  try {
    const entries = await readdir(dir);
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.startsWith(tempPrefix) || !entry.endsWith(".tmp")) {
          return;
        }

        const tempPath = join(dir, entry);
        if (tempPath === excludeTempFile) {
          return;
        }

        try {
          const info = await stat(tempPath);
          if (now - info.mtimeMs < staleMs) {
            return;
          }
          await rm(tempPath, { force: true });
        } catch {
          // best-effort cleanup
        }
      }),
    );
  } catch {
    // best-effort cleanup
  }
}

/**
 * Perform an atomic write with a temporary file and rename.
 * rename is atomic on the same filesystem and prevents data-overwrite risks during concurrent read-modify-write operations.
 * Place the temporary file in the target's directory to avoid cross-volume rename failures on Windows.
 */
export async function atomicWriteText(
  filePath: string,
  content: string,
  options?: AtomicWriteTextOptions,
): Promise<void> {
  const dir = dirname(filePath);
  const tempFile = join(
    dir,
    `${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  maybeThrowInjectedFsFault({ operation: "mkdir", path: dir });
  await mkdir(dir, { recursive: true });
  // On Windows, multiple windows/host processes may save the same task JSON at once.
  // In-process writeChains cannot prevent this race, which often causes EPERM when rename replaces the target file.
  // Use a same-directory lock file to serialize ZCode processes, and retain rename retries for brief antivirus/indexer locks.
  const releaseLock =
    options?.useFileLock === false
      ? null
      : await acquireFileLock(
          filePath,
          options?.lockRetryDelaysMs ?? DEFAULT_LOCK_RETRY_DELAYS_MS,
          options?.lockOwnerlessGraceMs ?? DEFAULT_LOCK_OWNERLESS_GRACE_MS,
          options?.lockMaxWaitMs ?? DEFAULT_LOCK_MAX_WAIT_MS,
        );
  try {
    // A failed rename from an older version or a crash can leave config.json.*.tmp files behind.
    // Clean only temporary files for this target that exceed the age threshold, avoiding another process's active temp file.
    await cleanupStaleTempFilesForTarget(
      filePath,
      tempFile,
      options?.tempFileStaleMs ?? DEFAULT_TEMP_FILE_STALE_MS,
    );
    maybeThrowInjectedFsFault({ operation: "writeFile", path: tempFile });
    await writeFile(tempFile, content, "utf-8");
    await options?.beforeRename?.();
    // Windows Defender, indexing services, or another window may briefly hold the target JSON,
    // causing the atomic-replace rename to throw EPERM/EBUSY/EACCES. Retry briefly only for these transient locks,
    // while propagating real permission errors to avoid silently losing a session snapshot.
    const renameFile = () => renameWithRetry(tempFile, filePath, options?.renameRetryDelaysMs);
    if (options?.runRename) {
      await options.runRename(renameFile);
    } else {
      await renameFile();
    }
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => {
      // best-effort cleanup
    });
    throw error;
  } finally {
    await releaseLock?.();
  }
}

export async function atomicWriteJson(
  filePath: string,
  data: Record<string, unknown>,
  options?: AtomicWriteTextOptions,
): Promise<void> {
  await atomicWriteText(filePath, JSON.stringify(data, null, 2), options);
}

/**
 * Thrown when a config file exists but cannot be read, is not valid JSON, or its root node is not an object.
 * Callers must abort the write and surface the error through the existing failure feedback in the UI.
 */
export class JsonObjectFileUnreadableError extends Error {
  constructor(
    readonly filePath: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "JsonObjectFileUnreadableError";
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a JSON object file before writing: a missing file is treated as an empty object; read failures,
 * invalid JSON, or a non-object root node throw. Read-only display paths may treat a corrupt file as an
 * empty config; write paths must not, otherwise the whole file would be written back with only the
 * writer's own fields left in it.
 */
export async function readJsonObjectFileForUpdate(
  filePath: string,
): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return {};
    throw new JsonObjectFileUnreadableError(filePath, `Failed to read config file ${filePath}`, {
      cause: error,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new JsonObjectFileUnreadableError(filePath, `Config file ${filePath} is not valid JSON`, {
      cause: error,
    });
  }
  if (!isJsonObject(parsed)) {
    throw new JsonObjectFileUnreadableError(
      filePath,
      `Config file ${filePath} must contain a JSON object`,
    );
  }
  return parsed;
}

/**
 * `~/.zcode/cli/config.json` has multiple writers (commands, hooks, skills, MCP, plugins, sync import, and
 * the CLI itself) that do not lock against each other. Every writer follows "re-read before write → change
 * only its own fields → atomic replace":
 * - update receives the on-disk content as of the moment of the read and must only change its own fields;
 * - the temp file + rename replaces the target, so a mid-write failure never leaves a truncated file behind;
 * - no rename retries; failures propagate directly to the caller.
 * Known limitation: there is no lock between the read and the replace. When two writers run concurrently,
 * the one that renames later overwrites the fields the other just wrote (the same applies to in-process
 * concurrency).
 */
export async function updateJsonObjectFile(
  filePath: string,
  update: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const next = update(await readJsonObjectFileForUpdate(filePath));
  await atomicWritePrivateTextFile(filePath, `${JSON.stringify(next, null, 2)}\n`, []);
}

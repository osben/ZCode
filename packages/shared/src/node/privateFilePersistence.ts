import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { acquireFileLock } from "./atomicFileLock.js";

const DEFAULT_LOCK_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;
const DEFAULT_LOCK_OWNERLESS_GRACE_MS = 100;
const DEFAULT_LOCK_MAX_WAIT_MS = 8_000;
const DEFAULT_RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;
const processFileLockTails = new Map<string, Promise<void>>();
const credentialOperationScope = new AsyncLocalStorage<ReadonlyMap<string, string>>();
export type CredentialFileGuard = <T>(operation: () => Promise<T>) => Promise<T>;

/** 登录等跨请求流程保留最初代次，不能在迟到响应写入时重新领取新代次。 */
export async function captureCredentialFileGuard(filePath: string): Promise<CredentialFileGuard> {
  const generation =
    credentialOperationScope.getStore()?.get(filePath) ?? (await credentialGeneration(filePath));
  const scope = new Map(credentialOperationScope.getStore());
  scope.set(filePath, generation);
  return (operation) =>
    credentialOperationScope.run(scope, async () => {
      await assertCredentialGeneration(filePath, generation);
      const result = await operation();
      await assertCredentialGeneration(filePath, generation);
      return result;
    });
}

async function credentialGeneration(filePath: string): Promise<string> {
  try {
    return await readFile(`${filePath}.recovery-generation`, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return "";
    throw error;
  }
}

async function assertCredentialGeneration(filePath: string, expected: string): Promise<void> {
  if ((await credentialGeneration(filePath)) !== expected) {
    throw Object.assign(new Error("Credential store changed; retry with the current store"), {
      code: "ZCODE_CREDENTIAL_STORE_CHANGED",
    });
  }
}

/** 恢复会使已接收的旧读写失效；代次与凭据分离，不能用进程内计数代替跨进程检查。 */
export async function withCredentialFileRead<T>(
  filePath: string,
  read: () => Promise<T>,
): Promise<T> {
  // 普通读取不能争用写锁：慢写入曾使正常登录读取等待 8 秒后超时。
  // 前后代次检查拒绝跨恢复的旧结果；恢复替换前的损坏原件仍由读取方严格解析并拒绝。
  const expected = credentialOperationScope.getStore()?.get(filePath);
  const current = await credentialGeneration(filePath);
  if (expected !== undefined) await assertCredentialGeneration(filePath, expected);
  const generation = expected ?? current;
  let result: T;
  try {
    result = await read();
  } catch (error) {
    await assertCredentialGeneration(filePath, generation);
    throw error;
  }
  await assertCredentialGeneration(filePath, generation);
  return result;
}

export async function withCredentialFileMutation<T>(
  filePath: string,
  mutate: () => Promise<T>,
): Promise<T> {
  const generation =
    credentialOperationScope.getStore()?.get(filePath) ?? (await credentialGeneration(filePath));
  return withFileLock(filePath, async () => {
    await assertCredentialGeneration(filePath, generation);
    return mutate();
  });
}

export interface SharedFileLockOptions {
  lockRetryDelaysMs?: readonly number[];
  lockOwnerlessGraceMs?: number;
  lockMaxWaitMs?: number;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isRetryableRenameError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

async function renameWithRetry(
  tempFile: string,
  filePath: string,
  retryDelaysMs: readonly number[],
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tempFile, filePath);
      return;
    } catch (error) {
      const delayMs = retryDelaysMs[attempt];
      if (delayMs === undefined || !isRetryableRenameError(error)) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
}

export async function withFileLock<T>(
  filePath: string,
  operation: () => Promise<T>,
  options: SharedFileLockOptions = {},
): Promise<T> {
  // Dozens of callers in one process polling a directory lock can cause a thundering herd; queued requests may hit the
  // 8-second timeout even after a very short write. Use an in-process FIFO first so only the head of each process competes for the OS lock.
  const previousTail = processFileLockTails.get(filePath) ?? Promise.resolve();
  let releaseProcessQueue!: () => void;
  const currentTail = new Promise<void>((resolve) => {
    releaseProcessQueue = resolve;
  });
  processFileLockTails.set(filePath, currentTail);
  await previousTail;

  let releaseLock: (() => Promise<void>) | undefined;
  try {
    await mkdir(dirname(filePath), { recursive: true });
    releaseLock = await acquireFileLock(
      filePath,
      options.lockRetryDelaysMs ?? DEFAULT_LOCK_RETRY_DELAYS_MS,
      options.lockOwnerlessGraceMs ?? DEFAULT_LOCK_OWNERLESS_GRACE_MS,
      options.lockMaxWaitMs ?? DEFAULT_LOCK_MAX_WAIT_MS,
    );
    return await operation();
  } finally {
    try {
      await releaseLock?.();
    } finally {
      releaseProcessQueue();
      if (processFileLockTails.get(filePath) === currentTail) {
        processFileLockTails.delete(filePath);
      }
    }
  }
}

/** SHA-256 hex of raw file bytes: the content revision used for conditional writes and deletes. */
export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface AtomicWriteFileOptions {
  /** Target file permission bits; when omitted, the process default permissions are used (subject to umask). */
  mode?: number;
  renameRetryDelaysMs?: readonly number[];
}

/**
 * Atomic write using a temporary file in the same directory and rename. Rename replaces the target inode,
 * which breaks hard links; callers must pass mode when the original permissions need to be preserved.
 */
export async function atomicWriteFile(
  filePath: string,
  data: string | Uint8Array,
  options: AtomicWriteFileOptions = {},
): Promise<void> {
  const directory = dirname(filePath);
  const tempPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(
      tempPath,
      data,
      options.mode === undefined ? undefined : { mode: options.mode },
    );
    if (options.mode !== undefined) {
      // writeFile's mode is restricted by umask; only an explicit chmod fully preserves the original file permissions.
      await chmod(tempPath, options.mode);
    }
    await renameWithRetry(
      tempPath,
      filePath,
      options.renameRetryDelaysMs ?? DEFAULT_RENAME_RETRY_DELAYS_MS,
    );
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function atomicWritePrivateTextFile(
  filePath: string,
  content: string,
  renameRetryDelaysMs: readonly number[] = DEFAULT_RENAME_RETRY_DELAYS_MS,
): Promise<void> {
  await atomicWriteFile(filePath, content, { mode: 0o600, renameRetryDelaysMs });
}

export async function backupCorruptFile(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  const contentId = createHash("sha256").update(content).digest("hex").slice(0, 24);
  const backupPath = `${filePath}.corrupt-${contentId}.bak`;
  try {
    // The same corrupt credential may be read repeatedly by Desktop, CLI, and retry loops. Derive the backup name from its contents and
    // create it exclusively so failures converge on one stable piece of evidence, while avoiding copyFile inheriting permissive old permissions.
    await writeFile(backupPath, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (getErrorCode(error) !== "EEXIST") throw error;
  }
  await chmod(backupPath, 0o600);
  return backupPath;
}

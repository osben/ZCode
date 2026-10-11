import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BotConfig, BotProviderCallbackResult, BotRuntimeInfo } from "@zcode/shared";
import { getAppConfigDir } from "../paths.js";

export const BOT_RUNTIME_LOCK_RETRY_MS = 10_000;
export const BOT_RUNTIME_LOCK_LEASE_MS = 30_000;
const BOT_RUNTIME_LOCK_HEARTBEAT_MS = 10_000;
const BOT_RUNTIME_LOCK_CLEANUP_RETRY_DELAYS_MS = [100, 250, 500] as const;

export interface BotRuntimeLogger {
  debug(traceId: string | undefined, message: string): void;
  info(traceId: string | undefined, message: string): void;
  warn(traceId: string | undefined, message: string): void;
}

export interface BotRuntimeStatusSink {
  getRuntimeStatus(botId: string): BotRuntimeInfo | undefined;
  setRuntimeStatus(status: BotRuntimeInfo): void;
}

export function createBotConnectionFingerprint(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function assertBotCallbackSucceeded(
  provider: string,
  result: BotProviderCallbackResult,
): void {
  if (result.ok) {
    return;
  }
  // Bug fix: provider callbacks can report recoverable business failures as return values instead of rejecting.
  // Commit the external consumption cursor only after ok=true; otherwise a transient failure is incorrectly acknowledged and the message is lost permanently.
  throw new Error(`${provider} callback failed: status=${result.status ?? "unknown"}`);
}

export function createLatestRuntimeRefreshQueue() {
  let generation = 0;
  let queue: Promise<void> = Promise.resolve();

  return {
    enqueue(reconcile: (isLatest: () => boolean) => Promise<void>): Promise<void> {
      const currentGeneration = ++generation;
      const result = queue
        .catch(() => undefined)
        .then(() => reconcile(() => currentGeneration === generation));
      // Bug fix: saving configuration can trigger consecutive fire-and-forget refreshes. The serial queue must make the next run wait
      // for the previous run to release its connection, without letting a previous failure permanently block newer configuration.
      queue = result.catch(() => undefined);
      return result;
    },
    invalidate(): void {
      generation += 1;
    },
  };
}

interface BotRuntimeLockOwner {
  pid: number;
  botId: string;
  nonce: string;
  createdAt: number;
}

interface BotRuntimeLock {
  release(): Promise<void>;
}
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function isBotRuntimeLockConflictError(error: unknown): boolean {
  return (
    isNodeError(error) &&
    (error.code === "EEXIST" ||
      error.code === "ENOTEMPTY" ||
      error.code === "EISDIR" ||
      error.code === "EPERM")
  );
}

function isBotRuntimeLockCleanupRetryable(error: unknown): boolean {
  return (
    isNodeError(error) &&
    (error.code === "EPERM" || error.code === "EBUSY" || error.code === "ENOTEMPTY")
  );
}

async function removeBotRuntimeLockPath(lockPath: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(lockPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const delay = BOT_RUNTIME_LOCK_CLEANUP_RETRY_DELAYS_MS[attempt];
      if (!isBotRuntimeLockCleanupRetryable(error) || delay === undefined) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

function getBotRuntimeLockPath(namespace: string, lockKey: string): string {
  const lockHash = createHash("sha256").update(lockKey.trim()).digest("hex");
  return join(getAppConfigDir(), "bots-runtime-locks", namespace, `${lockHash}.lock`);
}

async function readBotRuntimeLockOwner(lockPath: string): Promise<BotRuntimeLockOwner | null> {
  try {
    const raw = JSON.parse(
      await readFile(join(lockPath, "owner.json"), "utf-8"),
    ) as Partial<BotRuntimeLockOwner>;
    return typeof raw.pid === "number" &&
      typeof raw.botId === "string" &&
      typeof raw.nonce === "string"
      ? {
          pid: raw.pid,
          botId: raw.botId,
          nonce: raw.nonce,
          createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
        }
      : null;
  } catch {
    return null;
  }
}

async function readBotRuntimeLockLeaseAt(lockPath: string, nonce: string): Promise<number> {
  try {
    return (await stat(join(lockPath, `lease-${nonce}`))).mtimeMs;
  } catch {
    return 0;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

async function acquireBotRuntimeLock(
  namespace: string,
  lockKey: string,
  botId: string,
): Promise<BotRuntimeLock | null> {
  const lockPath = getBotRuntimeLockPath(namespace, lockKey);
  const owner: BotRuntimeLockOwner = {
    pid: process.pid,
    botId,
    nonce: randomBytes(8).toString("hex"),
    createdAt: Date.now(),
  };
  const leasePath = join(lockPath, `lease-${owner.nonce}`);
  await mkdir(dirname(lockPath), {
    recursive: true,
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pendingLockPath = `${lockPath}.${owner.nonce}.pending`;
    try {
      // Bug fix: the lock directory and owner file must be visible as one complete state.
      // Write the owner file in a unique temporary directory, then atomically rename it so contenders do not mistake an incompletely initialized lock for a stale one.
      await mkdir(pendingLockPath);
      await writeFile(join(pendingLockPath, "owner.json"), `${JSON.stringify(owner)}\n`);
      await writeFile(join(pendingLockPath, `lease-${owner.nonce}`), "");
      try {
        await rename(pendingLockPath, lockPath);
      } catch (error) {
        // Bug fix: on Windows, renaming a temporary lock directory to an existing lock directory returns EPERM. Treat only rename conflicts as lock contention,
        // so permission errors from mkdir/writeFile are not mistaken for a lock that can be taken over.
        if (!isBotRuntimeLockConflictError(error)) {
          throw error;
        }
        // EPERM may also indicate a directory permission error; enter the conflict-takeover branch only if the final lock path actually exists.
        if (!(await stat(lockPath).catch(() => undefined))) {
          throw error;
        }
        const currentOwner = await readBotRuntimeLockOwner(lockPath);
        if (currentOwner) {
          const leaseAt = await readBotRuntimeLockLeaseAt(lockPath, currentOwner.nonce);
          const leaseAge = Date.now() - leaseAt;
          if (
            isProcessAlive(currentOwner.pid) &&
            leaseAt > 0 &&
            leaseAge < BOT_RUNTIME_LOCK_LEASE_MS
          ) {
            return null;
          }
        }
        // Bug fix: a stale directory may be held briefly by a Windows file handle; retry a limited number of times before giving up to avoid silent leftovers.
        await removeBotRuntimeLockPath(lockPath);
        continue;
      }
      let heartbeatWriting = false;
      const heartbeat = setInterval(() => {
        if (heartbeatWriting) return;
        heartbeatWriting = true;
        const now = new Date();
        void utimes(leasePath, now, now)
          .catch(() => undefined)
          .finally(() => {
            heartbeatWriting = false;
          });
      }, BOT_RUNTIME_LOCK_HEARTBEAT_MS);
      heartbeat.unref();
      return {
        async release() {
          clearInterval(heartbeat);
          const currentOwner = await readBotRuntimeLockOwner(lockPath);
          if (
            currentOwner?.pid === owner.pid &&
            currentOwner.botId === owner.botId &&
            currentOwner.nonce === owner.nonce
          ) {
            await removeBotRuntimeLockPath(lockPath);
          }
        },
      };
    } finally {
      await removeBotRuntimeLockPath(pendingLockPath);
    }
  }
  return null;
}

export async function acquireTelegramPollingLock(
  token: string,
  botId: string,
): Promise<BotRuntimeLock | null> {
  return acquireBotRuntimeLock("telegram-polling", token, botId);
}

export async function acquireWeixinPollingLock(
  token: string,
  botId: string,
): Promise<BotRuntimeLock | null> {
  return acquireBotRuntimeLock("weixin-polling", token, botId);
}

export function acquireFeishuWebSocketLock(
  bot: Pick<BotConfig, "id" | "provider" | "feishuAppId">,
): Promise<BotRuntimeLock | null> {
  return acquireBotRuntimeLock(`${bot.provider}-websocket`, bot.feishuAppId?.trim() ?? "", bot.id);
}

export function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onAbort = () => finish();
    const timeout = setTimeout(finish, ms);
    // Bug fix: the runtime reuses the same signal for a long time; remove the listener after each wait to prevent it accumulating across retries.
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

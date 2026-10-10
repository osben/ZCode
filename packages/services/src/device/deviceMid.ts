import { createUuid } from "@zcode/shared";
import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAppConfigDir } from "../paths.js";

const LOCK_RETRY_DELAY_MS = 10;
const LOCK_RETRY_COUNT = 200;
const LOCK_STALE_MS = 5 * 60 * 1000;

interface DeviceState {
  deviceMid?: string;
}

interface DeviceStateLockOwner {
  pid: number;
  createdAt: number;
}

const deviceMidCacheByStateFile = new Map<string, Promise<string>>();

// `telemetry-state.json` is the long-standing on-disk filename for device identity: CLI, Desktop, and the remote server all read/write the same
// path and fields. Renaming it would reset the user's device identity, so keep the filename unchanged.
function resolveDeviceStateFile(homeDir?: string): string {
  if (homeDir) {
    return join(homeDir, ".zcode", "v2", "telemetry-state.json");
  }
  return join(getAppConfigDir(), "telemetry-state.json");
}

function resolveDeviceStateLockFile(homeDir?: string): string {
  if (homeDir) {
    return join(homeDir, ".zcode", "v2", "telemetry-state.lock");
  }
  return join(getAppConfigDir(), "telemetry-state.lock");
}

async function readDeviceState(homeDir?: string): Promise<DeviceState> {
  try {
    const raw = await readFile(resolveDeviceStateFile(homeDir), "utf-8");
    const parsed = JSON.parse(raw) as DeviceState;
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

async function writeDeviceState(state: DeviceState, homeDir?: string): Promise<void> {
  const deviceStateFile = resolveDeviceStateFile(homeDir);
  await mkdir(dirname(deviceStateFile), { recursive: true });
  await writeFile(deviceStateFile, JSON.stringify(state, null, 2), "utf-8");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeStaleDeviceStateLockIfNeeded(
  lockFile: string,
  timestamp: number,
): Promise<boolean> {
  try {
    const metadata = await stat(lockFile);
    if (timestamp - metadata.mtimeMs < LOCK_STALE_MS) {
      const owner = await readDeviceStateLockOwner(lockFile);
      if (!owner || isProcessAlive(owner.pid)) {
        return false;
      }
    }

    await unlink(lockFile).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function readDeviceStateLockOwner(lockFile: string): Promise<DeviceStateLockOwner | null> {
  try {
    const raw = await readFile(lockFile, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DeviceStateLockOwner>;
    if (
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.createdAt === "number" &&
      Number.isFinite(parsed.createdAt)
    ) {
      return {
        pid: parsed.pid,
        createdAt: parsed.createdAt,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code !== "ESRCH"
    );
  }
}

async function withDeviceStateLock<T>(
  homeDir: string | undefined,
  run: (state: DeviceState) => Promise<T>,
): Promise<T> {
  const lockFile = resolveDeviceStateLockFile(homeDir);
  await mkdir(dirname(lockFile), { recursive: true });

  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
    try {
      const handle = await open(lockFile, "wx");
      try {
        // The lock stores the owner's pid, allowing an orphaned lock to be identified and safely reclaimed within 5 minutes after a crash.
        await handle.writeFile(
          JSON.stringify({
            pid: process.pid,
            createdAt: Date.now(),
          }),
          "utf-8",
        );
        const state = await readDeviceState(homeDir);
        return await run(state);
      } finally {
        await handle.close();
        await unlink(lockFile).catch(() => {});
      }
    } catch (error) {
      const isLockConflict =
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "EEXIST";
      if (!isLockConflict) {
        throw error;
      }

      const removedStaleLock = await removeStaleDeviceStateLockIfNeeded(lockFile, Date.now());
      if (removedStaleLock) {
        continue;
      }

      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }

  throw new Error("Device state lock timeout");
}

export interface EnsureDeviceMidOptions {
  homeDir?: string;
  randomUUID?: () => string;
}

function rememberDeviceMid(deviceStateFile: string, deviceMid: string): string {
  deviceMidCacheByStateFile.set(deviceStateFile, Promise.resolve(deviceMid));
  return deviceMid;
}

/**
 * The caller must already hold the device identity file lock (telemetry-state.lock); generate and write back deviceMid only if it is missing from state.
 *
 * Telemetry reporting and similar flows already hold this lock in their own critical section and maintain the complete state, so deviceMid generation
 * must be combined with the same write. In that case, use this entry point instead of ensureDeviceMid, which would try to acquire the lock again.
 */
export async function ensureDeviceMidInLockedState(
  state: DeviceState,
  options: EnsureDeviceMidOptions,
): Promise<string> {
  const deviceStateFile = resolveDeviceStateFile(options.homeDir);
  if (state.deviceMid) {
    return rememberDeviceMid(deviceStateFile, state.deviceMid);
  }

  const deviceMid = (options.randomUUID ?? createUuid)();
  state.deviceMid = deviceMid;
  await writeDeviceState(state, options.homeDir);
  return rememberDeviceMid(deviceStateFile, deviceMid);
}

/**
 * Ensure the device identity file contains deviceMid and return it.
 *
 * deviceMid is shared device identity across clients: the X-Device-Mid billing header, feedback, and onboarding all read it.
 * The remote zcode-server has no Desktop main process, so its stdio entry calls this function at startup to populate it,
 * sharing the same file, fields, and lock with the local CLI/Desktop.
 */
export function ensureDeviceMid(options: EnsureDeviceMidOptions = {}): Promise<string> {
  const deviceStateFile = resolveDeviceStateFile(options.homeDir);
  const cached = deviceMidCacheByStateFile.get(deviceStateFile);
  if (cached) {
    return cached;
  }

  const pending = withDeviceStateLock(options.homeDir, async (state) =>
    ensureDeviceMidInLockedState(state, options),
  ).catch((error) => {
    if (deviceMidCacheByStateFile.get(deviceStateFile) === pending) {
      deviceMidCacheByStateFile.delete(deviceStateFile);
    }
    throw error;
  });
  deviceMidCacheByStateFile.set(deviceStateFile, pending);
  return pending;
}

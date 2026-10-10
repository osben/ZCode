import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createUuid } from "@zcode/shared";
import { getAppConfigDir } from "@zcode/services/node";

interface EnsureDesktopDeviceMidSyncOptions {
  /** Directory containing the state file; defaults to getAppConfigDir() (that is, ~/.zcode/v2). Test injection only. */
  configDir?: string;
  /** UUID generator; defaults to createUuid. Test injection only. */
  createId?: () => string;
}

/**
 * Synchronously ensure the device identity file (using the existing telemetry-state.json filename
 * shared with the CLI/remote server) contains deviceMid, and return that value.
 *
 * Share the file's `deviceMid` field with warehouse reporting (telemetryCore) so ARMS and warehouse
 * device_mid use the same persistent UUID. ARMS needs the value synchronously before creating a
 * window (injected through preload `--device-id=`), so this uses synchronous node:fs reads/writes.
 *
 * Race avoidance:
 * - Return an existing valid deviceMid without writing to disk (no writes for existing users or subsequent launches).
 * - Write only when it is missing; read the full state, add only deviceMid, and write it back so fields
 *   written by telemetryCore such as lastDailyActiveDate / dailyActiveInFlight are preserved.
 * - Write atomically (temporary file + renameSync) so concurrent readers cannot see partial JSON.
 *
 * Do not throw for fs/JSON errors: if writing fails, return the UUID generated in memory and try to
 * persist it on the next launch, ensuring deviceMid is available when the window is created.
 */
export function ensureDesktopDeviceMidSync(options?: EnsureDesktopDeviceMidSyncOptions): string {
  const createId = options?.createId ?? createUuid;
  try {
    const configDir = options?.configDir ?? getAppConfigDir();
    const stateFile = join(configDir, "telemetry-state.json");

    const state = readDeviceStateSync(stateFile);
    if (typeof state.deviceMid === "string" && state.deviceMid) {
      return state.deviceMid;
    }

    const deviceMid = createId();
    state.deviceMid = deviceMid;
    writeDeviceStateSync(stateFile, state);
    return deviceMid;
  } catch {
    // Fallback for fs/JSON errors: always return a value without blocking window creation.
    return createId();
  }
}

function readDeviceStateSync(stateFile: string): Record<string, unknown> {
  try {
    const raw = readFileSync(stateFile, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeDeviceStateSync(stateFile: string, state: Record<string, unknown>): void {
  const dir = dirname(stateFile);
  mkdirSync(dir, { recursive: true });
  const tempFile = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(tempFile, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tempFile, stateFile);
}

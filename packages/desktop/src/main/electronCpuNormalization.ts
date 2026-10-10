/**
 * Normalize Electron `percentCPUUsage` to a whole-machine scale.
 *
 * The resource-manager UI uses this single normalization for whole-machine CPU:
 * on darwin / win32, Chromium already reports a whole-machine value; on Linux it reports a per-core value that must be divided by the logical core count.
 */

import os from "node:os";

export function normalizeElectronCpuToMachinePercent(
  cpu: number | null | undefined,
  options: { platform?: NodeJS.Platform; logicalCpuCount?: number } = {},
): number {
  const normalizedCpu = typeof cpu === "number" && Number.isFinite(cpu) ? cpu : 0;
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") {
    return normalizedCpu;
  }
  const logicalCpuCount = options.logicalCpuCount ?? os.cpus().length;
  const scale = Number.isFinite(logicalCpuCount) && logicalCpuCount > 0 ? logicalCpuCount : 1;
  return normalizedCpu / scale;
}

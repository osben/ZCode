/**
 * Device-level sample source.
 *
 * Shares main's 10-second tick with the Chromium subsystem and runs in the second sampling phase:
 * derive machine-wide CPU from differences between adjacent `os.cpus()` snapshots, read available
 * machine memory from `os.freemem()`, then add the exact total from phase one to the latest samples
 * from external sources (CLI, MCP) to calculate the application total.
 * These are all in-process APIs; the main process uses no external processes.
 */

import os from "node:os";
import { addAppResourceTotals } from "./processResourceAppTotals.js";
import {
  collectExternalAppResourceTotals,
  resetExternalAppResourceSamples,
} from "./processResourceExternalAppSamples.js";
import type { ProcessResourceSampleSource } from "./processResourceSampleSources.js";
import { roundMetric } from "./resourceMetricsStats.js";

/** Cumulative machine-wide CPU time snapshot; only the difference between two snapshots represents CPU over an interval. */
interface SystemCpuTimesSnapshot {
  busyMs: number;
  totalMs: number;
}

function summarizeSystemCpuTimes(cpus: readonly os.CpuInfo[]): SystemCpuTimesSnapshot {
  let busyMs = 0;
  let idleMs = 0;
  for (const cpu of cpus) {
    const times = cpu.times;
    busyMs += (times?.user ?? 0) + (times?.nice ?? 0) + (times?.sys ?? 0) + (times?.irq ?? 0);
    idleMs += times?.idle ?? 0;
  }
  return { busyMs, totalMs: busyMs + idleMs };
}

/**
 * Percentage difference between two snapshots. Return null when no valid difference is available;
 * the caller then produces no sample for this tick.
 * Return null if cumulative time did not advance (`os.cpus()` is empty in a container), the core
 * count changed, or a clock adjustment caused a negative difference.
 */
function diffSystemCpuPercent(
  previous: SystemCpuTimesSnapshot,
  next: SystemCpuTimesSnapshot,
): number | null {
  const totalDeltaMs = next.totalMs - previous.totalMs;
  const busyDeltaMs = next.busyMs - previous.busyMs;
  if (!(totalDeltaMs > 0) || busyDeltaMs < 0) {
    return null;
  }
  return roundMetric(Math.min(100, (busyDeltaMs / totalDeltaMs) * 100));
}

let previousCpuTimes: SystemCpuTimesSnapshot | null = null;

export const systemProcessResourceSampleSource: ProcessResourceSampleSource = {
  id: "system",
  sampleDevice(context) {
    const snapshot = summarizeSystemCpuTimes(os.cpus());
    const baseline = previousCpuTimes;
    previousCpuTimes = snapshot;

    // The first tick has only one snapshot, so there is no difference to calculate and no sample is
    // produced. The same applies when phase one has no exact total: a device event should omit a
    // sample rather than report a partial or inaccurate total.
    if (!baseline || !context.appProcessTotals) {
      return;
    }
    const systemCpuPercent = diffSystemCpuPercent(baseline, snapshot);
    if (systemCpuPercent === null) {
      return;
    }

    const appTotals = addAppResourceTotals(
      context.appProcessTotals,
      collectExternalAppResourceTotals(context.now),
    );
    context.addDeviceSample({
      systemCpuPercent,
      systemFreeMemoryKb: Math.round(os.freemem() / 1024),
      appCpuPercent: appTotals.cpuPercent,
      appRssKbTotal: appTotals.rssKbTotal,
      appProcessCount: appTotals.processCount,
    });
  },
  reset() {
    // Discard the CPU baseline and latest external-source samples so facts from the previous sampling session are not used in differences or totals.
    previousCpuTimes = null;
    resetExternalAppResourceSamples();
  },
};

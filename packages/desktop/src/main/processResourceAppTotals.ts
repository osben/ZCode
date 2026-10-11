/**
 * The resource total for a group of processes at a point in time.
 *
 * App totals for device-level `perf_system_window` are the sum of two parts: the Chromium-system total that main can enumerate precisely,
 * and the most recently known sample totals from external sources such as CLI / MCP. Both sides share the same value semantics, so keep one type and one summation implementation.
 */

import { roundMetric } from "./resourceMetricsStats.js";

export interface AppResourceTotals {
  /** Sum of CPU usage for this process group (normalized percentage of the whole machine). */
  cpuPercent: number;
  rssKbTotal: number;
  processCount: number;
}

export function createEmptyAppResourceTotals(): AppResourceTotals {
  return { cpuPercent: 0, rssKbTotal: 0, processCount: 0 };
}

/** Add two totals; round CPU only after summation, since rounding each process would accumulate error as the process count grows. */
export function addAppResourceTotals(
  base: AppResourceTotals,
  extra: AppResourceTotals,
): AppResourceTotals {
  return {
    cpuPercent: roundMetric(base.cpuPercent + extra.cpuPercent),
    rssKbTotal: base.rssKbTotal + extra.rssKbTotal,
    processCount: base.processCount + extra.processCount,
  };
}

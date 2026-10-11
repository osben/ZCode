/**
 * Classify Chromium-system processes from main-side getAppMetrics and aggregate them by role.
 * Pure functions with no Electron runtime dependency for unit testing; resourceManagerWindow provides the PID sets from its registry.
 */

import type { ProcessResourceRole } from "@zcode/shared";
import {
  addAppResourceTotals,
  createEmptyAppResourceTotals,
  type AppResourceTotals,
} from "./processResourceAppTotals.js";
import { roundMetric } from "./resourceMetricsStats.js";

/** Seven roles covered by getAppMetrics; cli_* and mcp come from CLI samples and are not included here. */
export const CHROMIUM_PROCESS_RESOURCE_ROLES = [
  "main",
  "renderer_main",
  "renderer_guest",
  "gpu",
  "chromium_other",
  "host",
  "scheduler",
] as const satisfies readonly ProcessResourceRole[];

export type ChromiumProcessResourceRole = (typeof CHROMIUM_PROCESS_RESOURCE_ROLES)[number];

/** Normalized sample for one process: CPU is normalized to machine-wide usage; memory is in KB. */
export interface ChromiumProcessMetricSample {
  pid: number;
  type: string;
  cpuPercent: number;
  rssKb: number;
  /** Process creation time (epoch ms); when unknown, runtime is counted as 0. */
  creationTime?: number;
}

/**
 * Snapshot of PIDs assigned to each role. The renderer must distinguish the main window from
 * `<webview>` guests; Host and scheduler utilityProcess PIDs are registered at their respective spawn points.
 */
export interface ChromiumProcessRolePids {
  mainPid: number;
  mainWindowRendererPids: ReadonlySet<number>;
  guestRendererPids: ReadonlySet<number>;
  hostPids: ReadonlySet<number>;
  schedulerPids: ReadonlySet<number>;
}

export interface ChromiumRoleAggregate {
  role: ChromiumProcessResourceRole;
  /** Sum of CPU usage across all processes in the role (percentage normalized to the whole machine). */
  cpuPercent: number;
  rssKbTotal: number;
  rssKbMaxProcess: number;
  processCount: number;
  /** Runtime in minutes of the oldest process in the role. */
  uptimeMinutes: number;
}

/**
 * Aggregate all Chromium roles for one tick to get the total for application processes that main
 * can enumerate exactly. The Chromium portion of device-level application totals comes only from
 * here; CLI and MCP use the external-sample entry point, avoiding double-counting.
 */
export function sumChromiumRoleAggregates(
  aggregates: readonly ChromiumRoleAggregate[],
): AppResourceTotals {
  let totals = createEmptyAppResourceTotals();
  for (const aggregate of aggregates) {
    totals = addAppResourceTotals(totals, {
      cpuPercent: aggregate.cpuPercent,
      rssKbTotal: aggregate.rssKbTotal,
      processCount: aggregate.processCount,
    });
  }
  return totals;
}

export function classifyChromiumProcessRole(
  sample: Pick<ChromiumProcessMetricSample, "pid" | "type">,
  pids: ChromiumProcessRolePids,
): ChromiumProcessResourceRole {
  if (sample.pid === pids.mainPid) {
    return "main";
  }
  if (sample.type === "GPU") {
    return "gpu";
  }
  if (pids.mainWindowRendererPids.has(sample.pid)) {
    return "renderer_main";
  }
  if (pids.guestRendererPids.has(sample.pid)) {
    return "renderer_guest";
  }
  if (pids.hostPids.has(sample.pid)) {
    return "host";
  }
  if (pids.schedulerPids.has(sample.pid)) {
    return "scheduler";
  }
  return "chromium_other";
}

function uptimeMinutesOf(sample: ChromiumProcessMetricSample, now: number): number {
  const creationTime = sample.creationTime;
  if (typeof creationTime !== "number" || !Number.isFinite(creationTime) || creationTime <= 0) {
    return 0;
  }
  return Math.max(0, Math.round((now - creationTime) / 60_000));
}

/** Aggregate all Chromium processes by role for one tick; return only roles with live processes in this tick. */
export function aggregateChromiumProcessRoles(input: {
  processes: readonly ChromiumProcessMetricSample[];
  pids: ChromiumProcessRolePids;
  now: number;
}): ChromiumRoleAggregate[] {
  const byRole = new Map<ChromiumProcessResourceRole, ChromiumRoleAggregate>();

  for (const sample of input.processes) {
    const role = classifyChromiumProcessRole(sample, input.pids);
    const existing = byRole.get(role);
    const uptimeMinutes = uptimeMinutesOf(sample, input.now);
    if (!existing) {
      byRole.set(role, {
        role,
        cpuPercent: sample.cpuPercent,
        rssKbTotal: sample.rssKb,
        rssKbMaxProcess: sample.rssKb,
        processCount: 1,
        uptimeMinutes,
      });
      continue;
    }
    // Round only after summing; rounding each value would accumulate error as process count grows.
    existing.cpuPercent += sample.cpuPercent;
    existing.rssKbTotal += sample.rssKb;
    existing.rssKbMaxProcess = Math.max(existing.rssKbMaxProcess, sample.rssKb);
    existing.processCount += 1;
    existing.uptimeMinutes = Math.max(existing.uptimeMinutes, uptimeMinutes);
  }

  // Keep output order fixed by role enumeration so event order is predictable in tests and dashboards.
  return CHROMIUM_PROCESS_RESOURCE_ROLES.map((role) => byRole.get(role))
    .filter((aggregate): aggregate is ChromiumRoleAggregate => aggregate !== undefined)
    .map((aggregate) => ({ ...aggregate, cpuPercent: roundMetric(aggregate.cpuPercent) }));
}

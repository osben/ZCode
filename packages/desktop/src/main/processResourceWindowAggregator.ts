/**
 * Bounded aggregation windows for process roles.
 *
 * All sources (Chromium, Node self-sampling, CLI, MCP) feed in "instantaneous facts for a role at a
 * given time." On flush, each window is projected to one `perf_process_window` event. In-memory and
 * bounded; no queue and no retries.
 */

import type { ProcessResourceRole, ProcessResourceRuntimeSurface } from "@zcode/shared";
import {
  appendBoundedSamples,
  computeAggregateStats,
  roundMetric,
} from "./resourceMetricsStats.js";

/** Maximum samples per role/sequence (5 minutes at 10 seconds = 30, plus 2 for timer drift). */
export const PROCESS_RESOURCE_MAX_SAMPLES_PER_WINDOW = 32;
/**
 * Maximum number of concurrent windows (bounded memory).
 * Roles, runtime environments, hardware, and MCP IDs get separate windows; remote environments
 * share a budget of 64 windows. Drop new windows after the limit; do not queue or persist them.
 */
const PROCESS_RESOURCE_MAX_WINDOWS = 64;

export type ProcessResourceScene = "foreground" | "background";

/** Machine running this role; the output layer supplies desktop-machine values when absent. */
export interface ProcessResourceHardware {
  platform: NodeJS.Platform;
  arch: string;
  logicalCpuCount: number;
  totalMemoryGb: number;
}

/**
 * Machine information reported by a sample may include only some fields (older CLI versions omit
 * `totalMemoryGb`). The output layer overrides desktop defaults field by field rather than choosing one object wholesale.
 */
export type ProcessResourceHardwareOverride = Partial<ProcessResourceHardware>;

/** Instantaneous facts for one role at one point in time. */
export interface ProcessRoleSample {
  role: ProcessResourceRole;
  /** Runtime-environment hash injected by Host, used only for in-memory grouping and not projected into event properties. */
  environmentKey?: string;
  /** Sum of CPU usage across all processes in the role (percentage normalized to the whole machine). */
  cpuPercent: number;
  rssKbTotal: number;
  rssKbMaxProcess: number;
  processCount: number;
  uptimeMinutes: number;
  /** Only for Node roles and renderer_main; absent means this sample had no heap reading. */
  heapUsedKb?: number;
  runtimeSurface?: ProcessResourceRuntimeSurface;
  /** Only for the mcp role. */
  mcpId?: string;
  hardware?: ProcessResourceHardwareOverride;
}

export interface ProcessRoleWindowReport {
  role: ProcessResourceRole;
  runtimeSurface: ProcessResourceRuntimeSurface;
  mcpId?: string;
  hardware?: ProcessResourceHardwareOverride;
  backgroundRatio: number;
  uptimeMinutes: number;
  cpuPercentMean: number;
  cpuPercentP95: number;
  cpuPercentPeak: number;
  rssKbTotalMean: number;
  rssKbTotalPeak: number;
  rssKbMaxProcessPeak: number;
  heapUsedKbMean?: number;
  heapUsedKbPeak?: number;
  processCountPeak: number;
  sampleCount: number;
}

interface ProcessRoleWindow {
  role: ProcessResourceRole;
  runtimeSurface: ProcessResourceRuntimeSurface;
  mcpId?: string;
  hardware?: ProcessResourceHardwareOverride;
  cpuPercent: number[];
  rssKbTotal: number[];
  rssKbMaxProcess: number[];
  heapUsedKb: number[];
  processCountPeak: number;
  uptimeMinutes: number;
}

/**
 * The hardware fingerprint describes specifications, not machine identity. Host adds environment
 * identity separately to the window key to prevent CPU/RSS from same-spec remote environments from
 * being summed; the hardware fingerprint still separates readings with different specs in one
 * environment. Local roles have no hardware, so their empty fingerprint leaves the key identical to
 * a role-only key.
 */
export function processResourceHardwareKey(hardware?: ProcessResourceHardwareOverride): string {
  if (!hardware) {
    return "";
  }
  return [
    hardware.platform ?? "",
    hardware.arch ?? "",
    hardware.logicalCpuCount ?? "",
    hardware.totalMemoryGb ?? "",
  ].join("/");
}

function windowKey(sample: ProcessRoleSample): string {
  return [
    sample.role,
    sample.runtimeSurface ?? "local",
    sample.environmentKey ?? "",
    sample.mcpId ?? "",
    processResourceHardwareKey(sample.hardware),
  ].join(":");
}

export class ProcessResourceWindowAggregator {
  private readonly windows = new Map<string, ProcessRoleWindow>();
  private sceneTicks = 0;
  private backgroundTicks = 0;

  /** Main records foreground/background state every 10-second tick; all role events share the ratio for the window. */
  recordScene(scene: ProcessResourceScene): void {
    this.sceneTicks += 1;
    if (scene === "background") {
      this.backgroundTicks += 1;
    }
  }

  add(sample: ProcessRoleSample): void {
    const key = windowKey(sample);
    let window = this.windows.get(key);
    if (!window) {
      if (this.windows.size >= PROCESS_RESOURCE_MAX_WINDOWS) {
        return;
      }
      window = {
        role: sample.role,
        runtimeSurface: sample.runtimeSurface ?? "local",
        mcpId: sample.mcpId,
        hardware: sample.hardware,
        cpuPercent: [],
        rssKbTotal: [],
        rssKbMaxProcess: [],
        heapUsedKb: [],
        processCountPeak: 0,
        uptimeMinutes: 0,
      };
      this.windows.set(key, window);
    }

    // Runtime environment and hardware are both part of the window key, so dimensions do not need to be overwritten within a window.
    window.cpuPercent = appendBounded(window.cpuPercent, sample.cpuPercent);
    window.rssKbTotal = appendBounded(window.rssKbTotal, sample.rssKbTotal);
    window.rssKbMaxProcess = appendBounded(window.rssKbMaxProcess, sample.rssKbMaxProcess);
    if (typeof sample.heapUsedKb === "number" && Number.isFinite(sample.heapUsedKb)) {
      window.heapUsedKb = appendBounded(window.heapUsedKb, sample.heapUsedKb);
    }
    window.processCountPeak = Math.max(window.processCountPeak, sample.processCount);
    window.uptimeMinutes = Math.max(window.uptimeMinutes, sample.uptimeMinutes);
  }

  /**
   * Fraction of background ticks in the window.
   * Role events and device-level `perf_system_window` share this value, so there is one scene count.
   * `drain()` clears the count; read it for the device event before draining.
   */
  get backgroundRatio(): number {
    return this.sceneTicks > 0 ? roundMetric(this.backgroundTicks / this.sceneTicks) : 0;
  }

  /** Return and clear all windows; `sample_count` reports the actual number of samples in each window (including partial windows). */
  drain(): ProcessRoleWindowReport[] {
    const backgroundRatio = this.backgroundRatio;
    const reports = [...this.windows.values()]
      .filter((window) => window.cpuPercent.length > 0)
      .map((window) => projectWindow(window, backgroundRatio));
    this.clear();
    return reports;
  }

  clear(): void {
    this.windows.clear();
    this.sceneTicks = 0;
    this.backgroundTicks = 0;
  }
}

/**
 * On overflow, drop the oldest samples. The limit is reached only when timer drift puts more than
 * 30 ticks in one window; at that point, the latest readings are the facts for the interval being reported.
 */
function appendBounded(bucket: number[], value: number): number[] {
  return appendBoundedSamples(bucket, value, PROCESS_RESOURCE_MAX_SAMPLES_PER_WINDOW);
}

function projectWindow(
  window: ProcessRoleWindow,
  backgroundRatio: number,
): ProcessRoleWindowReport {
  const cpu = computeAggregateStats(window.cpuPercent);
  const rssTotal = computeAggregateStats(window.rssKbTotal);
  const rssMaxProcess = computeAggregateStats(window.rssKbMaxProcess);
  const heap = window.heapUsedKb.length > 0 ? computeAggregateStats(window.heapUsedKb) : null;

  return {
    role: window.role,
    runtimeSurface: window.runtimeSurface,
    mcpId: window.mcpId,
    hardware: window.hardware,
    backgroundRatio,
    uptimeMinutes: window.uptimeMinutes,
    cpuPercentMean: cpu.mean,
    cpuPercentP95: cpu.p95,
    cpuPercentPeak: cpu.peak,
    rssKbTotalMean: rssTotal.mean,
    rssKbTotalPeak: rssTotal.peak,
    rssKbMaxProcessPeak: rssMaxProcess.peak,
    heapUsedKbMean: heap?.mean,
    heapUsedKbPeak: heap?.peak,
    processCountPeak: window.processCountPeak,
    sampleCount: cpu.sample_count,
  };
}

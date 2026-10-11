/**
 * Bounded aggregation windows for device-level resources.
 *
 * One `perf_system_window` per device/window: whole-machine CPU and available memory, application
 * totals, and telemetry overhead. Like role windows, this is in-memory and bounded, with no queue or
 * retries; flush projects it into one report.
 */

import {
  appendBoundedSamples,
  computeAggregateStats,
  roundMetric,
} from "./resourceMetricsStats.js";
import { PROCESS_RESOURCE_MAX_SAMPLES_PER_WINDOW } from "./processResourceWindowAggregator.js";

/** Instantaneous device-level facts for one 10-second tick; no sample is produced without a whole-machine CPU baseline. */
export interface DeviceResourceSample {
  /** Whole-machine CPU (percentage normalized across the machine, derived from two `os.cpus()` snapshots). */
  systemCpuPercent: number;
  systemFreeMemoryKb: number;
  /** Sum of CPU usage across all local ZCode processes. */
  appCpuPercent: number;
  appRssKbTotal: number;
  appProcessCount: number;
}

export interface SystemResourceWindowReport {
  backgroundRatio: number;
  appUptimeMinutes: number;
  systemCpuPercentP95: number;
  systemFreeMemoryKbMin: number;
  /** Event value. */
  appCpuPercentMean: number;
  appCpuPercentP95: number;
  appRssKbTotalMean: number;
  appRssKbTotalPeak: number;
  processCountTotalPeak: number;
  sampleCount: number;
  telemetrySelfMs: number;
}

export class ProcessResourceSystemWindowAggregator {
  private systemCpuPercent: number[] = [];
  private systemFreeMemoryKb: number[] = [];
  private appCpuPercent: number[] = [];
  private appRssKbTotal: number[] = [];
  private processCountTotalPeak = 0;
  private telemetrySelfMs = 0;

  add(sample: DeviceResourceSample): void {
    this.systemCpuPercent = appendSample(this.systemCpuPercent, sample.systemCpuPercent);
    this.systemFreeMemoryKb = appendSample(this.systemFreeMemoryKb, sample.systemFreeMemoryKb);
    this.appCpuPercent = appendSample(this.appCpuPercent, sample.appCpuPercent);
    this.appRssKbTotal = appendSample(this.appRssKbTotal, sample.appRssKbTotal);
    this.processCountTotalPeak = Math.max(this.processCountTotalPeak, sample.appProcessCount);
  }

  /**
   * Accumulated wall-clock time spent in main-side telemetry code itself (self-measured overhead).
   * The flush duration can only be counted in the next window because it occurs after projection.
   */
  addTelemetrySelfMs(elapsedMs: number): void {
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
      return;
    }
    this.telemetrySelfMs += elapsedMs;
  }

  /**
   * Return and clear the window. Return null when there are no device samples and do not emit an
   * empty event. Carry accumulated self-measured overhead into the next window; windows where
   * sampling repeatedly fails most need telemetry cost visibility.
   * `backgroundRatio` comes from the role aggregator's scene count so both events report the same value.
   */
  drain(input: {
    backgroundRatio: number;
    appUptimeMinutes: number;
  }): SystemResourceWindowReport | null {
    if (this.appCpuPercent.length === 0) {
      this.clearSamples();
      return null;
    }

    const systemCpu = computeAggregateStats(this.systemCpuPercent);
    const appCpu = computeAggregateStats(this.appCpuPercent);
    const appRss = computeAggregateStats(this.appRssKbTotal);
    const report: SystemResourceWindowReport = {
      backgroundRatio: input.backgroundRatio,
      appUptimeMinutes: input.appUptimeMinutes,
      systemCpuPercentP95: systemCpu.p95,
      systemFreeMemoryKbMin: Math.min(...this.systemFreeMemoryKb),
      appCpuPercentMean: appCpu.mean,
      appCpuPercentP95: appCpu.p95,
      appRssKbTotalMean: appRss.mean,
      appRssKbTotalPeak: appRss.peak,
      processCountTotalPeak: this.processCountTotalPeak,
      sampleCount: appCpu.sample_count,
      telemetrySelfMs: roundMetric(this.telemetrySelfMs),
    };
    this.clear();
    return report;
  }

  clear(): void {
    this.clearSamples();
    this.telemetrySelfMs = 0;
  }

  private clearSamples(): void {
    this.systemCpuPercent = [];
    this.systemFreeMemoryKb = [];
    this.appCpuPercent = [];
    this.appRssKbTotal = [];
    this.processCountTotalPeak = 0;
  }
}

/** Use the same limit and overflow policy as role windows: keep the latest readings when timers drift. */
function appendSample(bucket: number[], value: number): number[] {
  return appendBoundedSamples(bucket, value, PROCESS_RESOURCE_MAX_SAMPLES_PER_WINDOW);
}

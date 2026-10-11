import { randomBytes } from "node:crypto";
import { availableParallelism, totalmem } from "node:os";
import {
  ZCODE_CLI_RESOURCE_SAMPLE_INTERVAL_MS,
  type ZCodeProcessResourceSample,
} from "@zcode/shared";

/** Sampling interval shared with app-side aggregation, preventing the two cadences from drifting. */
export const ZCODE_PROCESS_RESOURCE_SAMPLE_INTERVAL_MS = ZCODE_CLI_RESOURCE_SAMPLE_INTERVAL_MS;

let processInstanceToken: string | undefined;

/**
 * Instance ID for this CLI process: generate once at the first sample and keep it for the process
 * lifetime, including when the sampler is recreated.
 *
 * Used only by app-side main to count simultaneously alive CLI processes and measure maximum per-process RSS.
 *
 * Contains no PID and never leaves the machine; using a random token instead of a PID is a privacy requirement.
 */
function resolveProcessInstanceToken(): string {
  processInstanceToken ??= randomBytes(8).toString("hex");
  return processInstanceToken;
}

interface CpuUsageSnapshot {
  user: number;
  system: number;
}

/** Same shape as Node `process.memoryUsage()`; local memory diagnostics need heap details, while protocol samples include only rss. */
export interface ProcessMemoryUsageSnapshot {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

interface ResourceSamplerTimerHandle {
  unref?(): void;
}

interface ResourceSamplerTimer {
  setInterval(callback: () => void, intervalMs: number): ResourceSamplerTimerHandle;
  clearInterval(handle: ResourceSamplerTimerHandle): void;
}

interface CreateZCodeProcessResourceSamplerOptions {
  /**
   * The second argument is the full memory snapshot for this cycle, used by local in-process
   * diagnostics. The protocol sample itself contains only rss and heapUsed memory fields.
   */
  onSample(sample: ZCodeProcessResourceSample, memoryUsage: ProcessMemoryUsageSnapshot): void;
  platform?: ZCodeProcessResourceSample["platform"];
  arch?: ZCodeProcessResourceSample["arch"];
  logicalCpuCount?: number;
  readCpuUsage?: () => CpuUsageSnapshot;
  readMonotonicTimeNs?: () => bigint;
  readMemoryUsage?: () => ProcessMemoryUsageSnapshot;
/** Physical memory on the machine running this process, read once at construction (does not change within the process). */
  readTotalMemoryBytes?: () => number;
/** Process uptime; the platform buckets by uptime to detect memory growth over time. */
  readUptimeSeconds?: () => number;
/** Allows tests to inject a predictable instance ID; production uses the process-level random token. */
  instanceToken?: string;
  timer?: ResourceSamplerTimer;
}

export interface ZCodeProcessResourceSampler {
  start(): void;
  stop(): void;
}

interface ResourceSamplerBaseline {
  cpu: CpuUsageSnapshot;
  monotonicTimeNs: bigint;
}

const defaultTimer: ResourceSamplerTimer = {
  setInterval(callback, intervalMs) {
    return setInterval(callback, intervalMs);
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

function roundResourceMetric(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * If a reading is unavailable, omit the field (both are optional in the protocol); do not substitute 0.
 * Errors thrown while reading are handled by the outer sampling try/catch (rule 6: drop on failure).
 */
function toRoundedUnit(value: number, divisor: number): number | undefined {
  return Number.isFinite(value) && value >= 0 ? Math.round(value / divisor) : undefined;
}

export function createZCodeProcessResourceSampler(
  options: CreateZCodeProcessResourceSamplerOptions,
): ZCodeProcessResourceSampler {
  const platform = options.platform ?? (process.platform as ZCodeProcessResourceSample["platform"]);
  const arch = options.arch ?? (process.arch as ZCodeProcessResourceSample["arch"]);
  const logicalCpuCount = Math.max(
    1,
    Math.min(4_096, Math.trunc(options.logicalCpuCount ?? availableParallelism())),
  );
  const readCpuUsage = options.readCpuUsage ?? (() => process.cpuUsage());
  const readMonotonicTimeNs = options.readMonotonicTimeNs ?? (() => process.hrtime.bigint());
  // One memoryUsage() call returns rss and heap details; memoryUsage.rss() alone also reads /proc
  // on Linux, so combining them does not add cost.
  const readMemoryUsage = options.readMemoryUsage ?? (() => process.memoryUsage());
  const readUptimeSeconds = options.readUptimeSeconds ?? (() => process.uptime());
  const instanceToken = options.instanceToken ?? resolveProcessInstanceToken();
  // Read physical memory for the running machine once at construction: remote CLI samples use this
  // value instead of the desktop machine's total_memory_gb.
  const totalMemoryGb = toRoundedUnit(
    (options.readTotalMemoryBytes ?? (() => totalmem()))(),
    1024 ** 3,
  );
  const timer = options.timer ?? defaultTimer;
  let baseline: ResourceSamplerBaseline | undefined;
  let timerHandle: ResourceSamplerTimerHandle | undefined;

  const readBaseline = (): ResourceSamplerBaseline => ({
    cpu: readCpuUsage(),
    monotonicTimeNs: readMonotonicTimeNs(),
  });

  const sample = (): void => {
    try {
      const nextBaseline = readBaseline();
      if (!baseline) {
        baseline = nextBaseline;
        return;
      }
      const elapsedNs = nextBaseline.monotonicTimeNs - baseline.monotonicTimeNs;
      const cpuDeltaUs =
        nextBaseline.cpu.user - baseline.cpu.user + (nextBaseline.cpu.system - baseline.cpu.system);
      if (elapsedNs <= 0n || cpuDeltaUs < 0) {
        baseline = nextBaseline;
        return;
      }
      const intervalMs = Math.round(Number(elapsedNs) / 1_000_000);
      if (intervalMs <= 0) {
        baseline = nextBaseline;
        return;
      }
      const cpuCores = cpuDeltaUs / (Number(elapsedNs) / 1_000);
      const memoryUsage = readMemoryUsage();
      const rssKb = memoryUsage.rss / 1_024;
      const uptimeMinutes = toRoundedUnit(readUptimeSeconds(), 60);
      baseline = nextBaseline;
      const resourceSample: ZCodeProcessResourceSample = {
        platform,
        arch,
        logicalCpuCount,
        intervalMs,
        cpuCores: roundResourceMetric(cpuCores),
        cpuPercent: roundResourceMetric((cpuCores / logicalCpuCount) * 100),
        rssKb: roundResourceMetric(rssKb),
        heapUsedKb: roundResourceMetric(memoryUsage.heapUsed / 1_024),
        instanceToken,
        ...(uptimeMinutes === undefined ? {} : { uptimeMinutes }),
        ...(totalMemoryGb === undefined ? {} : { totalMemoryGb }),
      };
      try {
        options.onSample(resourceSample, memoryUsage);
      } catch {
        // If reporting is closed or backpressured, drop only the current sample; do not propagate the error to the Agent main loop.
      }
    } catch {
      // If the process metrics API fails, skip only this cycle and retain the most recent successful baseline for recovery.
    }
  };

  return {
    start() {
      if (timerHandle) {
        return;
      }
      try {
        baseline = readBaseline();
      } catch {
        baseline = undefined;
      }
      try {
        timerHandle = timer.setInterval(sample, ZCODE_PROCESS_RESOURCE_SAMPLE_INTERVAL_MS);
      } catch {
        timerHandle = undefined;
        return;
      }
      try {
        timerHandle.unref?.();
      } catch {
        // If unref is unavailable, retain the timer owner so stop can still clean up the timer.
      }
    },
    stop() {
      if (!timerHandle) {
        return;
      }
      const handle = timerHandle;
      timerHandle = undefined;
      baseline = undefined;
      try {
        timer.clearInterval(handle);
      } catch {
        // Sampler cleanup failure must not block the CLI's existing exit flow.
      }
    },
  };
}

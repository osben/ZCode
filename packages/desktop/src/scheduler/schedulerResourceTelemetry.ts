/**
 * Resource telemetry for the cron scheduler process.
 *
 * The scheduler previously collected no samples. This module adds its only unref'ed timer: every 60
 * seconds it reads `process.cpuUsage()` and `process.memoryUsage()`, then sends the sample to main through
 * parentPort. The heap value becomes the source for scheduler-role events. Read or send failures only
 * drop the current sample and do not affect the dispatch loop.
 * No external process is started, and the unref'ed timer does not extend the process lifetime.
 */

import {
  createNodeSelfResourceSampler,
  NODE_SELF_RESOURCE_SAMPLE_INTERVAL_MS,
  type NodeSelfResourceSamplerOptions,
} from "@zcode/shared/node";
import type { SchedulerToMainMessage } from "./schedulerProtocol.js";

interface SchedulerResourceTelemetryTimerHandle {
  unref?(): void;
}

export interface StartSchedulerResourceTelemetryOptions extends NodeSelfResourceSamplerOptions {
  /** The parentPort sender; callers pass a no-op when parentPort is unavailable. */
  postMessage: (message: SchedulerToMainMessage) => void;
  readMemoryUsage?: () => NodeJS.MemoryUsage;
  intervalMs?: number;
  timer?: {
    setInterval(callback: () => void, intervalMs: number): SchedulerResourceTelemetryTimerHandle;
    clearInterval(handle: SchedulerResourceTelemetryTimerHandle): void;
  };
}

export interface SchedulerResourceTelemetry {
  stop(): void;
}

export function startSchedulerResourceTelemetry(
  options: StartSchedulerResourceTelemetryOptions,
): SchedulerResourceTelemetry {
  const sampler = createNodeSelfResourceSampler(options);
  const readMemoryUsage = options.readMemoryUsage ?? (() => process.memoryUsage());
  const timer = options.timer ?? {
    setInterval: (callback: () => void, intervalMs: number) => setInterval(callback, intervalMs),
    clearInterval: (handle: SchedulerResourceTelemetryTimerHandle) =>
      clearInterval(handle as ReturnType<typeof setInterval>),
  };

  const sampleNow = (): void => {
    try {
      const sample = sampler.sample(readMemoryUsage());
      if (!sample) {
        return;
      }
      options.postMessage({ type: "scheduler-resource-sample", sample });
    } catch {
      // Drop only the current sample if reading fails, parentPort is unavailable, or postMessage throws.
    }
  };

  let handle: SchedulerResourceTelemetryTimerHandle | undefined = timer.setInterval(
    sampleNow,
    options.intervalMs ?? NODE_SELF_RESOURCE_SAMPLE_INTERVAL_MS,
  );
  try {
    handle.unref?.();
  } catch {
    // Keep the handle for stop() to dispose even when unref is unavailable.
  }

  return {
    stop() {
      if (!handle) {
        return;
      }
      const current = handle;
      handle = undefined;
      try {
        timer.clearInterval(current);
      } catch {
        // A cleanup failure must not block the scheduler's existing shutdown flow.
      }
    },
  };
}

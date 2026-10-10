/**
 * Shared conversion logic for CPU/memory samples collected by the host and scheduler utilityProcesses.
 *
 * Performs only delta conversion: it owns no timer and does not send data. The host reuses the existing 60-second timer
 * for memory diagnostic logs; the scheduler starts its single unref timer. Both pass the same `process.memoryUsage()` reading
 * here to convert into one sample. No external processes are involved; only in-process APIs are used.
 */

import { availableParallelism } from "node:os";
import { bytesToKb } from "../memoryDiagnostics.js";
import type { NodeSelfResourceSample } from "../validation.js";

interface NodeCpuUsageSnapshot {
  user: number;
  system: number;
}

/** Node process self-sampling interval: 60 seconds, aligned with local memory diagnostic logs. */
export const NODE_SELF_RESOURCE_SAMPLE_INTERVAL_MS = 60_000;

export interface NodeSelfResourceSamplerOptions {
  readCpuUsage?: () => NodeCpuUsageSnapshot;
  readMonotonicTimeNs?: () => bigint;
  logicalCpuCount?: number;
}

export interface NodeSelfResourceSampler {
  /**
   * Converts the caller's latest `memoryUsage` reading into a sample.
   * Returns null when the baseline is unavailable (first read failed, clock did not advance, or CPU counter decreased); only the current sample is dropped.
   */
  sample(memoryUsage: NodeJS.MemoryUsage): NodeSelfResourceSample | null;
}

interface SamplerBaseline {
  cpu: NodeCpuUsageSnapshot;
  monotonicTimeNs: bigint;
}

/** CPU percentage is rounded to 4 decimal places, matching CLI self-sampled values. */
function roundResourceMetric(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function createNodeSelfResourceSampler(
  options: NodeSelfResourceSamplerOptions = {},
): NodeSelfResourceSampler {
  const readCpuUsage = options.readCpuUsage ?? (() => process.cpuUsage());
  const readMonotonicTimeNs = options.readMonotonicTimeNs ?? (() => process.hrtime.bigint());
  const logicalCpuCount = Math.max(
    1,
    Math.min(4_096, Math.trunc(options.logicalCpuCount ?? availableParallelism())),
  );

  const readBaseline = (): SamplerBaseline | null => {
    try {
      return { cpu: readCpuUsage(), monotonicTimeNs: readMonotonicTimeNs() };
    } catch {
      return null;
    }
  };

  // Establish the baseline during construction so the first 60-second tick produces a sample instead of an empty cycle.
  let baseline = readBaseline();

  return {
    sample(memoryUsage) {
      const next = readBaseline();
      if (!next) {
        return null;
      }
      const previous = baseline;
      baseline = next;
      if (!previous) {
        return null;
      }

      const elapsedNs = next.monotonicTimeNs - previous.monotonicTimeNs;
      const cpuDeltaUs =
        next.cpu.user - previous.cpu.user + (next.cpu.system - previous.cpu.system);
      if (elapsedNs <= 0n || cpuDeltaUs < 0) {
        return null;
      }

      const cpuCores = cpuDeltaUs / (Number(elapsedNs) / 1_000);
      return {
        cpuPercent: roundResourceMetric((cpuCores / logicalCpuCount) * 100),
        rssKb: bytesToKb(memoryUsage.rss),
        heapUsedKb: bytesToKb(memoryUsage.heapUsed),
      };
    },
  };
}

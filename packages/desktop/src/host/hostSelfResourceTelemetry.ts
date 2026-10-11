/**
 * Resource telemetry for the Host process itself.
 *
 * Reuse the existing 60-second timer from memory diagnostics: one `process.memoryUsage()` reading has two outputs—
 * write the local `[memory] role=utility_host` log line under the existing gate, and convert the same reading into
 * a `HostResourceSample` sent to Main through parentPort as the heap source for the Host-role event.
 * The process therefore still has only one telemetry timer; any failure drops only the current sample and does not affect Host services.
 */

import { HostResponseTypes } from "@zcode/shared";
import {
  createNodeSelfResourceSampler,
  type NodeSelfResourceSamplerOptions,
} from "@zcode/shared/node";
import {
  startHostMemoryDiagnosticsLog,
  type StartHostMemoryDiagnosticsLogOptions,
} from "./hostMemoryDiagnosticsLog.js";

export interface StartHostSelfResourceTelemetryOptions
  extends
    Omit<StartHostMemoryDiagnosticsLogOptions, "onMemoryUsage">,
    NodeSelfResourceSamplerOptions {
  /**
   * parentPort send function. Host has no parentPort outside utilityProcess (for example, during local debugging),
   * so it writes only the local log and does not send a sample.
   */
  postMessage?: ((message: unknown) => void) | undefined;
}

export interface HostSelfResourceTelemetry {
  /** Sample immediately (for tests and manual triggers); return whether the local log was written to disk. */
  sampleNow(): boolean;
  stop(): void;
}

export function startHostSelfResourceTelemetry(
  options: StartHostSelfResourceTelemetryOptions,
): HostSelfResourceTelemetry {
  const sampler = createNodeSelfResourceSampler(options);
  const postMessage = options.postMessage;

  // Pass options individually rather than spreading the whole object; sampler-only options such as readCpuUsage must not leak into the diagnostics module.
  return startHostMemoryDiagnosticsLog({
    logger: options.logger,
    collectCounters: options.collectCounters,
    readMemoryUsage: options.readMemoryUsage,
    now: options.now,
    intervalMs: options.intervalMs,
    timer: options.timer,
    onMemoryUsage: (memoryUsage) => {
      if (!postMessage) {
        return;
      }
      const sample = sampler.sample(memoryUsage);
      if (!sample) {
        return;
      }
      try {
        postMessage({ type: HostResponseTypes.HostResourceSample, sample });
      } catch {
        // If Main has exited or IPC is unavailable, drop only the current sample.
      }
    },
  });
}

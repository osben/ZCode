/**
 * Types and scheduling for the resource sample-source registry.
 *
 * Each source lives in its own file and adds one registry entry; sources do not know about one
 * another. A sampling failure drops only that source's sample and does not block business logic.
 */

import type { ProcessResourceRole } from "@zcode/shared";
import type { AppResourceTotals } from "./processResourceAppTotals.js";
import type { DeviceResourceSample } from "./processResourceSystemWindowAggregator.js";
import type { ProcessRoleSample } from "./processResourceWindowAggregator.js";

export interface ProcessResourceSampleContext {
  /** Wall-clock time for this tick, shared by all sources to avoid timestamp drift within one tick. */
  now: number;
  addRoleSample: (sample: ProcessRoleSample) => void;
  /**
   * Sources that contribute only a heap reading and not a complete role sample use this hook
   * (Host/scheduler self-sampling, renderer). Merge heap into the complete sample for that role in
   * the same tick. Drop the reading if the role has no complete sample this tick; heap is an
   * additional dimension of a role event and cannot open a window on its own.
   */
  addRoleHeapSample: (role: ProcessResourceRole, heapUsedKb: number) => void;
  /**
   * Total for application processes that main can enumerate exactly in this tick (currently only the
   * Chromium subsystem). The device-level source reads this in phase two to calculate application
   * totals, so this value must not double-count the external-sample entry point.
   */
  addAppProcessTotals: (totals: AppResourceTotals) => void;
  onError?: (sourceId: string, error: unknown) => void;
}

/**
 * Context for device-level sampling (phase two), which depends on facts collected in phase one during
 * the same tick. Running the phases separately avoids passing data through call ordering or module-level variables.
 */
export interface ProcessResourceDeviceSampleContext {
  now: number;
  /** Exact total from phase one; null if no source contributed during this tick, in which case no device sample is produced. */
  appProcessTotals: AppResourceTotals | null;
  addDeviceSample: (sample: DeviceResourceSample) => void;
  onError?: (sourceId: string, error: unknown) => void;
}

export interface ProcessResourceSampleSource {
  /** Source identifier, used only for logs and registry uniqueness checks; not included in event properties. */
  readonly id: string;
  /**
   * Called on each 10-second main tick to write this source's current instantaneous facts into the current window.
   *
   * Push sources (Host/scheduler heap, renderer heap, CLI, MCP) use this hook too: each exports an
   * `ingestXxx(sample)` for the message dispatcher to store the latest sample in the source module,
   * then passes it to the aggregator from `sample()`. This keeps window boundaries under main's
   * flush clock, keeps sources independent, and requires only one registry entry.
   */
  sample?: (context: ProcessResourceSampleContext) => void;
  /**
   * Sources that need facts already collected by other sources in the same tick use this hook
   * (`perf_system_window`). Run all `sample` methods first, then all `sampleDevice` methods.
   */
  sampleDevice?: (context: ProcessResourceDeviceSampleContext) => void;
  /**
   * Called during normal shutdown to drain partial windows: deliver readings that have already
   * arrived but have not reached their source's delivery interval (CLI, and likewise MCP).
   * **Move existing facts only; do not sample again** — shutdown must not read `getAppMetrics()` or start probes.
   */
  flushPending?: (context: ProcessResourceSampleContext) => void;
  /** Clear transient state cached by each source when sampling stops/restarts to prevent data crossing sessions. */
  reset?: () => void;
}

export function runProcessResourceSampleSources(
  sources: readonly ProcessResourceSampleSource[],
  context: ProcessResourceSampleContext,
): void {
  for (const source of sources) {
    try {
      source.sample?.(context);
    } catch (error) {
      context.onError?.(source.id, error);
    }
  }
}

export function runProcessResourceDeviceSampleSources(
  sources: readonly ProcessResourceSampleSource[],
  context: ProcessResourceDeviceSampleContext,
): void {
  for (const source of sources) {
    try {
      source.sampleDevice?.(context);
    } catch (error) {
      context.onError?.(source.id, error);
    }
  }
}

export function flushPendingProcessResourceSampleSources(
  sources: readonly ProcessResourceSampleSource[],
  context: ProcessResourceSampleContext,
): void {
  for (const source of sources) {
    try {
      source.flushPending?.(context);
    } catch (error) {
      context.onError?.(source.id, error);
    }
  }
}

export function resetProcessResourceSampleSources(
  sources: readonly ProcessResourceSampleSource[],
): void {
  for (const source of sources) {
    try {
      source.reset?.();
    } catch {
      // reset only discards transient state; a failure must not affect other sources or later sampling.
    }
  }
}

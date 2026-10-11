/**
 * External sample entry point for device-level application totals.
 *
 * Application totals in `perf_system_window` are defined as "the exact Chromium-system total every
 * 10 seconds plus the latest known external sample." External processes (CLI self-sampling every 60
 * seconds, MCP sampling every five minutes) are not included in `app.getAppMetrics()` and cannot
 * provide readings on main's 10-second schedule. Keep only the latest sample from each source and
 * determine expiration using that source's own sampling period: no new sample for two periods means
 * the process exited or its sampling path failed. Under-count rather than treat stale values as current.
 *
 * CLI and MCP roles call `recordExternalAppResourceSample` at their respective ingestion points.
 * In-memory and bounded; drop failures without queuing, persisting, or retrying.
 */

import type { ProcessResourceRuntimeSurface } from "@zcode/shared";
import {
  addAppResourceTotals,
  createEmptyAppResourceTotals,
  type AppResourceTotals,
} from "./processResourceAppTotals.js";

/** Default sampling period when a source does not report one (the CLI self-sampling interval). */
export const EXTERNAL_APP_RESOURCE_SAMPLE_DEFAULT_INTERVAL_MS = 60_000;

/**
 * Maximum number of source entries (bounded memory).
 * CLI now stores up to 64 instances, so increase the budget by those 64 entries while keeping the
 * existing space for MCP sources. Increase only the memory limit; add no queue or timer, and drop
 * new sources above the limit.
 */
export const PROCESS_RESOURCE_MAX_EXTERNAL_SAMPLE_SOURCES = 128;

export interface ExternalAppResourceSample extends AppResourceTotals {
  /**
   * Stable source key (such as CLI instance or MCP source group), used only to replace old samples
   * and determine expiration. It is not included in ARMS properties, so it must not contain a PID,
   * path, or workspace identifier.
   */
  sourceKey: string;
  /** Device-level totals count local processes only; discard remote CLI/MCP samples here. */
  runtimeSurface: ProcessResourceRuntimeSurface;
  /** Source sampling period; expire after two periods without an update. Defaults to 60 seconds. */
  intervalMs?: number;
  /** Time the sample reached main. */
  receivedAt: number;
}

interface StoredExternalSample extends AppResourceTotals {
  receivedAt: number;
  expiresAfterMs: number;
}

const latestSamplesBySource = new Map<string, StoredExternalSample>();

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/** Record the latest sample from an external source; drop invalid samples without affecting existing totals. */
export function recordExternalAppResourceSample(sample: ExternalAppResourceSample): void {
  if (sample.runtimeSurface !== "local" || !sample.sourceKey) {
    return;
  }
  if (
    !isNonNegativeFinite(sample.cpuPercent) ||
    !isNonNegativeFinite(sample.rssKbTotal) ||
    !isNonNegativeFinite(sample.processCount) ||
    !Number.isFinite(sample.receivedAt)
  ) {
    return;
  }
  if (
    !latestSamplesBySource.has(sample.sourceKey) &&
    latestSamplesBySource.size >= PROCESS_RESOURCE_MAX_EXTERNAL_SAMPLE_SOURCES
  ) {
    return;
  }

  const intervalMs =
    typeof sample.intervalMs === "number" &&
    Number.isFinite(sample.intervalMs) &&
    sample.intervalMs > 0
      ? sample.intervalMs
      : EXTERNAL_APP_RESOURCE_SAMPLE_DEFAULT_INTERVAL_MS;

  latestSamplesBySource.set(sample.sourceKey, {
    cpuPercent: sample.cpuPercent,
    rssKbTotal: sample.rssKbTotal,
    processCount: sample.processCount,
    receivedAt: sample.receivedAt,
    expiresAfterMs: intervalMs * 2,
  });
}

/** Aggregate unexpired external sources and remove expired entries to prevent zombie sources from lingering in long sessions. */
export function collectExternalAppResourceTotals(now: number): AppResourceTotals {
  let totals = createEmptyAppResourceTotals();
  for (const [sourceKey, sample] of latestSamplesBySource) {
    if (now - sample.receivedAt > sample.expiresAfterMs) {
      latestSamplesBySource.delete(sourceKey);
      continue;
    }
    totals = addAppResourceTotals(totals, sample);
  }
  return totals;
}

/** Clear all sources when sampling starts/stops to prevent data from crossing sampling sessions. */
export function resetExternalAppResourceSamples(): void {
  latestSamplesBySource.clear();
}

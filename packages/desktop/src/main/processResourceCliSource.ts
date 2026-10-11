/**
 * Resource sample source for zcode-cli roles (`cli_chat` / `cli_aux`, fifth registry entry).
 *
 * Each CLI process self-samples every 60 seconds, sends the sample to services through the protocol
 * (where the owning process manager assigns a lane), then Host forwards it to main. Keep the latest
 * reading per process, grouped by role × runtime_surface × process instance, and deliver totals for
 * currently live processes to the window aggregator every 60 seconds:
 *
 * - Do not deliver on every 10-second tick: CLI samples have a 60-second cadence, so tick-based
 *   delivery would count each reading repeatedly and increase `sample_count` from the expected 5 to 30.
 * - Do not use "deliver on arrival, clear after delivery" (the Host/renderer-heap approach): the
 *   60-second timers for multiple CLI processes have different phases, so each tick usually receives
 *   readings from only some processes, undercounting both `process_count_peak` and totals. Role events
 *   need the number of simultaneously live processes and their combined usage, so retain each
 *   process's latest reading.
 * - Use the same expiration rule as device-level external samples: if no reading arrives for two
 *   sampling periods, treat the process as exited and exclude it. Under-count rather than present
 *   stale values as current facts.
 * - Deliver only when there is a new reading, so the same reading is never counted twice.
 * - On normal exit, use `flushPending` to deliver readings already received but not yet at their
 *   60-second delivery point (move existing facts only; do not sample again).
 *
 * Privacy boundary: `instanceToken` distinguishes processes only in this module's memory and is
 * never included in ARMS properties; samples contain no PID.
 */

import {
  agentLaneResourceSampleSchema,
  resolveCliProcessResourceRole,
  ZCODE_CLI_RESOURCE_SAMPLE_INTERVAL_MS,
  type AgentLaneResourceSample,
  type ProcessResourceRole,
  type ProcessResourceRuntimeSurface,
} from "@zcode/shared";
import { recordExternalAppResourceSample } from "./processResourceExternalAppSamples.js";
import type {
  ProcessResourceSampleContext,
  ProcessResourceSampleSource,
} from "./processResourceSampleSources.js";
import {
  processResourceHardwareKey,
  type ProcessResourceHardwareOverride,
  type ProcessRoleSample,
} from "./processResourceWindowAggregator.js";
import { roundMetric } from "./resourceMetricsStats.js";

/**
 * Maximum number of concurrently tracked CLI processes (bounded memory).
 * The normal shape is one chat process per workspace plus three control-plane lanes; 64 is well
 * above actual use. Drop new processes beyond this limit.
 */
const PROCESS_RESOURCE_MAX_CLI_INSTANCES = 64;

/** Legacy CLI samples without instanceToken share one bucket; individual processes cannot be distinguished, so count them as one. */
const LEGACY_INSTANCE_KEY = "legacy";

interface StoredCliSample {
  role: ProcessResourceRole;
  runtimeSurface: ProcessResourceRuntimeSurface;
  environmentKey?: string;
  sample: AgentLaneResourceSample;
  /** Arrival time, used only to determine expiration. */
  receivedAt: number;
  /**
   * Whether this reading has been delivered to the window aggregator.
   * Use an explicit flag instead of comparing timestamps: if a reading and delivery occur in the
   * same millisecond, timestamp comparison could treat it as delivered and permanently drop it.
   */
  delivered: boolean;
}

const latestSamplesByInstance = new Map<string, StoredCliSample>();

/**
 * Main-side trust boundary: the payload is strictly validated against the Host response schema before
 * reaching here, but validate it again because other paths (scheduler/remote relay) reuse the same
 * entry point. Drop invalid samples without throwing.
 */
export function ingestCliResourceSample(
  raw: unknown,
  runtimeSurface: ProcessResourceRuntimeSurface,
  environmentKey?: string,
): void {
  const parsed = agentLaneResourceSampleSchema.safeParse(raw);
  if (!parsed.success) {
    return;
  }
  const sample = parsed.data;
  const role = resolveCliProcessResourceRole(sample.lane);
  const key = [
    role,
    runtimeSurface,
    environmentKey ?? "",
    sample.instanceToken ?? LEGACY_INSTANCE_KEY,
  ].join(":");
  if (
    !latestSamplesByInstance.has(key) &&
    latestSamplesByInstance.size >= PROCESS_RESOURCE_MAX_CLI_INSTANCES
  ) {
    return;
  }
  const receivedAt = Date.now();
  latestSamplesByInstance.set(key, {
    role,
    runtimeSurface,
    environmentKey,
    sample,
    receivedAt,
    delivered: false,
  });
  // Device totals track the original arrival time per instance; using the group's delivery time
  // would renew a stale instance when another group or active instance in the same group reports.
  recordExternalAppResourceSample({
    sourceKey: `cli:${key}`,
    runtimeSurface,
    cpuPercent: sample.cpuPercent,
    rssKbTotal: sample.rssKb,
    processCount: 1,
    intervalMs: resolveSampleIntervalMs(sample),
    receivedAt,
  });
}

/** Keep the sampling period at least as long as CLI's own interval; an unusually short reading gap must not shorten expiration. */
function resolveSampleIntervalMs(sample: AgentLaneResourceSample): number {
  return Math.max(ZCODE_CLI_RESOURCE_SAMPLE_INTERVAL_MS, sample.intervalMs);
}

function resolveHardware(sample: AgentLaneResourceSample): ProcessResourceHardwareOverride {
  return {
    platform: sample.platform,
    arch: sample.arch,
    logicalCpuCount: sample.logicalCpuCount,
    // Older CLI samples do not include machine memory; the output layer supplies the desktop-machine value.
    ...(sample.totalMemoryGb === undefined ? {} : { totalMemoryGb: sample.totalMemoryGb }),
  };
}

/** Drop process entries with no new reading for more than two sampling periods. */
function purgeExpired(now: number): void {
  for (const [key, entry] of latestSamplesByInstance) {
    if (now - entry.receivedAt > resolveSampleIntervalMs(entry.sample) * 2) {
      latestSamplesByInstance.delete(key);
    }
  }
}

interface CliRoleGroup {
  role: ProcessResourceRole;
  runtimeSurface: ProcessResourceRuntimeSurface;
  environmentKey?: string;
  /** Machine shared by this group: it is part of the grouping key, so all processes in the group have identical machine information. */
  hardware: ProcessResourceHardwareOverride;
  samples: AgentLaneResourceSample[];
  fresh: boolean;
}

/**
 * Grouping key: role × runtime_surface × machine.
 * Include the machine because remote workspaces may run on different hosts; their RSS cannot be
 * added together, and hardware dimensions can describe only one machine (the aggregator uses the
 * same fingerprint in its window key).
 */
function groupByRole(): CliRoleGroup[] {
  const groups = new Map<string, CliRoleGroup>();
  for (const entry of latestSamplesByInstance.values()) {
    const hardware = resolveHardware(entry.sample);
    // Matching hardware does not mean the runtime environment is the same; carry the Host-injected identity through instance caching and grouping.
    const key = [
      entry.role,
      entry.runtimeSurface,
      entry.environmentKey ?? "",
      processResourceHardwareKey(hardware),
    ].join(":");
    const group = groups.get(key);
    if (group) {
      group.samples.push(entry.sample);
      group.fresh ||= !entry.delivered;
      continue;
    }
    groups.set(key, {
      role: entry.role,
      runtimeSurface: entry.runtimeSurface,
      environmentKey: entry.environmentKey,
      hardware,
      samples: [entry.sample],
      fresh: !entry.delivered,
    });
  }
  return [...groups.values()];
}

function projectRoleSample(group: CliRoleGroup): ProcessRoleSample {
  let cpuPercent = 0;
  let rssKbTotal = 0;
  let rssKbMaxProcess = 0;
  let uptimeMinutes = 0;
  let heapUsedKb: number | undefined;
  for (const sample of group.samples) {
    cpuPercent += sample.cpuPercent;
    rssKbTotal += sample.rssKb;
    rssKbMaxProcess = Math.max(rssKbMaxProcess, sample.rssKb);
    uptimeMinutes = Math.max(uptimeMinutes, sample.uptimeMinutes ?? 0);
    // For roles with multiple processes, use the largest per-process heap in this sample.
    if (sample.heapUsedKb !== undefined) {
      heapUsedKb = Math.max(heapUsedKb ?? 0, sample.heapUsedKb);
    }
  }

  return {
    role: group.role,
    runtimeSurface: group.runtimeSurface,
    ...(group.environmentKey === undefined ? {} : { environmentKey: group.environmentKey }),
    // Round CPU only after summing; rounding each value would accumulate error as the process count grows.
    cpuPercent: roundMetric(cpuPercent),
    rssKbTotal: roundMetric(rssKbTotal),
    rssKbMaxProcess: roundMetric(rssKbMaxProcess),
    processCount: group.samples.length,
    uptimeMinutes,
    ...(heapUsedKb === undefined ? {} : { heapUsedKb }),
    hardware: group.hardware,
  };
}

/** Time the role sample was last delivered to the window aggregator (`context.now`, same wall clock as ingest's `Date.now()`). */
let lastDeliveredAt: number | null = null;

/** Whether any reading has arrived but not yet been delivered; do not deliver the same fact again without a new reading. */
function hasUndeliveredReading(): boolean {
  for (const entry of latestSamplesByInstance.values()) {
    if (!entry.delivered) {
      return true;
    }
  }
  return false;
}

/** Deliver live processes with new readings to the role window; device totals are maintained per instance at ingestion. */
function deliverRoleSamples(context: ProcessResourceSampleContext): void {
  lastDeliveredAt = context.now;
  // Read each group's new-reading flag before closing it; a new reading somewhere does not mean
  // every group has one, and stale groups must not be renewed by it.
  const groups = groupByRole();
  for (const entry of latestSamplesByInstance.values()) {
    entry.delivered = true;
  }
  for (const group of groups) {
    if (!group.fresh) continue;
    context.addRoleSample(projectRoleSample(group));
  }
}

export const cliProcessResourceSampleSource: ProcessResourceSampleSource = {
  id: "cli",
  sample(context) {
    purgeExpired(context.now);
    // Deliver every 60 seconds, and only when there is a new reading: main's flush clock still owns
    // window boundaries; this controls only how often a CLI sample is counted, so the same reading
    // never contributes twice to statistics.
    if (
      lastDeliveredAt !== null &&
      context.now - lastDeliveredAt < ZCODE_CLI_RESOURCE_SAMPLE_INTERVAL_MS
    ) {
      return;
    }
    if (!hasUndeliveredReading()) {
      return;
    }
    deliverRoleSamples(context);
  },
  flushPending(context) {
    // On normal exit, deliver readings already received in this period but not yet at their 60-second
    // delivery point; otherwise exiting within a one-minute window (development/E2E) would leave no
    // event for the cli role.
    purgeExpired(context.now);
    if (!hasUndeliveredReading()) {
      return;
    }
    deliverRoleSamples(context);
  },
  reset() {
    latestSamplesByInstance.clear();
    lastDeliveredAt = null;
  },
};

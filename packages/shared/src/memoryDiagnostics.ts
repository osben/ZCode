/**
 * Shared pure logic for local process-memory diagnostic logs.
 *
 * The main / renderer / host / agent CLI processes each collect samples, but write gating, line format, and the counter registry
 * have one implementation here to avoid maintaining separate thresholds in four places. This file has no Node/DOM API dependencies.
 */

export type MemorySampleRole = "main" | "renderer" | "utility_host" | "agent_node";

export type MemorySampleWriteReason = "first" | "changed" | "heartbeat";

export interface MemorySampleFields {
  rssKb?: number;
  heapUsedKb?: number;
  heapTotalKb?: number;
  externalKb?: number;
  arrayBuffersKb?: number;
}

export interface MemorySample extends MemorySampleFields {
  role: MemorySampleRole;
  /** `<provider>.<key>` → numeric value; only counts obtained through read-only operations are allowed. */
  counters: Record<string, number>;
}

export interface MemorySampleWriteGateOptions {
  /** Change-ratio threshold for heapUsedKb compared with the last persisted value; defaults to 5%. */
  heapDeltaRatio?: number;
  /**
   * Change-ratio threshold for rssKb / externalKb compared with the last persisted value; defaults to 10%.
   * On a real device, host RSS rose from 240MB to 1.5GB and externalKb to 1.3GB while heapUsed barely moved;
   * heap-only gating treated that minute as a heartbeat and silently dropped it. Native/external memory must be evaluated separately.
   */
  nativeDeltaRatio?: number;
  /** Heartbeat interval when there is no change; defaults to 5 minutes. */
  heartbeatMs?: number;
}

export interface MemorySampleWriteGate {
  /**
   * Determines whether to persist this sample. A non-null return means it should be persisted and recorded as the "last persisted value."
   */
  evaluate(sample: MemorySample, nowMs: number): MemorySampleWriteReason | null;
}

export const MEMORY_SAMPLE_INTERVAL_MS = 60_000;
export const MEMORY_SAMPLE_HEAP_DELTA_RATIO = 0.05;
export const MEMORY_SAMPLE_NATIVE_DELTA_RATIO = 0.1;
export const MEMORY_SAMPLE_HEARTBEAT_MS = 300_000;

const MEMORY_FIELD_ORDER: readonly (keyof MemorySampleFields)[] = [
  "rssKb",
  "heapUsedKb",
  "heapTotalKb",
  "externalKb",
  "arrayBuffersKb",
];

function countersDiffer(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) {
      return true;
    }
  }
  return false;
}

function exceedsRatio(
  current: number | undefined,
  previous: number | undefined,
  ratio: number,
): boolean {
  return (
    current !== undefined &&
    previous !== undefined &&
    Math.abs(current - previous) > Math.max(previous, 1) * ratio
  );
}

export function createMemorySampleWriteGate(
  options: MemorySampleWriteGateOptions = {},
): MemorySampleWriteGate {
  const heapDeltaRatio = options.heapDeltaRatio ?? MEMORY_SAMPLE_HEAP_DELTA_RATIO;
  const nativeDeltaRatio = options.nativeDeltaRatio ?? MEMORY_SAMPLE_NATIVE_DELTA_RATIO;
  const heartbeatMs = options.heartbeatMs ?? MEMORY_SAMPLE_HEARTBEAT_MS;
  let lastWritten: MemorySample | undefined;
  let lastWrittenAt = 0;

  return {
    evaluate(sample, nowMs) {
      let reason: MemorySampleWriteReason | null = null;
      if (!lastWritten) {
        reason = "first";
      } else if (
        exceedsRatio(sample.heapUsedKb, lastWritten.heapUsedKb, heapDeltaRatio) ||
        exceedsRatio(sample.rssKb, lastWritten.rssKb, nativeDeltaRatio) ||
        exceedsRatio(sample.externalKb, lastWritten.externalKb, nativeDeltaRatio)
      ) {
        reason = "changed";
      } else if (countersDiffer(sample.counters, lastWritten.counters)) {
        reason = "changed";
      } else if (nowMs - lastWrittenAt >= heartbeatMs) {
        reason = "heartbeat";
      }
      if (reason) {
        lastWritten = { ...sample, counters: { ...sample.counters } };
        lastWrittenAt = nowMs;
      }
      return reason;
    },
  };
}

export function bytesToKb(bytes: number): number {
  return Math.round(bytes / 1024);
}

/** Converts Node `process.memoryUsage()` results into KB fields; omits missing fields. */
export function memoryUsageToSampleFields(usage: {
  rss?: number;
  heapUsed?: number;
  heapTotal?: number;
  external?: number;
  arrayBuffers?: number;
}): MemorySampleFields {
  const fields: MemorySampleFields = {};
  if (typeof usage.rss === "number") fields.rssKb = bytesToKb(usage.rss);
  if (typeof usage.heapUsed === "number") fields.heapUsedKb = bytesToKb(usage.heapUsed);
  if (typeof usage.heapTotal === "number") fields.heapTotalKb = bytesToKb(usage.heapTotal);
  if (typeof usage.external === "number") fields.externalKb = bytesToKb(usage.external);
  if (typeof usage.arrayBuffers === "number") {
    fields.arrayBuffersKb = bytesToKb(usage.arrayBuffers);
  }
  return fields;
}

/**
 * Single-line `key=value` format: fixed memory fields first, counters afterward in lexical order, all rounded to integers.
 * Example: `[memory] role=main reason=first rssKb=1 heapUsedKb=2 app.windows=1`
 */
export function formatMemorySampleLine(
  sample: MemorySample,
  reason: MemorySampleWriteReason,
): string {
  const parts = [`[memory]`, `role=${sample.role}`, `reason=${reason}`];
  for (const field of MEMORY_FIELD_ORDER) {
    const value = sample[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      parts.push(`${field}=${Math.round(value)}`);
    }
  }
  for (const key of Object.keys(sample.counters).sort()) {
    const value = sample.counters[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      parts.push(`${key}=${Math.round(value)}`);
    }
  }
  return parts.join(" ");
}

export type MemoryDiagnosticsProvider = () => Record<string, number>;

export interface MemoryDiagnosticsRegistry {
  /** A later registration replaces an earlier one with the same name; the returned disposer removes it only if it is still the current registration. */
  register(name: string, provider: MemoryDiagnosticsProvider): { dispose(): void };
  /** Call providers one by one, prefixing keys with `<name>.`; an error from one provider skips only that provider. */
  collect(): Record<string, number>;
}

export function createMemoryDiagnosticsRegistry(): MemoryDiagnosticsRegistry {
  const providers = new Map<string, MemoryDiagnosticsProvider>();
  return {
    register(name, provider) {
      providers.set(name, provider);
      return {
        dispose() {
          if (providers.get(name) === provider) {
            providers.delete(name);
          }
        },
      };
    },
    collect() {
      const result: Record<string, number> = {};
      for (const [name, provider] of providers) {
        try {
          for (const [key, value] of Object.entries(provider())) {
            if (typeof value === "number" && Number.isFinite(value)) {
              result[`${name}.${key}`] = value;
            }
          }
        } catch {
          // Diagnostic providers are read-only; an exception from one must not affect other counters or application behavior.
        }
      }
      return result;
    },
  };
}

/*
 * CLI profile file (agent_node). The CLI writes one JSON record per file under ~/.zcode/cli/memory-diagnostics; the
 * feedback archive and log export read the same files, so the bounds and the sanitizer live here as the single source.
 */

export const CLI_MEMORY_DIAGNOSTICS_DIR_NAME = "memory-diagnostics";
export const CLI_MEMORY_DIAGNOSTIC_FORMAT = "zcode-cli-memory-v1";
/** Filename written by the CLI writer: `memory-<Date.now()>-<instanceId>.jsonl`. */
export const CLI_MEMORY_DIAGNOSTIC_FILE_NAME_PATTERN = /^memory-[0-9]+-[a-f0-9-]{36}\.jsonl$/;
/** Maximum files kept in the directory, and the maximum the archive accepts from one source. */
export const CLI_MEMORY_DIAGNOSTIC_MAX_FILES = 16;
export const CLI_MEMORY_DIAGNOSTIC_MAX_FILE_BYTES = 65_536;
export const CLI_MEMORY_DIAGNOSTIC_MAX_SAMPLES = 8;
export const CLI_MEMORY_DIAGNOSTIC_MAX_ALLOCATIONS = 32;
export const CLI_MEMORY_DIAGNOSTIC_MAX_STACK_FRAMES = 8;

export const CLI_MEMORY_DIAGNOSTIC_COUNTER_KEYS: readonly string[] = [
  "sessions",
  "eventRows",
  "eventEvicted",
  "eventTransientRetained",
  "v4.publishers",
  "v4.detachedLive",
  "v4.detachedTerminal",
  "v4.rawSeqStates",
  "v4.hydrations",
  "v4.historyOpenings",
  "v4.binaryCacheEntries",
  "v4.binaryCacheBytes",
];

export const CLI_MEMORY_DIAGNOSTIC_STATES: readonly string[] = [
  "active",
  "unsupported",
  "budget-exceeded",
  "error",
];

const CLI_MEMORY_TOKEN_PATTERN = /^[a-zA-Z0-9._-]{1,80}$/;
const CLI_MEMORY_INSTANCE_ID_PATTERN = /^[a-f0-9-]{36}$/;
const CLI_MEMORY_BUNDLE_SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CLI_MEMORY_STACK_NAME_PATTERN = /^[a-zA-Z0-9_$.[\]<>-]{0,64}$/;

export interface CliMemoryDiagnosticSample {
  at: number;
  counters: Record<string, number>;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  heapLimit: number;
}

export interface CliMemoryDiagnosticFrame {
  name: string;
  line: number;
  column: number;
}

export interface CliMemoryDiagnosticAllocation {
  bytes: number;
  stack: CliMemoryDiagnosticFrame[];
}

export interface CliMemoryDiagnosticRecord {
  format: typeof CLI_MEMORY_DIAGNOSTIC_FORMAT;
  timestamp: number;
  instanceId: string;
  pid: number;
  version: string;
  commit: string;
  node: string;
  v8: string;
  bundleSha256: string;
  sampler: {
    state: string;
    intervalBytes: number;
    windowStartedAt: number;
    profileCapturedAt: number;
    durationMs: number;
  };
  samples: CliMemoryDiagnosticSample[];
  allocations: CliMemoryDiagnosticAllocation[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Non-finite, negative, or non-number inputs become 0, so one bad field never drops the whole record. */
function asNonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function asToken(value: unknown): string {
  return typeof value === "string" && CLI_MEMORY_TOKEN_PATTERN.test(value) ? value : "";
}

/**
 * Parses an untrusted CLI memory record and keeps only the fixed schema. Unknown keys are dropped, strings are
 * limited to small token / identifier patterns, and arrays are bounded. Returns null when the record is not a
 * `zcode-cli-memory-v1` object or its sampler state is outside the allowed set.
 */
export function sanitizeCliMemoryDiagnostic(value: unknown): CliMemoryDiagnosticRecord | null {
  const input = asRecord(value);
  if (!input || input.format !== CLI_MEMORY_DIAGNOSTIC_FORMAT || !Array.isArray(input.samples)) {
    return null;
  }
  const sampler = asRecord(input.sampler);
  if (!sampler || !CLI_MEMORY_DIAGNOSTIC_STATES.includes(String(sampler.state))) {
    return null;
  }

  const samples: CliMemoryDiagnosticSample[] = [];
  for (const rawSample of input.samples.slice(-CLI_MEMORY_DIAGNOSTIC_MAX_SAMPLES)) {
    const sample = asRecord(rawSample);
    if (!sample) continue;
    const rawCounters = asRecord(sample.counters);
    const counters: Record<string, number> = {};
    for (const key of CLI_MEMORY_DIAGNOSTIC_COUNTER_KEYS) {
      if (rawCounters && typeof rawCounters[key] === "number") {
        counters[key] = asNonNegativeNumber(rawCounters[key]);
      }
    }
    samples.push({
      at: asNonNegativeNumber(sample.at),
      counters,
      rss: asNonNegativeNumber(sample.rss),
      heapUsed: asNonNegativeNumber(sample.heapUsed),
      heapTotal: asNonNegativeNumber(sample.heapTotal),
      external: asNonNegativeNumber(sample.external),
      arrayBuffers: asNonNegativeNumber(sample.arrayBuffers),
      heapLimit: asNonNegativeNumber(sample.heapLimit),
    });
  }

  const allocations: CliMemoryDiagnosticAllocation[] = [];
  if (Array.isArray(input.allocations)) {
    for (const rawAllocation of input.allocations.slice(0, CLI_MEMORY_DIAGNOSTIC_MAX_ALLOCATIONS)) {
      const allocation = asRecord(rawAllocation);
      if (!allocation || !Array.isArray(allocation.stack)) continue;
      const stack: CliMemoryDiagnosticFrame[] = [];
      for (const rawFrame of allocation.stack.slice(-CLI_MEMORY_DIAGNOSTIC_MAX_STACK_FRAMES)) {
        const frame = asRecord(rawFrame);
        if (!frame) continue;
        const name =
          typeof frame.name === "string" && CLI_MEMORY_STACK_NAME_PATTERN.test(frame.name)
            ? frame.name
            : "";
        stack.push({
          name,
          line: asNonNegativeNumber(frame.line),
          column: asNonNegativeNumber(frame.column),
        });
      }
      allocations.push({ bytes: asNonNegativeNumber(allocation.bytes), stack });
    }
  }

  return {
    format: CLI_MEMORY_DIAGNOSTIC_FORMAT,
    timestamp: asNonNegativeNumber(input.timestamp),
    instanceId:
      typeof input.instanceId === "string" && CLI_MEMORY_INSTANCE_ID_PATTERN.test(input.instanceId)
        ? input.instanceId
        : "",
    pid: asNonNegativeNumber(input.pid),
    version: asToken(input.version),
    commit: asToken(input.commit),
    node: asToken(input.node),
    v8: asToken(input.v8),
    bundleSha256:
      typeof input.bundleSha256 === "string" &&
      CLI_MEMORY_BUNDLE_SHA256_PATTERN.test(input.bundleSha256)
        ? input.bundleSha256
        : "",
    sampler: {
      state: String(sampler.state),
      intervalBytes: asNonNegativeNumber(sampler.intervalBytes),
      windowStartedAt: asNonNegativeNumber(sampler.windowStartedAt),
      profileCapturedAt: asNonNegativeNumber(sampler.profileCapturedAt),
      durationMs: asNonNegativeNumber(sampler.durationMs),
    },
    samples,
    allocations,
  };
}

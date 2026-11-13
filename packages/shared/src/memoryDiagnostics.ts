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

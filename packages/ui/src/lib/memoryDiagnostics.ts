import {
  createMemoryDiagnosticsRegistry,
  createMemorySampleWriteGate,
  formatMemorySampleLine,
  MEMORY_SAMPLE_INTERVAL_MS,
  type MemoryDiagnosticsRegistry,
  type MemorySample,
  type RendererHeapSample,
} from "@zcode/shared";
import { logMemoryDiagnostics } from "@/logger.js";

/**
 * Registry of renderer memory-diagnostic counters.
 * Cache/store modules register read-only providers at module load; `startMemoryDiagnosticsLogger` samples every 60 seconds
 * and, after gating, writes to the desktop main log through `logger.logMemoryDiagnostics`.
 */
export const uiMemoryDiagnosticsRegistry: MemoryDiagnosticsRegistry =
  createMemoryDiagnosticsRegistry();

interface RendererHeapSnapshot {
  usedJSHeapSize?: number;
  totalJSHeapSize?: number;
}

/** Chromium-only `performance.memory`; returns undefined when unavailable in a Web browser. */
function readRendererHeapSnapshot(): RendererHeapSnapshot | undefined {
  if (typeof performance === "undefined") {
    return undefined;
  }
  const memory = (performance as Performance & { memory?: RendererHeapSnapshot }).memory;
  if (!memory || typeof memory.usedJSHeapSize !== "number") {
    return undefined;
  }
  return memory;
}

interface StartMemoryDiagnosticsLoggerOptions {
  intervalMs?: number;
  now?: () => number;
  readHeap?: () => RendererHeapSnapshot | undefined;
  write?: (line: string) => void;
  registry?: MemoryDiagnosticsRegistry;
  /**
   * Resource-telemetry output: in addition to writing the same sample to the local
   * diagnostic log, also send it through the preload bridge as a main-process `renderer_main` role event. Injected by App as
   * `platform.reportRendererHeapSample`; Web and mobile remote control have no bridge, so omitting it is a no-op.
   */
  reportHeapSample?: (sample: RendererHeapSample) => void;
}

interface MemoryDiagnosticsLoggerHandle {
  sampleNow(): boolean;
  stop(): void;
}

export function startMemoryDiagnosticsLogger(
  options: StartMemoryDiagnosticsLoggerOptions = {},
): MemoryDiagnosticsLoggerHandle {
  const now = options.now ?? (() => Date.now());
  const readHeap = options.readHeap ?? readRendererHeapSnapshot;
  const write = options.write ?? logMemoryDiagnostics;
  const registry = options.registry ?? uiMemoryDiagnosticsRegistry;
  const reportHeapSample = options.reportHeapSample;
  const gate = createMemorySampleWriteGate();

  const sampleNow = (): boolean => {
    try {
      const heap = readHeap();
      const heapUsedKb = heap ? Math.round(heap.usedJSHeapSize! / 1024) : undefined;
      // Send samples to resource telemetry as soon as they are read: ARMS needs the full 60-second series, while local logs are written only when values change,
      // so the two outputs cannot share a single gating result. Counter collection/formatting must not delay this heap sample either.
      if (heapUsedKb !== undefined) {
        try {
          reportHeapSample?.({ heapUsedKb });
        } catch {
          // A bridge failure drops only this telemetry sample; local diagnostic logging and rendering are unaffected.
        }
      }
      const sample: MemorySample = {
        role: "renderer",
        counters: registry.collect(),
      };
      if (heap) {
        sample.heapUsedKb = heapUsedKb;
        if (typeof heap.totalJSHeapSize === "number") {
          sample.heapTotalKb = Math.round(heap.totalJSHeapSize / 1024);
        }
      }
      const reason = gate.evaluate(sample, now());
      if (!reason) {
        return false;
      }
      write(formatMemorySampleLine(sample, reason));
      return true;
    } catch {
      // A diagnostic-sampling failure drops only the current sample and must not affect rendering.
      return false;
    }
  };

  let handle: ReturnType<typeof setInterval> | undefined = setInterval(
    sampleNow,
    options.intervalMs ?? MEMORY_SAMPLE_INTERVAL_MS,
  );

  return {
    sampleNow,
    stop() {
      if (handle === undefined) {
        return;
      }
      clearInterval(handle);
      handle = undefined;
    },
  };
}

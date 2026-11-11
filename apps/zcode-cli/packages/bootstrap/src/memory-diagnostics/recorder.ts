import {
  sanitizeCliMemoryDiagnostic,
  CLI_MEMORY_DIAGNOSTIC_MAX_ALLOCATIONS,
  CLI_MEMORY_DIAGNOSTIC_MAX_SAMPLES,
  CLI_MEMORY_DIAGNOSTIC_MAX_STACK_FRAMES,
  CLI_MEMORY_DIAGNOSTIC_FORMAT,
  type CliMemoryDiagnosticAllocation,
  type CliMemoryDiagnosticFrame,
  type CliMemoryDiagnosticRecord,
  type CliMemoryDiagnosticSample,
} from "@zcode/shared";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { normalize } from "node:path";

/** Sampling interval passed to HeapProfiler.startSampling (1 MiB). */
export const CLI_MEMORY_PROFILE_SAMPLING_INTERVAL_BYTES = 1024 * 1024;
/** Tick cadence of the recorder: one heap sample, one profile read, one file write per tick. */
export const CLI_MEMORY_RECORDER_TICK_MS = 15_000;
/** Length of one profile window; after it the profile is reset so allocations describe recent activity. */
export const CLI_MEMORY_PROFILE_WINDOW_MS = 60_000;
/** Maximum nodes visited while projecting one profile; more than this means the tree is too large to walk per tick. */
export const CLI_MEMORY_PROJECTION_MAX_NODES = 4096;
/** Wall-clock budget for a start, or for one tick (checked after the profile read and at the end). */
export const CLI_MEMORY_TICK_BUDGET_MS = 25;
/** Fraction of heapLimit at which profiling stops to avoid adding allocations near OOM. */
export const CLI_MEMORY_HEAP_LIMIT_RATIO = 0.8;

export type CliMemoryRecorderState = "active" | "unsupported" | "budget-exceeded" | "error";

export interface HeapProfileNode {
  callFrame: {
    functionName: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
  selfSize: number;
  children: HeapProfileNode[];
}

export interface CliMemoryProfilerPort {
  start(): Promise<void>;
  read(): Promise<{ head: HeapProfileNode }>;
  reset(): Promise<void>;
  dispose(): void;
}

export interface CliMemoryReading {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  heapLimit: number;
}

export interface CliMemoryMetadata {
  instanceId: string;
  pid: number;
  version: string;
  commit: string;
  node: string;
  v8: string;
  bundleSha256: string;
}

export interface CreateMemoryDiagnosticRecorderOptions {
  /** Injectable clocks for deterministic budget tests; production uses Date.now and performance.now. */
  now?: () => number;
  measure?: () => number;
  profiler: CliMemoryProfilerPort;
  readMemory(): CliMemoryReading;
  readCounters(): Record<string, number>;
  metadata(): CliMemoryMetadata;
  /** Read at projection time, so a later realpath result is used. */
  readonly bundlePath: string;
  write(record: CliMemoryDiagnosticRecord): Promise<void>;
}

export interface CliMemoryDiagnosticRecorder {
  start(): Promise<void>;
  sample(): Promise<void>;
  stop(): void;
}

/**
 * Walks a heap sampling profile and returns the largest self-size allocation sites whose frames belong to the running
 * bundle. Frames from other files are dropped, so only function names, line and column of the CLI bundle are kept.
 * Returns null when more than CLI_MEMORY_PROJECTION_MAX_NODES nodes would be visited.
 */
export function projectAllocations(
  head: HeapProfileNode,
  bundlePath: string,
): CliMemoryDiagnosticAllocation[] | null {
  const comparablePath = (value: string): string =>
    process.platform === "win32" ? normalize(value).toLowerCase() : normalize(value);
  const target = comparablePath(bundlePath);
  const pending: Array<{ node: HeapProfileNode; stack: CliMemoryDiagnosticFrame[] }> = [
    { node: head, stack: [] },
  ];
  const top: CliMemoryDiagnosticAllocation[] = [];
  let visited = 0;

  while (pending.length) {
    if (++visited > CLI_MEMORY_PROJECTION_MAX_NODES) return null;
    const { node, stack } = pending.pop()!;
    const frame = node.callFrame;
    let url = frame.url;
    if (url.startsWith("file:")) {
      try {
        url = fileURLToPath(url);
      } catch {
        url = "";
      }
    }
    const nextStack =
      comparablePath(url) === target
        ? [
            ...stack,
            { name: frame.functionName, line: frame.lineNumber, column: frame.columnNumber },
          ].slice(-CLI_MEMORY_DIAGNOSTIC_MAX_STACK_FRAMES)
        : stack;
    if (node.selfSize > 0 && nextStack.length) {
      top.push({ bytes: node.selfSize, stack: nextStack });
      top.sort((a, b) => b.bytes - a.bytes);
      if (top.length > CLI_MEMORY_DIAGNOSTIC_MAX_ALLOCATIONS) top.pop();
    }
    if (visited + pending.length + node.children.length > CLI_MEMORY_PROJECTION_MAX_NODES) {
      return null;
    }
    for (const child of node.children) pending.push({ node: child, stack: nextStack });
  }
  return top;
}

/**
 * Heap sampling recorder. Each tick takes a memory reading, reads and projects the sampling profile while it is within
 * budget, and writes one sanitized record. A budget overrun stops profiling for the rest of the process but keeps
 * writing memory-only records. The recorder is best effort: any error drops the current tick.
 */
export function createMemoryDiagnosticRecorder(
  options: CreateMemoryDiagnosticRecorderOptions,
): CliMemoryDiagnosticRecorder {
  const now = options.now ?? Date.now;
  const measure = options.measure ?? (() => performance.now());
  let stopped = false;
  let started = false;
  let ticking = false;
  let profilerDisposed = false;
  let state: CliMemoryRecorderState = "unsupported";
  let windowStartedAt = 0;
  let profileCapturedAt = 0;
  let windowStartedAtForRecord = 0;
  let allocations: CliMemoryDiagnosticAllocation[] = [];
  const samples: CliMemoryDiagnosticSample[] = [];

  const disposeProfiler = (): void => {
    if (profilerDisposed) return;
    profilerDisposed = true;
    try {
      options.profiler.dispose();
    } catch {
      // Disposing a profiler session must not affect the process that owns it.
    }
  };

  return {
    async start() {
      if (started || stopped) return;
      started = true;
      ticking = true;
      try {
        const startedAt = measure();
        await options.profiler.start();
        if (stopped) {
          disposeProfiler();
          return;
        }
        state = measure() - startedAt > CLI_MEMORY_TICK_BUDGET_MS ? "budget-exceeded" : "active";
        windowStartedAt = now();
        if (state !== "active") disposeProfiler();
      } catch {
        disposeProfiler();
      } finally {
        ticking = false;
      }
    },

    async sample() {
      if (stopped || !started) return;
      if (ticking) {
        // A tick still running after a full window means the profiler is blocking the loop; stop profiling.
        if (state === "active" && now() - windowStartedAt >= CLI_MEMORY_PROFILE_WINDOW_MS) {
          state = "budget-exceeded";
          disposeProfiler();
        }
        return;
      }
      ticking = true;
      try {
        const tickStartedAt = measure();
        const memory = options.readMemory();
        samples.push({ at: now(), ...memory, counters: options.readCounters() });
        if (samples.length > CLI_MEMORY_DIAGNOSTIC_MAX_SAMPLES) samples.shift();

        if (
          state === "active" &&
          memory.heapLimit > 0 &&
          memory.heapUsed >= memory.heapLimit * CLI_MEMORY_HEAP_LIMIT_RATIO
        ) {
          state = "budget-exceeded";
          disposeProfiler();
        }

        if (state === "active") {
          try {
            const profile = await options.profiler.read();
            if (stopped) return;
            const projected = projectAllocations(profile.head, options.bundlePath);
            if (!projected || measure() - tickStartedAt > CLI_MEMORY_TICK_BUDGET_MS) {
              state = "budget-exceeded";
              disposeProfiler();
            } else {
              allocations = projected;
              profileCapturedAt = now();
              windowStartedAtForRecord = windowStartedAt;
              if (now() - windowStartedAt >= CLI_MEMORY_PROFILE_WINDOW_MS) {
                await options.profiler.reset();
                if (stopped) return;
                windowStartedAt = now();
              }
            }
          } catch {
            state = "error";
            disposeProfiler();
          }
        }

        if (stopped) return;
        const durationMs = measure() - tickStartedAt;
        if (state === "active" && durationMs > CLI_MEMORY_TICK_BUDGET_MS) {
          state = "budget-exceeded";
          disposeProfiler();
        }

        const record = sanitizeCliMemoryDiagnostic({
          format: CLI_MEMORY_DIAGNOSTIC_FORMAT,
          timestamp: now(),
          ...options.metadata(),
          sampler: {
            state,
            intervalBytes: CLI_MEMORY_PROFILE_SAMPLING_INTERVAL_BYTES,
            windowStartedAt: windowStartedAtForRecord,
            profileCapturedAt,
            durationMs,
          },
          samples,
          allocations,
        });
        if (record) await options.write(record);
      } catch {
        // A failed tick drops only this record.
      } finally {
        ticking = false;
      }
    },

    stop() {
      stopped = true;
      disposeProfiler();
    },
  };
}

/**
 * cli-memory-diagnostics public contract (specs/upstream-backport-3.18.1.md item 7,
 * docs/monitoring/memory-diagnostics-log.md).
 *
 * - attachCliMemoryDiagnostics: starts the recorder next to a started resource sampler; returns undefined when the
 *   sampler is undefined; the returned stop stops both. A recorder start failure never affects the sampler.
 * - startCliMemoryDiagnostics: starts the 15 s recorder for this process; stop is idempotent and disposes the
 *   inspector session.
 * - createMemoryDiagnosticRecorder / projectAllocations / writeMemoryDiagnostic: pure-ish building blocks with
 *   injected profiler, clock and writer, exported for tests.
 */
export { attachCliMemoryDiagnostics, startCliMemoryDiagnostics } from "./start.js";
export type { StartCliMemoryDiagnosticsOptions } from "./start.js";
export { createMemoryDiagnosticRecorder, projectAllocations } from "./recorder.js";
export type {
  CliMemoryDiagnosticRecorder,
  CliMemoryProfilerPort,
  CreateMemoryDiagnosticRecorderOptions,
} from "./recorder.js";
export { writeMemoryDiagnostic } from "./writer.js";

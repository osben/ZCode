import type { IDisposable } from "@zcode/rpc";
import {
  createMemoryDiagnosticsRegistry,
  type MemoryDiagnosticsProvider,
  type MemoryDiagnosticsRegistry,
} from "@zcode/shared";

/**
 * Process-wide memory diagnostics registry for services.
 *
 * Each service factory registers a read-only provider on creation and unregisters it on disposeAll. The Host collects data every 60 seconds
 * and writes it to the local log. This is kept off service interfaces so diagnostic methods are not exposed through RPC channels.
 */
export const memoryDiagnosticsRegistry: MemoryDiagnosticsRegistry =
  createMemoryDiagnosticsRegistry();

export function registerMemoryDiagnosticsProvider(
  name: string,
  provider: MemoryDiagnosticsProvider,
): IDisposable {
  return memoryDiagnosticsRegistry.register(name, provider);
}

export function collectServiceMemoryDiagnostics(): Record<string, number> {
  return memoryDiagnosticsRegistry.collect();
}

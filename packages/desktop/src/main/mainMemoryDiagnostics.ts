import { createMemoryDiagnosticsRegistry, type MemoryDiagnosticsRegistry } from "@zcode/shared";

/**
 * Registry of main-process memory diagnostic counters.
 * `index.ts` registers the provider after instantiating TaskRealtimeBus / BroadcastHub / BrowserGuestManager;
 * `desktopResourceTelemetry.ts` collects every 60 seconds and writes to the main log.
 */
export const mainMemoryDiagnosticsRegistry: MemoryDiagnosticsRegistry =
  createMemoryDiagnosticsRegistry();

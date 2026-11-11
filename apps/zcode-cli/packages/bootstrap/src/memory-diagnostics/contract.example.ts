import { attachCliMemoryDiagnostics } from "./contract.js";

/** The protocol agent wraps its resource sampler once at startup and stops the result on shutdown. */
export function exampleAttachCliMemoryDiagnostics(
  sampler: { start(): void; stop(): void } | undefined,
  collectMemoryDiagnostics: (options: { includeEventStats: boolean }) => Record<string, number>,
): { start(): void; stop(): void } | undefined {
  return attachCliMemoryDiagnostics(sampler, () =>
    collectMemoryDiagnostics({ includeEventStats: false }),
  );
}

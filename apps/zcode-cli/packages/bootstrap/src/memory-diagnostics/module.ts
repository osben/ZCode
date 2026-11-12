/**
 * cli-memory-diagnostics module manifest (architecture-governance managed module).
 * Layer: adapters. When changing requires, update architecture-policy.yaml as well.
 */
export const cliMemoryDiagnosticsModule = {
  id: "cli-memory-diagnostics",
  requires: ["shared"],
  provides: ["cli-memory-diagnostics"],
  publicEntrypoints: ["contract.ts"],
} as const;

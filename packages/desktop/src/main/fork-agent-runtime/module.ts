/**
 * desktop-fork-agent-runtime module manifest (architecture-governance managed module).
 * Layer: adapters. When changing requires, update architecture-policy.yaml as well.
 */
export const desktopForkAgentRuntimeModule = {
  id: "desktop-fork-agent-runtime",
  requires: ["shared"],
  provides: ["desktop-fork-agent-runtime"],
  publicEntrypoints: ["contract.ts"],
} as const;

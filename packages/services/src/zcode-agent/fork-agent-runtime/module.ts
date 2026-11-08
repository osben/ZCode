/**
 * services-fork-agent-runtime module manifest (architecture-governance managed module).
 * Layer: adapters. When changing requires, update architecture-policy.yaml as well.
 */
export const servicesForkAgentRuntimeModule = {
  id: "services-fork-agent-runtime",
  requires: ["shared"],
  provides: ["services-fork-agent-runtime"],
  publicEntrypoints: ["contract.ts"],
} as const;

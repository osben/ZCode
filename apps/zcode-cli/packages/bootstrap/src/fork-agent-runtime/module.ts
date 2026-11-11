/**
 * cli-fork-agent-runtime module manifest (architecture-governance managed module).
 * Layer: adapters. When changing requires, update architecture-policy.yaml as well.
 */
export const cliForkAgentRuntimeModule = {
  id: "cli-fork-agent-runtime",
  requires: ["shared", "zcode-cli"],
  provides: ["cli-fork-agent-runtime"],
  publicEntrypoints: ["contract.ts"],
} as const;

/**
 * services-feedback module manifest (architecture-governance managed module).
 * Covers only the diagnostic log archive builders. Layer: adapters. When changing requires, update
 * architecture-policy.yaml as well.
 */
export const servicesFeedbackModule = {
  id: "services-feedback",
  requires: ["rpc", "services", "shared"],
  provides: ["services-feedback"],
  publicEntrypoints: ["contract.ts"],
} as const;

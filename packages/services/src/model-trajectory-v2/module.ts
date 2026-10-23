/**
 * model-trajectory-v2-projection module manifest (architecture-governance managed module).
 * Layers: domain < app < adapters. Keep `requires` in sync with architecture-policy.yaml.
 */
export const modelTrajectoryV2ProjectionModule = {
  id: "model-trajectory-v2-projection",
  requires: ["services"],
  provides: ["model-trajectory-v2-projection"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;

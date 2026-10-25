/**
 * model-trajectory-v2 UI module manifest (architecture-governance managed module).
 * Layers: domain < app < ui (components). Keep `requires` in sync with architecture-policy.yaml.
 */
export const modelTrajectoryV2Module = {
  id: "model-trajectory-v2",
  requires: ["services", "shared", "ui", "mobile-ui"],
  provides: ["model-trajectory-v2"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;

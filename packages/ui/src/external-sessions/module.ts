/**
 * external-sessions-ui module manifest (architecture-governance managed module).
 * Layers: contract (contract.ts, the only file that imports @zcode/services) and ui.
 * Keep `requires` in sync with architecture-policy.yaml. Spec: specs/external-sessions.md.
 */
export const externalSessionsUiModule = {
  id: "external-sessions-ui",
  requires: ["services", "shared", "ui"],
  provides: ["external-sessions-ui"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;

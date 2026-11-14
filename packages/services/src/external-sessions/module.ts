/**
 * external-sessions module manifest (architecture-governance managed module).
 * Layer: adapters. Keep `requires` in sync with architecture-policy.yaml (the checker compares both).
 * Spec: specs/external-sessions.md.
 */
export const externalSessionsModule = {
  id: "external-sessions",
  requires: ["services", "shared", "session", "acp-launch-rules"],
  provides: ["external-sessions"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;

/**
 * Storage module manifest: disk usage scan and cleanup for the settings page's “Storage Management”.
 * Keep dependency declarations aligned with architecture-policy.yaml; expose only contract.ts externally.
 */
export const storageModule = {
  id: "storage",
  requires: ["shared", "rpc", "services"],
  provides: ["storage-service"],
  publicEntrypoints: ["contract.ts"],
} as const;

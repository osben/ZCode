/**
 * desktop-storage-sweep-gate module manifest (architecture-governance managed module).
 * Layer: adapters. When changing requires, update architecture-policy.yaml as well (the checker verifies both match).
 */
export const desktopStorageSweepGateModule = {
  id: "desktop-storage-sweep-gate",
  requires: [],
  provides: ["desktop-storage-sweep-gate"],
  publicEntrypoints: ["contract.ts"],
} as const;

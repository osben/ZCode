// Dependencies stay in sync with architecture-policy.yaml; new files must belong to this managed boundary.
export const desktopWebRemoteRelayModule = {
  id: "desktop-web-remote-relay",
  requires: ["client", "desktop", "shared", "remote-relay-protocol"],
  provides: ["desktop-web-remote-relay"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;

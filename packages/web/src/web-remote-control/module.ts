// Dependencies must stay in sync with architecture-policy.yaml; new files must belong to this managed boundary.
export const webRemoteControlModule = {
  id: "web-remote-control",
  requires: ["client", "mobile-ui", "remote-relay-protocol", "shared", "ui", "web"],
  provides: ["web-remote-control"],
  publicEntrypoints: [
    "index.ts",
    "contract.ts",
    "views.ts",
    "adapters/webRemoteControlThemeSeed.ts",
  ],
} as const;

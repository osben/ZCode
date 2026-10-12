export const remoteRelayModule = {
  id: "remote-relay",
  requires: ["remote-relay-protocol"],
  provides: ["remote-relay"],
  publicEntrypoints: ["contract.ts", "adapters/nodeServer.ts"],
} as const;

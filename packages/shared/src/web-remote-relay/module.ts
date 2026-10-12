export const remoteRelayProtocolModule = {
  id: "remote-relay-protocol",
  requires: [],
  provides: ["remote-relay-protocol"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;

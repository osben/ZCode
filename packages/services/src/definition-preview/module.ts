export const definitionPreviewServiceModule = {
  id: "definition-preview-service",
  requires: ["services", "shared", "rpc", "definition-preview-protocol"],
  provides: ["definition-preview-service"],
  publicEntrypoints: ["index.ts", "contract.ts", "node.ts"],
} as const;

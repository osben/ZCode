/**
 * cli-fork-rust-helper module manifest (architecture-governance managed module).
 * Layer: adapters. When changing requires, update architecture-policy.yaml as well.
 */
export const cliForkRustHelperModule = {
  id: "cli-fork-rust-helper",
  requires: ["shared", "zcode-cli", "plugin-host-queries", "mcp-ui"],
  provides: ["cli-fork-rust-helper"],
  publicEntrypoints: ["contract.ts"],
} as const;

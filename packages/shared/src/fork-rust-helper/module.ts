export const forkRustHelperSharedModule = {
  id: "fork-rust-helper-shared",
  requires: [],
  provides: ["fork-rust-helper-shared"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;

export const acpLaunchRulesModule = {
  id: "acp-launch-rules",
  requires: [],
  provides: ["acp-launch-rules"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;

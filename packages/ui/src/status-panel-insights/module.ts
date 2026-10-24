/**
 * status-panel-insights module manifest (architecture-governance managed module).
 * Layer: ui. Keep requires in sync with architecture-policy.yaml (the checker verifies both).
 */
export const statusPanelInsightsModule = {
  id: "status-panel-insights",
  requires: ["shared", "ui", "review-last-turn"],
  provides: ["status-panel-insights"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;

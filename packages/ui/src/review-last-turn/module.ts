/**
 * review-last-turn module manifest (architecture-governance managed module).
 * Layer: ui. Keep requires in sync with architecture-policy.yaml (the checker verifies both).
 */
export const reviewLastTurnModule = {
  id: "review-last-turn",
  requires: ["shared", "ui"],
  provides: ["review-last-turn"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;

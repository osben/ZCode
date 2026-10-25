import { SIWC_PLAN_USAGE_SCOPE } from "./siwc-constants.js";

/** Split a space-delimited OAuth scope string into a normalized list. */
export function parseSiwcScopes(value: string | null | undefined): readonly string[] {
  if (!value) return [];
  return value
    .split(/\s+/u)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

/**
 * Consent gating: without chatgpt.tokens.use.direct the signed-in identity is kept but
 * plan-backed inference must not be attempted (SIWC docs: token sharing, consent).
 */
export function isSiwcPlanUsageEntitled(scopes: readonly string[]): boolean {
  return scopes.includes(SIWC_PLAN_USAGE_SCOPE);
}

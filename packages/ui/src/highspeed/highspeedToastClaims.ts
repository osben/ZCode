const fallbackToastClaimsByCommandId = new Set<string>();

/**
 * Fallback events may be observed multiple times due to snapshot replay or SessionPane remounts;
 * a module-level claim guarantees the toast is shown only once.
 */
export function claimHighspeedFallbackToast(sourceCommandId: string): boolean {
  if (fallbackToastClaimsByCommandId.has(sourceCommandId)) return false;
  fallbackToastClaimsByCommandId.add(sourceCommandId);
  return true;
}

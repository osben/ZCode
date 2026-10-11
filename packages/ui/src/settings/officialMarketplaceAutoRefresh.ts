// Throttling criteria for “Catalog Auto-Refresh” on the marketplace page.
//
// Requirement: refresh the official ZCode marketplace by default on every page entry so newly published CDN plugins appear without a manual refresh;
// apply throttling (skip if the last successful refresh is within the window) and debounce (do not trigger again after failure while the request is still in flight).
//
// Criteria = now - max(lastUpdated, lastAttemptAt) >= window.
// - lastUpdated comes from the agent's persisted known_marketplaces.json; every successful refresh (manual or from the session-recommended plugin
//   path) rewrites it, so it is naturally shared across windows and restarts, and manual refresh resets the automatic window too.
// - lastAttemptAt is the in-memory “start time” in this module. The UI's PluginMarketplaceSummary has no failure timestamp;
//   relying only on lastUpdated would make offline users retry a long-timeout request every time they enter. Record the attempt immediately when starting,
//   preventing both “just failed” and “previous request still in flight” repeats. Resetting it on process restart is acceptable (a restart allows another attempt).
// - The marketplace page remounts on every entry (key includes pluginStoreOpenVersion), so a component ref cannot hold throttle state;
//   keep it at module scope.

export const OFFICIAL_MARKETPLACE_AUTO_REFRESH_INTERVAL_MS = 10 * 60_000;

const lastAttemptAtByMarketplace = new Map<string, number>();

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function shouldAutoRefreshMarketplace(params: {
  lastUpdated?: string;
  lastAttemptAt?: number;
  now: number;
}): boolean {
  const lastUpdatedAt = parseTimestamp(params.lastUpdated);
  const lastKnownAt = Math.max(lastUpdatedAt ?? -Infinity, params.lastAttemptAt ?? -Infinity);
  return params.now - lastKnownAt >= OFFICIAL_MARKETPLACE_AUTO_REFRESH_INTERVAL_MS;
}

/**
 * Determine whether to refresh automatically; if yes, claim the slot immediately (record this attempt time) and return true.
 * Determine and claim in one step to avoid duplicate requests if the effect reruns during the same mount or the user enters/exits the marketplace quickly.
 */
export function claimMarketplaceAutoRefresh(
  marketplaceId: string,
  lastUpdated: string | undefined,
  now: number = Date.now(),
): boolean {
  const shouldRefresh = shouldAutoRefreshMarketplace({
    lastUpdated,
    lastAttemptAt: lastAttemptAtByMarketplace.get(marketplaceId),
    now,
  });
  if (shouldRefresh) {
    lastAttemptAtByMarketplace.set(marketplaceId, now);
  }
  return shouldRefresh;
}

export function resetMarketplaceAutoRefreshForTests(): void {
  lastAttemptAtByMarketplace.clear();
}

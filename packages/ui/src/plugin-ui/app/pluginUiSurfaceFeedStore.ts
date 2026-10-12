import {
  EMPTY_PLUGIN_UI_SURFACE_FEED,
  mergePluginUiSurfaceFeed,
  type PluginUiSurfaceFeed,
} from "../domain/pluginUiToolFeed.js";

/**
 * Owner of surface feed snapshots (renderer memory, not persisted). Key is
 * `buildPluginUiSurfaceKey(target, surfaceScope)`, isolated the same way as pluginUiSurfaceStore /
 * pluginUiWidgetStateStore. The surface model merges a snapshot reduced from the projection window into
 * here, so reopening the pane or the projection window trimming old rows still yields the "last
 * successful result". Merges monotonically by rowId only; regressions are not accepted.
 */
const feeds = new Map<string, PluginUiSurfaceFeed>();
const listeners = new Set<() => void>();

export function getPluginUiSurfaceFeed(key: string): PluginUiSurfaceFeed {
  return feeds.get(key) ?? EMPTY_PLUGIN_UI_SURFACE_FEED;
}

/** Merges and returns the stored snapshot; when nothing changed, returns the original reference without notifying. */
export function offerPluginUiSurfaceFeed(
  key: string,
  candidate: PluginUiSurfaceFeed,
): PluginUiSurfaceFeed {
  const current = getPluginUiSurfaceFeed(key);
  const next = mergePluginUiSurfaceFeed(current, candidate);
  if (next === current) return current;
  feeds.set(key, next);
  for (const listener of listeners) listener();
  return next;
}

export function subscribePluginUiSurfaceFeeds(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For tests: clear all records. */
export function resetPluginUiSurfaceFeedsForTest(): void {
  feeds.clear();
  listeners.clear();
}

export function clearPluginUiSurfaceFeed(key: string): void {
  feeds.delete(key);
}

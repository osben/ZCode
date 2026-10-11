// Virtual scrolling core: v4 timeline row-height cache (pure data structure, no DOM/React dependency).
//
// Why it is needed: @tanstack/react-virtual's own measurementsCache is keyed by itemKey,
// preserving measurements when rows unmount/remount within the window. But when streaming rows keep growing, virtualizer resets
// (rows array rebuild, component StrictMode remount, error ↔ timeline transition) clear the cache back to the fixed estimateSize,
// causing scroll jumps and bottom-anchor jitter. Add a persistent cache within the component instance, keyed by the render unit's stable
// key (turnId), so measurements survive row unmount/remount.
//

/** Fallback estimated height for unmeasured rows (matches the old ConversationTimeline ROW_ESTIMATE_PX). */
export const DEFAULT_ROW_HEIGHT_ESTIMATE_PX = 72;

/** Cache limit to prevent memory growth in long conversations; evict the least recently written row (write order ≈ row order, so old rows go first). */
export const MAX_ROW_HEIGHT_CACHE_ENTRIES = 4000;

export type TimelineRowHeightCacheKey = string | number;

export class TimelineRowHeightCache {
  private readonly sizes = new Map<TimelineRowHeightCacheKey, number>();

  constructor(private readonly maxEntries: number = MAX_ROW_HEIGHT_CACHE_ENTRIES) {}

  get size(): number {
    return this.sizes.size;
  }

  /** Record a real measurement. Repeated writes refresh eviction order so active rows are not removed. */
  set(key: TimelineRowHeightCacheKey, heightPx: number): void {
    if (!Number.isFinite(heightPx) || heightPx <= 0) {
      return;
    }
    // Map iteration order is insertion order; delete then reinsert to move this row to the newest end.
    this.sizes.delete(key);
    this.sizes.set(key, heightPx);
    while (this.sizes.size > this.maxEntries) {
      const oldest = this.sizes.keys().next();
      if (oldest.done) break;
      this.sizes.delete(oldest.value);
    }
  }

  get(key: TimelineRowHeightCacheKey): number | undefined {
    return this.sizes.get(key);
  }

  /** estimateSize entry point: use the measurement when available, otherwise fall back to the estimate. */
  estimate(
    key: TimelineRowHeightCacheKey | undefined,
    fallbackPx: number = DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
  ): number {
    if (key === undefined) return fallbackPx;
    return this.sizes.get(key) ?? fallbackPx;
  }

  /** Reset everything when switching sessions (turnId is not guaranteed globally unique across sessions). */
  clear(): void {
    this.sizes.clear();
  }
}

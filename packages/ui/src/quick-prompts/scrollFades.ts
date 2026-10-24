export interface QuickPromptScrollMetrics {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
}

export interface QuickPromptScrollFades {
  left: boolean;
  right: boolean;
}

// Sub-pixel scroll positions on fractional-DPR displays must not flicker a fade on.
const SCROLL_EDGE_TOLERANCE_PX = 1;

/** A fade is only a scroll hint on a side that actually has hidden content. */
export function computeQuickPromptScrollFades(
  metrics: QuickPromptScrollMetrics,
): QuickPromptScrollFades {
  const hiddenRight = metrics.scrollWidth - metrics.clientWidth - metrics.scrollLeft;
  return {
    left: metrics.scrollLeft > SCROLL_EDGE_TOLERANCE_PX,
    right: hiddenRight > SCROLL_EDGE_TOLERANCE_PX,
  };
}

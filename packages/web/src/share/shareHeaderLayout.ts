interface ShareHeaderMeasurements {
  /** Width of the share header shell. */
  shellWidth: number;
  /** Distance from each content-rail edge to the shell edge. */
  railContentLeft: number;
  railContentRight: number;
  brandWidth: number;
  titleContentWidth: number;
  /** Combined width of the theme button and full Continue CTA. */
  continueWidth: number;
  /** Combined width of the theme button and compact Continue CTA. */
  compactContinueWidth?: number;
  /** Whether the right-side area contains the Continue CTA; read-only shares still keep the theme button. */
  hasContinueAction?: boolean;
  gap?: number;
  /** Padding from the viewport edge at the wide-screen anchor. */
  edgePadding?: number;
  /** Minimum safe gap to preserve before elements on either side enter the continuous movement animation. */
  minClearance?: number;
  /** Minimum width the full CTA must leave for the visible title. */
  minTitleWidth?: number;
}

export interface ShareHeaderView {
  /** 0 is the inline position within the content rail; 1 is the position anchored to both viewport edges. */
  progress: number;
  brandLeft: number;
  titleLeft: number;
  titleWidth: number;
  continueRight: number;
  titleTruncated: boolean;
  continueVisible: boolean;
  continueCompact: boolean;
}

const DEFAULT_GAP = 16;
const DEFAULT_EDGE_PADDING = 24;
const DEFAULT_MIN_CLEARANCE = 16;
const DEFAULT_MIN_TITLE_WIDTH = 80;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lerp(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

/**
 * Calculate continuous geometric positions for the share header.
 *
 * Previously this returned two discrete layouts, inline/rail-aligned, and the brand and CTA jumped from
 * the flex flow to absolute positioning at the breakpoint. Now derive progress from the available gutter
 * between the content rail and viewport edge so all three elements move continuously along the same track.
 * Keep the wide-screen outer anchors while the gutter can still fit each element; move back toward the
 * content rail only after the gutter becomes too small.
 */
export function resolveShareHeaderView({
  shellWidth,
  railContentLeft,
  railContentRight,
  brandWidth,
  titleContentWidth,
  continueWidth,
  compactContinueWidth = continueWidth,
  hasContinueAction = continueWidth > 0,
  gap = DEFAULT_GAP,
  edgePadding = DEFAULT_EDGE_PADDING,
  minClearance = DEFAULT_MIN_CLEARANCE,
  minTitleWidth = DEFAULT_MIN_TITLE_WIDTH,
}: ShareHeaderMeasurements): ShareHeaderView {
  const normalizedShellWidth = Math.max(0, shellWidth);
  const normalizedRailLeft = Math.max(0, railContentLeft);
  const normalizedRailRight = Math.max(0, railContentRight);
  const normalizedBrandWidth = Math.max(0, brandWidth);
  const normalizedTitleContentWidth = Math.max(0, titleContentWidth);
  const normalizedContinueWidth = Math.max(0, continueWidth);
  const normalizedCompactContinueWidth = Math.min(
    normalizedContinueWidth,
    Math.max(0, compactContinueWidth),
  );
  const normalizedGap = Math.max(0, gap);
  const normalizedEdgePadding = Math.max(0, edgePadding);
  const normalizedMinClearance = Math.max(0, minClearance);
  const normalizedMinTitleWidth = Math.max(0, minTitleWidth);
  const brandRequiredGutter = normalizedBrandWidth + normalizedEdgePadding + normalizedMinClearance;
  const brandProgress = clamp(normalizedRailLeft / brandRequiredGutter, 0, 1);
  const narrowBrandLeft = normalizedRailLeft;
  const narrowTitleLeft = normalizedRailLeft + normalizedBrandWidth + normalizedGap;
  const wideBrandLeft = normalizedEdgePadding;
  const wideTitleLeft = normalizedRailLeft;
  const wideTitleRight = normalizedShellWidth - normalizedRailRight;
  const wideContinueRight = normalizedEdgePadding;
  const brandLeft = lerp(narrowBrandLeft, wideBrandLeft, brandProgress);
  const titleLeft = Math.max(
    brandLeft + normalizedBrandWidth + normalizedGap,
    lerp(narrowTitleLeft, wideTitleLeft, brandProgress),
  );

  const resolveTrailingGeometry = (trailingWidth: number) => {
    const continueRequiredGutter = trailingWidth + normalizedEdgePadding + normalizedMinClearance;
    const continueProgress =
      trailingWidth === 0 ? 1 : clamp(normalizedRailRight / continueRequiredGutter, 0, 1);
    const continueRight = lerp(normalizedRailRight, wideContinueRight, continueProgress);
    const narrowTitleRight =
      normalizedShellWidth - normalizedRailRight - trailingWidth - normalizedGap;
    const titleRight = Math.min(
      lerp(narrowTitleRight, wideTitleRight, continueProgress),
      normalizedShellWidth - continueRight - trailingWidth - normalizedGap,
    );
    return {
      continueProgress,
      continueRight,
      titleWidth: Math.max(0, titleRight - titleLeft),
    };
  };

  const fullGeometry = resolveTrailingGeometry(normalizedContinueWidth);
  // Permanently reserving space for the full CTA on very narrow screens reduces the title width to zero.
  // Keep the continuous track, switching to a compact icon button in the same position only when the full CTA cannot leave the minimum title width.
  const continueCompact =
    hasContinueAction &&
    normalizedCompactContinueWidth < normalizedContinueWidth &&
    fullGeometry.titleWidth < normalizedMinTitleWidth;
  const geometry = continueCompact
    ? resolveTrailingGeometry(normalizedCompactContinueWidth)
    : fullGeometry;

  return {
    progress: Math.min(brandProgress, geometry.continueProgress),
    brandLeft,
    titleLeft,
    titleWidth: geometry.titleWidth,
    continueRight: geometry.continueRight,
    titleTruncated: normalizedTitleContentWidth > geometry.titleWidth,
    continueVisible: hasContinueAction,
    continueCompact,
  };
}

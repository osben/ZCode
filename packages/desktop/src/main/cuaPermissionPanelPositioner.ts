/**
 * Geometry calculations for the permission-drag panel.
 *
 * Intentionally keep this as a pure function without an Electron dependency. Snapping needs the
 * external System Settings window bounds, which may be unavailable (the CLI that provides them may
 * be missing from the package or killed, or Settings may not be open). Separating geometry from data
 * acquisition makes fail-open behavior exhaustively testable: snapping is a visual enhancement, not
 * a usability requirement, so missing bounds must fall back to a known usable position.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PanelSize {
  width: number;
  height: number;
}

interface ResolvePanelBoundsInput {
  /** System Settings main-window screen coordinates; null means unavailable (fail open at the bottom of the screen). */
  settings: Rect | null;
  /** Available work area of the target display (excluding the menu bar/Dock). */
  display: Rect;
  panel: PanelSize;
}

/** Slight overlap with the bottom edge of Settings when snapped, making the panel appear connected to it. */
const ANCHOR_OVERLAP_PX = 6;
/** Bottom margin when failing open. */
const SCREEN_BOTTOM_INSET_PX = 28;

function clamp(value: number, min: number, max: number): number {
  // When max < min (the panel is larger than the visible area), prioritize keeping it within the top/left boundaries.
  return Math.max(min, Math.min(value, max));
}

function isUsableRect(rect: Rect | null): rect is Rect {
  // CGWindowList occasionally returns a transient window with zero size; snapping to it would put the panel in a screen corner, so treat it as unavailable.
  return rect !== null && rect.width > 0 && rect.height > 0;
}

export function resolvePanelBounds(input: ResolvePanelBoundsInput): Rect {
  const { settings, display, panel } = input;

  const anchored = isUsableRect(settings);
  const rawX = anchored
    ? settings.x + (settings.width - panel.width) / 2
    : display.x + (display.width - panel.width) / 2;
  const rawY = anchored
    ? settings.y + settings.height - ANCHOR_OVERLAP_PX
    : display.y + display.height - panel.height - SCREEN_BOTTOM_INSET_PX;

  return {
    x: Math.round(clamp(rawX, display.x, display.x + display.width - panel.width)),
    y: Math.round(clamp(rawY, display.y, display.y + display.height - panel.height)),
    width: Math.round(panel.width),
    height: Math.round(panel.height),
  };
}

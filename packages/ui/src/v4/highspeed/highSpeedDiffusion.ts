export const HIGHSPEED_DIFFUSION_DURATION_MS = 1_400;
const HIGHSPEED_DIFFUSION_FINISH_START_PROGRESS = 0.84;
export const HIGHSPEED_MODEL_SWITCH_START_PROGRESS = 0.8;

interface HighSpeedDiffusionDistanceInput {
  height: number;
  width: number;
  x: number;
  y: number;
}

const clampUnit = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * Parses sRGB colors from hex (3/4/6/8 digits) or `rgb()`/`rgba()` serialization, ignoring
 * alpha; other color functions return null so components of `oklch()` etc. are not mistaken
 * for RGB channels.
 */
export function parseHighSpeedCanvasColor(value: string): readonly [number, number, number] | null {
  const normalized = value.trim().toLowerCase();
  const hex = normalized.match(/^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/)?.[1];
  if (hex) {
    const digits = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join("") : hex;
    const channel = (offset: number) => Number.parseInt(digits.slice(offset, offset + 2), 16);
    return [channel(0), channel(2), channel(4)];
  }

  const rgb = normalized.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

/**
 * Normalizes a CSS color token through the canvas and parses it to RGB; returns the fallback
 * when the token is missing or the canvas cannot parse it.
 *
 * Root cause: production builds compress colors via Lightning CSS (e.g. `#ffffff` → `#fff`,
 * possibly rewritten to a color name); the old hand-written parser only accepted 6-digit hex,
 * fell back to the dark fallback on failure, and the light theme's diffusion mosaic rendered
 * dark as a result.
 *
 * Regression constraint: the canvas silently ignores unparseable values (e.g. `var()`, which
 * CSS.supports would accept) and keeps the old fillStyle, so a single assignment plus
 * read-back is not a valid check. Here two different sentinel colors are each assigned as the
 * base first, and the assignment only counts as accepted when both read-backs match;
 * otherwise the default black or the previous token's color would be mistaken for the result.
 */
export function resolveHighSpeedCanvasColor(
  context: Pick<CanvasRenderingContext2D, "fillStyle">,
  value: string,
  fallback: readonly [number, number, number],
): readonly [number, number, number] {
  const specified = value.trim();
  if (!specified) return fallback;

  context.fillStyle = "#000000";
  context.fillStyle = specified;
  const overBlack = context.fillStyle;
  context.fillStyle = "#ffffff";
  context.fillStyle = specified;
  const overWhite = context.fillStyle;
  if (typeof overBlack !== "string" || overBlack !== overWhite) return fallback;
  return parseHighSpeedCanvasColor(overBlack) ?? fallback;
}

export function resolveHighSpeedDiffusionProgress(elapsedMs: number): number {
  return clampUnit(elapsedMs / HIGHSPEED_DIFFUSION_DURATION_MS);
}

export function shouldCompleteHighSpeedDiffusion(progress: number): boolean {
  return progress >= HIGHSPEED_DIFFUSION_FINISH_START_PROGRESS;
}

export function shouldStartHighSpeedModelSwitch(progress: number): boolean {
  return progress >= HIGHSPEED_MODEL_SWITCH_START_PROGRESS;
}

export function resolveHighSpeedDiffusionDistance({
  height,
  width,
  x,
  y,
}: HighSpeedDiffusionDistanceInput): number {
  const radiusX = Math.max(width / 2, 1);
  const radiusY = Math.max(height / 2, 1);
  const dx = Math.abs((x - width / 2) / radiusX);
  const dy = Math.abs((y - height / 2) / radiusY);

  // The quartic superellipse keeps the elongated composer's four-way advance closer to the
  // reference's thick pixel wave instead of a sharp circular ring.
  return Math.pow(dx ** 4 + dy ** 4, 0.25);
}

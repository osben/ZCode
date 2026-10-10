const PLAYWRIGHT_DEFAULT_TIMEOUT_MS = 3_000;

/**
 * The built-in browser uses a short failure budget for ordinary Playwright operations: 3s by default, with a cap supplied by the call site.
 * The old IAB used 30s directly, causing lengthy, unproductive polling after an incorrect locator; a shared normalizer prevents adapters from drifting again.
 */
export function normalizePlaywrightTimeout(
  timeoutMs: number | undefined,
  max = PLAYWRIGHT_DEFAULT_TIMEOUT_MS,
): number {
  const requested = typeof timeoutMs === "number" ? timeoutMs : PLAYWRIGHT_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(0, requested), max || PLAYWRIGHT_DEFAULT_TIMEOUT_MS);
}

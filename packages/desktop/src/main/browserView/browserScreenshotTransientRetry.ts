/** CopyFromSurface throws UnknownVizError in Chromium before the Viz surface is created; the same
 * request succeeds as soon as the surface exists. Other failures (destroyed guest, cross-window, etc.) are fatal. */
export function isTransientScreenshotCaptureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UnknownVizError");
}

interface ScreenshotTransientRetryContext {
  target: "owner" | "guest";
  windowId: number;
  webContentsId: number;
}

const TRANSIENT_CAPTURE_RETRY_DELAY_MS = 100;
// Keep this budget below the 3-second surface-prepare timeout
// (BROWSER_SCREENSHOT_SURFACE_PREPARE_TIMEOUT_MS) to leave time for the renderer handshake.
const TRANSIENT_CAPTURE_RETRY_BUDGET_MS = 2_000;

/**
 * Transient retry budget for probes during prepare: UnknownVizError is transient, so the caller
 * retries serially with backoff. Give up when consecutive failures exceed the budget (return to
 * fast-fail invalidate semantics); reset the count after any success.
 */
export class DesktopBrowserScreenshotTransientRetry {
  private startedAt: number | undefined;
  private attempts = 0;

  constructor(
    private readonly options: {
      delayMs?: number;
      budgetMs?: number;
      log?(message: string): void;
    } = {},
  ) {}

  retryDelayMs(): number {
    return this.options.delayMs ?? TRANSIENT_CAPTURE_RETRY_DELAY_MS;
  }

  /** Record a transient failure; false means the budget is exhausted and no retry should occur. */
  schedule(context: ScreenshotTransientRetryContext): boolean {
    this.startedAt ??= Date.now();
    this.attempts += 1;
    if (
      Date.now() - this.startedAt >=
      (this.options.budgetMs ?? TRANSIENT_CAPTURE_RETRY_BUDGET_MS)
    ) {
      this.options.log?.(
        `[browser-screenshot-activity] transient capture retry budget exhausted target=${context.target} windowId=${context.windowId} webContentsId=${context.webContentsId} attempts=${this.attempts}`,
      );
      return false;
    }
    this.options.log?.(
      `[browser-screenshot-activity] transient capture retry scheduled target=${context.target} windowId=${context.windowId} webContentsId=${context.webContentsId} attempt=${this.attempts} delayMs=${this.retryDelayMs()}`,
    );
    return true;
  }

  reset(): void {
    this.startedAt = undefined;
    this.attempts = 0;
  }
}

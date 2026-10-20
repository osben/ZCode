import { useEffect } from "react";
import {
  BROWSER_SCREENSHOT_SURFACE_PREPARE_TIMEOUT_MS,
  type BrowserViewportSize,
  type BrowserViewScreenshotSurfacePreparePayload,
} from "@zcode/shared";
import { safeWebviewCall } from "@/embeddedBrowserHelpers.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";

function roundViewport(width: number, height: number): BrowserViewportSize | null {
  const viewport = { width: Math.round(width), height: Math.round(height) };
  return viewport.width > 0 && viewport.height > 0 ? viewport : null;
}

function withinOnePixel(left: BrowserViewportSize, right: BrowserViewportSize): boolean {
  return Math.abs(left.width - right.width) <= 1 && Math.abs(left.height - right.height) <= 1;
}

const SURFACE_SCALE_EPSILON = 0.001;

// Previously, ready was reported only in the
// requestAnimationFrame callback, but Chromium freezes renderer rAF when the ZCode main window is obscured or minimized
// so ready is never sent and the main-process handshake always times out after 1500ms. User logs showed
// all failures at 1501/1502ms and all successes at 146–736ms; after app-activate it succeeded immediately in 461ms,
// confirming that “window is not in the foreground → rAF is not scheduled,” rather than the screenshot itself being slow.
//
//   Foreground: prepare ──► rAF (frame 1) ──► rAF (frame 2) ──► ready ──► capture      ✅ ~150ms
//   Background: prepare ──► rAF frozen ───────────────► (no ready) ──► 1500ms timeout ❌
//
// Therefore, race a timer against rAF to schedule the same check: when the window is obscured, the timer is the only clock still running.
const SURFACE_VERIFY_FALLBACK_MS = 100;
// Previously, the function returned immediately if the viewport was not aligned, and only ResizeObserver and dom-ready could restart it;
// if the size did not change after setViewportSize/reload, there was no second chance to validate and it still waited 1500ms in vain.
// Use controlled retries; main includes the actual current timeout in the prepare payload, and the renderer keeps an additional
// grace period for Release message cleanup. Main normally releases first; the grace period only prevents the loop from running forever if Release is lost.
const SURFACE_VERIFY_RELEASE_GRACE_MS = 1_000;

function resolveSurfacePrepareTimeoutMs(timeoutMs: number | undefined): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : BROWSER_SCREENSHOT_SURFACE_PREPARE_TIMEOUT_MS;
}

interface StableScreenshotSurface {
  surfaceScale: number;
  viewport: BrowserViewportSize;
}

function readBrowserLayoutScale(webview: ElectronWebviewTag): number {
  const layoutScale = Number(webview.dataset.browserLayoutScale);
  return Number.isFinite(layoutScale) && layoutScale > 0 ? layoutScale : 1;
}

function readSurfaceScale(webview: ElectronWebviewTag): number {
  const responsiveViewport = webview.closest<HTMLElement>("[data-responsive-scale]");
  const surfaceScale = Number(responsiveViewport?.dataset.responsiveScale);
  return Number.isFinite(surfaceScale) && surfaceScale > 0 ? surfaceScale : 1;
}

function sameSurface(left: StableScreenshotSurface, right: StableScreenshotSurface): boolean {
  return (
    withinOnePixel(left.viewport, right.viewport) &&
    Math.abs(left.surfaceScale - right.surfaceScale) <= SURFACE_SCALE_EPSILON
  );
}

function readSurfaceViewport(
  webview: ElectronWebviewTag,
  expected: BrowserViewportSize,
): BrowserViewportSize | null {
  const rect = webview.getBoundingClientRect();
  const transformed = roundViewport(rect.width, rect.height);
  const layoutScale = readBrowserLayoutScale(webview);
  // Negative Desktop zoom first expands the webview layout by 1 / zoom, then scales it back into the visible frame;
  // raw offset is the host’s compensated size and must be restored by the same layout scale to represent the logical screenshot viewport.
  const layout = roundViewport(
    webview.offsetWidth / layoutScale,
    webview.offsetHeight / layoutScale,
  );
  if (transformed && withinOnePixel(transformed, expected)) return transformed;
  if (layout && withinOnePixel(layout, expected)) return layout;
  return transformed ?? layout;
}

/** Wait for two stable frames in the background compositing layer to confirm that both the guest id and natural viewport are still valid. */
export function useBrowserScreenshotSurfaceReady({
  request,
  webview,
}: {
  request: BrowserViewScreenshotSurfacePreparePayload | null;
  webview: ElectronWebviewTag | null;
}): void {
  const platform = usePlatform();

  useEffect(() => {
    logger.debug("[browser-use] 截图 surface ready effect", {
      requestId: request?.requestId,
      tabId: request?.tabId,
      hasWebview: Boolean(webview),
      hasResizeObserver: typeof ResizeObserver !== "undefined",
    });
    if (!request || !webview || typeof ResizeObserver === "undefined") {
      logger.debug("[browser-use] 截图 surface ready 暂不启动", {
        requestId: request?.requestId,
        tabId: request?.tabId,
        hasWebview: Boolean(webview),
        hasResizeObserver: typeof ResizeObserver !== "undefined",
      });
      return;
    }

    // TypeScript does not carry the non-null narrowing from an early return into the hoisted function declaration below
    // (they could theoretically be called before the guard), so capture a narrowed reference here for the entire validation chain.
    const activeRequest = request;
    const activeWebview = webview;

    let disposed = false;
    let reported = false;
    let firstFrame: StableScreenshotSurface | null = null;
    let rafId: number | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let mismatchLogged = false;
    let verificationVersion = 0;
    const prepareTimeoutMs = resolveSurfacePrepareTimeoutMs(activeRequest.timeoutMs);
    const verifyDeadlineMs = prepareTimeoutMs + SURFACE_VERIFY_RELEASE_GRACE_MS;
    const deadline = Date.now() + verifyDeadlineMs;
    const cancelPendingVerification = () => {
      verificationVersion += 1;
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (fallbackTimer !== null) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
    };
    // Race rAF and the timer: whichever fires first runs the single check and immediately cancels the other, preserving the semantics of one validation.
    function verify(): void {
      if (disposed || reported) return;
      cancelPendingVerification();
      const version = verificationVersion;
      const run = () => {
        if (disposed || reported || version !== verificationVersion) return;
        cancelPendingVerification();
        runVerification();
      };
      rafId = window.requestAnimationFrame(run);
      fallbackTimer = setTimeout(run, SURFACE_VERIFY_FALLBACK_MS);
    }
    function retry(): void {
      if (Date.now() >= deadline) {
        logger.warn("[browser-use] 截图 surface 等待超时，停止重试", {
          requestId: activeRequest.requestId,
          tabId: activeRequest.tabId,
          expectedViewport: activeRequest.viewport,
          prepareTimeoutMs,
          verifyDeadlineMs,
        });
        return;
      }
      verify();
    }
    function runVerification(): void {
      const guestId = safeWebviewCall(() => activeWebview.getWebContentsId(), 0);
      if (guestId !== activeRequest.webContentsId) {
        logger.debug("[browser-use] 截图 surface 等待当前 guest", {
          requestId: activeRequest.requestId,
          expectedGuestId: activeRequest.webContentsId,
          guestId,
        });
        retry();
        return;
      }
      const viewport = readSurfaceViewport(activeWebview, activeRequest.viewport);
      if (!viewport || !withinOnePixel(viewport, activeRequest.viewport)) {
        if (!mismatchLogged) {
          mismatchLogged = true;
          logger.debug("[browser-use] 截图 surface viewport 尚未对齐", {
            requestId: activeRequest.requestId,
            expectedViewport: activeRequest.viewport,
            viewport,
          });
        }
        retry();
        return;
      }
      const current = { surfaceScale: readSurfaceScale(activeWebview), viewport };
      if (!firstFrame || !sameSurface(firstFrame, current)) {
        firstFrame = current;
        retry();
        return;
      }
      if (disposed) return;
      logger.debug("[browser-use] 截图 surface 已稳定", {
        requestId: activeRequest.requestId,
        tabId: activeRequest.tabId,
        surfaceScale: current.surfaceScale,
        viewport: current.viewport,
      });
      reported = true;
      platform.browserViewScreenshotSurfaceReady?.({
        ...activeRequest,
        surfaceScale: current.surfaceScale,
        viewport: current.viewport,
      });
    }
    function restartVerification(): void {
      if (disposed || reported) return;
      firstFrame = null;
      mismatchLogged = false;
      cancelPendingVerification();
      verify();
    }
    const observer = new ResizeObserver(() => {
      restartVerification();
    });
    // getWebContentsId() may temporarily return 0 on the guest’s first attach; if the layout size does not change,
    // ResizeObserver will not fire again. dom-ready is the view boundary where the guest identity becomes readable,
    // so reset the stable-frame count here and restart validation.
    const handleDomReady = () => {
      restartVerification();
    };
    // When the window returns to the foreground, Chromium resumes rAF and compositing; the surface may have just been rebuilt,
    // so previous stable frames are no longer trustworthy. Clear them and start over so validation can complete its two frames as soon as the view becomes visible again.
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      restartVerification();
    };
    observer.observe(activeWebview);
    activeWebview.addEventListener("dom-ready", handleDomReady);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    verify();
    return () => {
      disposed = true;
      observer.disconnect();
      activeWebview.removeEventListener("dom-ready", handleDomReady);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      cancelPendingVerification();
    };
  }, [platform, request, webview]);
}

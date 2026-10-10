import type { WebContents } from "electron";

/**
 * autoInject initializes executeJavaScript at dom-ready, but in Vite, window.load often finishes earlier,
 * so perf-collector's onLoad/sendPerf never runs (webvitals still reports, so beforeReport has perf=0).
 * Dispatch load after did-finish-load and dom-ready, and wait until RumSDK is ready.
 */
const ARMS_BROWSER_PERF_LOAD_NUDGE_SCRIPT = `(function () {
  function dispatchLoad() {
    try {
      window.dispatchEvent(new Event("load"));
    } catch (e) {}
  }
  function tryNudge(attempt) {
    if (typeof window.RumSDK !== "undefined" && window.RumSDK.default) {
      if (document.readyState === "complete") {
        dispatchLoad();
      }
      return;
    }
    if (attempt < 80) {
      setTimeout(function () {
        tryNudge(attempt + 1);
      }, 25);
    }
  }
  if (document.readyState === "complete") {
    tryNudge(0);
  } else {
    window.addEventListener(
      "load",
      function () {
        tryNudge(0);
      },
      { once: true }
    );
  }
})();`;

export function scheduleArmsBrowserPerfLoadNudge(webContents: WebContents): void {
  const nudge = (): void => {
    if (webContents.isDestroyed()) {
      return;
    }
    void webContents.executeJavaScript(ARMS_BROWSER_PERF_LOAD_NUDGE_SCRIPT, true).catch(() => {
      // Ignore non-main windows or injection failures.
    });
  };

  webContents.on("did-finish-load", nudge);
  // Register alongside SDK autoInject on dom-ready, delaying one tick for RumSDK.default.init to finish.
  webContents.on("dom-ready", () => {
    setTimeout(nudge, 0);
    setTimeout(nudge, 150);
  });
}

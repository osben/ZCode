/**
 * Minimal abstraction for the controlled view: the executor depends only on these methods, making
 * stub-based unit tests possible without a real Electron webContents. browserGuestManager provides
 * the production implementation through a `<webview>` guest's webContents and webContents.debugger.
 */
export interface ControlledViewWebContents {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  /**
   * Execute a script in the page context and return the value of the final expression (structured-cloned).
   * browserGuestManager wires this to `guest.executeJavaScript(script, true)` (userGesture=true, matching element-picker).
   */
  executeJavaScript(script: string): Promise<unknown>;
}

export interface ControlledViewCdp {
  /** Direct access to webContents.debugger.sendCommand; sessionId targets cross-process iframe/OOPIF targets. */
  send(method: string, params?: unknown, sessionId?: string): Promise<unknown>;
}

export interface ControlledView {
  webContents: ControlledViewWebContents;
  cdp: ControlledViewCdp;
  /**
   * Viewport screenshot already composited by the host. Used only for ordinary screenshots without
   * clip or fullPage; the Desktop production implementation reads the guest surface directly from
   * main, avoiding CDP tiling of small surfaces on Windows.
   */
  captureViewportScreenshot?: () => Promise<string | undefined>;
  /**
   * A free-size guest's visible surface retains the host backing scale, while screenshot targets are
   * still calculated in CSS px. The executor reads CDP layout metrics and validates the actual raster
   * only when this flag is enabled.
   */
  normalizeScreenshotToCssPixels?: boolean;
  /**
   * High-quality downsampling provided by the host image engine. The core executor does not depend
   * directly on Electron; Desktop production uses nativeImage, while tests and other hosts can inject
   * an equivalent implementation.
   */
  resizeScreenshotToCssPixels?: (
    base64Png: string,
    target: { height: number; width: number },
  ) => Promise<string | undefined> | string | undefined;
}

export interface BrowserPoint {
  cx: number;
  cy: number;
}

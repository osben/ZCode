/* eslint-disable max-lines -- Desktop window chrome, webview security policy, and popup routing share one BrowserWindow lifecycle context. */
import { app, BrowserWindow, Menu, nativeImage, nativeTheme, screen, shell } from "electron";
import { join } from "node:path";
import type {
  ContextMenuParams,
  Input,
  MenuItemConstructorOptions,
  WebContents,
  WindowOpenHandlerResponse,
} from "electron";
import type { DesktopTitleBarTheme, Locale } from "@zcode/shared";
import {
  DEFAULT_LOCALE,
  desktopMenuMessageIds,
  getDesktopMenuMessage,
  isTrustedCodingPlanWebviewOrigin,
  isTrustedRewardsUrl,
  PlatformChannels,
} from "@zcode/shared";
import { loadWindow, type WindowBootstrapOptions } from "./desktopHostProcess.js";
import {
  buildWindowsTitleBarOverlayForZoomLevel,
  hasCustomWindowsControls,
  registerCustomWindowsControls,
  MACOS_TRAFFIC_LIGHT_BASE_POSITION,
  syncWindowControlsOverlayForZoomLevel,
} from "./desktopWindowButtonPosition.js";
import {
  clampDesktopZoomLevel,
  resolveDesktopZoomFactorForLevel,
  resolveDesktopZoomLevelFromFactor,
} from "./desktopZoom.js";
import { resolveDesktopWindowChromeState } from "./desktopWindowChromeState.js";
import {
  MIN_DESKTOP_WINDOW_HEIGHT,
  MIN_DESKTOP_WINDOW_WIDTH,
  resolveDesktopWindowSize,
  type DesktopWindowSize,
} from "./desktopWindowSize.js";
import { getPluginSandboxHost, isPluginSandboxSrc } from "./pluginSandbox/index.js";
import { installEmbeddedBrowserBluetoothDeviceGuard } from "./embeddedBrowserBluetoothGuard.js";
import { getEmbeddedBrowserDevicePicker } from "./embeddedBrowserPermissionUiBridge.js";
// CDP-on-guest pivot: the built-in browser renders with `<webview>` again, so the host BrowserWindow must enable webviewTag
// and harden the guest, apply the URL allowlist, and route popups to internal tabs in will/did-attach-webview.
const ALLOWED_EMBEDDED_BROWSER_PROTOCOLS = new Set([
  "about:",
  "data:",
  "http:",
  "https:",
  "zcode-browser-restore:",
]);
const ALLOWED_EMBEDDED_BROWSER_NEW_WINDOW_PROTOCOLS = new Set(["http:", "https:"]);
const EXTERNAL_BROWSER_DISPOSITIONS = new Set(["background-tab"]);
const CODING_PLAN_ZAI_PAYPAL_RELAY_HOSTS = new Set(["api.z.ai", "api.z.ai"]);
const embeddedBrowserJavaScriptDialogPreloadPath = join(
  import.meta.dirname,
  "../preload/embeddedBrowserJavaScriptDialog.cjs",
);
// Coding Plan website-specific preload: expose window.zcodeBridge for the site to report purchase completion.
const codingPlanWebviewPreloadPath = join(import.meta.dirname, "../preload/codingPlanWebview.cjs");

/**
 * Check whether a webview is loading the Coding Plan purchase page (/coding-plan?...&embedded=app).
 * Used in will-attach-webview to switch its preload to codingPlanWebviewPreloadPath; other webviews (such as the built-in
 * browser) continue to use embeddedBrowserJavaScriptDialogPreloadPath.
 */
function isCodingPlanEmbeddedWebviewSrc(src: string | undefined): boolean {
  if (!src) return false;
  try {
    const url = new URL(src);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (
      !isTrustedCodingPlanWebviewOrigin(url.origin, {
        e2eStoreBridgeEnabled: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
      })
    ) {
      return false;
    }
    if (url.pathname !== "/coding-plan") return false;
    const embedded = url.searchParams.get("embedded");
    return embedded === "app";
  } catch {
    return false;
  }
}

/**
 * Loosely determine whether the webview's current URL belongs to the Coding Plan purchase page.
 *
 * By the time setWindowOpenHandler runs, the webview may already have followed a locale redirect
 * (/coding-plan → /cn/coding-plan), so match the pathname with includes.
 * embedded=app remains required to avoid misidentifying external links from the built-in browser.
 */
function isCodingPlanWebviewUrl(src: string | undefined): boolean {
  if (!src) return false;
  try {
    const url = new URL(src);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (
      !isTrustedCodingPlanWebviewOrigin(url.origin, {
        e2eStoreBridgeEnabled: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
      })
    ) {
      return false;
    }
    if (!url.pathname.includes("coding-plan")) return false;
    return url.searchParams.get("embedded") === "app";
  } catch {
    return false;
  }
}

function isCodingPlanPaymentCallbackUrl(src: string | undefined): boolean {
  if (!src) return false;
  try {
    const url = new URL(src);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (
      !isTrustedCodingPlanWebviewOrigin(url.origin, {
        e2eStoreBridgeEnabled: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
      })
    ) {
      return false;
    }
    if (!url.pathname.endsWith("/coding-plan/payment/callback")) return false;
    const returnTo = url.searchParams.get("returnTo");
    if (!returnTo) return false;
    const target = new URL(returnTo, url.origin);
    return target.origin === url.origin && isCodingPlanWebviewUrl(target.toString());
  } catch {
    return false;
  }
}

function isLinuxDesktopWindow() {
  return process.platform === "linux";
}

function buildDesktopWindowVisualOptions() {
  if (process.platform === "darwin") {
    return {
      backgroundColor: "#00000000",
      titleBarStyle: "hidden" as const,
      trafficLightPosition: MACOS_TRAFFIC_LIGHT_BASE_POSITION,
      vibrancy: "under-window" as const,
      visualEffectState: "active" as const,
    };
  }

  if (process.platform === "win32") {
    return {
      backgroundColor: "#00000000",
      // Window controls on Windows are drawn by the renderer; disable the native title bar to avoid duplicate buttons.
      frame: false,
      backgroundMaterial: "acrylic" as const,
    };
  }

  return {
    // An opaque BrowserWindow fills the renderer's clipped rounded corners with a square black background, so the Linux
    // shell cannot form concentric curves with the inner 12px panel. Transparency reveals only the corners; the renderer
    // root remains opaque to keep the desktop background out of the sidebar.
    backgroundColor: "#00000000",
    transparent: true,
    // Linux's native title bar duplicates the renderer-drawn top menu; hide the frame and use custom window controls.
    frame: false,
    // Some Linux window managers add an outer shadow/border to frameless windows, visible as a black outline.
    // Disable the system shadow only on Linux to preserve native materials on macOS/Windows.
    hasShadow: false,
  };
}

export function applyAppIcon(iconPath: string) {
  if (process.platform !== "darwin" || app.dock == null) {
    return;
  }

  // TypeScript does not narrow app.dock automatically when process.platform === "darwin".
  // Its declared type may still be undefined, so a direct call triggers ts(18048).
  // Combine the platform and null checks to match runtime semantics and let the type system know Dock is present.
  const dockIcon = nativeImage.createFromPath(iconPath);
  if (!dockIcon.isEmpty()) {
    app.dock.setIcon(dockIcon);
  }
}

function syncWindowFullscreenState(targetWindow: BrowserWindow) {
  if (targetWindow.isDestroyed()) {
    return;
  }

  targetWindow.webContents.send(
    PlatformChannels.WindowFullscreenChanged,
    targetWindow.isFullScreen(),
  );
}

function syncDesktopWindowChromeState(targetWindow: BrowserWindow) {
  if (targetWindow.isDestroyed()) return;

  targetWindow.webContents.send(
    PlatformChannels.DesktopWindowChromeStateChanged,
    resolveDesktopWindowChromeState(targetWindow.isMaximized()),
  );
}

export function getWindowOverlayTheme(): Exclude<DesktopTitleBarTheme, "system"> {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

export function applyWindowsTitleBarTheme(
  targetWindow: BrowserWindow,
  theme: DesktopTitleBarTheme,
) {
  if (
    process.platform !== "win32" ||
    targetWindow.isDestroyed() ||
    hasCustomWindowsControls(targetWindow)
  ) {
    return;
  }

  const resolvedTheme = theme === "system" ? getWindowOverlayTheme() : theme;
  const zoomLevel = resolveDesktopZoomLevelFromFactor(targetWindow.webContents.getZoomFactor());
  targetWindow.setTitleBarOverlay(
    buildWindowsTitleBarOverlayForZoomLevel(zoomLevel, resolvedTheme),
  );
}

function attachWindowsWindowRepaint(targetWindow: BrowserWindow) {
  if (process.platform !== "win32") {
    return;
  }

  let pendingRepaintTimer: ReturnType<typeof setTimeout> | null = null;
  const repaint = () => {
    if (targetWindow.isDestroyed() || targetWindow.webContents.isDestroyed()) {
      return;
    }

    targetWindow.webContents.invalidate();
  };

  const scheduleRepaint = () => {
    repaint();
    if (pendingRepaintTimer !== null) {
      clearTimeout(pendingRepaintTimer);
    }
    pendingRepaintTimer = setTimeout(() => {
      pendingRepaintTimer = null;
      repaint();
    }, 32);
  };

  targetWindow.on("resized", () => {
    // After manual resize on Windows, Electron/Chromium sometimes updates only the window bounds without fully repainting
    // the renderer's last frame, leaving host background in the newly exposed area. resized is a low-frequency completion
    // event, so repaint the full window once to fill the content layer at the final viewport size.
    scheduleRepaint();
  });
  targetWindow.on("show", () => {
    // After a Windows Acrylic window is hidden to the tray and shown again, it may reuse an invalid compositing surface.
    // Renderer and host remain alive but only the host background is visible; reuse the bounded two-frame repaint from
    // resize without reloading the renderer or session.
    scheduleRepaint();
  });
}

function isAllowedEmbeddedBrowserUrl(url: string): boolean {
  try {
    return ALLOWED_EMBEDDED_BROWSER_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

function isAllowedEmbeddedBrowserNewWindowUrl(url: string): boolean {
  try {
    return ALLOWED_EMBEDDED_BROWSER_NEW_WINDOW_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

function isPaypalHostname(hostname: string): boolean {
  return hostname === "paypal.com" || hostname.endsWith(".paypal.com");
}

function isCodingPlanPaypalNavigationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (isPaypalHostname(parsed.hostname)) return true;
    // The PayPal approveUrl from the backend may first point to a Z.AI payment API relay that redirects to PayPal.
    // Keep the relay URL in the current webview too, or the system browser will take over.
    return (
      CODING_PLAN_ZAI_PAYPAL_RELAY_HOSTS.has(parsed.hostname) &&
      parsed.pathname.startsWith("/api/pay/paypal/")
    );
  } catch {
    return false;
  }
}

function isAllowedCodingPlanEmbeddedNavigationUrl(url: string): boolean {
  return (
    isCodingPlanWebviewUrl(url) ||
    isCodingPlanPaypalNavigationUrl(url) ||
    isCodingPlanPaymentCallbackUrl(url)
  );
}

function hasExternalBrowserModifier(input: Input): boolean {
  const modifiers = new Set(input.modifiers ?? []);
  return (
    input.meta === true ||
    input.control === true ||
    modifiers.has("meta") ||
    modifiers.has("command") ||
    modifiers.has("cmd") ||
    modifiers.has("control") ||
    modifiers.has("ctrl")
  );
}

function isExternalBrowserModifierKey(input: Input): boolean {
  const key = input.key.toLowerCase();
  const code = input.code.toLowerCase();
  return (
    key === "meta" ||
    key === "control" ||
    code === "metaleft" ||
    code === "metaright" ||
    code === "controlleft" ||
    code === "controlright"
  );
}

function shouldOpenEmbeddedBrowserRequestExternally(input: {
  disposition: string;
  externalBrowserModifierActive: boolean;
}): boolean {
  return (
    input.externalBrowserModifierActive || EXTERNAL_BROWSER_DISPOSITIONS.has(input.disposition)
  );
}

function attachEmbeddedBrowserWindowOpenHandler(options: {
  hostWebContents: WebContents;
  guestWebContents: WebContents;
  isCodingPlanGuest: boolean;
  isRewardsGuest: boolean;
  resolveBrowserViewOwner?: (webContentsId: number) =>
    | {
        workspaceKey: string;
        remoteSessionId?: string;
        sessionId: string;
        browserId: string;
        browserGeneration: number;
        tabId: string;
      }
    | undefined;
  logger: { warn: (...args: unknown[]) => void };
}) {
  let externalBrowserModifierActive = false;

  options.guestWebContents.on("before-input-event", (_event, input) => {
    // On some platforms keyUp may still include modifier flags. Recording the latest modifiers directly would leave the
    // "open in system browser" state stuck on, causing later ordinary clicks to open externally too.
    if (input.type === "keyUp" && isExternalBrowserModifierKey(input)) {
      externalBrowserModifierActive = false;
      return;
    }

    externalBrowserModifierActive = hasExternalBrowserModifier(input);
  });

  options.guestWebContents.setWindowOpenHandler((details): WindowOpenHandlerResponse => {
    const { url, disposition } = details;
    if (!isAllowedEmbeddedBrowserNewWindowUrl(url)) {
      options.logger.warn(`[browser-pane] blocked unsupported webview popup url: ${url}`);
      return { action: "deny" };
    }

    // External links from the Coding Plan webview (terms/manage links using target=_blank) open in the system browser,
    // not an internal Browser tab, matching the native purchase panel. When the callback runs, the webview URL may already
    // have completed a locale redirect to /cn/coding-plan, so use the loose match.
    // Payment links use location.href (which does not trigger setWindowOpenHandler) and are unaffected.
    const guestUrl =
      typeof options.guestWebContents.getURL === "function"
        ? options.guestWebContents.getURL()
        : "";
    const shouldRouteCodingPlanPopup =
      options.isCodingPlanGuest ||
      isCodingPlanWebviewUrl(guestUrl) ||
      isCodingPlanPaypalNavigationUrl(guestUrl);
    if (shouldRouteCodingPlanPopup) {
      if (isAllowedCodingPlanEmbeddedNavigationUrl(url)) {
        // PayPal authorization/callback is part of the Coding Plan purchase flow and must stay out of the system browser,
        // or the authorization return leaves this webview and loses purchase context. Navigate the current guest for popup links.
        void options.guestWebContents.loadURL(url).catch((error: unknown) => {
          options.logger.warn(
            "[browser-pane] failed to load coding-plan embedded popup in webview",
            {
              error: error instanceof Error ? error.message : String(error),
              url,
            },
          );
        });
        return { action: "deny" };
      }
      void shell.openExternal(url).catch((error: unknown) => {
        options.logger.warn("[browser-pane] failed to open coding-plan popup externally", {
          error: error instanceof Error ? error.message : String(error),
          url,
        });
      });
      return { action: "deny" };
    }

    if (
      shouldOpenEmbeddedBrowserRequestExternally({
        disposition,
        externalBrowserModifierActive,
      })
    ) {
      void shell.openExternal(url).catch((error: unknown) => {
        options.logger.warn("[browser-pane] failed to open webview popup externally", {
          error: error instanceof Error ? error.message : String(error),
          url,
        });
      });
      return { action: "deny" };
    }

    const owner = options.resolveBrowserViewOwner?.(options.guestWebContents.id);
    options.hostWebContents.send(PlatformChannels.OpenBrowserUrl, {
      disposition,
      url,
      ...(owner
        ? {
            workspaceKey: owner.workspaceKey,
            ...(owner.remoteSessionId ? { remoteSessionId: owner.remoteSessionId } : {}),
            sessionId: owner.sessionId,
            browserId: owner.browserId,
            browserGeneration: owner.browserGeneration,
            sourceTabId: owner.tabId,
          }
        : {}),
    });
    return { action: "deny" };
  });

  options.guestWebContents.on("will-navigate", (event, url) => {
    if (options.isRewardsGuest) {
      if (
        isTrustedRewardsUrl(url, {
          dev: !app.isPackaged,
          e2e: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
        })
      )
        return;
      // When the invitation page leaves the trusted path it must open externally; never let
      // third-party pages use a container with injected credentials.
      event.preventDefault();
      if (isAllowedEmbeddedBrowserNewWindowUrl(url))
        void shell
          .openExternal(url)
          .catch(() => options.logger.warn("[rewards] external navigation failed"));
      return;
    }
    const guestUrl =
      typeof options.guestWebContents.getURL === "function"
        ? options.guestWebContents.getURL()
        : "";
    const shouldGuardCodingPlanNavigation =
      options.isCodingPlanGuest ||
      isCodingPlanWebviewUrl(guestUrl) ||
      isCodingPlanPaypalNavigationUrl(guestUrl);
    if (!shouldGuardCodingPlanNavigation || isCodingPlanWebviewUrl(url)) {
      return;
    }
    if (!isAllowedEmbeddedBrowserNewWindowUrl(url)) {
      options.logger.warn(`[browser-pane] blocked unsupported coding-plan navigation url: ${url}`);
      event.preventDefault();
      return;
    }
    if (isAllowedCodingPlanEmbeddedNavigationUrl(url)) {
      // PayPal authorization initiated by the website through location.href triggers a main-frame navigation.
      // Keep PayPal/relay/trusted-site returns in this webview so the later callback can continue the subscription flow.
      return;
    }

    // The Coding Plan-specific preload remains active across later main-frame navigations.
    // When leaving the trusted purchase page, block guest navigation and hand it to the system browser so third-party pages do not inherit zcodeBridge.
    event.preventDefault();
    void shell.openExternal(url).catch((error: unknown) => {
      options.logger.warn("[browser-pane] failed to open coding-plan navigation externally", {
        error: error instanceof Error ? error.message : String(error),
        url,
      });
    });
  });
}

function buildTextContextMenuTemplate(
  params: ContextMenuParams,
  locale: Locale,
): MenuItemConstructorOptions[] {
  if (params.isEditable) {
    const getLabel = (id: (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds]) =>
      getDesktopMenuMessage(locale, id);

    return [
      {
        label: getLabel(desktopMenuMessageIds.editUndo),
        role: "undo",
        enabled: params.editFlags.canUndo,
      },
      {
        label: getLabel(desktopMenuMessageIds.editRedo),
        role: "redo",
        enabled: params.editFlags.canRedo,
      },
      { type: "separator" },
      {
        label: getLabel(desktopMenuMessageIds.editCut),
        role: "cut",
        enabled: params.editFlags.canCut,
      },
      {
        label: getLabel(desktopMenuMessageIds.editCopy),
        role: "copy",
        enabled: params.editFlags.canCopy,
      },
      {
        label: getLabel(desktopMenuMessageIds.editPaste),
        role: "paste",
        enabled: params.editFlags.canPaste,
      },
      {
        label: getLabel(desktopMenuMessageIds.editDelete),
        role: "delete",
        enabled: params.editFlags.canDelete,
      },
      { type: "separator" },
      {
        label: getLabel(desktopMenuMessageIds.editSelectAll),
        role: "selectAll",
        enabled: params.editFlags.canSelectAll,
      },
    ];
  }

  if (params.selectionText.trim().length > 0) {
    return [{ role: "copy", enabled: params.editFlags.canCopy }];
  }

  return [];
}

export function createBrowserWindow(options: {
  iconPath: string;
  preloadPath: string;
  title?: string;
  bootstrap?: WindowBootstrapOptions;
  logger: { warn: (...args: unknown[]) => void };
  /** Desktop device identifier (SHA-256 of the userData path), read synchronously by the renderer. */
  deviceMid?: string;
  /** Persisted desktop page-zoom level; apply when creating the window so the first screen does not use the default size. */
  initialDesktopZoomLevel?: number;
  /** Most recent normal window size and maximized state read by the main-process settings service. */
  initialWindowSize?: DesktopWindowSize;
  /** Read each time a native menu opens so language changes do not require rebuilding the window. */
  currentApplicationLocale?: () => Locale;
  resolveBrowserViewOwner?: (webContentsId: number) =>
    | {
        workspaceKey: string;
        remoteSessionId?: string;
        sessionId: string;
        browserId: string;
        browserGeneration: number;
        tabId: string;
      }
    | undefined;
}): BrowserWindow {
  const initialDesktopZoomLevel = clampDesktopZoomLevel(options.initialDesktopZoomLevel ?? 0);
  const initialDesktopZoomFactor = resolveDesktopZoomFactorForLevel(initialDesktopZoomLevel);
  const initialWindowSize = resolveDesktopWindowSize(
    options.initialWindowSize,
    screen.getPrimaryDisplay().workAreaSize,
  );
  const win = new BrowserWindow({
    width: initialWindowSize.width,
    height: initialWindowSize.height,
    minWidth: MIN_DESKTOP_WINDOW_WIDTH,
    // Available height on a 1280x720 desktop is usually below 768; a higher minimum would prevent users from shrinking the window further.
    minHeight: MIN_DESKTOP_WINDOW_HEIGHT,
    title: options.title,
    icon: options.iconPath,
    // Some Linux desktops may still show Electron's native menu bar for frameless windows; auto-hide it to avoid duplicate top menus.
    autoHideMenuBar: isLinuxDesktopWindow(),
    ...buildDesktopWindowVisualOptions(),
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // CDP-on-guest pivot: the built-in browser renders with `<webview>` again, so the host must enable webviewTag.
      webviewTag: true,
      // Permanently setting backgroundThrottling=false wakes the entire window renderer, all webview guests, and the GPU.
      // Keep default throttling; during screenshots, wake only the owner renderer and current target guest temporarily.
      zoomFactor: initialDesktopZoomFactor,
      // Pass deviceMid to preload so the renderer can read it synchronously before React renders.
      additionalArguments: [`--device-id=${options.deviceMid ?? ""}`],
    },
  });

  // The zoom command originally changed only the current window and was not restored after restart.
  // Apply the desktop zoom level from setting.json in main when creating the window, overriding any per-host zoom Chromium may retain.
  win.webContents.setZoomFactor(initialDesktopZoomFactor);
  if (process.platform === "win32") registerCustomWindowsControls(win);
  syncWindowControlsOverlayForZoomLevel(win, initialDesktopZoomLevel);

  if (initialWindowSize.maximized) {
    win.maximize();
  }

  win.on("enter-full-screen", () => {
    syncWindowFullscreenState(win);
  });
  win.on("leave-full-screen", () => {
    syncWindowFullscreenState(win);
  });
  win.on("maximize", () => syncDesktopWindowChromeState(win));
  win.on("unmaximize", () => syncDesktopWindowChromeState(win));
  attachWindowsWindowRepaint(win);
  // will-attach and did-attach pair in order; queue entries record the guest kind, and
  // did-attach dispatches policy accordingly.
  const pendingWebviewGuestKinds: Array<
    | { kind: "browser" | "codingPlan"; isRewards: boolean }
    | { kind: "pluginSandbox"; sandboxId: string }
  > = [];

  win.webContents.once("did-finish-load", () => {
    // For packaged navigation through loadFile(file://...), Chromium may replay origin-level zoom after page load and
    // overwrite the persisted zoom set during window creation with the default.
    // Replay the setting.json zoom level after did-finish-load so packaged and localhost development builds behave consistently.
    win.webContents.setZoomFactor(initialDesktopZoomFactor);
    syncWindowControlsOverlayForZoomLevel(win, initialDesktopZoomLevel);
    syncWindowFullscreenState(win);
  });
  win.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      // After navigation failure, CDP target metadata may still retain the original file:// URL while the renderer's actual
      // document has entered chrome-error://. Record main-frame failures to find the true navigation cause.
      options.logger.warn("[desktop-window] renderer did-fail-load", {
        errorCode,
        errorDescription,
        validatedURL,
        webContentsId: win.webContents.id,
      });
    },
  );

  win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    // Replacing the UI through CDP after a native dialog is created may still leave a queued Chromium NSAlert visible on
    // macOS. The fixed preload intercepts before each frame calls the native API, and exposes only a synchronous
    // alert/confirm bridge in the isolated world; the page's main world still has no Node or arbitrary IPC access.
    //
    // Coding Plan website exception: it needs window.zcodeBridge to report purchase completion, so use its dedicated
    // preload (codingPlanWebview.ts); other webviews keep the native Dialog bridge.
    const targetUrl = params.src ?? "about:blank";
    // Plugin UI sandbox guest: a separate branch that skips the built-in browser's preload /
    // allowpopups / protocol allowlist.
    if (isPluginSandboxSrc(targetUrl)) {
      const host = getPluginSandboxHost();
      const decision = host?.configureGuest({
        webPreferences,
        params,
        ownerWebContentsId: win.webContents.id,
      });
      if (!decision?.ok) {
        options.logger.warn(
          `[plugin-sandbox] blocked webview attach: ${decision ? decision.reason : "host-not-installed"}`,
        );
        event.preventDefault();
        return;
      }
      pendingWebviewGuestKinds.push({ kind: "pluginSandbox", sandboxId: decision.sandboxId });
      return;
    }
    const isCodingPlanWebview = isCodingPlanEmbeddedWebviewSrc(targetUrl);
    webPreferences.preload = isCodingPlanWebview
      ? codingPlanWebviewPreloadPath
      : embeddedBrowserJavaScriptDialogPreloadPath;
    const isRewardsWebview = isTrustedRewardsUrl(targetUrl, {
      dev: !app.isPackaged,
      e2e: process.env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
    });
    if (isRewardsWebview) {
      webPreferences.preload = join(import.meta.dirname, "../preload/rewardsWebview.cjs");
      if (!app.isPackaged)
        webPreferences.additionalArguments = [
          ...(webPreferences.additionalArguments ?? []),
          "--zcode-rewards-dev",
        ];
    }
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = true;
    webPreferences.sandbox = true;

    delete params.preload;
    delete params.nodeintegration;
    // nodeIntegrationInSubFrames is a guest-creation preference. Set it true in both derived WebPreferences and the
    // original attach parameters so child frames that navigate load the same preload before page scripts.
    // Inherited empty frames without src do not trigger preload; the same-origin frame observer inside the preload handles them.
    params.nodeintegrationinsubframes = "true";
    delete params.disablewebsecurity;
    delete params.allowpopups;

    // Disabling target=_blank/window.open popups inside webview makes clicks appear unresponsive; allowing Electron's
    // default behavior creates a BrowserWindow outside ZCode. Re-enable allowpopups at the host, then use
    // setWindowOpenHandler in did-attach-webview to deny default window creation and route valid URLs to an internal Browser tab or system browser.
    params.allowpopups = "true";

    if (!isAllowedEmbeddedBrowserUrl(targetUrl)) {
      options.logger.warn(`[browser-pane] blocked unsupported webview url: ${targetUrl}`);
      event.preventDefault();
      return;
    }

    pendingWebviewGuestKinds.push({
      kind: isCodingPlanWebview ? "codingPlan" : "browser",
      isRewards: isRewardsWebview,
    });
  });

  win.webContents.on("did-attach-webview", (_event, guestWebContents) => {
    const guestKind = pendingWebviewGuestKinds.shift() ?? {
      kind: "browser" as const,
      isRewards: false,
    };
    if (guestKind.kind === "pluginSandbox") {
      getPluginSandboxHost()?.attachGuest({
        guest: guestWebContents,
        hostWebContents: win.webContents,
        sandboxId: guestKind.sandboxId,
      });
      return;
    }
    attachEmbeddedBrowserWindowOpenHandler({
      guestWebContents,
      hostWebContents: win.webContents,
      resolveBrowserViewOwner: options.resolveBrowserViewOwner,
      // PayPal/relay 30x redirects are not guaranteed to trigger will-navigate at each hop.
      // Pin Coding Plan guest identity to the initial src; do not remove protection based on the current URL.
      isCodingPlanGuest: guestKind.kind === "codingPlan",
      isRewardsGuest: guestKind.isRewards,
      logger: options.logger,
    });
    // Bluetooth device-selection events hang off the guest WebContents (Session covers only
    // hid/usb/serial); install the guard for built-in browser guests only, blocking Electron's
    // default of silently granting the first device when no listener is attached.
    if (guestKind.kind === "browser") {
      installEmbeddedBrowserBluetoothDeviceGuard(guestWebContents, options.logger.warn, {
        devicePicker: getEmbeddedBrowserDevicePicker(),
        hostWebContentsId: win.webContents.id,
      });
    }
  });

  win.webContents.on("context-menu", (_event, params) => {
    // Setting only the Electron role makes menu labels follow the system/Electron language, which may differ from the app.
    // Read the current locale on every context-menu open and set the label explicitly so language changes apply next time.
    const template = buildTextContextMenuTemplate(
      params,
      options.currentApplicationLocale?.() ?? DEFAULT_LOCALE,
    );

    if (!app.isPackaged) {
      if (template.length > 0) {
        template.push({ type: "separator" });
      }
      template.push({
        label: "Inspect Element",
        click: () => {
          win.webContents.inspectElement(params.x, params.y);
        },
      });
    }

    if (template.length === 0) {
      return;
    }

    // To prevent double context menus with terminal and other DOM menus, production previously disabled Electron's native
    // menu entirely. Ordinary text selections and inputs have no DOM menu, making right-click copy/paste appear disabled.
    // Add the native menu only for text-editing contexts.
    Menu.buildFromTemplate(template).popup({ window: win });
  });

  void Promise.resolve(loadWindow(win, "index", options.bootstrap)).catch((error: unknown) => {
    // Navigation promises returned by loadFile/loadURL were previously discarded, so a failed navigation during a long run
    // appeared only as a chrome-error page, with no original exception in main-process logs.
    options.logger.warn("[desktop-window] renderer navigation rejected", error);
  });
  return win;
}

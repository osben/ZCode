import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { PlatformChannels } from "@zcode/shared";

const electronMocks = vi.hoisted(() => {
  const browserWindowConstructor = vi.fn();
  const browserWindowInstance = {
    isFullScreen: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    isDestroyed: vi.fn(() => false),
    maximize: vi.fn(),
    on: vi.fn(),
    setWindowButtonPosition: vi.fn(),
    setTitleBarOverlay: vi.fn(),
    webContents: {
      id: 17,
      getZoomFactor: vi.fn(() => 1),
      invalidate: vi.fn(),
      isDestroyed: vi.fn(() => false),
      on: vi.fn(),
      once: vi.fn(),
      send: vi.fn(),
      setZoomFactor: vi.fn(),
    },
  };

  return {
    app: {
      dock: undefined,
    },
    browserWindowConstructor,
    browserWindowInstance,
    loadWindow: vi.fn(),
    menuBuildFromTemplate: vi.fn(() => ({ popup: vi.fn() })),
    nativeImageCreateFromPath: vi.fn(() => ({ isEmpty: () => true })),
    shellOpenExternal: vi.fn(() => Promise.resolve()),
    screenGetPrimaryDisplay: vi.fn(() => ({ workAreaSize: { width: 1920, height: 1040 } })),
    shouldUseDarkColors: true,
  };
});

vi.mock("electron", () => ({
  app: electronMocks.app,
  BrowserWindow: class {
    constructor(options: unknown) {
      electronMocks.browserWindowConstructor(options);
      return electronMocks.browserWindowInstance;
    }
  },
  Menu: {
    buildFromTemplate: electronMocks.menuBuildFromTemplate,
  },
  nativeImage: {
    createFromPath: electronMocks.nativeImageCreateFromPath,
  },
  nativeTheme: {
    get shouldUseDarkColors() {
      return electronMocks.shouldUseDarkColors;
    },
  },
  shell: {
    openExternal: electronMocks.shellOpenExternal,
  },
  screen: {
    getPrimaryDisplay: electronMocks.screenGetPrimaryDisplay,
  },
}));

vi.mock("../src/main/desktopHostProcess.js", () => ({
  loadWindow: electronMocks.loadWindow,
}));

const originalPlatform = process.platform;

function stubProcessPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

describe("desktopWindowChrome", () => {
  afterEach(() => {
    stubProcessPlatform(originalPlatform);
    electronMocks.browserWindowConstructor.mockReset();
    electronMocks.browserWindowInstance.isDestroyed.mockClear();
    electronMocks.browserWindowInstance.isFullScreen.mockClear();
    electronMocks.browserWindowInstance.isMaximized.mockReset();
    electronMocks.browserWindowInstance.isMaximized.mockReturnValue(false);
    electronMocks.browserWindowInstance.on.mockClear();
    electronMocks.browserWindowInstance.maximize.mockClear();
    electronMocks.browserWindowInstance.setWindowButtonPosition.mockClear();
    electronMocks.browserWindowInstance.setTitleBarOverlay.mockClear();
    electronMocks.browserWindowInstance.webContents.getZoomFactor.mockReset();
    electronMocks.browserWindowInstance.webContents.getZoomFactor.mockReturnValue(1);
    electronMocks.browserWindowInstance.webContents.invalidate.mockClear();
    electronMocks.browserWindowInstance.webContents.isDestroyed.mockClear();
    electronMocks.browserWindowInstance.webContents.on.mockClear();
    electronMocks.browserWindowInstance.webContents.once.mockClear();
    electronMocks.browserWindowInstance.webContents.send.mockClear();
    electronMocks.browserWindowInstance.webContents.setZoomFactor.mockClear();
    electronMocks.loadWindow.mockReset();
    electronMocks.menuBuildFromTemplate.mockClear();
    electronMocks.shouldUseDarkColors = true;
    electronMocks.shellOpenExternal.mockClear();
    electronMocks.screenGetPrimaryDisplay.mockClear();
    vi.useRealTimers();
  });

  function getWebContentsHandler(eventName: string): (...args: unknown[]) => void {
    const handler = electronMocks.browserWindowInstance.webContents.on.mock.calls.find(
      ([event]) => event === eventName,
    )?.[1];
    expect(handler).toBeTypeOf("function");
    return handler as (...args: unknown[]) => void;
  }

  function getWebContentsOnceHandler(eventName: string): (...args: unknown[]) => void {
    const handler = electronMocks.browserWindowInstance.webContents.once.mock.calls.find(
      ([event]) => event === eventName,
    )?.[1];
    expect(handler).toBeTypeOf("function");
    return handler as (...args: unknown[]) => void;
  }

  it("creates the desktop main window with the documented minimum size", async () => {
    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");

    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn: vi.fn() },
    });

    // Functional constraint: the main window height must fit a 720p usable height, while keeping the desktop's core
    // area from being squeezed into unusability.
    expect(electronMocks.browserWindowConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 1200,
        height: 800,
        minWidth: 480,
        minHeight: 640,
      }),
    );
  });

  it("forwards a NativeImage icon to the BrowserWindow (dev DEV badge on Windows/Linux)", async () => {
    // CR-01 regression guard: in dev mode the main window icon is an in-memory NativeImage (with the DEV badge
    // overlaid); createBrowserWindow must pass it through verbatim to BrowserWindow's icon instead of only accepting
    // a path string.
    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");
    const badgeIcon = { isEmpty: () => false } as unknown as Electron.NativeImage;

    createBrowserWindow({
      iconPath: badgeIcon,
      preloadPath: "preload.js",
      logger: { warn: vi.fn() },
    });

    expect(electronMocks.browserWindowConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ icon: badgeIcon }),
    );
  });

  it("restores the persisted normal size before restoring maximized state", async () => {
    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");

    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn: vi.fn() },
      initialWindowSize: { width: 1440, height: 900, maximized: true },
    });

    expect(electronMocks.browserWindowConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1440, height: 900 }),
    );
    expect(electronMocks.browserWindowInstance.maximize).toHaveBeenCalledTimes(1);
  });

  it("publishes the current Windows chrome state on maximize and restore", async () => {
    stubProcessPlatform("win32");
    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");

    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn: vi.fn() },
    });
    expect(electronMocks.browserWindowConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ frame: false }),
    );
    expect(
      electronMocks.browserWindowConstructor.mock.calls.at(-1)?.[0].titleBarOverlay,
    ).toBeUndefined();

    const maximizeHandler = electronMocks.browserWindowInstance.on.mock.calls.find(
      ([event]) => event === "maximize",
    )?.[1] as (() => void) | undefined;
    const unmaximizeHandler = electronMocks.browserWindowInstance.on.mock.calls.find(
      ([event]) => event === "unmaximize",
    )?.[1] as (() => void) | undefined;

    electronMocks.browserWindowInstance.isMaximized.mockReturnValue(true);
    maximizeHandler?.();
    expect(electronMocks.browserWindowInstance.webContents.send).toHaveBeenLastCalledWith(
      PlatformChannels.DesktopWindowChromeStateChanged,
      expect.objectContaining({ isMaximized: true }),
    );

    electronMocks.browserWindowInstance.isMaximized.mockReturnValue(false);
    unmaximizeHandler?.();
    expect(electronMocks.browserWindowInstance.webContents.send).toHaveBeenLastCalledWith(
      PlatformChannels.DesktopWindowChromeStateChanged,
      expect.objectContaining({ isMaximized: false }),
    );
  });

  it("logs main-frame renderer navigation failures with the original Chromium reason", async () => {
    const warn = vi.fn();
    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");

    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn },
    });

    getWebContentsHandler("did-fail-load")(
      {},
      -6,
      "ERR_FILE_NOT_FOUND",
      "file:///missing/index.html",
      true,
    );

    expect(warn).toHaveBeenCalledWith("[desktop-window] renderer did-fail-load", {
      errorCode: -6,
      errorDescription: "ERR_FILE_NOT_FOUND",
      validatedURL: "file:///missing/index.html",
      webContentsId: 17,
    });
  });

  it("logs a rejected renderer navigation promise", async () => {
    const warn = vi.fn();
    const navigationError = new Error("renderer navigation failed");
    electronMocks.loadWindow.mockRejectedValueOnce(navigationError);
    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");

    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn },
    });
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith(
      "[desktop-window] renderer navigation rejected",
      navigationError,
    );
  });

  it("enables webviewTag so the embedded browser can render via <webview> (CDP-on-guest pivot)", async () => {
    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");

    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn: vi.fn() },
    });

    // CDP-on-guest pivot: the embedded browser is back to rendering via `<webview>`; the host must enable webviewTag.
    expect(electronMocks.browserWindowConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        webPreferences: expect.objectContaining({ webviewTag: true }),
      }),
    );

    // The host must register will/did-attach-webview to harden the guest and route popups.
    const registeredEvents = electronMocks.browserWindowInstance.webContents.on.mock.calls.map(
      ([event]) => event,
    );
    expect(registeredEvents).toContain("will-attach-webview");
    expect(registeredEvents).toContain("did-attach-webview");
  });

  it("keeps Electron background throttling enabled outside bounded browser screenshot leases", async () => {
    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");

    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn: vi.fn() },
    });

    // Bug cause: a permanent backgroundThrottling=false keeps the same BrowserWindow's renderer, all browser-use
    // guests, and the GPU running frames while the window is in the background. During screenshots, main's activity
    // lease wakes it temporarily.
    expect(electronMocks.browserWindowConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        webPreferences: expect.not.objectContaining({ backgroundThrottling: false }),
      }),
    );
  });

  it("installs the isolated JavaScript Dialog preload in every webview frame", async () => {
    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");

    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn: vi.fn() },
    });
    const willAttach = getWebContentsHandler("will-attach-webview");
    const webPreferences: Record<string, unknown> = {
      preload: "/untrusted/page-preload.js",
      nodeIntegration: true,
      nodeIntegrationInSubFrames: false,
    };
    const params: Record<string, string> = { src: "about:blank" };
    willAttach({ preventDefault: vi.fn() }, webPreferences, params);

    expect(webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      sandbox: true,
    });
    // Bugfix: the preload path is assembled by the code under test with the host's path.join; on Windows it is
    // `...\preload\embeddedBrowserJavaScriptDialog.cjs`, while this used to hardcode a POSIX fragment and would
    // always fail on Windows. Assembling the expected fragment with the host's join keeps the assertion expressing
    // the same "isolated JavaScript Dialog preload under the preload directory".
    expect(webPreferences.preload).toEqual(
      expect.stringContaining(join("preload", "embeddedBrowserJavaScriptDialog.cjs")),
    );
    expect(params.nodeintegrationinsubframes).toBe("true");
  });

  it("only installs the Coding Plan preload for trusted embedded purchase origins", async () => {
    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");

    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn: vi.fn() },
    });
    const willAttach = getWebContentsHandler("will-attach-webview");

    const officialPreferences: Record<string, unknown> = {};
    willAttach({ preventDefault: vi.fn() }, officialPreferences, {
      src: "https://zcode.z.ai/coding-plan?provider=zai&embedded=app",
    });
    // Bugfix: same as above; the preload path is assembled with the host's path.join and the Windows separator is
    // `\`, so an assertion hardcoding a POSIX fragment always fails on Windows.
    expect(officialPreferences.preload).toEqual(
      expect.stringContaining(join("preload", "codingPlanWebview.cjs")),
    );

    const untrustedPreferences: Record<string, unknown> = {};
    willAttach({ preventDefault: vi.fn() }, untrustedPreferences, {
      src: "https://evil.example/coding-plan?provider=zai&embedded=app",
    });
    expect(untrustedPreferences.preload).toEqual(
      expect.stringContaining(join("preload", "embeddedBrowserJavaScriptDialog.cjs")),
    );
  });

  it("allows loopback Coding Plan preload only for the E2E bridge", async () => {
    const previous = process.env.VITE_ZCODE_E2E_STORE_BRIDGE;
    process.env.VITE_ZCODE_E2E_STORE_BRIDGE = "1";
    try {
      const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");

      createBrowserWindow({
        iconPath: "icon.png",
        preloadPath: "preload.js",
        logger: { warn: vi.fn() },
      });
      const willAttach = getWebContentsHandler("will-attach-webview");
      const webPreferences: Record<string, unknown> = {};
      willAttach({ preventDefault: vi.fn() }, webPreferences, {
        src: "http://127.0.0.1:4567/coding-plan?provider=zai&embedded=app",
      });

      // Bugfix: same as above; on Windows the host's join produces `preload\codingPlanWebview.cjs`.
      expect(webPreferences.preload).toEqual(
        expect.stringContaining(join("preload", "codingPlanWebview.cjs")),
      );
    } finally {
      if (previous === undefined) {
        delete process.env.VITE_ZCODE_E2E_STORE_BRIDGE;
      } else {
        process.env.VITE_ZCODE_E2E_STORE_BRIDGE = previous;
      }
    }
  });

  it("repaints the Windows desktop window after manual resize finishes", async () => {
    vi.useFakeTimers();
    stubProcessPlatform("win32");

    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");

    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn: vi.fn() },
    });

    const resizedHandler = electronMocks.browserWindowInstance.on.mock.calls.find(
      ([event]) => event === "resized",
    )?.[1] as (() => void) | undefined;

    expect(resizedHandler).toBeTypeOf("function");
    resizedHandler?.();

    // Bugfix: after a resize finishes, Chromium must be asked to repaint the whole frame, otherwise the newly sized
    // area can keep the host background color.
    expect(electronMocks.browserWindowInstance.webContents.invalidate).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(32);

    expect(electronMocks.browserWindowInstance.webContents.invalidate).toHaveBeenCalledTimes(2);
  });

  it("repaints the Windows desktop window after it is shown from the tray", async () => {
    vi.useFakeTimers();
    stubProcessPlatform("win32");

    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");

    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn: vi.fn() },
    });

    const showHandler = electronMocks.browserWindowInstance.on.mock.calls.find(
      ([event]) => event === "show",
    )?.[1] as (() => void) | undefined;

    expect(showHandler).toBeTypeOf("function");
    showHandler?.();
    expect(electronMocks.browserWindowInstance.webContents.invalidate).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(32);

    expect(electronMocks.browserWindowInstance.webContents.invalidate).toHaveBeenCalledTimes(2);
  });

  it("does not enable native overlay when updating a custom Windows title bar theme", async () => {
    stubProcessPlatform("win32");
    electronMocks.browserWindowInstance.webContents.getZoomFactor.mockReturnValue(Math.pow(1.1, 2));

    const { applyWindowsTitleBarTheme, createBrowserWindow } =
      await import("../src/main/desktopWindowChrome.js");
    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn: vi.fn() },
    });

    applyWindowsTitleBarTheme(electronMocks.browserWindowInstance as never, "dark");

    expect(electronMocks.browserWindowInstance.setTitleBarOverlay).not.toHaveBeenCalled();
  });

  it("syncs macOS traffic light position and overlay padding from startup zoom factor", async () => {
    stubProcessPlatform("darwin");

    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");

    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn: vi.fn() },
      initialDesktopZoomLevel: 2,
    });

    getWebContentsOnceHandler("did-finish-load")();

    expect(electronMocks.browserWindowConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        webPreferences: expect.objectContaining({
          zoomFactor: Math.pow(1.1, 2),
        }),
      }),
    );
    expect(electronMocks.browserWindowInstance.webContents.setZoomFactor).toHaveBeenCalledTimes(2);
    expect(electronMocks.browserWindowInstance.webContents.setZoomFactor).toHaveBeenNthCalledWith(
      1,
      Math.pow(1.1, 2),
    );
    expect(electronMocks.browserWindowInstance.webContents.setZoomFactor).toHaveBeenNthCalledWith(
      2,
      Math.pow(1.1, 2),
    );
    expect(electronMocks.browserWindowInstance.setWindowButtonPosition).toHaveBeenCalledWith({
      x: 22,
      y: 30,
    });
    expect(electronMocks.browserWindowInstance.webContents.send).toHaveBeenCalledWith(
      PlatformChannels.WindowControlsOverlayChanged,
      { leftPaddingPx: 79 },
    );
  });

  it("Linux desktop window exposes transparent corners for the renderer shell", async () => {
    stubProcessPlatform("linux");

    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");

    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn: vi.fn() },
    });

    const windowOptions = electronMocks.browserWindowConstructor.mock.calls[0]?.[0];

    // The Linux shell is clipped by the renderer at 16px; the BrowserWindow must provide a transparent base so the
    // four corners can reveal the desktop.
    expect(windowOptions).toMatchObject({
      backgroundColor: "#00000000",
      transparent: true,
      frame: false,
      hasShadow: false,
      autoHideMenuBar: true,
    });
    expect(windowOptions).not.toHaveProperty("backgroundMaterial");
  });

  it("keeps Rewards navigation inside the trusted page boundary", async () => {
    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");
    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn: vi.fn() },
    });
    getWebContentsHandler("will-attach-webview")(
      { preventDefault: vi.fn() },
      {},
      { src: "https://zcode.z.ai/en/rewards?embedded=app" },
    );
    const guest = {
      on: vi.fn(),
      getURL: vi.fn(() => "about:blank"),
      setWindowOpenHandler: vi.fn(),
    };
    getWebContentsHandler("did-attach-webview")({}, guest);
    const navigate = guest.on.mock.calls.find(([event]) => event === "will-navigate")?.[1];
    const event = { preventDefault: vi.fn() };
    navigate(event, "https://zcode.z.ai/cn/rewards?embedded=app");
    expect(event.preventDefault).not.toHaveBeenCalled();
    navigate(event, "https://example.com/");
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(electronMocks.shellOpenExternal).toHaveBeenCalledWith("https://example.com/");
  });

  it("routes normal webview popup requests into an in-app browser tab", async () => {
    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");

    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn: vi.fn() },
    });

    const willAttach = getWebContentsHandler("will-attach-webview");
    const params: Record<string, string> = { src: "about:blank" };
    willAttach({ preventDefault: vi.fn() }, {}, params);

    expect(params.allowpopups).toBe("true");

    const guestWebContents = {
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
    const didAttach = getWebContentsHandler("did-attach-webview");
    didAttach({}, guestWebContents);

    const windowOpenHandler = guestWebContents.setWindowOpenHandler.mock.calls[0]?.[0];
    expect(windowOpenHandler).toBeTypeOf("function");

    const result = windowOpenHandler({
      disposition: "new-window",
      url: "https://example.com/docs",
    });

    expect(result).toEqual({ action: "deny" });
    expect(electronMocks.browserWindowInstance.webContents.send).toHaveBeenCalledWith(
      PlatformChannels.OpenBrowserUrl,
      {
        disposition: "new-window",
        url: "https://example.com/docs",
      },
    );
    expect(electronMocks.shellOpenExternal).not.toHaveBeenCalled();
  });

  it("opens unexpected navigation externally after Coding Plan enters PayPal", async () => {
    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");
    const warn = vi.fn();

    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn },
    });

    const guestWebContents = {
      getURL: vi.fn(() => "https://www.sandbox.paypal.com/checkoutnow?token=abc"),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
    getWebContentsHandler("did-attach-webview")({}, guestWebContents);

    const willNavigateHandler = guestWebContents.on.mock.calls.find(
      ([event]) => event === "will-navigate",
    )?.[1];
    expect(willNavigateHandler).toBeTypeOf("function");

    const event = { preventDefault: vi.fn() };
    willNavigateHandler(event, "https://evil.example/phishing");

    // Reason for the fix: the PayPal authorization page is still shown inside the Coding Plan purchase shell; leaving
    // the expected payment domain must open externally, otherwise a third-party page can masquerade as the in-app
    // upgrade flow with no way back for the user.
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(electronMocks.shellOpenExternal).toHaveBeenCalledWith("https://evil.example/phishing");
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("blocked unsupported coding-plan navigation url"),
    );
  });

  it("keeps guarding Coding Plan guests after a redirect lands outside the allowlist", async () => {
    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");

    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn: vi.fn() },
    });

    const willAttach = getWebContentsHandler("will-attach-webview");
    willAttach(
      { preventDefault: vi.fn() },
      {},
      { src: "https://zcode.z.ai/coding-plan?provider=zai&embedded=app" },
    );

    const guestWebContents = {
      getURL: vi.fn(() => "https://acs.bank.example/challenge"),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
    getWebContentsHandler("did-attach-webview")({}, guestWebContents);

    const willNavigateHandler = guestWebContents.on.mock.calls.find(
      ([event]) => event === "will-navigate",
    )?.[1];
    expect(willNavigateHandler).toBeTypeOf("function");

    const event = { preventDefault: vi.fn() };
    willNavigateHandler(event, "https://evil.example/followup");

    // Reason for the fix: a 30x redirect does not trigger will-navigate hop by hop; the current URL must not decide
    // whether the purchase session still applies.
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(electronMocks.shellOpenExternal).toHaveBeenCalledWith("https://evil.example/followup");
  });

  it("opens command-click webview popup requests in the system browser", async () => {
    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");

    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn: vi.fn() },
    });

    const guestWebContents = {
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
    getWebContentsHandler("did-attach-webview")({}, guestWebContents);

    const beforeInputHandler = guestWebContents.on.mock.calls.find(
      ([event]) => event === "before-input-event",
    )?.[1];
    expect(beforeInputHandler).toBeTypeOf("function");
    beforeInputHandler(
      {},
      {
        code: "MetaLeft",
        control: false,
        key: "Meta",
        meta: true,
        modifiers: ["cmd"],
        type: "keyDown",
      },
    );

    const windowOpenHandler = guestWebContents.setWindowOpenHandler.mock.calls[0]?.[0];
    const result = windowOpenHandler({
      disposition: "new-window",
      url: "https://example.com/docs",
    });

    expect(result).toEqual({ action: "deny" });
    expect(electronMocks.shellOpenExternal).toHaveBeenCalledWith("https://example.com/docs");
    expect(electronMocks.browserWindowInstance.webContents.send).not.toHaveBeenCalledWith(
      PlatformChannels.OpenBrowserUrl,
      expect.anything(),
    );

    electronMocks.shellOpenExternal.mockClear();
    electronMocks.browserWindowInstance.webContents.send.mockClear();
    beforeInputHandler(
      {},
      {
        code: "MetaLeft",
        control: false,
        key: "Meta",
        meta: true,
        modifiers: ["cmd"],
        type: "keyUp",
      },
    );

    const nextResult = windowOpenHandler({
      disposition: "new-window",
      url: "https://example.com/next",
    });

    expect(nextResult).toEqual({ action: "deny" });
    expect(electronMocks.shellOpenExternal).not.toHaveBeenCalled();
    expect(electronMocks.browserWindowInstance.webContents.send).toHaveBeenCalledWith(
      PlatformChannels.OpenBrowserUrl,
      {
        disposition: "new-window",
        url: "https://example.com/next",
      },
    );
  });

  it("blocks unsupported webview popup protocols", async () => {
    const logger = { warn: vi.fn() };
    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");

    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger,
    });

    const guestWebContents = {
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
    getWebContentsHandler("did-attach-webview")({}, guestWebContents);

    const windowOpenHandler = guestWebContents.setWindowOpenHandler.mock.calls[0]?.[0];
    const result = windowOpenHandler({
      disposition: "new-window",
      url: "file:///tmp/demo.html",
    });

    expect(result).toEqual({ action: "deny" });
    expect(logger.warn).toHaveBeenCalledWith(
      "[browser-pane] blocked unsupported webview popup url: file:///tmp/demo.html",
    );
    expect(electronMocks.browserWindowInstance.webContents.send).not.toHaveBeenCalledWith(
      PlatformChannels.OpenBrowserUrl,
      expect.anything(),
    );
    expect(electronMocks.shellOpenExternal).not.toHaveBeenCalled();
  });

  it("opens Coding Plan main-frame navigations outside the trusted purchase page externally", async () => {
    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");

    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn: vi.fn() },
    });

    const guestWebContents = {
      getURL: vi.fn(() => "https://zcode.z.ai/coding-plan?provider=zai&embedded=app"),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
    getWebContentsHandler("did-attach-webview")({}, guestWebContents);

    const willNavigateHandler = guestWebContents.on.mock.calls.find(
      ([event]) => event === "will-navigate",
    )?.[1];
    expect(willNavigateHandler).toBeTypeOf("function");

    const event = { preventDefault: vi.fn() };
    willNavigateHandler(event, "https://pay.example/checkout");

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(electronMocks.shellOpenExternal).toHaveBeenCalledWith("https://pay.example/checkout");
  });

  it("keeps Coding Plan PayPal main-frame navigations inside the current webview", async () => {
    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");

    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn: vi.fn() },
    });

    const guestWebContents = {
      getURL: vi.fn(() => "https://zcode.z.ai/coding-plan?provider=zai&embedded=app"),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
    getWebContentsHandler("did-attach-webview")({}, guestWebContents);

    const willNavigateHandler = guestWebContents.on.mock.calls.find(
      ([event]) => event === "will-navigate",
    )?.[1];
    expect(willNavigateHandler).toBeTypeOf("function");

    const event = { preventDefault: vi.fn() };
    willNavigateHandler(
      event,
      "https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-123",
    );

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(electronMocks.shellOpenExternal).not.toHaveBeenCalled();
  });

  it("opens Coding Plan PayPal lookalike domains externally", async () => {
    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");

    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn: vi.fn() },
    });

    const guestWebContents = {
      getURL: vi.fn(() => "https://zcode.z.ai/coding-plan?provider=zai&embedded=app"),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
    getWebContentsHandler("did-attach-webview")({}, guestWebContents);

    const willNavigateHandler = guestWebContents.on.mock.calls.find(
      ([event]) => event === "will-navigate",
    )?.[1];
    expect(willNavigateHandler).toBeTypeOf("function");

    const event = { preventDefault: vi.fn() };
    willNavigateHandler(event, "https://www.sandbox.paypal.com.evil.example/checkout");

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(electronMocks.shellOpenExternal).toHaveBeenCalledWith(
      "https://www.sandbox.paypal.com.evil.example/checkout",
    );
  });

  it("keeps Coding Plan Z.AI PayPal relay navigations inside the current webview", async () => {
    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");

    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn: vi.fn() },
    });

    const guestWebContents = {
      getURL: vi.fn(() => "https://zcode.z.ai/coding-plan?provider=zai&embedded=app"),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
    getWebContentsHandler("did-attach-webview")({}, guestWebContents);

    const willNavigateHandler = guestWebContents.on.mock.calls.find(
      ([event]) => event === "will-navigate",
    )?.[1];
    expect(willNavigateHandler).toBeTypeOf("function");

    const event = { preventDefault: vi.fn() };
    willNavigateHandler(event, "https://api.z.ai/api/pay/paypal/approve?token=setup-1");

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(electronMocks.shellOpenExternal).not.toHaveBeenCalled();
  });

  it("keeps Coding Plan PayPal callback navigations inside the current webview", async () => {
    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");

    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn: vi.fn() },
    });

    const guestWebContents = {
      getURL: vi.fn(() => "https://www.sandbox.paypal.com/pay/billing?token=BA-123"),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
    getWebContentsHandler("did-attach-webview")({}, guestWebContents);

    const willNavigateHandler = guestWebContents.on.mock.calls.find(
      ([event]) => event === "will-navigate",
    )?.[1];
    expect(willNavigateHandler).toBeTypeOf("function");

    const returnTo = encodeURIComponent(
      "/coding-plan?provider=zai&embedded=app&lang=cn&theme=zai-dark",
    );
    const callbackUrl = `http://localhost:3000/coding-plan/payment/callback?channel=paypal&status=return&returnTo=${returnTo}&approval_token_id=setup-1`;
    const event = { preventDefault: vi.fn() };
    willNavigateHandler(event, callbackUrl);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(electronMocks.shellOpenExternal).not.toHaveBeenCalled();
  });

  it("opens cross-origin Coding Plan PayPal callback navigations externally", async () => {
    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");

    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn: vi.fn() },
    });

    const guestWebContents = {
      getURL: vi.fn(() => "https://www.sandbox.paypal.com/pay/billing?token=BA-123"),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
    getWebContentsHandler("did-attach-webview")({}, guestWebContents);

    const willNavigateHandler = guestWebContents.on.mock.calls.find(
      ([event]) => event === "will-navigate",
    )?.[1];
    expect(willNavigateHandler).toBeTypeOf("function");

    // If returnTo is cross-origin with the callback page it must open externally; a neutral domain expresses the
    // "different origin" without depending on the test-environment domain (the open-source export rewrites test
    // domains to production domains, which would make the callback and returnTo same-origin).
    const returnTo = encodeURIComponent(
      "https://other-origin.example/coding-plan?provider=zai&embedded=app",
    );
    const callbackUrl = `https://zcode.z.ai/coding-plan/payment/callback?channel=paypal&status=return&returnTo=${returnTo}`;
    const event = { preventDefault: vi.fn() };
    willNavigateHandler(event, callbackUrl);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(electronMocks.shellOpenExternal).toHaveBeenCalledWith(callbackUrl);
  });

  it("loads Coding Plan PayPal popup requests in the current webview", async () => {
    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");

    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn: vi.fn() },
    });

    const guestWebContents = {
      getURL: vi.fn(() => "https://zcode.z.ai/coding-plan?provider=zai&embedded=app"),
      loadURL: vi.fn(() => Promise.resolve()),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
    getWebContentsHandler("did-attach-webview")({}, guestWebContents);

    const windowOpenHandler = guestWebContents.setWindowOpenHandler.mock.calls[0]?.[0];
    expect(windowOpenHandler).toBeTypeOf("function");

    const result = windowOpenHandler({
      disposition: "new-window",
      url: "https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-123",
    });

    expect(result).toEqual({ action: "deny" });
    expect(guestWebContents.loadURL).toHaveBeenCalledWith(
      "https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-123",
    );
    expect(electronMocks.shellOpenExternal).not.toHaveBeenCalled();
    expect(electronMocks.browserWindowInstance.webContents.send).not.toHaveBeenCalledWith(
      PlatformChannels.OpenBrowserUrl,
      expect.anything(),
    );
  });

  it("loads Coding Plan localhost callback popup requests in the current webview", async () => {
    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");

    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn: vi.fn() },
    });

    const guestWebContents = {
      getURL: vi.fn(() => "https://www.sandbox.paypal.com/agreements/approve"),
      loadURL: vi.fn(() => Promise.resolve()),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
    getWebContentsHandler("did-attach-webview")({}, guestWebContents);

    const windowOpenHandler = guestWebContents.setWindowOpenHandler.mock.calls[0]?.[0];
    expect(windowOpenHandler).toBeTypeOf("function");

    const callbackUrl =
      "http://localhost:3000/coding-plan?provider=zai&embedded=app&lang=cn&theme=zai-dark";
    const result = windowOpenHandler({
      disposition: "new-window",
      url: callbackUrl,
    });

    expect(result).toEqual({ action: "deny" });
    expect(guestWebContents.loadURL).toHaveBeenCalledWith(callbackUrl);
    expect(electronMocks.shellOpenExternal).not.toHaveBeenCalled();
    expect(electronMocks.browserWindowInstance.webContents.send).not.toHaveBeenCalledWith(
      PlatformChannels.OpenBrowserUrl,
      expect.anything(),
    );
  });

  it("loads Coding Plan Z.AI PayPal relay popup requests in the current webview", async () => {
    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");

    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn: vi.fn() },
    });

    const guestWebContents = {
      getURL: vi.fn(() => "https://zcode.z.ai/coding-plan?provider=zai&embedded=app"),
      loadURL: vi.fn(() => Promise.resolve()),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
    getWebContentsHandler("did-attach-webview")({}, guestWebContents);

    const windowOpenHandler = guestWebContents.setWindowOpenHandler.mock.calls[0]?.[0];
    expect(windowOpenHandler).toBeTypeOf("function");

    const result = windowOpenHandler({
      disposition: "new-window",
      url: "https://api.z.ai/api/pay/paypal/approve?token=setup-1",
    });

    expect(result).toEqual({ action: "deny" });
    expect(guestWebContents.loadURL).toHaveBeenCalledWith(
      "https://api.z.ai/api/pay/paypal/approve?token=setup-1",
    );
    expect(electronMocks.shellOpenExternal).not.toHaveBeenCalled();
    expect(electronMocks.browserWindowInstance.webContents.send).not.toHaveBeenCalledWith(
      PlatformChannels.OpenBrowserUrl,
      expect.anything(),
    );
  });

  it("uses the current application locale for the editable text context menu", async () => {
    let locale: "zh-CN" | "en-US" = "zh-CN";
    const { createBrowserWindow } = await import("../src/main/desktopWindowChrome.js");

    createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn: vi.fn() },
      currentApplicationLocale: () => locale,
    });

    const contextMenuHandler = getWebContentsHandler("context-menu");
    const params = {
      isEditable: true,
      selectionText: "",
      editFlags: {
        canUndo: true,
        canRedo: false,
        canCut: true,
        canCopy: true,
        canPaste: false,
        canDelete: true,
        canSelectAll: true,
      },
    };

    contextMenuHandler({}, params);
    let template = electronMocks.menuBuildFromTemplate.mock.calls.at(
      -1,
    )?.[0] as Electron.MenuItemConstructorOptions[];
    expect(template.filter((item) => item.role).map((item) => item.label)).toEqual([
      "撤销",
      "重做",
      "剪切",
      "复制",
      "粘贴",
      "删除",
      "全选",
    ]);
    expect(template[0]).toMatchObject({ role: "undo", enabled: true });
    expect(template[1]).toMatchObject({ role: "redo", enabled: false });
    expect(template[5]).toMatchObject({ role: "paste", enabled: false });

    locale = "en-US";
    contextMenuHandler({}, params);
    template = electronMocks.menuBuildFromTemplate.mock.calls.at(
      -1,
    )?.[0] as Electron.MenuItemConstructorOptions[];
    expect(template.filter((item) => item.role).map((item) => item.label)).toEqual([
      "Undo",
      "Redo",
      "Cut",
      "Copy",
      "Paste",
      "Delete",
      "Select all",
    ]);
    expect(template[8]).toMatchObject({ role: "selectAll", enabled: true });
  });
  // After the DEV badge was removed, applyAppIcon only takes an icon path (it previously additionally accepted a
  // NativeImage for the badge's in-memory image); the case was updated accordingly to verify loading by path and
  // setting the Dock icon.
  it("applyAppIcon 在 darwin 下按路径加载图标并设置 Dock 图标", async () => {
    stubProcessPlatform("darwin");
    const setIcon = vi.fn();
    electronMocks.app.dock = { setIcon };
    const dockImage = { isEmpty: () => false };
    electronMocks.nativeImageCreateFromPath.mockReturnValueOnce(dockImage);
    const { applyAppIcon } = await import("../src/main/desktopWindowChrome.js");
    applyAppIcon("icon.png");
    expect(electronMocks.nativeImageCreateFromPath).toHaveBeenLastCalledWith("icon.png");
    expect(setIcon).toHaveBeenCalledWith(dockImage);
  });
});

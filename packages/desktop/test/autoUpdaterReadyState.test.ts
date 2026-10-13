import { EventEmitter } from "node:events";
import { PlatformChannels, desktopMenuMessageIds, formatDesktopMenuMessage } from "@zcode/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loggerErrorMock, loggerInfoMock, loggerWarnMock, readFileMock, spawnMock } = vi.hoisted(
  () => {
    return {
      loggerErrorMock: vi.fn(),
      loggerInfoMock: vi.fn(),
      loggerWarnMock: vi.fn(),
      readFileMock: vi.fn(),
      spawnMock: vi.fn(),
    };
  },
);

const originalPlatform = process.platform;

const ONE_HOUR_MS = 60 * 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const TWO_MINUTES_MS = 2 * 60 * 1000;

const TEST_LOCALE = "en-US" as const;

const menuItem = {
  label: "",
  enabled: true,
};

const browserWindows: Array<{
  isDestroyed: () => boolean;
  webContents: {
    id: number;
    send: ReturnType<typeof vi.fn>;
  };
}> = [];

const ipcMainOn = vi.fn();
const ipcMainHandle = vi.fn();
const dialogShowMessageBox = vi.fn(async () => ({ response: 1 }));
const settingServiceMock = {
  get: vi.fn(async () => ({ recentProjects: [], locale: "en-US" as const })),
  update: vi.fn(async () => {}),
};

const appListeners = new Map<string, Array<(...args: unknown[]) => void>>();
const appMock = {
  isPackaged: true,
  getVersion: vi.fn(() => "0.1.24"),
  getAppPath: vi.fn(() => "/tmp/zcode-app"),
  relaunch: vi.fn(),
  exit: vi.fn(),
  on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
    const listeners = appListeners.get(event) ?? [];
    listeners.push(listener);
    appListeners.set(event, listeners);
  }),
};

const autoUpdaterMock = new EventEmitter() as EventEmitter & {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  logger: unknown;
  checkForUpdates: ReturnType<typeof vi.fn>;
  downloadUpdate: ReturnType<typeof vi.fn>;
  quitAndInstall: ReturnType<typeof vi.fn>;
  setFeedURL: ReturnType<typeof vi.fn>;
  forceDevUpdateConfig: boolean;
  currentVersion: { format(): string } | null;
  installerPath: string | null;
  autoRunAppAfterInstall: boolean;
  installDirectory: string | null;
  downloadedUpdateHelper: {
    downloadedFileInfo?: { isAdminRightsRequired?: boolean } | null;
    packageFile?: string | null;
  } | null;
};

autoUpdaterMock.autoDownload = false;
autoUpdaterMock.autoInstallOnAppQuit = false;
autoUpdaterMock.checkForUpdates = vi.fn(() => Promise.resolve());
autoUpdaterMock.downloadUpdate = vi.fn(() => Promise.resolve([]));
autoUpdaterMock.quitAndInstall = vi.fn();
autoUpdaterMock.setFeedURL = vi.fn();
autoUpdaterMock.forceDevUpdateConfig = false;
autoUpdaterMock.currentVersion = null;
autoUpdaterMock.installerPath =
  "C:\\Users\\demo\\AppData\\Local\\zcode-updater\\pending\\ZCode-0.1.25-win-x64.exe";
autoUpdaterMock.autoRunAppAfterInstall = true;
autoUpdaterMock.installDirectory = null;
autoUpdaterMock.downloadedUpdateHelper = null;

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("electron", () => ({
  app: appMock,
  BrowserWindow: {
    getAllWindows: vi.fn(() => browserWindows),
  },
  ipcMain: {
    on: ipcMainOn,
    handle: ipcMainHandle,
  },
  dialog: {
    showMessageBox: dialogShowMessageBox,
  },
  Menu: {
    getApplicationMenu: vi.fn(() => ({
      getMenuItemById: vi.fn(() => menuItem),
    })),
  },
}));

vi.mock("electron-updater", () => {
  class CancellationTokenMock {
    cancelled = false;
    private cancelListeners: Array<() => void> = [];

    cancel() {
      this.cancelled = true;
      const listeners = this.cancelListeners;
      this.cancelListeners = [];
      for (const listener of listeners) {
        listener();
      }
    }

    once(event: string, listener: () => void) {
      if (event === "cancel") {
        this.cancelListeners.push(listener);
      }
      return this;
    }

    dispose() {
      this.cancelListeners = [];
    }
  }

  class ProviderMock {
    constructor() {}
    get isUseMultipleRangeRequest() {
      return false;
    }
    setRequestHeaders() {}
  }

  return {
    CancellationToken: CancellationTokenMock,
    Provider: ProviderMock,
    default: {
      autoUpdater: autoUpdaterMock,
    },
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: readFileMock,
}));

// Bugfix: this previously hard-coded the module path as a developer-machine absolute path, so running the
// unit test on another machine could not find the module at all.
// After switching to an import relative to the test file, macOS / Linux / Windows all resolve correctly
// against the current workspace.
vi.mock("../src/main/logger.js", () => ({
  logger: {
    info: loggerInfoMock,
    warn: loggerWarnMock,
    error: loggerErrorMock,
  },
}));

async function importAutoUpdaterWithLocale() {
  const module = await import("../src/main/autoUpdater.js");
  module.setAutoUpdaterMenuLocale(TEST_LOCALE);
  return module;
}

function mockProcessPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

function getExpectedDownloadingProgressLabel(progress: number) {
  return formatDesktopMenuMessage(
    TEST_LOCALE,
    desktopMenuMessageIds.helpDownloadingUpdateProgress,
    {
      progress,
    },
  );
}

describe("autoUpdater ready state sync", () => {
  beforeEach(() => {
    vi.resetModules();
    mockProcessPlatform(originalPlatform);
    browserWindows.length = 0;
    menuItem.label = "";
    menuItem.enabled = true;
    ipcMainOn.mockClear();
    ipcMainHandle.mockClear();
    spawnMock.mockClear();
    loggerInfoMock.mockClear();
    loggerWarnMock.mockClear();
    loggerErrorMock.mockClear();
    dialogShowMessageBox.mockClear();
    dialogShowMessageBox.mockResolvedValue({ response: 1 });
    appMock.getVersion.mockClear();
    appMock.relaunch.mockClear();
    appMock.exit.mockClear();
    autoUpdaterMock.removeAllListeners();
    autoUpdaterMock.autoDownload = false;
    autoUpdaterMock.autoInstallOnAppQuit = false;
    autoUpdaterMock.checkForUpdates.mockClear();
    autoUpdaterMock.downloadUpdate.mockClear();
    autoUpdaterMock.quitAndInstall.mockClear();
    autoUpdaterMock.setFeedURL.mockClear();
    autoUpdaterMock.forceDevUpdateConfig = false;
    autoUpdaterMock.currentVersion = null;
    autoUpdaterMock.installerPath =
      "C:\\Users\\demo\\AppData\\Local\\zcode-updater\\pending\\ZCode-0.1.25-win-x64.exe";
    autoUpdaterMock.autoRunAppAfterInstall = true;
    autoUpdaterMock.installDirectory = null;
    autoUpdaterMock.downloadedUpdateHelper = null;
    settingServiceMock.get.mockClear();
    settingServiceMock.get.mockResolvedValue({
      recentProjects: [],
      locale: "en-US",
    });
    settingServiceMock.update.mockClear();
    appListeners.clear();
    appMock.getVersion.mockImplementation(() => "0.1.24");
    appMock.getAppPath.mockClear();
    appMock.getAppPath.mockReturnValue("/tmp/zcode-app");
    appMock.isPackaged = true;
    Object.defineProperty(process, "resourcesPath", {
      value: "/tmp/zcode-resources",
      configurable: true,
    });
    delete process.env["TEST_UPDATER_ARCH"];
    delete process.env["ZCODE_UPDATE_FEED_URL"];
    delete process.env["ZCODE_AUTO_UPDATE_DEV"];
    delete process.env["ZCODE_AUTO_UPDATE_DEV_VERSION"];
    readFileMock.mockReset();
    readFileMock.mockRejectedValue(new Error("missing update config"));
  });

  it("Preview 禁用更新器时不注册 IPC、事件或启动检查", async () => {
    const { initAutoUpdater } = await import("../src/main/autoUpdater.js");

    await initAutoUpdater({ enabled: false });

    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    expect(ipcMainOn).not.toHaveBeenCalled();
    expect(autoUpdaterMock.listenerCount("checking-for-update")).toBe(0);
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "[auto-update] disabled for this desktop product flavor",
    );
  });

  it("Preview 禁用更新器后，漏改的手动检查入口也不能触碰未初始化的 updater", async () => {
    // Bugfix: if the tray/command entry still let requests through based on ZCODE_ENV, it would send a real
    // checkForUpdates against the placeholder feed; the disabled semantics must fail closed inside the
    // autoUpdater module instead of relying on each call site to judge for itself.
    const win = {
      isDestroyed: () => false,
      webContents: {
        id: 9,
        send: vi.fn(),
      },
    };
    browserWindows.push(win);

    const { initAutoUpdater, checkForUpdateMenuClick } = await import("../src/main/autoUpdater.js");

    await initAutoUpdater({ enabled: false });
    checkForUpdateMenuClick(win as never);
    await Promise.resolve();

    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalled();
    expect(win.webContents.send).toHaveBeenCalledWith(PlatformChannels.UpdateCheckResult, {
      kind: "dev-skipped",
    });
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "[auto-update] skip manual check: updater disabled for this product flavor",
    );
  });

  it("Linux arm64 主更新检查默认使用服务端 manifest provider", async () => {
    mockProcessPlatform("linux");
    process.env["TEST_UPDATER_ARCH"] = "arm64";

    const { initAutoUpdater } = await import("../src/main/autoUpdater.js");
    initAutoUpdater();

    expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "custom",
        releasePlatform: "linux-aarch64",
      }),
    );
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("开发态默认不初始化自动更新", async () => {
    appMock.isPackaged = false;

    const { initAutoUpdater } = await import("../src/main/autoUpdater.js");
    await initAutoUpdater();

    expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalled();
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    expect(autoUpdaterMock.forceDevUpdateConfig).toBe(false);
  });

  it("显式开启开发态自动更新时会覆盖本地版本并发起检查", async () => {
    appMock.isPackaged = false;
    appMock.getVersion.mockReturnValue("1.0.0");
    process.env["ZCODE_AUTO_UPDATE_DEV"] = "1";
    process.env["ZCODE_AUTO_UPDATE_DEV_VERSION"] = "3.3.1";

    const { initAutoUpdater } = await import("../src/main/autoUpdater.js");
    await initAutoUpdater();

    expect(autoUpdaterMock.forceDevUpdateConfig).toBe(true);
    expect(autoUpdaterMock.currentVersion?.format()).toBe("3.3.1");
    expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "custom",
      }),
    );
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(loggerInfoMock).toHaveBeenCalledWith("[auto-update] dev update enabled version=3.3.1");
  });

  it("服务端 manifest provider 会按设置选择 stable 或 preview 通道", async () => {
    settingServiceMock.get.mockResolvedValue({
      recentProjects: [],
      locale: "en-US",
      receivePreviewUpdates: true,
    });
    const { initAutoUpdater } = await import("../src/main/autoUpdater.js");

    initAutoUpdater({
      settingService: settingServiceMock,
      deviceMid: "mid-1",
      resolveEndpointOrigin: () => "https://endpoint.example.test",
    });

    const options = autoUpdaterMock.setFeedURL.mock.calls[0]?.[0] as {
      deviceMid?: string;
      resolveEndpointOrigin?: () => string | Promise<string>;
      resolveReleaseChannel?: () => Promise<string>;
    };
    expect(options.deviceMid).toBe("mid-1");
    await expect(Promise.resolve(options.resolveEndpointOrigin?.())).resolves.toBe(
      "https://endpoint.example.test",
    );
    await expect(options.resolveReleaseChannel?.()).resolves.toBe("preview");
  });

  it("preview 冷启动检查不会把合法 preview 更新误判为 stale", async () => {
    settingServiceMock.get.mockResolvedValue({
      recentProjects: [],
      locale: "en-US",
      receivePreviewUpdates: true,
    });
    const { getAutoUpdaterState, initAutoUpdater } = await import("../src/main/autoUpdater.js");

    initAutoUpdater({
      settingService: settingServiceMock,
      deviceMid: "mid-preview",
      resolveEndpointOrigin: () => "https://endpoint.example.test",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);

    autoUpdaterMock.emit("update-available", {
      version: "3.3.3",
      zcodeReleaseChannel: "preview",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Bugfix: on a cold start the provider has not resolved the release channel ahead of time, so the begin
    // phase must not keep using the default stable as the expected channel, otherwise a legitimate preview
    // manifest would be dropped by shouldIgnoreStaleAvailableUpdate.
    expect(getAutoUpdaterState()).toMatchObject({
      kind: "update-available",
      version: "3.3.3",
      channel: "preview",
    });
  });

  it("关闭接收 preview 后会重新检查 stable manifest 并更新可用版本状态", async () => {
    const win = {
      isDestroyed: () => false,
      webContents: {
        id: 18,
        send: vi.fn(),
      },
    };
    browserWindows.push(win);
    settingServiceMock.get.mockResolvedValue({
      recentProjects: [],
      locale: "en-US",
      receivePreviewUpdates: true,
    });
    const { getAutoUpdaterState, initAutoUpdater, refreshAutoUpdaterReleaseChannel } =
      await import("../src/main/autoUpdater.js");

    initAutoUpdater({ settingService: settingServiceMock });
    const options = autoUpdaterMock.setFeedURL.mock.calls[0]?.[0] as {
      resolveReleaseChannel?: () => Promise<string>;
    };
    await expect(options.resolveReleaseChannel?.()).resolves.toBe("preview");
    await Promise.resolve();
    await Promise.resolve();

    autoUpdaterMock.emit("update-available", { version: "3.3.3" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getAutoUpdaterState()).toMatchObject({
      kind: "update-available",
      version: "3.3.3",
      channel: "preview",
    });

    settingServiceMock.get.mockResolvedValue({
      recentProjects: [],
      locale: "en-US",
      receivePreviewUpdates: false,
    });
    refreshAutoUpdaterReleaseChannel(false, "test preview setting changed");

    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(getAutoUpdaterState()).toMatchObject({
      kind: "checking",
      enabled: false,
    });

    await expect(options.resolveReleaseChannel?.()).resolves.toBe("stable");
    autoUpdaterMock.emit("update-available", { version: "3.3.2" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getAutoUpdaterState()).toMatchObject({
      kind: "update-available",
      version: "3.3.2",
      channel: "stable",
    });
    expect(win.webContents.send).toHaveBeenCalledWith(
      PlatformChannels.UpdateStateChanged,
      expect.objectContaining({
        kind: "update-available",
        version: "3.3.2",
        channel: "stable",
      }),
    );
  });

  it("切换到 preview 后会忽略晚到的 stable manifest 结果", async () => {
    const win = {
      isDestroyed: () => false,
      webContents: {
        id: 19,
        send: vi.fn(),
      },
    };
    browserWindows.push(win);
    settingServiceMock.get.mockResolvedValue({
      recentProjects: [],
      locale: "en-US",
      receivePreviewUpdates: false,
    });
    const { getAutoUpdaterState, initAutoUpdater, refreshAutoUpdaterReleaseChannel } =
      await import("../src/main/autoUpdater.js");

    initAutoUpdater({ settingService: settingServiceMock });
    autoUpdaterMock.emit("checking-for-update");
    autoUpdaterMock.emit("update-available", {
      version: "3.3.4",
      zcodeReleaseChannel: "stable",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getAutoUpdaterState()).toMatchObject({
      kind: "update-available",
      version: "3.3.4",
      channel: "stable",
    });

    settingServiceMock.get.mockResolvedValue({
      recentProjects: [],
      locale: "en-US",
      receivePreviewUpdates: true,
    });
    refreshAutoUpdaterReleaseChannel(true, "test preview setting changed");

    expect(getAutoUpdaterState()).toMatchObject({
      kind: "checking",
      enabled: false,
    });

    autoUpdaterMock.emit("update-available", {
      version: "3.3.4",
      zcodeReleaseChannel: "stable",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getAutoUpdaterState()).toMatchObject({
      kind: "checking",
      enabled: false,
    });

    autoUpdaterMock.emit("update-available", {
      version: "3.3.5",
      zcodeReleaseChannel: "preview",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getAutoUpdaterState()).toMatchObject({
      kind: "update-available",
      version: "3.3.5",
      channel: "preview",
    });
    expect(win.webContents.send).toHaveBeenCalledWith(
      PlatformChannels.UpdateStateChanged,
      expect.objectContaining({
        kind: "update-available",
        version: "3.3.5",
        channel: "preview",
      }),
    );
  });

  it("update-available 异步处理完成前切换通道会延后到当前 generation 收口", async () => {
    let resolveSettings:
      | ((settings: Awaited<ReturnType<typeof settingServiceMock.get>>) => void)
      | undefined;
    const pendingSettings = new Promise<Awaited<ReturnType<typeof settingServiceMock.get>>>(
      (resolve) => {
        resolveSettings = resolve;
      },
    );
    settingServiceMock.get.mockReturnValue(pendingSettings);
    const { getAutoUpdaterState, initAutoUpdater, refreshAutoUpdaterReleaseChannel } =
      await import("../src/main/autoUpdater.js");

    initAutoUpdater({ settingService: settingServiceMock });
    autoUpdaterMock.emit("checking-for-update");
    autoUpdaterMock.emit("update-available", {
      version: "3.3.4",
      zcodeReleaseChannel: "stable",
    });
    await Promise.resolve();
    await Promise.resolve();

    refreshAutoUpdaterReleaseChannel(true, "test preview setting changed");

    // Bugfix: with a settingService, the startup check warms the channel first before actually requesting from
    // the provider. During the pending-settings phase it is still in-flight; the channel switch must be
    // deferred, but no request has gone out yet.
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
    expect(getAutoUpdaterState()).toMatchObject({
      kind: "checking",
      enabled: false,
    });

    resolveSettings?.({
      recentProjects: [],
      locale: "en-US",
      receivePreviewUpdates: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(getAutoUpdaterState()).toMatchObject({
      kind: "checking",
      enabled: false,
    });
  });

  it("冷启动恢复待安装说明后同版本 manifest 仍会重新下载以重建 macOS staging", async () => {
    mockProcessPlatform("darwin");
    appMock.getVersion.mockReturnValue("3.5.0");
    const pendingReleaseNotes = {
      version: "3.6.4",
      title: "Release v3.6.4",
      markdown: "## Fixes",
      releaseDate: "2026-07-30T16:56:00.356Z",
    };
    settingServiceMock.get.mockResolvedValue({
      recentProjects: [],
      locale: "en-US",
      autoDownloadAndInstallUpdates: true,
      pendingPostUpdateReleaseNotes: pendingReleaseNotes,
    });
    const { getAutoUpdaterState, hydratePendingPostUpdateReleaseNotes, initAutoUpdater } =
      await import("../src/main/autoUpdater.js");

    await hydratePendingPostUpdateReleaseNotes(settingServiceMock);
    await initAutoUpdater({ settingService: settingServiceMock });
    await Promise.resolve();

    autoUpdaterMock.emit("update-available", {
      version: "3.6.4",
      zcodeReleaseChannel: "stable",
      releaseName: "Release v3.6.4",
      releaseNotes: "## Fixes",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Bugfix: pendingPostUpdateReleaseNotes can only restore the display copy; it cannot prove that this
    // process's electron-updater / Squirrel.Mac has rebuilt the native staging. On a same-version manifest it
    // must still go through downloadUpdate again, letting the update-downloaded event after a cache hit or a
    // fresh download bring back the real installable state.
    expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(getAutoUpdaterState()).toMatchObject({
      kind: "update-available",
      version: "3.6.4",
      channel: "stable",
    });
  });

  it("冷启动恢复的待安装状态被点击时不会执行退出准备而是重新 staging", async () => {
    mockProcessPlatform("darwin");
    appMock.getVersion.mockReturnValue("3.5.0");
    const onBeforeQuitAndInstall = vi.fn();
    settingServiceMock.get.mockResolvedValue({
      recentProjects: [],
      locale: "en-US",
      autoDownloadAndInstallUpdates: true,
      pendingPostUpdateReleaseNotes: {
        version: "3.6.4",
        title: "Release v3.6.4",
        markdown: "## Fixes",
      },
    });
    const { getAutoUpdaterState, hydratePendingPostUpdateReleaseNotes, initAutoUpdater } =
      await import("../src/main/autoUpdater.js");

    await hydratePendingPostUpdateReleaseNotes(settingServiceMock);
    await initAutoUpdater({
      settingService: settingServiceMock,
      onBeforeQuitAndInstall,
    });

    const quitAndInstallHandler = ipcMainHandle.mock.calls.find(
      ([channel]: [string, unknown]) => channel === PlatformChannels.QuitAndInstallUpdate,
    )?.[1] as (() => Promise<void>) | undefined;
    await quitAndInstallHandler?.();

    // Bugfix: a ready state restored from pending release notes has no in-process Squirrel.Mac staging
    // context and must not run quit preparation. When the user clicks, it should first revert to a
    // downloadable update and downloadUpdate again, allowing install only after a real update-downloaded.
    expect(onBeforeQuitAndInstall).not.toHaveBeenCalled();
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(getAutoUpdaterState()).toMatchObject({
      kind: "update-available",
      version: "3.6.4",
      channel: "stable",
    });
  });

  it("晚到的旧通道结果不会结束当前通道的检查 generation", async () => {
    const { getAutoUpdaterState, initAutoUpdater, refreshAutoUpdaterReleaseChannel } =
      await import("../src/main/autoUpdater.js");

    initAutoUpdater({ settingService: settingServiceMock });
    autoUpdaterMock.emit("update-not-available", { version: "0.1.24" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const previewCheckPromise = new Promise<void>(() => {});
    autoUpdaterMock.checkForUpdates.mockImplementationOnce(() => previewCheckPromise);
    refreshAutoUpdaterReleaseChannel(true, "test preview setting changed");

    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(getAutoUpdaterState()).toMatchObject({
      kind: "checking",
      enabled: false,
    });

    autoUpdaterMock.emit("update-available", {
      version: "3.3.4",
      zcodeReleaseChannel: "stable",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    refreshAutoUpdaterReleaseChannel(false, "test stable setting changed");

    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(getAutoUpdaterState()).toMatchObject({
      kind: "checking",
      enabled: false,
    });

    autoUpdaterMock.emit("update-available", {
      version: "3.3.5",
      zcodeReleaseChannel: "preview",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(3);
    expect(getAutoUpdaterState()).toMatchObject({
      kind: "checking",
      enabled: false,
    });
  });

  it("启动参数中的 update feed URL 优先于环境变量", async () => {
    const { resolveUpdateFeedSourceFromStartupConfig } = await import("../src/main/autoUpdater.js");

    expect(
      resolveUpdateFeedSourceFromStartupConfig({
        argv: [
          "ZCode",
          "--zcode-update-feed-url",
          "https://arg.example.test/api/v1/releases/electron/manifest",
        ],
        env: {
          ZCODE_UPDATE_FEED_URL: "https://env.example.test/api/v1/releases/electron/manifest",
        },
      }),
    ).toEqual({
      url: "https://arg.example.test/api/v1/releases/electron/manifest",
    });
    expect(
      resolveUpdateFeedSourceFromStartupConfig({
        argv: [
          "ZCode",
          "--zcode-update-feed-url=https://equals.example.test/api/v1/releases/electron/manifest",
        ],
        env: {},
      }),
    ).toEqual({
      url: "https://equals.example.test/api/v1/releases/electron/manifest",
    });
    expect(
      resolveUpdateFeedSourceFromStartupConfig({
        argv: ["ZCode"],
        env: {
          ZCODE_UPDATE_FEED_URL: "https://env.example.test/api/v1/releases/electron/manifest",
        },
      }),
    ).toEqual({
      url: "https://env.example.test/api/v1/releases/electron/manifest",
    });
  });

  it("启动时可覆盖服务端 manifest 接口 URL", async () => {
    mockProcessPlatform("darwin");
    process.env["TEST_UPDATER_ARCH"] = "arm64";
    const { initAutoUpdater } = await import("../src/main/autoUpdater.js");

    initAutoUpdater({
      updateFeedSource: {
        url: "https://zcode.z.ai/api/v1/releases/electron/manifest?platform=old&channel=1",
      },
    });

    expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "custom",
        manifestUrl: "https://zcode.z.ai/api/v1/releases/electron/manifest?platform=old&channel=1",
        releasePlatform: "darwin-aarch64",
      }),
    );
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("manifest URL 覆盖不会切换到 generic feed", async () => {
    mockProcessPlatform("darwin");
    process.env["TEST_UPDATER_ARCH"] = "arm64";
    const { initAutoUpdater } = await import("../src/main/autoUpdater.js");
    initAutoUpdater({
      updateFeedSource: {
        url: "https://runtime.example.test/api/v1/releases/electron/manifest",
      },
    });

    expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "custom",
        manifestUrl: "https://runtime.example.test/api/v1/releases/electron/manifest",
      }),
    );
    expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalledWith(
      expect.objectContaining({ provider: "generic" }),
    );
  });

  it("下载完成后会缓存版本，并补发给后续窗口", async () => {
    const firstWindow = {
      isDestroyed: () => false,
      webContents: {
        id: 1,
        send: vi.fn(),
      },
    };
    browserWindows.push(firstWindow);

    const { initAutoUpdater, syncReadyUpdateToWindow } = await import("../src/main/autoUpdater.js");

    initAutoUpdater();
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);

    autoUpdaterMock.emit("update-downloaded", { version: "0.1.25" });

    expect(firstWindow.webContents.send).toHaveBeenCalledWith(
      PlatformChannels.UpdateReady,
      "0.1.25",
    );

    const laterWindow = {
      isDestroyed: () => false,
      webContents: {
        id: 2,
        send: vi.fn(),
      },
    };

    syncReadyUpdateToWindow(laterWindow);

    expect(laterWindow.webContents.send).toHaveBeenCalledWith(
      PlatformChannels.UpdateReady,
      "0.1.25",
    );
  });

  it("下载完成后 updater 报错会清理 ready 状态", async () => {
    const win = {
      isDestroyed: () => false,
      webContents: {
        id: 5,
        send: vi.fn(),
      },
    };
    browserWindows.push(win);

    const { initAutoUpdater, syncReadyUpdateToWindow } = await importAutoUpdaterWithLocale();

    initAutoUpdater();
    autoUpdaterMock.emit("update-downloaded", { version: "0.1.25" });

    expect(menuItem.label).toBe(
      formatDesktopMenuMessage(TEST_LOCALE, desktopMenuMessageIds.helpRestartToUpdate, {
        version: "0.1.25",
      }),
    );

    win.webContents.send.mockClear();
    autoUpdaterMock.emit(
      "error",
      new Error("Could not locate update bundle for com.github.Electron"),
    );
    await Promise.resolve();

    // Bugfix: Squirrel.Mac may discover only after update-downloaded that the zip cannot be staged.
    // At that point ready must not be re-sent or "restart to update" kept, otherwise clicking again still
    // finds no installer in charge.
    expect(win.webContents.send).toHaveBeenCalledWith(PlatformChannels.UpdateStateChanged, {
      kind: "idle",
      enabled: true,
    });
    expect(menuItem.label).toBe(
      formatDesktopMenuMessage(TEST_LOCALE, desktopMenuMessageIds.helpCheckForUpdates),
    );

    const laterWindow = {
      isDestroyed: () => false,
      webContents: {
        id: 6,
        send: vi.fn(),
      },
    };

    syncReadyUpdateToWindow(laterWindow);

    expect(laterWindow.webContents.send).not.toHaveBeenCalledWith(
      PlatformChannels.UpdateReady,
      "0.1.25",
    );
  });

  it("开发态缓存包 ready 后的 Squirrel 迟到错误不会关闭待安装状态", async () => {
    mockProcessPlatform("darwin");
    appMock.isPackaged = false;
    process.env["ZCODE_AUTO_UPDATE_DEV"] = "1";
    const win = {
      isDestroyed: () => false,
      webContents: {
        id: 7,
        send: vi.fn(),
      },
    };
    browserWindows.push(win);

    const { initAutoUpdater, syncReadyUpdateToWindow } = await importAutoUpdaterWithLocale();

    initAutoUpdater();
    autoUpdaterMock.emit("update-downloaded", { version: "0.1.25" });

    expect(menuItem.label).toBe(
      formatDesktopMenuMessage(TEST_LOCALE, desktopMenuMessageIds.helpRestartToUpdate, {
        version: "0.1.25",
      }),
    );

    win.webContents.send.mockClear();
    autoUpdaterMock.emit("error", {
      code: 2,
      message: "Could not locate update bundle for com.github.Electron",
      domain: "SQRLUpdaterErrorDomain",
    });
    await Promise.resolve();

    // Reason for the fix: while verifying a real test-environment manifest in dev, Squirrel.Mac may still emit
    // a late code=2 after update-downloaded. A production staging error must still clear ready,
    // but dev must not let the dialog auto-close because of it.
    expect(win.webContents.send).not.toHaveBeenCalledWith(PlatformChannels.UpdateStateChanged, {
      kind: "idle",
      enabled: true,
    });
    expect(menuItem.label).toBe(
      formatDesktopMenuMessage(TEST_LOCALE, desktopMenuMessageIds.helpRestartToUpdate, {
        version: "0.1.25",
      }),
    );
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("[auto-update] ignore dev Squirrel ready error"),
    );

    const laterWindow = {
      isDestroyed: () => false,
      webContents: {
        id: 8,
        send: vi.fn(),
      },
    };

    syncReadyUpdateToWindow(laterWindow);

    expect(laterWindow.webContents.send).toHaveBeenCalledWith(
      PlatformChannels.UpdateReady,
      "0.1.25",
    );
  });

  it("在没有已下载更新时不会误发 update-ready", async () => {
    const { syncReadyUpdateToWindow } = await import("../src/main/autoUpdater.js");

    const win = {
      isDestroyed: () => false,
      webContents: {
        id: 3,
        send: vi.fn(),
      },
    };

    syncReadyUpdateToWindow(win);

    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  it("下载过程中不会提前向 renderer 宣告 update-ready", async () => {
    const releaseNotes = {
      version: "0.1.25",
      releaseName: "Release v0.1.25",
      releaseNotes: "# Release v0.1.25\n\n- downloading notes",
      releaseDate: "2026-06-23T13:48:54.438Z",
    };
    const expectedReleaseNotes = {
      version: "0.1.25",
      title: "Release v0.1.25",
      markdown: "# Release v0.1.25\n\n- downloading notes",
      releaseDate: "2026-06-23T13:48:54.438Z",
    };
    const win = {
      isDestroyed: () => false,
      webContents: {
        id: 4,
        send: vi.fn(),
      },
    };
    browserWindows.push(win);

    const { downloadAvailableUpdate, initAutoUpdater } = await importAutoUpdaterWithLocale();

    // Bugfix: the autoUpdater menu copy now follows the current locale.
    // This unit test previously asserted English constants directly without first syncing the app language the
    // way the main process does, so the module fell back to DEFAULT_LOCALE and the "downloading" copy turned
    // Chinese in the test environment.
    // It is explicitly set to en-US here so the assertions verify the "download progress state" itself rather
    // than implicitly depending on the default language.
    initAutoUpdater();

    // Regression guard: the button's display depends entirely on the renderer receiving
    // PlatformChannels.UpdateReady.
    // If the event were sent early during update-available / download-progress, the UI would mistake the state
    // for "update installable", and the user would see a restart-to-update button while the download has not
    // finished.
    autoUpdaterMock.emit("update-available", releaseNotes);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled();
    downloadAvailableUpdate("test");
    autoUpdaterMock.emit("download-progress", {
      percent: 42,
      bytesPerSecond: 1024,
      transferred: 1024,
      total: 2048,
    });

    expect(win.webContents.send).not.toHaveBeenCalledWith(
      PlatformChannels.UpdateReady,
      expect.anything(),
    );
    expect(win.webContents.send).toHaveBeenCalledWith(PlatformChannels.UpdateStateChanged, {
      kind: "update-available",
      enabled: true,
      version: "0.1.25",
      channel: "stable",
      releaseNotes: expectedReleaseNotes,
    });
    expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).toHaveBeenCalledWith(PlatformChannels.UpdateStateChanged, {
      kind: "download-progress",
      enabled: false,
      progress: "42",
      version: "0.1.25",
      channel: "stable",
      releaseNotes: expectedReleaseNotes,
      transferredBytes: 1024,
      totalBytes: 2048,
    });
    expect(menuItem.label).toBe(getExpectedDownloadingProgressLabel(42));
    expect(menuItem.enabled).toBe(false);
  });

  it("收到真实下载进度时会通知状态监听器", async () => {
    const { downloadAvailableUpdate, initAutoUpdater, onAutoUpdaterStateChanged } =
      await importAutoUpdaterWithLocale();

    initAutoUpdater();
    autoUpdaterMock.emit("update-available", { version: "0.1.25" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const listener = vi.fn();
    const dispose = onAutoUpdaterStateChanged(listener);
    downloadAvailableUpdate("test");
    autoUpdaterMock.emit("download-progress", {
      percent: 7,
      bytesPerSecond: 1024,
      transferred: 1024,
      total: 2048,
    });
    dispose();

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "download-progress",
        enabled: false,
        progress: "7",
        version: "0.1.25",
      }),
    );
  });

  it("命中已下载缓存时不会先广播 0% 下载态，会直接进入已下载状态", async () => {
    const win = {
      isDestroyed: () => false,
      webContents: {
        id: 42,
        send: vi.fn(),
      },
    };
    browserWindows.push(win);
    const { downloadAvailableUpdate, getAutoUpdaterState, initAutoUpdater } =
      await importAutoUpdaterWithLocale();

    initAutoUpdater();
    autoUpdaterMock.emit("update-available", { version: "0.1.25" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    downloadAvailableUpdate("test");
    expect(getAutoUpdaterState()).toMatchObject({
      kind: "update-available",
      version: "0.1.25",
    });
    expect(win.webContents.send).not.toHaveBeenCalledWith(
      PlatformChannels.UpdateStateChanged,
      expect.objectContaining({
        kind: "download-progress",
        progress: "0",
      }),
    );

    autoUpdaterMock.emit("update-downloaded", { version: "0.1.25" });

    expect(getAutoUpdaterState()).toMatchObject({
      kind: "update-downloaded",
      version: "0.1.25",
    });
    expect(win.webContents.send).toHaveBeenCalledWith(
      PlatformChannels.UpdateStateChanged,
      expect.objectContaining({
        kind: "update-downloaded",
        version: "0.1.25",
      }),
    );
  });

  it("开启自动下载并安装偏好后发现更新会自动开始下载", async () => {
    settingServiceMock.get.mockResolvedValue({
      recentProjects: [],
      locale: "en-US",
      autoDownloadAndInstallUpdates: true,
    });
    const { getAutoUpdaterState, initAutoUpdater } = await importAutoUpdaterWithLocale();

    initAutoUpdater({ settingService: settingServiceMock });
    autoUpdaterMock.emit("update-available", { version: "0.1.25" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(getAutoUpdaterState()).toMatchObject({
      kind: "update-available",
      version: "0.1.25",
    });
  });

  it("发现更新后只有 renderer 请求才会开始下载", async () => {
    const { initAutoUpdater } = await importAutoUpdaterWithLocale();

    initAutoUpdater();
    autoUpdaterMock.emit("update-available", { version: "0.1.25" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled();

    const downloadHandler = ipcMainHandle.mock.calls.find(
      ([channel]: [string, unknown]) => channel === PlatformChannels.DownloadUpdate,
    )?.[1] as (() => void) | undefined;

    expect(downloadHandler).toBeTypeOf("function");
    downloadHandler?.();

    expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it("取消下载会中断 token 并回到当前可更新版本", async () => {
    const releaseNotes = {
      version: "0.1.25",
      releaseName: "Release v0.1.25",
      releaseNotes: "# Release v0.1.25\n\n- cancellable notes",
      releaseDate: "2026-06-23T13:48:54.438Z",
    };
    const expectedReleaseNotes = {
      version: "0.1.25",
      title: "Release v0.1.25",
      markdown: "# Release v0.1.25\n\n- cancellable notes",
      releaseDate: "2026-06-23T13:48:54.438Z",
    };
    const win = {
      isDestroyed: () => false,
      webContents: {
        id: 6,
        send: vi.fn(),
      },
    };
    browserWindows.push(win);
    autoUpdaterMock.downloadUpdate.mockImplementationOnce(
      (token: EventEmitter) =>
        new Promise((_resolve, reject) => {
          token.once("cancel", () => reject(new Error("cancelled")));
        }),
    );
    const { getAutoUpdaterState, initAutoUpdater } = await importAutoUpdaterWithLocale();

    initAutoUpdater();
    autoUpdaterMock.emit("update-available", releaseNotes);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const downloadHandler = ipcMainHandle.mock.calls.find(
      ([channel]: [string, unknown]) => channel === PlatformChannels.DownloadUpdate,
    )?.[1] as (() => void) | undefined;
    const cancelHandler = ipcMainHandle.mock.calls.find(
      ([channel]: [string, unknown]) => channel === PlatformChannels.CancelUpdateDownload,
    )?.[1] as (() => void) | undefined;

    expect(downloadHandler).toBeTypeOf("function");
    expect(cancelHandler).toBeTypeOf("function");
    downloadHandler?.();

    const cancellationToken = autoUpdaterMock.downloadUpdate.mock.calls[0]?.[0] as
      | { cancelled?: boolean }
      | undefined;
    expect(cancellationToken?.cancelled).toBe(false);
    autoUpdaterMock.emit("download-progress", {
      percent: 1,
      bytesPerSecond: 1024,
      transferred: 1,
      total: 100,
    });
    expect(getAutoUpdaterState()).toEqual({
      kind: "download-progress",
      enabled: false,
      progress: "1",
      version: "0.1.25",
      channel: "stable",
      releaseNotes: expectedReleaseNotes,
      transferredBytes: 1,
      totalBytes: 100,
    });

    cancelHandler?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(cancellationToken?.cancelled).toBe(true);
    expect(loggerErrorMock).not.toHaveBeenCalled();
    expect(getAutoUpdaterState()).toEqual({
      kind: "update-available",
      enabled: true,
      version: "0.1.25",
      channel: "stable",
      releaseNotes: expectedReleaseNotes,
    });
    expect(win.webContents.send).toHaveBeenCalledWith(PlatformChannels.UpdateStateChanged, {
      kind: "update-available",
      enabled: true,
      version: "0.1.25",
      channel: "stable",
      releaseNotes: expectedReleaseNotes,
    });
    expect(menuItem.enabled).toBe(true);

    win.webContents.send.mockClear();
    autoUpdaterMock.emit("download-progress", {
      percent: 63,
      bytesPerSecond: 1024,
      transferred: 1024,
      total: 2048,
    });

    expect(getAutoUpdaterState()).toEqual({
      kind: "update-available",
      enabled: true,
      version: "0.1.25",
      channel: "stable",
      releaseNotes: expectedReleaseNotes,
    });
    expect(win.webContents.send).not.toHaveBeenCalledWith(
      PlatformChannels.UpdateStateChanged,
      expect.objectContaining({
        kind: "download-progress",
      }),
    );

    autoUpdaterMock.emit("error", new Error("cancelled"));

    expect(loggerErrorMock).not.toHaveBeenCalled();
    expect(getAutoUpdaterState()).toEqual({
      kind: "update-available",
      enabled: true,
      version: "0.1.25",
      channel: "stable",
      releaseNotes: expectedReleaseNotes,
    });
  });

  it("下载启动失败后保留当前可更新版本供用户重试", async () => {
    const releaseNotes = {
      version: "0.1.25",
      releaseName: "Release v0.1.25",
      releaseNotes: "# Release v0.1.25\n\n- retryable notes",
      releaseDate: "2026-06-23T13:48:54.438Z",
    };
    const expectedReleaseNotes = {
      version: "0.1.25",
      title: "Release v0.1.25",
      markdown: "# Release v0.1.25\n\n- retryable notes",
      releaseDate: "2026-06-23T13:48:54.438Z",
    };
    const win = {
      isDestroyed: () => false,
      webContents: {
        id: 10,
        send: vi.fn(),
      },
    };
    browserWindows.push(win);
    const { getAutoUpdaterState, initAutoUpdater } = await importAutoUpdaterWithLocale();

    initAutoUpdater();
    autoUpdaterMock.emit("update-available", releaseNotes);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const downloadHandler = ipcMainHandle.mock.calls.find(
      ([channel]: [string, unknown]) => channel === PlatformChannels.DownloadUpdate,
    )?.[1] as (() => void) | undefined;
    downloadHandler?.();
    expect(getAutoUpdaterState()).toMatchObject({
      kind: "update-available",
      version: "0.1.25",
    });

    autoUpdaterMock.emit("error", new Error("download failed before progress"));
    await Promise.resolve();

    // Bugfix: a download failure is not a skipped version. idle must not be broadcast making the main entry
    // and the dialog vanish together; it should revert to the updatable state, keeping the same version for
    // the user to retry.
    expect(getAutoUpdaterState()).toEqual({
      kind: "update-available",
      enabled: true,
      version: "0.1.25",
      channel: "stable",
      releaseNotes: expectedReleaseNotes,
    });
    expect(win.webContents.send).toHaveBeenCalledWith(PlatformChannels.UpdateStateChanged, {
      kind: "update-available",
      enabled: true,
      version: "0.1.25",
      channel: "stable",
      releaseNotes: expectedReleaseNotes,
    });
    expect(menuItem.enabled).toBe(true);
    await Promise.resolve();
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("下载失败发生在检查收口前时，收口后再查一次", async () => {
    let releaseCheck: (() => void) | undefined;
    autoUpdaterMock.checkForUpdates.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCheck = () => resolve(undefined);
        }),
    );
    const { initAutoUpdater } = await import("../src/main/autoUpdater.js");

    initAutoUpdater();
    autoUpdaterMock.emit("update-available", { version: "0.1.25" });
    await Promise.resolve();

    const downloadHandler = ipcMainHandle.mock.calls.find(
      ([channel]: [string, unknown]) => channel === PlatformChannels.DownloadUpdate,
    )?.[1] as (() => void) | undefined;
    autoUpdaterMock.downloadUpdate.mockRejectedValueOnce(new Error("network down"));
    downloadHandler?.();
    await Promise.resolve();
    expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);

    releaseCheck?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("跳过当前版本会按 stable 通道持久化并清空 available 状态", async () => {
    const win = {
      isDestroyed: () => false,
      webContents: {
        id: 7,
        send: vi.fn(),
      },
    };
    browserWindows.push(win);
    const { initAutoUpdater } = await importAutoUpdaterWithLocale();

    initAutoUpdater({ settingService: settingServiceMock });
    autoUpdaterMock.emit("update-available", { version: "0.1.25" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const skipHandler = ipcMainHandle.mock.calls.find(
      ([channel]: [string, unknown]) => channel === PlatformChannels.SkipUpdateVersion,
    )?.[1] as ((event: unknown, version: string) => Promise<void>) | undefined;

    expect(skipHandler).toBeTypeOf("function");
    await skipHandler?.({}, "0.1.25");

    expect(settingServiceMock.update).toHaveBeenCalledWith({
      skippedElectronUpdateVersions: {
        stable: "0.1.25",
      },
    });
    expect(win.webContents.send).toHaveBeenCalledWith(PlatformChannels.UpdateStateChanged, {
      kind: "idle",
      enabled: true,
    });
  });

  it("下载中跳过当前版本会取消下载并持久化 skipped 状态", async () => {
    const win = {
      isDestroyed: () => false,
      webContents: {
        id: 8,
        send: vi.fn(),
      },
    };
    browserWindows.push(win);
    autoUpdaterMock.downloadUpdate.mockImplementationOnce(
      (token: EventEmitter) =>
        new Promise((_resolve, reject) => {
          token.once("cancel", () => reject(new Error("cancelled")));
        }),
    );
    const { getAutoUpdaterState, initAutoUpdater } = await importAutoUpdaterWithLocale();

    initAutoUpdater({ settingService: settingServiceMock });
    autoUpdaterMock.emit("update-available", { version: "0.1.25" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const downloadHandler = ipcMainHandle.mock.calls.find(
      ([channel]: [string, unknown]) => channel === PlatformChannels.DownloadUpdate,
    )?.[1] as (() => void) | undefined;
    const skipHandler = ipcMainHandle.mock.calls.find(
      ([channel]: [string, unknown]) => channel === PlatformChannels.SkipUpdateVersion,
    )?.[1] as ((event: unknown, version: string) => Promise<void>) | undefined;

    downloadHandler?.();
    const cancellationToken = autoUpdaterMock.downloadUpdate.mock.calls[0]?.[0] as
      | { cancelled?: boolean }
      | undefined;

    await skipHandler?.({}, "0.1.25");
    await Promise.resolve();
    await Promise.resolve();

    expect(cancellationToken?.cancelled).toBe(true);
    expect(loggerErrorMock).not.toHaveBeenCalled();
    expect(settingServiceMock.update).toHaveBeenCalledWith({
      skippedElectronUpdateVersions: {
        stable: "0.1.25",
      },
    });
    expect(getAutoUpdaterState()).toEqual({ kind: "idle", enabled: true });
    expect(win.webContents.send).toHaveBeenCalledWith(PlatformChannels.UpdateStateChanged, {
      kind: "idle",
      enabled: true,
    });
  });

  it("手动检查更新会清除当前通道的 skipped 缓存并重新显示该版本", async () => {
    const win = {
      isDestroyed: () => false,
      webContents: {
        id: 9,
        send: vi.fn(),
      },
    };
    browserWindows.push(win);
    let settingsState = {
      recentProjects: [],
      locale: "en-US" as const,
      skippedElectronUpdateVersions: {
        preview: "0.2.0",
      },
    };
    settingServiceMock.get.mockImplementation(async () => settingsState);
    settingServiceMock.update.mockImplementation(async (patch) => {
      settingsState = { ...settingsState, ...patch };
    });
    const { checkForUpdateMenuClick, getAutoUpdaterState, initAutoUpdater } =
      await importAutoUpdaterWithLocale();

    initAutoUpdater({ settingService: settingServiceMock });
    await Promise.resolve();
    await Promise.resolve();
    autoUpdaterMock.emit("update-available", { version: "0.1.25" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const skipHandler = ipcMainHandle.mock.calls.find(
      ([channel]: [string, unknown]) => channel === PlatformChannels.SkipUpdateVersion,
    )?.[1] as ((event: unknown, version: string) => Promise<void>) | undefined;

    await skipHandler?.({}, "0.1.25");
    expect(getAutoUpdaterState()).toEqual({ kind: "idle", enabled: true });
    expect(settingsState.skippedElectronUpdateVersions).toEqual({
      preview: "0.2.0",
      stable: "0.1.25",
    });
    win.webContents.send.mockClear();

    checkForUpdateMenuClick(win as never);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(settingsState.skippedElectronUpdateVersions).toEqual({
      preview: "0.2.0",
    });

    autoUpdaterMock.emit("update-available", { version: "0.1.25" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Bugfix: a manual check means the user is interested again in a skipped version.
    // Only the current stable channel's cache is cleared, avoiding an accidental deletion of the preview skip
    // record, while the same-version update must be shown again.
    expect(getAutoUpdaterState()).toEqual({
      kind: "update-available",
      enabled: true,
      version: "0.1.25",
      channel: "stable",
    });
    expect(win.webContents.send).toHaveBeenCalledWith(PlatformChannels.UpdateCheckResult, {
      kind: "available",
      version: "0.1.25",
      channel: "stable",
    });
  });

  it("下载完成后会持久化版本说明，并且启动后只同步给一个窗口", async () => {
    const firstWindow = {
      isDestroyed: () => false,
      webContents: {
        id: 11,
        send: vi.fn(),
      },
    };
    const secondWindow = {
      isDestroyed: () => false,
      webContents: {
        id: 12,
        send: vi.fn(),
      },
    };
    browserWindows.push(firstWindow, secondWindow);

    const { initAutoUpdater, syncPostUpdateReleaseNotesToWindow } =
      await import("../src/main/autoUpdater.js");

    initAutoUpdater({ settingService: settingServiceMock });

    autoUpdaterMock.emit("update-downloaded", {
      version: "0.1.25",
      releaseName: "Release v0.1.25",
      releaseNotes: "# Release v0.1.25\n\n- add popup",
      releaseDate: new Date("2026-06-23T13:48:54.438Z"),
      releaseNotesByLocale: {
        "zh-CN": {
          title: "ZCode v0.1.25",
          markdown: "# ZCode v0.1.25\n\n- 中文说明",
        },
        "en-US": {
          title: "ZCode v0.1.25",
          markdown: "# ZCode v0.1.25\n\n- English notes",
        },
      },
    });
    await Promise.resolve();

    expect(settingServiceMock.update).toHaveBeenCalledWith({
      pendingPostUpdateReleaseNotes: {
        version: "0.1.25",
        title: "Release v0.1.25",
        markdown: "# Release v0.1.25\n\n- add popup",
        releaseDate: "2026-06-23T13:48:54.438Z",
        releaseNotesByLocale: {
          "zh-CN": {
            title: "ZCode v0.1.25",
            markdown: "# ZCode v0.1.25\n\n- 中文说明",
          },
          "en-US": {
            title: "ZCode v0.1.25",
            markdown: "# ZCode v0.1.25\n\n- English notes",
          },
        },
      },
    });

    expect(firstWindow.webContents.send).toHaveBeenCalledWith(PlatformChannels.UpdateStateChanged, {
      kind: "update-downloaded",
      enabled: true,
      version: "0.1.25",
      channel: "stable",
      releaseNotes: {
        version: "0.1.25",
        title: "Release v0.1.25",
        markdown: "# Release v0.1.25\n\n- add popup",
        releaseDate: "2026-06-23T13:48:54.438Z",
        releaseNotesByLocale: {
          "zh-CN": {
            title: "ZCode v0.1.25",
            markdown: "# ZCode v0.1.25\n\n- 中文说明",
          },
          "en-US": {
            title: "ZCode v0.1.25",
            markdown: "# ZCode v0.1.25\n\n- English notes",
          },
        },
      },
    });

    // Only on the next launch after installation does the current app version equal the pending version; only
    // then should the pending payload be synced to the renderer as post-update release notes.
    appMock.getVersion.mockImplementation(() => "0.1.25");
    syncPostUpdateReleaseNotesToWindow(firstWindow as never);
    syncPostUpdateReleaseNotesToWindow(secondWindow as never);

    expect(firstWindow.webContents.send).toHaveBeenCalledWith(
      PlatformChannels.PostUpdateReleaseNotes,
      {
        version: "0.1.25",
        title: "Release v0.1.25",
        markdown: "# Release v0.1.25\n\n- add popup",
        releaseDate: "2026-06-23T13:48:54.438Z",
        releaseNotesByLocale: {
          "zh-CN": {
            title: "ZCode v0.1.25",
            markdown: "# ZCode v0.1.25\n\n- 中文说明",
          },
          "en-US": {
            title: "ZCode v0.1.25",
            markdown: "# ZCode v0.1.25\n\n- English notes",
          },
        },
      },
    );
    expect(secondWindow.webContents.send).not.toHaveBeenCalledWith(
      PlatformChannels.PostUpdateReleaseNotes,
      expect.anything(),
    );
  });

  it("没有 releaseNotes 时不会写入待展示说明", async () => {
    const { initAutoUpdater } = await import("../src/main/autoUpdater.js");

    initAutoUpdater({ settingService: settingServiceMock });

    autoUpdaterMock.emit("update-downloaded", { version: "0.1.25" });
    await Promise.resolve();

    expect(settingServiceMock.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        pendingPostUpdateReleaseNotes: expect.anything(),
      }),
    );
  });

  it("renderer ack 后会清空待展示说明，不再重复补发", async () => {
    appMock.getVersion.mockImplementation(() => "0.1.25");
    const firstWindow = {
      isDestroyed: () => false,
      webContents: {
        id: 21,
        send: vi.fn(),
      },
    };
    const laterWindow = {
      isDestroyed: () => false,
      webContents: {
        id: 22,
        send: vi.fn(),
      },
    };
    browserWindows.push(firstWindow, laterWindow);
    settingServiceMock.get.mockResolvedValue({
      recentProjects: [],
      locale: "en-US",
      pendingPostUpdateReleaseNotes: {
        version: "0.1.25",
        title: "Release v0.1.25",
        markdown: "# Release v0.1.25\n\n- add popup",
      },
    });

    const {
      acknowledgePostUpdateReleaseNotes,
      hydratePendingPostUpdateReleaseNotes,
      syncPostUpdateReleaseNotesToWindow,
    } = await import("../src/main/autoUpdater.js");

    await hydratePendingPostUpdateReleaseNotes(settingServiceMock);
    syncPostUpdateReleaseNotesToWindow(firstWindow as never);

    expect(firstWindow.webContents.send).toHaveBeenCalledWith(
      PlatformChannels.PostUpdateReleaseNotes,
      {
        version: "0.1.25",
        title: "Release v0.1.25",
        markdown: "# Release v0.1.25\n\n- add popup",
      },
    );

    await acknowledgePostUpdateReleaseNotes("0.1.25", settingServiceMock);

    expect(settingServiceMock.update).toHaveBeenCalledWith({
      pendingPostUpdateReleaseNotes: undefined,
    });

    syncPostUpdateReleaseNotesToWindow(laterWindow as never);
    expect(laterWindow.webContents.send).not.toHaveBeenCalledWith(
      PlatformChannels.PostUpdateReleaseNotes,
      expect.anything(),
    );
  });

  it("hydrate 时若待展示版本低于已安装应用版本则丢弃，避免手动跳级安装后弹出旧版说明", async () => {
    appMock.getVersion.mockImplementation(() => "0.1.26");
    settingServiceMock.get.mockResolvedValue({
      recentProjects: [],
      locale: "en-US",
      pendingPostUpdateReleaseNotes: {
        version: "0.1.25",
        title: "Release v0.1.25",
        markdown: "# Release v0.1.25\n\n- old",
      },
    });

    const { hydratePendingPostUpdateReleaseNotes, syncPostUpdateReleaseNotesToWindow } =
      await import("../src/main/autoUpdater.js");

    await hydratePendingPostUpdateReleaseNotes(settingServiceMock);

    expect(settingServiceMock.update).toHaveBeenCalledWith({
      pendingPostUpdateReleaseNotes: undefined,
    });

    const win = {
      isDestroyed: () => false,
      webContents: {
        id: 99,
        send: vi.fn(),
      },
    };
    syncPostUpdateReleaseNotesToWindow(win as never);
    expect(win.webContents.send).not.toHaveBeenCalledWith(
      PlatformChannels.PostUpdateReleaseNotes,
      expect.anything(),
    );
  });

  it("hydrate 时若待展示版本高于当前应用版本则恢复为待安装更新", async () => {
    appMock.getVersion.mockImplementation(() => "0.1.24");
    settingServiceMock.get.mockResolvedValue({
      recentProjects: [],
      locale: "en-US",
      pendingPostUpdateReleaseNotes: {
        version: "0.1.25",
        title: "Release v0.1.25",
        markdown: "# Release v0.1.25\n\n- cached",
      },
    });

    const {
      getAutoUpdaterState,
      hydratePendingPostUpdateReleaseNotes,
      syncPostUpdateReleaseNotesToWindow,
      syncReadyUpdateToWindow,
    } = await importAutoUpdaterWithLocale();

    await hydratePendingPostUpdateReleaseNotes(settingServiceMock);

    // Bugfix: restarting while downloaded but not installed leaves the pending release notes version still
    // above the current app. In that case "restart to update" must be restored, not a fresh prompt to download
    // the same cached version.
    expect(getAutoUpdaterState()).toEqual({
      kind: "update-downloaded",
      enabled: true,
      version: "0.1.25",
      releaseNotes: {
        version: "0.1.25",
        title: "Release v0.1.25",
        markdown: "# Release v0.1.25\n\n- cached",
      },
    });

    const readyWindow = {
      isDestroyed: () => false,
      webContents: {
        id: 101,
        send: vi.fn(),
      },
    };
    syncReadyUpdateToWindow(readyWindow as never);
    expect(readyWindow.webContents.send).toHaveBeenCalledWith(
      PlatformChannels.UpdateReady,
      "0.1.25",
    );

    const notesWindow = {
      isDestroyed: () => false,
      webContents: {
        id: 102,
        send: vi.fn(),
      },
    };
    syncPostUpdateReleaseNotesToWindow(notesWindow as never);
    expect(notesWindow.webContents.send).not.toHaveBeenCalledWith(
      PlatformChannels.PostUpdateReleaseNotes,
      expect.anything(),
    );
  });

  it("用户确认安装更新前会先执行退出准备钩子", async () => {
    mockProcessPlatform("darwin");
    let resolveQuitPreparation: (() => void) | null = null;
    const onBeforeQuitAndInstall = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveQuitPreparation = resolve;
        }),
    );
    const { initAutoUpdater } = await import("../src/main/autoUpdater.js");

    initAutoUpdater({ onBeforeQuitAndInstall });

    const quitHandler = ipcMainOn.mock.calls.find(
      ([channel]: [string, unknown]) => channel === PlatformChannels.QuitAndInstallUpdate,
    )?.[1] as (() => void) | undefined;

    expect(quitHandler).toBeTypeOf("function");

    autoUpdaterMock.emit("update-downloaded", { version: "0.1.25" });
    await Promise.resolve();
    quitHandler?.();

    expect(onBeforeQuitAndInstall).toHaveBeenCalledTimes(1);
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(0);

    resolveQuitPreparation?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("安装前退出准备失败时不会继续启动安装器或开发态重启", async () => {
    mockProcessPlatform("win32");
    const prepareError = new Error("host process still locked resources");
    const onBeforeQuitAndInstall = vi.fn(async () => {
      throw prepareError;
    });
    const { initAutoUpdater } = await import("../src/main/autoUpdater.js");

    initAutoUpdater({ onBeforeQuitAndInstall });

    const quitHandler = ipcMainHandle.mock.calls.find(
      ([channel]: [string, unknown]) => channel === PlatformChannels.QuitAndInstallUpdate,
    )?.[1] as (() => Promise<void>) | undefined;

    autoUpdaterMock.emit("update-downloaded", { version: "0.1.25" });
    await Promise.resolve();
    expect(quitHandler).toBeTypeOf("function");
    await expect(quitHandler!()).rejects.toBe(prepareError);

    // Bugfix: the pre-install preparation is responsible for releasing bundled resource locks such as Windows
    // resources/glm.
    // Continuing to launch the installer after a failed preparation would create another half-updated bundled
    // runtime.
    expect(onBeforeQuitAndInstall).toHaveBeenCalledTimes(1);
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    expect(appMock.relaunch).not.toHaveBeenCalled();
    expect(appMock.exit).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(
      "[auto-update] prepare quit and install failed:",
      prepareError,
    );
  });

  it("没有已下载更新时安装请求不会执行退出准备", async () => {
    mockProcessPlatform("darwin");
    const onBeforeQuitAndInstall = vi.fn();
    const { initAutoUpdater } = await import("../src/main/autoUpdater.js");

    initAutoUpdater({ onBeforeQuitAndInstall });

    const quitHandler = ipcMainHandle.mock.calls.find(
      ([channel]: [string, unknown]) => channel === PlatformChannels.QuitAndInstallUpdate,
    )?.[1] as (() => Promise<void>) | undefined;

    expect(quitHandler).toBeTypeOf("function");
    await expect(quitHandler!()).rejects.toThrow("Update is not ready to install: state=idle");

    // Bugfix: the renderer's stale ready cache may linger, but main has already gone back to idle because of
    // the staging error. The host must not be cleaned up nor quitAndInstall called, otherwise the button
    // appears unresponsive.
    expect(onBeforeQuitAndInstall).not.toHaveBeenCalled();
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "[auto-update] ignore quitAndInstall request: state=idle",
    );
  });

  it("Windows 安装更新恢复 electron-updater 原生入口，不再启动 PowerShell launcher", async () => {
    mockProcessPlatform("win32");
    const onBeforeQuitAndInstall = vi.fn();
    const { initAutoUpdater } = await import("../src/main/autoUpdater.js");

    initAutoUpdater({ onBeforeQuitAndInstall });

    const quitHandler = ipcMainOn.mock.calls.find(
      ([channel]: [string, unknown]) => channel === PlatformChannels.QuitAndInstallUpdate,
    )?.[1] as (() => void) | undefined;

    autoUpdaterMock.emit("update-downloaded", { version: "0.1.25" });
    await Promise.resolve();
    quitHandler?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(onBeforeQuitAndInstall).toHaveBeenCalledTimes(1);
    // Bugfix: 3.3.0's detached hidden PowerShell launcher only proved that powershell.exe was created, not that
    // the installer script actually ran. Windows must also return to electron-updater's native entry point.
    expect(spawnMock).not.toHaveBeenCalled();
    expect(appMock.exit).not.toHaveBeenCalled();
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("安装器交接失败时会清理就绪状态并重启应用恢复", async () => {
    mockProcessPlatform("win32");
    const installError = new Error("installer handoff failed");
    // Model electron-updater 6.8.9: BaseUpdater.install() catches the synchronous doInstall()
    // failure, emits the generic "error" event, and returns false — quitAndInstall() does not
    // throw. The handoff failure reaches main only through the error event.
    autoUpdaterMock.quitAndInstall.mockImplementationOnce(() => {
      autoUpdaterMock.emit("error", installError);
      return false;
    });
    const { getAutoUpdaterState, initAutoUpdater } = await import("../src/main/autoUpdater.js");

    initAutoUpdater({});

    const quitHandler = ipcMainHandle.mock.calls.find(
      ([channel]: [string, unknown]) => channel === PlatformChannels.QuitAndInstallUpdate,
    )?.[1] as (() => Promise<void>) | undefined;

    autoUpdaterMock.emit("update-downloaded", { version: "0.1.25" });
    await Promise.resolve();
    expect(quitHandler).toBeTypeOf("function");
    await quitHandler!();

    // Upstream 3.15.3 parity: when the installer handoff fails after shutdown started, the old
    // in-flight boolean left the app quitting without installing. The ready state is cleared, the
    // failure is reported, and the app relaunches so the user is not left with a dead updater.
    expect(loggerErrorMock).toHaveBeenCalledWith(
      "[auto-update] quit and install failed:",
      installError,
    );
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "[auto-update] install failed after shutdown started: relaunch app",
    );
    expect(appMock.relaunch).toHaveBeenCalledTimes(1);
    expect(appMock.exit).toHaveBeenCalledWith(0);
    expect(getAutoUpdaterState()).toMatchObject({ kind: "idle" });
  });

  it("安装准入等待在途检查、抑制其错误并阻止新的检查", async () => {
    mockProcessPlatform("win32");
    vi.useFakeTimers();
    try {
      const { getAutoUpdaterState, initAutoUpdater } = await import("../src/main/autoUpdater.js");

      initAutoUpdater({});
      await vi.advanceTimersByTimeAsync(0);

      // Arm a hung check for the download-finished recheck that fires right after
      // update-downloaded, so a check is in flight when the install is requested.
      let rejectCheck!: (err: Error) => void;
      autoUpdaterMock.checkForUpdates.mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectCheck = reject;
          }),
      );

      const quitHandler = ipcMainHandle.mock.calls.find(
        ([channel]: [string, unknown]) => channel === PlatformChannels.QuitAndInstallUpdate,
      )?.[1] as (() => Promise<void>) | undefined;

      autoUpdaterMock.emit("update-downloaded", { version: "0.1.25" });
      await vi.advanceTimersByTimeAsync(0);
      expect(quitHandler).toBeTypeOf("function");

      const quitPromise = quitHandler!();
      await vi.advanceTimersByTimeAsync(0);
      // The handoff waits for the in-flight check before quitting.
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();

      // While the phase is locked, polls must not start new checks.
      const callsBefore = autoUpdaterMock.checkForUpdates.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(callsBefore);

      // The in-flight check's error event is check-originated noise: suppressed, no relaunch.
      loggerInfoMock.mockClear();
      autoUpdaterMock.emit("error", new Error("manifest request failed"));
      await vi.advanceTimersByTimeAsync(0);
      expect(loggerInfoMock).toHaveBeenCalledWith(
        "[auto-update] ignore late check failure after install admission",
      );
      expect(appMock.relaunch).not.toHaveBeenCalled();

      // Settling the check releases the handoff.
      rejectCheck(new Error("network down"));
      await quitPromise;
      await vi.advanceTimersByTimeAsync(0);
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
      // The rejection itself is also check-originated ("download-finished check failed").
      expect(loggerInfoMock).toHaveBeenCalledWith(
        "[auto-update] ignore late check failure after install admission",
      );
      expect(getAutoUpdaterState()).toMatchObject({
        kind: "update-downloaded",
        version: "0.1.25",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("quitAndInstall 返回后异步上报的安装器启动失败会触发重启恢复", async () => {
    mockProcessPlatform("win32");
    vi.useFakeTimers();
    try {
      const { getAutoUpdaterState, initAutoUpdater } = await import("../src/main/autoUpdater.js");

      initAutoUpdater({});
      await vi.advanceTimersByTimeAsync(0);

      const quitHandler = ipcMainHandle.mock.calls.find(
        ([channel]: [string, unknown]) => channel === PlatformChannels.QuitAndInstallUpdate,
      )?.[1] as (() => Promise<void>) | undefined;

      autoUpdaterMock.emit("update-downloaded", { version: "0.1.25" });
      await vi.advanceTimersByTimeAsync(0);
      expect(quitHandler).toBeTypeOf("function");
      await quitHandler!();
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);

      // Model NsisUpdater on Windows: doInstall() returned true synchronously, and the
      // spawnLog().catch() reports the launch failure asynchronously after quitAndInstall()
      // has already returned. The handoff attribution window must still route this event to
      // recovery so the shutdown cannot quit without installing or relaunching.
      loggerErrorMock.mockClear();
      autoUpdaterMock.emit("error", new Error("spawn installer failed"));
      await vi.advanceTimersByTimeAsync(0);

      expect(loggerErrorMock).toHaveBeenCalledWith(
        "[auto-update] quit and install failed:",
        expect.any(Error),
      );
      expect(loggerWarnMock).toHaveBeenCalledWith(
        "[auto-update] install failed after shutdown started: relaunch app",
      );
      expect(appMock.relaunch).toHaveBeenCalledTimes(1);
      expect(appMock.exit).toHaveBeenCalledWith(0);
      expect(getAutoUpdaterState()).toMatchObject({ kind: "idle" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("退出准备失败后安装请求不会被状态机卡死，可再次尝试", async () => {
    mockProcessPlatform("win32");
    const prepareError = new Error("host process still locked resources");
    const onBeforeQuitAndInstall = vi
      .fn()
      .mockRejectedValueOnce(prepareError)
      .mockResolvedValueOnce(undefined);
    const { initAutoUpdater } = await import("../src/main/autoUpdater.js");

    initAutoUpdater({ onBeforeQuitAndInstall });

    const quitHandler = ipcMainHandle.mock.calls.find(
      ([channel]: [string, unknown]) => channel === PlatformChannels.QuitAndInstallUpdate,
    )?.[1] as (() => Promise<void>) | undefined;

    autoUpdaterMock.emit("update-downloaded", { version: "0.1.25" });
    await Promise.resolve();
    await expect(quitHandler!()).rejects.toBe(prepareError);
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();

    // The prepare failure also clears the ready state, so re-stage by emitting update-downloaded
    // again; the second request must reach quit preparation instead of being wedged by the
    // admission phase ("quitAndInstall already in flight").
    autoUpdaterMock.emit("update-downloaded", { version: "0.1.25" });
    await Promise.resolve();
    await quitHandler!();
    await Promise.resolve();
    await Promise.resolve();
    expect(onBeforeQuitAndInstall).toHaveBeenCalledTimes(2);
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("更新已下载后点击菜单会直接重启安装", async () => {
    mockProcessPlatform("darwin");
    const onBeforeQuitAndInstall = vi.fn();
    const win = {
      isDestroyed: () => false,
      webContents: {
        id: 21,
        send: vi.fn(),
      },
    };
    browserWindows.push(win);

    const { initAutoUpdater, checkForUpdateMenuClick } = await import("../src/main/autoUpdater.js");

    initAutoUpdater({ onBeforeQuitAndInstall });
    autoUpdaterMock.emit("update-downloaded", { version: "0.1.25" });
    win.webContents.send.mockClear();

    checkForUpdateMenuClick(win as never);
    // The install handoff now waits for the in-flight startup check to settle before quitting,
    // so flush a macrotask to let the whole settle chain run before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Bugfix: when the menu copy says "restart to update", clicking must really install just like the update
    // button; the old logic only sent a ready toast to the renderer, so the user saw "restart" without any
    // actual restart.
    expect(onBeforeQuitAndInstall).toHaveBeenCalledTimes(1);
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).not.toHaveBeenCalledWith(PlatformChannels.UpdateCheckResult, {
      kind: "ready",
      version: "0.1.25",
    });
  });
  it("Windows 初始化时会关闭 quit 自动安装，避免关应用后立即关机打断更新", async () => {
    mockProcessPlatform("win32");
    const { initAutoUpdater } = await import("../src/main/autoUpdater.js");

    initAutoUpdater();

    expect(autoUpdaterMock.autoDownload).toBe(false);
    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false);
  });

  it("非 Windows 初始化时保持 quit 自动安装，避免影响既有升级行为", async () => {
    mockProcessPlatform("darwin");
    const { initAutoUpdater } = await import("../src/main/autoUpdater.js");

    initAutoUpdater();

    // Non-Windows also no longer lets electron-updater install the staged package directly at quit.
    // When the ready package still equals the current target, before-quit installs proactively; if the target
    // has moved higher, it is skipped.
    expect(autoUpdaterMock.autoDownload).toBe(false);
    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false);
  });

  it("Windows 启动时不阻塞主界面，后台检查更新", async () => {
    mockProcessPlatform("win32");
    const { initAutoUpdater } = await import("../src/main/autoUpdater.js");

    // initAutoUpdater now returns immediately, without waiting for the update check to finish
    await expect(initAutoUpdater()).resolves.toBeUndefined();

    // The update check should be triggered in the background
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it("启动后会注册 15 分钟轮询，并在空闲时再次检查更新", async () => {
    vi.useFakeTimers();
    try {
      const { initAutoUpdater } = await import("../src/main/autoUpdater.js");

      initAutoUpdater();
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(FIFTEEN_MINUTES_MS);

      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("已发现更新后 2 分钟轮询会换成更高版本，且入口不进入 checking", async () => {
    vi.useFakeTimers();
    try {
      const { getAutoUpdaterState, initAutoUpdater } = await importAutoUpdaterWithLocale();

      initAutoUpdater();
      autoUpdaterMock.emit("update-available", { version: "0.1.25" });
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(TWO_MINUTES_MS);
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2);
      autoUpdaterMock.emit("update-available", { version: "0.1.27" });
      await Promise.resolve();

      expect(getAutoUpdaterState()).toMatchObject({
        kind: "update-available",
        version: "0.1.27",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("已发现更新后手动检查会重新请求并替换版本", async () => {
    const win = {
      isDestroyed: () => false,
      webContents: { id: 51, send: vi.fn() },
    };
    browserWindows.push(win);
    const { checkForUpdateMenuClick, getAutoUpdaterState, initAutoUpdater } =
      await import("../src/main/autoUpdater.js");

    initAutoUpdater();
    await Promise.resolve();
    await Promise.resolve();
    autoUpdaterMock.emit("update-available", { version: "0.1.25" });
    await Promise.resolve();

    checkForUpdateMenuClick(win as never);
    await Promise.resolve();
    autoUpdaterMock.emit("update-available", { version: "0.1.27" });
    await Promise.resolve();

    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(getAutoUpdaterState()).toMatchObject({
      kind: "update-available",
      version: "0.1.27",
    });
  });

  it("自动下载完成后立刻复查，更高版本会替换并重新下载", async () => {
    settingServiceMock.get.mockResolvedValue({
      recentProjects: [],
      locale: "en-US",
      autoDownloadAndInstallUpdates: true,
    });
    const { getAutoUpdaterState, initAutoUpdater } = await import("../src/main/autoUpdater.js");

    initAutoUpdater({ settingService: settingServiceMock });
    await new Promise((resolve) => setTimeout(resolve, 0));
    autoUpdaterMock.emit("update-available", { version: "0.1.25" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledTimes(1);

    autoUpdaterMock.emit("update-downloaded", { version: "0.1.25" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2);

    autoUpdaterMock.emit("update-available", { version: "0.1.27" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledTimes(2);
    expect(getAutoUpdaterState()).toMatchObject({
      kind: "update-available",
      version: "0.1.27",
    });
  });

  it("macOS 上旧 ready 包不再等于目标时退出不安装", async () => {
    mockProcessPlatform("darwin");
    const { initAutoUpdater } = await import("../src/main/autoUpdater.js");

    initAutoUpdater();
    autoUpdaterMock.emit("update-downloaded", { version: "0.1.25" });
    autoUpdaterMock.emit("update-available", { version: "0.1.27" });
    await Promise.resolve();

    const event = { preventDefault: vi.fn() };
    for (const listener of appListeners.get("before-quit") ?? []) {
      listener(event);
    }

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
  });

  it("下载中轮询不会并发触发新的检查", async () => {
    vi.useFakeTimers();
    try {
      const { downloadAvailableUpdate, initAutoUpdater } = await importAutoUpdaterWithLocale();

      initAutoUpdater();
      await Promise.resolve();
      await Promise.resolve();
      autoUpdaterMock.emit("update-available", { version: "0.1.25" });
      await Promise.resolve();
      downloadAvailableUpdate("test");
      autoUpdaterMock.emit("download-progress", {
        percent: 10,
        bytesPerSecond: 1024,
        transferred: 1024,
        total: 10240,
      });

      await vi.advanceTimersByTimeAsync(FIFTEEN_MINUTES_MS);

      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("已下载更新后轮询发现更高版本时先提示，用户确认后替换 ready 版本", async () => {
    vi.useFakeTimers();
    try {
      const win = {
        isDestroyed: () => false,
        webContents: {
          id: 41,
          send: vi.fn(),
        },
      };
      browserWindows.push(win);
      const { downloadAvailableUpdate, initAutoUpdater } = await importAutoUpdaterWithLocale();

      initAutoUpdater();
      autoUpdaterMock.emit("update-downloaded", { version: "0.1.25" });
      autoUpdaterMock.downloadUpdate.mockClear();
      win.webContents.send.mockClear();

      await vi.advanceTimersByTimeAsync(TWO_MINUTES_MS);

      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2);

      autoUpdaterMock.emit("update-available", { version: "0.1.26" });
      await Promise.resolve();
      await Promise.resolve();

      expect(autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled();
      expect(win.webContents.send).toHaveBeenCalledWith(PlatformChannels.UpdateStateChanged, {
        kind: "update-available",
        enabled: true,
        version: "0.1.26",
        channel: "stable",
      });

      downloadAvailableUpdate("test");
      expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledTimes(1);
      autoUpdaterMock.emit("update-downloaded", { version: "0.1.26" });

      expect(win.webContents.send).toHaveBeenCalledWith(PlatformChannels.UpdateReady, "0.1.26");
      expect(menuItem.label).toBe(
        formatDesktopMenuMessage(TEST_LOCALE, desktopMenuMessageIds.helpRestartToUpdate, {
          version: "0.1.26",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("已下载更新后轮询发现同版本时不会重复下载", async () => {
    vi.useFakeTimers();
    try {
      const { initAutoUpdater } = await importAutoUpdaterWithLocale();

      initAutoUpdater();
      autoUpdaterMock.emit("update-downloaded", { version: "0.1.25" });
      autoUpdaterMock.downloadUpdate.mockClear();

      await vi.advanceTimersByTimeAsync(TWO_MINUTES_MS);
      autoUpdaterMock.emit("update-available", { version: "0.1.25" });

      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2);
      expect(autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled();
      expect(menuItem.label).toBe(
        formatDesktopMenuMessage(TEST_LOCALE, desktopMenuMessageIds.helpRestartToUpdate, {
          version: "0.1.25",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("重复手动检查时不会丢失第一次检查的结果", async () => {
    const firstWindow = {
      isDestroyed: () => false,
      webContents: {
        id: 31,
        send: vi.fn(),
      },
    };
    const secondWindow = {
      isDestroyed: () => false,
      webContents: {
        id: 32,
        send: vi.fn(),
      },
    };

    const { initAutoUpdater, checkForUpdateMenuClick } = await import("../src/main/autoUpdater.js");

    browserWindows.push(firstWindow, secondWindow);

    initAutoUpdater();
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();

    checkForUpdateMenuClick(firstWindow as never);
    checkForUpdateMenuClick(secondWindow as never);

    expect(secondWindow.webContents.send).toHaveBeenCalledWith(PlatformChannels.UpdateCheckResult, {
      kind: "error",
      message: "Update check already in progress.",
    });

    autoUpdaterMock.emit("update-not-available", { version: "0.1.24" });

    // Bugfix: the second manual click should only receive the immediate "already checking" feedback and must
    // not steal the real completion result of the first manual check; otherwise the user who clicked first
    // would never see a conclusion.
    expect(firstWindow.webContents.send).toHaveBeenCalledWith(PlatformChannels.UpdateCheckResult, {
      kind: "up-to-date",
      currentVersion: "0.1.24",
    });
  });

  it("强制升级自动更新会直接安装已下载版本，不再用最低版本二次拦截", async () => {
    mockProcessPlatform("darwin");
    const { initAutoUpdater, requestForceAutoUpdate } = await import("../src/main/autoUpdater.js");
    const onStateChange = vi.fn();

    initAutoUpdater();
    autoUpdaterMock.emit("update-downloaded", { version: "0.1.25" });
    await Promise.resolve();
    await Promise.resolve();
    autoUpdaterMock.checkForUpdates.mockClear();
    autoUpdaterMock.quitAndInstall.mockClear();

    requestForceAutoUpdate(onStateChange, "force-update", "0.1.26");
    await Promise.resolve();

    expect(onStateChange).toHaveBeenCalledWith({ kind: "checking" });
    // The install handoff awaits the dictation mute drain before quitAndInstall, so flush a few
    // microtask ticks instead of assuming a synchronous call.
    await vi.waitFor(() => {
      expect(onStateChange).toHaveBeenCalledWith({ kind: "installing" });
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledOnce();
    });
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
  });

  it("开发态自动更新安装请求会重启当前 dev app", async () => {
    mockProcessPlatform("darwin");
    appMock.isPackaged = false;
    process.env["ZCODE_AUTO_UPDATE_DEV"] = "1";
    const onBeforeQuitAndInstall = vi.fn();
    const { initAutoUpdater } = await import("../src/main/autoUpdater.js");

    initAutoUpdater({ onBeforeQuitAndInstall });
    autoUpdaterMock.emit("update-downloaded", { version: "0.1.25" });
    await Promise.resolve();
    await Promise.resolve();
    autoUpdaterMock.quitAndInstall.mockClear();
    appMock.relaunch.mockClear();
    appMock.exit.mockClear();

    const quitAndInstallHandler = ipcMainHandle.mock.calls.find(
      ([channel]: [string, unknown]) => channel === PlatformChannels.QuitAndInstallUpdate,
    )?.[1] as (() => Promise<void>) | undefined;
    await quitAndInstallHandler?.();

    // Reason for the fix: in dev there is no real release-package install context to hand over to, so we cannot
    // keep relying on electron-updater.quitAndInstall(); otherwise the button runs quit preparation but the
    // app never restarts.
    expect(onBeforeQuitAndInstall).toHaveBeenCalledTimes(1);
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled();
    expect(appMock.relaunch).toHaveBeenCalledTimes(1);
    expect(appMock.exit).toHaveBeenCalledWith(0);
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "[auto-update] dev update install fallback: relaunch app",
    );
  });

  it("强制升级下载失败时会恢复菜单并反馈弹窗错误", async () => {
    const downloadError = new Error("network down");
    autoUpdaterMock.downloadUpdate.mockRejectedValueOnce(downloadError);
    const win = {
      isDestroyed: () => false,
      webContents: {
        id: 41,
        send: vi.fn(),
      },
    };
    browserWindows.push(win);
    const { initAutoUpdater, requestForceAutoUpdate } = await import("../src/main/autoUpdater.js");
    const onStateChange = vi.fn();

    initAutoUpdater();
    requestForceAutoUpdate(onStateChange);
    autoUpdaterMock.emit("update-available", { version: "0.1.25" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onStateChange).toHaveBeenCalledWith({ kind: "checking" });
    expect(onStateChange).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "downloading",
        version: "0.1.25",
      }),
    );
    expect(onStateChange).toHaveBeenCalledWith({
      kind: "error",
      message: "network down",
    });
    expect(win.webContents.send).toHaveBeenCalledWith(PlatformChannels.UpdateStateChanged, {
      kind: "idle",
      enabled: true,
    });
  });

  it("强制升级自动更新复用检查时，无可用更新会反馈错误状态", async () => {
    const { initAutoUpdater, requestForceAutoUpdate } = await import("../src/main/autoUpdater.js");
    const onStateChange = vi.fn();

    initAutoUpdater();
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);

    requestForceAutoUpdate(onStateChange);

    expect(onStateChange).toHaveBeenCalledWith({ kind: "checking" });
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1);

    autoUpdaterMock.emit("update-not-available", { version: "0.1.24" });

    // Bugfix: once the startup check is reused by the force-update dialog, "no update" must also notify the dialog, avoiding a forever-checking state.
    expect(onStateChange).toHaveBeenCalledWith({
      kind: "error",
      message: "未找到可安装更新，请使用手动升级。",
    });
  });

  it("强制升级自动更新复用检查失败时，会反馈弹窗错误状态", async () => {
    const checkError = new Error("feed offline");
    autoUpdaterMock.checkForUpdates.mockRejectedValueOnce(checkError);
    const { getAutoUpdaterState, initAutoUpdater, requestForceAutoUpdate } =
      await import("../src/main/autoUpdater.js");
    const onStateChange = vi.fn();

    initAutoUpdater();
    requestForceAutoUpdate(onStateChange);
    await Promise.resolve();
    await Promise.resolve();

    // Bugfix: when the force-update dialog reuses the startup background check, a direct checkForUpdates
    // rejection must also be reported to the dialog, otherwise the user keeps seeing checking and cannot tell
    // the automatic upgrade has failed.
    expect(onStateChange).toHaveBeenCalledWith({ kind: "checking" });
    expect(onStateChange).toHaveBeenCalledWith({
      kind: "error",
      message: "feed offline",
    });
    expect(getAutoUpdaterState()).toEqual({ kind: "idle", enabled: true });
  });

  it("强制升级自动更新无可用更新时按英文 locale 反馈错误文案", async () => {
    const { initAutoUpdater, requestForceAutoUpdate } = await importAutoUpdaterWithLocale();
    const onStateChange = vi.fn();

    initAutoUpdater();
    requestForceAutoUpdate(onStateChange);
    autoUpdaterMock.emit("update-not-available", { version: "0.1.24" });

    expect(onStateChange).toHaveBeenCalledWith({
      kind: "error",
      message: "No installable update was found. Use manual update instead.",
    });
  });
});

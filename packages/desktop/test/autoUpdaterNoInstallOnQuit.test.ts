// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  appOn: vi.fn(),
  updater: {
    on: vi.fn(),
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(() => new Promise(() => {})),
    autoDownload: true,
    autoInstallOnAppQuit: true,
    logger: null as unknown,
  },
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    on: h.appOn,
    getVersion: () => "3.18.0",
    relaunch: vi.fn(),
    exit: vi.fn(),
    commandLine: { getSwitchValue: () => "", hasSwitch: () => false },
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
}));

vi.mock("electron-updater", () => {
  class NsisUpdater {}
  class CancellationToken {}
  return {
    default: { autoUpdater: h.updater, NsisUpdater },
    CancellationToken,
  };
});

vi.mock("../src/main/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../src/main/desktopDictationSystemAudio.js", () => ({
  restoreDictationSystemMuteForShutdown: vi.fn(),
}));
vi.mock("../scripts/powershell-command.mjs", () => ({
  verifyWindowsAuthenticodeSignature: vi.fn(),
}));
vi.mock("../src/main/manifestUpdateProvider.js", () => ({
  ManifestUpdateProvider: class {},
  getElectronReleasePlatform: () => "mac-arm64",
}));

import { initAutoUpdater } from "../src/main/autoUpdater.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
});

// Upstream 3.18.0: an ordinary quit is not a request to install. Installing from before-quit,
// combined with the relaunch after a failed install, made every quit install and restart again.
describe("auto updater install on quit", () => {
  it.each(["darwin", "linux", "win32"] as const)(
    "installs only from the explicit entry on %s",
    async (platform) => {
      Object.defineProperty(process, "platform", {
        value: platform,
        configurable: true,
      });
      h.appOn.mockClear();
      await initAutoUpdater({});
      expect(h.updater.autoInstallOnAppQuit).toBe(false);
      expect(h.appOn.mock.calls.map(([event]) => event)).not.toContain("before-quit");
    },
  );
});

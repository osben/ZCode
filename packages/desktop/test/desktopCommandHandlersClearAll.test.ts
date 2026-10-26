// @vitest-environment node

import { describe, expect, it, vi, beforeEach } from "vitest";
import { DesktopCommandIds } from "@zcode/shared";

const h = vi.hoisted(() => ({
  restore: vi.fn(async () => {}),
  relaunch: vi.fn(),
  exit: vi.fn(),
  showMessageBox: vi.fn(async () => ({ response: 1 })),
  getAllWindows: vi.fn(() => []),
  clearBrowserData: vi.fn(async () => {}),
  clearStorageData: vi.fn(async () => {}),
  executeJavaScript: vi.fn(async () => undefined),
  fromPartition: { clearStorageData: vi.fn(async () => {}) },
  rm: vi.fn(async () => {}),
}));

vi.mock("electron", () => ({
  app: { relaunch: h.relaunch, exit: h.exit },
  BrowserWindow: { getAllWindows: h.getAllWindows, getFocusedWindow: vi.fn(() => null) },
  dialog: { showMessageBox: h.showMessageBox },
  session: { fromPartition: () => h.fromPartition },
}));
// desktopCommandHandlers pulls @zcode/services/node → electron-updater → electron, whose install
// check throws in the test checkout; nothing from the updater is exercised here.
vi.mock("electron-updater", () => ({
  default: {},
  CancellationToken: class {},
  autoUpdater: {},
  Provider: class {},
}));
vi.mock("node:fs/promises", () => ({
  rm: h.rm,
  readFile: vi.fn(async () => ""),
}));
vi.mock("../src/main/pluginSandbox/index.js", () => ({
  getPluginSandboxHost: () => ({ clearBrowserData: h.clearBrowserData }),
}));
// The dictation mute drain is covered by its own suite; here only the ordering matters.
vi.mock("../src/main/desktopDictationSystemAudio.js", () => ({
  restoreDictationSystemMuteForShutdown: h.restore,
}));

import { executeDesktopCommand } from "../src/main/desktopCommandHandlers.js";

describe("Clear All Data restart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("releases the dictation system mute before relaunching and exiting", async () => {
    await executeDesktopCommand({
      command: DesktopCommandIds.ClearAllData,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      updateZCodeStdioTapDevMenuState: vi.fn(),
      onRelaunchApp: vi.fn(async () => {}),
      settingService: { get: vi.fn(async () => ({})), update: vi.fn(async () => {}) },
      credentialsDir: "/tmp/zcode-test-v2",
      currentApplicationLocale: "en-US",
    });

    // The restart exits outside exitPreparedApp, so it must release the mute itself, and only
    // after the drain settled hand control to relaunch/app.exit.
    expect(h.restore).toHaveBeenCalledTimes(1);
    expect(h.relaunch).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(0);
    expect(h.restore.mock.invocationCallOrder[0]).toBeLessThan(
      h.relaunch.mock.invocationCallOrder[0],
    );
    expect(h.restore.mock.invocationCallOrder[0]).toBeLessThan(h.exit.mock.invocationCallOrder[0]);
  });

  it("keeps the exit path untouched when the confirmation dialog is cancelled", async () => {
    h.showMessageBox.mockResolvedValueOnce({ response: 0 });

    await executeDesktopCommand({
      command: DesktopCommandIds.ClearAllData,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      updateZCodeStdioTapDevMenuState: vi.fn(),
      onRelaunchApp: vi.fn(async () => {}),
      settingService: { get: vi.fn(async () => ({})), update: vi.fn(async () => {}) },
      credentialsDir: "/tmp/zcode-test-v2",
      currentApplicationLocale: "en-US",
    });

    expect(h.restore).not.toHaveBeenCalled();
    expect(h.relaunch).not.toHaveBeenCalled();
    expect(h.exit).not.toHaveBeenCalled();
    // Cancel must not sign the user out of the Coding Plan webview or delete any data.
    expect(h.fromPartition.clearStorageData).not.toHaveBeenCalled();
    expect(h.clearBrowserData).not.toHaveBeenCalled();
    expect(h.rm).not.toHaveBeenCalled();
  });

  it("clears the webview partitions only after the user confirms", async () => {
    await executeDesktopCommand(clearAllCommand("en-US"));

    expect(h.fromPartition.clearStorageData).toHaveBeenCalled();
    expect(h.showMessageBox.mock.invocationCallOrder[0]).toBeLessThan(
      h.fromPartition.clearStorageData.mock.invocationCallOrder[0],
    );
    expect(h.rm).toHaveBeenCalledWith("/tmp/zcode-test-v2", { recursive: true, force: true });
  });

  it.each([
    ["en-US", "Clear all data?", ["Cancel", "Clear All"]],
    ["uk-UA", "Очистити всі дані?", ["Скасувати", "Очистити все"]],
    ["zh-CN", "确定要清除所有数据吗？", ["取消", "全部清除"]],
  ] as const)("shows the confirmation in the %s locale", async (locale, message, buttons) => {
    h.showMessageBox.mockResolvedValueOnce({ response: 0 });

    await executeDesktopCommand(clearAllCommand(locale));

    expect(h.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ message, buttons: [...buttons] }),
    );
  });
});

function clearAllCommand(currentApplicationLocale: "en-US" | "uk-UA" | "zh-CN") {
  return {
    command: DesktopCommandIds.ClearAllData,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    updateZCodeStdioTapDevMenuState: vi.fn(),
    onRelaunchApp: vi.fn(async () => {}),
    settingService: { get: vi.fn(async () => ({})), update: vi.fn(async () => {}) },
    credentialsDir: "/tmp/zcode-test-v2",
    currentApplicationLocale,
  };
}

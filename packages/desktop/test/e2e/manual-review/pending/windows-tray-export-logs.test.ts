import { readFile } from "node:fs/promises";
import type { Menu } from "electron";
import type { Locale } from "@zcode/shared";
import { readSettings, waitForDefaultWorkspaceReady } from "../../helpers/desktop-app.js";
import { skipOccupationOnboardingIfPresent } from "../../helpers/occupation-onboarding.js";

type TrayCapture = {
  menu?: Menu;
  restore: () => void;
};
type TrayTestGlobal = typeof globalThis & { __trayExportCapture?: TrayCapture };
type DesktopBridge = {
  zcode: { setApplicationLocale: (locale: Locale) => Promise<void> };
};

describe("Windows 托盘导出日志", () => {
  it("中英文托盘不再显示清除数据，导出恢复主窗口并生成日志包", async function () {
    if (process.platform !== "win32") this.skip();
    this.timeout(90_000);
    await skipOccupationOnboardingIfPresent();
    await waitForDefaultWorkspaceReady(30_000);
    const originalSettings = await readSettings();
    const reveal = await browser.electron.mock("shell", "showItemInFolder");
    await reveal.mockReturnValue(undefined);

    // 语言更新会重建托盘菜单；保留真实 setContextMenu，仅捕获传入的原生 Menu。
    await browser.electron.execute((electron) => {
      const target = globalThis as TrayTestGlobal;
      const original = electron.Tray.prototype.setContextMenu;
      target.__trayExportCapture = {
        restore: () => {
          electron.Tray.prototype.setContextMenu = original;
        },
      };
      electron.Tray.prototype.setContextMenu = function (menu) {
        target.__trayExportCapture!.menu = menu ?? undefined;
        return original.call(this, menu);
      };
    });

    try {
      const exportLogsLabel = "Export logs";
      const removedLabel = "Clear all data";
      await browser.execute(async () => {
        await (window as unknown as DesktopBridge).zcode.setApplicationLocale("en-US");
      });
      const labels = await browser.electron.execute(() =>
        (globalThis as TrayTestGlobal).__trayExportCapture?.menu?.items.map((item) => item.label),
      );
      expect(labels).toContain(exportLogsLabel);
      expect(labels).not.toContain(removedLabel);

      await browser.electron.execute((electron, label) => {
        const item = (globalThis as TrayTestGlobal).__trayExportCapture?.menu?.items.find(
          (entry) => entry.label === label,
        );
        const window = electron.BrowserWindow.getAllWindows().find((candidate) =>
          candidate.webContents.getURL().includes("/renderer/index.html"),
        );
        if (!item || !window) throw new Error("没有找到托盘导出日志入口或主窗口");
        window.hide();
        // 直接触发实际托盘 MenuItem 的回调；不替换命令分发或导出实现。
        item.click(item, window, {});
      }, exportLogsLabel);
      await browser.waitUntil(
        async () => {
          await reveal.update();
          return reveal.mock.calls.length === 1;
        },
        { timeout: 30_000, timeoutMsg: "托盘导出未生成日志包并请求系统定位" },
      );
      const archivePath = String(reveal.mock.calls[0]?.[0]);
      expect(archivePath).toMatch(/zcode-logs-[^/\\]+\.zip$/);
      expect((await readFile(archivePath)).subarray(0, 4).toString("hex")).toBe("504b0304");
      expect(
        await browser.electron.execute((electron) =>
          electron.BrowserWindow.getAllWindows().some(
            (window) =>
              window.webContents.getURL().includes("/renderer/index.html") && window.isVisible(),
          ),
        ),
      ).toBe(true);
    } finally {
      await browser.electron.execute(() => {
        const target = globalThis as TrayTestGlobal;
        target.__trayExportCapture?.restore();
        delete target.__trayExportCapture;
      });
      await reveal.mockRestore();
      await browser.execute(async (locale) => {
        await (window as unknown as DesktopBridge).zcode.setApplicationLocale(locale);
      }, originalSettings.locale ?? "en-US");
    }
  });
});

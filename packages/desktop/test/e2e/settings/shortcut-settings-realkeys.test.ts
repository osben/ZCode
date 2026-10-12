import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_SIDEBAR,
  TID_TASK_SETTINGS_BUTTON,
  TID_V4_COMPOSER_INPUT,
  TID_V4_SESSION_PANE,
  testId,
} from "@zcode/shared";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  quitElectronAppGracefully,
  waitForDefaultWorkspaceReady,
  waitForWorkspaceApp,
} from "../helpers/desktop-app.js";
import { sel } from "../helpers/selectors.js";

interface ShortcutSettingsShape {
  shortcutBindings?: Record<string, string[]>;
}

/**
 * Real-key E2E for shortcut settings: browser.keys() goes through CDP's real input pipeline (unlike synthetic
 * KeyboardEvents, it includes real sequences such as modifier press order and key release), covering the three scenarios reported by users:
 * 1. whether a pure Shift combination (no Ctrl/Cmd/Alt) can be recorded and take effect (SC-04);
 * 2. after a recording conflict, whether pressing a second combination directly without Escape works (SC-05);
 * 3. when the recording state receives IME composition noise events, recording the physical key by looking up event.code (SC-06, simulated with synthetic events).
 */
describe("快捷键设置真实按键 E2E", () => {
  before(async () => {
    // Clean baseline: clear any shortcutBindings overrides left over from the previous round (SC-05/SC-08 rely on default bindings to create conflicts)
    await quitElectronAppGracefully();
    await writeSettings({
      lastWorkspaceSession: [
        { kind: "local", workspacePath: DEFAULT_WORKSPACE, workspacePurpose: "project" },
      ],
      lastActiveTabIndex: 0,
      shortcutBindings: {},
    });
    await browser.reloadSession();
    await waitForDefaultWorkspaceReady(30_000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SC-04: 真实按键录制纯 Shift 组合（Shift+F）并生效", async function () {
    this.timeout(120_000);

    await openShortcutSettings();
    await clickTestIdByDom("settings-shortcut-bind-toggleSidebar-0", {
      timeout: 15_000,
      timeoutMsg: "快捷键列表没有出现 toggleSidebar 行",
    });

    await realKeys(["Shift", "F"]);
    await browser.waitUntil(
      async () => {
        const settings = await readSettings();
        return settings.shortcutBindings?.toggleSidebar?.[0] === "Shift+f";
      },
      { timeout: 15_000, timeoutMsg: "纯 Shift 组合没有写入 setting.json（录制失败或被拒绝）" },
    );

    // Real keys on the main UI: Shift+F should toggle the sidebar
    await backToWorkspace();
    await realKeys(["Shift", "F"]);
    await $(sel(TID_SIDEBAR)).waitForDisplayed({ reverse: true, timeout: 10_000 });
    await realKeys(["Shift", "F"]);
    await $(sel(TID_SIDEBAR)).waitForDisplayed({ timeout: 10_000 });
  });

  it("SC-05: 真实按键冲突后不按 Escape，直接输入第二组组合", async function () {
    this.timeout(120_000);

    await openShortcutSettings();
    await clickTestIdByDom("settings-shortcut-bind-findInTask-0", {
      timeout: 15_000,
      timeoutMsg: "快捷键列表没有出现 findInTask 行",
    });

    // First combination: Ctrl+J is taken by toggleTerminal's default → red conflict hint
    await realKeys(["Control", "j"]);
    await $(sel("settings-shortcut-error-findInTask")).waitForDisplayed({ timeout: 10_000 });

    // Second combination: press Ctrl+E directly without Escape → recording should succeed immediately and exit recording state
    await realKeys(["Control", "e"]);
    await browser.waitUntil(
      async () => {
        const settings = await readSettings();
        return settings.shortcutBindings?.findInTask?.[0] === "CmdOrCtrl+e";
      },
      {
        timeout: 15_000,
        timeoutMsg: "冲突后直接输入第二组组合没有写入 setting.json（录制态没有续上）",
      },
    );
    await $(sel("settings-shortcut-error-findInTask")).waitForDisplayed({
      reverse: true,
      timeout: 5_000,
    });
  });

  it("SC-06: 录制态收到 IME 组合事件（isComposing）仍按 event.code 录制", async function () {
    this.timeout(90_000);

    await openShortcutSettings();
    await clickTestIdByDom("settings-shortcut-bind-toggleSidePane-0", {
      timeout: 15_000,
      timeoutMsg: "快捷键列表没有出现 toggleSidePane 行",
    });

    // When a Chinese IME has focus on an editable element, Shift+G gets swallowed into composition input and the event only carries the isComposing flag;
    // recording is an explicit intent, so the kernel should look up the physical key by event.code and record Shift+g
    await dispatchKey("Process", "KeyG", { shiftKey: true, isComposing: true });
    await browser.waitUntil(
      async () => {
        const settings = await readSettings();
        return settings.shortcutBindings?.toggleSidePane?.[0] === "Shift+g";
      },
      { timeout: 15_000, timeoutMsg: "IME 组合事件没有按 event.code 录制为 Shift+g" },
    );
  });

  it("SC-07: 纯 Shift+可打印键在可编辑目标内不触发命令、不吞字符（CR-02）", async function () {
    this.timeout(120_000);

    await openShortcutSettings();
    await clickTestIdByDom("settings-shortcut-bind-toggleSidePane-0", {
      timeout: 15_000,
      timeoutMsg: "快捷键列表没有出现 toggleSidePane 行",
    });
    await realKeys(["Shift", "G"]);
    await browser.waitUntil(
      async () => {
        const settings = await readSettings();
        return settings.shortcutBindings?.toggleSidePane?.[0] === "Shift+g";
      },
      { timeout: 15_000, timeoutMsg: "纯 Shift 组合没有写入 setting.json" },
    );

    await backToWorkspace();
    // Focus into the chat input (contenteditable): pressing Shift+G should type an uppercase G,
    // and must not trigger toggleSidePane (the side pane stays collapsed) — otherwise the user cannot type uppercase letters
    await clickTestIdByDom(TID_V4_COMPOSER_INPUT, {
      timeout: 15_000,
      timeoutMsg: "没有找到聊天输入框",
    });
    await realKeys(["Shift", "G"]);

    await browser.waitUntil(
      async () => {
        const text = await $(sel(TID_V4_COMPOSER_INPUT)).getText();
        return text.includes("G");
      },
      { timeout: 10_000, timeoutMsg: "可编辑目标内 Shift+G 的字符被快捷键吞掉" },
    );
    expect(await $(sel(TID_V4_SESSION_PANE)).isDisplayed()).toBe(false);
  });

  it("SC-08: 抢绑 menu 通道默认键后原 accelerator 摘除，按键只触发新 owner（CR-03）", async function () {
    this.timeout(120_000);

    await openShortcutSettings();
    await clickTestIdByDom("settings-shortcut-bind-findInTask-0", {
      timeout: 15_000,
      timeoutMsg: "快捷键列表没有出现 findInTask 行",
    });

    // Ctrl+N is taken by newTask (menu channel) default → red conflict + "bind anyway" to steal the binding
    await realKeys(["Control", "n"]);
    await $(sel("settings-shortcut-error-findInTask")).waitForDisplayed({ timeout: 10_000 });
    await clickTestIdByDom("settings-shortcut-steal-findInTask");
    await browser.waitUntil(
      async () => {
        const settings = await readSettings();
        return (
          settings.shortcutBindings?.findInTask?.[0] === "CmdOrCtrl+n" &&
          settings.shortcutBindings?.newTask?.length === 0
        );
      },
      {
        timeout: 15_000,
        timeoutMsg: "抢绑后 findInTask 未绑上 CmdOrCtrl+n 或 newTask 未清成显式空数组",
      },
    );

    await backToWorkspace();
    const countWorkspaceItems = async () =>
      await browser.execute(
        () => document.querySelectorAll('[data-testid^="workspace-item-"]').length,
      );
    const before = await countWorkspaceItems();

    // Before the fix: the main-side ?? fallback resurrected newTask's default accelerator, so Ctrl+N triggered both
    // the menu newTask (new task) and the renderer findInTask (find popup); after the fix only the latter fires
    await realKeys(["Control", "n"]);
    await browser.waitUntil(async () => await $('[role="dialog"]').isExisting(), {
      timeout: 10_000,
      timeoutMsg: "Ctrl+N 没有触发 findInTask 查找弹窗",
    });
    await browser.keys(["Escape"]);
    expect(await countWorkspaceItems()).toBe(before);
  });

  it("SC-09: composer 作用域改绑——裸 Enter 换行不发送，CmdOrCtrl+Enter 发送（spec §12）", async function () {
    this.timeout(180_000);

    // The settings page records composerSend as CmdOrCtrl+Enter (real keys go through the recorder)
    await openShortcutSettings();
    await clickTestIdByDom("settings-shortcut-bind-composerSend-0", {
      timeout: 15_000,
      timeoutMsg: "快捷键列表没有出现 composerSend 行",
    });
    await realKeys(["Control", "Enter"]);
    await browser.waitUntil(
      async () => {
        const settings = await readSettings();
        return settings.shortcutBindings?.composerSend?.[0] === "CmdOrCtrl+Enter";
      },
      { timeout: 15_000, timeoutMsg: "composerSend 没有录制为 CmdOrCtrl+Enter" },
    );
    // 落盘 ≠ renderer 生效表已刷新：SettingsChanged 广播有亚秒级异步窗口，
    // 立即回主界面按键会踩进旧键位窗口误发送（曾致本用例偶发失败）；显式等窗口过去。
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    await backToWorkspace();
    await clickTestIdByDom(TID_V4_COMPOSER_INPUT, {
      timeout: 15_000,
      timeoutMsg: "没有找到聊天输入框",
    });
    // Bugfix: clickTestIdByDom 是 JS element.click()，对 contenteditable 不转移焦点；
    // 焦点不在 composer 时 keys 输入会落空（本用例曾因此误判"裸 Enter 吞草稿"）。显式聚焦。
    await browser.execute((inputTestId) => {
      (document.querySelector(`[data-testid="${inputTestId}"]`) as HTMLElement | null)?.focus();
    }, TID_V4_COMPOSER_INPUT);
    await browser.keys("sc9");

    // 裸 Enter：composerSend 已改绑走 → 回退换行，不发送（草稿保留）
    await realKeys(["Enter"]);
    await browser.waitUntil(
      async () => {
        const text = await $(sel(TID_V4_COMPOSER_INPUT)).getText();
        return text.includes("sc9");
      },
      { timeout: 10_000, timeoutMsg: "改绑后裸 Enter 误触发送或吞掉了草稿" },
    );

    // CmdOrCtrl+Enter：命中改绑后的发送 → 草稿清空
    await realKeys(["Control", "Enter"]);
    await browser.waitUntil(
      async () => {
        const draft = await $(sel(TID_V4_COMPOSER_INPUT)).getText();
        return !draft.includes("sc9");
      },
      { timeout: 15_000, timeoutMsg: "CmdOrCtrl+Enter 没有触发发送（草稿未清空）" },
    );
  });

  it("SC-10: 全部恢复默认有二次确认——取消保留覆盖，确认清空（spec §12.4）", async function () {
    this.timeout(120_000);

    await openShortcutSettings();
    // 前序用例留下的覆盖仍在，按钮可用；点击后弹全局确认弹窗（ConfirmDialogHost）
    await clickTestIdByDom("settings-shortcut-reset-all", {
      timeout: 15_000,
      timeoutMsg: "没有找到「全部恢复默认」按钮",
    });
    await $(sel("confirm-dialog-confirm")).waitForDisplayed({ timeout: 10_000 });

    // 取消（Esc）：覆盖保留
    await browser.keys(["Escape"]);
    await $(sel("confirm-dialog-confirm")).waitForDisplayed({ reverse: true, timeout: 10_000 });
    const settingsAfterCancel = await readSettings();
    expect(Object.keys(settingsAfterCancel.shortcutBindings ?? {}).length).toBeGreaterThan(0);

    // 再点并确认：shortcutBindings 清空，全部命令回到默认绑定
    await clickTestIdByDom("settings-shortcut-reset-all", {
      timeout: 15_000,
      timeoutMsg: "确认弹窗关闭后没找到「全部恢复默认」按钮",
    });
    await clickTestIdByDom("confirm-dialog-confirm", {
      timeout: 10_000,
      timeoutMsg: "没有出现恢复默认确认弹窗",
    });
    await browser.waitUntil(
      async () => {
        const settings = await readSettings();
        return Object.keys(settings.shortcutBindings ?? {}).length === 0;
      },
      { timeout: 15_000, timeoutMsg: "确认后 shortcutBindings 没有被清空" },
    );
  });

  it("SC-11: 工具条三键转正为可配置命令——列表可见、改绑落盘（spec §12.6）", async function () {
    this.timeout(120_000);

    await openShortcutSettings();
    // 三条工具条命令出现在列表（数据驱动，含「全局」作用域标注）
    for (const commandId of ["openModelMenu", "cycleSessionMode", "cycleThoughtLevel"]) {
      await clickTestIdByDom(`settings-shortcut-bind-${commandId}-0`, {
        timeout: 15_000,
        timeoutMsg: `快捷键列表没有出现 ${commandId} 行`,
      });
      // 进入录制态后 Escape 取消，保持循环继续
      await realKeys(["Escape"]);
    }

    // 把 openModelMenu 改绑为 Ctrl+Shift+Y：win 上录制器平台归一产出 "CmdOrCtrl+Shift+y"
    // （注意不能选 Ctrl+Y——归一后撞黑名单的 redo "CmdOrCtrl+y" 会被拒）
    await clickTestIdByDom("settings-shortcut-bind-openModelMenu-0", {
      timeout: 15_000,
      timeoutMsg: "没有找到 openModelMenu 绑定入口",
    });
    await realKeys(["Control", "Shift", "y"]);
    await browser.waitUntil(
      async () => {
        const settings = await readSettings();
        return settings.shortcutBindings?.openModelMenu?.[0] === "CmdOrCtrl+Shift+y";
      },
      { timeout: 15_000, timeoutMsg: "openModelMenu 没有录制为 CmdOrCtrl+Shift+y" },
    );
  });
});

/** 平台主修饰键感知的真实按键（macOS 用 Command）。 */
async function realKeys(keys: string[]) {
  const isMac = await browser.execute(() => /Mac|iPhone|iPad/.test(navigator.userAgent));
  const mapped = keys.map((key) => (key === "Control" && isMac ? "Command" : key));
  await browser.keys(mapped as never);
}

/** 合成 keydown 直发 window（SC-06 模拟 IME 噪声事件形态）。 */
async function dispatchKey(
  key: string,
  code: string,
  modifiers: { shiftKey?: boolean; isComposing?: boolean },
) {
  await browser.execute(
    (eventKey, eventCode, shiftKey, isComposing) => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: eventKey,
          code: eventCode,
          shiftKey,
          isComposing,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    key,
    code,
    modifiers.shiftKey ?? false,
    modifiers.isComposing ?? false,
  );
}

async function openShortcutSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15_000,
    timeoutMsg: "没有找到设置入口按钮",
  });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15_000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "shortcuts"), {
    timeout: 15_000,
    timeoutMsg: "设置页没有出现快捷键分区入口",
  });
}

async function backToWorkspace() {
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15_000,
    timeoutMsg: "设置页没有出现返回按钮",
  });
}

async function writeSettings(patch: Record<string, unknown>) {
  const settingsFile = join(getE2EAppDataPaths().appDataDir, "setting.json");
  await mkdir(join(getE2EAppDataPaths().appDataDir), { recursive: true });
  const current = await readSettings();
  await writeFile(settingsFile, JSON.stringify({ ...current, ...patch }, null, 2), "utf-8");
}

async function readSettings(): Promise<ShortcutSettingsShape> {
  try {
    return JSON.parse(
      await readFile(join(getE2EAppDataPaths().appDataDir, "setting.json"), "utf-8"),
    ) as ShortcutSettingsShape;
  } catch {
    return {};
  }
}

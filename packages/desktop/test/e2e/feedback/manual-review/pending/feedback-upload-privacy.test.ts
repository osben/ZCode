import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { TID_FEEDBACK_LOGS_OPT_IN, TID_WORKSPACE_HELP_MENU_TRIGGER } from "@zcode/shared";
import {
  readSettings,
  seedSettings,
  waitForDefaultWorkspaceReady,
} from "../../../helpers/desktop-app.js";
import {
  expectedCopy,
  startHelpConfigFixture,
} from "../../../helpers/help-client-config-fixture.js";
import { sel } from "../../../helpers/selectors.js";

async function dismissInitialOnboarding() {
  const onboarding = $('[data-testid="onboarding-page"]');
  await browser.waitUntil(
    async () =>
      (await onboarding.isExisting()) ||
      (await $(sel(TID_WORKSPACE_HELP_MENU_TRIGGER)).isExisting()),
    { timeout: 15000 },
  );
  if (await onboarding.isDisplayed()) {
    // 当前 staging 的引导按本地完成记录触发；只关窗口后刷新会重开。
    // 通过现有跳过操作完成隔离测试账号的三步引导，不改变产品实现。
    for (let step = 0; step < 3; step += 1) {
      const before = await onboarding.getText();
      await onboarding.$("footer > button").click();
      await browser.waitUntil(
        async () => !(await onboarding.isDisplayed()) || (await onboarding.getText()) !== before,
        { timeout: 15000 },
      );
      if (!(await onboarding.isDisplayed())) break;
    }
    await onboarding.waitForDisplayed({ reverse: true, timeout: 15000 });
  }
}

describe("反馈上传授权（manual review）", () => {
  let settings: Awaited<ReturnType<typeof readSettings>>;
  let server: Awaited<ReturnType<typeof startHelpConfigFixture>>;
  let windowSize:
    | { width: number; height: number; minWidth: number; minHeight: number }
    | undefined;

  before(async () => {
    await dismissInitialOnboarding();
    await waitForDefaultWorkspaceReady(30000);
    settings = await readSettings();
    windowSize = await browser.electron.execute((electron) => {
      const window = electron.BrowserWindow.getAllWindows()[0]!;
      const bounds = window.getBounds();
      const [minWidth = 0, minHeight = 0] = window.getMinimumSize();
      window.setMinimumSize(360, 400);
      return { width: bounds.width, height: bounds.height, minWidth, minHeight };
    });
    server = await startHelpConfigFixture({ feedback_use_external_form: false });
  });
  after(async () => {
    await browser.keys("Escape");
    if (settings) await seedSettings(settings);
    if (windowSize)
      await browser.electron.execute((electron, size) => {
        const window = electron.BrowserWindow.getAllWindows()[0]!;
        window.setMinimumSize(size.minWidth, size.minHeight);
        window.setSize(size.width, size.height);
      }, windowSize);
    await server?.close();
  });

  const reportIssueLabel = expectedCopy("workspaceHeader.help.issueReport");
  const logsHint = expectedCopy("feedback.submit.simple.logsHint");

  for (const [width, height] of [
    [1280, 900],
    [430, 900],
  ] as const) {
    it(`FB-PRIV-01/08: en-US ${width}px 新反馈默认开启日志且允许取消`, async () => {
      await seedSettings({
        locale: "en-US",
        localePreference: "en-US",
        zcodeEndpointOrigin: server.origin,
      });
      await browser.electron.execute(
        (electron, size) => {
          electron.BrowserWindow.getAllWindows()[0]!.setSize(size.width, size.height);
        },
        { width, height },
      );
      await browser.refresh();
      await dismissInitialOnboarding();
      await waitForDefaultWorkspaceReady(30000);
      const help = $(sel(TID_WORKSPACE_HELP_MENU_TRIGGER));
      await help.waitForDisplayed({ timeout: 10000 });
      await help.click();
      await $(`[role="menuitem"]*=${reportIssueLabel}`).click();
      const dialog = $('[role="dialog"]');
      await dialog.waitForDisplayed({ timeout: 10000 });
      const logs = $(`[data-testid="${TID_FEEDBACK_LOGS_OPT_IN}"]`);
      await expect(logs).toHaveAttribute("aria-checked", "true");
      await expect(dialog).toHaveText(expect.stringContaining(logsHint));
      expect(await dialog.$$("img").length).toBe(0);
      await logs.click();
      await expect(logs).toHaveAttribute("aria-checked", "false");
      await logs.click();
      await expect(logs).toHaveAttribute("aria-checked", "true");
      for (const theme of ["light", "dark"] as const) {
        await browser.execute((value) => {
          const actions = (
            window as typeof window & { __testActions?: { setTheme?: (theme: string) => void } }
          ).__testActions;
          if (!actions?.setTheme) throw new Error("Missing theme test action");
          actions.setTheme(value);
        }, theme);
        await logs.scrollIntoView();
        await expect(logs).toBeDisplayed();
        // E2E runtime path guard 禁止源码出现裸系统临时目录字面量，须走 tmpdir() 拼接。
        await browser.saveScreenshot(join(tmpdir(), `zcode-feedback-en-US-${width}-${theme}.png`));
      }
      await browser.keys("Escape");
    });
  }
});

// 浏览器 fixture 单独由 esbuild 打包，不向 WDIO 的 Window 类型注入产品 store 声明。
declare global {
  interface Window {
    feedbackSubmitFixture?: {
      failNextCreate(): void;
      restore(jobId: string): void;
      snapshot(): {
        calls: { create: number; prepare: number; upload: string[]; cleanup: number };
        createInputs: Array<Record<string, unknown>>;
        jobs: Array<{ id: string; status: string; includeLogs?: boolean }>;
      };
    };
  }
}

describe("FB-PRIV-02: 反馈表单到日志服务边界", () => {
  let server: Awaited<ReturnType<typeof startHelpConfigFixture>>;
  let mainHandle: string;
  let windowId: number;

  before(async () => {
    const root = resolve(import.meta.dirname, "../../../../../../..");
    const bundle = await build({
      entryPoints: [resolve(root, "packages/desktop/test/e2e/helpers/feedback-submit-fixture.js")],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      alias: { "@": resolve(root, "packages/ui/src") },
      define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"test"' },
      tsconfig: resolve(root, "packages/ui/tsconfig.json"),
    });
    // fixture 页的脚本在 head 同步执行；等 DOM 就绪后再挂载真实表单。
    server = await startHelpConfigFixture(
      {},
      `
      window.addEventListener("error", (event) => {
        document.documentElement.dataset.fixtureError = event.message;
      });
      window.addEventListener("DOMContentLoaded", () => { ${bundle.outputFiles[0]!.text} });
    `,
    );
    mainHandle = await browser.getWindowHandle();
    const existing = await browser.getWindowHandles();
    windowId = await browser.electron.execute(async (electron, url) => {
      const win = new electron.BrowserWindow({
        width: 1000,
        height: 900,
        show: false,
        // 隐藏窗口也保持回调计时稳定，避免 Chromium 后台节流影响表单完成回调。
        webPreferences: { sandbox: true, nodeIntegration: false, backgroundThrottling: false },
      });
      await win.loadURL(url);
      return win.id;
    }, server.origin);
    await browser.waitUntil(
      async () => (await browser.getWindowHandles()).length > existing.length,
    );
    const handle = (await browser.getWindowHandles()).find((item) => !existing.includes(item))!;
    await browser.switchToWindow(handle);
  });
  after(async () => {
    if (windowId)
      await browser.electron.execute(
        (electron, id) => electron.BrowserWindow.fromId(id)?.destroy(),
        windowId,
      );
    if (mainHandle) await browser.switchToWindow(mainHandle);
    await server?.close();
  });

  const snapshot = () => browser.execute(() => window.feedbackSubmitFixture!.snapshot());
  const submit = async () => {
    const previousJobs = (await snapshot()).jobs.length;
    await $("button=Submit feedback").click();
    await browser.waitUntil(
      async () => {
        const jobs = (await snapshot()).jobs;
        return jobs.length > previousJobs && ["success", "error"].includes(jobs.at(-1)!.status);
      },
      { timeout: 10000 },
    );
  };

  for (const [name, includeLogs, restore] of [
    ["默认提交", true, false],
    ["取消后提交", false, false],
    ["开启日志的后台任务恢复后重试", true, true],
    ["取消日志的后台任务恢复后重试", false, true],
  ] as const) {
    it(`${name}：验证实际归档/上传调用`, async () => {
      await browser.refresh();
      const logs = $(`[data-testid="${TID_FEEDBACK_LOGS_OPT_IN}"]`);
      await browser.waitUntil(
        async () => {
          const error = await browser.execute(() => document.documentElement.dataset.fixtureError);
          if (error) throw new Error(`Feedback fixture failed: ${error}`);
          return logs.isExisting();
        },
        { timeout: 10000 },
      );
      await expect(logs).toHaveAttribute("aria-checked", "true");
      await $("textarea").setValue("E2E_FEEDBACK_LOG_CHOICE");
      if (!includeLogs) await logs.click();
      if (restore) {
        await browser.execute(() => window.feedbackSubmitFixture!.failNextCreate());
        await submit();
        const failed = await snapshot();
        expect(failed.jobs[0]).toMatchObject({ status: "error", includeLogs });
        expect(failed.calls).toEqual({ create: 1, prepare: 0, upload: [], cleanup: 0 });
        await browser.execute(
          (id) => window.feedbackSubmitFixture!.restore(id),
          failed.jobs[0]!.id,
        );
        await expect($("textarea")).toHaveValue("E2E_FEEDBACK_LOG_CHOICE");
        await expect(logs).toHaveAttribute("aria-checked", String(includeLogs));
      }
      await submit();
      const result = await snapshot();
      expect(result.jobs.at(-1)).toMatchObject({ status: "success", includeLogs });
      expect(result.createInputs).toHaveLength(restore ? 2 : 1);
      for (const input of result.createInputs) {
        expect(input).toMatchObject({
          title: "E2E_FEEDBACK_LOG_CHOICE",
          description: expect.stringContaining("E2E_FEEDBACK_LOG_CHOICE"),
          type: "bug",
        });
      }
      if (restore) expect(result.createInputs[1]).toEqual(result.createInputs[0]);
      expect(result.calls).toEqual({
        create: restore ? 2 : 1,
        prepare: includeLogs ? 1 : 0,
        upload: includeLogs ? ["log"] : [],
        cleanup: includeLogs ? 1 : 0,
      });
    });
  }
});

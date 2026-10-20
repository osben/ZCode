import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  waitForWorkspaceApp,
} from "../../../helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../../../helpers/v4-conversation.js";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  readSSHRuntimeConfig,
  prepareSSHConnectionPage,
  selectSSHRemoteDirectory,
  waitForSSHDirectoryStep,
  waitForRemoteTab,
} from "../../../helpers/ssh-remote-p0.js";

const CASE_MARKER = "E2E_REMOTE_SETTINGS_SAFEGUARDS";
const deviceName = "RDUX-05 device";
const connectionName = "RDUX-05 connection";

async function section(name: string) {
  if (!(await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).isDisplayed()))
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, name));
}

async function clickButton(text: string, root = "[data-settings-content-frame]") {
  await browser.waitUntil(
    async () =>
      await browser.execute(
        (label, selector) => {
          const button = [
            ...(document
              .querySelector(selector)
              ?.querySelectorAll<HTMLElement>('button, [role="menuitem"]') ?? []),
          ].find(
            (item) =>
              item.textContent?.trim() === label && !item.matches(":disabled, [data-disabled]"),
          );
          if (!button) return false;
          button.click();
          return true;
        },
        text,
        root,
      ),
    { timeout: 10_000, timeoutMsg: `${CASE_MARKER}: button ${text}` },
  );
}

async function more() {
  await $('[data-settings-content-frame] button[aria-label="More"]').click();
  await $('[role="menu"]').waitForDisplayed();
}

describe(`${CASE_MARKER}: settings guardrails, connection editing and device labels`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("settings section does not show the editing hint", async function () {
    this.timeout(120_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    const artifactDir = resolve(
      process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/settings-notice",
    );
    await mkdir(artifactDir, { recursive: true });
    for (const theme of ["zai-light", "zai-dark"] as const) {
      await browser.execute((value) => {
        const actions = (
          window as Window & {
            __testActions?: { setTheme(theme: "zai-light" | "zai-dark"): void };
          }
        ).__testActions;
        if (!actions) throw new Error("Missing theme actions");
        actions.setTheme(value);
      }, theme);
      for (const width of [1400, 480]) {
        await browser.electron.execute((electron, size) => {
          const window = electron.BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
          window?.setMinimumSize(360, 600);
          window?.setSize(size, 900);
        }, width);
        for (const name of [
          "general",
          "plugin",
          "mcp",
          "skill",
          "commands",
          "hooks",
          "subagents",
        ]) {
          await section(name);
          const frame = $("[data-settings-content-frame]");
          await frame.waitForDisplayed();
          expect(await frame.getText()).not.toMatch(/Editing:/u);
          expect(await $("[data-settings-machine]").isExisting()).toBe(false);
          await browser.saveScreenshot(resolve(artifactDir, `${name}-${theme}-${width}.png`));
        }
      }
    }
  });

  it("RDUX-05 real SSH settings actions keep device, connection and project boundaries", async function () {
    this.timeout(15 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const path = config.workspacePaths[0];
    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    await openSSHRemoteDialog(CASE_MARKER);
    await fillSSHPasswordSettings(config);
    await clickLastEnabledSSHDialogButton(CASE_MARKER);
    await waitForSSHDirectoryStep(CASE_MARKER);
    await selectSSHRemoteDirectory(path, CASE_MARKER);
    await waitForWorkspaceApp(path, 120_000);
    const tab = await waitForRemoteTab({ caseMarker: CASE_MARKER, expectedPath: path });
    await browser.execute(() => {
      const actions = (
        window as Window & {
          __testActions?: { setLocale(locale: "en-US" | "uk-UA" | "zh-CN"): void };
        }
      ).__testActions;
      if (!actions) throw new Error("Missing locale actions");
      actions.setLocale("en-US");
    });
    await section("remoteDevices");
    await $('[data-remote-connection-status="online"]').waitForDisplayed();
    await clickButton("Edit");
    await $("#edit-connection-name").setValue(connectionName);
    await $("#edit-device-name").setValue(deviceName);
    expect(await $('[role="dialog"]').getText()).toContain("Takes effect next time you connect");
    await clickButton("Save changes", '[role="dialog"]');
    await $('[role="dialog"]').waitForDisplayed({ reverse: true });
    await browser.waitUntil(
      async () => (await $("[data-settings-content-frame]").getText()).includes(deviceName),
      { timeout: 10_000 },
    );
    await clickButton("Edit");
    expect(await $("#edit-connection-name").getValue()).toBe(connectionName);
    expect(await $("#edit-device-name").getValue()).toBe(deviceName);
    expect(await $('[data-testid="ssh-auth-password"]').getAttribute("aria-pressed")).toBe("true");
    const artifactDir = resolve(
      process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/remote-settings-safeguards",
    );
    await mkdir(artifactDir, { recursive: true });
    for (const locale of ["zh-CN", "en-US"] as const) {
      await browser.execute(
        (value) =>
          (
            window as Window & { __testActions?: { setLocale(value: "zh-CN" | "en-US"): void } }
          ).__testActions?.setLocale(value),
        locale,
      );
      for (const theme of ["light", "dark"]) {
        await browser.execute(
          (value) =>
            (
              window as Window & { __testActions?: { setTheme(value: string): void } }
            ).__testActions?.setTheme(value),
          theme,
        );
        for (const width of [1400, 480]) {
          await browser.electron.execute((electron, size) => {
            const window = electron.BrowserWindow.getAllWindows().find(
              (candidate) => !candidate.isDestroyed(),
            );
            window?.setMinimumSize(360, 600);
            window?.setSize(size, 900);
          }, width);
          await browser.executeAsync((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          );
          await browser.saveScreenshot(
            resolve(artifactDir, `edit-${locale}-${theme}-${width}.png`),
          );
        }
      }
    }
    await browser.execute(() =>
      (
        window as Window & { __testActions?: { setLocale(value: "zh-CN"): void } }
      ).__testActions?.setLocale("zh-CN"),
    );
    await clickButton("Cancel", '[role="dialog"]');
    await browser.electron.execute((electron) =>
      electron.BrowserWindow.getAllWindows()
        .find((candidate) => !candidate.isDestroyed())
        ?.setSize(1400, 900),
    );
    for (const name of ["plugin", "mcp", "skill", "hooks", "subagents"]) {
      await section(name);
      expect(await $("[data-settings-machine]").isExisting()).toBe(false);
      expect(await $("[data-settings-content-frame]").getText()).not.toMatch(/Editing:/u);
      const trigger = $('[data-plugin-scope-trigger="true"]');
      expect(await trigger.getText()).toContain(name === "subagents" ? "This device" : deviceName);
    }
    await section("general");
    expect(await $("[data-settings-machine]").isExisting()).toBe(false);
    expect(await $("[data-settings-content-frame]").getText()).not.toMatch(/Editing:/u);
    await section("remoteDevices");
    await more();
    await clickButton("Show in sidebar", '[role="menu"]');
    await browser.waitUntil(
      async () =>
        await browser.execute(
          (identity) =>
            document.activeElement?.closest<HTMLElement>("[data-project-workspace-identity]")
              ?.dataset.projectWorkspaceIdentity === identity,
          tab.workspaceIdentity,
        ),
      { timeout: 10_000 },
    );
    await section("remoteDevices");
    await more();
    await clickButton("Remove device", '[role="menu"]');
    await $('[role="dialog"]').waitForDisplayed();
    expect(await $('[role="dialog"]').getText()).toContain(path);
    expect(await browser.execute(() => document.activeElement?.textContent)).toContain("Cancel");
    await browser.keys("Enter");
    await $('[role="dialog"]').waitForDisplayed({ reverse: true });
    expect(await $("[data-settings-content-frame]").getText()).toContain(deviceName);
    // 任务继续提示只放在断开按钮说明上，不再常驻成一行。
    expect(
      await browser.execute(
        () =>
          [...document.querySelectorAll<HTMLButtonElement>("[data-source-server-card] button")]
            .find((button) => button.textContent?.trim() === "Disconnect")
            ?.getAttribute("title") ?? null,
      ),
    ).toContain("Remote tasks will continue running");
    await clickButton("Disconnect");
    await $('[data-remote-connection-status="offline"]').waitForDisplayed({ timeout: 20_000 });
    expect(await $('[role="dialog"]').isDisplayed()).toBe(false);
    await browser.waitUntil(
      async () =>
        (await $("[data-settings-content-frame]").getText()).includes("Last online just now"),
      { timeout: 10_000 },
    );
  });
});

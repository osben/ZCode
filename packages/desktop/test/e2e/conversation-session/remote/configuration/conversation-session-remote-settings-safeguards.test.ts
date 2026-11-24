import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import { prepareV4ConversationE2E } from "#e2e/helpers/v4-conversation";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  readSSHRuntimeConfig,
  prepareSSHConnectionPage,
  selectSSHRemoteDirectory,
  waitForSSHDirectoryStep,
  waitForRemoteTab,
} from "#e2e/helpers/ssh-remote-p0";

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

  it("RDUX-05 real SSH settings actions keep device, connection and project boundaries", async function () {
    this.timeout(15 * 60_000);
    const config = readSSHRuntimeConfig(CASE_MARKER);
    const path = config.workspacePaths[0];
    // The SSH entry runs on its own: fix the desktop viewport first so the connection wizard opens from a visible project sidebar.
    await browser.electron.execute((electron) =>
      electron.BrowserWindow.getAllWindows()
        .find((window) => !window.isDestroyed())
        ?.setSize(1400, 900),
    );
    await browser.waitUntil(() => browser.execute(() => innerWidth === 1400));
    await prepareSSHConnectionPage(CASE_MARKER);
    await prepareV4ConversationE2E({ skipProvider: true });
    if (await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).isDisplayed())
      await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    // The sidebar has its own collapse state; after restoring the size, still check that the connection entry is visible.
    if (!(await $('[data-testid="project-section"]').isDisplayed())) {
      const toggles = await $$(
        'button[aria-label="切换侧边栏"], button[aria-label="Toggle sidebar"]',
      );
      for (const toggle of toggles) {
        if (!(await toggle.isDisplayed())) continue;
        await toggle.click();
        break;
      }
      await $('[data-testid="project-section"]').waitForDisplayed();
    }
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
    // RDUX-13: Edit lives in the device row's More menu.
    await more();
    await clickButton("Edit", '[role="menu"]');
    // Keys sent while the menu was exiting once lost the connection-name prefix; focus the field with a real click first, then verify the full input.
    await $("#edit-connection-name").waitForClickable();
    await $("#edit-connection-name").click();
    await $("#edit-connection-name").setValue(connectionName);
    expect(await $("#edit-connection-name").getValue()).toBe(connectionName);
    await $("#edit-device-name").click();
    await $("#edit-device-name").setValue(deviceName);
    expect(await $("#edit-device-name").getValue()).toBe(deviceName);
    expect(await $('[role="dialog"]').getText()).toContain("Takes effect next time you connect");
    await clickButton("Save changes", '[role="dialog"]');
    await $('[role="dialog"]').waitForDisplayed({ reverse: true });
    await browser.waitUntil(
      async () => (await $("[data-settings-content-frame]").getText()).includes(deviceName),
      { timeout: 10_000 },
    );
    await more();
    await clickButton("Edit", '[role="menu"]');
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
    // The English button labels below require the en-US baseline this case uses.
    await browser.execute(() =>
      (
        window as Window & { __testActions?: { setLocale(value: "en-US"): void } }
      ).__testActions?.setLocale("en-US"),
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
      // Data sync has unified each resource's scope; subagents no longer carry the old exception that the user is always "this device".
      expect(await trigger.getText()).toContain(deviceName);
      const sourceId = parseRemoteWorkspaceIdentity(tab.workspaceIdentity!)?.sourceServerId;
      expect(sourceId).toBeTruthy();
      expect(await trigger.getAttribute("data-plugin-scope-key")).toBe(`source-user:${sourceId}`);
    }
    await section("general");
    expect(await $("[data-settings-machine]").isExisting()).toBe(false);
    expect(await $("[data-settings-content-frame]").getText()).not.toMatch(/Editing:/u);
    await section("remoteDevices");
    await more();
    await clickButton("Show in sidebar", '[role="menu"]');
    // Verify the return to the workspace per the "menu and collapse" contract of the remote device settings spec, without depending on sidebar expansion, scrolling or focus.
    await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed({ reverse: true });
    await waitForWorkspaceApp(path, 30_000);
    await section("remoteDevices");
    await more();
    await clickButton("Remove device", '[role="menu"]');
    await $('[role="dialog"]').waitForDisplayed();
    expect(await $('[role="dialog"]').getText()).toContain(path);
    expect(await browser.execute(() => document.activeElement?.textContent)).toContain("Cancel");
    await browser.keys("Enter");
    await $('[role="dialog"]').waitForDisplayed({ reverse: true });
    expect(await $("[data-settings-content-frame]").getText()).toContain(deviceName);
    // RDUX-13: Disconnect lives in the More menu; the task-continues notice stays inside the menu item and does not take up the device row.
    expect(await $("[data-settings-content-frame]").getText()).not.toContain(
      "Remote tasks will continue running",
    );
    await more();
    const disconnectItem = await browser.execute(() => {
      const item = [
        ...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]'),
      ].find((candidate) => candidate.textContent?.trim().startsWith("Disconnect"));
      const text = item?.textContent ?? null;
      item?.click();
      return text;
    });
    expect(disconnectItem).toContain("Remote tasks will continue running");
    await $('[data-remote-connection-status="offline"]').waitForDisplayed({ timeout: 20_000 });
    expect(await $('[role="dialog"]').isDisplayed()).toBe(false);
    await browser.waitUntil(
      async () =>
        (await $("[data-settings-content-frame]").getText()).includes("Last online just now"),
      { timeout: 10_000 },
    );
  });
});

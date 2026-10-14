import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  getE2EAppDataPaths,
  quitElectronAppGracefully,
  waitForDefaultWorkspaceReady,
} from "../helpers/desktop-app.js";
import { skipOccupationOnboardingIfPresent } from "../helpers/occupation-onboarding.js";

const SETTINGS_FILE = join(getE2EAppDataPaths().appDataDir, "setting.json");

describe("Appearance font family picker E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("selects an installed code font and resets to the bundled default", async function () {
    this.timeout(90000);

    await quitElectronAppGracefully();
    await clearAppData();
    await mkdir(getE2EAppDataPaths().appDataDir, { recursive: true });
    await writeFile(
      SETTINGS_FILE,
      JSON.stringify({
        locale: "en-US",
        localePreference: "en-US",
        lastWorkspaceSession: [
          { kind: "local", workspacePath: DEFAULT_WORKSPACE, workspacePurpose: "project" },
        ],
        lastActiveTabIndex: 0,
      }),
      "utf-8",
    );
    await browser.reloadSession();
    await skipOccupationOnboardingIfPresent();
    await waitForDefaultWorkspaceReady(30000);

    await browser.execute(() => {
      Object.defineProperty(window, "queryLocalFonts", {
        configurable: true,
        value: async () => [{ family: "E2E Mono" }],
      });
    });
    await clickTestId(TID_TASK_SETTINGS_BUTTON);
    await clickTestId(testId(TID_SETTINGS_SECTION_NAV, "appearance"));
    await $(
      `[data-testid="${TID_SETTINGS_PAGE}"] button[aria-label="Code font"]`,
    ).waitForDisplayed();
    await $(`[data-testid="${TID_SETTINGS_PAGE}"] button[aria-label="Code font"]`).click();
    await clickCommandOption("E2E Mono");

    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            localStorage.getItem("zcode-mono-font-family") === "E2E Mono" &&
            document.documentElement.style.getPropertyValue("--font-mono").includes("E2E Mono"),
        ),
      { timeout: 10000, timeoutMsg: "The selected font was not applied and persisted" },
    );

    await $(`[data-testid="${TID_SETTINGS_PAGE}"] button[aria-label="Code font"]`).click();
    await clickCommandOption("Default");
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            localStorage.getItem("zcode-mono-font-family") === null &&
            document.documentElement.style.getPropertyValue("--font-mono") === "" &&
            getComputedStyle(document.documentElement)
              .getPropertyValue("--font-mono")
              .includes("JetBrains Mono Variable"),
        ),
      { timeout: 10000, timeoutMsg: "Reset did not restore the bundled mono default" },
    );
  });
});

async function clickTestId(id: string): Promise<void> {
  await $(`[data-testid="${id}"]`).waitForDisplayed({ timeout: 15000 });
  await $(`[data-testid="${id}"]`).click();
}

async function clickCommandOption(label: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (expected) =>
          [...document.querySelectorAll<HTMLElement>("[role=option]")].some(
            (item) =>
              item.getBoundingClientRect().width > 0 && item.textContent?.trim() === expected,
          ),
        label,
      ),
    { timeout: 10000, timeoutMsg: `Font option did not appear: ${label}` },
  );
  const clicked = await browser.execute((expected) => {
    const option = [...document.querySelectorAll<HTMLElement>("[role=option]")].find(
      (item) => item.getBoundingClientRect().width > 0 && item.textContent?.trim() === expected,
    );
    option?.click();
    return Boolean(option);
  }, label);
  if (!clicked) {
    throw new Error(`Font option disappeared before click: ${label}`);
  }
}

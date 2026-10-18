import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_SETTINGS_OUTPUT_STYLES_DEFAULT_PROMPT,
  TID_SETTINGS_SYSTEM_PROMPT_CUSTOMIZED,
  TID_SETTINGS_SYSTEM_PROMPT_DIFF,
  TID_SETTINGS_SYSTEM_PROMPT_EDIT,
  TID_SETTINGS_SYSTEM_PROMPT_EDITOR,
  TID_SETTINGS_SYSTEM_PROMPT_RESTORE,
  TID_SETTINGS_SYSTEM_PROMPT_ROW,
  TID_SETTINGS_SYSTEM_PROMPT_SAVE,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  waitForDefaultWorkspaceReady,
  waitForWorkspaceApp,
  DEFAULT_WORKSPACE,
} from "../../../helpers/desktop-app.js";
import { skipOccupationOnboardingIfPresent } from "../../../helpers/occupation-onboarding.js";
import { sel } from "../../../helpers/selectors.js";

const OVERRIDE_FILE = join(
  getE2EAppDataPaths().homeDir,
  ".zcode",
  "system-prompt",
  "cli-prefix.md",
);
const CUSTOM_PREFIX = "You are the E2E customized ZCode agent.";

describe("System Prompt Settings E2E", () => {
  before(async () => {
    await clearAppData();
    await skipOccupationOnboardingIfPresent();
    await waitForDefaultWorkspaceReady(30_000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SP-01: edits a whitelisted section and restores its built-in default", async function () {
    this.timeout(90_000);

    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
      timeout: 15_000,
      timeoutMsg: "Settings entry did not appear",
    });
    await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15_000 });
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "systemPrompt"), {
      timeout: 15_000,
      timeoutMsg: "System Prompts section did not appear in Settings navigation",
    });

    const editableKeys = [
      "cli-prefix",
      "identity-intro",
      "harness",
      "communication",
      "memory-guidance",
      "context-management",
      "memory-extraction",
      "memory-dream",
    ];
    await browser.waitUntil(
      async () => await $(sel(testId(TID_SETTINGS_SYSTEM_PROMPT_ROW, "cli-prefix"))).isDisplayed(),
      { timeout: 15_000, timeoutMsg: "System Prompt sections did not load" },
    );
    for (const key of editableKeys) {
      expect(await $(sel(testId(TID_SETTINGS_SYSTEM_PROMPT_ROW, key))).isExisting()).toBe(true);
    }
    expect(
      await browser.execute(
        () => document.querySelectorAll('[data-testid^="settings-system-prompt-row-"]').length,
      ),
    ).toBe(editableKeys.length);

    await clickTestIdByDom(testId(TID_SETTINGS_SYSTEM_PROMPT_EDIT, "cli-prefix"));
    const editor = $(sel(testId(TID_SETTINGS_SYSTEM_PROMPT_EDITOR, "cli-prefix")));
    await editor.waitForDisplayed({ timeout: 10_000 });
    await editor.setValue(CUSTOM_PREFIX);
    await $(sel(testId(TID_SETTINGS_SYSTEM_PROMPT_DIFF, "cli-prefix"))).waitForDisplayed({
      timeout: 10_000,
    });
    await clickTestIdByDom(testId(TID_SETTINGS_SYSTEM_PROMPT_SAVE, "cli-prefix"));

    await browser.waitUntil(
      async () => {
        try {
          return (await readFile(OVERRIDE_FILE, "utf-8")) === CUSTOM_PREFIX;
        } catch {
          return false;
        }
      },
      { timeout: 15_000, timeoutMsg: "System prompt override was not written on the local host" },
    );
    await $(sel(testId(TID_SETTINGS_SYSTEM_PROMPT_CUSTOMIZED, "cli-prefix"))).waitForDisplayed({
      timeout: 10_000,
    });

    await clickTestIdByDom(testId(TID_SETTINGS_SYSTEM_PROMPT_RESTORE, "cli-prefix"));
    await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM, {
      timeout: 10_000,
      timeoutMsg: "Restore confirmation was not shown",
    });
    await browser.waitUntil(
      async () => {
        try {
          await access(OVERRIDE_FILE);
          return false;
        } catch {
          return true;
        }
      },
      { timeout: 15_000, timeoutMsg: "Restore default did not delete the override file" },
    );
    expect(
      await $(sel(testId(TID_SETTINGS_SYSTEM_PROMPT_CUSTOMIZED, "cli-prefix"))).isExisting(),
    ).toBe(false);

    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "outputStyles"));
    const defaultStyleRow = await browser.$(
      '[data-testid="settings-output-styles-row"][data-style-id="default"]',
    );
    await defaultStyleRow.waitForDisplayed({ timeout: 10_000 });
    expect(
      await defaultStyleRow
        .$(`[data-testid="${TID_SETTINGS_OUTPUT_STYLES_DEFAULT_PROMPT}"]`)
        .getText(),
    ).toContain("No additional output-style instructions");
    expect(await defaultStyleRow.$("button*=Edit").isExisting()).toBe(false);
    expect(await defaultStyleRow.$("button*=Delete").isExisting()).toBe(false);
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
  });
});

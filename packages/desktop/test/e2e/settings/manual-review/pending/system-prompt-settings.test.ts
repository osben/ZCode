import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  TID_SETTINGS_SYSTEM_PROMPT_DISK_CHANGED,
  TID_SETTINGS_SYSTEM_PROMPT_DIRTY,
  TID_SETTINGS_SYSTEM_PROMPT_DIRTY_NOTE,
  TID_SETTINGS_SYSTEM_PROMPT_DISK_OVERWRITE,
  TID_SETTINGS_SYSTEM_PROMPT_DISK_RELOAD,
  TID_SETTINGS_SYSTEM_PROMPT_RESTORE,
  TID_SETTINGS_SYSTEM_PROMPT_RESTORE_CONFIRM,
  TID_SETTINGS_SYSTEM_PROMPT_RESTORE_CONFIRM_ACTION,
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
    await $(sel(testId(TID_SETTINGS_SYSTEM_PROMPT_RESTORE_CONFIRM, "cli-prefix"))).waitForDisplayed(
      {
        timeout: 10_000,
        timeoutMsg: "Restore confirmation was not shown",
      },
    );
    await clickTestIdByDom(testId(TID_SETTINGS_SYSTEM_PROMPT_RESTORE_CONFIRM_ACTION, "cli-prefix"));
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

  // Not run in this round: the desktop E2E harness needs a built app. Written against the
  // inline-editor flow in specs/system-prompt-settings.md (SP-02 to SP-04).
  async function openCliPrefixEditor(): Promise<void> {
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
      timeout: 15_000,
      timeoutMsg: "Settings entry did not appear",
    });
    await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15_000 });
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "systemPrompt"), {
      timeout: 15_000,
      timeoutMsg: "System Prompts section did not appear in Settings navigation",
    });
    await clickTestIdByDom(testId(TID_SETTINGS_SYSTEM_PROMPT_EDIT, "cli-prefix"));
    await $(sel(testId(TID_SETTINGS_SYSTEM_PROMPT_EDITOR, "cli-prefix"))).waitForDisplayed({
      timeout: 10_000,
    });
  }

  async function restoreCliPrefixDefault(): Promise<void> {
    await clickTestIdByDom(testId(TID_SETTINGS_SYSTEM_PROMPT_RESTORE, "cli-prefix"));
    await clickTestIdByDom(testId(TID_SETTINGS_SYSTEM_PROMPT_RESTORE_CONFIRM_ACTION, "cli-prefix"));
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
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
  }

  it("SP-02: the editor opens inline, Ctrl+S saves, Esc asks before discarding, and other rows stay blocked while dirty", async function () {
    this.timeout(90_000);
    await openCliPrefixEditor();
    const editor = $(sel(testId(TID_SETTINGS_SYSTEM_PROMPT_EDITOR, "cli-prefix")));
    expect(
      await browser.execute(
        (testIdValue) => document.activeElement?.getAttribute("data-testid") === testIdValue,
        testId(TID_SETTINGS_SYSTEM_PROMPT_EDITOR, "cli-prefix"),
      ),
    ).toBe(true);

    await editor.setValue(CUSTOM_PREFIX);
    expect(await $(sel(testId(TID_SETTINGS_SYSTEM_PROMPT_DIRTY, "cli-prefix"))).isExisting()).toBe(
      true,
    );
    expect(await $(sel(TID_SETTINGS_SYSTEM_PROMPT_DIRTY_NOTE)).isExisting()).toBe(true);
    expect(await $(sel(testId(TID_SETTINGS_SYSTEM_PROMPT_EDIT, "harness"))).isEnabled()).toBe(
      false,
    );

    await browser.keys(["Control", "s"]);
    await browser.waitUntil(
      async () => {
        try {
          return (await readFile(OVERRIDE_FILE, "utf-8")) === CUSTOM_PREFIX;
        } catch {
          return false;
        }
      },
      { timeout: 15_000, timeoutMsg: "Ctrl+S did not save the override" },
    );

    await clickTestIdByDom(testId(TID_SETTINGS_SYSTEM_PROMPT_EDIT, "cli-prefix"));
    await editor.waitForDisplayed({ timeout: 10_000 });
    await editor.setValue("Another draft");
    await browser.keys(["Escape"]);
    await $(sel(TID_CONFIRM_DIALOG_CONFIRM)).waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: "Esc on a dirty draft did not ask before discarding",
    });
    await browser.keys(["Escape"]);
    expect(await editor.getValue()).toBe("Another draft");

    await browser.keys(["Escape"]);
    await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM, {
      timeout: 10_000,
      timeoutMsg: "Discard confirmation was not shown",
    });
    await restoreCliPrefixDefault();
  });

  it("SP-03: an external edit while the editor is open shows the disk-changed state; Overwrite saves the draft", async function () {
    this.timeout(90_000);
    const EXTERNAL_PREFIX = "You are the externally edited ZCode agent.";
    const DRAFT = "My unsaved draft.";
    await openCliPrefixEditor();
    const editor = $(sel(testId(TID_SETTINGS_SYSTEM_PROMPT_EDITOR, "cli-prefix")));
    await editor.setValue(DRAFT);

    await mkdir(dirname(OVERRIDE_FILE), { recursive: true });
    await writeFile(OVERRIDE_FILE, EXTERNAL_PREFIX, "utf-8");
    await browser.execute(() => window.dispatchEvent(new Event("focus")));
    await $(sel(TID_SETTINGS_SYSTEM_PROMPT_DISK_CHANGED)).waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: "Disk-changed state did not appear after the file changed",
    });
    await clickTestIdByDom(TID_SETTINGS_SYSTEM_PROMPT_DISK_OVERWRITE);
    await browser.waitUntil(
      async () => {
        try {
          return (await readFile(OVERRIDE_FILE, "utf-8")) === DRAFT;
        } catch {
          return false;
        }
      },
      { timeout: 15_000, timeoutMsg: "Overwrite did not write the draft" },
    );
    await restoreCliPrefixDefault();
  });

  it("SP-04: Reload from disk discards the draft and adopts the external text", async function () {
    this.timeout(90_000);
    const EXTERNAL_PREFIX = "You are the reloaded ZCode agent.";
    await openCliPrefixEditor();
    const editor = $(sel(testId(TID_SETTINGS_SYSTEM_PROMPT_EDITOR, "cli-prefix")));
    await editor.setValue("Draft to discard.");

    await mkdir(dirname(OVERRIDE_FILE), { recursive: true });
    await writeFile(OVERRIDE_FILE, EXTERNAL_PREFIX, "utf-8");
    await browser.execute(() => window.dispatchEvent(new Event("focus")));
    await $(sel(TID_SETTINGS_SYSTEM_PROMPT_DISK_CHANGED)).waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: "Disk-changed state did not appear after the file changed",
    });
    await clickTestIdByDom(TID_SETTINGS_SYSTEM_PROMPT_DISK_RELOAD);
    await browser.waitUntil(async () => (await editor.getValue()) === EXTERNAL_PREFIX, {
      timeout: 10_000,
      timeoutMsg: "Reload from disk did not adopt the external text",
    });
    await restoreCliPrefixDefault();
  });
});

// Settings → Quick prompts (specs/composer-quick-prompts.md rule 20). Outside the conversation-session admission
// harness, like the other Settings specs. No provider request: the composer is only used to reach the shell.
import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  clickTestIdByWebDriver,
  setInputValueByTestIdDom,
} from "../helpers/desktop-app.js";
import { sel } from "../helpers/selectors.js";
import { prepareV4ConversationE2E } from "../helpers/v4-conversation.js";

const SECTION_NAV_ID = testId(TID_SETTINGS_SECTION_NAV, "quickPrompts");
const ALPHA = "settings alpha";
const BETA = "settings beta";

type Scope = "global" | "project";

describe("Settings quick prompts", () => {
  before(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    await openQuickPromptsSettings();
  });
  after(async () => {
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15000 }).catch(() => undefined);
    await clearAppData();
  });

  it("creates two global quick prompts from the Global list", async () => {
    await createQuickPrompt("global", ALPHA, "alpha body");
    await createQuickPrompt("global", BETA, "beta body");
    expect(await rowNames("global")).toEqual([ALPHA, BETA]);
  });

  it("toggles Pinned on a row and reflects the new state in aria-checked", async () => {
    const before = await readSwitch(ALPHA, "quick-prompts-settings-pinned");
    await toggleSwitch(ALPHA, "quick-prompts-settings-pinned");
    await browser.waitUntil(
      async () => (await readSwitch(ALPHA, "quick-prompts-settings-pinned")) !== before,
      { timeout: 10000, timeoutMsg: "Pinned switch did not change state" },
    );
    await toggleSwitch(ALPHA, "quick-prompts-settings-pinned");
    await browser.waitUntil(
      async () => (await readSwitch(ALPHA, "quick-prompts-settings-pinned")) === before,
      { timeout: 10000, timeoutMsg: "Pinned switch did not switch back" },
    );
  });

  it("hides a global quick prompt in the current project through Shown in <project>", async () => {
    const before = await readSwitch(ALPHA, "quick-prompts-settings-shown");
    await toggleSwitch(ALPHA, "quick-prompts-settings-shown");
    await browser.waitUntil(
      async () => (await readSwitch(ALPHA, "quick-prompts-settings-shown")) !== before,
      { timeout: 10000, timeoutMsg: "Shown in project switch did not change state" },
    );
    await toggleSwitch(ALPHA, "quick-prompts-settings-shown");
    await browser.waitUntil(
      async () => (await readSwitch(ALPHA, "quick-prompts-settings-shown")) === before,
      { timeout: 10000, timeoutMsg: "Shown in project switch did not switch back" },
    );
  });

  it("reorders the Global list by dragging a row above another row", async () => {
    await dragRowAbove(BETA, ALPHA);
    await browser.waitUntil(
      async () => (await rowNames("global")).join("|") === [BETA, ALPHA].join("|"),
      {
        timeout: 10000,
        timeoutMsg: "dragging the row did not reorder the Global list",
      },
    );
  });

  it("deletes a quick prompt from the row menu after confirmation", async () => {
    await openRowMenu(BETA);
    await clickTestIdByWebDriver("quick-prompts-settings-menu-delete", { timeout: 10000 });
    await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM, { timeout: 10000 });
    await browser.waitUntil(async () => !(await rowNames("global")).includes(BETA), {
      timeout: 10000,
      timeoutMsg: "deleted quick prompt is still listed",
    });
    expect(await rowNames("global")).toEqual([ALPHA]);
  });
});

async function openQuickPromptsSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15000,
    timeoutMsg: "no settings entry button",
  });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });
  await clickTestIdByDom(SECTION_NAV_ID, {
    timeout: 15000,
    timeoutMsg: "Settings has no Quick prompts section entry",
  });
  await $(sel("quick-prompts-settings-section")).waitForDisplayed({ timeout: 15000 });
}

/** Creates a quick prompt through the "+ New quick prompt" button of one list, filling the editor dialog. */
async function createQuickPrompt(scope: Scope, name: string, body: string) {
  await browser.execute((currentScope: string) => {
    const button = document.querySelector<HTMLElement>(
      `[data-testid="quick-prompts-settings-new"][data-scope="${currentScope}"]`,
    );
    if (!button) throw new Error(`no new quick prompt button for ${currentScope}`);
    button.click();
  }, scope);
  await setInputValueByTestIdDom("quick-prompt-editor-name", name, { timeout: 15000 });
  // The body is the dialog's Lexical editor; it has no test id, so it is typed through the real focus path.
  const bodyEditor = await $('[role="dialog"] [contenteditable="true"]');
  await bodyEditor.waitForDisplayed({ timeout: 15000 });
  await bodyEditor.click();
  await browser.keys(body);
  await clickTestIdByDom(`quick-prompt-editor-scope-${scope}`, { timeout: 10000 });
  await clickTestIdByDom("quick-prompt-editor-save", { timeout: 10000 });
  await browser.waitUntil(async () => (await rowNames(scope)).includes(name), {
    timeout: 15000,
    timeoutMsg: `created quick prompt is not listed: ${name}`,
  });
}

async function rowNames(scope: Scope): Promise<string[]> {
  return browser.execute((currentScope: string) => {
    return Array.from(
      document.querySelectorAll<HTMLElement>(
        `[data-testid="quick-prompts-settings-list"][data-scope="${currentScope}"] [data-testid="quick-prompts-settings-row"]`,
      ),
    ).map((row) => row.dataset.promptName ?? "");
  }, scope);
}

async function readSwitch(name: string, switchTestId: string): Promise<boolean> {
  return browser.execute(
    (rowName: string, currentTestId: string) => {
      const row = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="quick-prompts-settings-row"]'),
      ).find((candidate) => candidate.dataset.promptName === rowName);
      const toggle = row?.querySelector<HTMLElement>(`[data-testid="${currentTestId}"]`);
      if (!toggle) throw new Error(`switch ${currentTestId} missing in row ${rowName}`);
      return toggle.getAttribute("aria-checked") === "true";
    },
    name,
    switchTestId,
  );
}

async function toggleSwitch(name: string, switchTestId: string) {
  await browser.execute(
    (rowName: string, currentTestId: string) => {
      const row = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="quick-prompts-settings-row"]'),
      ).find((candidate) => candidate.dataset.promptName === rowName);
      const toggle = row?.querySelector<HTMLElement>(`[data-testid="${currentTestId}"]`);
      if (!toggle) throw new Error(`switch ${currentTestId} missing in row ${rowName}`);
      toggle.click();
    },
    name,
    switchTestId,
  );
}

/**
 * Opens a row's "..." menu through the real WebDriver pointer chain. Radix DropdownMenu opens on pointerdown;
 * an item clicked right after a synthetic pointerdown open did not fire onSelect, so the item is clicked
 * through WebDriver too, once it is clickable.
 */
async function openRowMenu(name: string) {
  const trigger = $(
    `[data-testid="quick-prompts-settings-row"][data-prompt-name="${name}"] [data-testid="quick-prompts-settings-menu"]`,
  );
  await trigger.waitForClickable({
    timeout: 10000,
    timeoutMsg: `menu trigger missing in row ${name}`,
  });
  await trigger.click();
}

/**
 * Drags a row over another row by its grip handle (quick-prompts-settings-drag, the dnd-kit activator), using
 * the real pointer chain: dnd-kit's PointerSensor needs a 6px move before it starts the drag.
 * Coordinates come from viewport rectangles, as in the other drag specs.
 */
async function dragRowAbove(movingName: string, targetName: string) {
  const positions = await browser.execute(
    (moving: string, target: string) => {
      const rowOf = (value: string) =>
        Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid="quick-prompts-settings-row"]'),
        ).find((candidate) => candidate.dataset.promptName === value);
      const grip = rowOf(moving)?.querySelector<HTMLElement>(
        '[data-testid="quick-prompts-settings-drag"]',
      );
      const to = rowOf(target)?.getBoundingClientRect();
      const from = grip?.getBoundingClientRect();
      if (!from || !to) return null;
      return {
        startX: Math.round(from.left + from.width / 2),
        startY: Math.round(from.top + from.height / 2),
        endX: Math.round(from.left + from.width / 2),
        endY: Math.round(to.top + 4),
      };
    },
    movingName,
    targetName,
  );
  if (!positions) throw new Error("quick prompt rows or grip handle for drag are missing");

  await browser.performActions([
    {
      id: "quick-prompt-row-drag-pointer",
      type: "pointer",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", duration: 0, x: positions.startX, y: positions.startY },
        { type: "pointerDown", button: 0 },
        { type: "pause", duration: 80 },
        { type: "pointerMove", duration: 120, x: positions.startX, y: positions.startY - 10 },
        { type: "pointerMove", duration: 260, x: positions.endX, y: positions.endY },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await browser.releaseActions();
}

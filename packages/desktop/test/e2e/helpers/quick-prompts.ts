// Shared DOM helpers for composer quick prompt E2E (specs/composer-quick-prompts.md).
// Test ids are owned by packages/ui/src/quick-prompts; keep them in sync with that module.
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import { clickTestIdByDom, setInputValueByTestIdDom } from "./desktop-app.js";

export const QUICK_PROMPT_CHIP_TEST_ID = "quick-prompt-chip";
const COMPOSER_INPUT_SELECTOR = `[data-testid="${TID_V4_COMPOSER_INPUT}"]`;

/** Reads the visible text of the composer editor. */
export async function composerText(): Promise<string> {
  return browser.execute((selector: string) => {
    return document.querySelector<HTMLElement>(selector)?.textContent ?? "";
  }, COMPOSER_INPUT_SELECTOR);
}

/** Counts mention chips in the composer; mentions are serialized with a data-mention-id attribute. */
export async function composerMentionCount(): Promise<number> {
  return browser.execute((selector: string) => {
    return (
      document.querySelector<HTMLElement>(selector)?.querySelectorAll("[data-mention-id]").length ??
      0
    );
  }, COMPOSER_INPUT_SELECTOR);
}

/** Labels of every quick prompt chip currently in the composer row. */
export async function chipLabels(): Promise<string[]> {
  return browser.execute((testId: string) => {
    return Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)).map(
      (chip) => chip.textContent?.trim() ?? "",
    );
  }, QUICK_PROMPT_CHIP_TEST_ID);
}

/**
 * The color label dot of a chip (data-color), or null only when the chip has no dot element (spec rule 23).
 * A dot without data-color returns "", so a lingering dot never passes a `=== null` "no color" check.
 */
export async function chipColor(label: string): Promise<string | null> {
  return browser.execute(
    (testId: string, chipLabel: string) => {
      const chip = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
      ).find((candidate) => candidate.textContent?.trim() === chipLabel);
      if (!chip) throw new Error(`quick prompt chip not found: ${chipLabel}`);
      const dot = chip.querySelector("[data-testid=quick-prompt-color-dot]");
      if (!dot) return null;
      return dot.getAttribute("data-color") ?? "";
    },
    QUICK_PROMPT_CHIP_TEST_ID,
    label,
  );
}

/**
 * Clicks the first chip with the given label. The send modifier (Cmd on macOS, Ctrl elsewhere) is
 * set on the click event itself, because the chip's onClick reads it (QuickPromptBar.tsx).
 */
export async function clickChip(label: string, options: { send?: boolean } = {}) {
  await browser.execute(
    (testId: string, chipLabel: string, send: boolean) => {
      const chip = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
      ).find((candidate) => candidate.textContent?.trim() === chipLabel);
      if (!chip) throw new Error(`quick prompt chip not found: ${chipLabel}`);
      const apple = /mac/i.test(navigator.platform);
      chip.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          metaKey: send && apple,
          ctrlKey: send && !apple,
        }),
      );
    },
    QUICK_PROMPT_CHIP_TEST_ID,
    label,
    options.send === true,
  );
}

/** Opens the right-click menu of a chip. Radix ContextMenu listens to the contextmenu event. */
export async function openChipContextMenu(label: string) {
  await browser.execute(
    (testId: string, chipLabel: string) => {
      const chip = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
      ).find((candidate) => candidate.textContent?.trim() === chipLabel);
      if (!chip) throw new Error(`quick prompt chip not found: ${chipLabel}`);
      chip.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    },
    QUICK_PROMPT_CHIP_TEST_ID,
    label,
  );
}

/** Whether a scope button of the Save draft popover is disabled. */
export async function isSaveScopeDisabled(scope: "global" | "project"): Promise<boolean> {
  return browser.execute((testId: string) => {
    const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    return button?.disabled === true;
  }, `quick-prompt-save-scope-${scope}`);
}

/**
 * Saves the composer draft through the Save draft popover. When scope is omitted the popover default
 * applies (project for a session with a project).
 */
export async function saveDraftAsQuickPrompt(name: string, scope?: "global" | "project") {
  await clickTestIdByDom("quick-prompt-save-draft");
  await setInputValueByTestIdDom("quick-prompt-save-name", name, { timeout: 10000 });
  if (scope) {
    await clickTestIdByDom(`quick-prompt-save-scope-${scope}`);
  }
  await clickTestIdByDom("quick-prompt-save-submit");
}

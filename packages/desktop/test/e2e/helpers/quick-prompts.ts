// Shared DOM helpers for composer quick prompt E2E (specs/composer-quick-prompts.md).
// Test ids are owned by packages/ui/src/quick-prompts; keep them in sync with that module.
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import { clickTestIdByDom, setInputValueByTestIdDom, waitForTestIdByDom } from "./desktop-app.js";

export const QUICK_PROMPT_CHIP_TEST_ID = "quick-prompt-chip";
const COMPOSER_INPUT_SELECTOR = `[data-testid="${TID_V4_COMPOSER_INPUT}"]`;

/** Reads the visible text of the composer editor. */
export async function composerText(): Promise<string> {
  return browser.execute((selector: string) => {
    return document.querySelector<HTMLElement>(selector)?.textContent ?? "";
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

/** Whether a scope button of the quick prompt editor is disabled. */
export async function isEditorScopeDisabled(scope: "global" | "project"): Promise<boolean> {
  return browser.execute((testId: string) => {
    const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    return button?.disabled === true;
  }, `quick-prompt-editor-scope-${scope}`);
}

/** Opens the editor from the row's "+" chip (spec rule 3) and waits for its Lexical body. */
export async function openQuickPromptCreateEditor() {
  await clickTestIdByDom("quick-prompt-add");
  await waitForTestIdByDom("quick-prompt-editor-body", { timeout: 10000 });
}

/**
 * Creates a quick prompt through the "+" chip and the editor. When scope is omitted the editor default
 * applies (project for a session with a project).
 */
export async function createQuickPrompt(name: string, body: string, scope?: "global" | "project") {
  await openQuickPromptCreateEditor();
  await setInputValueByTestIdDom("quick-prompt-editor-name", name, { timeout: 10000 });
  await setInputValueByTestIdDom("quick-prompt-editor-body", body, {
    stabilizeLexicalCaretAtEnd: true,
    timeout: 15000,
  });
  if (scope) {
    await clickTestIdByDom(`quick-prompt-editor-scope-${scope}`);
  }
  await clickTestIdByDom("quick-prompt-editor-save");
}

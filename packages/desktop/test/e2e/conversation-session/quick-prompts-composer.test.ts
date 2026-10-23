// Composer quick prompts (specs/composer-quick-prompts.md): acceptance scenarios 1, 2, 4, 5 and 7, and the
// insert-only half of scenario 3. None of them submits a prompt, so this case makes no provider request
// (providerRequestPolicy "none"; afterEach asserts the capture is empty).
// The send half of scenario 3 (empty draft + Cmd-click submits) needs a recorded provider fixture and lives in
// manual-review/pending/quick-prompts-composer-send.test.ts. Scenario 10 (mobile remote) is not covered here.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_PROMPT_SUGGESTION_PANEL, TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  setInputValueByTestIdDom,
} from "../helpers/desktop-app.js";
import {
  chipLabels,
  clickChip,
  composerMentionCount,
  composerText,
  isSaveScopeDisabled,
  openChipContextMenu,
  saveDraftAsQuickPrompt,
} from "../helpers/quick-prompts.js";
import {
  clickV4SlashOption,
  prepareV4ConversationE2E,
  waitForV4MentionOptionPrefix,
} from "../helpers/v4-conversation.js";

const PROJECT_PROMPT_NAME = "review the diff";
const GLOBAL_PROMPT_NAME = "summarize the change";
const MENTION_PROMPT_NAME = "explain the mention";
const MENTION_FILE_NAME = "quick-prompt-mention-target.md";
const MENTION_QUERY = "quick-prompt-mention-target";

describe("composer quick prompts", () => {
  before(async () => {
    // Opens the fixture project draft (ZCodeProject) so that a Save draft from this session is project-scoped.
    await prepareV4ConversationE2E();
  });
  afterEach(async () => {
    await assertNoProviderRequests();
  });
  after(async () => {
    await clearAppData();
  });

  it("scenario 1: first run shows no chips, and a saved project quick prompt appears in the row", async () => {
    expect(await chipLabels()).toEqual([]);
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, PROJECT_PROMPT_NAME, {
      stabilizeLexicalCaretAtEnd: true,
      timeout: 15000,
    });
    await saveDraftAsQuickPrompt(PROJECT_PROMPT_NAME);
    await browser.waitUntil(async () => (await chipLabels()).includes(PROJECT_PROMPT_NAME), {
      timeout: 10000,
    });
  });

  it("scenario 2: a click inserts at the caret and does not open the slash panel", async () => {
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "before after", {
      stabilizeLexicalCaretAtEnd: true,
      timeout: 15000,
    });
    await clickChip(PROJECT_PROMPT_NAME);
    const text = await composerText();
    expect(text).toContain(PROJECT_PROMPT_NAME);
    expect(text).toContain("before");
    const panelOpen = await browser.execute(
      (testId: string) => Boolean(document.querySelector(`[data-testid="${testId}"]`)),
      TID_PROMPT_SUGGESTION_PANEL,
    );
    expect(panelOpen).toBe(false);
  });

  it("scenario 3 (insert half): Cmd-click with a non-empty draft only inserts and keeps the draft", async () => {
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "typed first", {
      stabilizeLexicalCaretAtEnd: true,
      timeout: 15000,
    });
    await clickChip(PROJECT_PROMPT_NAME, { send: true });
    // The draft is still in the composer, so the modifier click did not submit it.
    const text = await composerText();
    expect(text).toContain("typed first");
    expect(text).toContain(PROJECT_PROMPT_NAME);
  });

  it("scenario 4: '/' lists quick prompts and Enter replaces the typed token", async () => {
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/review", {
      stabilizeLexicalCaretAtEnd: true,
      timeout: 15000,
    });
    await browser.waitUntil(
      async () =>
        browser.execute(
          (testId: string) => Boolean(document.querySelector(`[data-testid="${testId}"]`)),
          TID_PROMPT_SUGGESTION_PANEL,
        ),
      { timeout: 10000 },
    );
    await browser.keys(["Enter"]);
    const text = await composerText();
    expect(text).not.toContain("/review");
    expect(text).toContain(PROJECT_PROMPT_NAME);
  });

  it("scenario 5: a draft with an @file mention disables Global and saves as a project quick prompt", async () => {
    // The mention is picked from the real "@" panel, so the saved content holds a file mention chip.
    await writeFile(join(DEFAULT_WORKSPACE, MENTION_FILE_NAME), "# quick prompt mention target\n");
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", { timeout: 15000 });
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, `@${MENTION_QUERY}`, {
      stabilizeLexicalCaretAtEnd: true,
      timeout: 15000,
    });
    const fileOptionId = await waitForV4MentionOptionPrefix("file:");
    expect(await clickV4SlashOption(fileOptionId)).toBe(true);
    await browser.waitUntil(async () => (await composerMentionCount()) >= 1, {
      timeout: 10000,
      timeoutMsg: "picking the @file entry did not insert a mention chip",
    });

    await clickTestIdByDom("quick-prompt-save-draft");
    await browser.waitUntil(async () => isSaveScopeDisabled("global"), {
      timeout: 10000,
      timeoutMsg: "Global stayed enabled for a draft with an @file mention",
    });
    expect(await isSaveScopeDisabled("project")).toBe(false);
    await setInputValueByTestIdDom("quick-prompt-save-name", MENTION_PROMPT_NAME, {
      timeout: 10000,
    });
    await clickTestIdByDom("quick-prompt-save-submit");
    await browser.waitUntil(async () => (await chipLabels()).includes(MENTION_PROMPT_NAME), {
      timeout: 10000,
    });
  });

  it("scenario 7: editing a global quick prompt from a session shows the global banner", async () => {
    // The chip from scenario 1 is project-scoped, so this scenario saves its own global prompt.
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, GLOBAL_PROMPT_NAME, {
      stabilizeLexicalCaretAtEnd: true,
      timeout: 15000,
    });
    await saveDraftAsQuickPrompt(GLOBAL_PROMPT_NAME, "global");
    await browser.waitUntil(async () => (await chipLabels()).includes(GLOBAL_PROMPT_NAME), {
      timeout: 10000,
    });

    await openChipContextMenu(GLOBAL_PROMPT_NAME);
    await clickTestIdByDom("quick-prompt-menu-edit");
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          Boolean(document.querySelector('[data-testid="quick-prompt-banner-global"]')),
        ),
      { timeout: 10000 },
    );
    // The editor has no Cancel button; Escape closes the Radix dialog without saving.
    await browser.keys(["Escape"]);
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => !document.querySelector('[data-testid="quick-prompt-banner-global"]'),
        ),
      { timeout: 10000, timeoutMsg: "Escape did not close the quick prompt editor" },
    );
  });
});

/** Fails when the provider capture recorded any request; a missing capture file is not treated as zero. */
async function assertNoProviderRequests() {
  const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
  if (!capturePath) {
    throw new Error("Provider capture path is required for the no-request assertion");
  }
  const capture = JSON.parse(await readFile(capturePath, "utf8"));
  expect(capture.records).toEqual([]);
}

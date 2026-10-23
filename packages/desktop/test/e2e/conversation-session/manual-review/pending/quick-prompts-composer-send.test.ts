// Composer quick prompts scenario 3, send half (specs/composer-quick-prompts.md rule 8): Cmd-click on a chip with
// an empty draft inserts the content and runs the composer's own Send path. That submits a real prompt, so the case
// needs a recorded provider fixture before it can join the formal conversation-session set (the formal sibling
// quick-prompts-composer.test.ts makes no provider request). Run it by path; it is excluded from the default run.
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import { clearAppData, setInputValueByTestIdDom } from "../../../helpers/desktop-app.js";
import { clickChip, composerText, saveDraftAsQuickPrompt } from "../../../helpers/quick-prompts.js";
import { prepareV4ConversationE2E } from "../../../helpers/v4-conversation.js";

const PROMPT_NAME = "review the diff";

describe("composer quick prompts send (pending admission)", () => {
  before(async () => {
    await prepareV4ConversationE2E();
  });
  after(async () => {
    await clearAppData();
  });

  it("scenario 3 send: Cmd-click with an empty draft inserts the prompt and submits it", async () => {
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, PROMPT_NAME, {
      stabilizeLexicalCaretAtEnd: true,
      timeout: 15000,
    });
    await saveDraftAsQuickPrompt(PROMPT_NAME);
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "", { timeout: 15000 });
    await clickChip(PROMPT_NAME, { send: true });
    // Submit clears the composer; the transcript check is left to the admitted case's provider fixture.
    await browser.waitUntil(async () => (await composerText()).trim().length === 0, {
      timeout: 15000,
      timeoutMsg: "Cmd-click with an empty draft did not submit the quick prompt",
    });
  });
});

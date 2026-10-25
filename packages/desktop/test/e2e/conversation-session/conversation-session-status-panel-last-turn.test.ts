// Status panel Context and Last turn sections (specs/status-panel-context-and-last-turn.md, acceptance 1 and 5):
// after a turn writes a file, Last turn shows the turn aggregate, expands to the file, and Context reports the
// session's usage. The E2E workspace is not a Git repository, so a todo (Progress) is what mounts the panel; the
// new sections never mount it on their own. Local desktop-continuous only; mobile remote is covered by unit tests.
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { TID_CHAT_SUMMARY_PANEL } from "@zcode/shared/test-ids";
import { clearAppData, DEFAULT_WORKSPACE, waitForTestIdByDom } from "../helpers/desktop-app.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

const CASE_ROOT = join(DEFAULT_WORKSPACE, "status-panel-last-turn-e2e");
const RELATIVE_PATH = "status-panel-last-turn-e2e/notes.txt";
const REQUEST_MARKER = "E2E_STATUS_PANEL_LAST_TURN";
const FINAL_MARKER = "E2E_STATUS_PANEL_LAST_TURN_OK";
const EXPAND_LABELS = ["Expand status", "展开状态"];
const PANEL = `[data-testid="${TID_CHAT_SUMMARY_PANEL}"]`;

describe("Status panel Last turn and Context sections", () => {
  afterEach(async () => {
    await rm(CASE_ROOT, { force: true, recursive: true });
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("lists the last editing turn and reports context usage once the panel has content", async function () {
    this.timeout(240_000);
    await rm(CASE_ROOT, { force: true, recursive: true });
    await prepareV4ConversationE2E();
    await switchV4Mode("yolo");

    await sendV4Prompt(
      `${REQUEST_MARKER}: create ${RELATIVE_PATH} with the requested fixture content.`,
    );
    await waitForV4TimelineContaining(FINAL_MARKER, 90_000);
    await browser.waitUntil(
      async () =>
        (await readFile(join(DEFAULT_WORKSPACE, RELATIVE_PATH), "utf8").catch(() => "")) ===
        "last-turn-line-1\nlast-turn-line-2\n",
      { timeout: 60_000, timeoutMsg: `${RELATIVE_PATH} was not written by the fixture turn` },
    );
    await waitForV4Pane((snapshot) => !snapshot.canStop, "the turn did not return to idle", 60_000);

    await waitForExpandedStatusPanel();
    const sections = await readSectionOrder();
    // Without Git Tools, Last turn is the first section, Progress follows, and Context stays last.
    expect(sections.indexOf("environment")).toBe(-1);
    expect(sections.indexOf("lastTurn")).toBe(0);
    expect(sections.indexOf("plan")).toBeGreaterThan(0);
    expect(sections.at(-1)).toBe("context");

    const summary = await $(`${PANEL} [data-status-panel-last-turn-summary="true"]`).getText();
    expect(summary).toMatch(/1 (file|个文件)/u);
    expect(summary).toMatch(/\+2\s+-0/u);
    expect(await $(`${PANEL} [data-status-panel-context-percent]`).getText()).toMatch(/^\d+%$/u);

    // Both sections start collapsed; expanding Last turn reads the turn's files.
    expect(await $(`${PANEL} [data-status-panel-last-turn="body"]`).isExisting()).toBe(false);
    await expandSection("lastTurn");
    await $(`${PANEL} [data-status-panel-last-turn-file="${RELATIVE_PATH}"]`).waitForDisplayed({
      timeout: 30_000,
      timeoutMsg: "expanding Last turn did not list the written file",
    });

    await expandSection("context");
    await $(`${PANEL} [data-status-panel-context="body"]`).waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: "expanding Context did not show the usage body",
    });
  });
});

async function waitForExpandedStatusPanel() {
  await waitForTestIdByDom(TID_CHAT_SUMMARY_PANEL, {
    timeout: 90_000,
    timeoutMsg: "the status panel did not mount for a session with a todo",
  });
  const lastTurnTrigger = $(`${PANEL} [data-status-section-trigger="lastTurn"]`);
  // Auto mode keeps the capsule on narrow windows; expand it before reading sections.
  if (!(await lastTurnTrigger.isDisplayed().catch(() => false))) {
    const clicked = await browser.execute(
      (selector, labels) => {
        const button = Array.from(
          document.querySelectorAll<HTMLButtonElement>(`${selector} button`),
        ).find((candidate) => labels.includes(candidate.getAttribute("aria-label") ?? ""));
        button?.click();
        return Boolean(button);
      },
      PANEL,
      EXPAND_LABELS,
    );
    expect(clicked).toBe(true);
  }
  await lastTurnTrigger.waitForDisplayed({
    timeout: 30_000,
    timeoutMsg: "the expanded status panel did not show the Last turn section",
  });
}

// Same DOM-click pattern as the shared terminal/agent helper in v4-conversation.ts.
async function expandSection(section: string) {
  await browser.waitUntil(
    () =>
      browser.execute(
        (selector, name) => {
          const trigger = document.querySelector<HTMLButtonElement>(
            `${selector} [data-status-section-trigger="${name}"]`,
          );
          if (!trigger) return false;
          if (trigger.getAttribute("aria-expanded") === "true") return true;
          trigger.click();
          return false;
        },
        PANEL,
        section,
      ),
    { timeout: 10_000, timeoutMsg: `the ${section} section did not expand` },
  );
}

function readSectionOrder(): Promise<string[]> {
  return browser.execute(
    (selector) =>
      Array.from(document.querySelectorAll<HTMLElement>(`${selector} [data-status-section]`)).map(
        (element) => element.dataset.statusSection ?? "",
      ),
    PANEL,
  );
}

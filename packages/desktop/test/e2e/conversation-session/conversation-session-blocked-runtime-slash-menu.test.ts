// While the session runtime is blocked the composer slash menu offers only the recovery command
// (/reload); ordinary app commands such as /plan stay hidden until the runtime is ready
// (specs/upstream-3.17.1-sync-catalog.md §7). The runtime is blocked without product hooks, by the
// history-first seed: cold-opening a persisted session runs a `SessionStart` resume hook that waits
// on a barrier file (runtimeInitialization "initializing"), and corrupting the session row before
// releasing it makes the final materialization fail (runtimeInitialization "failed").
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TID_V4_COMPOSER_SEND } from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE, clearAppData, waitForWorkspaceApp } from "../helpers/desktop-app.js";
import {
  prepareV4ConversationE2E,
  selectV4TaskById,
  setV4ComposerText,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";
import {
  HISTORY_FIRST_FAILED_SESSION,
  HISTORY_FIRST_SESSION,
  HISTORY_FIRST_TEXT,
} from "../helpers/session-history-first-fixture.js";

const root = join(DEFAULT_WORKSPACE, ".zcode", "history-first-e2e");
const release = join(root, "release");
const entered = join(root, "entered");
const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR ?? join(process.cwd(), ".e2e-artifacts");
const RELOAD_OPTION = '[data-option-id="app-slash:reload"]';
const PLAN_OPTION = '[data-option-id="app-slash:plan"]';

function readAppSlashOptionIds(): Promise<string[]> {
  return browser.execute(() =>
    [...document.querySelectorAll('[data-option-id^="app-slash:"]')].map(
      (node) => node.getAttribute("data-option-id") ?? "",
    ),
  );
}

async function waitForResumeHookEntered() {
  await browser.waitUntil(
    async () => (await readFile(entered, "utf8").catch(() => "")) === "entered",
    { timeout: 30_000, timeoutMsg: "resume hook did not reach the barrier" },
  );
}

/** Opens the slash menu; the reload option is the positive anchor that the menu rendered. */
async function openSlashMenu() {
  await setV4ComposerText("/");
  await $(RELOAD_OPTION).waitForDisplayed({ timeout: 10_000 });
}

async function closeSlashMenu() {
  await browser.keys("Escape");
  await setV4ComposerText("");
}

describe("BSM: composer slash menu while the session runtime is blocked", () => {
  afterEach(async function () {
    if (this.currentTest?.state !== "failed") return;
    await browser.saveScreenshot(join(artifacts, "blocked-runtime-slash-menu-failure.png"));
  });
  after(async () => {
    await writeFile(release, "release").catch(() => undefined);
    await clearAppData();
  });

  it("BSM01-BSM02: initializing runtime offers only /reload, ready runtime offers /plan again", async function () {
    this.timeout(180_000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
    await prepareV4ConversationE2E();
    await selectV4TaskById(HISTORY_FIRST_SESSION);
    await waitForV4TimelineContaining(HISTORY_FIRST_TEXT, 30_000);
    await waitForResumeHookEntered();

    try {
      await openSlashMenu();
      expect(await readAppSlashOptionIds()).toEqual(["app-slash:reload"]);
      expect(await $(PLAN_OPTION).isExisting()).toBe(false);
      await browser.saveScreenshot(join(artifacts, "blocked-runtime-slash-menu-initializing.png"));
      await closeSlashMenu();
    } finally {
      // A held resume blocks the next cold open too; release it so BSM03 does not fail in cascade.
      await writeFile(release, "release");
    }
    // Send needs a draft; it turns enabled only once the runtime is ready.
    await setV4ComposerText("E2E_BLOCKED_SLASH ready probe");
    await browser.waitUntil(
      async () => await $(`[data-testid="${TID_V4_COMPOSER_SEND}"]`).isEnabled(),
      { timeout: 30_000, timeoutMsg: "runtime did not become ready after the barrier" },
    );
    await openSlashMenu();
    await $(PLAN_OPTION).waitForDisplayed({ timeout: 10_000 });
    expect(await readAppSlashOptionIds()).toEqual(
      expect.arrayContaining(["app-slash:reload", "app-slash:plan"]),
    );
    await closeSlashMenu();
  });

  it("BSM03: failed runtime initialization offers only /reload", async function () {
    this.timeout(120_000);
    await Promise.all([rm(release, { force: true }), rm(entered, { force: true })]);
    await selectV4TaskById(HISTORY_FIRST_FAILED_SESSION);
    await waitForV4TimelineContaining(HISTORY_FIRST_TEXT, 30_000);
    await waitForResumeHookEntered();
    const database = new DatabaseSync(
      join(DEFAULT_WORKSPACE, "..", ".zcode", "cli", "db", "db.sqlite"),
    );
    try {
      // Same fault as HF02: a corrupted branch field fails the real final materialization read.
      database
        .prepare("UPDATE session SET revert = '{' WHERE id = ?")
        .run(HISTORY_FIRST_FAILED_SESSION);
      await writeFile(release, "release");
      await $('[data-testid="v4-session-initialization-retry"]').waitForDisplayed({
        timeout: 30_000,
      });

      await openSlashMenu();
      expect(await readAppSlashOptionIds()).toEqual(["app-slash:reload"]);
      expect(await $(PLAN_OPTION).isExisting()).toBe(false);
      await browser.saveScreenshot(join(artifacts, "blocked-runtime-slash-menu-failed.png"));
      await closeSlashMenu();
    } finally {
      database
        .prepare("UPDATE session SET revert = NULL WHERE id = ?")
        .run(HISTORY_FIRST_FAILED_SESSION);
      database.close();
    }
  });
});

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
  getV4SlashOptionIds,
  prepareV4ConversationE2E,
  selectV4TaskById,
  setV4ComposerText,
  waitForV4ComposerText,
  waitForV4SlashOption,
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
const RELOAD_ID = "app-slash:reload";
const PLAN_ID = "app-slash:plan";
const PLAN_OPTION = `[data-option-id="${PLAN_ID}"]`;

/** Ids of the app-command rows currently rendered in the slash panel (CLI commands excluded). */
async function readAppSlashOptionIds(): Promise<string[]> {
  return (await getV4SlashOptionIds()).filter((id) => id.startsWith("app-slash:"));
}

async function waitForResumeHookEntered() {
  await browser.waitUntil(
    async () => (await readFile(entered, "utf8").catch(() => "")) === "entered",
    { timeout: 30_000, timeoutMsg: "resume hook did not reach the barrier" },
  );
}

async function closeSlashMenu() {
  await browser.keys("Escape");
  await setV4ComposerText("");
}

/**
 * Blocked-menu check. The panel is virtualised and a bare "/" lists 13 CLI commands before any app row,
 * so a "/" list cannot prove that /plan is absent. Instead: "/reload" is the positive anchor that app rows
 * render for a matching query, then "/plan" must show no app row.
 */
async function expectOnlyReloadWhileBlocked(screenshot: string) {
  await setV4ComposerText("/reload");
  await waitForV4SlashOption(RELOAD_ID);
  expect(await readAppSlashOptionIds()).toEqual([RELOAD_ID]);
  await browser.saveScreenshot(screenshot);

  await setV4ComposerText("/plan");
  await waitForV4ComposerText("/plan", "composer did not take the /plan query");
  expect(await readAppSlashOptionIds()).toEqual([]);
  expect(await $(PLAN_OPTION).isExisting()).toBe(false);
  await closeSlashMenu();
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
      await expectOnlyReloadWhileBlocked(
        join(artifacts, "blocked-runtime-slash-menu-initializing.png"),
      );
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
    // Once the CLI catalog loads, its 13 commands precede the app rows in the virtualized panel
    // (max-h-56, overscan 8), so /plan is not in the DOM until the query narrows the list.
    await setV4ComposerText("/plan");
    await $(PLAN_OPTION).waitForDisplayed({ timeout: 10_000 });
    expect(await readAppSlashOptionIds()).toEqual(expect.arrayContaining([PLAN_ID]));
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

      await expectOnlyReloadWhileBlocked(join(artifacts, "blocked-runtime-slash-menu-failed.png"));
    } finally {
      database
        .prepare("UPDATE session SET revert = NULL WHERE id = ?")
        .run(HISTORY_FIRST_FAILED_SESSION);
      database.close();
    }
  });
});

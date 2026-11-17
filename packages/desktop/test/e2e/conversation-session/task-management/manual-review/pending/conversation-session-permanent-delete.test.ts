// DEL01: permanent deletion through the real UI path. The seeded task is archived from its sidebar row, then deleted
// permanently from Settings → Archives (the archived row's delete button, useTaskDeleteDialog's confirm dialog).
// The fixture is seeded by wdio.conf.ts before the Host starts (workerSpecsContain for this file).
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_ARCHIVE,
  TID_TASK_DELETE_CONFIRM,
  TID_TASK_DELETE_DIALOG,
  TID_TASK_ITEM,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  waitForTestIdByDom,
  waitForWorkspaceApp,
} from "../../../../helpers/desktop-app.js";
import { PROVIDER_READINESS_HISTORY_SESSION_ID } from "../../../../helpers/provider-readiness-history-fixture.js";

const TASK_ID = PROVIDER_READINESS_HISTORY_SESSION_ID;
const CASE_TIMEOUT_MS = 180_000;
const sel = (id: string) => `[data-testid="${id}"]`;

function readPersistedState() {
  const root = join(getE2EAppDataPaths().homeDir, ".zcode");
  const content = new DatabaseSync(join(root, "cli", "db", "db.sqlite"), { readOnly: true });
  const index = new DatabaseSync(join(root, "v2", "tasks-index.sqlite"), { readOnly: true });
  try {
    const session = content
      .prepare("select count(*) as n from session where id = ?")
      .get(TASK_ID) as { n: number };
    const row = index
      .prepare("select deleted, title, searchable_text from tasks where task_id = ?")
      .get(TASK_ID) as { deleted: number; title: string; searchable_text: string };
    return { sessions: Number(session.n), ...row };
  } finally {
    content.close();
    index.close();
  }
}

/** Archives the seeded task from its sidebar row: the row's archive button asks for a second click to confirm. */
async function archiveTaskFromSidebar() {
  const row = await $(sel(testId(TID_TASK_ITEM, TASK_ID)));
  await row.waitForDisplayed({ timeout: 30_000 });
  await row.moveTo();
  const archive = await row.$(sel(testId(TID_TASK_ARCHIVE, TASK_ID)));
  await archive.waitForDisplayed({ timeout: 15_000 });
  await archive.click();
  if (await row.isExisting()) {
    const confirming = await row.getAttribute("data-archive-confirming-task-id");
    if (confirming === TASK_ID) await archive.click();
  }
  await row.waitForExist({ reverse: true, timeout: 30_000 });
}

/** Opens Settings → Archives and waits for the archive list. */
async function openArchiveSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15_000,
    timeoutMsg: "no settings entry button",
  });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15_000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "archives"), {
    timeout: 15_000,
    timeoutMsg: "Settings has no Archives section entry",
  });
  await $(sel("archive-management")).waitForDisplayed({ timeout: 15_000 });
  // The group renders its rows only while open (ArchiveGroupCard): the seeded task's group is the only one here.
  const toggle = await $(sel("archive-group-toggle"));
  await toggle.waitForDisplayed({ timeout: 30_000, timeoutMsg: "Archives has no project group" });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

/** The archived row of the seeded task; its delete button opens the permanent-delete dialog. */
function archivedRow() {
  return $(`[data-testid="archive-task"][data-task-id="${TASK_ID}"]`);
}

async function openDeleteDialog() {
  const row = await archivedRow();
  await row.waitForDisplayed({ timeout: 30_000 });
  await (await row.$(sel("archive-delete"))).click();
  await $(sel(TID_TASK_DELETE_DIALOG)).waitForDisplayed({ timeout: 15_000 });
  await $(sel(TID_TASK_DELETE_CONFIRM)).waitForEnabled({ timeout: 30_000 });
}

describe("DEL01: permanent task deletion from Settings → Archives", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("cancel preserves content; confirm erases content and retains the tombstone", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    await waitForTestIdByDom(testId(TID_TASK_ITEM, TASK_ID), {
      timeout: 30_000,
      timeoutMsg: "DEL01 的预置任务没有出现在侧栏",
    });
    const before = readPersistedState();
    expect(before.sessions).toBe(1);
    expect(before.deleted).toBe(0);

    await archiveTaskFromSidebar();
    await openArchiveSettings();

    await openDeleteDialog();
    await browser.keys("Escape");
    await $(sel(TID_TASK_DELETE_DIALOG)).waitForExist({ reverse: true });
    expect(readPersistedState()).toEqual(before);

    await openDeleteDialog();
    await $(sel(TID_TASK_DELETE_CONFIRM)).click();
    await browser.waitUntil(
      () => {
        const state = readPersistedState();
        return state.sessions === 0 && state.deleted === 1;
      },
      {
        timeout: 30_000,
        timeoutMsg: "Delete did not erase the CLI session and retain its tombstone",
      },
    );
    expect(readPersistedState()).toMatchObject({ title: "", searchable_text: "" });
    await $(`[data-testid="archive-task"][data-task-id="${TASK_ID}"]`).waitForExist({
      reverse: true,
      timeout: 30_000,
    });
  });
});

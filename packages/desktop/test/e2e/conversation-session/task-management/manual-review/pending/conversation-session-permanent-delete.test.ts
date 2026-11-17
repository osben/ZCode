import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  TID_TASK_DELETE,
  TID_TASK_DELETE_DIALOG,
  TID_TASK_DELETE_CONFIRM,
  TID_TASK_ITEM,
  testId,
} from "@zcode/shared";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  getE2EAppDataPaths,
  waitForTestIdByDom,
  waitForWorkspaceApp,
} from "../../../../helpers/desktop-app.js";
import { PROVIDER_READINESS_HISTORY_SESSION_ID } from "../../../../helpers/provider-readiness-history-fixture.js";

const TASK_ID = PROVIDER_READINESS_HISTORY_SESSION_ID;
const CASE_TIMEOUT_MS = 120_000;

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

async function openDeleteDialog() {
  const row = await $(`[data-testid="${testId(TID_TASK_ITEM, TASK_ID)}"]`);
  await row.waitForDisplayed({ timeout: 15_000 });
  // Radix ContextMenu opens on the contextmenu event; a WebDriver right click does not reach it in this harness.
  await browser.execute(
    (taskItemTestId) => {
      const target = document.querySelector<HTMLElement>(`[data-testid="${taskItemTestId}"]`);
      if (!target) throw new Error(`task row missing: ${taskItemTestId}`);
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }),
      );
    },
    testId(TID_TASK_ITEM, TASK_ID),
  );
  await $(`[data-testid="${TID_TASK_DELETE}"]`).waitForDisplayed({ timeout: 10_000 });
  await $(`[data-testid="${TID_TASK_DELETE}"]`).click();
  await $(`[data-testid="${TID_TASK_DELETE_DIALOG}"]`).waitForDisplayed({ timeout: 15_000 });
  await $(`[data-testid="${TID_TASK_DELETE_CONFIRM}"]`).waitForEnabled({ timeout: 30_000 });
}

describe("DEL01: permanent task deletion from the sidebar", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("cancel preserves content; confirm erases content and retains the tombstone after reload", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    await waitForTestIdByDom(testId(TID_TASK_ITEM, TASK_ID), {
      timeout: 30_000,
      timeoutMsg: "DEL01 的预置任务没有出现在侧栏",
    });
    const before = readPersistedState();
    expect(before.sessions).toBe(1);
    expect(before.deleted).toBe(0);

    await openDeleteDialog();
    await browser.keys("Escape");
    await $(`[data-testid="${TID_TASK_DELETE_DIALOG}"]`).waitForExist({ reverse: true });
    expect(readPersistedState()).toEqual(before);

    await openDeleteDialog();
    await $(`[data-testid="${TID_TASK_DELETE_CONFIRM}"]`).click();
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

    await browser.refresh();
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
    expect(await $(`[data-testid="${testId(TID_TASK_ITEM, TASK_ID)}"]`).isExisting()).toBe(false);
    expect(readPersistedState()).toMatchObject({ sessions: 0, deleted: 1 });
  });
});

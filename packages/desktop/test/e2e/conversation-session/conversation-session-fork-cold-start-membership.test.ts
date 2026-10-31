import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TID_TASK_ITEM, TID_V4_COMPOSER_INPUT, testId } from "@zcode/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  setInputValueByTestIdDom,
} from "../helpers/desktop-app.js";
import { restartIntoWorkspacePreservingProfile } from "../helpers/model-provider-restart.js";
import {
  clickFirstV4Fork,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4Fork,
  waitForV4MentionOptionPrefix,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

const CASE_TIMEOUT_MS = 180_000;
const PARENT_MARKER = "E2E_FORK_COLD_START_PROJECT_ROW";
const PARENT_REPLY = "FORK_COLD_START_PROJECT_ROW_OK";

describe("TSL19/TSL28：fork child Project row 与冷启动 membership", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("fork 后无需重启即显示可点击 Project row，重启后仍能从会话目录找到 child", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await prepareV4ConversationE2E();
    await sendV4Prompt(`${PARENT_MARKER}: Reply with exactly "${PARENT_REPLY}" and no other text.`);
    await waitForV4TimelineContaining(PARENT_REPLY, 60_000);
    const parent = await waitForV4Pane(
      (snapshot) =>
        !snapshot.canStop && Boolean(snapshot.sessionId && snapshot.sessionId !== "draft"),
      "TSL19 parent 没有完成并绑定 session",
      60_000,
    );
    const parentId = requireSessionId(parent.sessionId, "parent");

    await waitForV4Fork();
    expect(await clickFirstV4Fork()).toBe(true);
    const child = await waitForV4Pane(
      (snapshot) =>
        Boolean(
          snapshot.sessionId && snapshot.sessionId !== "draft" && snapshot.sessionId !== parentId,
        ),
      "TSL19 fork 后没有切换到 child",
      60_000,
    );
    const childId = requireSessionId(child.sessionId, "child");
    expect(readCliSession(childId)).toEqual({
      parentId,
      taskType: "fork",
    });

    // Root cause of the bug: the fork child's conversation hydration restores the pane, but the old
    // gateway never published the post-hydration non-draft summary to sessions-index. So the current pane
    // looks fine while the task-index syncer never receives the child, and Project can only add the task
    // row after a restart re-reads the source. Within the no-restart, no-continuation window, this must
    // first prove that both the persisted row and the unique DOM row have appeared.
    await waitForPersistedProjectTask(childId);
    await waitForSingleProjectRow(
      childId,
      "TSL28 fork child hydration 后 tasks-index 已落库，但 Project 没有唯一 child row",
    );

    // Leave the active child first, then click back in from the Project row, to rule out a false green
    // caused by the active pane/optimistic overlay temporarily keeping the same row.
    await selectV4TaskById(parentId);
    await waitForSingleProjectRow(
      childId,
      "TSL28 离开 active child 后 Project child row 消失或重复",
    );
    await selectV4TaskById(childId);
    await waitForV4TimelineContaining(PARENT_REPLY, 30_000);

    // Root cause of the bug: the old cold-start query used parent_id is null instead of task type
    // membership. Switch back to the unsent draft first, so that the App restart's automatic resume of
    // the current child cannot mask the missing cold seed.
    await startNewV4Draft();
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === "draft",
      "TSL19 重启前没有切回 draft",
      30_000,
    );
    await restartIntoWorkspacePreservingProfile();
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === "draft",
      "TSL19 冷启动错误恢复了 fork child",
      60_000,
    );

    // The mention directory reads sessions-index directly; seeing the exact session id before clicking
    // the child proves the parented fork came from cold-start membership, not from an on-demand resume
    // that only fills memory after selection.
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "#", {
      timeout: 15_000,
      timeoutMsg: "TSL19 冷启动后 composer 不可输入",
    });
    expect(await waitForV4MentionOptionPrefix(`session:${childId}`, 30_000)).toBe(
      `session:${childId}`,
    );
  });
});

async function waitForPersistedProjectTask(taskId: string): Promise<void> {
  await browser.waitUntil(
    () => readWorkspaceTaskIds().filter((candidate) => candidate === taskId).length === 1,
    {
      timeout: 30_000,
      timeoutMsg: `TSL28 fork child 没有写入唯一 tasks-index row: ${taskId}`,
    },
  );
}

async function waitForSingleProjectRow(taskId: string, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (taskItemTestId) =>
          document.querySelectorAll(`[data-testid="${taskItemTestId}"]`).length === 1,
        testId(TID_TASK_ITEM, taskId),
      ),
    {
      timeout: 30_000,
      timeoutMsg,
    },
  );
}

function readWorkspaceTaskIds(): string[] {
  // Node's built-in SQLite only provides DatabaseSync; the E2E poll closes the read-only handle
  // immediately on every iteration.
  const database = new DatabaseSync(join(homedir(), ".zcode", "v2", "tasks-index.sqlite"), {
    readOnly: true,
  });
  try {
    const rows = database
      .prepare("select task_id from tasks where workspace_key = ? and deleted = 0 order by task_id")
      .all(DEFAULT_WORKSPACE) as Array<{ task_id: string }>;
    return rows.map((row) => row.task_id);
  } finally {
    database.close();
  }
}

function requireSessionId(value: string | null, label: string): string {
  if (!value || value === "draft") {
    throw new Error(`TSL19 缺少 ${label} sessionId: ${String(value)}`);
  }
  return value;
}

function readCliSession(sessionId: string): {
  parentId: string | null;
  taskType: string | null;
} | null {
  // Node's built-in SQLite only provides DatabaseSync; the E2E reads once and closes the handle immediately.
  const database = new DatabaseSync(join(homedir(), ".zcode", "cli", "db", "db.sqlite"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare("select parent_id, task_type from session where id = ?")
      .get(sessionId) as { parent_id: string | null; task_type: string | null } | undefined;
    return row ? { parentId: row.parent_id, taskType: row.task_type } : null;
  } finally {
    database.close();
  }
}

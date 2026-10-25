// catalog E09 (forkUsesEditedActiveBranch) acceptance (case catalog campaign).
// Evidence layer L3: edit re-run replaces the branch → fork the post-edit assistant → child contains only the active branch,
// without the old user/assistant branches rewound away. History reconciliation chain = rowId→messageId translation +
// RewindTriggered truncation + fork copy + child cold-subscription transcript synthetic hydration (the surface where a bug once appeared).
import { clearAppData } from "../helpers/desktop-app.js";
import {
  clickFirstV4Fork,
  editFirstV4UserQuery,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Edit,
  waitForV4Fork,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

describe("v4 catalog E09：fork 使用编辑后的 active branch", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("edit 重跑后 fork → child 只含编辑分支，不带旧分支", async () => {
    await prepareV4ConversationE2E();

    // Original first round
    await sendV4Prompt("E2E_V4_BRANCH_T1 原始问题");
    await waitForV4TimelineContaining("V4_BRANCH_T1_REPLY", 60000);
    const parent = await waitForV4Pane(
      (s) => s.sessionId !== "draft" && s.sessionId !== null && !s.canStop,
      "首轮没有完成",
      45000,
    );
    const parentSessionId = parent.sessionId;

    // edit: inline newText + Send → rewind truncation + re-run
    await waitForV4Edit();
    await editFirstV4UserQuery("E2E_V4_BRANCH_EDITED 编辑后的问题");
    // branch cut 可见后，replacement user row 也必须从权威投影恢复，不能只剩截断结果。
    await waitForV4TimelineContaining("E2E_V4_BRANCH_EDITED", 30000);
    await waitForV4TimelineContaining("V4_BRANCH_EDITED_REPLY", 60000);
    const afterEdit = await getV4PaneSnapshot();
    expect(afterEdit.timelineText).not.toContain("V4_BRANCH_T1_REPLY");
    expect(afterEdit.timelineText).not.toContain("E2E_V4_BRANCH_T1");

    // fork the edited assistant row
    await waitForV4Pane((s) => !s.canStop, "edit 重跑没有收口", 45000);
    await waitForV4Fork();
    expect(await clickFirstV4Fork()).toBe(true);

    const child = await waitForV4Pane(
      (s) => s.sessionId !== null && s.sessionId !== "draft" && s.sessionId !== parentSessionId,
      "fork 后 pane 没有切到 child session",
      60000,
    );
    expect(child.sessionId).not.toBe(parentSessionId);

    // child history = the edited active branch; the old branch must not enter the child.
    // Note: the rewind synthetic notice (rewoundPromptPreview) references the original prompt text that was edited away;
    // that is the transcript's record of the rewind, not a revival of the old branch — the strict assertions only check
    // whether the old assistant reply and old user turn exist as real turns.
    await waitForV4TimelineContaining("V4_BRANCH_EDITED_REPLY", 30000);
    const childSnapshot = await getV4PaneSnapshot();
    expect(childSnapshot.timelineText).toContain("E2E_V4_BRANCH_EDITED");
    expect(childSnapshot.timelineText).not.toContain("V4_BRANCH_T1_REPLY");
  });
});

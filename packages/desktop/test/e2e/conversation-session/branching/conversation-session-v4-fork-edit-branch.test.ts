// catalog E09 (forkUsesEditedActiveBranch) acceptance (case catalog campaign).
// Evidence layer L3: edit re-run replaces the branch → fork the post-edit assistant → child contains only the active branch,
// without the old user/assistant branches rewound away. History reconciliation chain = rowId→messageId translation +
// RewindTriggered truncation + fork copy + child cold-subscription transcript synthetic hydration (the surface where a bug once appeared).
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData } from "#e2e/helpers/desktop-app";
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
} from "#e2e/helpers/v4-conversation";

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
    // D20：首轮 edit 的 branch cut 不能变成可绘制空帧；真实链路记录中间帧而非只看终态。
    await browser.execute(() => {
      const scope = window as typeof window & {
        __editFrames?: { at: number; hasRows: boolean; height: number }[];
        __editFrameRequest?: number;
      };
      scope.__editFrames = [];
      const sample = () => {
        const timeline = document.querySelector<HTMLElement>('[data-testid="v4-timeline"]');
        scope.__editFrames!.push({
          at: performance.now(),
          hasRows: Boolean(timeline?.querySelector('[data-testid^="v4-row-"]')),
          height: timeline?.scrollHeight ?? 0,
        });
        scope.__editFrameRequest = requestAnimationFrame(sample);
      };
      sample();
    });
    try {
      await editFirstV4UserQuery("E2E_V4_BRANCH_EDITED 编辑后的问题");
      await waitForV4TimelineContaining("E2E_V4_BRANCH_EDITED", 30000);
      await waitForV4TimelineContaining("V4_BRANCH_EDITED_REPLY", 60000);
    } finally {
      const frames = await browser.execute(() => {
        const scope = window as typeof window & {
          __editFrames?: { at: number; hasRows: boolean; height: number }[];
          __editFrameRequest?: number;
        };
        cancelAnimationFrame(scope.__editFrameRequest!);
        const result = scope.__editFrames ?? [];
        delete scope.__editFrames;
        delete scope.__editFrameRequest;
        return result;
      });
      await writeFile(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "edit-presentation-frames.json"),
        JSON.stringify(frames, null, 2),
      );
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.filter((frame) => !frame.hasRows)).toEqual([]);
    }
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

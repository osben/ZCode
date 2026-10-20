import { TID_TASK_ITEM, testId } from "@zcode/shared";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  waitForTestIdByDom,
  waitForWorkspaceApp,
} from "../helpers/desktop-app.js";
import { SESSION_PR_STATUS_SESSION_ID } from "../helpers/session-pr-status-fixture.js";

/**
 * Session pull request status E2E (specs/sidebar-pr-status.md, scenario set
 * PRS). All data is seeded before the Host boots by
 * seedSessionPrStatusFixture: a completed worktree task row, a github.com
 * remote on the default workspace, and a fake gh at the ZCODE_GH_BINARY seam
 * (wdio.conf, POSIX only) that answers the batched GraphQL query with one
 * open PR (#101, failing required check → red dot) and one merged PR (#100)
 * for every branch alias.
 *
 * The status-panel "Git tools" group of the same data is covered by
 * packages/ui/test/conversationStatusPanelPullRequests.test.ts; driving the
 * expanded status panel on a seeded read-only session is the same
 * manual-review flow as SP13 (conversation-session-git-review-entry).
 */

const itPosix = process.platform === "win32" ? it.skip : it;

describe("session pull request status E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  itPosix(
    "PRS-01: worktree session shows the PR row icon with the health dot and the hover card lines",
    async function () {
      this.timeout(120_000);

      await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45_000);
      await waitForTestIdByDom(testId(TID_TASK_ITEM, SESSION_PR_STATUS_SESSION_ID), {
        timeout: 30_000,
        timeoutMsg: "PRS 预置的 worktree 会话没有出现在任务列表",
      });

      // Sidebar row: open PR glyph with the destructive health dot (failing
      // required check), rendered beside the worktree marker.
      const rowIcon = await $('[data-task-pr-stage="open"]');
      await rowIcon.waitForExist({ timeout: 30_000 });
      const hasDestructiveDot = await browser.execute(
        () =>
          document.querySelector('[data-task-pr-stage="open"]')?.querySelector(".bg-destructive") !=
          null,
      );
      expect(hasDestructiveDot).toBe(true);

      // Hover card: one line per pull request, the open one first.
      await rowIcon.moveTo();
      const hoverList = await $('[data-task-hover-pr="list"]');
      await hoverList.waitForExist({ timeout: 10_000 });
      const hoverText = await hoverList.getText();
      expect(hoverText).toContain("#101");
      expect(hoverText).toContain("#100");
    },
  );
});

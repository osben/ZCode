// Worktree failure return-to-draft E2E (specs/composer-worktree-setup-steps.md §Return to draft
// on failure, acceptance scenario 24 — the preflight half). The post-session modal flow needs a
// Git failure the preflight cannot predict, which has no deterministic UI-only trigger yet; its
// coverage lives in packages/ui/test/composerWorktreeFailureReturn.test.ts. This spec drives the
// deterministic preflight scenario: an unborn-HEAD repository (no branches, no commits) blocks
// Send before any session exists, names the cause, and keeps the draft in the editor.
//
// Run: ZCODE_E2E_MANUAL_REVIEW=1 pnpm --filter @zcode/desktop test:e2e -- --spec
//   ./test/e2e/conversation-session/manual-review/pending/conversation-session-worktree-failure-return.test.ts
import { execFileSync } from "node:child_process";
import { prepareV4ConversationE2E } from "../../../helpers/v4-conversation.js";
import {
  getChatRootSnapshot,
  sendPrompt,
  waitForComposerText,
} from "../../../helpers/conversation-session.js";
import { DEFAULT_WORKSPACE, clearAppData } from "../../../helpers/desktop-app.js";

function git(args: string[]): string {
  return execFileSync("git", ["-C", DEFAULT_WORKSPACE, ...args], { encoding: "utf8" });
}

/** Leave HEAD on an unborn branch with zero local branches: getLocalBranches then reports an empty list with a named current branch. */
function makeWorkspaceUnbornHead(): void {
  git(["checkout", "--orphan", "e2e-unborn-head"]);
  const branches = git(["for-each-ref", "--format=%(refname:short)", "refs/heads"])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "e2e-unborn-head");
  for (const branch of branches) {
    git(["branch", "-D", branch]);
  }
}

describe("Worktree 创建失败返回草稿 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("preflight: 无提交的仓库在创建会话前阻止发送并说明原因（场景 24）", async function () {
    this.timeout(120000);

    await prepareV4ConversationE2E({ skipProvider: true });
    makeWorkspaceUnbornHead();

    const destination = await $('button[aria-label="Choose where this task runs"]');
    await destination.waitForClickable({ timeout: 15000 });
    await destination.click();
    const worktreeSwitch = await $('button[role="switch"][aria-label="Worktree"]');
    await worktreeSwitch.waitForDisplayed({ timeout: 10000 });
    await worktreeSwitch.click();
    expect(await worktreeSwitch.getAttribute("aria-checked")).toBe("true");
    await destination.click();

    const prompt = `E2E_WORKTREE_PREFLIGHT_UNBORN_${Date.now()}: this send must be blocked`;
    await sendPrompt(prompt);

    // No preparing session was created: the shell stays on the draft screen.
    await browser.waitUntil(
      async () => !(await $('[data-worktree-setup-steps="true"]').isExisting()),
      { timeout: 10000 },
    );
    const snapshot = await getChatRootSnapshot();
    expect(snapshot.sessionId || snapshot.taskId).toBeFalsy();

    // The draft stays in the editor — nothing was consumed by a session.
    await waitForComposerText(prompt, "preflight must keep the blocked draft in the editor");

    // The destination control explains the cause in plain language.
    await destination.click();
    const worktreeStatus = await $('[data-testid="destination-worktree-status"]');
    await worktreeStatus.waitForDisplayed({ timeout: 10000 });
    const explanation = await worktreeStatus.getText();
    expect(explanation).toContain("was not found");
    expect(explanation).toContain("A repository without commits has no branches yet");
  });
});

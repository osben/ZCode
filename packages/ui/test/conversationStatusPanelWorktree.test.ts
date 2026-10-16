// Source-contract coverage for the worktree disclosure row in the session Git Tools section
// (specs/composer-branch-switcher-semantics.md §3 visibility slice): the parent-reflecting
// widgets must be prefixed with the session's own worktree branch + directory.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const panel = readFileSync(
  resolve(process.cwd(), "packages/ui/src/v4/ConversationStatusPanel.tsx"),
  "utf8",
);
const sessionPane = readFileSync(
  resolve(process.cwd(), "packages/ui/src/v4/SessionPane.tsx"),
  "utf8",
);

describe("status panel worktree disclosure", () => {
  it("renders the session's own branch and directory above the parent git widgets", () => {
    expect(panel).toContain('data-status-panel-worktree="true"');
    expect(panel).toContain("gitSummary.branchName");
    expect(panel).toContain('intl.formatMessage({ id: "git.head.detached" })');
    expect(panel).toContain("worktreeDirectoryNameOf(executionWorktree.path)");
    // Full path stays available as the tooltip.
    expect(panel).toContain("title={executionWorktree.path}");
  });

  it("SessionPane feeds the panel from the sessions-index task meta", () => {
    expect(sessionPane).toContain("useWorkspaceSessionsIndexItems(sessionIndexScopes)");
    expect(sessionPane).toContain(
      "sessionIndexItems.find((task) => task.taskId === sessionId)?.executionWorktree",
    );
    expect(sessionPane).not.toContain("getTaskMeta(workspaceState, sessionId)?.executionWorktree");
    expect(sessionPane).toContain("executionWorktree={sessionExecutionWorktree}");
    expect(sessionPane).toContain("workspacePath: executionGitPath");
    expect(sessionPane).toContain("enabled: Boolean(sessionExecutionWorktree)");
    expect(sessionPane).toContain(
      "sessionExecutionWorktree ? worktreeGitState.summary : gitSummary",
    );
    expect(sessionPane).toContain("sessionExecutionWorktree ? refreshWorktreeGit : onRefreshGit");
  });

  it("routes status-panel branch and Git actions to the worktree path and uses the scoped guard", () => {
    expect(panel).toContain("const targetPath = gitWorkspacePath ?? workspacePath;");
    expect(panel).toContain("workspacePath={targetPath}");
    expect(panel).toContain('scope: executionWorktree ? "worktree" : "checkout"');
    expect(panel).toContain("worktreePath: executionWorktree.path");
  });
});

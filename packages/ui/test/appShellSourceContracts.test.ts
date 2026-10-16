import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

let appSource = "";
let taskNavigationSource = "";

beforeAll(async () => {
  // The source contracts share one immutable fixture, avoiding repeated reads of the App and
  // task navigation sources.
  [appSource, taskNavigationSource] = await Promise.all([
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app-shell/useWorkspaceTaskNavigation.ts", import.meta.url), "utf8"),
  ]);
});

function getQuickPickCommandsMemoBlock(source: string): string {
  const start = source.indexOf("const quickPickCommands = useMemo");
  const end = source.indexOf("  );", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function expectNoTaskQueryCacheHookSubscription(source: string) {
  // Performance regression guard: task meta refreshes at high frequency and should read
  // snapshots via getState only when a command triggers it; App or navigation hooks must not
  // subscribe to the whole task query cache and drag the shell into re-renders.
  expect(source).not.toMatch(/\buseTaskQueryCacheStore\s*\(/);
}

describe("App quick pick command render stability", () => {
  it("does not recreate quick pick commands when only the user object reference changes", () => {
    const memoBlock = getQuickPickCommandsMemoBlock(appSource);

    // Performance regression guard: commands are passed all the way down to CommandCenterDialog.
    // Only the logged-in boolean is needed here; do not subscribe to the full user object
    // reference.
    expect(memoBlock).toContain("isLoggedIn");
    expect(memoBlock).not.toMatch(/\n\s+user,\n/);
  });

  it("memoizes task find dialog props before passing them to the shell layout", () => {
    // Performance regression guard: taskFindDialogProps is an object prop; creating it inline
    // would hand WorkspaceShellLayout a new reference on unrelated streaming refreshes and keep
    // re-rendering downstream.
    expect(appSource).toContain("const taskFindDialogProps = useMemo<TaskFindDialogProps>");
    expect(appSource).toContain("taskFindDialogProps={taskFindDialogProps}");
  });

  it("uses the active worktree for the general Git Review entry", () => {
    expect(appSource).toMatch(
      /const gitRepositoryWorkspacePath\s*=\s*[\s\S]*?resolvedActiveTaskMeta\?\.executionWorktree\?\.path\s*\?\?\s*workspaceAbsPath/u,
    );
  });
});

describe("task query cache render subscription boundary", () => {
  it("keeps App from subscribing to the whole task query cache", () => {
    expectNoTaskQueryCacheHookSubscription(appSource);
  });

  it("keeps task navigation handlers from subscribing to the whole task query cache", () => {
    expectNoTaskQueryCacheHookSubscription(taskNavigationSource);
    expect(taskNavigationSource).toContain("setTaskQueryCacheUnreadOverlay");
    expect(taskNavigationSource).toContain("reconcileTaskQueryCacheUnread");
    expect(taskNavigationSource).not.toContain("setTaskUnreadIndicator");
    expect(taskNavigationSource).not.toContain("targetWorkspaceState.taskListCache");
  });

  it("选择已有 task 时保留 workspace slash command 目录", () => {
    // Bug cause: the catalog belongs to workspace identity; if task navigation clears it
    // proactively, session projection does not backfill it for the composer, and the custom
    // slash commands of known sessions disappear permanently.
    expect(taskNavigationSource).not.toMatch(/\.setSlashCommands\s*\(/);
    expect(taskNavigationSource).not.toMatch(/const\s+setSlashCommands\s*=\s*useZCodeSessionStore/);
  });
});

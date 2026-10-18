// @vitest-environment jsdom

// Only the RPC service boundary (file watcher / system services) is mocked here; the Git
// auto-refresh scheduling logic under test (useGitAutoRefresh + lib/gitAutoRefresh) is real.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileWatchEvent, GitRepositorySummary } from "@zcode/shared";

const { fileWatcherService, systemService, changeListeners } = vi.hoisted(() => {
  const changeListeners: Array<(event: FileWatchEvent) => void> = [];
  return {
    changeListeners,
    fileWatcherService: {
      watch: vi.fn(async () => ({ id: "watch-1" })),
      unwatch: vi.fn(async () => {}),
      onDynamicChange: vi.fn(() => (listener: (event: FileWatchEvent) => void) => {
        changeListeners.push(listener);
        return { dispose: vi.fn() };
      }),
    },
    systemService: {
      info: vi.fn(async () => ({ homedir: "/home/tester", platform: "darwin" })),
    },
  };
});

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServices: () => ({ fileWatcherService, systemService }),
}));

import { useGitAutoRefresh } from "@/hooks/useGitAutoRefresh.js";

const gitSummary: GitRepositorySummary = {
  workspacePath: "/repo",
  repoRoot: "/repo",
  workspaceInRepoPath: ".",
  autoRefreshWatchPaths: [{ path: "/repo/.git", recursive: true }],
  branchName: "main",
  trackingBranchName: null,
  headRefType: "branch",
  ahead: 0,
  behind: 0,
  isDirty: false,
  isGitAvailable: true,
  isRepository: true,
};

// External file changes must refresh Git within seconds: the file-watcher host debounces 150 ms
// (packages/services/src/fileWatcher/fileWatcherService.ts DEBOUNCE_MS) and the renderer-side Git
// debounce was designed at 350 ms (see the history note in useGitAutoRefresh.ts). 5 s is a
// generous margin and far below the minute observed in QA.
const EXTERNAL_CHANGE_REFRESH_WINDOW_MS = 5_000;

describe("useGitAutoRefresh external file change", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    changeListeners.length = 0;
  });

  // Fails while BUG-GWT-002 is unfixed: the renderer-side Git debounce is 60 s with a full reset
  // on every event, so an external file change never refreshes within seconds.
  // See docs/testing/git-worktree-qa/bugs/BUG-GWT-002.md.
  it.fails("BUG-GWT-002: refreshes Git shortly after an external change event reaches the renderer", async () => {
    const onRefreshGit = vi.fn();
    renderHook(() =>
      useGitAutoRefresh({
        workspacePath: "/repo",
        workspaceIdentity: null,
        remoteSessionId: null,
        gitSummary,
        gitSummaryWorkspaceKey: "/repo",
        enabled: true,
        onRefreshGit,
      }),
    );

    // Settle the async watch()/info() promise chain (microtasks only, no timer advance).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Preconditions prove the setup is live: on macOS the workspace root is watched recursively
    // and the renderer subscribed to the watcher's change event.
    expect(fileWatcherService.watch).toHaveBeenCalledWith({ path: "/repo", recursive: true });
    expect(changeListeners.length).toBeGreaterThan(0);

    // An external change (e.g. `echo >> src/app.txt`) arrives through the RPC event boundary.
    act(() => {
      changeListeners[0]({ dirPath: "/repo", changedPath: "/repo/src/app.txt" });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXTERNAL_CHANGE_REFRESH_WINDOW_MS);
    });

    expect(onRefreshGit).toHaveBeenCalledTimes(1);
  });
});

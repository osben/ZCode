// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitRepositorySummary } from "@zcode/shared";

type FileEventListener = (event: { dirPath: string }) => void;

const { fileWatcherService, systemService, fileEventListeners } = vi.hoisted(() => {
  const fileEventListeners: FileEventListener[] = [];
  return {
    fileEventListeners,
    fileWatcherService: {
      watch: vi.fn(async () => ({ id: "watch-1" })),
      unwatch: vi.fn(async () => {}),
      disposeAll: vi.fn(),
      // Capture the listener so tests can emit file events into the hook.
      onDynamicChange: vi.fn(() => (listener: FileEventListener) => {
        fileEventListeners.push(listener);
        return { dispose: vi.fn() };
      }),
    },
    systemService: {
      info: vi.fn(async () => ({ homedir: "/home/tester", platform: "linux" })),
    },
  };
});

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServices: () => ({ fileWatcherService, systemService }),
}));

import { useGitAutoRefresh } from "@/hooks/useGitAutoRefresh.js";

describe("useGitAutoRefresh", () => {
  beforeEach(() => {
    fileWatcherService.watch.mockClear();
    fileWatcherService.unwatch.mockClear();
    fileWatcherService.onDynamicChange.mockClear();
    systemService.info.mockClear();
  });

  it("uses the workspace Host platform and never recursively watches a Linux workspace root", async () => {
    renderHook(() =>
      useGitAutoRefresh({
        workspacePath: "/repo",
        workspaceIdentity: "remote:ssh:linux:/repo",
        remoteSessionId: "remote-session-1",
        gitSummary: {
          workspacePath: "/repo",
          repoRoot: "/repo",
          workspaceInRepoPath: ".",
          autoRefreshWatchPaths: [
            { path: "/repo", recursive: true },
            { path: "/repo/.git", recursive: true },
          ],
          branchName: "main",
          trackingBranchName: null,
          headRefType: "branch",
          ahead: 0,
          behind: 0,
          isDirty: false,
          isGitAvailable: true,
          isRepository: true,
        },
        gitSummaryWorkspaceKey: "remote:ssh:linux:/repo",
        enabled: true,
        onRefreshGit: vi.fn(),
      }),
    );

    await waitFor(() => expect(fileWatcherService.watch).toHaveBeenCalledTimes(1));
    expect(fileWatcherService.watch).toHaveBeenCalledWith({
      path: "/repo/.git",
      recursive: true,
    });
    expect(systemService.info).toHaveBeenCalledTimes(1);
  });
});

// Refresh coalescing contract (docs/ui/git-auto-refresh.md "节流契约"):
// quiet single event -> refresh after 500ms; continuous stream -> at most one refresh per 5s window;
// a lone event after 30s of silence -> fast refresh again.
describe("useGitAutoRefresh refresh coalescing", () => {
  const summary: GitRepositorySummary = {
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

  // Mounts the hook on real timers, waits for the single watcher subscription, then switches to fake
  // timers so the schedule is driven deterministically by the test.
  async function mountWithOneWatcher() {
    const onRefreshGit = vi.fn();
    const hook = renderHook(() =>
      useGitAutoRefresh({
        workspacePath: "/repo",
        workspaceIdentity: "remote:ssh:linux:/repo",
        remoteSessionId: "remote-session-1",
        gitSummary: summary,
        gitSummaryWorkspaceKey: "remote:ssh:linux:/repo",
        enabled: true,
        onRefreshGit,
      }),
    );
    await waitFor(() => expect(fileEventListeners).toHaveLength(1));
    vi.useFakeTimers();
    const emit = () => fileEventListeners[0]?.({ dirPath: "/repo/.git" });
    return { onRefreshGit, emit, unmount: hook.unmount };
  }

  beforeEach(() => {
    fileEventListeners.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("(a) a single event refreshes after about 500ms", async () => {
    const { onRefreshGit, emit, unmount } = await mountWithOneWatcher();

    emit();
    await vi.advanceTimersByTimeAsync(499);
    expect(onRefreshGit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onRefreshGit).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("(b) an event stream every 200ms for 3s yields one refresh in the 5s window, and another later while it continues", async () => {
    const { onRefreshGit, emit, unmount } = await mountWithOneWatcher();

    // Events at 0, 200, ..., 3000ms; the trailing debounce fires at 3500ms.
    for (let i = 0; i < 16; i += 1) {
      emit();
      await vi.advanceTimersByTimeAsync(200);
    }
    await vi.advanceTimersByTimeAsync(1800); // now 5000ms
    expect(onRefreshGit).toHaveBeenCalledTimes(1);

    // The stream keeps going: the max-wait window opened at 5000ms refreshes at 10000ms.
    for (let i = 0; i < 25; i += 1) {
      emit();
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(onRefreshGit).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("(c) after 30s of silence a lone event refreshes fast again", async () => {
    const { onRefreshGit, emit, unmount } = await mountWithOneWatcher();

    emit();
    await vi.advanceTimersByTimeAsync(500);
    expect(onRefreshGit).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    emit();
    await vi.advanceTimersByTimeAsync(499);
    expect(onRefreshGit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(onRefreshGit).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("(d) a lone event within 5s of a refresh waits for the minimum interval", async () => {
    const { onRefreshGit, emit, unmount } = await mountWithOneWatcher();

    emit();
    await vi.advanceTimersByTimeAsync(500); // refresh at 500ms
    await vi.advanceTimersByTimeAsync(1000); // now 1500ms
    emit();
    await vi.advanceTimersByTimeAsync(3999); // 5499ms: still inside the 5s interval after the 500ms refresh
    expect(onRefreshGit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // 5500ms = last refresh + 5s
    expect(onRefreshGit).toHaveBeenCalledTimes(2);
    unmount();
  });
});

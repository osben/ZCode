// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitFileChange, GitRefreshResult } from "@zcode/shared";
import type { IGitService, IServiceAccessor } from "@zcode/services";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useGitRepository } from "@/hooks/useGitRepository.js";
import { shouldRenderComposerDestinationControl } from "@/v4/composer/destinationControlVisibility.js";

// Keep the fault injection at the Git RPC boundary, with remote routing already resolved.
vi.mock("@/hooks/useResolvedRemoteWorkspaceSessionId.js", () => ({
  useResolvedRemoteWorkspaceSessionId: () => "connected-session",
}));
vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn() } }));
afterEach(cleanup);

const PATH = "/repo";
const TIMEOUT = "git status timed out after 15000ms";

function refreshResult(workspacePath = PATH): GitRefreshResult {
  const change: GitFileChange = {
    path: `${workspacePath}/edited.txt`,
    repoRelativePath: "edited.txt",
    workspaceRelativePath: "edited.txt",
    kind: "modified",
    section: "unstaged",
    added: 2,
    removed: 1,
    isStaged: false,
    isUntracked: false,
    isConflicted: false,
  };
  return {
    summary: {
      workspacePath,
      repoRoot: workspacePath,
      workspaceInRepoPath: ".",
      autoRefreshWatchPaths: [],
      branchName: "main",
      trackingBranchName: "origin/main",
      headRefType: "branch",
      ahead: 0,
      behind: 0,
      isDirty: true,
      isGitAvailable: true,
      isRepository: true,
    },
    identity: {
      userName: "Tester",
      userEmail: "test@example.com",
      nameSource: "local",
      emailSource: "local",
    },
    unstagedChanges: [change],
    stagedChanges: [
      {
        ...change,
        path: `${workspacePath}/staged.txt`,
        workspaceRelativePath: "staged.txt",
        section: "staged",
        isStaged: true,
      },
    ],
    branchComparison: {
      baseRef: "origin/main",
      headRef: "main",
      comparisonLabel: "main -> origin/main",
      changes: [{ ...change, section: "branch" }],
    },
  };
}

function mountHook(refresh: IGitService["refresh"], workspaceIdentity: string | null = null) {
  const services = { gitService: { refresh } } as unknown as IServiceAccessor;
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(ServiceProvider, { services }, children);
  return renderHook(
    (props: { workspacePath: string; workspaceIdentity: string | null; refreshToken: number }) =>
      useGitRepository({
        ...props,
        activeTaskId: null,
        includeExtendedData: true,
      }),
    { wrapper, initialProps: { workspacePath: PATH, workspaceIdentity, refreshToken: 0 } },
  );
}

function deferred() {
  let resolve!: (value: GitRefreshResult) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<GitRefreshResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Git refresh failure isolation", () => {
  it("retains a confirmed snapshot on status timeout, bounds retries, and recovers", async () => {
    const initial = refreshResult();
    const pending = deferred();
    const refresh = vi
      .fn<IGitService["refresh"]>()
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(() => pending.promise)
      .mockRejectedValue(new Error(TIMEOUT));
    const { result, rerender } = mountHook(refresh);
    await waitFor(() => expect(result.current.summary.isRepository).toBe(true));
    const confirmed = result.current;
    rerender({ workspacePath: PATH, workspaceIdentity: null, refreshToken: 1 });
    expect(result.current.loading).toBe(true);
    expect(result.current.summary).toEqual(initial.summary);
    expect(result.current.datasets).toEqual(confirmed.datasets);
    await act(async () => pending.reject(new Error(TIMEOUT)));
    await waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(4);
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBe(TIMEOUT);
    expect(result.current.summary).toEqual(initial.summary);
    expect(result.current.identity).toEqual(initial.identity);
    expect(result.current.datasets).toEqual(confirmed.datasets);
    expect(result.current.revision).toBe(confirmed.revision);
    expect(
      shouldRenderComposerDestinationControl({
        activeWorkspaceKey: PATH,
        gitState: result.current,
      }),
    ).toBe(true);
    await act(async () => {});
    expect(refresh).toHaveBeenCalledTimes(4);

    const recovered = refreshResult();
    recovered.summary.branchName = "recovered";
    recovered.unstagedChanges = [];
    refresh.mockResolvedValue(recovered);
    rerender({ workspacePath: PATH, workspaceIdentity: null, refreshToken: 2 });
    await waitFor(() => expect(result.current.summary.branchName).toBe("recovered"));
    expect(result.current.error).toBeNull();
    expect(result.current.datasets.unstaged.sections).toEqual([]);
    expect(result.current.revision).toBeGreaterThan(confirmed.revision);
  });

  it("discloses comparison failure without discarding rows or entering a retry loop, then recovers", async () => {
    const partial = {
      ...refreshResult(),
      branchComparison: null,
      branchComparisonError: "fatal: bad revision 'origin/missing...HEAD'",
    };
    const refresh = vi.fn<IGitService["refresh"]>().mockResolvedValue(partial);
    const { result, rerender } = mountHook(refresh);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(partial.branchComparisonError);
    expect(result.current.summary).toEqual(partial.summary);
    expect(result.current.identity).toEqual(partial.identity);
    expect(result.current.datasets.unstaged.sections[0]?.changes).toHaveLength(1);
    expect(result.current.datasets.staged.sections[0]?.changes).toHaveLength(1);
    expect(result.current.datasets.branch.sections).toEqual([]);
    await act(async () => {});
    expect(refresh).toHaveBeenCalledTimes(1);
    refresh.mockResolvedValue(refreshResult());
    rerender({ workspacePath: PATH, workspaceIdentity: null, refreshToken: 1 });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.datasets.branch.sections[0]?.changes).toHaveLength(1);
    });
  });

  it("gives another path under the same identity its own bounded retry budget", async () => {
    const refresh = vi.fn<IGitService["refresh"]>().mockRejectedValue(new Error(TIMEOUT));
    const { result, rerender } = mountHook(refresh, "shared-identity");
    await waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(3);
      expect(result.current.loading).toBe(false);
    });
    rerender({
      workspacePath: "/other-path",
      workspaceIdentity: "shared-identity",
      refreshToken: 0,
    });
    await waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(6);
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBe(TIMEOUT);
    expect(result.current.summary.isRepository).toBe(false);
  });

  it("does not re-issue a deferred comparison failure after a confirmed refresh", async () => {
    const pending = deferred();
    const refresh = vi
      .fn<IGitService["refresh"]>()
      .mockResolvedValueOnce(refreshResult())
      .mockImplementation(() => pending.promise);
    const { result, rerender } = mountHook(refresh);
    await waitFor(() => expect(result.current.summary.isRepository).toBe(true));
    rerender({ workspacePath: PATH, workspaceIdentity: null, refreshToken: 1 });
    expect(result.current.loading).toBe(true);
    await act(async () =>
      pending.resolve({
        ...refreshResult(),
        branchComparison: null,
        branchComparisonError: "missing ref",
      }),
    );
    await waitFor(() => expect(result.current.error).toBe("missing ref"));
    expect(result.current.loading).toBe(false);
    expect(result.current.datasets.branch.sections).toEqual([]);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      workspacePath: PATH,
      workspaceIdentity: "another-identity",
      initialIdentity: "first-identity",
    },
    {
      workspacePath: "/another-path",
      workspaceIdentity: "same-identity",
      initialIdentity: "same-identity",
    },
    { workspacePath: "/another-path", workspaceIdentity: null, initialIdentity: null },
  ])(
    "never retains data for a different target: $workspacePath / $workspaceIdentity",
    async (target) => {
      const pending = deferred();
      const refresh = vi
        .fn<IGitService["refresh"]>()
        .mockResolvedValueOnce(refreshResult())
        .mockImplementation(() => pending.promise);
      const { result, rerender } = mountHook(refresh, target.initialIdentity);
      await waitFor(() => expect(result.current.summary.isRepository).toBe(true));
      rerender({ ...target, refreshToken: 0 });
      expect(result.current.summary.isRepository).toBe(false);
      expect(result.current.identity.userName).toBeNull();
      expect(result.current.datasets.unstaged.sections).toEqual([]);
      await act(async () => pending.reject(new Error(TIMEOUT)));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.summary.isRepository).toBe(false);
      expect(result.current.error).toBe(TIMEOUT);
      expect(result.current.datasets.staged.sections).toEqual([]);
      expect(refresh).toHaveBeenCalledTimes(4);
    },
  );

  it.each([false, true])(
    "replaces stale repository data with an authoritative non-repository result (Git installed: %s)",
    async (isGitAvailable) => {
      const refresh = vi.fn<IGitService["refresh"]>().mockResolvedValue(refreshResult());
      const { result, rerender } = mountHook(refresh);
      await waitFor(() => expect(result.current.summary.isRepository).toBe(true));
      const unavailable = refreshResult();
      unavailable.summary = {
        ...unavailable.summary,
        isGitAvailable,
        isRepository: false,
        isDirty: false,
        branchName: null,
        trackingBranchName: null,
      };
      unavailable.unstagedChanges = [];
      unavailable.stagedChanges = [];
      unavailable.identity = null;
      unavailable.branchComparison = null;
      refresh.mockResolvedValue(unavailable);
      rerender({ workspacePath: PATH, workspaceIdentity: null, refreshToken: 1 });
      await waitFor(() => expect(result.current.summary.isRepository).toBe(false));
      expect(result.current.summary.isGitAvailable).toBe(isGitAvailable);
      expect(result.current.error).toBeNull();
      expect(result.current.identity.userName).toBeNull();
      expect(result.current.datasets.unstaged.sections).toEqual([]);
      refresh.mockResolvedValue(refreshResult());
      rerender({ workspacePath: PATH, workspaceIdentity: null, refreshToken: 2 });
      await waitFor(() => expect(result.current.summary.isRepository).toBe(true));
    },
  );

  it.each(["resolve", "reject"] as const)(
    "ignores a stale %s after A → B → A while a newer refresh is pending",
    async (settle) => {
      const stale = deferred();
      const current = deferred();
      const refresh = vi
        .fn<IGitService["refresh"]>()
        .mockResolvedValueOnce(refreshResult())
        .mockImplementationOnce(() => stale.promise)
        .mockResolvedValueOnce(refreshResult("/other"))
        .mockImplementation(() => current.promise);
      const { result, rerender } = mountHook(refresh);
      await waitFor(() => expect(result.current.summary.isRepository).toBe(true));
      rerender({ workspacePath: PATH, workspaceIdentity: null, refreshToken: 1 });
      rerender({ workspacePath: "/other", workspaceIdentity: null, refreshToken: 1 });
      await waitFor(() => {
        expect(result.current.summary.workspacePath).toBe("/other");
        expect(result.current.loading).toBe(false);
      });
      rerender({ workspacePath: PATH, workspaceIdentity: null, refreshToken: 2 });
      await act(async () => {
        if (settle === "resolve") stale.resolve(refreshResult());
        else stale.reject(new Error(TIMEOUT));
      });
      expect(result.current.loading).toBe(true);
      expect(result.current.summary.isRepository).toBe(false);
      expect(result.current.error).toBeNull();
      const recovered = refreshResult();
      recovered.summary.branchName = "newest";
      await act(async () => current.resolve(recovered));
      await waitFor(() => expect(result.current.summary.branchName).toBe("newest"));
      expect(refresh).toHaveBeenCalledTimes(4);
    },
  );
});

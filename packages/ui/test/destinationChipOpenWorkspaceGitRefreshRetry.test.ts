// @vitest-environment jsdom
// BUG-GWT-013 (docs/testing/git-worktree-qa/bugs/BUG-GWT-013.md): after a workspace is opened
// programmatically (--open-workspace / second instance), the destination chip
// ("Choose where this task runs") stays hidden until a renderer reload. The chip is gated on
// useGitRepository state (shouldRenderComposerDestinationControl), and the hook issues exactly
// one gitService.refresh per workspace switch: if that in-flight result is dropped (effect
// cleanup while logical inputs stay equal — e.g. a services identity swap during the
// open-workspace reconnect burst), shouldRefreshLiveGitData sees identical inputs forever and
// never re-issues the request, so summary.isRepository never resolves without a remount or a
// workspace switch. The it.fails test below pins the desired self-healing behavior.
import { createElement, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GitRefreshResult, GitRepositorySummary } from "@zcode/shared";
import type { IGitService, IServiceAccessor } from "@zcode/services";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useGitRepository } from "@/hooks/useGitRepository.js";
import { shouldRenderComposerDestinationControl } from "@/v4/composer/destinationControlVisibility.js";

const WORKSPACE_PATH = "/qa/repos/empty";

function createRepositorySummary(workspacePath: string): GitRepositorySummary {
  return {
    workspacePath,
    repoRoot: workspacePath,
    workspaceInRepoPath: ".",
    autoRefreshWatchPaths: [],
    branchName: "main",
    trackingBranchName: null,
    headRefType: "branch",
    ahead: 0,
    behind: 0,
    isDirty: false,
    isGitAvailable: true,
    isRepository: true,
  };
}

function createRefreshResult(workspacePath: string): GitRefreshResult {
  return {
    summary: createRepositorySummary(workspacePath),
    identity: {
      userName: null,
      userEmail: null,
      nameSource: null,
      emailSource: null,
      scopeLabel: null,
    },
    unstagedChanges: [],
    stagedChanges: [],
    branchComparison: {
      baseRef: null,
      headRef: null,
      comparisonLabel: null,
      changes: [],
    },
  };
}

interface DeferredGitServiceDouble {
  gitService: IGitService;
  refreshCalls: string[];
  resolvePendingRefresh: (result: GitRefreshResult) => void;
}

// RPC-boundary double: refresh stays pending until the test resolves it, mimicking the
// in-flight request that the renderer drops while the host already completed it (see bug log).
function createDeferredGitService(): DeferredGitServiceDouble {
  const refreshCalls: string[] = [];
  const resolvers: Array<(result: GitRefreshResult) => void> = [];
  const gitService = {
    refresh: (params: { workspacePath: string }) =>
      new Promise<GitRefreshResult>((resolve) => {
        refreshCalls.push(params.workspacePath);
        resolvers.push(resolve);
      }),
  } as unknown as IGitService;
  return {
    gitService,
    refreshCalls,
    resolvePendingRefresh: (result) => {
      const resolve = resolvers.shift();
      resolve?.(result);
    },
  };
}

function createAccessor(gitService: IGitService): IServiceAccessor {
  return { gitService } as unknown as IServiceAccessor;
}

function renderGitRepositoryHook(gitService: IGitService) {
  let currentServices = createAccessor(gitService);
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(ServiceProvider, { services: currentServices }, children);
  const utils = renderHook(
    ({ tick }: { tick: number }) => {
      void tick;
      return useGitRepository({
        workspacePath: WORKSPACE_PATH,
        activeTaskId: null,
        refreshToken: null,
        remoteSessionId: null,
        workspaceIdentity: null,
      });
    },
    { initialProps: { tick: 0 }, wrapper },
  );
  return {
    ...utils,
    swapServices: (nextGitService: IGitService) => {
      currentServices = createAccessor(nextGitService);
      utils.rerender({ tick: utils.result.current.revision + 1 });
    },
  };
}

describe("useGitRepository destination chip resolution after programmatic open-workspace", () => {
  it("applies the initial git refresh for a newly opened workspace (control case)", async () => {
    const connection = createDeferredGitService();
    const { result } = renderGitRepositoryHook(connection.gitService);

    await waitFor(() => expect(connection.refreshCalls).toHaveLength(1));
    await act(async () => {
      connection.resolvePendingRefresh(createRefreshResult(WORKSPACE_PATH));
    });

    await waitFor(() => expect(result.current.summary.isRepository).toBe(true));
    expect(
      shouldRenderComposerDestinationControl({
        activeWorkspaceKey: WORKSPACE_PATH,
        gitState: result.current,
      }),
    ).toBe(true);
  });

  it.fails("BUG-GWT-013: re-issues the initial git refresh when the in-flight result is dropped, so the destination chip resolves without a reload", async () => {
    const firstConnection = createDeferredGitService();
    const reconnectedService = createDeferredGitService();
    const { result, swapServices } = renderGitRepositoryHook(firstConnection.gitService);

    // The open-workspace switch issued the single initial refresh.
    await waitFor(() => expect(firstConnection.refreshCalls).toHaveLength(1));
    expect(result.current.summary.isRepository).toBe(false);

    // The open burst swaps the services identity (workspace connection rebuild) while the
    // refresh is still in flight: logical inputs stay equal, so no second refresh starts.
    swapServices(reconnectedService.gitService);
    expect(reconnectedService.refreshCalls).toHaveLength(0);

    // The host already resolved the first request, but the effect cleanup disposed it.
    await act(async () => {
      firstConnection.resolvePendingRefresh(createRefreshResult(WORKSPACE_PATH));
    });

    // Desired behavior (currently broken, see bug file): the dropped initial result must
    // self-heal — a new refresh is issued and the destination chip gate resolves without a
    // renderer reload or a workspace tab switch.
    await waitFor(
      () => {
        expect(result.current.summary.isRepository).toBe(true);
        expect(
          shouldRenderComposerDestinationControl({
            activeWorkspaceKey: WORKSPACE_PATH,
            gitState: result.current,
          }),
        ).toBe(true);
      },
      { timeout: 500 },
    );
    expect(
      firstConnection.refreshCalls.length + reconnectedService.refreshCalls.length,
    ).toBeGreaterThanOrEqual(2);
  });
});

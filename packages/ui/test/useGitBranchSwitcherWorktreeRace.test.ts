// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { gitService } = vi.hoisted(() => ({
  gitService: {
    getLocalBranches: vi.fn(async () => ({ branches: [] })),
    listWorktrees: vi.fn(async () => ({ worktrees: [] })),
  },
}));
vi.mock("@/hooks/useServices.js", () => ({ useServices: () => ({ gitService }) }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: () => "" }, locale: "en" }),
}));

import { useGitBranchSwitcher } from "@/hooks/useGitBranchSwitcher.js";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useGitBranchSwitcher worktree occupancy", () => {
  it("ignores a listWorktrees response from the previous workspace", async () => {
    let resolveOld!: (value: {
      worktrees: Array<{ branchName: string; isCurrent: boolean; path: string }>;
    }) => void;
    gitService.listWorktrees.mockImplementationOnce(
      () => new Promise((resolve) => (resolveOld = resolve)),
    );
    gitService.listWorktrees.mockResolvedValueOnce({ worktrees: [] });
    const options = (workspacePath: string) => ({
      workspacePath,
      currentBranchName: "main",
      headRefType: "branch" as const,
      onRefreshGit: vi.fn(),
    });
    const { result, rerender } = renderHook(
      ({ workspacePath }) => useGitBranchSwitcher(options(workspacePath)),
      { initialProps: { workspacePath: "/repo/one" } },
    );
    act(() => result.current.setOpen(true));
    rerender({ workspacePath: "/repo/two" });
    await act(async () => {
      resolveOld({
        worktrees: [{ branchName: "stale", isCurrent: false, path: "/repo/one/.worktrees/stale" }],
      });
    });
    expect(result.current.worktreeOccupancy.size).toBe(0);
  });
});

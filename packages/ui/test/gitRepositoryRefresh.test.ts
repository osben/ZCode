import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  matchesGitRepositoryTarget,
  shouldRefreshLiveGitData,
} from "../src/hooks/useGitRepository.js";

describe("shouldRefreshLiveGitData", () => {
  it("does not reuse repository state for a different execution path under the same identity", () => {
    expect(
      matchesGitRepositoryTarget(
        { workspaceKey: "remote:ssh:host:/root", workspacePath: "/root/worktree-a" },
        { workspaceKey: "remote:ssh:host:/root", workspacePath: "/root/worktree-b" },
      ),
    ).toBe(false);
    expect(
      matchesGitRepositoryTarget(
        { workspaceKey: "remote:ssh:host:/root", workspacePath: "/root/worktree-a" },
        { workspaceKey: "remote:ssh:host:/root", workspacePath: "/root/worktree-a" },
      ),
    ).toBe(true);
  });

  it("refreshes on initial load and workspace changes", () => {
    expect(
      shouldRefreshLiveGitData(null, {
        workspacePath: "/repo-a",
        workspaceKey: "/repo-a",
        includeExtendedData: false,
        refreshToken: 0,
        workspaceRpcEnabled: true,
      }),
    ).toBe(true);

    expect(
      shouldRefreshLiveGitData(
        {
          workspacePath: "/repo-a",
          workspaceKey: "/repo-a",
          includeExtendedData: false,
          refreshToken: 0,
          workspaceRpcEnabled: true,
        },
        {
          workspacePath: "/repo-b",
          workspaceKey: "/repo-b",
          includeExtendedData: false,
          refreshToken: 0,
          workspaceRpcEnabled: true,
        },
      ),
    ).toBe(true);
  });

  it("clears the live refresh baseline while disabled so re-enabling fetches unchanged inputs", () => {
    const source = readFileSync("packages/ui/src/hooks/useGitRepository.ts", "utf8");
    const disabledBranch = source.slice(
      source.indexOf("if (!enabled) {"),
      source.indexOf("if (!workspaceRpcEnabled) {"),
    );

    expect(disabledBranch).toContain("lastLiveRefreshInputRef.current = null;");
    expect(
      shouldRefreshLiveGitData(null, {
        workspacePath: "/repo-a",
        workspaceKey: "/repo-a",
        includeExtendedData: false,
        refreshToken: 0,
        workspaceRpcEnabled: true,
      }),
    ).toBe(true);
  });

  it("refreshes when the pane opens or user triggers an explicit refresh", () => {
    expect(
      shouldRefreshLiveGitData(
        {
          workspacePath: "/repo-a",
          workspaceKey: "/repo-a",
          includeExtendedData: false,
          refreshToken: 0,
          workspaceRpcEnabled: true,
        },
        {
          workspacePath: "/repo-a",
          workspaceKey: "/repo-a",
          includeExtendedData: true,
          refreshToken: 0,
          workspaceRpcEnabled: true,
        },
      ),
    ).toBe(true);

    expect(
      shouldRefreshLiveGitData(
        {
          workspacePath: "/repo-a",
          workspaceKey: "/repo-a",
          includeExtendedData: true,
          refreshToken: 0,
          workspaceRpcEnabled: true,
        },
        {
          workspacePath: "/repo-a",
          workspaceKey: "/repo-a",
          includeExtendedData: true,
          refreshToken: 1,
          workspaceRpcEnabled: true,
        },
      ),
    ).toBe(true);
  });

  it("refreshes when workspace identity changes even if the remote path is the same", () => {
    expect(
      shouldRefreshLiveGitData(
        {
          workspacePath: "/root",
          workspaceKey: "remote:ssh:root@server-a:/root",
          includeExtendedData: false,
          refreshToken: 0,
          workspaceRpcEnabled: true,
        },
        {
          workspacePath: "/root",
          workspaceKey: "remote:ssh:root@server-b:/root",
          includeExtendedData: false,
          refreshToken: 0,
          workspaceRpcEnabled: true,
        },
      ),
    ).toBe(true);
  });

  it("does not refresh when only the pane closes or task-local data changes", () => {
    expect(
      shouldRefreshLiveGitData(
        {
          workspacePath: "/repo-a",
          workspaceKey: "/repo-a",
          includeExtendedData: true,
          refreshToken: 1,
          workspaceRpcEnabled: true,
        },
        {
          workspacePath: "/repo-a",
          workspaceKey: "/repo-a",
          includeExtendedData: false,
          refreshToken: 1,
          workspaceRpcEnabled: true,
        },
      ),
    ).toBe(false);

    expect(
      shouldRefreshLiveGitData(
        {
          workspacePath: "/repo-a",
          workspaceKey: "/repo-a",
          includeExtendedData: false,
          refreshToken: 1,
          workspaceRpcEnabled: true,
        },
        {
          workspacePath: "/repo-a",
          workspaceKey: "/repo-a",
          includeExtendedData: false,
          refreshToken: 1,
          workspaceRpcEnabled: true,
        },
      ),
    ).toBe(false);
  });

  it("does not refresh disconnected remote placeholders until workspace RPC is available", () => {
    expect(
      shouldRefreshLiveGitData(null, {
        workspacePath: "/root",
        workspaceKey: "remote:ssh:root@server:/root",
        includeExtendedData: false,
        refreshToken: 0,
        workspaceRpcEnabled: false,
      }),
    ).toBe(false);

    expect(
      shouldRefreshLiveGitData(
        {
          workspacePath: "/root",
          workspaceKey: "remote:ssh:root@server:/root",
          includeExtendedData: false,
          refreshToken: 0,
          workspaceRpcEnabled: false,
        },
        {
          workspacePath: "/root",
          workspaceKey: "remote:ssh:root@server:/root",
          includeExtendedData: false,
          refreshToken: 0,
          workspaceRpcEnabled: true,
        },
      ),
    ).toBe(true);
  });
});

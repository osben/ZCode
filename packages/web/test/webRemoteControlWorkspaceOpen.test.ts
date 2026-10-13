import { describe, expect, it, vi } from "vitest";
import { openWebRemoteControlWorkspace } from "@web/webRemoteControlWorkspaceOpen.js";
import type { WebRemoteControlWorkspaceListResult } from "@zcode/shared";

function createListResult(
  workspaces: Array<{ workspacePath: string; workspaceIdentity?: string }>,
): WebRemoteControlWorkspaceListResult {
  return {
    workspaces: workspaces.map((workspace) => ({
      workspacePath: workspace.workspacePath,
      ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
      label: workspace.workspacePath,
      kind: "local" as const,
    })),
  };
}

function createDeps(options?: {
  listResults?: WebRemoteControlWorkspaceListResult[];
  requestWorkspaceOpen?: () => Promise<void>;
}) {
  const listResults = options?.listResults ?? [
    createListResult([{ workspacePath: "/workspace/demo-worktrees/feature" }]),
  ];
  const deps = {
    requestWorkspaceOpen: options?.requestWorkspaceOpen ?? vi.fn(async () => undefined),
    // Consumes one queued result per call; the last queued result repeats for further attempts.
    listWorkspaces: vi.fn(async () => {
      if (listResults.length > 1) {
        return listResults.shift() as WebRemoteControlWorkspaceListResult;
      }
      return listResults[0];
    }),
    switchWorkspace: vi.fn(async () => undefined),
    delay: vi.fn(async () => undefined),
  };
  return deps;
}

describe("openWebRemoteControlWorkspace", () => {
  it("requests the desktop open, then switches through the existing bridge when listed", async () => {
    const deps = createDeps();

    await openWebRemoteControlWorkspace({
      target: { workspacePath: "/workspace/demo-worktrees/feature" },
      deps,
    });

    expect(deps.requestWorkspaceOpen).toHaveBeenCalledWith({
      workspacePath: "/workspace/demo-worktrees/feature",
    });
    expect(deps.switchWorkspace).toHaveBeenCalledTimes(1);
    expect(deps.switchWorkspace).toHaveBeenCalledWith("/workspace/demo-worktrees/feature");
    expect(deps.delay).not.toHaveBeenCalled();
  });

  it("retries the workspace list with a bounded delay before switching", async () => {
    const deps = createDeps({
      listResults: [
        createListResult([{ workspacePath: "/workspace/demo" }]),
        createListResult([{ workspacePath: "/workspace/demo-worktrees/feature" }]),
      ],
    });

    await openWebRemoteControlWorkspace({
      target: { workspacePath: "/workspace/demo-worktrees/feature" },
      deps,
    });

    expect(deps.listWorkspaces).toHaveBeenCalledTimes(2);
    expect(deps.delay).toHaveBeenCalledTimes(1);
    expect(deps.switchWorkspace).toHaveBeenCalledWith("/workspace/demo-worktrees/feature");
  });

  it("matches by workspace identity first and never falls back to the bare path", async () => {
    const identity = "remote:ssh:dev:/workspace/demo-worktrees/feature";
    const deps = createDeps({
      listResults: [
        // Same path without identity must not satisfy a target that carries identity.
        createListResult([{ workspacePath: "/workspace/demo-worktrees/feature" }]),
        createListResult([
          { workspacePath: "/workspace/demo-worktrees/feature", workspaceIdentity: identity },
        ]),
      ],
    });

    await openWebRemoteControlWorkspace({
      target: { workspacePath: "/workspace/demo-worktrees/feature", workspaceIdentity: identity },
      deps,
    });

    expect(deps.switchWorkspace).toHaveBeenCalledWith(identity);
  });

  it("fails after the bounded list attempts when the workspace never appears", async () => {
    const deps = createDeps({
      listResults: [createListResult([{ workspacePath: "/workspace/demo" }])],
    });

    await expect(
      openWebRemoteControlWorkspace({
        target: { workspacePath: "/workspace/demo-worktrees/feature" },
        deps,
        listAttempts: 3,
        retryDelayMs: 1,
      }),
    ).rejects.toThrow(
      "Opened workspace did not appear in the Web remote control workspace list: /workspace/demo-worktrees/feature",
    );
    expect(deps.listWorkspaces).toHaveBeenCalledTimes(3);
    expect(deps.delay).toHaveBeenCalledTimes(2);
    expect(deps.switchWorkspace).not.toHaveBeenCalled();
  });

  it("propagates desktop open failures without touching the workspace list or bridge", async () => {
    const deps = createDeps({
      requestWorkspaceOpen: async () => {
        throw new Error("Desktop window is not available for Web remote control workspace open.");
      },
    });

    await expect(
      openWebRemoteControlWorkspace({
        target: { workspacePath: "/workspace/demo-worktrees/feature" },
        deps,
      }),
    ).rejects.toThrow("Desktop window is not available");

    expect(deps.listWorkspaces).not.toHaveBeenCalled();
    expect(deps.switchWorkspace).not.toHaveBeenCalled();
  });
});

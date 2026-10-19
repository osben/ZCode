// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppPanels } from "@/hooks/useAppPanels.js";
import { clearTaskSidePaneMemoryStateForTest } from "@/lib/taskSidePaneMemory.js";

vi.mock("@/hooks/useInterfaceMode.js", () => ({ useIsOfficeMode: () => false }));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ zcodeAgentService: {}, zcodeSessionService: { closeSession: vi.fn() } }),
}));

const WORKSPACE_PATH = "/repo";

function renderPanels(options: {
  terminalCwd: string;
  activeTaskId: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}) {
  return renderHook(
    ({ terminalCwd, activeTaskId }) =>
      useAppPanels({
        workspaceAbsPath: WORKSPACE_PATH,
        terminalCwd,
        workspaceIdentity: options.workspaceIdentity,
        workspaceRemoteSessionId: options.workspaceRemoteSessionId,
        activeTaskId,
        sidePaneOwnerId: activeTaskId,
        isDesktop: true,
        isWorkspaceVisible: true,
        defaultWhiteboardNamePrefix: "Whiteboard",
      }),
    { initialProps: { terminalCwd: options.terminalCwd, activeTaskId: options.activeTaskId } },
  );
}

describe("useAppPanels terminal worktree cwd", () => {
  beforeEach(() => clearTaskSidePaneMemoryStateForTest());
  afterEach(() => clearTaskSidePaneMemoryStateForTest());

  it("uses the active task cwd without changing local workspace ownership or existing terminals", () => {
    const { result, rerender, unmount } = renderPanels({
      terminalCwd: "/repo/.worktrees/task-a",
      activeTaskId: "task-a",
    });

    act(() => result.current.handleOpenTerminalTab());
    const originalTab = result.current.sidePaneState?.tabs.find((tab) => tab.type === "terminal");
    expect(originalTab).toMatchObject({
      cwd: "/repo/.worktrees/task-a",
      ownerTaskId: "task-a",
      workspaceKey: WORKSPACE_PATH,
    });

    rerender({ terminalCwd: "/repo/.worktrees/task-b", activeTaskId: "task-b" });
    expect(result.current.sidePaneState?.tabs).toContainEqual(originalTab);

    act(() => result.current.handleOpenTerminalTab());
    const terminalTabs = result.current.sidePaneState?.tabs.filter(
      (tab) => tab.type === "terminal",
    );
    expect(terminalTabs).toHaveLength(2);
    expect(terminalTabs?.[0]).toMatchObject({ cwd: "/repo/.worktrees/task-a" });
    expect(terminalTabs?.[1]).toMatchObject({
      cwd: "/repo/.worktrees/task-b",
      ownerTaskId: "task-b",
      workspaceKey: WORKSPACE_PATH,
    });
    unmount();
  });

  it("preserves remote workspace ownership and session routing", () => {
    const { result, unmount } = renderPanels({
      terminalCwd: "/remote/repo/.worktrees/task-a",
      activeTaskId: "remote-task-a",
      workspaceIdentity: "ssh://host/repo",
      workspaceRemoteSessionId: "remote-session-a",
    });

    act(() => result.current.handleOpenTerminalTab());

    expect(result.current.sidePaneState?.tabs.find((tab) => tab.type === "terminal")).toMatchObject(
      {
        cwd: "/remote/repo/.worktrees/task-a",
        ownerTaskId: "remote-task-a",
        workspaceKey: "ssh://host/repo",
        remoteSessionId: "remote-session-a",
      },
    );
    unmount();
  });
});

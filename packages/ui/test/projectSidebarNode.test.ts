// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement, type ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectSidebarNode } from "@/project-sidebar/ProjectSidebarNode.js";

const probes = vi.hoisted(() => ({
  node: vi.fn(),
  getRepositoryRemotes: vi.fn(),
  openExternal: vi.fn(),
  openSettingsTab: vi.fn(),
  setIntent: vi.fn(),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServices: () => ({
    gitService: { getRepositoryRemotes: probes.getRepositoryRemotes },
  }),
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => ({ openExternal: probes.openExternal }),
}));
vi.mock("@/lib/settingsNavigation.js", () => ({
  setPendingSettingsSectionIntent: probes.setIntent,
}));
vi.mock("@/project-sidebar/ProjectNode.js", () => ({
  ProjectNode: (props: { onCreate(): void }) => {
    probes.node(props);
    return createElement("button", { onClick: props.onCreate }, "Create");
  },
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStoreApi: () => ({ getState: () => ({ openSettingsTab: probes.openSettingsTab }) }),
}));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => async () => true }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function fixture(): ComponentProps<typeof ProjectSidebarNode> {
  return {
    project: {
      id: "p",
      hostId: "local",
      name: "Project",
      roots: [],
      pinned: false,
      deleted: false,
      position: 0,
      createdAt: 1,
      updatedAt: 1,
      nameOverridden: false,
    },
    tasks: [
      {
        taskId: "s",
        hostId: "local",
        workspacePath: "/example",
        projectId: "p",
        title: "Task",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    expanded: true,
    onExpandedChange: vi.fn(),
    onEdit: vi.fn(),
    onViewFiles: vi.fn(async () => {}),
    onSelect: vi.fn(),
    onCreateTask: vi.fn(),
    onReconnectRemoteWorkspace: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    remoteActions: () => [],
  };
}

it("等价任务数组不刷新项目；任务字段、顺序与成员变化仍传入内容层", () => {
  const props = fixture();
  const { rerender } = render(createElement(ProjectSidebarNode, props));
  rerender(createElement(ProjectSidebarNode, { ...props, tasks: [...props.tasks] }));
  expect(probes.node).toHaveBeenCalledTimes(1);
  const changed = { ...props.tasks[0]!, title: "Renamed task" };
  const other = { ...changed, taskId: "other" };
  for (const tasks of [[changed], [changed, other], [other, changed], []]) {
    probes.node.mockClear();
    rerender(createElement(ProjectSidebarNode, { ...props, tasks }));
    expect(probes.node).toHaveBeenCalledOnce();
    expect(probes.node.mock.lastCall![0].tasks).toBe(tasks);
  }
});

it("回调与项目身份变化不能被 memo 忽略，新建始终使用当前目标", () => {
  const props = fixture();
  const { rerender, getByText } = render(createElement(ProjectSidebarNode, props));
  const latestCreate = vi.fn();
  rerender(createElement(ProjectSidebarNode, { ...props, onCreateTask: latestCreate }));
  fireEvent.click(getByText("Create"));
  expect(props.onCreateTask).not.toHaveBeenCalled();
  expect(latestCreate).toHaveBeenLastCalledWith({ projectId: "p", taskGroupId: null });
  const project = { ...props.project, id: "remote-p", hostId: "remote:server:example" };
  rerender(
    createElement(ProjectSidebarNode, {
      ...props,
      project,
      isWebRemoteControl: true,
      onCreateTask: latestCreate,
    }),
  );
  fireEvent.click(getByText("Create"));
  expect(latestCreate).toHaveBeenLastCalledWith({
    projectId: "remote-p",
    hostId: "remote:server:example",
    taskGroupId: null,
  });
});

const rootedProject = () => ({
  ...fixture().project,
  roots: [{ rootPath: "/repo", position: 0, isPrimary: true }],
});

it("Manage sessions opens the sessions section scoped to the project's primary root", () => {
  render(createElement(ProjectSidebarNode, { ...fixture(), project: rootedProject() }));
  probes.node.mock.lastCall![0].onManageSessions();
  expect(probes.setIntent).toHaveBeenCalledWith("sessions", {
    sessionsScope: { workspacePath: "/repo" },
  });
  expect(probes.openSettingsTab).toHaveBeenCalledOnce();
});

it("hides Manage sessions for a project without roots", () => {
  render(createElement(ProjectSidebarNode, fixture()));
  expect(probes.node.mock.lastCall![0].onManageSessions).toBeUndefined();
});

it("reads the GitHub remote only when a menu opens and opens it externally", async () => {
  probes.getRepositoryRemotes.mockResolvedValue({
    remotes: [
      { name: "gl", url: "git@gitlab.com:o/r.git" },
      { name: "origin", url: "git@github.com:o/r.git" },
    ],
  });
  render(createElement(ProjectSidebarNode, { ...fixture(), project: rootedProject() }));
  expect(probes.getRepositoryRemotes).not.toHaveBeenCalled();
  expect(probes.node.mock.lastCall![0].onOpenGitHub).toBeUndefined();
  act(() => probes.node.mock.lastCall![0].onMenuOpen());
  await waitFor(() => expect(probes.node.mock.lastCall![0].onOpenGitHub).toBeDefined());
  probes.node.mock.lastCall![0].onOpenGitHub();
  expect(probes.openExternal).toHaveBeenCalledWith("https://github.com/o/r");
});

it("shows no GitHub item when the remote is not on GitHub", async () => {
  probes.getRepositoryRemotes.mockResolvedValue({
    remotes: [{ name: "origin", url: "git@gitlab.com:o/r.git" }],
  });
  render(createElement(ProjectSidebarNode, { ...fixture(), project: rootedProject() }));
  act(() => probes.node.mock.lastCall![0].onMenuOpen());
  await waitFor(() => expect(probes.getRepositoryRemotes).toHaveBeenCalled());
  expect(probes.node.mock.lastCall![0].onOpenGitHub).toBeUndefined();
});

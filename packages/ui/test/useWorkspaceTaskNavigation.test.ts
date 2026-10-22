// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import type { IServiceAccessor } from "@zcode/services";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useWorkspaceTaskNavigation } from "@/app-shell/useWorkspaceTaskNavigation.js";
import { createTaskNavigationHistory } from "@/lib/taskNavigationHistory.js";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

const tabStore = vi.hoisted(() => {
  let state: {
    activeTabId: string | null;
    tabs: Array<{
      id: string;
      kind: "workspace";
      label: string;
      workspacePath: string;
      workspaceIdentity?: string;
      remoteSessionId?: string;
    }>;
  } = { activeTabId: null, tabs: [] };
  return {
    api: { getState: () => state },
    setState: (next: typeof state) => {
      state = next;
    },
  };
});

vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStoreApi: () => tabStore.api,
}));

const localWorkspacePath = "/work/local";
const taskId = "task-local";

function taskMeta(params: { workspacePath?: string; workspaceIdentity?: string } = {}) {
  const workspacePath = params.workspacePath ?? localWorkspacePath;
  return {
    taskId,
    traceId: "trace-local",
    title: "local task",
    workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    createdAt: 1,
    updatedAt: 2,
    mode: "default" as const,
    unreadAt: 2,
  };
}

function servicesWithSetTaskUnread(setTaskUnread: ReturnType<typeof vi.fn>): IServiceAccessor {
  return { zcodeTaskService: { setTaskUnread } } as unknown as IServiceAccessor;
}

function renderNavigation(params: {
  ambientServices: IServiceAccessor;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  workspacePath?: string;
  workspaceIdentity?: string;
  onNavigateToAutomations?: ReturnType<typeof vi.fn>;
}) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(ServiceProvider, { services: params.ambientServices }, children);
  return renderHook(
    () =>
      useWorkspaceTaskNavigation({
        intl: { formatMessage: ({ id }) => id },
        workspaceAbsPath: params.workspacePath ?? "/home/dev",
        workspaceIdentity: params.workspaceIdentity ?? "remote:ssh:dev:22:user:/home/dev",
        activateTabByPath: params.activateTabByPath,
        onNavigateToAutomations: params.onNavigateToAutomations,
      }),
    { wrapper },
  );
}

describe("useWorkspaceTaskNavigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tabStore.setState({ activeTabId: null, tabs: [] });
    useTaskQueryCacheStore.getState().clearAll();
    useRemoteWorkspaceSessionStore.setState({
      baseServices: null,
      sessionsById: {},
      sessionIdByWorkspacePath: {},
      sessionIdByWorkspaceIdentity: {},
    });
    useZCodeSessionStore.setState({ taskNavHistory: createTaskNavigationHistory() });
    useZCodeSessionStore.getState().setTaskNavDeletedTasks([]);
  });

  it("把 Idle-time intent 写入 Automations 导航目标和历史", () => {
    const onNavigateToAutomations = vi.fn();
    const hook = renderNavigation({
      ambientServices: servicesWithSetTaskUnread(vi.fn()),
      activateTabByPath: vi.fn(() => true),
      onNavigateToAutomations,
    });

    act(() => {
      hook.result.current.handleOpenAutomations(undefined, "idle");
    });

    expect(onNavigateToAutomations).toHaveBeenCalledWith({
      workspacePath: "/home/dev",
      workspaceIdentity: "remote:ssh:dev:22:user:/home/dev",
      automationTab: "idle",
    });
    expect(useZCodeSessionStore.getState().taskNavHistory.entries).toEqual([
      {
        kind: "automations",
        workspacePath: "/home/dev",
        workspaceIdentity: "remote:ssh:dev:22:user:/home/dev",
        automationTab: "idle",
      },
    ]);
    hook.unmount();
  });

  it("前进回放时恢复 Idle-time Automations intent", () => {
    const onNavigateToAutomations = vi.fn();
    const activateTabByPath = vi.fn(() => true);
    useZCodeSessionStore.setState({
      taskNavHistory: {
        entries: [
          {
            kind: "task",
            workspacePath: "/home/dev",
            workspaceIdentity: "remote:ssh:dev:22:user:/home/dev",
            taskId: "task-before-automations",
          },
          {
            kind: "automations",
            workspacePath: "/home/dev",
            workspaceIdentity: "remote:ssh:dev:22:user:/home/dev",
            automationTab: "idle",
          },
        ],
        cursor: 0,
      },
    });
    const hook = renderNavigation({
      ambientServices: servicesWithSetTaskUnread(vi.fn()),
      activateTabByPath,
      onNavigateToAutomations,
    });

    act(() => {
      hook.result.current.handleTaskNavForward();
    });

    expect(activateTabByPath).toHaveBeenCalledWith("/home/dev", {
      workspaceIdentity: "remote:ssh:dev:22:user:/home/dev",
    });
    expect(onNavigateToAutomations).toHaveBeenCalledWith({
      workspacePath: "/home/dev",
      workspaceIdentity: "remote:ssh:dev:22:user:/home/dev",
      automationTab: "idle",
    });
    hook.unmount();
  });

  it("从 remote workspace 选择本地 task 时通过 window base services 清除未读", async () => {
    const baseSetTaskUnread = vi.fn(async () => taskMeta());
    const staleRemoteSetTaskUnread = vi.fn(async () => taskMeta());
    const baseServices = servicesWithSetTaskUnread(baseSetTaskUnread);
    const staleRemoteServices = servicesWithSetTaskUnread(staleRemoteSetTaskUnread);
    useRemoteWorkspaceSessionStore.setState({ baseServices });
    useTaskQueryCacheStore.getState().upsertTaskMeta(taskMeta());
    tabStore.setState({
      activeTabId: "remote-a",
      tabs: [
        {
          id: "remote-a",
          kind: "workspace",
          label: "remote",
          workspacePath: "/home/dev",
          workspaceIdentity: "remote:ssh:dev:22:user:/home/dev",
          remoteSessionId: "remote-a",
        },
      ],
    });
    const activateTabByPath = vi.fn(() => {
      tabStore.setState({
        activeTabId: "local",
        tabs: [
          {
            id: "local",
            kind: "workspace",
            label: "local",
            workspacePath: localWorkspacePath,
          },
        ],
      });
      return true;
    });
    const hook = renderNavigation({
      ambientServices: staleRemoteServices,
      activateTabByPath,
    });

    await act(async () => {
      hook.result.current.handleSelectTask(localWorkspacePath, taskId);
      await Promise.resolve();
    });

    expect(baseSetTaskUnread).toHaveBeenCalledWith({
      taskId,
      workspacePath: localWorkspacePath,
      unread: false,
      expectedUnreadAt: 2,
    });
    expect(staleRemoteSetTaskUnread).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("任务行未读但 query cache 尚未水合时仍按点击版本清除未读", async () => {
    const baseSetTaskUnread = vi.fn(async () => ({
      ...taskMeta(),
      unreadAt: undefined,
    }));
    const baseServices = servicesWithSetTaskUnread(baseSetTaskUnread);
    useRemoteWorkspaceSessionStore.setState({ baseServices });
    tabStore.setState({ activeTabId: null, tabs: [] });
    const activateTabByPath = vi.fn(() => {
      tabStore.setState({
        activeTabId: "local",
        tabs: [
          {
            id: "local",
            kind: "workspace",
            label: "local",
            workspacePath: localWorkspacePath,
          },
        ],
      });
      return true;
    });
    const hook = renderNavigation({
      ambientServices: baseServices,
      activateTabByPath,
    });

    await act(async () => {
      hook.result.current.handleSelectTask(localWorkspacePath, taskId, undefined, 321);
      await Promise.resolve();
    });

    expect(useTaskQueryCacheStore.getState().taskMetaByEntityKey).toEqual({});
    expect(baseSetTaskUnread).toHaveBeenCalledWith({
      taskId,
      workspacePath: localWorkspacePath,
      unread: false,
      expectedUnreadAt: 321,
    });
    hook.unmount();
  });

  it("选择 remote task 时只使用目标 tab 的精确 remoteSessionId attachment", async () => {
    const targetWorkspacePath = "/home/shared";
    const targetWorkspaceIdentity = "remote:ssh:host-b:22:user:/home/shared";
    const targetSetTaskUnread = vi.fn(async () =>
      taskMeta({ workspacePath: targetWorkspacePath, workspaceIdentity: targetWorkspaceIdentity }),
    );
    const baseSetTaskUnread = vi.fn();
    const staleRemoteSetTaskUnread = vi.fn();
    const baseServices = servicesWithSetTaskUnread(baseSetTaskUnread);
    const targetServices = servicesWithSetTaskUnread(targetSetTaskUnread);
    const staleRemoteServices = servicesWithSetTaskUnread(staleRemoteSetTaskUnread);
    useRemoteWorkspaceSessionStore.setState({
      baseServices,
      sessionsById: {
        "remote-b": { sessionId: "remote-b", services: targetServices },
      },
    });
    useTaskQueryCacheStore.getState().upsertTaskMeta(
      taskMeta({
        workspacePath: targetWorkspacePath,
        workspaceIdentity: targetWorkspaceIdentity,
      }),
    );
    tabStore.setState({
      activeTabId: "remote-a",
      tabs: [
        {
          id: "remote-a",
          kind: "workspace",
          label: "remote-a",
          workspacePath: "/home/shared",
          workspaceIdentity: "remote:ssh:host-a:22:user:/home/shared",
          remoteSessionId: "remote-a",
        },
      ],
    });
    const activateTabByPath = vi.fn(() => {
      tabStore.setState({
        activeTabId: "remote-b",
        tabs: [
          {
            id: "remote-b",
            kind: "workspace",
            label: "remote-b",
            workspacePath: targetWorkspacePath,
            workspaceIdentity: targetWorkspaceIdentity,
            remoteSessionId: "remote-b",
          },
        ],
      });
      return true;
    });
    const hook = renderNavigation({
      ambientServices: staleRemoteServices,
      activateTabByPath,
      workspacePath: "/home/shared",
      workspaceIdentity: "remote:ssh:host-a:22:user:/home/shared",
    });

    await act(async () => {
      hook.result.current.handleSelectTask(targetWorkspacePath, taskId, targetWorkspaceIdentity);
      await Promise.resolve();
    });

    expect(targetSetTaskUnread).toHaveBeenCalledWith({
      taskId,
      workspacePath: targetWorkspacePath,
      workspaceIdentity: targetWorkspaceIdentity,
      unread: false,
      expectedUnreadAt: 2,
    });
    expect(baseSetTaskUnread).not.toHaveBeenCalled();
    expect(staleRemoteSetTaskUnread).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("目标 remote attachment 已断开时回滚未读且不回退到 base", async () => {
    const targetWorkspacePath = "/home/shared";
    const targetWorkspaceIdentity = "remote:ssh:host-b:22:user:/home/shared";
    const baseSetTaskUnread = vi.fn();
    const staleRemoteSetTaskUnread = vi.fn();
    const baseServices = servicesWithSetTaskUnread(baseSetTaskUnread);
    const staleRemoteServices = servicesWithSetTaskUnread(staleRemoteSetTaskUnread);
    useRemoteWorkspaceSessionStore.setState({ baseServices });
    const remoteTask = taskMeta({
      workspacePath: targetWorkspacePath,
      workspaceIdentity: targetWorkspaceIdentity,
    });
    useTaskQueryCacheStore.getState().upsertTaskMeta(remoteTask);
    tabStore.setState({ activeTabId: null, tabs: [] });
    const activateTabByPath = vi.fn(() => {
      tabStore.setState({
        activeTabId: "remote-b",
        tabs: [
          {
            id: "remote-b",
            kind: "workspace",
            label: "remote-b",
            workspacePath: targetWorkspacePath,
            workspaceIdentity: targetWorkspaceIdentity,
            remoteSessionId: "remote-b-disconnected",
          },
        ],
      });
      return true;
    });
    const hook = renderNavigation({
      ambientServices: staleRemoteServices,
      activateTabByPath,
      workspacePath: "/home/shared",
      workspaceIdentity: "remote:ssh:host-a:22:user:/home/shared",
    });

    act(() => {
      hook.result.current.handleSelectTask(targetWorkspacePath, taskId, targetWorkspaceIdentity);
    });

    expect(baseSetTaskUnread).not.toHaveBeenCalled();
    expect(staleRemoteSetTaskUnread).not.toHaveBeenCalled();
    expect(
      useTaskQueryCacheStore.getState().taskMetaByEntityKey[buildTaskEntityKey(remoteTask)]
        ?.unreadAt,
    ).toBe(2);
    hook.unmount();
  });

  it("ISSUE-033: 前进遇到项目树确认删除的 task 时清除它，并按访问顺序到达下一条有效条目", () => {
    useZCodeSessionStore
      .getState()
      .setTaskNavDeletedTasks([{ taskId: "task-missing", workspacePath: localWorkspacePath }]);
    useZCodeSessionStore.setState({
      taskNavHistory: {
        entries: [
          { kind: "plugin-store", workspacePath: "/home/dev" },
          { kind: "task", workspacePath: localWorkspacePath, taskId: "task-missing" },
          { kind: "task", workspacePath: localWorkspacePath, taskId: "task-b" },
          { kind: "task", workspacePath: localWorkspacePath, taskId: "task-c" },
        ],
        cursor: 0,
      },
    });
    const hook = renderNavigation({
      ambientServices: servicesWithSetTaskUnread(vi.fn()),
      activateTabByPath: vi.fn(() => true),
    });

    act(() => {
      hook.result.current.handleTaskNavForward();
    });

    const history = useZCodeSessionStore.getState().taskNavHistory;
    expect(
      history.entries.map((entry) => (entry.kind === "task" ? entry.taskId : entry.kind)),
    ).toEqual(["plugin-store", "task-b", "task-c"]);
    expect(history.entries[history.cursor]).toMatchObject({ kind: "task", taskId: "task-b" });
    hook.unmount();
  });

  // Reproduces the live trace: projects-view tasks are live in the sidebar tree but absent from
  // visibleTasks and taskMetaByEntityKey. Back must still visit each entry in order.
  it("ISSUE-033: 项目视图中存活但不在缓存里的 task 后退时按顺序回放且不被清除", () => {
    const pluginStore = { kind: "plugin-store" as const, workspacePath: "/home/dev" };
    const taskA = { kind: "task" as const, workspacePath: "/draft/aa49", taskId: "task-A" };
    const taskB = { kind: "task" as const, workspacePath: "/work/qa-sandbox", taskId: "task-B" };
    const taskC = { kind: "task" as const, workspacePath: "/draft/aa49", taskId: "task-C" };
    useZCodeSessionStore.getState().setTaskNavDeletedTasks([]);
    useZCodeSessionStore.setState({
      taskNavHistory: { entries: [pluginStore, taskA, taskB, taskC], cursor: 3 },
    });
    const hook = renderNavigation({
      ambientServices: servicesWithSetTaskUnread(vi.fn()),
      activateTabByPath: vi.fn(() => true),
    });
    const cursors: number[] = [];
    for (let step = 0; step < 3; step++) {
      act(() => {
        hook.result.current.handleTaskNavBack();
      });
      cursors.push(useZCodeSessionStore.getState().taskNavHistory.cursor);
    }

    const history = useZCodeSessionStore.getState().taskNavHistory;
    expect(cursors).toEqual([2, 1, 0]);
    expect(history.entries).toHaveLength(4);
    expect(history.entries[history.cursor]).toMatchObject(pluginStore);
    hook.unmount();
  });

  it("ISSUE-033: 项目树确认删除的 task 在后退时只清除该条目，其余按顺序回放", () => {
    useZCodeSessionStore
      .getState()
      .setTaskNavDeletedTasks([{ taskId: "task-A", workspacePath: "/draft/aa49" }]);
    useZCodeSessionStore.setState({
      taskNavHistory: {
        entries: [
          { kind: "plugin-store", workspacePath: "/home/dev" },
          { kind: "task", workspacePath: "/draft/aa49", taskId: "task-A" },
          { kind: "task", workspacePath: "/work/qa-sandbox", taskId: "task-B" },
          { kind: "task", workspacePath: "/draft/aa49", taskId: "task-C" },
        ],
        cursor: 3,
      },
    });
    const hook = renderNavigation({
      ambientServices: servicesWithSetTaskUnread(vi.fn()),
      activateTabByPath: vi.fn(() => true),
    });

    act(() => {
      hook.result.current.handleTaskNavBack();
    });
    const afterFirst = useZCodeSessionStore.getState().taskNavHistory;
    expect(afterFirst.entries[afterFirst.cursor]).toMatchObject({ taskId: "task-B" });

    act(() => {
      hook.result.current.handleTaskNavBack();
    });
    const afterSecond = useZCodeSessionStore.getState().taskNavHistory;
    expect(
      afterSecond.entries.map((entry) => (entry.kind === "task" ? entry.taskId : entry.kind)),
    ).toEqual(["plugin-store", "task-B", "task-C"]);
    expect(afterSecond.entries[afterSecond.cursor]).toMatchObject({ kind: "plugin-store" });
    hook.unmount();
  });
});

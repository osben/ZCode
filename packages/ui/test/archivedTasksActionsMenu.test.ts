// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeleteAllArchivedTasksButton } from "@/DeleteAllArchivedTasksButton.js";
import { WebRemoteControlTaskIndex } from "@/WebRemoteControlTaskIndex.js";
import { ServiceProvider } from "@/hooks/useServices.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatPlural: ({ id }: { id: string }, count: number) => `${id}:${count}`,
      formatMessage: ({ id }: { id: string }, values?: { count?: number }) =>
        values?.count == null ? id : `${id}:${values.count}`,
    },
  }),
}));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children, title }: { children: ReactNode; title: string }) =>
    createElement("span", { title }, children),
}));
vi.mock("@/logger.js", () => ({ logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function mount(count = 2) {
  const toolbar = document.createElement("div");
  document.body.append(toolbar);
  const eraseResult = (taskIds: string[]) => ({
    erasedTaskIds: taskIds,
    skippedTaskIds: [],
    blockedRunningTaskIds: [],
    failedTaskIds: [],
    fileFailureCount: 0,
    filesRetainedCount: 0,
    worktreeCleanup: {
      removed: [],
      retained: [],
      failed: [],
      removedCount: 0,
      retainedCount: 0,
      failedCount: 0,
    },
  });
  const service = {
    getDeletionCapability: vi.fn(async () => ({ supported: true })),
    countTaskTrees: vi.fn(async ({ taskIds }: { taskIds: string[] }) => ({
      total: taskIds.length,
      sideChats: 0,
      subagents: 0,
      workflowSessions: 0,
      workflowRuns: 0,
      running: 0,
    })),
    eraseTasks: vi.fn(async ({ taskIds }: { taskIds: string[] }) => eraseResult(taskIds)),
    listArchivedTasks: vi.fn(async () => [{ taskId: "one" }, { taskId: "two" }] as never),
    deleteArchivedTasks: vi.fn(async ({ taskIds }: { taskIds: string[] }) => ({
      deletedTaskIds: taskIds,
      skippedTaskIds: [],
      failedTaskIds: [],
    })),
  };
  const onDeleted = vi.fn();
  const view = render(
    createElement(DeleteAllArchivedTasksButton, {
      count,
      disabled: count === 0,
      actionsContainer: toolbar,
      workspaces: [
        {
          workspacePath: "/project",
          label: "Project",
          service,
          gitService: { getChanges: vi.fn(async () => []) },
        },
      ],
      onDeleted,
    }),
  );
  return { toolbar, service, onDeleted, eraseResult, ...view };
}

async function openMenu(toolbar: HTMLElement) {
  fireEvent.keyDown(within(toolbar).getByRole("button", { name: "taskList.archivedActions" }), {
    key: "ArrowDown",
  });
  return screen.findByRole("menuitem", { name: "taskList.deleteAllArchivedMenu" });
}

describe("归档更多菜单", () => {
  it("入口位于工具栏，打开菜单只展示数量，不读取或删除任务", async () => {
    const { toolbar, container, service } = mount();
    expect(container.querySelector("button")).toBeNull();
    expect(screen.queryByRole("menuitem")).toBeNull();
    await openMenu(toolbar);
    expect(screen.getByText("taskList.archivedTaskCount:2")).toBeTruthy();
    expect(service.listArchivedTasks).not.toHaveBeenCalled();
    expect(service.deleteArchivedTasks).not.toHaveBeenCalled();
  });

  it("取消不写入；确认期间禁用入口，菜单关闭后仍展示永久删除结果", async () => {
    const { toolbar, container, service, onDeleted, eraseResult } = mount();
    fireEvent.click(await openMenu(toolbar));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "taskDelete.title:2" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "common.cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(service.deleteArchivedTasks).not.toHaveBeenCalled();
    expect(service.eraseTasks).not.toHaveBeenCalled();

    let resolveErase!: (value: ReturnType<typeof eraseResult>) => void;
    service.eraseTasks.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveErase = resolve;
        }),
    );
    fireEvent.click(await openMenu(toolbar));
    const confirmButton = await screen.findByRole("button", { name: "taskDelete.confirm:2" });
    await waitFor(() => expect(confirmButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(confirmButton);
    await waitFor(() => expect(service.eraseTasks).toHaveBeenCalledTimes(1));
    expect(toolbar.querySelector("button")?.disabled).toBe(true);
    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    resolveErase(eraseResult(["one", "two"]));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(2));
    expect(service.deleteArchivedTasks).toHaveBeenCalledExactlyOnceWith({
      workspacePath: "/project",
      taskIds: ["one", "two"],
    });
    expect(service.eraseTasks).toHaveBeenCalledExactlyOnceWith({
      workspacePath: "/project",
      taskIds: ["one", "two"],
    });
    await waitFor(() =>
      expect(within(container).getByRole("status").textContent).toBe("taskDelete.result"),
    );
    expect(within(toolbar).queryByRole("status")).toBeNull();
  });

  it("空态禁用工具栏入口", () => {
    const { toolbar, service } = mount(0);
    expect(within(toolbar).getByRole("button").hasAttribute("disabled")).toBe(true);
    expect(service.listArchivedTasks).not.toHaveBeenCalled();
  });

  it("Web 远程索引禁止批量永久删除，即使基础服务支持本地删除", async () => {
    const toolbar = document.createElement("div");
    document.body.append(toolbar);
    const task = {
      taskId: "web-archived",
      title: "Web archived task",
      workspacePath: "/project",
      workspaceLabel: "Project",
      workspaceKind: "local" as const,
      createdAt: 1,
      updatedAt: 1,
      archived: true,
    };
    const result = {
      workspaces: [{ workspacePath: "/project", label: "Project", kind: "local" as const }],
      tasks: [task],
    };
    const service = {
      getDeletionCapability: vi.fn(async () => ({ supported: true })),
      eraseTasks: vi.fn(),
      listArchivedTasks: vi.fn(async () => [task]),
      deleteArchivedTasks: vi.fn(async ({ taskIds }: { taskIds: string[] }) => ({
        deletedTaskIds: taskIds,
        skippedTaskIds: [],
        failedTaskIds: [],
      })),
    };

    await act(async () => {
      render(
        createElement(
          ServiceProvider,
          {
            services: {
              zcodeTaskService: service,
              gitService: { getChanges: vi.fn(async () => []) },
            } as never,
          },
          createElement(WebRemoteControlTaskIndex, {
            activeWorkspacePath: "/project",
            activeTaskId: null,
            taskViewMode: "archived",
            initialResult: result,
            archivedActionsContainer: toolbar,
            onSelectTask: vi.fn(),
            switcher: {
              listWorkspaces: vi.fn(async () => result),
              switchWorkspace: vi.fn(async () => {}),
            },
          }),
        ),
      );
    });
    const action = within(toolbar).getByRole("button", { name: "taskList.archivedActions" });
    expect(action.hasAttribute("disabled")).toBe(true);
    expect(within(toolbar).getByTitle("taskDelete.unsupported")).toBeTruthy();
    fireEvent.keyDown(action, { key: "ArrowDown" });
    fireEvent.click(action);
    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Web archived task")).toBeTruthy();
    expect(service.listArchivedTasks).not.toHaveBeenCalled();
    expect(service.deleteArchivedTasks).not.toHaveBeenCalled();
    expect(service.getDeletionCapability).not.toHaveBeenCalled();
    expect(service.eraseTasks).not.toHaveBeenCalled();
  });
});

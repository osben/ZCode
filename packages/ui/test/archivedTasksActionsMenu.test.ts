// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TID_TASK_DELETE_CONFIRM, TID_TASK_DELETE_DIALOG } from "@zcode/shared";
import { ArchiveManagement } from "@/project-sidebar/ArchiveManagement.js";
import type { ProjectTask, ProjectTree } from "@/project-sidebar/contract.js";

const mocks = vi.hoisted(() => ({
  directory: {} as Record<string, unknown>,
  services: {} as Record<string, unknown>,
  removeTaskState: vi.fn(),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en-US",
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
vi.mock("@/project-sidebar/ProjectDirectoryProvider.js", () => ({
  ProjectDirectoryProvider: ({ children }: { children: ReactNode }) => children,
  useProjectDirectory: () => mocks.directory,
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => mocks.services,
}));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: (select: (state: unknown) => unknown) =>
    select({ removeTaskState: mocks.removeTaskState }),
}));
vi.mock("@/lib/taskListMetaSync.js", () => ({ removeTaskFromTaskCaches: vi.fn() }));
vi.mock("@/logger.js", () => ({ logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

const LOCAL_PROJECT = {
  id: "one",
  hostId: "local",
  name: "Project",
  roots: [{ rootPath: "/project", isPrimary: true, position: 0 }],
  deleted: false,
  pinned: false,
  position: 0,
  nameOverridden: true,
  createdAt: 1,
  updatedAt: 1,
};

function archivedTask(id: string, extra: Partial<ProjectTask> = {}): ProjectTask {
  return {
    taskId: id,
    title: id,
    traceId: id,
    workspacePath: "/project",
    hostId: "local",
    projectId: "one",
    pinned: false,
    archived: true,
    createdAt: 1,
    updatedAt: 2,
    mode: "default",
    ...extra,
  } as ProjectTask;
}

function eraseResult(taskIds: string[]) {
  return {
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
  };
}

function createServices(overrides: { supported?: boolean; skippedTaskIds?: string[] } = {}) {
  const zcodeTaskService = {
    getDeletionCapability: vi.fn(async () => ({ supported: overrides.supported ?? true })),
    countTaskTrees: vi.fn(async ({ taskIds }: { taskIds: string[] }) => ({
      total: taskIds.length,
      sideChats: 0,
      subagents: 0,
      workflowSessions: 0,
      workflowRuns: 0,
      running: 0,
    })),
    deleteArchivedTasks: vi.fn(async ({ taskIds }: { taskIds: string[] }) => ({
      deletedTaskIds: taskIds.filter((id) => !overrides.skippedTaskIds?.includes(id)),
      skippedTaskIds: overrides.skippedTaskIds ?? [],
      failedTaskIds: [],
    })),
    eraseTasks: vi.fn(async ({ taskIds }: { taskIds: string[] }) => eraseResult(taskIds)),
  };
  return {
    zcodeTaskService,
    gitService: { getChanges: vi.fn(async () => []) },
    windowControllerService: undefined,
  };
}

function mount(
  tasks: ProjectTask[],
  options: {
    allowPermanentDelete?: boolean;
    services?: ReturnType<typeof createServices>;
    refresh?: () => Promise<void>;
  } = {},
) {
  const services = options.services ?? createServices();
  mocks.services = services;
  mocks.directory = {
    tree: {
      projects: [LOCAL_PROJECT],
      tasks,
    } as unknown as ProjectTree,
    directory: { hosts: [], entries: [] },
    availability: new Map(),
    refresh: vi.fn(options.refresh ?? (async () => {})),
    error: null,
    loading: false,
  };
  const view = render(
    createElement(ArchiveManagement, {
      allowPermanentDelete: options.allowPermanentDelete ?? true,
    }),
  );
  return { ...view, services };
}

function deleteAllButton() {
  return screen.getByTestId("archive-delete-all") as HTMLButtonElement;
}

function openDeleteAll() {
  fireEvent.click(deleteAllButton());
  return screen.findByTestId(TID_TASK_DELETE_DIALOG);
}

describe("Settings archives permanent delete", () => {
  it("disables the bulk entry when there are no archived rows", () => {
    mount([]);
    expect(deleteAllButton().disabled).toBe(true);
    expect(screen.queryByTestId(TID_TASK_DELETE_DIALOG)).toBeNull();
  });

  it("cancel writes nothing and re-enables the entry", async () => {
    const { services } = mount([archivedTask("one"), archivedTask("two")]);
    const dialog = await openDeleteAll();
    expect(within(dialog).getByRole("heading", { name: "taskDelete.title:2" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "common.cancel" }));
    expect(screen.queryByTestId(TID_TASK_DELETE_DIALOG)).toBeNull();
    expect(deleteAllButton().disabled).toBe(false);
    expect(services.zcodeTaskService.deleteArchivedTasks).not.toHaveBeenCalled();
    expect(services.zcodeTaskService.eraseTasks).not.toHaveBeenCalled();
    expect(mocks.removeTaskState).not.toHaveBeenCalled();
  });

  it("entry stays disabled while erase runs; result stays after the menu closes", async () => {
    const { services } = mount([archivedTask("one"), archivedTask("two")]);
    let resolveErase!: (value: ReturnType<typeof eraseResult>) => void;
    services.zcodeTaskService.eraseTasks.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveErase = resolve;
        }),
    );
    const dialog = await openDeleteAll();
    const confirm = within(dialog).getByTestId(TID_TASK_DELETE_CONFIRM) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() => expect(services.zcodeTaskService.eraseTasks).toHaveBeenCalledTimes(1));
    expect(deleteAllButton().disabled).toBe(true);
    expect(screen.queryByTestId(TID_TASK_DELETE_DIALOG)).toBeNull();
    resolveErase(eraseResult(["one", "two"]));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("taskDelete.result"));
    expect(deleteAllButton().disabled).toBe(false);
    expect(services.zcodeTaskService.deleteArchivedTasks).toHaveBeenCalledExactlyOnceWith({
      workspacePath: "/project",
      taskIds: ["one", "two"],
    });
    expect(services.zcodeTaskService.eraseTasks).toHaveBeenCalledExactlyOnceWith({
      workspacePath: "/project",
      taskIds: ["one", "two"],
    });
    // Event order: tombstone, UI removal per tombstoned row, then erase of the same IDs.
    const tombstone = services.zcodeTaskService.deleteArchivedTasks.mock.invocationCallOrder[0]!;
    const erase = services.zcodeTaskService.eraseTasks.mock.invocationCallOrder[0]!;
    expect(mocks.removeTaskState.mock.invocationCallOrder[0]!).toBeGreaterThan(tombstone);
    expect(mocks.removeTaskState.mock.invocationCallOrder[1]!).toBeLessThan(erase);
    expect(mocks.removeTaskState).toHaveBeenCalledTimes(2);
  });

  it("search and project filters limit the confirmed rows", async () => {
    const { services } = mount([archivedTask("alpha"), archivedTask("beta")]);
    fireEvent.change(screen.getByLabelText("archives.search"), { target: { value: "alpha" } });
    const dialog = await openDeleteAll();
    expect(within(dialog).getByRole("heading", { name: "taskDelete.title:1" })).toBeTruthy();
    fireEvent.click(await within(dialog).findByTestId(TID_TASK_DELETE_CONFIRM));
    await waitFor(() =>
      expect(services.zcodeTaskService.eraseTasks).toHaveBeenCalledExactlyOnceWith({
        workspacePath: "/project",
        taskIds: ["alpha"],
      }),
    );
    expect(services.zcodeTaskService.deleteArchivedTasks).toHaveBeenCalledWith({
      workspacePath: "/project",
      taskIds: ["alpha"],
    });
  });

  it("remote rows are excluded from the batch and named in the notice", async () => {
    const { services } = mount([
      archivedTask("local-one"),
      archivedTask("remote-two", {
        hostId: "remote:server:r",
        projectId: null,
        workspaceIdentity: "remote:server:r:/project",
      }),
    ]);
    const dialog = await openDeleteAll();
    expect(within(dialog).getByRole("heading", { name: "taskDelete.title:1" })).toBeTruthy();
    expect(within(dialog).getByText("taskList.deleteAllArchivedUnavailable")).toBeTruthy();
    fireEvent.click(await within(dialog).findByTestId(TID_TASK_DELETE_CONFIRM));
    await waitFor(() =>
      expect(services.zcodeTaskService.eraseTasks).toHaveBeenCalledExactlyOnceWith({
        workspacePath: "/project",
        taskIds: ["local-one"],
      }),
    );
    expect(services.zcodeTaskService.deleteArchivedTasks).toHaveBeenCalledExactlyOnceWith({
      workspacePath: "/project",
      taskIds: ["local-one"],
    });
  });

  it("web remote disables every permanent delete entry without consulting capability", async () => {
    const { services, container } = mount([archivedTask("one"), archivedTask("two")], {
      allowPermanentDelete: false,
    });
    expect(deleteAllButton().disabled).toBe(true);
    expect(within(container).getByTitle("taskDelete.remoteUnavailable")).toBeTruthy();
    fireEvent.click(deleteAllButton());
    expect(screen.queryByTestId(TID_TASK_DELETE_DIALOG)).toBeNull();

    fireEvent.keyDown(screen.getByTestId("archive-group-menu"), { key: "ArrowDown" });
    const groupDelete = await screen.findByTestId("archive-group-delete");
    expect(groupDelete.getAttribute("data-disabled")).not.toBeNull();
    expect(services.zcodeTaskService.getDeletionCapability).not.toHaveBeenCalled();
    expect(services.zcodeTaskService.deleteArchivedTasks).not.toHaveBeenCalled();
    expect(services.zcodeTaskService.eraseTasks).not.toHaveBeenCalled();
  });

  it("unsupported capability keeps confirm disabled and writes nothing", async () => {
    const { services } = mount([archivedTask("one")], {
      services: createServices({ supported: false }),
    });
    const dialog = await openDeleteAll();
    const confirm = within(dialog).getByTestId(TID_TASK_DELETE_CONFIRM) as HTMLButtonElement;
    await waitFor(() => expect(within(dialog).getByText("taskDelete.unsupported")).toBeTruthy());
    expect(confirm.disabled).toBe(true);
    expect(services.zcodeTaskService.deleteArchivedTasks).not.toHaveBeenCalled();
    expect(services.zcodeTaskService.eraseTasks).not.toHaveBeenCalled();
  });

  it("rows restored elsewhere before confirm are skipped and never erased", async () => {
    const { services } = mount([archivedTask("one"), archivedTask("two")], {
      services: createServices({ skippedTaskIds: ["two"] }),
    });
    const dialog = await openDeleteAll();
    fireEvent.click(await within(dialog).findByTestId(TID_TASK_DELETE_CONFIRM));
    await waitFor(() =>
      expect(services.zcodeTaskService.eraseTasks).toHaveBeenCalledExactlyOnceWith({
        workspacePath: "/project",
        taskIds: ["one"],
      }),
    );
    expect(mocks.removeTaskState).toHaveBeenCalledTimes(1);
    expect(mocks.removeTaskState.mock.calls[0]?.[1]).toBe("one");
  });

  it("a rejected refresh after erase keeps the erase summary and is not reported as a deletion failure", async () => {
    const { services } = mount([archivedTask("one")], {
      refresh: async () => {
        throw new Error("refresh failed");
      },
    });
    const dialog = await openDeleteAll();
    fireEvent.click(await within(dialog).findByTestId(TID_TASK_DELETE_CONFIRM));
    await waitFor(() => expect(services.zcodeTaskService.eraseTasks).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("taskDelete.result"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(deleteAllButton().disabled).toBe(false);
  });

  it("a failed erase is announced as an alert, not a status", async () => {
    const { services } = mount([archivedTask("one"), archivedTask("two")]);
    services.zcodeTaskService.eraseTasks.mockImplementationOnce(async ({ taskIds }) => ({
      ...eraseResult(taskIds),
      erasedTaskIds: ["one"],
      failedTaskIds: ["two"],
    }));
    const dialog = await openDeleteAll();
    fireEvent.click(await within(dialog).findByTestId(TID_TASK_DELETE_CONFIRM));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("taskDelete.result"));
    expect(screen.queryByRole("status")).toBeNull();
  });
});

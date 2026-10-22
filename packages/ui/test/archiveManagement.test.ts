// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement, Fragment } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { TID_TASK_DELETE_CONFIRM } from "@zcode/shared";
import type { ProjectTask, ProjectTree } from "@/project-sidebar/contract.js";
import { buildArchiveGroups, archiveTaskKey } from "@/project-sidebar/archive-view.js";
import { mutateProjectTask } from "@/project-sidebar/task-mutation.js";
import { useArchiveManagement } from "@/project-sidebar/useArchiveManagement.js";

const mocks = vi.hoisted(() => ({
  directory: {} as any,
  mutateTask: vi.fn(),
  service: {} as any,
  removeTaskState: vi.fn(),
  // Stable identity: a new git service per render would change the preview loader identity.
  gitService: { getChanges: vi.fn(async (): Promise<unknown[]> => []) },
  locale: "en-US",
}));
vi.mock("@/project-sidebar/ProjectDirectoryProvider.js", () => ({
  useProjectDirectory: () => mocks.directory,
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({
    windowControllerService: mocks,
    zcodeTaskService: mocks.service,
    gitService: mocks.gitService,
  }),
}));
vi.mock("@/lib/taskListMetaSync.js", () => ({ removeTaskFromTaskCaches: vi.fn() }));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: (select: any) => select(mocks),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: mocks.locale,
    intl: {
      formatPlural: ({ id }: any, count: number) => `${id}:${count}`,
      formatMessage: ({ id }: any, values: any) => `${id}:${JSON.stringify(values)}`,
    },
  }),
}));
const task = (id: string, extra: Partial<ProjectTask> = {}): ProjectTask => ({
  taskId: id,
  title: id,
  traceId: id,
  workspacePath: "/same",
  hostId: "local",
  projectId: "one",
  pinned: false,
  archived: true,
  createdAt: 1,
  updatedAt: 2,
  mode: "default",
  ...extra,
});
const project = (id: string, extra = {}) => ({
  id,
  hostId: "local",
  name: `Virtual ${id}`,
  roots: [{ rootPath: "/same", isPrimary: true, position: 0 }],
  deleted: false,
  pinned: false,
  position: 0,
  nameOverridden: true,
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});
const tree = (): ProjectTree => ({
  projects: [
    project("one"),
    project("two"),
    project("one", { hostId: "remote:server:r", name: "Remote virtual" }),
    project("deleted", { deleted: true }),
  ],
  tasks: [
    task("alpha"),
    task("beta", { projectId: "two", cronAutomationId: "cron" }),
    task("alpha", { hostId: "remote:server:r", workspaceIdentity: "remote:server:r:/same" }),
    task("orphan", { projectId: null }),
    task("old", { projectId: "deleted" }),
    task("active", { archived: false }),
  ],
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("groups by virtual identity rather than shared roots and preserves removed/unclassified archives", () => {
  const groups = buildArchiveGroups(tree());
  expect(groups.map((g) => g.tasks.length)).toEqual([1, 1, 1, 1, 1]);
  expect(new Set(groups.map((g) => g.key)).size).toBe(5);
  expect(groups.find((g) => g.project?.id === "deleted")?.project?.deleted).toBe(true);
  expect(groups.find((g) => g.project === undefined)?.tasks[0]?.taskId).toBe("orphan");
  expect(archiveTaskKey(tree().tasks[0]!)).not.toBe(archiveTaskKey(tree().tasks[2]!));
});
it("intersects title/project and switches between CLI updated and created time", () => {
  const t = tree();
  t.tasks.push(task("alpha-second", { createdAt: 9, updatedAt: 1 }));
  const before = JSON.stringify(t);
  const key = buildArchiveGroups(t).find(
    (g) => g.project?.id === "one" && g.hostId === "local",
  )!.key;
  expect(
    buildArchiveGroups(t, { query: "ALPHA", sort: "updated", project: key })[0]?.tasks.map(
      (t) => t.taskId,
    ),
  ).toEqual(["alpha", "alpha-second"]);
  expect(
    buildArchiveGroups(t, { query: "ALPHA", sort: "created", project: key })[0]?.tasks.map(
      (t) => t.taskId,
    ),
  ).toEqual(["alpha-second", "alpha"]);
  expect(JSON.stringify(t)).toBe(before);
});
it("routes archived actions with full remote identity and uses the existing local service fallback", async () => {
  const row = task("same", {
    workspaceIdentity: "remote:server:r:/same",
    hostId: "remote:server:r",
  });
  await mutateProjectTask(
    { controller: mocks, service: {} as never },
    row,
    { kind: "delete" },
    "attachment",
  );
  expect(mocks.mutateTask).toHaveBeenCalledWith({
    address: {
      taskId: "same",
      workspacePath: "/same",
      workspaceIdentity: "remote:server:r:/same",
      remoteSessionId: "attachment",
      sourceServerId: "r",
    },
    mutation: { kind: "delete" },
  });
  const service = { unarchiveTask: vi.fn(async () => row) };
  await mutateProjectTask({ service: service as never }, task("local"), {
    kind: "archive",
    archived: false,
  });
  expect(service.unarchiveTask).toHaveBeenCalledWith({
    workspacePath: "/same",
    workspaceIdentity: undefined,
    taskId: "local",
  });
});
function prepare(options: { tree?: ProjectTree } = {}) {
  mocks.directory = {
    tree: options.tree ?? tree(),
    directory: { hosts: [], entries: [] },
    availability: new Map(),
    refresh: vi.fn(async () => {}),
    error: null,
    loading: false,
  };
  mocks.mutateTask.mockResolvedValue(null);
  mocks.gitService.getChanges.mockReset().mockResolvedValue([]);
  mocks.locale = "en-US";
  mocks.service = {
    getDeletionCapability: vi.fn(async () => ({ supported: true })),
    countTaskTrees: vi.fn(async ({ taskIds }: { taskIds: string[] }) => ({
      total: taskIds.length,
      sideChats: 0,
      subagents: 0,
      workflowSessions: 0,
      workflowRuns: 0,
      running: 0,
    })),
    deleteArchivedTasks: vi.fn(async ({ taskIds }: { taskIds: string[] }) => ({
      deletedTaskIds: taskIds,
      skippedTaskIds: [],
      failedTaskIds: [],
    })),
    eraseTasks: vi.fn(async ({ taskIds }: { taskIds: string[] }) => ({
      erasedTaskIds: taskIds,
      skippedTaskIds: [],
      blockedRunningTaskIds: [],
      failedTaskIds: [],
      fileFailureCount: 0,
      filesRetainedCount: 0,
      worktreeCleanup: { removed: [], retained: [], failed: [] },
    })),
  };
}
function setup(options: { allowPermanentDelete?: boolean; tree?: ProjectTree } = {}) {
  prepare(options);
  return renderHook(() =>
    useArchiveManagement({ allowPermanentDelete: options.allowPermanentDelete ?? true }),
  );
}
/** Mounts the dialog the hook hands to the page, so tests drive the real confirmation controls. */
function renderDeletionDialog(result: { current: { deletionDialog: unknown } }) {
  return render(createElement(Fragment, null, result.current.deletionDialog as never));
}
async function confirmOpenDialog() {
  const confirm = (await screen.findByTestId(TID_TASK_DELETE_CONFIRM)) as HTMLButtonElement;
  await waitFor(() => expect(confirm.disabled).toBe(false));
  fireEvent.click(confirm);
}
it("opening the permanent delete dialog writes nothing; cancel releases the page without mutation", async () => {
  const { result } = setup();
  act(() => {
    void result.current.run([tree().tasks[0]!], "delete");
  });
  expect(result.current.pending).toBe(true);
  expect(mocks.service.deleteArchivedTasks).not.toHaveBeenCalled();
  act(() => {
    result.current.cancelDelete();
  });
  expect(result.current.pending).toBe(false);
  expect(mocks.mutateTask).not.toHaveBeenCalled();
  expect(mocks.service.deleteArchivedTasks).not.toHaveBeenCalled();
  expect(mocks.service.eraseTasks).not.toHaveBeenCalled();
  expect(result.current.busy).toBe(false);
});
it("does not open the permanent delete dialog for remote-only selections and reports why", async () => {
  const { result } = setup();
  const remoteOnly = tree().tasks[2]!;
  await act(async () => {
    await result.current.run([remoteOnly], "delete");
  });
  expect(result.current.pending).toBe(false);
  expect(result.current.deletionResult).toContain("taskList.deleteAllArchivedUnavailable");
  expect(mocks.service.deleteArchivedTasks).not.toHaveBeenCalled();
});
it("the Web remote gate blocks the permanent delete owner before any capability lookup", async () => {
  const { result } = setup({ allowPermanentDelete: false });
  await act(async () => {
    await result.current.run([tree().tasks[0]!], "delete");
  });
  expect(result.current.pending).toBe(false);
  expect(mocks.service.getDeletionCapability).not.toHaveBeenCalled();
  expect(mocks.service.deleteArchivedTasks).not.toHaveBeenCalled();
});
it("one in-flight unarchive batch rejects duplicate clicks and preserves failures", async () => {
  const { result } = setup();
  let release!: () => void;
  mocks.mutateTask
    .mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    )
    .mockRejectedValueOnce(new Error("offline"));
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.run(tree().tasks.slice(0, 2), "unarchive");
  });
  await act(async () => {
    await result.current.run([tree().tasks[0]!], "unarchive");
  });
  expect(mocks.mutateTask).toHaveBeenCalledTimes(1);
  await act(async () => {
    release();
    await pending;
  });
  expect(mocks.mutateTask).toHaveBeenCalledTimes(2);
  expect(result.current.result).toEqual({ succeeded: 1, failed: 1, skipped: 0 });
  expect(mocks.directory.refresh).toHaveBeenCalledOnce();
  expect(result.current.busy).toBe(false);
});
it("defaults to fail-closed: without an explicit opt-in no permanent delete dialog opens", async () => {
  prepare();
  const { result } = renderHook(() => useArchiveManagement());
  await act(async () => {
    await result.current.run([tree().tasks[0]!], "delete");
  });
  expect(result.current.pending).toBe(false);
  expect(mocks.service.getDeletionCapability).not.toHaveBeenCalled();
  expect(mocks.service.deleteArchivedTasks).not.toHaveBeenCalled();
});
it("rows archived after the dialog opens are not added to the confirmed batch", async () => {
  const { result, rerender } = setup();
  act(() => {
    void result.current.run([tree().tasks[0]!], "delete");
  });
  expect(result.current.pending).toBe(true);
  mocks.directory = {
    ...mocks.directory,
    tree: { ...tree(), tasks: [...tree().tasks, task("fresh")] },
  };
  rerender();
  renderDeletionDialog(result);
  await confirmOpenDialog();
  await waitFor(() => expect(mocks.service.eraseTasks).toHaveBeenCalledTimes(1));
  expect(mocks.service.deleteArchivedTasks).toHaveBeenCalledExactlyOnceWith({
    workspacePath: "/same",
    taskIds: ["alpha"],
  });
  expect(mocks.service.eraseTasks).toHaveBeenCalledExactlyOnceWith({
    workspacePath: "/same",
    taskIds: ["alpha"],
  });
});
it("a pinned archived row is excluded from a batch unless the user opts in", async () => {
  const pinned = task("pinned-one", { pinned: true });
  const plain = task("plain-two");
  const { result } = setup({ tree: { ...tree(), tasks: [pinned, plain] } });
  act(() => {
    void result.current.run([pinned, plain], "delete");
  });
  renderDeletionDialog(result);
  const checkbox = await screen.findByRole("checkbox", { name: "taskDelete.includePinned:1" });
  expect(checkbox.getAttribute("aria-checked")).toBe("false");
  await confirmOpenDialog();
  await waitFor(() => expect(mocks.service.eraseTasks).toHaveBeenCalledTimes(1));
  expect(mocks.service.deleteArchivedTasks).toHaveBeenCalledExactlyOnceWith({
    workspacePath: "/same",
    taskIds: ["plain-two"],
  });
  expect(mocks.service.eraseTasks).toHaveBeenCalledExactlyOnceWith({
    workspacePath: "/same",
    taskIds: ["plain-two"],
  });
});
it("a pinned archived row is erased only after the user opts in", async () => {
  const pinned = task("pinned-one", { pinned: true });
  const plain = task("plain-two");
  const { result } = setup({ tree: { ...tree(), tasks: [pinned, plain] } });
  act(() => {
    void result.current.run([pinned, plain], "delete");
  });
  renderDeletionDialog(result);
  const checkbox = await screen.findByRole("checkbox", { name: "taskDelete.includePinned:1" });
  fireEvent.click(checkbox);
  await waitFor(() => expect(checkbox.getAttribute("aria-checked")).toBe("true"));
  await confirmOpenDialog();
  await waitFor(() => expect(mocks.service.eraseTasks).toHaveBeenCalledTimes(1));
  expect(mocks.service.deleteArchivedTasks).toHaveBeenCalledExactlyOnceWith({
    workspacePath: "/same",
    taskIds: ["pinned-one", "plain-two"],
  });
});
it("a lone pinned archived row is not erased until the user opts in", async () => {
  const pinned = task("pinned-only", { pinned: true });
  const { result } = setup({ tree: { ...tree(), tasks: [pinned] } });
  act(() => {
    void result.current.run([pinned], "delete");
  });
  renderDeletionDialog(result);
  const confirm = (await screen.findByTestId(TID_TASK_DELETE_CONFIRM)) as HTMLButtonElement;
  const checkbox = await screen.findByRole("checkbox", { name: "taskDelete.includePinned:1" });
  await waitFor(() => expect(checkbox.getAttribute("aria-checked")).toBe("false"));
  expect(confirm.disabled).toBe(true);
  expect(mocks.service.deleteArchivedTasks).not.toHaveBeenCalled();
  fireEvent.click(checkbox);
  await confirmOpenDialog();
  await waitFor(() => expect(mocks.service.eraseTasks).toHaveBeenCalledTimes(1));
  expect(mocks.service.deleteArchivedTasks).toHaveBeenCalledExactlyOnceWith({
    workspacePath: "/same",
    taskIds: ["pinned-only"],
  });
});
it("joins remote project names in the notice with the active locale's list format", async () => {
  const remote = (id: string, path: string) =>
    task(id, {
      workspacePath: path,
      hostId: "remote:server:r",
      workspaceIdentity: `remote:server:r:${path}`,
    });
  const rows = [remote("r1", "/work/api"), remote("r2", "/work/web"), remote("r3", "/work/cli")];
  const { result } = setup({ tree: { ...tree(), tasks: rows } });
  await act(async () => {
    await result.current.run(rows, "delete");
  });
  expect(result.current.deletionResult).toContain('"projects":"api, web, and cli"');

  mocks.locale = "uk-UA";
  const { result: uk } = renderHook(() => useArchiveManagement({ allowPermanentDelete: true }));
  await act(async () => {
    await uk.current.run(rows, "delete");
  });
  expect(uk.current.deletionResult).toContain('"projects":"api, web і cli"');
});
it("an archived row with unknown worktree status is not erased until the loss is acknowledged", async () => {
  const withWorktree = task("wt", {
    executionWorktree: { path: "/same/.worktrees/wt", branchName: "wt" },
  });
  const { result } = setup({ tree: { ...tree(), tasks: [withWorktree] } });
  mocks.gitService.getChanges.mockRejectedValue(new Error("git unavailable"));
  act(() => {
    void result.current.run([withWorktree], "delete");
  });
  renderDeletionDialog(result);
  const acknowledge = await screen.findByRole("checkbox", {
    name: /^taskDelete\.worktreeUnknownAcknowledge/,
  });
  const confirm = (await screen.findByTestId(TID_TASK_DELETE_CONFIRM)) as HTMLButtonElement;
  expect(confirm.textContent).toBe("taskDelete.deleteAnyway:1");
  expect(confirm.disabled).toBe(true);
  fireEvent.click(confirm);
  expect(mocks.service.deleteArchivedTasks).not.toHaveBeenCalled();
  expect(mocks.service.eraseTasks).not.toHaveBeenCalled();
  fireEvent.click(acknowledge);
  await confirmOpenDialog();
  await waitFor(() => expect(mocks.service.eraseTasks).toHaveBeenCalledTimes(1));
  expect(mocks.service.deleteArchivedTasks).toHaveBeenCalledExactlyOnceWith({
    workspacePath: "/same",
    taskIds: ["wt"],
  });
});

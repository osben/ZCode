import { describe, expect, it, vi } from "vitest";
import { selectTaskInNavigationWorkspace } from "@/app-shell/taskNavigationWorkspace.js";
import { createTabStore, isWorkspaceTab } from "@/store/tabStore.js";

// ISSUE-069 (specs/task-search-debounce.md, "Opening a result from another project").
// Search covers local projects whose tab is closed; picking such a result must open that project.
function setup(openPaths: string[], remote?: { path: string; identity: string }) {
  const tabs = createTabStore();
  for (const path of openPaths) tabs.getState().addTab(path);
  if (remote) tabs.getState().addTab(remote.path, { workspaceIdentity: remote.identity });
  tabs.getState().activateTabByPath(openPaths[0]!);
  const selectTask = vi.fn();
  const onRejected = vi.fn();
  const select = (workspacePath: string, taskId: string, workspaceIdentity?: string) =>
    selectTaskInNavigationWorkspace({
      target: { workspacePath, taskId, workspaceIdentity },
      activateTabByPath: tabs.getState().activateTabByPath,
      addLocalWorkspaceTab: (path) => tabs.getState().addTab(path),
      selectTask,
      onRejected,
    });
  const workspaceTabPaths = () =>
    tabs
      .getState()
      .tabs.filter(isWorkspaceTab)
      .map((tab) => tab.workspacePath)
      .sort();
  return { tabs, select, selectTask, onRejected, workspaceTabPaths };
}

describe("selectTaskInNavigationWorkspace", () => {
  it("opens and activates a closed local project before selecting its task", () => {
    const { tabs, select, selectTask, onRejected, workspaceTabPaths } = setup(["/dev/qa-sandbox"]);

    select("/dev/4POLL", "task-b");

    expect(tabs.getState().activeWorkspacePath).toBe("/dev/4POLL");
    expect(workspaceTabPaths()).toEqual(["/dev/4POLL", "/dev/qa-sandbox"]);
    expect(selectTask).toHaveBeenCalledWith("/dev/4POLL", "task-b", undefined);
    expect(onRejected).not.toHaveBeenCalled();
  });

  it("activates an already open project without adding a tab", () => {
    const { tabs, select, selectTask, workspaceTabPaths } = setup([
      "/dev/qa-sandbox",
      "/dev/4POLL",
    ]);

    select("/dev/4POLL", "task-b");

    expect(tabs.getState().activeWorkspacePath).toBe("/dev/4POLL");
    expect(workspaceTabPaths()).toEqual(["/dev/4POLL", "/dev/qa-sandbox"]);
    expect(selectTask).toHaveBeenCalledWith("/dev/4POLL", "task-b", undefined);
  });

  it("matches a remote result by identity, never by path", () => {
    const identity = "remote:ssh:host-a:/srv/app";
    const { tabs, select, selectTask } = setup(["/srv/app"], { path: "/srv/app", identity });

    select("/srv/app", "task-r", identity);

    expect(tabs.getState().activeWorkspaceIdentity).toBe(identity);
    expect(selectTask).toHaveBeenCalledWith("/srv/app", "task-r", identity);
  });

  it("rejects a remote result without an attachment in this window", () => {
    const { tabs, select, selectTask, onRejected, workspaceTabPaths } = setup(["/dev/qa-sandbox"]);

    select("/srv/app", "task-r", "remote:ssh:host-a:/srv/app");

    expect(tabs.getState().activeWorkspacePath).toBe("/dev/qa-sandbox");
    expect(workspaceTabPaths()).toEqual(["/dev/qa-sandbox"]);
    expect(selectTask).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledTimes(1);
  });
});

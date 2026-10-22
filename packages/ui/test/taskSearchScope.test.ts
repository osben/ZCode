import { describe, expect, it } from "vitest";
import {
  buildLocalTaskSearchScopes,
  buildTaskSearchProjectNames,
  getTaskSearchTaskKey,
} from "@/project-sidebar/taskSearchScope.js";
import type { ProjectTask, ProjectTree, VirtualProject } from "@/project-sidebar/contract.js";

function project(
  id: string,
  name: string,
  roots: string[],
  overrides: Partial<VirtualProject> = {},
): VirtualProject {
  return {
    id,
    hostId: "local",
    name,
    nameOverridden: false,
    roots: roots.map((rootPath, position) => ({ rootPath, position, isPrimary: position === 0 })),
    position: 0,
    pinned: false,
    deleted: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function task(
  taskId: string,
  workspacePath: string,
  projectId: string | null,
  overrides: Partial<ProjectTask> = {},
): ProjectTask {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    title: taskId,
    workspacePath,
    createdAt: 1,
    updatedAt: 1,
    mode: "default",
    projectId,
    hostId: "local",
    pinned: false,
    archived: false,
    ...overrides,
  };
}

const tree: ProjectTree = {
  projects: [
    project("open-project", "Open project", ["/work/open"]),
    project("closed-project", "Closed project", ["/work/closed"]),
    project("deleted-project", "Deleted project", ["/work/deleted"], { deleted: true }),
    project("remote-project", "Remote project", ["/srv/remote"], { hostId: "remote-1" }),
  ],
  tasks: [
    task("open-task", "/work/open", "open-project"),
    task("closed-task", "/work/closed", "closed-project"),
    // The cwd is no longer a root of its project; the sidebar still lists it under the project.
    task("moved-cwd-task", "/work/old-primary", "closed-project"),
    task("task-area-task", "/work/loose", null),
    task("deleted-project-task", "/work/deleted", "deleted-project"),
    task("remote-task", "/srv/remote", "remote-project", {
      workspaceIdentity: "remote-1:/srv/remote",
      hostId: "remote-1",
    }),
  ],
};

describe("buildLocalTaskSearchScopes", () => {
  it("includes a local project that has no open tab", () => {
    const scopes = buildLocalTaskSearchScopes({
      tree,
      openTabs: [{ workspacePath: "/work/open" }],
    });

    expect(scopes.map((scope) => scope.workspacePath)).toContain("/work/closed");
  });

  it("includes the cwd of a sidebar task that is outside its project roots", () => {
    const scopes = buildLocalTaskSearchScopes({ tree, openTabs: [] });

    expect(scopes.map((scope) => scope.workspacePath)).toContain("/work/old-primary");
  });

  it("includes the task area and the roots of deleted projects", () => {
    const paths = buildLocalTaskSearchScopes({ tree, openTabs: [] }).map(
      (scope) => scope.workspacePath,
    );

    expect(paths).toContain("/work/loose");
    expect(paths).toContain("/work/deleted");
  });

  it("does not widen remote sources beyond the open tabs", () => {
    const scopes = buildLocalTaskSearchScopes({ tree, openTabs: [] });

    expect(scopes.some((scope) => scope.workspaceIdentity)).toBe(false);
    expect(scopes.map((scope) => scope.workspacePath)).not.toContain("/srv/remote");
  });

  it("keeps an open remote tab as given and deduplicates by workspace key", () => {
    const scopes = buildLocalTaskSearchScopes({
      tree,
      openTabs: [
        { workspacePath: "/work/closed" },
        { workspacePath: "/srv/remote", workspaceIdentity: "remote-1:/srv/remote" },
      ],
    });

    expect(scopes.filter((scope) => scope.workspacePath === "/work/closed")).toHaveLength(1);
    expect(scopes).toContainEqual({
      workspacePath: "/srv/remote",
      workspaceIdentity: "remote-1:/srv/remote",
    });
  });

  it("falls back to the open tabs while the project tree is not loaded", () => {
    expect(
      buildLocalTaskSearchScopes({ tree: null, openTabs: [{ workspacePath: "/work/open" }] }),
    ).toEqual([{ workspacePath: "/work/open" }]);
  });
});

describe("buildTaskSearchProjectNames", () => {
  it("names a task by the project its row belongs to, even when a root is shared by two projects", () => {
    const shared: ProjectTree = {
      projects: [
        project("alpha", "Alpha", ["/work/shared"]),
        project("beta", "Beta", ["/work/shared"]),
      ],
      tasks: [task("beta-task", "/work/shared", "beta")],
    };

    const names = buildTaskSearchProjectNames(shared);

    expect(
      names.get(getTaskSearchTaskKey({ workspacePath: "/work/shared", taskId: "beta-task" })),
    ).toBe("Beta");
  });

  it("returns the name of a deleted project, because its tasks stay visible in the timeline", () => {
    const names = buildTaskSearchProjectNames(tree);

    expect(
      names.get(
        getTaskSearchTaskKey({ workspacePath: "/work/deleted", taskId: "deleted-project-task" }),
      ),
    ).toBe("Deleted project");
  });

  it("gives no project name to a task-area task or a task missing from the tree", () => {
    const names = buildTaskSearchProjectNames(tree);

    expect(
      names.has(getTaskSearchTaskKey({ workspacePath: "/work/loose", taskId: "task-area-task" })),
    ).toBe(false);
    expect(names.has(getTaskSearchTaskKey({ workspacePath: "/work/x", taskId: "unknown" }))).toBe(
      false,
    );
  });

  it("keys remote tasks by their workspace identity", () => {
    const names = buildTaskSearchProjectNames(tree);

    expect(
      names.get(
        getTaskSearchTaskKey({
          workspacePath: "/srv/remote",
          workspaceIdentity: "remote-1:/srv/remote",
          taskId: "remote-task",
        }),
      ),
    ).toBe("Remote project");
  });
});

import type { ProjectTree } from "@/project-sidebar/contract.js";

/** A workspace that a task search queries: the local path, or the remote identity when the workspace is remote. */
export interface TaskSearchScope {
  workspacePath: string;
  workspaceIdentity?: string;
}

interface TaskSearchTaskRef {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}

export function getTaskSearchWorkspaceKey(scope: TaskSearchScope): string {
  return scope.workspaceIdentity?.trim() || scope.workspacePath;
}

export function getTaskSearchTaskKey(task: TaskSearchTaskRef): string {
  return `${getTaskSearchWorkspaceKey(task)}:${task.taskId}`;
}

/**
 * Every local workspace the sidebar lists, plus open workspace tabs. Search must not stop at the open tabs: a task in a
 * project whose tab is closed is still visible in the sidebar. Remote workspaces are not widened; only an open remote
 * tab is searched, as before.
 */
export function buildLocalTaskSearchScopes(params: {
  tree: ProjectTree | null | undefined;
  openTabs: ReadonlyArray<TaskSearchScope>;
}): TaskSearchScope[] {
  const scopes = new Map<string, TaskSearchScope>();
  const add = (scope: TaskSearchScope) => {
    const key = getTaskSearchWorkspaceKey(scope);
    if (scopes.has(key)) return;
    scopes.set(key, scope.workspaceIdentity ? scope : { workspacePath: scope.workspacePath });
  };
  for (const tab of params.openTabs) add(tab);
  if (params.tree) {
    for (const project of params.tree.projects) {
      if (project.hostId !== "local") continue;
      for (const root of project.roots) add({ workspacePath: root.rootPath });
    }
    for (const task of params.tree.tasks) {
      // A task's cwd can differ from every current root of its project (the primary directory changed after it ran),
      // so the cwd of every listed local task is searched too.
      if (task.hostId !== "local" || task.workspaceIdentity?.trim()) continue;
      add({ workspacePath: task.workspacePath });
    }
  }
  return [...scopes.values()];
}

/**
 * Project name per task, joined by task identity against the sidebar's task rows, which carry the row's project_id.
 * Path is not used to pick a project: one directory can belong to several projects. Task-area tasks have no entry.
 */
export function buildTaskSearchProjectNames(
  tree: ProjectTree | null | undefined,
): Map<string, string> {
  const names = new Map<string, string>();
  if (!tree) return names;
  const projectNameById = new Map(tree.projects.map((project) => [project.id, project.name]));
  for (const task of tree.tasks) {
    const name = task.projectId ? projectNameById.get(task.projectId) : undefined;
    if (name) names.set(getTaskSearchTaskKey(task), name);
  }
  return names;
}

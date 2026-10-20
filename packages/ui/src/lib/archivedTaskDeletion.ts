import type { IGitService, IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  countTaskDeletionTrees,
  loadTaskDeletionWorktreePreview,
  permanentlyDeleteTasks,
  type ResolveTaskDeleteServices,
  type TaskDeleteTarget,
} from "@/task-deletion/taskDeletion.js";
import { logger } from "@/logger.js";

export interface ArchivedTaskDeletionTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}

export interface ArchivedTaskDeletionWorkspace {
  workspacePath: string;
  workspaceIdentity?: string;
  label: string;
  service?: Pick<
    IZCodeTaskService,
    | "listArchivedTasks"
    | "deleteArchivedTasks"
    | "countTaskTrees"
    | "getDeletionCapability"
    | "eraseTasks"
  >;
  gitService?: Pick<IGitService, "getChanges">;
}

export interface ArchivedTaskDeletionSelection {
  groups: { workspace: ArchivedTaskDeletionWorkspace; targets: TaskDeleteTarget[] }[];
  targets: TaskDeleteTarget[];
  count: number;
  unavailableWorkspaces: string[];
}

function resolverFor(selection: ArchivedTaskDeletionSelection): ResolveTaskDeleteServices {
  const byKey = new Map(
    selection.groups.map(({ workspace }) => [
      buildTaskWorkspaceKey(workspace.workspacePath, workspace.workspaceIdentity),
      workspace,
    ]),
  );
  return (target) => {
    const workspace = byKey.get(
      buildTaskWorkspaceKey(target.workspacePath, target.workspaceIdentity),
    );
    if (!workspace?.service || !workspace.gitService) return null;
    return {
      taskService: workspace.service as IZCodeTaskService,
      gitService: workspace.gitService as IGitService,
    };
  };
}

function toTarget(task: ZCodeTaskMeta, workspace: ArchivedTaskDeletionWorkspace): TaskDeleteTarget {
  return {
    id: `${buildTaskWorkspaceKey(workspace.workspacePath, workspace.workspaceIdentity)}:${task.taskId}`,
    taskId: task.taskId,
    title: task.title,
    workspacePath: workspace.workspacePath,
    workspaceIdentity: workspace.workspaceIdentity,
    archived: true,
    pinned: false,
    ...(task.executionWorktree ? { executionWorktree: task.executionWorktree } : {}),
  };
}

export async function collectArchivedTaskDeletion(
  workspaces: ArchivedTaskDeletionWorkspace[],
): Promise<ArchivedTaskDeletionSelection> {
  const unique = new Map(
    workspaces.map((workspace) => [
      buildTaskWorkspaceKey(workspace.workspacePath, workspace.workspaceIdentity),
      workspace,
    ]),
  );
  const results = await Promise.all(
    [...unique.values()].map(async (workspace) => {
      if (!workspace.service?.getDeletionCapability || !workspace.gitService) {
        return { workspace, targets: null };
      }
      try {
        const [tasks, capability] = await Promise.all([
          workspace.service.listArchivedTasks({
            workspacePath: workspace.workspacePath,
            workspaceIdentity: workspace.workspaceIdentity,
          }),
          workspace.service.getDeletionCapability({
            workspacePath: workspace.workspacePath,
            workspaceIdentity: workspace.workspaceIdentity,
          }),
        ]);
        if (!capability.supported) return { workspace, targets: null };
        const uniqueTasks = new Map(tasks.map((task) => [task.taskId, task]));
        return {
          workspace,
          targets: [...uniqueTasks.values()].map((task) => toTarget(task, workspace)),
        };
      } catch (error) {
        logger.warn("[ArchivedTaskDeletion] archived tasks or capability unavailable", {
          workspaceKey: buildTaskWorkspaceKey(workspace.workspacePath, workspace.workspaceIdentity),
          error,
        });
        return { workspace, targets: null };
      }
    }),
  );
  const groups = results.flatMap((result) =>
    result.targets ? [{ workspace: result.workspace, targets: result.targets }] : [],
  );
  const targets = groups.flatMap((group) => group.targets);
  return {
    groups,
    targets,
    count: targets.length,
    unavailableWorkspaces: results
      .filter((result) => result.targets === null)
      .map((result) => result.workspace.label),
  };
}

export async function deleteArchivedTaskSelection(
  selection: ArchivedTaskDeletionSelection,
  onDeleted: (target: ArchivedTaskDeletionTarget) => void,
  targets: readonly TaskDeleteTarget[] = selection.targets,
) {
  const result = await permanentlyDeleteTasks(targets, resolverFor(selection), (target) =>
    onDeleted({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      taskId: target.taskId,
    }),
  );
  return { ...result, unavailableWorkspaces: selection.unavailableWorkspaces };
}

export function countArchivedTaskDeletionTrees(
  selection: ArchivedTaskDeletionSelection,
  targets: readonly TaskDeleteTarget[] = selection.targets,
) {
  return countTaskDeletionTrees(targets, resolverFor(selection));
}

export function loadArchivedTaskDeletionWorktreePreview(
  selection: ArchivedTaskDeletionSelection,
  targets: readonly TaskDeleteTarget[] = selection.targets,
) {
  return loadTaskDeletionWorktreePreview(targets, resolverFor(selection));
}

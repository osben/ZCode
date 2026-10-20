/**
 * ZCode Session Store selectors and internal helpers.
 *
 * Split from zcodeSessionStore.ts; contains helpers for reading/updating workspace state,
 * plus all task-level read-only accessors and standalone selectors.
 */
import type { ZCodeTaskRuntimeStatus, ZCodeTaskMeta } from "@zcode/shared";
import { mergeTaskWithOptimisticMeta } from "@/lib/zcodeTaskMetaMerge.js";
import {
  DEFAULT_TASK_UI_STATE,
  DEFAULT_WORKSPACE_INIT_STATE,
  DEFAULT_TASK_RUNTIME_STATE,
  createDefaultWorkspaceState,
  getDefaultWorkspaceState,
  type ZCodeSessionStoreState,
  type WorkspaceInitState,
  type TaskRuntimeState,
  type WorkspaceZCodeUIState,
} from "./zcodeSessionStoreTypes.js";

// ────────────────────────────────────────────
// Internal helpers (also used by the store itself).
// ────────────────────────────────────────────

export function resolveWorkspaceStateKey(
  workspacePath: string,
  workspaceIdentity?: string,
): string {
  return workspaceIdentity?.trim() || workspacePath;
}

function copyTaskRecordEntries<T>(
  record: Record<string, T>,
  taskIds: ReadonlySet<string>,
): Record<string, T> {
  const entries = Object.entries(record).filter(([taskId]) => taskIds.has(taskId));
  return entries.length > 0 ? Object.fromEntries(entries) : {};
}

function collectIdentityTaskIds(
  baseState: WorkspaceZCodeUIState,
  workspaceIdentity: string,
): Set<string> {
  const normalizedIdentity = workspaceIdentity.trim();
  const taskIds = new Set<string>();
  for (const task of baseState.taskListCache ?? []) {
    if (task.workspaceIdentity?.trim() === normalizedIdentity) {
      taskIds.add(task.taskId);
    }
  }
  for (const task of Object.values(baseState.optimisticTaskListByTaskId)) {
    if (task.workspaceIdentity?.trim() === normalizedIdentity) {
      taskIds.add(task.taskId);
    }
  }
  return taskIds;
}

function createIdentityWorkspaceStateSeed(
  baseState: WorkspaceZCodeUIState | undefined,
  workspaceIdentity?: string,
): WorkspaceZCodeUIState {
  if (!baseState) {
    return createDefaultWorkspaceState(getDefaultWorkspaceState().selectedProvider);
  }

  const seededState = createDefaultWorkspaceState(baseState.selectedProvider);
  const migratedTaskIds = workspaceIdentity
    ? collectIdentityTaskIds(baseState, workspaceIdentity)
    : new Set<string>();
  const migratedTaskListCache =
    baseState.taskListCache?.filter((task) => migratedTaskIds.has(task.taskId)) ?? null;
  return {
    ...seededState,
    // On first write, identity may inherit workspace/draft-level display seeds,
    // but task state can be migrated only once using the persisted workspaceIdentity; do not dynamically merge path buckets.
    selectedSupplierKey: baseState.selectedSupplierKey,
    isGhostSupplier: baseState.isGhostSupplier,
    supplierMismatchReason: baseState.supplierMismatchReason,
    configOptions: baseState.configOptions,
    configOptionsStatus: baseState.configOptionsStatus,
    slashCommands: baseState.slashCommands,
    ...(migratedTaskIds.size > 0
      ? {
          activeTaskId:
            baseState.activeTaskId && migratedTaskIds.has(baseState.activeTaskId)
              ? baseState.activeTaskId
              : seededState.activeTaskId,
          optimisticTaskListByTaskId: copyTaskRecordEntries(
            baseState.optimisticTaskListByTaskId,
            migratedTaskIds,
          ),
          taskConfigOptionsByTaskId: copyTaskRecordEntries(
            baseState.taskConfigOptionsByTaskId,
            migratedTaskIds,
          ),
          taskConfigOptionsStatusByTaskId: copyTaskRecordEntries(
            baseState.taskConfigOptionsStatusByTaskId,
            migratedTaskIds,
          ),
          taskListCache: migratedTaskListCache,
          taskListVersion: baseState.taskListVersion,
          taskRuntimeByTaskId: copyTaskRecordEntries(
            baseState.taskRuntimeByTaskId,
            migratedTaskIds,
          ),
          taskUiByTaskId: copyTaskRecordEntries(baseState.taskUiByTaskId, migratedTaskIds),
          taskUnreadByTaskId: copyTaskRecordEntries(baseState.taskUnreadByTaskId, migratedTaskIds),
        }
      : {}),
  };
}

export function getWorkspaceState(
  state: ZCodeSessionStoreState,
  workspacePath: string,
  workspaceIdentity?: string,
): WorkspaceZCodeUIState {
  const baseState = state.workspaces[workspacePath] ?? getDefaultWorkspaceState();
  const workspaceKey = resolveWorkspaceStateKey(workspacePath, workspaceIdentity);
  if (workspaceKey === workspacePath) {
    return baseState;
  }

  const identityState = state.workspaces[workspaceKey];
  if (!identityState) {
    return baseState;
  }

  // workspaceIdentity represents remote/isolated workspace identity; path buckets are only for local fallback
  // and as a one-time migration source before the identity bucket is first written. Once an identity bucket exists, do not dynamically merge
  // path task maps; otherwise, different SSH/WSL/Docker windows using the same path could read each other's task config, queue, and error state.
  return identityState;
}

export function updateWorkspaceState(
  state: ZCodeSessionStoreState,
  workspacePath: string,
  updater: (current: WorkspaceZCodeUIState) => WorkspaceZCodeUIState,
  workspaceIdentity?: string,
): Pick<ZCodeSessionStoreState, "workspaces"> {
  const workspaceKey = resolveWorkspaceStateKey(workspacePath, workspaceIdentity);
  const current =
    workspaceKey === workspacePath
      ? getWorkspaceState(state, workspacePath, workspaceIdentity)
      : (state.workspaces[workspaceKey] ??
        createIdentityWorkspaceStateSeed(state.workspaces[workspacePath], workspaceIdentity));
  const nextWorkspaceState = updater(current);

  if (nextWorkspaceState === current) {
    // After migration to a single ZCode Agent, legacy provider selections normalize to glm, so many calls do not actually change state.
    // Return `state` itself: any new wrapper fails zustand's Object.is check and rerenders every subscriber.
    return state;
  }

  if (workspaceKey === workspacePath) {
    return {
      workspaces: {
        ...state.workspaces,
        [workspacePath]: nextWorkspaceState,
      },
    };
  }

  return {
    workspaces: {
      ...state.workspaces,
      // Workspace-level state for remote workspaces must be written only under the identity key.
      // Do not also write a path key to accommodate calls that omit identity: another remote window using the same path could fall back to it
      // and read this state, leaking slashCommands, model selection, and initialization state. The relevant call chains now pass identity,
      // so do not pollute path buckets here.
      [workspaceKey]: nextWorkspaceState,
    },
  };
}

// ────────────────────────────────────────────
// Per-task accessor functions
// ────────────────────────────────────────────

export function getTaskRuntimeState(
  workspaceState: WorkspaceZCodeUIState,
  taskId: string,
): TaskRuntimeState {
  return workspaceState.taskRuntimeByTaskId[taskId] ?? DEFAULT_TASK_RUNTIME_STATE;
}

interface WorkspaceDisplayedTaskState {
  taskStatus: ZCodeTaskRuntimeStatus;
  taskError: string | null;
}

export function getWorkspaceDisplayedTaskState(
  workspaceState: WorkspaceZCodeUIState,
): WorkspaceDisplayedTaskState {
  if (!workspaceState.activeTaskId) {
    return {
      taskStatus: workspaceState.draftRuntime.status,
      taskError: workspaceState.draftRuntime.error,
    };
  }

  const runtimeState = getTaskRuntimeState(workspaceState, workspaceState.activeTaskId);
  return {
    taskStatus: runtimeState.status,
    taskError: runtimeState.error,
  };
}

export function getTaskUiState(workspaceState: WorkspaceZCodeUIState, taskId: string) {
  return workspaceState.taskUiByTaskId[taskId] ?? DEFAULT_TASK_UI_STATE;
}

export function hasTaskPendingPermissionRequest(
  workspaceState: WorkspaceZCodeUIState,
  taskId: string,
): boolean {
  const taskUiState = getTaskUiState(workspaceState, taskId);
  return (
    taskUiState.permissionRequest != null ||
    (taskUiState.pendingPermissionRequests?.length ?? 0) > 0
  );
}

export function hasTaskPendingHumanInterventionRequest(
  workspaceState: WorkspaceZCodeUIState,
  taskId: string,
): boolean {
  const taskUiState = getTaskUiState(workspaceState, taskId);
  return (
    hasTaskPendingPermissionRequest(workspaceState, taskId) ||
    taskUiState.elicitationRequest != null ||
    (taskUiState.pendingElicitationRequests?.length ?? 0) > 0
  );
}

export function getTaskMeta(
  workspaceState:
    | WorkspaceZCodeUIState
    | Partial<Pick<WorkspaceZCodeUIState, "optimisticTaskListByTaskId" | "taskListCache">>,
  taskId: string,
): ZCodeTaskMeta | null {
  const optimisticTask = workspaceState.optimisticTaskListByTaskId?.[taskId];
  const cachedTask = workspaceState.taskListCache?.find((task) => task.taskId === taskId) ?? null;

  if (!optimisticTask) {
    return cachedTask;
  }

  if (!cachedTask) {
    return optimisticTask;
  }

  return mergeTaskWithOptimisticMeta(cachedTask, optimisticTask);
}

export function getVisibleTaskMetas(
  workspaceState:
    | WorkspaceZCodeUIState
    | Partial<Pick<WorkspaceZCodeUIState, "optimisticTaskListByTaskId" | "taskListCache">>,
): ZCodeTaskMeta[] {
  const taskById = new Map<string, ZCodeTaskMeta>();

  for (const task of workspaceState.taskListCache ?? []) {
    taskById.set(task.taskId, task);
  }

  for (const task of Object.values(workspaceState.optimisticTaskListByTaskId ?? {})) {
    taskById.set(task.taskId, getTaskMeta(workspaceState, task.taskId) ?? task);
  }

  return Array.from(taskById.values());
}

export function getTaskUnreadIndicator(
  workspaceState:
    | WorkspaceZCodeUIState
    | Partial<
        Pick<
          WorkspaceZCodeUIState,
          "optimisticTaskListByTaskId" | "taskListCache" | "taskUnreadByTaskId"
        >
      >,
  taskId: string,
  fallbackTask?: Pick<ZCodeTaskMeta, "unreadAt">,
): boolean {
  const storedTask = getTaskMeta(workspaceState, taskId);
  // After an IDE upgrade or restart, the task list may restore from the query cache before the session store has hydrated;
  // the persisted unreadAt then exists only on the list task. Fall back only when the store lacks that task, so an old list does not overwrite optimistic read state.
  return (
    Boolean((storedTask ?? fallbackTask)?.unreadAt) ||
    workspaceState.taskUnreadByTaskId?.[taskId] === true
  );
}

// ────────────────────────────────────────────
// Standalone selector functions
// ────────────────────────────────────────────

export function selectWorkspaceZCodeState(
  state: ZCodeSessionStoreState,
  workspacePath: string,
  workspaceIdentity?: string,
) {
  return getWorkspaceState(state, workspacePath, workspaceIdentity);
}

export function getWorkspaceInitState(
  workspaceState: Pick<WorkspaceZCodeUIState, "workspaceInit">,
): WorkspaceInitState {
  return workspaceState.workspaceInit ?? DEFAULT_WORKSPACE_INIT_STATE;
}

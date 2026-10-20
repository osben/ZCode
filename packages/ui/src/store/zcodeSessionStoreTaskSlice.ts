/* oxlint-disable eslint(max-lines) -- This file owns the task-level state slice; keep the draft-logic fix minimal and split the file later as a separate effort. */
import {
  normalizeAgentProviderToZCodeAgent,
  type ZCodeApiRetryStatus,
  type ZCodeConfigOption,
  type ZCodePermissionRequest,
  type ZCodeElicitationRequest,
  type ZCodeProvider,
  type ZCodeTaskRuntimeStatus,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import { removeTaskFromHistory } from "@/lib/taskNavigationHistory.js";
import { mergeTaskWithOptimisticMeta } from "@/lib/zcodeTaskMetaMerge.js";
import type {
  ConfigOptionsStatus,
  ElicitationFormDraft,
  ZCodeSessionStoreState,
  TaskRuntimeState,
  TaskUsageState,
} from "@/store/zcodeSessionStoreTypes.js";
import { getDefaultWorkspaceState } from "@/store/zcodeSessionStoreTypes.js";
import { clearPersistedComposerDraft } from "@/lib/chatComposerDraftStorage.js";
import { areConfigOptionsEquivalent } from "@/lib/configOptionsEquality.js";
import {
  getTaskRuntimeState,
  getTaskUiState,
  getWorkspaceState,
  resolveWorkspaceStateKey,
  updateWorkspaceState,
} from "@/store/zcodeSessionStoreSelectors.js";

type SetFn = (
  partial:
    | ZCodeSessionStoreState
    | Partial<ZCodeSessionStoreState>
    | ((state: ZCodeSessionStoreState) => ZCodeSessionStoreState | Partial<ZCodeSessionStoreState>),
) => void;

function sortTasksByUpdatedAt(tasks: readonly ZCodeTaskMeta[]): ZCodeTaskMeta[] {
  return [...tasks].sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    if (right.createdAt !== left.createdAt) {
      return right.createdAt - left.createdAt;
    }
    return right.taskId.localeCompare(left.taskId);
  });
}

function arePermissionOptionsEqual(
  left: ZCodePermissionRequest["options"],
  right: ZCodePermissionRequest["options"],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((option, index) => {
    const otherOption = right[index];
    if (!otherOption) {
      return false;
    }

    return (
      option.optionId === otherOption.optionId &&
      option.kind === otherOption.kind &&
      option.name === otherOption.name
    );
  });
}

function arePermissionRequestsEquivalent(
  left: ZCodePermissionRequest,
  right: ZCodePermissionRequest,
): boolean {
  if (left === right) {
    return true;
  }

  // The same requestId may be delivered repeatedly as different objects. raw is only for display previews; requestId is the protocol identity of a permission request.
  // Deduplicate by visible fields here so duplicate requests do not rerender the permission dialog and entire ChatView.
  return (
    left.requestId === right.requestId &&
    left.taskId === right.taskId &&
    left.traceId === right.traceId &&
    left.inputId === right.inputId &&
    left.kind === right.kind &&
    left.title === right.title &&
    left.description === right.description &&
    arePermissionOptionsEqual(left.options, right.options)
  );
}

function areTaskUsageCostsEqual(
  left: TaskUsageState["cost"] | undefined,
  right: TaskUsageState["cost"] | undefined,
): boolean {
  const normalizedLeft = left ?? null;
  const normalizedRight = right ?? null;
  if (normalizedLeft === null || normalizedRight === null) {
    return normalizedLeft === normalizedRight;
  }
  return (
    normalizedLeft.amount === normalizedRight.amount &&
    normalizedLeft.currency === normalizedRight.currency
  );
}

function areTaskUsageCachesEqual(
  left: TaskUsageState["cache"] | undefined,
  right: TaskUsageState["cache"] | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.inputTokens === right.inputTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.cacheWriteTokens === right.cacheWriteTokens &&
    left.latestHitRate === right.latestHitRate &&
    left.hitRate === right.hitRate &&
    left.hitRateRequestCount === right.hitRateRequestCount &&
    left.totalInputTokens === right.totalInputTokens &&
    left.totalCacheReadTokens === right.totalCacheReadTokens &&
    left.totalCacheWriteTokens === right.totalCacheWriteTokens
  );
}

function areTaskUsageBreakdownsEqual(
  left: TaskUsageState["breakdown"] | undefined,
  right: TaskUsageState["breakdown"] | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.every(
    (item, index) => item.source === right[index]?.source && item.chars === right[index]?.chars,
  );
}

function areTaskUsageStatesEqual(
  left: TaskUsageState | null,
  right: TaskUsageState | null,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.size === right.size &&
    left.used === right.used &&
    areTaskUsageCostsEqual(left.cost, right.cost) &&
    areTaskUsageCachesEqual(left.cache, right.cache) &&
    areTaskUsageBreakdownsEqual(left.breakdown, right.breakdown)
  );
}

function normalizeTaskContextWindow(contextWindow: number | null): number | null {
  if (contextWindow === null) {
    return null;
  }
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }
  return Math.floor(contextWindow);
}

function updateWorkspaceStateForIdentityScopedTaskState(
  state: ZCodeSessionStoreState,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  updater: (
    current: ReturnType<typeof getDefaultWorkspaceState>,
  ) => ReturnType<typeof getDefaultWorkspaceState>,
): Pick<ZCodeSessionStoreState, "workspaces"> {
  const workspaceKey = resolveWorkspaceStateKey(workspacePath, workspaceIdentity);
  if (workspaceKey === workspacePath) {
    return updateWorkspaceState(state, workspacePath, updater);
  }
  const current = state.workspaces[workspaceKey] ?? getDefaultWorkspaceState();
  return {
    workspaces: {
      ...state.workspaces,
      [workspaceKey]: updater(current),
    },
  };
}

/** `next` is a spread of `stored` plus overrides, so its keys cover every key of `stored`. */
function isTaskRuntimeUnchanged(stored: TaskRuntimeState, next: TaskRuntimeState): boolean {
  return (Object.keys(next) as (keyof TaskRuntimeState)[]).every((key) =>
    Object.is(next[key], stored[key]),
  );
}

export function createTaskSlice(set: SetFn) {
  return {
    setTaskRuntimeState: (
      workspacePath: string,
      taskId: string,
      status: ZCodeTaskRuntimeStatus,
      error?: string | null,
      workspaceIdentity?: string,
      provider?: ZCodeProvider,
    ) => {
      set((state) => {
        // Only an entry already stored in its own bucket may short-circuit: a missing bucket or entry must still be created.
        const storedTaskRuntime =
          state.workspaces[resolveWorkspaceStateKey(workspacePath, workspaceIdentity)]
            ?.taskRuntimeByTaskId[taskId];
        return updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const currentTaskRuntime = getTaskRuntimeState(current, taskId);
            const isRunningStatus =
              status === "creating" || status === "restoring" || status === "streaming";
            const nextTaskRuntime = {
              ...currentTaskRuntime,
              status,
              error: error ?? null,
              provider: provider ?? currentTaskRuntime.provider,
              // activeInputId identifies command routing for the current generation turn.
              // If a terminal/non-running state keeps the old inputId, mobile clients relying on snapshots will mistake a completed task for one that is still loading.
              // activeTurnKind is also session runtime state; it must be cleared when compaction finishes,
              // or the app layer will continue to treat sends for the same task as “compacting” and drop them.
              activeTurnKind: isRunningStatus ? currentTaskRuntime.activeTurnKind : undefined,
              activeInputId: isRunningStatus ? currentTaskRuntime.activeInputId : undefined,
              activeInputOwnerClientId: isRunningStatus
                ? currentTaskRuntime.activeInputOwnerClientId
                : undefined,
            };
            // Bot broadcasts repeat "streaming" on every chunk; an identical write must not notify every subscriber.
            if (
              storedTaskRuntime !== undefined &&
              isTaskRuntimeUnchanged(storedTaskRuntime, nextTaskRuntime)
            ) {
              return current;
            }
            return {
              ...current,
              taskRuntimeByTaskId: {
                ...current.taskRuntimeByTaskId,
                [taskId]: nextTaskRuntime,
              },
            };
          },
          workspaceIdentity,
        );
      });
    },

    setTaskUsage: (
      workspacePath: string,
      taskId: string,
      usage: TaskUsageState | null,
      workspaceIdentity?: string,
    ) => {
      set((state) => {
        const current = getWorkspaceState(state, workspacePath, workspaceIdentity);
        const currentRuntime = getTaskRuntimeState(current, taskId);
        if (areTaskUsageStatesEqual(currentRuntime.usage, usage)) {
          // usage_update may arrive repeatedly with the same value during streaming.
          // Creating new workspace/taskRuntime objects for these duplicates needlessly wakes React and causes dropped frames.
          return state;
        }
        return updateWorkspaceStateForIdentityScopedTaskState(
          state,
          workspacePath,
          workspaceIdentity,
          (current) => ({
            ...current,
            taskRuntimeByTaskId: {
              ...current.taskRuntimeByTaskId,
              [taskId]: {
                ...getTaskRuntimeState(current, taskId),
                usage,
              },
            },
          }),
        );
      });
    },

    setTaskContextWindow: (
      workspacePath: string,
      taskId: string,
      contextWindow: number | null,
      workspaceIdentity?: string,
    ) => {
      const normalizedContextWindow = normalizeTaskContextWindow(contextWindow);
      set((state) => {
        const current = getWorkspaceState(state, workspacePath, workspaceIdentity);
        const currentRuntime = getTaskRuntimeState(current, taskId);
        if (currentRuntime.contextWindow === normalizedContextWindow) {
          return state;
        }
        return updateWorkspaceStateForIdentityScopedTaskState(
          state,
          workspacePath,
          workspaceIdentity,
          (current) => ({
            ...current,
            taskRuntimeByTaskId: {
              ...current.taskRuntimeByTaskId,
              [taskId]: {
                ...getTaskRuntimeState(current, taskId),
                // contextWindow comes from model state; usage.used comes from runtime token statistics.
                // They may arrive in different streaming orders, so refreshing the window must not recreate the usage object and overwrite a positive used count with 0.
                contextWindow: normalizedContextWindow,
              },
            },
          }),
        );
      });
    },

    setTaskApiRetryStatus: (
      workspacePath: string,
      taskId: string,
      apiRetry: ZCodeApiRetryStatus | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            taskRuntimeByTaskId: {
              ...current.taskRuntimeByTaskId,
              [taskId]: {
                ...getTaskRuntimeState(current, taskId),
                apiRetry,
              },
            },
          }),
          workspaceIdentity,
        ),
      );
    },

    setTaskConfigOptions: (
      workspacePath: string,
      taskId: string,
      options: ZCodeConfigOption[],
      workspaceIdentity?: string,
      status: ConfigOptionsStatus = "ready",
    ) => {
      const normalizedOptions = [...options];
      set((state) => {
        const current = getWorkspaceState(state, workspacePath, workspaceIdentity);
        const currentOptions = current.taskConfigOptionsByTaskId[taskId] ?? [];
        const currentStatus = current.taskConfigOptionsStatusByTaskId[taskId] ?? "ready";
        if (
          currentStatus === status &&
          areConfigOptionsEquivalent(currentOptions, normalizedOptions)
        ) {
          // When restoring a historical task with an old model or automatically clearing a model without an API key, multiple restore paths may repeatedly submit
          // configOptions with equal content but different references. Skip equivalent writes to avoid Zustand notifications triggering a React effect loop.
          return state;
        }

        return updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            return {
              ...current,
              taskConfigOptionsByTaskId: {
                ...current.taskConfigOptionsByTaskId,
                [taskId]: normalizedOptions,
              },
              taskConfigOptionsStatusByTaskId: {
                ...current.taskConfigOptionsStatusByTaskId,
                [taskId]: status,
              },
            };
          },
          workspaceIdentity,
        );
      });
    },

    setTaskPermissionRequest: (
      workspacePath: string,
      taskId: string,
      request: ZCodePermissionRequest | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const taskUiState = getTaskUiState(current, taskId);
            if (request === null) {
              if (
                taskUiState.permissionRequest === null &&
                taskUiState.pendingPermissionRequests.length === 0
              ) {
                return current;
              }

              return {
                ...current,
                taskUiByTaskId: {
                  ...current.taskUiByTaskId,
                  [taskId]: {
                    ...taskUiState,
                    permissionRequest: null,
                    pendingPermissionRequests: [],
                  },
                },
              };
            }

            const currentPermissionRequest = taskUiState.permissionRequest;
            const pendingPermissionRequests = taskUiState.pendingPermissionRequests ?? [];

            let nextPermissionRequest = currentPermissionRequest;
            let nextPendingPermissionRequests = pendingPermissionRequests;

            if (currentPermissionRequest?.requestId === request.requestId) {
              if (arePermissionRequestsEquivalent(currentPermissionRequest, request)) {
                return current;
              }
              nextPermissionRequest = request;
            } else if (currentPermissionRequest === null) {
              nextPermissionRequest = request;
              nextPendingPermissionRequests = pendingPermissionRequests.filter(
                (item) => item.requestId !== request.requestId,
              );
            } else {
              const existingPendingIndex = pendingPermissionRequests.findIndex(
                (item) => item.requestId === request.requestId,
              );
              if (existingPendingIndex >= 0) {
                const existingPendingRequest = pendingPermissionRequests[existingPendingIndex];
                if (!existingPendingRequest) {
                  return current;
                }
                if (arePermissionRequestsEquivalent(existingPendingRequest, request)) {
                  return current;
                }
                nextPendingPermissionRequests = pendingPermissionRequests.map((item, index) =>
                  index === existingPendingIndex ? request : item,
                );
              } else {
                // Multiple permission requests may arrive consecutively for the same task. With only one permissionRequest field,
                // a later request overwrites the earlier one, leaving its pending permission unanswered and making the task appear “stuck.”
                // Queue subsequent requests by task so the next can be handled automatically after the user confirms the current request.
                nextPendingPermissionRequests = [...pendingPermissionRequests, request];
              }
            }

            return {
              ...current,
              taskUiByTaskId: {
                ...current.taskUiByTaskId,
                [taskId]: {
                  ...taskUiState,
                  permissionRequest: nextPermissionRequest,
                  pendingPermissionRequests: nextPendingPermissionRequests,
                },
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    removeTaskPermissionRequest: (
      workspacePath: string,
      taskId: string,
      requestId: string,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const taskUiState = getTaskUiState(current, taskId);
            const currentPermissionRequest = taskUiState.permissionRequest;
            const pendingPermissionRequests = taskUiState.pendingPermissionRequests ?? [];

            if (currentPermissionRequest?.requestId === requestId) {
              const [nextPermissionRequest, ...restPendingPermissionRequests] =
                pendingPermissionRequests;
              return {
                ...current,
                taskUiByTaskId: {
                  ...current.taskUiByTaskId,
                  [taskId]: {
                    ...taskUiState,
                    permissionRequest: nextPermissionRequest ?? null,
                    pendingPermissionRequests: restPendingPermissionRequests,
                  },
                },
              };
            }

            const pendingPermissionIndex = pendingPermissionRequests.findIndex(
              (item) => item.requestId === requestId,
            );
            if (pendingPermissionIndex < 0) {
              // Permission responses are cleared optimistically locally, and a replayed permission_response also arrives from the stream.
              // Rebuilding taskUiState during the second cleanup triggers unnecessary rerenders of ChatView and the permission preview tree, driving CPU usage up after confirmation.
              return current;
            }

            return {
              ...current,
              taskUiByTaskId: {
                ...current.taskUiByTaskId,
                [taskId]: {
                  ...taskUiState,
                  pendingPermissionRequests: pendingPermissionRequests.filter(
                    (_item, index) => index !== pendingPermissionIndex,
                  ),
                },
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    setTaskElicitationRequest: (
      workspacePath: string,
      taskId: string,
      request: ZCodeElicitationRequest | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const taskUiState = getTaskUiState(current, taskId);
            if (request === null) {
              return {
                ...current,
                taskUiByTaskId: {
                  ...current.taskUiByTaskId,
                  [taskId]: {
                    ...taskUiState,
                    elicitationRequest: null,
                    pendingElicitationRequests: [],
                  },
                },
              };
            }

            const currentElicitationRequest = taskUiState.elicitationRequest;
            const pendingElicitationRequests = taskUiState.pendingElicitationRequests ?? [];

            let nextElicitationRequest = currentElicitationRequest;
            let nextPendingElicitationRequests = pendingElicitationRequests;

            if (currentElicitationRequest?.requestId === request.requestId) {
              nextElicitationRequest = request;
            } else if (currentElicitationRequest === null) {
              nextElicitationRequest = request;
              nextPendingElicitationRequests = pendingElicitationRequests.filter(
                (item) => item.requestId !== request.requestId,
              );
            } else {
              const existingPendingIndex = pendingElicitationRequests.findIndex(
                (item) => item.requestId === request.requestId,
              );
              if (existingPendingIndex >= 0) {
                nextPendingElicitationRequests = pendingElicitationRequests.map((item, index) =>
                  index === existingPendingIndex ? request : item,
                );
              } else {
                nextPendingElicitationRequests = [...pendingElicitationRequests, request];
              }
            }

            return {
              ...current,
              taskUiByTaskId: {
                ...current.taskUiByTaskId,
                [taskId]: {
                  ...taskUiState,
                  elicitationRequest: nextElicitationRequest,
                  pendingElicitationRequests: nextPendingElicitationRequests,
                },
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    removeTaskElicitationRequest: (
      workspacePath: string,
      taskId: string,
      requestId: string,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const taskUiState = getTaskUiState(current, taskId);
            const currentElicitationRequest = taskUiState.elicitationRequest;
            const pendingElicitationRequests = taskUiState.pendingElicitationRequests ?? [];

            if (currentElicitationRequest?.requestId === requestId) {
              const [nextElicitationRequest, ...restPendingElicitationRequests] =
                pendingElicitationRequests;
              return {
                ...current,
                taskUiByTaskId: {
                  ...current.taskUiByTaskId,
                  [taskId]: {
                    ...taskUiState,
                    elicitationRequest: nextElicitationRequest ?? null,
                    pendingElicitationRequests: restPendingElicitationRequests,
                  },
                },
              };
            }

            return {
              ...current,
              taskUiByTaskId: {
                ...current.taskUiByTaskId,
                [taskId]: {
                  ...taskUiState,
                  pendingElicitationRequests: pendingElicitationRequests.filter(
                    (item) => item.requestId !== requestId,
                  ),
                },
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    setTaskElicitationFormDraft: (
      workspacePath: string,
      taskId: string,
      requestId: string,
      draft: ElicitationFormDraft,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const taskUiState = getTaskUiState(current, taskId);
            return {
              ...current,
              taskUiByTaskId: {
                ...current.taskUiByTaskId,
                [taskId]: {
                  ...taskUiState,
                  // Q&A progress used to live only in the dialog useState; switching tasks unmounted the component,
                  // and remounting initialized it only from the original request. Move it into the renderer store keyed by task/request,
                  // so local drafts can be restored without incorrectly writing per-question state into a runtime/replayable snapshot.
                  elicitationFormDraftsByRequestId: {
                    ...taskUiState.elicitationFormDraftsByRequestId,
                    [requestId]: draft,
                  },
                },
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    removeTaskElicitationFormDraft: (
      workspacePath: string,
      taskId: string,
      requestId: string,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const taskUiState = getTaskUiState(current, taskId);
            if (!(requestId in taskUiState.elicitationFormDraftsByRequestId)) {
              return current;
            }
            const nextDrafts = { ...taskUiState.elicitationFormDraftsByRequestId };
            delete nextDrafts[requestId];
            return {
              ...current,
              taskUiByTaskId: {
                ...current.taskUiByTaskId,
                [taskId]: {
                  ...taskUiState,
                  elicitationFormDraftsByRequestId: nextDrafts,
                },
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    setTaskError: (
      workspacePath: string,
      taskId: string,
      error: ZCodeUiError | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            taskUiByTaskId: {
              ...current.taskUiByTaskId,
              [taskId]: {
                ...getTaskUiState(current, taskId),
                // The full error object previously lived only in local state in ChatView/useZCodeChat.
                // When the page or task changed, unmounting the component also lost traceId/code, leaving only the plain text in taskRuntime.error.
                // Store it by task here so error details can be restored across pages like plans and permissions.
                error,
              },
            },
          }),
          workspaceIdentity,
        ),
      );
    },

    initializeBackgroundTaskRuntime: (
      workspacePath: string,
      params: {
        task: ZCodeTaskMeta;
        provider: ZCodeProvider;
        activeInputId: string;
        workspaceIdentity?: string;
      },
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const existingTask = current.optimisticTaskListByTaskId[params.task.taskId];
            const nextTask = existingTask
              ? mergeTaskWithOptimisticMeta(params.task, existingTask)
              : params.task;
            const currentTaskRuntime = getTaskRuntimeState(current, params.task.taskId);
            const cachedTasks = current.taskListCache ?? [];
            const nextTaskListCache =
              current.taskListCache === null
                ? current.taskListCache
                : sortTasksByUpdatedAt([
                    nextTask,
                    ...cachedTasks.filter((cachedTask) => cachedTask.taskId !== params.task.taskId),
                  ]);

            return {
              ...current,
              selectedProvider: normalizeAgentProviderToZCodeAgent(params.provider),
              // Performance: background first-send no longer needs multiple set operations through optimistic -> cache -> runtime.
              // Combining these into one write reduces renderer subscription storms when load tests create tasks concurrently.
              optimisticTaskListByTaskId: {
                ...current.optimisticTaskListByTaskId,
                [params.task.taskId]: nextTask,
              },
              taskListCache: nextTaskListCache,
              taskRuntimeByTaskId: {
                ...current.taskRuntimeByTaskId,
                [params.task.taskId]: {
                  ...currentTaskRuntime,
                  status: "streaming",
                  error: null,
                  provider: params.provider,
                  activeInputId: params.activeInputId,
                },
              },
            };
          },
          params.workspaceIdentity ?? params.task.workspaceIdentity,
        ),
      );
    },

    upsertOptimisticTaskListItem: (
      workspacePath: string,
      task: ZCodeTaskMeta,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const existingTask = current.optimisticTaskListByTaskId[task.taskId];
            const nextTask = existingTask ? mergeTaskWithOptimisticMeta(task, existingTask) : task;

            return {
              ...current,
              optimisticTaskListByTaskId: {
                ...current.optimisticTaskListByTaskId,
                // A desktop-continuous readSession snapshot may be older than the initial optimistic Date.now().
                // Merge monotonically by updatedAt here so an old snapshot cannot push a new task back down the list.
                [task.taskId]: nextTask,
              },
            };
          },
          workspaceIdentity ?? task.workspaceIdentity,
        ),
      );
    },

    removeOptimisticTaskListItem: (
      workspacePath: string,
      taskId: string,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const { [taskId]: _removedTaskMeta, ...restOptimisticTaskListByTaskId } =
              current.optimisticTaskListByTaskId;
            return {
              ...current,
              optimisticTaskListByTaskId: restOptimisticTaskListByTaskId,
            };
          },
          workspaceIdentity,
        ),
      );
    },

    removeTaskState: (workspacePath: string, taskId: string, workspaceIdentity?: string) => {
      // Deleting a task clears its in-memory state, but the composer draft also has a Desktop localStorage bucket.
      // If it is not cleared in the shared delete action, drafts for deleted tasks will remain after restart.
      clearPersistedComposerDraft(workspacePath, taskId, workspaceIdentity);
      set((state) => {
        const workspaceUpdate = updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const { [taskId]: _removedTaskRuntime, ...restTaskRuntimeByTaskId } =
              current.taskRuntimeByTaskId;
            const { [taskId]: _removedTaskUi, ...restTaskUiByTaskId } = current.taskUiByTaskId;
            const { [taskId]: _removedTaskConfigOptions, ...restTaskConfigOptionsByTaskId } =
              current.taskConfigOptionsByTaskId;
            const {
              [taskId]: _removedTaskConfigOptionsStatus,
              ...restTaskConfigOptionsStatusByTaskId
            } = current.taskConfigOptionsStatusByTaskId;
            const { [taskId]: _removedTaskUnread, ...restTaskUnreadByTaskId } =
              current.taskUnreadByTaskId;
            const { [taskId]: _removedTaskMeta, ...restOptimisticTaskListByTaskId } =
              current.optimisticTaskListByTaskId;

            const shouldCloseDeletedTask = current.activeTaskId === taskId;

            // When deleting the task currently viewed in the sidebar, the task list data used to be updated alone,
            // leaving the workspace activeTaskId pointing to the deleted task, so the main pane continued rendering details for the old taskId.
            // After successful deletion, clear the selection and runtime state together so the main pane immediately leaves the deleted task.
            return {
              ...current,
              activeTaskId: shouldCloseDeletedTask ? null : current.activeTaskId,
              draftRuntime: shouldCloseDeletedTask
                ? { status: "idle", error: null }
                : current.draftRuntime,
              taskRuntimeByTaskId: restTaskRuntimeByTaskId,
              taskUiByTaskId: restTaskUiByTaskId,
              taskConfigOptionsByTaskId: restTaskConfigOptionsByTaskId,
              taskConfigOptionsStatusByTaskId: restTaskConfigOptionsStatusByTaskId,
              taskUnreadByTaskId: restTaskUnreadByTaskId,
              optimisticTaskListByTaskId: restOptimisticTaskListByTaskId,
            };
          },
          workspaceIdentity,
        );

        return {
          ...workspaceUpdate,
          taskNavHistory: removeTaskFromHistory(state.taskNavHistory, taskId),
        };
      });
    },
  };
}

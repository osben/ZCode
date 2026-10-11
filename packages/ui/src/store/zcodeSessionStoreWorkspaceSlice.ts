import type { SessionCreateSource } from "@zcode/shared";
/* eslint-disable max-lines -- Keep workspace-level state actions in the same slice for maintainability. */
import {
  buildNativeSupplierKey,
  normalizeAgentProviderToZCodeAgent,
  type ZCodeConfigOption,
  type ModelSelectionResolution,
  type ZCodeProvider,
  type ZCodeSlashCommand,
  type ZCodeTaskMeta,
  type ZCodeTaskRuntimeStatus,
  type ZCodeWorkspaceInitStatus,
} from "@zcode/shared";
import { persistLastSelectedAgentProvider } from "@/lib/zcodeProviderPreference.js";
import { areConfigOptionsEquivalent } from "@/lib/configOptionsEquality.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import { pushNavEntry } from "@/lib/taskNavigationHistory.js";
import { resolveTaskRestorePreloadConfigOptions } from "@/lib/taskModelRecovery.js";
import type {
  ZCodeSessionStoreState,
  ConfigOptionsStatus,
  ComposerMentionPrefill,
  GroupedDraftTaskState,
  GroupedDraftTaskPlacement,
  ModelSwitchStage,
  WorkspaceZCodeUIState,
} from "@/store/zcodeSessionStoreTypes.js";
import {
  getTaskMeta,
  getWorkspaceState,
  getWorkspaceInitState,
  updateWorkspaceState,
} from "@/store/zcodeSessionStoreSelectors.js";

type SetFn = (
  partial:
    | ZCodeSessionStoreState
    | Partial<ZCodeSessionStoreState>
    | ((state: ZCodeSessionStoreState) => ZCodeSessionStoreState | Partial<ZCodeSessionStoreState>),
) => void;

let groupedDraftSequence = 0;

function createGroupedDraftId(createdAt: number): string {
  groupedDraftSequence += 1;
  return `grouped-draft-${createdAt}-${groupedDraftSequence}`;
}

function normalizeThoughtLevelConfigOption(option: ZCodeConfigOption): ZCodeConfigOption {
  if (
    option.type !== "select" ||
    (option.id !== "thought_level" && option.category !== "thought_level")
  ) {
    return option;
  }
  const currentValue = typeof option.currentValue === "string" ? option.currentValue : "";
  if (option.options?.some((entry) => entry.value === currentValue)) {
    return option;
  }
  const fallbackValue = option.options?.[0]?.value;
  if (!fallbackValue) {
    return option;
  }
  // thought_level may briefly be empty during a model-switch race; normalize it in the store so the toolbar Select does not enter an empty selection state.
  return { ...option, currentValue: fallbackValue };
}

function normalizeConfigOptions(options: ZCodeConfigOption[]): ZCodeConfigOption[] {
  return options.map(normalizeThoughtLevelConfigOption);
}

function cloneConfigOptions(options: readonly ZCodeConfigOption[]): ZCodeConfigOption[] {
  return options.map((option) => ({
    ...option,
    options: option.options?.map((entry) => ({ ...entry })),
  }));
}

function isSameGroupedDraftPlacement(
  left: GroupedDraftTaskPlacement,
  right: GroupedDraftTaskPlacement,
): boolean {
  if (left.type !== right.type) {
    return false;
  }
  if (left.type === "top") {
    return true;
  }
  return right.type === "group" && left.groupId === right.groupId;
}

function isModeConfigOption(option: ZCodeConfigOption): boolean {
  return option.category === "mode" && option.type === "select";
}

function createFallbackModeOption(params: {
  currentModeId: string;
  options?: NonNullable<ZCodeConfigOption["options"]>;
}): ZCodeConfigOption {
  const options = params.options?.length
    ? params.options
    : [{ value: params.currentModeId, name: params.currentModeId }];
  return {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: params.currentModeId,
    options,
  };
}

function replaceModeConfigOption(
  currentOptions: ZCodeConfigOption[] | null,
  nextModeOption: ZCodeConfigOption | null,
): ZCodeConfigOption[] | null {
  const options = currentOptions ?? [];
  const modeIndex = options.findIndex(isModeConfigOption);
  if (modeIndex === -1) {
    if (!nextModeOption) {
      return currentOptions;
    }
    return normalizeConfigOptions([...options, nextModeOption]);
  }

  if (!nextModeOption) {
    return normalizeConfigOptions([
      ...options.slice(0, modeIndex),
      ...options.slice(modeIndex + 1),
    ]);
  }

  return normalizeConfigOptions([
    ...options.slice(0, modeIndex),
    nextModeOption,
    ...options.slice(modeIndex + 1),
  ]);
}

function updateCurrentModeConfigOption(
  currentOptions: ZCodeConfigOption[] | null,
  modeId: string | null,
): ZCodeConfigOption[] | null {
  const options = currentOptions ?? [];
  const existingModeOption = options.find(isModeConfigOption);
  if (!modeId) {
    if (!existingModeOption) {
      return currentOptions;
    }
    if ((existingModeOption.options?.length ?? 0) === 0) {
      return replaceModeConfigOption(currentOptions, null);
    }
    return replaceModeConfigOption(currentOptions, {
      ...existingModeOption,
      currentValue: "",
    });
  }

  if (!existingModeOption) {
    return replaceModeConfigOption(
      currentOptions,
      createFallbackModeOption({ currentModeId: modeId }),
    );
  }

  return replaceModeConfigOption(currentOptions, {
    ...existingModeOption,
    currentValue: modeId,
  });
}

function updateActiveTaskConfigOptions(
  current: WorkspaceZCodeUIState,
  updater: (options: ZCodeConfigOption[] | null) => ZCodeConfigOption[] | null,
): Pick<WorkspaceZCodeUIState, "taskConfigOptionsByTaskId"> | null {
  const activeTaskId = current.activeTaskId;
  if (!activeTaskId) {
    return null;
  }

  const currentTaskOptions = current.taskConfigOptionsByTaskId[activeTaskId];
  if (!currentTaskOptions) {
    return null;
  }

  const nextTaskOptions = updater(currentTaskOptions);
  if (nextTaskOptions === currentTaskOptions || !nextTaskOptions) {
    return null;
  }

  return {
    taskConfigOptionsByTaskId: {
      ...current.taskConfigOptionsByTaskId,
      [activeTaskId]: nextTaskOptions,
    },
  };
}

function resolveActiveTaskConfigOptionsOnSwitch(
  current: WorkspaceZCodeUIState,
  taskId: string,
): { configOptions: ZCodeConfigOption[]; status: ConfigOptionsStatus } | null {
  const cachedTaskConfigOptions = current.taskConfigOptionsByTaskId[taskId];
  if (cachedTaskConfigOptions) {
    return {
      configOptions: cachedTaskConfigOptions,
      status: current.taskConfigOptionsStatusByTaskId[taskId] ?? "ready",
    };
  }

  const taskMeta = getTaskMeta(current, taskId);
  // When switching to a historical task, the toolbar model and context usage come from different state buckets.
  // If no task-level settings cache exists, seed the model from task metadata and enter loading while runtime settings arrive,
  // preventing the previous task's model (for example, glm-0531[1m]) from appearing with the current task's contextWindow.
  const preloadedOptions = normalizeConfigOptions(
    resolveTaskRestorePreloadConfigOptions({
      taskMeta: {
        provider: taskMeta?.provider ?? current.selectedProvider,
        model: taskMeta?.model,
        mode: taskMeta?.mode,
        thoughtLevel: taskMeta?.thoughtLevel,
      },
    }),
  );
  if (preloadedOptions.length === 0) {
    return null;
  }

  return {
    configOptions: preloadedOptions,
    status: "loading",
  };
}

export function createWorkspaceSlice(set: SetFn) {
  return {
    setActiveTaskId: (workspacePath: string, id: string | null, workspaceIdentity?: string) => {
      set((state) => {
        const workspaceUpdate = updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const { [id ?? ""]: _ignoredUnreadTask, ...restTaskUnreadByTaskId } =
              current.taskUnreadByTaskId;
            const optimisticTask = id ? current.optimisticTaskListByTaskId[id] : undefined;
            const nextOptimisticTaskListByTaskId =
              id && typeof optimisticTask?.unreadAt === "number"
                ? {
                    ...current.optimisticTaskListByTaskId,
                    [id]: {
                      ...optimisticTask,
                      // Marking unread from the context menu also writes unreadAt to the optimistic task.
                      // Previously, reopening the current task cleared only the old unread map, and list merging restored the blue dot
                      // from the optimistic task. Clear this projection in the same workspace transaction when opening the task.
                      unreadAt: undefined,
                    },
                  }
                : current.optimisticTaskListByTaskId;
            const activeTaskId = id;
            const activeTaskConfig = activeTaskId
              ? resolveActiveTaskConfigOptionsOnSwitch(current, activeTaskId)
              : null;
            const nextState = {
              ...current,
              taskUnreadByTaskId: restTaskUnreadByTaskId,
              optimisticTaskListByTaskId: nextOptimisticTaskListByTaskId,
              activeTaskId: id,
              // A grouped New task draft row is only an anchor for the current draft state.
              // Selecting a real task leaves that temporary entity, so clear it immediately to avoid an inoperable phantom row in the sidebar.
              groupedDraftTask: id ? null : current.groupedDraftTask,
            };
            return activeTaskId && activeTaskConfig
              ? {
                  ...nextState,
                  taskConfigOptionsByTaskId: {
                    ...current.taskConfigOptionsByTaskId,
                    [activeTaskId]: activeTaskConfig.configOptions,
                  },
                  taskConfigOptionsStatusByTaskId: {
                    ...current.taskConfigOptionsStatusByTaskId,
                    [activeTaskId]: activeTaskConfig.status,
                  },
                }
              : nextState;
          },
          workspaceIdentity,
        );

        const navUpdate = id
          ? {
              taskNavHistory: pushNavEntry(
                state.taskNavHistory,
                workspacePath,
                id,
                workspaceIdentity,
              ),
            }
          : {};

        return { ...workspaceUpdate, ...navUpdate };
      });
    },

    promoteGroupedDraftTask: (
      workspacePath: string,
      taskId: string,
      draft: GroupedDraftTaskState,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const optimisticTask: ZCodeTaskMeta = {
              taskId,
              traceId: `session-${taskId}` as ZCodeTaskMeta["traceId"],
              title: "",
              workspacePath,
              ...(workspaceIdentity ? { workspaceIdentity } : {}),
              createdAt: draft.createdAt,
              // This is a renderer placeholder used only to fill the ACK gap, not session truth.
              // Set updatedAt to the lowest sentinel value so any authoritative sessions-index metadata wins in
              // mergeTaskWithOptimisticMeta and the local clock cannot override fields such as mode/provider/status.
              updatedAt: 0,
              mode: "default",
              provider: current.selectedProvider,
            };
            // Task navigation and draft session creation are different state transitions. Bind the grouped placement captured when
            // the command was issued to the new task only at the successful creation boundary. The user may have entered another draft
            // while waiting for the ACK, so clear the current draft only if its identity still matches.
            // Previously, this cleared the draft row first but waited for sessions-index to provide real task metadata,
            // leaving a gap between the create/send ACK and the authoritative projection. Promote the transaction and write minimal optimistic metadata too,
            // without fabricating conversation state; the desktop continuous / web replayable authoritative projection will reconcile it later.
            return {
              ...current,
              groupedDraftTask:
                current.groupedDraftTask?.draftId === draft.draftId
                  ? null
                  : current.groupedDraftTask,
              optimisticTaskListByTaskId: {
                ...current.optimisticTaskListByTaskId,
                // task_created may reach the renderer before the command ACK. Do not downgrade more complete optimistic metadata
                // with this minimal row, which exists only to fill the gap.
                [taskId]: current.optimisticTaskListByTaskId[taskId] ?? optimisticTask,
              },
              promotedGroupedDraftTaskByTaskId: {
                ...current.promotedGroupedDraftTaskByTaskId,
                [taskId]: draft,
              },
            };
          },
          workspaceIdentity,
        ),
      );
    },

    clearPromotedGroupedDraftTask: (
      workspacePath: string,
      taskId: string,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            if (!current.promotedGroupedDraftTaskByTaskId[taskId]) {
              return current;
            }
            // promoted placement is a one-time transaction for promoting a draft before SQLite ordering converges.
            // Consume it after persistence so a later manual task drag is not pulled back into the old group.
            const { [taskId]: _consumedPromotedDraft, ...restPromotedGroupedDraftTaskByTaskId } =
              current.promotedGroupedDraftTaskByTaskId;
            return {
              ...current,
              promotedGroupedDraftTaskByTaskId: restPromotedGroupedDraftTaskByTaskId,
            };
          },
          workspaceIdentity,
        ),
      );
    },

    setDraftSessionId: (
      workspacePath: string,
      sessionId: string | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            if (current.draftSessionId === sessionId) {
              return current;
            }
            return { ...current, draftSessionId: sessionId };
          },
          workspaceIdentity,
        ),
      );
    },

    invalidateDraftRuntime: (workspacePath: string, workspaceIdentity?: string) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            // A protocol-v4 draft warm-up session exists only inside SessionPane, so clearing legacy draftSessionId is not enough.
            // Increment the version so the pane can precisely dispose of the unpromoted warm-up session and rebuild its capability snapshot.
            draftRuntimeInvalidationVersion: current.draftRuntimeInvalidationVersion + 1,
            draftSessionId: null,
          }),
          workspaceIdentity,
        ),
      );
    },

    requestComposerTextInsert: (
      workspacePath: string,
      text: string,
      workspaceIdentity?: string,
      mention?: ComposerMentionPrefill,
      mode?: "replace" | "prepend-if-missing",
    ) => {
      let nextRequestId = 0;
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const requestId = current.composerTextInsertVersion + 1;
            nextRequestId = requestId;
            return {
              ...current,
              composerTextInsertVersion: requestId,
              composerTextInsertRequest: {
                requestId,
                text,
                ...(mention ? { mention } : {}),
                ...(mode ? { mode } : {}),
              },
            };
          },
          workspaceIdentity,
        ),
      );
      return nextRequestId;
    },

    clearComposerTextInsertRequest: (
      workspacePath: string,
      requestId: number,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) =>
            current.composerTextInsertRequest?.requestId === requestId
              ? { ...current, composerTextInsertRequest: null }
              : current,
          workspaceIdentity,
        ),
      );
    },

    requestTimelineBottom: (workspacePath: string, taskId: string, workspaceIdentity?: string) => {
      let nextRequestId = 0;
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const requestId = current.timelineBottomRequestVersion + 1;
            nextRequestId = requestId;
            return {
              ...current,
              timelineBottomRequestVersion: requestId,
              timelineBottomRequest: { requestId, taskId },
            };
          },
          workspaceIdentity,
        ),
      );
      return nextRequestId;
    },

    clearTimelineBottomRequest: (
      workspacePath: string,
      requestId: number,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) =>
            current.timelineBottomRequest?.requestId === requestId
              ? { ...current, timelineBottomRequest: null }
              : current,
          workspaceIdentity,
        ),
      );
    },

    startDraft: (
      workspacePath: string,
      provider?: ZCodeProvider,
      workspaceIdentity?: string,
      options?: {
        groupedDraftPlacement?: GroupedDraftTaskPlacement;
        createSource?: SessionCreateSource;
      },
    ) => {
      const normalizedProvider = provider
        ? normalizeAgentProviderToZCodeAgent(provider)
        : undefined;
      if (normalizedProvider) {
        persistLastSelectedAgentProvider(normalizedProvider);
      }

      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const nextSelectedProvider = normalizeAgentProviderToZCodeAgent(
              normalizedProvider ?? current.selectedProvider,
            );
            const shouldResetSupplierForDraftProvider =
              Boolean(normalizedProvider) && nextSelectedProvider !== current.selectedProvider;
            const shouldClearSlashCommands =
              current.activeTaskId !== null || shouldResetSupplierForDraftProvider;
            const shouldInheritActiveTaskConfig =
              current.activeTaskId !== null && !shouldResetSupplierForDraftProvider;
            const activeTaskIdForInheritance = shouldInheritActiveTaskConfig
              ? current.activeTaskId
              : null;
            const cachedActiveTaskConfigOptions = activeTaskIdForInheritance
              ? current.taskConfigOptionsByTaskId[activeTaskIdForInheritance]
              : null;
            const inheritedConfigOptions = activeTaskIdForInheritance
              ? cachedActiveTaskConfigOptions && cachedActiveTaskConfigOptions.length > 0
                ? cachedActiveTaskConfigOptions
                : // Bug cause: the protocol-v4 current task's configuration may have completed only the workspace projection;
                  // the legacy task cache may not be written yet or may still be an empty first-frame array. The toolbar already shows
                  // current.configOptions, so the new draft must inherit the current projection rather than warm up without a seed.
                  current.configOptions
              : null;
            const inheritedDraftConfigOptions =
              inheritedConfigOptions && inheritedConfigOptions.length > 0
                ? cloneConfigOptions(inheritedConfigOptions)
                : null;
            const inheritedConfigOptionsStatus =
              current.activeTaskId && inheritedDraftConfigOptions
                ? (current.taskConfigOptionsStatusByTaskId[current.activeTaskId] ?? "ready")
                : current.configOptionsStatus;
            const nextGroupedDraftTask = (() => {
              const placement = options?.groupedDraftPlacement;
              if (!placement) {
                return null;
              }
              if (
                current.activeTaskId === null &&
                current.groupedDraftTask &&
                isSameGroupedDraftPlacement(current.groupedDraftTask.placement, placement)
              ) {
                return current.groupedDraftTask;
              }
              if (current.activeTaskId === null && current.groupedDraftTask) {
                // Different New task entry points can reposition the same grouped draft.
                // Repeated clicks on the same entry should reuse the temporary entity, but switching from the global entry to a group entry must use the latest location.
                return {
                  ...current.groupedDraftTask,
                  workspacePath,
                  ...(workspaceIdentity ? { workspaceIdentity } : {}),
                  placement,
                };
              }
              const createdAt = Date.now();
              return {
                draftId: createGroupedDraftId(createdAt),
                workspacePath,
                ...(workspaceIdentity ? { workspaceIdentity } : {}),
                placement,
                createdAt,
              };
            })();
            return {
              ...current,
              activeTaskId: null,
              groupedDraftTask: nextGroupedDraftTask,
              draftCreateSource:
                options?.createSource ?? (options?.groupedDraftPlacement ? "group" : "session"),
              draftRuntime: { status: "idle", error: null },
              // When New Task is opened from an existing task, the draft input must inherit that task's full configuration.
              // Otherwise, a later workspace prepare rebuilds the draft with the Team Plan/default model and switches deepseek back to GLM.
              ...(inheritedDraftConfigOptions
                ? {
                    configOptions: inheritedDraftConfigOptions,
                    configOptionsStatus: inheritedConfigOptionsStatus,
                    // An old deferred draft session may still use the previous default model.
                    // Recreate the draft session after inheriting the active task so an old session response cannot overwrite the new draft.
                    draftSessionId: null,
                  }
                : {}),
              draftError: null,
              modelSwitchRequestId: null,
              modelSwitchPending: false,
              modelSwitchStage: "idle",
              // Cmd/Ctrl+N and "New task" in the task list previously changed only store state without explicitly returning focus to the input.
              // Electron menus and buttons take focus first, so the draft appeared open before the cursor returned.
              // Increment the version whenever entering draft state so ChatView can focus the Lexical input after the state transition completes.
              draftFocusVersion: current.draftFocusVersion + 1,
              optimisticMessages: [],
              // The new-task state (taskId=null) now has its own unsent draft.
              // When switching to draft state, reset only transient state for this task creation; do not clear the null-scoped draft,
              // so users can return from taskA/B/C to "New task" and continue editing unsent content.
              // A new draft must not inherit slashCommands from the previous session, or typing `/` would show commands left over from that task.
              // Previously, every "New task" click cleared them unconditionally, so repeated clicks in draft state emptied the list without triggering a refill.
              // Clear only when switching from task to draft or when the provider actually changes, avoiding damage on repeated clicks in the same draft state.
              ...(shouldClearSlashCommands ? { slashCommands: [] } : {}),
              ...(normalizedProvider ? { selectedProvider: nextSelectedProvider } : {}),
              ...(shouldResetSupplierForDraftProvider
                ? {
                    // Some "New task" entry points pass the current selectedProvider back into startDraft.
                    // Forcing a supplier reset when the provider has not changed would show a custom model while locking custom options.
                    // Return to native only when the provider actually changes, preserving supplier context when creating a draft with the same provider.
                    selectedSupplierKey: buildNativeSupplierKey(nextSelectedProvider),
                    isGhostSupplier: false,
                    supplierMismatchReason: null,
                  }
                : {}),
            };
          },
          workspaceIdentity,
        ),
      );
    },

    clearGroupedDraftTask: (workspacePath: string, workspaceIdentity?: string) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) =>
            current.groupedDraftTask ? { ...current, groupedDraftTask: null } : current,
          workspaceIdentity,
        ),
      );
    },

    bindRuntimeProvider: (
      workspacePath: string,
      provider: ZCodeProvider,
      workspaceIdentity?: string,
    ) =>
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            selectedProvider: normalizeAgentProviderToZCodeAgent(provider),
          }),
          workspaceIdentity,
        ),
      ),

    setModelSelectionResolution: (
      workspacePath: string,
      resolution: Pick<
        ModelSelectionResolution,
        "selectedSupplierKey" | "isGhostSupplier" | "supplierMismatchReason"
      >,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            selectedSupplierKey: resolution.selectedSupplierKey,
            isGhostSupplier: resolution.isGhostSupplier,
            supplierMismatchReason: resolution.supplierMismatchReason,
          }),
          workspaceIdentity,
        ),
      );
    },

    setWorkspaceInitState: (
      workspacePath: string,
      status: ZCodeWorkspaceInitStatus,
      error?: string | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            workspaceInit: {
              ...getWorkspaceInitState(current),
              status,
              error: error ?? null,
            },
          }),
          workspaceIdentity,
        ),
      );
    },

    setWorkspaceInitAttempts: (
      workspacePath: string,
      attempts: number,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            workspaceInit: {
              ...getWorkspaceInitState(current),
              attempts,
            },
          }),
          workspaceIdentity,
        ),
      );
    },

    setTaskState: (
      workspacePath: string,
      status: ZCodeTaskRuntimeStatus,
      error?: string | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            draftRuntime: {
              status,
              error: error ?? null,
            },
          }),
          workspaceIdentity,
        ),
      );
    },

    setDraftError: (
      workspacePath: string,
      error: ZCodeUiError | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            // A first-send failure in draft state has no taskId. If the error stays only in component memory,
            // it disappears after navigating away and back. Store a workspace-level draftError separately
            // so errors from a task that has not yet been created remain visible in the current workspace.
            draftError: error,
          }),
          workspaceIdentity,
        ),
      );
    },

    startModelSwitch: (
      workspacePath: string,
      requestId: string,
      stage: ModelSwitchStage = "settingModel",
      workspaceIdentity?: string,
      options?: { pending?: boolean },
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            modelSwitchRequestId: requestId,
            // Ordinary session/setModel already updates the UI optimistically; requestId is enough to prevent stale responses from overwriting the new selection.
            // Only slower paths such as custom providers and runtime restarts need to put the toolbar into loading state.
            modelSwitchPending: options?.pending ?? true,
            modelSwitchStage: stage,
          }),
          workspaceIdentity,
        ),
      );
    },

    updateModelSwitchStage: (
      workspacePath: string,
      requestId: string,
      stage: ModelSwitchStage,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            if (current.modelSwitchRequestId !== requestId) {
              return current;
            }

            return {
              ...current,
              modelSwitchStage: stage,
            };
          },
          workspaceIdentity,
        ),
      );
    },

    finishModelSwitch: (workspacePath: string, requestId: string, workspaceIdentity?: string) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            if (current.modelSwitchRequestId !== requestId) {
              return current;
            }

            return {
              ...current,
              modelSwitchRequestId: null,
              modelSwitchPending: false,
              modelSwitchStage: "idle",
            };
          },
          workspaceIdentity,
        ),
      );
    },

    setConfigOptions: (
      workspacePath: string,
      options: ZCodeConfigOption[],
      workspaceIdentity?: string,
    ) => {
      set((state) => {
        const current = getWorkspaceState(state, workspacePath, workspaceIdentity);
        const normalizedOptions = normalizeConfigOptions(options);
        const skipped = areConfigOptionsEquivalent(current.configOptions, normalizedOptions);
        if (skipped) {
          // When no API key is available or an old model is unavailable, the toolbar recovery effect may submit the same empty model configuration repeatedly.
          // An equivalent configuration must not trigger a workspace-level store notification, or ChatInputToolbar will call setConfigOptions again from its effect.
          return state;
        }

        return updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            // startDraft first saves the active task's warm-up seed, then async directory hydration reaches this point.
            // Directory refresh is not the end of the draft lifecycle; do not clear the seed or createSession will fall back to the global default model.
            configOptions: normalizedOptions,
          }),
          workspaceIdentity,
        );
      });
    },

    setConfigOptionsStatus: (
      workspacePath: string,
      status: "idle" | "loading" | "ready" | "error",
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            configOptionsStatus: status,
          }),
          workspaceIdentity,
        ),
      );
    },

    setSlashCommands: (
      workspacePath: string,
      commands: ZCodeSlashCommand[],
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            slashCommands: commands,
          }),
          workspaceIdentity,
        ),
      );
    },

    setCurrentModeId: (
      workspacePath: string,
      modeId: string | null,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const nextConfigOptions = updateCurrentModeConfigOption(current.configOptions, modeId);
            const activeTaskPatch = updateActiveTaskConfigOptions(current, (options) =>
              updateCurrentModeConfigOption(options, modeId),
            );
            if (nextConfigOptions === current.configOptions && !activeTaskPatch) {
              return current;
            }
            return {
              ...current,
              configOptions: nextConfigOptions,
              // An active task runtime ignores workspace_config_options_update,
              // while first-send/restore may first write task configuration containing only model.
              // mode_update is the session source of truth and must also be written to the task configuration bucket, or the mode control disappears after sending.
              ...activeTaskPatch,
            };
          },
          workspaceIdentity,
        ),
      );
    },

    bumpTaskListVersion: (workspacePath: string, workspaceIdentity?: string) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            taskListVersion: current.taskListVersion + 1,
          }),
          workspaceIdentity,
        ),
      );
    },

    setTaskListCache: (
      workspacePath: string,
      tasks: ZCodeTaskMeta[],
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            taskListCache: tasks,
            // The source of truth for unread state is now task meta.unreadAt.
            // Do not rebuild the list cache as a second source of truth; that would make cache refreshes conflict with local optimistic updates.
            taskUnreadByTaskId: current.taskUnreadByTaskId,
          }),
          workspaceIdentity,
        ),
      );
    },

    setTaskUnreadIndicator: (
      workspacePath: string,
      taskId: string,
      hasUnread: boolean,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => {
            const optimisticTaskMeta = current.optimisticTaskListByTaskId[taskId];
            const cachedTaskMeta = current.taskListCache?.find((task) => task.taskId === taskId);
            const baseTaskMeta = optimisticTaskMeta ?? cachedTaskMeta;
            const currentHasUnread = current.taskUnreadByTaskId[taskId] === true;
            const currentUnreadAt = optimisticTaskMeta?.unreadAt ?? cachedTaskMeta?.unreadAt;

            if (hasUnread) {
              const nextUnreadAt = baseTaskMeta?.unreadAt ?? Date.now();
              if (currentHasUnread && currentUnreadAt === nextUnreadAt) {
                return current;
              }

              const nextOptimisticTaskListByTaskId = baseTaskMeta
                ? {
                    ...current.optimisticTaskListByTaskId,
                    [taskId]: {
                      ...baseTaskMeta,
                      unreadAt: nextUnreadAt,
                    },
                  }
                : current.optimisticTaskListByTaskId;

              return {
                ...current,
                optimisticTaskListByTaskId: nextOptimisticTaskListByTaskId,
                taskUnreadByTaskId: {
                  ...current.taskUnreadByTaskId,
                  [taskId]: true,
                },
              };
            }

            if (!currentHasUnread && currentUnreadAt === undefined) {
              // Both the local response and stream response clear unread state after permission is granted.
              // If already read, reuse the workspace state to avoid unnecessary task-list and ChatView refreshes.
              return current;
            }

            const { [taskId]: _removedTaskUnread, ...restTaskUnreadByTaskId } =
              current.taskUnreadByTaskId;
            const nextOptimisticTaskListByTaskId = baseTaskMeta
              ? {
                  ...current.optimisticTaskListByTaskId,
                  [taskId]: {
                    ...baseTaskMeta,
                    unreadAt: undefined,
                  },
                }
              : current.optimisticTaskListByTaskId;

            return {
              ...current,
              optimisticTaskListByTaskId: nextOptimisticTaskListByTaskId,
              taskUnreadByTaskId: restTaskUnreadByTaskId,
            };
          },
          workspaceIdentity,
        ),
      );
    },
  };
}

/**
 * ZCode Session Store navigation slice — task forward/back history management.
 *
 * Split from zcodeSessionStore.ts; encapsulates initial state and actions related to task navigation.
 * createNavigationSlice(set, get) returns an object that can be spread directly into the store.
 */
import { Emitter } from "@zcode/rpc";
import {
  createTaskNavigationHistory,
  pushAutomationsNavEntry,
  pushPluginStoreNavEntry,
  stepTaskNavigationHistory,
  type AutomationsNavigationTab,
  type TaskNavigationDirection,
  type WorkspaceNavEntry,
  type TaskNavEntry,
} from "@/lib/taskNavigationHistory.js";
import type { ZCodeSessionStoreState } from "./zcodeSessionStoreTypes.js";

type SetFn = (
  partial:
    | ZCodeSessionStoreState
    | Partial<ZCodeSessionStoreState>
    | ((state: ZCodeSessionStoreState) => ZCodeSessionStoreState | Partial<ZCodeSessionStoreState>),
) => void;
type GetFn = () => ZCodeSessionStoreState;
type TaskNavAvailability = (entry: TaskNavEntry) => boolean;

const alwaysAvailable: TaskNavAvailability = () => true;

// Stepping and purging happen in one store update, so the caller never observes a cursor that a removal moved.
function stepTaskNav(
  set: SetFn,
  get: GetFn,
  direction: TaskNavigationDirection,
  isAvailable: TaskNavAvailability,
): WorkspaceNavEntry | null {
  const step = stepTaskNavigationHistory(get().taskNavHistory, direction, isAvailable);
  set({ taskNavHistory: step.history });
  return step.entry;
}

// 查看事实只由完整导航提交发布；tab 激活与历史游标移动都可能暴露缓存任务，不能代替提交。
const taskNavigationCommitted = new Emitter<TaskNavEntry>();
export const onTaskNavigationCommitted = taskNavigationCommitted.event;
export function notifyTaskNavigationCommitted(target: Omit<TaskNavEntry, "kind">): void {
  taskNavigationCommitted.fire({ kind: "task", ...target });
}

/**
 * Creates a navigation slice for the store creator to spread:
 * `...createNavigationSlice(set, get)`
 */
export function createNavigationSlice(set: SetFn, get: GetFn) {
  return {
    taskNavHistory: createTaskNavigationHistory(),

    taskNavPushAutomations: (
      workspacePath: string,
      workspaceIdentity?: string,
      automationId?: string,
      automationTab?: AutomationsNavigationTab,
    ) => {
      set((state) => ({
        taskNavHistory: pushAutomationsNavEntry(
          state.taskNavHistory,
          workspacePath,
          workspaceIdentity,
          automationId,
          automationTab,
        ),
      }));
    },

    taskNavPushPluginStore: (workspacePath: string, workspaceIdentity?: string) => {
      set((state) => ({
        taskNavHistory: pushPluginStoreNavEntry(
          state.taskNavHistory,
          workspacePath,
          workspaceIdentity,
        ),
      }));
    },

    taskNavGoBack: (isAvailable: TaskNavAvailability = alwaysAvailable): WorkspaceNavEntry | null =>
      stepTaskNav(set, get, "back", isAvailable),

    taskNavGoForward: (
      isAvailable: TaskNavAvailability = alwaysAvailable,
    ): WorkspaceNavEntry | null => stepTaskNav(set, get, "forward", isAvailable),
  };
}

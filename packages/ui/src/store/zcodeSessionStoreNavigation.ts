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

/** 深层组件请求跳转到某个任务的目标（规格 0.13）。 */
export interface TaskNavigationRequest {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * 跳转**请求**通道，与上面的「已提交」通道相反：这条是入站的。
 *
 * 会话气泡的「来自会话 X」这类深层展示组件到 App 顶层隔着 SessionPane / WorkbenchPane /
 * V4ChatPane 等多层，逐层传回调会把展示组件绑死在壳层结构上。这里只发意图，由
 * useWorkspaceTaskNavigation（handleSelectTask 的唯一持有者）订阅并执行——
 * 与 App 控制工具的 OpenSession 是同一条「外部请求 → 既有导航 owner」的形状。
 * 导航 owner 仍然唯一，不新增第二条导航路径。
 */
const taskNavigationRequested = new Emitter<TaskNavigationRequest>();
export const onTaskNavigationRequested = taskNavigationRequested.event;
export function requestTaskNavigation(target: TaskNavigationRequest): void {
  taskNavigationRequested.fire(target);
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

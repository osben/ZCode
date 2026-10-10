import type { ZCodeTaskMeta } from "@zcode/shared";
import type {
  PendingInteractionSummary,
  SessionSummary,
  SessionWorkflowActivity,
} from "@zcode/shared/zcode-protocol-v4";

// UI-only sidecar: not part of shared task metadata/schema and never written back to tasks-index.
// Field names use an explicit internal prefix to prevent callers from mistaking them for persisted task properties.
const TASK_LIST_ROW_ACTIVITY_FIELD = "__zcodeSessionActivity" as const;

export interface TaskListRowActivity {
  phase: SessionSummary["phase"];
  lastActivityAt: number;
  hasBackgroundWork: boolean;
  pendingInteractions?: PendingInteractionSummary;
  /** Sidebar workflow-run row data; absent when there is no run. */
  workflowActivity?: SessionWorkflowActivity;
}

export type TaskListMetaWithActivity = ZCodeTaskMeta & {
  [TASK_LIST_ROW_ACTIVITY_FIELD]: TaskListRowActivity;
};

export function attachTaskListRowActivity<T extends ZCodeTaskMeta>(
  task: T,
  activity: TaskListRowActivity,
): T & TaskListMetaWithActivity {
  return {
    ...task,
    [TASK_LIST_ROW_ACTIVITY_FIELD]: activity,
  };
}

export function getTaskListRowActivity(task: ZCodeTaskMeta): TaskListRowActivity | null {
  const activity = (task as Partial<TaskListMetaWithActivity>)[TASK_LIST_ROW_ACTIVITY_FIELD];
  return activity ?? null;
}

/** Trust only the live phase from sessions-index; leftover status=running in tasks-index must not pin historical tasks to the top. */
function isTaskListRowRunning(task: ZCodeTaskMeta): boolean {
  const phase = getTaskListRowActivity(task)?.phase;
  return phase === "prewarming" || phase === "running";
}

/**
 * Membership rule for the running list layer: the turn is active (prewarming/running) **or** has background work (hasBackgroundWork).
 *
 * Dynamic workflow runs are background work — after the launch turn settles, the parent session phase is back to completedSuccess,
 * but each run-progress event still advances lastActivityAt. If the running layer checks phase alone, sessions each running one workflow
 * land in the non-running layer sorted by updatedAt and keep swapping places as progress events arrive. Background bash / detached subagents behave similarly.
 * The spinner still depends only on phase (isTaskListRowRunning); this decides only the sort layer.
 */
export function isTaskListRowActive(task: ZCodeTaskMeta): boolean {
  return isTaskListRowRunning(task) || getTaskListRowActivity(task)?.hasBackgroundWork === true;
}

export function getTaskListAttention(
  task: ZCodeTaskMeta,
): { kind: "permission" | "userInput"; count: number } | null {
  const summary = getTaskListRowActivity(task)?.pendingInteractions;
  if (!summary) {
    return null;
  }
  const count = summary.permissionCount + summary.userInputCount;
  if (count === 0) {
    return null;
  }
  return {
    kind: summary.userInputCount > 0 ? "userInput" : "permission",
    count,
  };
}

export function mergeTaskListMembershipFields(
  activityTask: ZCodeTaskMeta,
  membershipTask: ZCodeTaskMeta,
): ZCodeTaskMeta {
  const activity = getTaskListRowActivity(activityTask);
  if (!activity) {
    return membershipTask;
  }
  const membershipOwnsUnreadAt = Object.prototype.hasOwnProperty.call(membershipTask, "unreadAt");
  // tasks-index responses for rename/pin/archive/unread carry their own updatedAt/status,
  // but sidebar activity and Updated sorting belong only to sessions-index. Mutations may update membership/metadata
  // fields only; do not replace the whole row and reorder inactive tasks or lose the live phase.
  return attachTaskListRowActivity(
    {
      ...activityTask,
      ...membershipTask,
      createdAt: activityTask.createdAt,
      updatedAt: activity.lastActivityAt,
      status: activityTask.status,
      unreadAt: membershipOwnsUnreadAt ? membershipTask.unreadAt : activityTask.unreadAt,
    },
    activity,
  );
}

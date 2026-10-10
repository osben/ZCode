import type { ZCodeWorkspaceTaskListChanged } from "@zcode/shared";

type TaskListMembershipWorkspaceEventReason =
  | "task_archived"
  | "task_unarchived"
  | "task_pinned"
  | "task_unpinned";

const TASK_LIST_MEMBERSHIP_REASONS = new Set<ZCodeWorkspaceTaskListChanged["reason"]>([
  "task_archived",
  "task_unarchived",
  "task_pinned",
  "task_unpinned",
]);

function isTaskListMembershipWorkspaceEvent<
  T extends Pick<ZCodeWorkspaceTaskListChanged, "reason">,
>(
  event: T,
): event is T & {
  reason: TaskListMembershipWorkspaceEventReason;
} {
  return TASK_LIST_MEMBERSHIP_REASONS.has(event.reason);
}

/**
 * The sidebar treats tasks-index rows and pin/archive/unread membership as authoritative; sessions-index only provides detail,
 * and membershipVersion drives refetches. unread (setTaskUnread), rename, etc. use task_meta_changed;
 * sessions-index does not carry unread, so task_meta_changed is also a (low-frequency) membership-refetch signal.
 * task_created adds a positive row to tasks-index and must trigger a versioned read after the task row/grouped order is committed;
 * do not rely only on sessions-index detail or old query-cache incremental insertion.
 * task_model_changed (model switch) is unrelated to membership and is explicitly excluded — it used to be mixed into task_meta_changed,
 * so each model switch globally bumped membershipVersion and caused every list instance to refetch membership.
 */
export function shouldRefetchTaskListMembershipForWorkspaceEvent(
  event: Pick<ZCodeWorkspaceTaskListChanged, "reason">,
): boolean {
  // After deletion, sessions-index may continue publishing a session retained in the CLI store;
  // task_deleted must trigger a versioned join with deleted tombstones, not just remove it from query cache once.
  return (
    isTaskListMembershipWorkspaceEvent(event) ||
    // Once the sidebar treats tasks-index rows as authoritative, task_created is no longer only a session metadata event.
    // Without versioning membership/task-row promises, the new row may already be in SQLite while Project keeps displaying the old set.
    event.reason === "task_created" ||
    event.reason === "task_meta_changed" ||
    event.reason === "task_deleted"
  );
}

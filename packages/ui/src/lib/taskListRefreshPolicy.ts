import type { ZCodeWorkspaceTaskListChanged } from "@zcode/shared";

export type TaskListMembershipWorkspaceEventReason =
  | "task_archived"
  | "task_unarchived"
  | "task_pinned"
  | "task_unpinned";

export type TaskMetaWorkspaceEventSyncMode = "insert-active" | "preserve-membership";

const TASK_META_INCREMENTAL_REASONS = new Set<ZCodeWorkspaceTaskListChanged["reason"]>([
  "user_message_saved",
  "assistant_message_saved",
  "task_status_changed",
  "task_meta_changed",
  // Bugfix: changing models is a configuration-only change; update the model field incrementally
  // in metadata. Do not refresh the entire table or refetch membership. It used to be included in
  // task_meta_changed, causing every sidebar list across workspaces to refetch membership and republish all rows.
  "task_model_changed",
  // Bugfix: title changes (set by the first message, generated automatically, or renamed manually)
  // do not affect membership. Update metadata incrementally without refreshing the whole table or
  // refetching membership.
  "task_title_changed",
]);

const OPTIMISTIC_TASK_LIST_REASONS = new Set<ZCodeWorkspaceTaskListChanged["reason"]>([
  "task_meta_changed",
  "task_model_changed",
  "task_title_changed",
  "auto_archive",
]);

const TASK_LIST_MEMBERSHIP_REASONS = new Set<ZCodeWorkspaceTaskListChanged["reason"]>([
  "task_archived",
  "task_unarchived",
  "task_pinned",
  "task_unpinned",
]);

export function isTaskListMembershipWorkspaceEvent<
  T extends Pick<ZCodeWorkspaceTaskListChanged, "reason">,
>(
  event: T,
): event is T & {
  reason: TaskListMembershipWorkspaceEventReason;
} {
  return TASK_LIST_MEMBERSHIP_REASONS.has(event.reason);
}

export function isTaskListDeletionWorkspaceEvent(
  event: Pick<ZCodeWorkspaceTaskListChanged, "reason">,
): boolean {
  return event.reason === "task_deleted";
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

export function shouldRefreshTaskListForWorkspaceEvent(
  event: Pick<ZCodeWorkspaceTaskListChanged, "reason" | "taskId" | "taskMeta">,
): boolean {
  // Bugfix: send, stop, archive, and metadata saves already update the optimistic task cache or
  // snapshot metadata incrementally. Treating realtime invalidation as a full-table query would
  // make sidebar tasks flicker during these actions. However, message-save and status-change events
  // carry only taskId/reason, not current metadata; remote-control observers have no local
  // optimistic state. Keep the silent refresh to sync running/completed/error, or the desktop task
  // list will not update after sending from a phone.
  if (getTaskMetaWorkspaceEventSyncMode(event)) {
    return false;
  }
  if (isTaskListMembershipWorkspaceEvent(event)) {
    // Bugfix: when a membership event includes taskMeta, the UI can infer the old membership from
    // the current cache position and move it incrementally. Refresh the whole table only as a
    // fallback for older versions or malformed broadcasts without metadata.
    return !event.taskMeta;
  }
  if (isTaskListDeletionWorkspaceEvent(event)) {
    // Bugfix: delete events usually carry only taskId, so we cannot tell which active/pinned/archived
    // lists contained a collapsed or paginated-away item. The caller skips refresh when it confirms
    // a visible cache hit; otherwise, query the server source of truth to update total/hasMore.
    return true;
  }

  return !OPTIMISTIC_TASK_LIST_REASONS.has(event.reason);
}

export function getTaskMetaWorkspaceEventSyncMode(
  event: Pick<ZCodeWorkspaceTaskListChanged, "reason" | "taskMeta">,
): TaskMetaWorkspaceEventSyncMode | null {
  if (!event.taskMeta) {
    return null;
  }
  if (event.reason === "task_created") {
    // Bugfix: when a phone creates a task through shared-host, the desktop renderer has no local
    // optimistic insertion. Treat task_created as an active-membership change and insert it into
    // every matching query cache, rather than only reordering existing entries.
    return "insert-active";
  }
  if (TASK_META_INCREMENTAL_REASONS.has(event.reason)) {
    return "preserve-membership";
  }
  return null;
}

export function shouldApplyTaskMetaFromWorkspaceEvent(
  event: Pick<ZCodeWorkspaceTaskListChanged, "reason" | "taskMeta">,
): event is Pick<ZCodeWorkspaceTaskListChanged, "reason"> & {
  taskMeta: NonNullable<ZCodeWorkspaceTaskListChanged["taskMeta"]>;
} {
  return Boolean(getTaskMetaWorkspaceEventSyncMode(event));
}

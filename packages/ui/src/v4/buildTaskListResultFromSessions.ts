// Left-side list projection: tasks-index determines the persistent row set and membership; sessions-index adds only live activity/details.
// Keep this as a pure function so Project/Timeline/Pinned/Archived/Grouped share the same field authority.
import type { ZCodeTaskMeta } from "@zcode/shared";
import { matchesTaskListMembershipKind } from "@zcode/shared/zcode-protocol-v4";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";
import { compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import { attachTaskListRowActivity, getTaskListRowActivity } from "@/v4/taskListRowActivity.js";

export type TaskListKind = "pinned" | "archived" | "timeline" | "active";
export type TaskListSortBy = "created" | "updated";

export interface BuildTaskListParams {
  /** Union of task rows from the three persistent tasks-index partitions: active/pinned/archived. */
  taskIndexItems: ZCodeTaskMeta[];
  /** Session activity/details derived from sessions-index; overrides only matching persistent rows. */
  sessions: ZCodeTaskMeta[];
  kind: TaskListKind;
  /** Server-authoritative set of pinned/archived IDs (persisted in tasks-index.sqlite). */
  pinnedIds: ReadonlySet<string>;
  archivedIds: ReadonlySet<string>;
  /** Persistent deletion tombstones from tasks-index; a matching task belongs to no list kind. */
  deletedIds?: ReadonlySet<string>;
  search?: string;
  sortBy: TaskListSortBy;
  /** Collapse limit; undefined means all rows (expanded). */
  limit?: number;
  /** taskId → unreadAt (tasks-index organization state, fetched alongside pin/archive). The sessions-index schema is frozen and carries no unread state, so join it into metadata while building the list. */
  unreadAtByTaskId?: ReadonlyMap<string, number>;
  /** taskId → terminal status (historical terminal state from tasks-index; fills only cold-start stored summaries). */
  terminalStatusByTaskId?: ReadonlyMap<
    string,
    Extract<ZCodeTaskMeta["status"], "completed" | "error">
  >;
  /** taskId → legacy task-index manual title; overrides only session metadata where titleOverridden !== true. */
  titleOverrideByTaskId?: ReadonlyMap<string, string>;
  /** taskId -> cronAutomationId (tasks-index metadata; not included in SessionSummary). */
  cronAutomationIdByTaskId?: ReadonlyMap<string, string>;
}

export interface BuildTaskListResult {
  items: ZCodeTaskMeta[];
  total: number;
}

function mergeTaskIndexRowWithSession(
  taskIndexTask: ZCodeTaskMeta,
  sessionTask: ZCodeTaskMeta,
): ZCodeTaskMeta {
  const activity = getTaskListRowActivity(sessionTask);
  const sessionTitle = sessionTask.title.trim();
  const sessionTitleWins =
    sessionTitle.length > 0 &&
    (sessionTask.titleOverridden === true || taskIndexTask.titleOverridden !== true);
  const titleOverridden =
    sessionTask.titleOverridden === true || taskIndexTask.titleOverridden === true
      ? true
      : undefined;
  const merged: ZCodeTaskMeta = {
    ...taskIndexTask,
    title: sessionTitleWins ? sessionTask.title : taskIndexTask.title,
    titleOverridden,
    // Session activity is authoritative for live creation/activity time and terminal state; task rows are a fallback only when the summary is missing.
    createdAt: sessionTask.createdAt || taskIndexTask.createdAt,
    updatedAt: (activity?.lastActivityAt ?? sessionTask.updatedAt) || taskIndexTask.updatedAt,
    status: sessionTask.status ?? taskIndexTask.status,
    forkedFromTaskId: sessionTask.forkedFromTaskId ?? taskIndexTask.forkedFromTaskId,
    // Pending interaction belongs to the current session projection; if its summary has arrived with an empty field, clear the old persisted value.
    pendingInteraction: sessionTask.pendingInteraction,
    // The worktree fact is session-projection-owned: the persistent task index has no column for it.
    executionWorktree: sessionTask.executionWorktree,
    // Health is live session state too; assigning undefined clears a stale marker after recovery.
    executionWorktreeMissing: sessionTask.executionWorktreeMissing,
    // Child facts are session-owned; missing fields clear stale task-index metadata.
    sideChatCount: sessionTask.sideChatCount,
    subagentCount: sessionTask.subagentCount,
    runningSubagentCount: sessionTask.runningSubagentCount,
    childSessions: sessionTask.childSessions,
  };
  return activity ? attachTaskListRowActivity(merged, activity) : merged;
}

/**
 * Join fields using tasks-index rows as the left side. If a summary is missing, keep the original task reference; session-only cold summaries
 * do not enter the persistent list, and the existing optimistic/live overlay handles the short window after creation.
 */
export function mergeTaskIndexRowsWithSessions(params: {
  taskIndexItems: ZCodeTaskMeta[];
  sessions: ZCodeTaskMeta[];
}): ZCodeTaskMeta[] {
  const sessionByEntityKey = new Map(
    params.sessions.map((session) => [buildTaskEntityKey(session), session]),
  );
  return params.taskIndexItems.map((task) => {
    const session = sessionByEntityKey.get(buildTaskEntityKey(task));
    return session ? mergeTaskIndexRowWithSession(task, session) : task;
  });
}

/** Join unreadAt: when the map is loaded, tasks-index is authoritative; before then, leave existing metadata unchanged to avoid first-frame flicker. */
export function joinTaskListUnreadAt(
  tasks: ZCodeTaskMeta[],
  unreadAtByTaskId: ReadonlyMap<string, number> | undefined,
): ZCodeTaskMeta[] {
  return joinTaskListMembershipMeta(tasks, { unreadAtByTaskId });
}

export function joinTaskListMembershipMeta(
  tasks: ZCodeTaskMeta[],
  params: {
    unreadAtByTaskId?: ReadonlyMap<string, number>;
    terminalStatusByTaskId?: ReadonlyMap<
      string,
      Extract<ZCodeTaskMeta["status"], "completed" | "error">
    >;
    titleOverrideByTaskId?: ReadonlyMap<string, string>;
    cronAutomationIdByTaskId?: ReadonlyMap<string, string>;
  },
): ZCodeTaskMeta[] {
  const {
    unreadAtByTaskId,
    terminalStatusByTaskId,
    titleOverrideByTaskId,
    cronAutomationIdByTaskId,
  } = params;
  if (
    unreadAtByTaskId === undefined &&
    (!terminalStatusByTaskId || terminalStatusByTaskId.size === 0) &&
    (!titleOverrideByTaskId || titleOverrideByTaskId.size === 0) &&
    (!cronAutomationIdByTaskId || cronAutomationIdByTaskId.size === 0)
  ) {
    return tasks;
  }
  return tasks.map((task) => {
    const activity = getTaskListRowActivity(task);
    const unreadAt = unreadAtByTaskId?.get(task.taskId);
    const terminalStatus = terminalStatusByTaskId?.get(task.taskId);
    const titleOverride =
      task.titleOverridden === true ? undefined : titleOverrideByTaskId?.get(task.taskId);
    const cronAutomationId = cronAutomationIdByTaskId?.get(task.taskId);
    const shouldUpdateUnread =
      unreadAtByTaskId !== undefined &&
      (unreadAt !== task.unreadAt || (unreadAt === undefined && task.unreadAt !== undefined));
    // On a v4 cold start, stored summaries may not yet have the activity sidecar, so only then use
    // tasks-index to fill historical terminal status. Once sessions-index projects activity, all live terminal states
    // belong to it and must not be overwritten by an old tasks-index error/completed value.
    const shouldUpdateStatus =
      activity === null &&
      terminalStatus !== undefined &&
      (task.status === undefined || (terminalStatus === "error" && task.status === "completed"));
    const shouldUpdateTitle =
      titleOverride !== undefined &&
      (task.title !== titleOverride || task.titleOverridden !== true);
    const shouldUpdateCronAutomationId =
      cronAutomationId !== undefined && cronAutomationId !== task.cronAutomationId;
    if (
      !shouldUpdateUnread &&
      !shouldUpdateStatus &&
      !shouldUpdateTitle &&
      !shouldUpdateCronAutomationId
    ) {
      return task;
    }
    return {
      ...task,
      ...(shouldUpdateUnread ? { unreadAt } : {}),
      ...(shouldUpdateStatus ? { status: terminalStatus } : {}),
      ...(shouldUpdateTitle ? { title: titleOverride, titleOverridden: true } : {}),
      // The frozen sessions-index summary does not include cron identity; join it back from tasks-index,
      // or the database will mark it as scheduled while the metadata passed to React still fails isCronTask.
      ...(shouldUpdateCronAutomationId ? { cronAutomationId } : {}),
    };
  });
}

/** Client-side filtering/sorting/pagination, returning { items, total } in the same shape as the old listTaskList. */
export function buildTaskListResult(params: BuildTaskListParams): BuildTaskListResult {
  const query = params.search?.trim().toLocaleLowerCase() ?? "";
  const rows = mergeTaskIndexRowsWithSessions({
    taskIndexItems: params.taskIndexItems,
    sessions: params.sessions,
  });
  const tasks = joinTaskListMembershipMeta(rows, {
    unreadAtByTaskId: params.unreadAtByTaskId,
    terminalStatusByTaskId: params.terminalStatusByTaskId,
    titleOverrideByTaskId: params.titleOverrideByTaskId,
    cronAutomationIdByTaskId: params.cronAutomationIdByTaskId,
  });
  const filtered = tasks.filter((task) => {
    // The CLI session store does not physically clean up when an item is permanently removed from the archived list; apply
    // deleted negative membership first, or a cold-start sessions-index will resurrect it as a regular non-archived task.
    if (params.deletedIds?.has(task.taskId)) return false;
    const pinned = params.pinnedIds.has(task.taskId);
    const archived = params.archivedIds.has(task.taskId);
    if (!matchesTaskListMembershipKind({ pinned, archived }, params.kind)) return false;
    if (query && !task.title.toLocaleLowerCase().includes(query)) return false;
    return true;
  });
  filtered.sort((a, b) => compareZCodeTaskListItems(a, b, params.sortBy));
  const total = filtered.length;
  const items = params.limit === undefined ? filtered : filtered.slice(0, params.limit);
  return { items, total };
}

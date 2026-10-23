import { isCronTask, isOffPeakTask, type ZCodeTaskMeta } from "@zcode/shared";
import type { WindowHostControllerTaskListItem } from "@zcode/services";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { getPathLeaf } from "@/lib/path.js";
import type {
  SessionManagerEnvironmentFilter,
  SessionManagerSortColumn,
  SessionManagerSortDirection,
  SessionManagerTypeFilter,
} from "./sessionManagerTypes.js";

export type SessionManagerRowTask = WindowHostControllerTaskListItem;

export interface SessionManagerRow {
  task: SessionManagerRowTask;
  taskKey: string;
  workspaceKey: string;
  /** Membership source kind; listTaskList items carry no membership field, so the source query is the truth. */
  archived: boolean;
  pinned: boolean;
  running: boolean;
  offline: boolean;
}

export interface SessionManagerGroup {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  label: string;
  rows: SessionManagerRow[];
  latestUpdatedAt: number;
  activeCount: number;
}

export type FlattenedSessionManagerRow =
  | { kind: "group"; group: SessionManagerGroup }
  | { kind: "row"; row: SessionManagerRow };

export function buildSessionManagerRowKey(
  workspacePath: string,
  taskId: string,
  workspaceIdentity?: string,
): string {
  return `${buildTaskWorkspaceKey(workspacePath, workspaceIdentity)}:${taskId}`;
}

/**
 * Signature of the row keys at the given flat indexes (group rows are skipped). Uses the composite
 * row key: the same task id in two workspaces must change the signature, or memoized PR probe
 * targets keep the previous workspace's rows.
 */
export function buildSessionManagerVisibleRowSignature(
  flatRows: readonly FlattenedSessionManagerRow[],
  indexes: readonly number[],
): string {
  return indexes
    .flatMap((index) => {
      const item = flatRows[index];
      return item?.kind === "row" ? [item.row.taskKey] : [];
    })
    .join("\u0000");
}

/**
 * Merge kind-tagged list results into rows. Membership flags do not ride the wire items,
 * so `archived` comes from the source kind and `pinned` from the pinned-kind key set.
 */
export function buildSessionManagerRows(params: {
  activeItems: readonly SessionManagerRowTask[];
  archivedItems: readonly SessionManagerRowTask[];
  pinnedKeys: ReadonlySet<string>;
}): SessionManagerRow[] {
  const rows: SessionManagerRow[] = [];
  const seen = new Set<string>();
  const push = (task: SessionManagerRowTask, archived: boolean) => {
    const taskKey = buildSessionManagerRowKey(
      task.workspacePath,
      task.taskId,
      task.workspaceIdentity,
    );
    if (seen.has(taskKey)) {
      return;
    }
    seen.add(taskKey);
    rows.push({
      task,
      taskKey,
      workspaceKey: buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity),
      archived,
      pinned: !archived && params.pinnedKeys.has(taskKey),
      running: task.liveStatus === "running" || task.liveStatus === "waiting",
      offline: task.sourceAvailability === "offline",
    });
  };
  for (const task of params.activeItems) {
    push(task, false);
  }
  for (const task of params.archivedItems) {
    push(task, true);
  }
  return rows;
}

/** Client-side filters (environment/type/pinned); status narrowing happens through the list kinds. */
export function applySessionManagerClientFilters(
  rows: readonly SessionManagerRow[],
  filters: {
    environment: SessionManagerEnvironmentFilter;
    type: SessionManagerTypeFilter;
    pinnedOnly: boolean;
  },
): SessionManagerRow[] {
  return rows.filter((row) => {
    if (filters.environment === "worktree" && !row.task.executionWorktree) {
      return false;
    }
    if (filters.environment === "local" && row.task.executionWorktree) {
      return false;
    }
    if (filters.type !== "all") {
      const taskType = sessionManagerTaskType(row.task);
      if (taskType !== filters.type) {
        return false;
      }
    }
    if (filters.pinnedOnly && !row.pinned) {
      return false;
    }
    return true;
  });
}

export type SessionManagerTaskType = "session" | "cron" | "offpeak";

export function sessionManagerTaskType(task: ZCodeTaskMeta): SessionManagerTaskType {
  if (isCronTask(task)) {
    return "cron";
  }
  if (isOffPeakTask(task)) {
    return "offpeak";
  }
  return "session";
}

export function sortSessionManagerRows(
  rows: readonly SessionManagerRow[],
  sort: { column: SessionManagerSortColumn; direction: SessionManagerSortDirection },
): SessionManagerRow[] {
  const directionFactor = sort.direction === "asc" ? 1 : -1;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const sorted = [...rows].sort((left, right) => {
    let comparison: number;
    switch (sort.column) {
      case "created":
        comparison = left.task.createdAt - right.task.createdAt;
        break;
      case "name":
        comparison = collator.compare(left.task.title, right.task.title);
        break;
      case "updated":
      default:
        comparison = left.task.updatedAt - right.task.updatedAt;
        break;
    }
    if (comparison === 0) {
      // Stable tiebreak keeps reshuffles out of the virtualizer when timestamps collide.
      comparison = left.taskKey.localeCompare(right.taskKey);
    }
    return comparison * directionFactor;
  });
  return sorted;
}

/** Group by workspace identity key (identity-first, path fallback — the uniform repo rule). */
export function groupSessionManagerRows(rows: readonly SessionManagerRow[]): SessionManagerGroup[] {
  const groups = new Map<string, SessionManagerGroup>();
  for (const row of rows) {
    let group = groups.get(row.workspaceKey);
    if (!group) {
      group = {
        workspaceKey: row.workspaceKey,
        workspacePath: row.task.workspacePath,
        ...(row.task.workspaceIdentity ? { workspaceIdentity: row.task.workspaceIdentity } : {}),
        label: getPathLeaf(row.task.workspacePath) || row.task.workspacePath,
        rows: [],
        latestUpdatedAt: row.task.updatedAt,
        activeCount: 0,
      };
      groups.set(row.workspaceKey, group);
    }
    group.rows.push(row);
    group.latestUpdatedAt = Math.max(group.latestUpdatedAt, row.task.updatedAt);
    if (!row.archived) {
      group.activeCount += 1;
    }
  }
  // Groups ordered by their most recent row activity, newest first.
  return Array.from(groups.values()).sort(
    (left, right) => right.latestUpdatedAt - left.latestUpdatedAt,
  );
}

/** Flatten groups into the virtualizer model, replacing collapsed groups' rows with nothing (the header stays). */
export function flattenSessionManagerGroups(
  groups: readonly SessionManagerGroup[],
  collapsedWorkspaceKeys: ReadonlySet<string>,
): FlattenedSessionManagerRow[] {
  const flat: FlattenedSessionManagerRow[] = [];
  for (const group of groups) {
    flat.push({ kind: "group", group });
    if (!collapsedWorkspaceKeys.has(group.workspaceKey)) {
      for (const row of group.rows) {
        flat.push({ kind: "row", row });
      }
    }
  }
  return flat;
}

export interface SessionManagerDeleteCandidates {
  /** Rows the confirm button would delete under the current include-pinned choice. */
  deletable: SessionManagerRow[];
  /** Pinned rows in the selection; deleted only with the explicit opt-in. */
  pinned: SessionManagerRow[];
  archived: SessionManagerRow[];
  active: SessionManagerRow[];
}

/** Pinned-exclusion arithmetic for the delete dialog (Copilot BulkDeleteSessionsDialog parity). */
export function computeSessionManagerDeleteCandidates(
  selectedRows: readonly SessionManagerRow[],
  includePinned: boolean,
): SessionManagerDeleteCandidates {
  const pinned = selectedRows.filter((row) => row.pinned);
  const deletable = includePinned ? [...selectedRows] : selectedRows.filter((row) => !row.pinned);
  return {
    deletable,
    pinned,
    archived: deletable.filter((row) => row.archived),
    active: deletable.filter((row) => !row.archived),
  };
}

/**
 * `meta.model` is the raw `providerId/modelName` selection; the table shows only the model name and
 * keeps the full value in the tooltip. Values without a usable name segment render unchanged.
 */
export function formatSessionManagerModelLabel(model: string | undefined): string | null {
  const trimmed = model?.trim();
  if (!trimmed) {
    return null;
  }
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return name.length > 0 ? name : trimmed;
}

import type { WorkspacePurpose, ZCodeTaskMeta } from "@zcode/shared";

export type ZCodeTaskListKind = "pinned" | "archived" | "timeline" | "active";
export type ZCodeTaskListSortBy = "created" | "updated";

export interface ZCodeTaskListWorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
}

export interface ZCodeTaskListQuery {
  kind: ZCodeTaskListKind;
  workspaceScopes: ZCodeTaskListWorkspaceScope[];
  sortBy: ZCodeTaskListSortBy;
  search?: string;
  limit?: number;
}

export type ZCodeTaskListItem = ZCodeTaskMeta & {
  searchSnippet?: string;
  searchSnippets?: string[];
};

export interface ZCodeTaskListResult {
  items: ZCodeTaskListItem[];
  total: number;
  hasMore: boolean;
}

export type ZCodeTaskGroupColor =
  | "gray"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple";

export interface ZCodeTaskGroup {
  id: string;
  title: string;
  color: ZCodeTaskGroupColor;
  createdAt: number;
  updatedAt: number;
}

export interface ZCodeGroupedTaskRef {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}

export type ZCodeGroupedTaskViewTopLevelNodeRef =
  | { type: "group"; groupId: string }
  | { type: "task"; task: ZCodeGroupedTaskRef };

export type ZCodeGroupedTaskViewNode =
  | {
      type: "group";
      group: ZCodeTaskGroup;
      tasks: ZCodeTaskListItem[];
      sortOrder?: number;
    }
  | {
      type: "task";
      task: ZCodeTaskListItem;
      sortOrder?: number;
    };

export interface ZCodeGroupedTaskView {
  nodes: ZCodeGroupedTaskViewNode[];
}

export interface ZCodeGroupedTaskViewQuery {
  workspaceScopes: ZCodeTaskListWorkspaceScope[];
  includeAllWorkspaces?: boolean;
}

// ── Raw grouped structure (does not join the tasks table) ──
// After the grouped view's task data source moved to sessions-index, the server provides only the group structure
// (task_groups / task_group_members / task_group_view_node_orders),
// which the client joins with sessions-index sessions.

/** Group member reference (does not include task metadata; task content comes from sessions-index). */
export interface ZCodeGroupedTaskViewStructureMember {
  groupId: string;
  /** Server-side workspaceKey (resolveWorkspaceKey: identity ?? path), used as the join key. */
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  /** null = sort_order has not been persisted yet (newly added to the group); the client assigns in-memory order by addedAt descending. */
  sortOrder: number | null;
  addedAt: number;
}

/** Top-level node ordering (task_group_view_node_orders, with node_key parsed into a structured reference). */
export type ZCodeGroupedTaskViewStructureTopOrder =
  | { type: "group"; groupId: string; sortOrder: number }
  | { type: "task"; workspaceKey: string; taskId: string; sortOrder: number };

export interface ZCodeGroupedTaskViewStructure {
  /** Groups filtered by workspaceScopes visibility (a bootstrap workspace group is visible only in its workspace). */
  groups: ZCodeTaskGroup[];
  /** All group members, including members of invisible groups; top-level exclusion rules require the complete set. */
  members: ZCodeGroupedTaskViewStructureMember[];
  topLevelOrders: ZCodeGroupedTaskViewStructureTopOrder[];
}

export interface ZCodeGroupedTaskViewOrderInput {
  workspaceScopes: ZCodeTaskListWorkspaceScope[];
  topLevelNodes: ZCodeGroupedTaskViewTopLevelNodeRef[];
  groups: Array<{
    groupId: string;
    taskRefs: ZCodeGroupedTaskRef[];
  }>;
}

export interface ZCodeWorkspaceEventSubscriptionParams {
  workspacePath: string;
  workspaceIdentity?: string;
}

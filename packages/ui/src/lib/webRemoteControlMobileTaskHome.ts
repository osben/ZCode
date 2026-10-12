import type {
  WebRemoteControlTaskDisplayStatus,
  WebRemoteControlTaskTarget,
  WebRemoteControlWorkspaceListResult,
} from "@zcode/shared";
import { resolveWebRemoteControlWorkspaceKey } from "@zcode/shared";
import {
  groupWebRemoteControlTasksByWorkspace,
  sortWebRemoteControlTasksByTime,
  type WebRemoteControlWorkspaceTaskGroup,
} from "@/lib/webRemoteControlTaskIndex.js";

export const EMPTY_WEB_REMOTE_CONTROL_WORKSPACE_LIST: WebRemoteControlWorkspaceListResult = {
  workspaces: [],
  tasks: [],
};

interface WebRemoteControlMobileTaskHomeModel {
  activeTaskId: string | null;
  activeWorkspaceKey: string;
  defaultExpandedWorkspaceKeys: Set<string>;
  pinnedTasks: WebRemoteControlTaskTarget[];
  timelineTasks: WebRemoteControlTaskTarget[];
  groups: WebRemoteControlWorkspaceTaskGroup[];
  totalTaskCount: number;
  totalWorkspaceCount: number;
}

export type WebRemoteControlMobileTaskSortBy = "created" | "updated";
export type WebRemoteControlMobileTaskOrganizeBy = "workspace" | "timeline";

export type WebRemoteControlMobileTaskHomePreferences = {
  organizeBy: WebRemoteControlMobileTaskOrganizeBy;
  sortBy: WebRemoteControlMobileTaskSortBy;
};

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

const WEB_REMOTE_CONTROL_MOBILE_TASK_HOME_PREFERENCES_STORAGE_KEY =
  "zcode-web-remote-control-mobile-task-home-preferences";

const DEFAULT_WEB_REMOTE_CONTROL_MOBILE_TASK_HOME_PREFERENCES: WebRemoteControlMobileTaskHomePreferences =
  {
    organizeBy: "workspace",
    sortBy: "updated",
  };

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isWebRemoteControlMobileTaskHomePreferences(
  value: unknown,
): value is WebRemoteControlMobileTaskHomePreferences {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<WebRemoteControlMobileTaskHomePreferences>;
  return (
    (candidate.organizeBy === "workspace" || candidate.organizeBy === "timeline") &&
    (candidate.sortBy === "created" || candidate.sortBy === "updated")
  );
}

export function readWebRemoteControlMobileTaskHomePreferences(
  storage: StorageLike | null = getBrowserStorage(),
): WebRemoteControlMobileTaskHomePreferences {
  try {
    const raw = storage?.getItem(WEB_REMOTE_CONTROL_MOBILE_TASK_HOME_PREFERENCES_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_WEB_REMOTE_CONTROL_MOBILE_TASK_HOME_PREFERENCES;
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!isWebRemoteControlMobileTaskHomePreferences(parsed)) {
      return DEFAULT_WEB_REMOTE_CONTROL_MOBILE_TASK_HOME_PREFERENCES;
    }

    return parsed;
  } catch {
    return DEFAULT_WEB_REMOTE_CONTROL_MOBILE_TASK_HOME_PREFERENCES;
  }
}

export function persistWebRemoteControlMobileTaskHomePreferences(
  preferences: WebRemoteControlMobileTaskHomePreferences,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  try {
    storage?.setItem(
      WEB_REMOTE_CONTROL_MOBILE_TASK_HOME_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences),
    );
  } catch {
    // localStorage may be unwritable in private mode or under capacity errors; ignore the failure
    // so the remote-control main flow is not blocked.
  }
}

export function buildWebRemoteControlMobileTaskHomeModel({
  activeTaskId,
  activeWorkspaceIdentity,
  activeWorkspacePath,
  sortBy = "updated",
  result,
}: {
  activeTaskId: string | null;
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  sortBy?: WebRemoteControlMobileTaskSortBy;
  result: WebRemoteControlWorkspaceListResult;
}): WebRemoteControlMobileTaskHomeModel {
  const fallbackWorkspaceKey = resolveWebRemoteControlWorkspaceKey({
    workspacePath: activeWorkspacePath,
    workspaceIdentity: activeWorkspaceIdentity,
  });
  const resolvedActiveWorkspaceKey = result.activeWorkspaceKey ?? fallbackWorkspaceKey;
  const resolvedActiveTaskId = result.activeTaskId ?? activeTaskId;
  // Bugfix: the remote-control task home previously handed all tasks to workspace/timeline
  // grouping. Pinned tasks now come from a separate sqlite query, so the pinned section must be
  // split out first to keep them from reappearing in the regular list.
  const allTasks = (result.tasks ?? []).filter((task) => !task.archived);
  const pinnedTasks = sortWebRemoteControlTasksByTime(
    allTasks.filter((task) => task.pinned),
    sortBy,
  );
  const regularTasks = allTasks.filter((task) => !task.pinned);
  const groups = groupWebRemoteControlTasksByWorkspace({
    workspaces: result.workspaces,
    tasks: regularTasks,
  });
  const hasActiveWorkspace = groups.some(
    (group) => group.workspaceKey === resolvedActiveWorkspaceKey,
  );

  return {
    activeTaskId: resolvedActiveTaskId ?? null,
    activeWorkspaceKey: resolvedActiveWorkspaceKey,
    defaultExpandedWorkspaceKeys: new Set(hasActiveWorkspace ? [resolvedActiveWorkspaceKey] : []),
    pinnedTasks,
    timelineTasks: sortWebRemoteControlTasksByTime(regularTasks, sortBy),
    groups,
    totalTaskCount: allTasks.length,
    totalWorkspaceCount: groups.length,
  };
}

export function hasWebRemoteControlMobileTaskHomeActiveTaskMatch(
  model: Pick<
    WebRemoteControlMobileTaskHomeModel,
    "activeTaskId" | "activeWorkspaceKey" | "groups" | "pinnedTasks"
  >,
): boolean {
  if (!model.activeTaskId) {
    return true;
  }

  // Bugfix: pinned tasks are split into their own section and no longer appear in
  // workspace group.tasks. The initial selection check must also look at the pinned section,
  // otherwise a legitimate active pinned task is wrongly recorded as unmatched.
  return (
    model.pinnedTasks.some(
      (task) =>
        task.taskId === model.activeTaskId &&
        resolveWebRemoteControlWorkspaceKey(task) === model.activeWorkspaceKey,
    ) ||
    model.groups.some(
      (group) =>
        group.workspaceKey === model.activeWorkspaceKey &&
        group.tasks.some((task) => task.taskId === model.activeTaskId),
    )
  );
}

export function getWebRemoteControlTaskStatusClassName(status: WebRemoteControlTaskDisplayStatus) {
  switch (status) {
    case "running":
      return "border-brand/40 bg-accent text-foreground";
    case "completed":
      return "border-success/40 bg-success text-success-foreground";
    case "error":
      return "border-destructive/40 bg-destructive text-destructive-foreground";
    case "idle":
      return "border-border bg-surface text-foreground-subtle";
  }
}

export function getWorkspaceLatestUpdatedAt(
  tasks: readonly WebRemoteControlTaskTarget[],
): number | null {
  if (tasks.length === 0) {
    return null;
  }

  return Math.max(...tasks.map((task) => task.updatedAt));
}

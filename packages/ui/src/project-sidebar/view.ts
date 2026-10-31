import {
  buildRemoteHostWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
} from "@/project-sidebar/contract.js";
import type {
  ProjectTask,
  ProjectTree,
  VirtualProject,
  RemoteProjectDirectory,
  RemoteProjectEntry,
  ProjectAvailability,
  WindowHostTaskAddress,
  WindowHostControllerTaskActivity,
} from "@/project-sidebar/contract.js";
import type { TaskChildSessionFacts } from "@/v4/windowControllerTaskListRegistry.js";
import type { ConfirmDialogRequest } from "@/store/confirmDialogStore.js";
import { attachTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { compareTaskListItemsByTime, compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";
import { LEGACY_SINGLE_ROOT_PROJECT_PREFIX } from "@/project-sidebar/contract.js";
import {
  areStabilizedValuesEquivalent,
  stabilizeTaskListItems,
} from "@/v4/taskListItemStabilization.js";

/**
 * Activity only overlays a UI sidecar on existing rows; a Controller snapshot cannot replace the project tree's row set and facts.
 * Child-conversation facts ride the same overlay: the task index never stores them, so dropping
 * them here hid the sidebar child marker in every view (spec sidebar-child-conversation-counts §7).
 */
export function applyProjectTaskOverlays(
  tree: ProjectTree,
  overlays: readonly {
    address: WindowHostTaskAddress;
    activity?: WindowHostControllerTaskActivity;
    childFacts?: TaskChildSessionFacts;
  }[],
): ProjectTree {
  const byKey = new Map(overlays.map((overlay) => [buildTaskEntityKey(overlay.address), overlay]));
  return {
    ...tree,
    tasks: tree.tasks.map((task) => {
      const overlay = byKey.get(buildTaskEntityKey(task));
      if (!overlay) return task;
      const withFacts = overlay.childFacts ? { ...task, ...overlay.childFacts } : task;
      return overlay.activity ? attachTaskListRowActivity(withFacts, overlay.activity) : withFacts;
    }),
  };
}

/** Reuses equivalent objects to preserve row memoization; both reorganization and activity take part in comparison, so old project membership never sticks to a row. */
export function stabilizeProjectTree(previous: ProjectTree, next: ProjectTree): ProjectTree {
  const previousProjects = new Map(
    previous.projects.map((project) => [projectKey(project), project]),
  );
  let sameProjects = previous.projects.length === next.projects.length;
  const projects = next.projects.map((project, index) => {
    const old = previousProjects.get(projectKey(project));
    const stable = old && areStabilizedValuesEquivalent(old, project) ? old : project;
    if (previous.projects[index] !== stable) sameProjects = false;
    return stable;
  });
  const tasks = stabilizeTaskListItems(previous.tasks, next.tasks);
  return sameProjects &&
    tasks === previous.tasks &&
    areStabilizedValuesEquivalent(previous.deletedTasks, next.deletedTasks)
    ? previous
    : { ...next, projects: sameProjects ? previous.projects : projects, tasks };
}

export type ProjectRowSelection =
  | { kind: "project"; projectId: string | null; hostId?: string }
  | { kind: "timeline" }
  | { kind: "unread" }
  | { kind: "pinned" };

/** Selector and row list share one comparator so the timeline is not re-overridden by run priority at render time. */
export function compareProjectTaskRows(
  left: ProjectTask,
  right: ProjectTask,
  kind: ProjectRowSelection["kind"],
): number {
  return (
    (kind === "timeline" || kind === "unread"
      ? compareTaskListItemsByTime(left, right, "updated")
      : compareZCodeTaskListItems(left, right, "updated")) ||
    JSON.stringify([right.hostId, buildTaskEntityKey(right)]).localeCompare(
      JSON.stringify([left.hostId, buildTaskEntityKey(left)]),
    )
  );
}
/** Display derives only from Host-committed rows; an identical cwd does not mean the same project. */
export function selectProjectRows(
  tree: ProjectTree,
  selection: ProjectRowSelection,
): ProjectTask[] {
  if (selection.kind === "unread")
    return selectUnreadProjectRows(tree).sort((left, right) =>
      compareProjectTaskRows(left, right, selection.kind),
    );
  return tree.tasks
    .filter((task) => {
      if (selection.kind === "pinned") return task.pinned && !task.archived;
      if (selection.kind === "timeline") return !task.archived;
      return (
        task.projectId === selection.projectId &&
        (!selection.hostId || task.hostId === selection.hostId) &&
        !task.archived &&
        !task.pinned
      );
    })
    .sort((left, right) => compareProjectTaskRows(left, right, selection.kind));
}

export function projectHasUnread(
  tree: ProjectTree,
  project: Pick<VirtualProject, "id" | "hostId">,
): boolean {
  // Pinning only changes display position, not project membership; do not aggregate from visible rows that truncate/exclude pinned ones.
  return tree.tasks.some(
    (task) =>
      task.projectId === project.id &&
      task.hostId === project.hostId &&
      !task.archived &&
      Boolean(task.unreadAt),
  );
}

/**
 * Total unread count for the taskbar/tray badge: same source as the sidebar blue dot (the
 * authoritative host readTree), same filter as projectHasUnread (not archived + has unreadAt),
 * deduplicated by host+workspace+task.
 * Do not switch to the renderer's taskListCache/taskQueryCache: they only hold the active
 * workspace's lists, both caches are empty when a background workspace has a blue dot, and the badge would lose counts.
 */
export function countProjectTreeUnreadTasks(tree: ProjectTree): number {
  return selectUnreadProjectRows(tree).length;
}

/** Filtering and the badge share one set, so the unread list never shows historical orphan tasks with no matching badge count. */
function selectUnreadProjectRows(tree: ProjectTree): ProjectTask[] {
  // Count only projects the sidebar actually renders (not soft-deleted): unread on orphan tasks
  // (project missing) and on deleted projects has no blue-dot anchor in the UI; counting them
  // only produces ghost "badge without dot" reminders.
  const renderedProjectKeys = new Set(
    tree.projects
      .filter((project) => !project.deleted)
      .map((project) => `${project.hostId}::${project.id}`),
  );
  const seen = new Set<string>();
  const rows: ProjectTask[] = [];
  for (const task of tree.tasks) {
    if (task.archived || !task.unreadAt) {
      continue;
    }

    // Visibility aligns with render sections: the pinned section renders across projects; the
    // local no-project section renders only host=local null-project tasks; all other tasks must
    // belong to a rendered project.
    const visible =
      task.pinned ||
      (task.projectId == null && task.hostId === "local") ||
      renderedProjectKeys.has(`${task.hostId}::${task.projectId}`);
    if (!visible) {
      continue;
    }

    const key = JSON.stringify([
      task.hostId,
      task.workspaceIdentity?.trim() || task.workspacePath,
      task.taskId,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(task);
  }

  return rows;
}

export function projectKey(project: Pick<VirtualProject, "id" | "hostId">): string {
  return JSON.stringify([project.hostId, project.id]);
}

export function resolveEntryProject(
  entry: RemoteProjectEntry,
  tree: ProjectTree,
): VirtualProject | undefined {
  const exact = tree.projects.find(
    (project) => project.hostId === entry.hostId && project.id === entry.projectId,
  );
  if (exact) return exact;
  const legacyRoot =
    entry.projectId?.startsWith(LEGACY_SINGLE_ROOT_PROJECT_PREFIX) && entry.roots.length === 1
      ? entry.roots[0]!.rootPath
      : entry.projectId
        ? undefined
        : entry.legacyWorkspace?.workspacePath;
  const candidates = tree.projects.filter(
    (project) =>
      project.hostId === entry.hostId &&
      !project.deleted &&
      legacyRoot !== undefined &&
      project.roots.some((root) => root.rootPath === legacyRoot),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** The aggregate is a display projection, not a copy of remote facts; offline only the local entry base cache remains. */
export function mergeProjectTrees(
  local: ProjectTree,
  directory: RemoteProjectDirectory,
  remote: ReadonlyMap<string, ProjectTree>,
): {
  tree: ProjectTree;
  availability: Map<string, ProjectAvailability>;
} {
  const projects = [...local.projects];
  const tasks = [...local.tasks];
  // Local deletion facts carry hostId "local" (see LOCAL_TASK_HOST_ID in deletedTaskFacts.ts); the remote rows below are filtered by host id.
  const deletedTasks = [...(local.deletedTasks ?? [])];
  const availability = new Map(
    local.projects.map((project) => [projectKey(project), { online: true } as ProjectAvailability]),
  );
  const retainedHosts = new Set(directory.hosts.map((host) => host.id));
  for (const entry of directory.entries) {
    if (!retainedHosts.has(entry.hostId)) continue;
    const tree = remote.get(entry.hostId);
    const resolved = tree && resolveEntryProject(entry, tree);
    const source: VirtualProject = resolved ?? {
      id: entry.projectId ?? `legacy:${entry.id}`,
      hostId: entry.hostId,
      name: entry.name,
      roots: entry.roots,
      pinned: false,
      // Bug cause: cached rows once hard-coded not-deleted, so projects deleted online reappeared offline or on remote read failure; now reads the deletion-state cache written by refresh.
      deleted: entry.deleted === true,
      nameOverridden: false,
      position: projects.length,
      createdAt: 0,
      updatedAt: 0,
    };
    const project =
      entry.initialPosition == null ? source : { ...source, position: entry.initialPosition };
    const key = projectKey(project);
    if (!availability.has(key)) projects.push(project);
    availability.set(key, {
      entryId: entry.id,
      ...(entry.initialPosition == null ? {} : { upgradeEntryId: entry.id }),
      online: Boolean(resolved),
      ...(!resolved && tree ? { unresolved: true } : {}),
    });
  }
  for (const [hostId, tree] of remote) {
    if (!retainedHosts.has(hostId)) continue;
    deletedTasks.push(...(tree.deletedTasks ?? []).filter((task) => task.hostId === hostId));
    for (const task of tree.tasks) {
      if (task.hostId !== hostId) continue;
      if (
        task.projectId == null ||
        availability.get(projectKey({ hostId, id: task.projectId }))?.online
      )
        tasks.push(task);
    }
  }
  return {
    tree: { projects, tasks, ...(deletedTasks.length ? { deletedTasks } : {}) },
    availability,
  };
}

/** Host position is only the seed for first-time controller initialization; the actual display order is overridden by sidebar preference. */
export function selectSortedProjects(tree: ProjectTree): VirtualProject[] {
  return tree.projects
    .filter((project) => !project.deleted)
    .sort((a, b) => a.position - b.position);
}

export function projectSourceServerId(project: VirtualProject): string | undefined {
  return project.hostId === "local"
    ? undefined
    : parseRemoteWorkspaceIdentity(
        buildRemoteHostWorkspaceIdentity(project.hostId, project.roots[0]?.rootPath ?? "/"),
      )?.sourceServerId;
}

/** Internal error codes are for decisions only; the display boundary translates known states and keeps diagnostic info for unknown service errors. */
export function formatProjectError(
  cause: unknown,
  formatMessage: (descriptor: { id: string }) => string,
): string {
  const code = cause instanceof Error ? cause.message : String(cause);
  if (code === "remote-project.host-removed") return formatMessage({ id: "project.hostRemoved" });
  if (code === "project.connection-unavailable")
    return formatMessage({ id: "project.connectionUnavailable" });
  if (code === "project.undo-unavailable") return formatMessage({ id: "project.undoUnavailable" });
  if (code === "project.data-session-running")
    return formatMessage({ id: "project.dataSessionRunning" });
  if (code === "project.data-session-referenced")
    return formatMessage({ id: "project.dataSessionReferenced" });
  if (code === "project.data-delete-failed")
    return formatMessage({ id: "project.dataDeleteFailed" });
  if (code === "project.data-unavailable") return formatMessage({ id: "project.dataUnavailable" });
  return String(cause);
}

/**
 * Confirmation for deleting a project. Both delete entries (row menu and editor) use this one
 * request so the copy and the destructive variant cannot drift. Deleting a project keeps its
 * tasks, so the description says so instead of warning about task loss.
 */
export function projectDeleteConfirmRequest(
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string,
  projectName: string,
): ConfirmDialogRequest {
  return {
    title: formatMessage({ id: "project.deleteConfirmTitle" }, { name: projectName }),
    description: formatMessage({ id: "project.deleteConfirmDescription" }),
    confirmLabel: formatMessage({ id: "project.deleteConfirmAction" }),
    cancelLabel: formatMessage({ id: "project.cancel" }),
    confirmVariant: "destructive",
    testId: "project-delete-confirm",
  };
}

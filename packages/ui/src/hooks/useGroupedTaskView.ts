/* eslint-disable max-lines -- The grouped-view hook owns the optimistic overlay, saved ordering, and persisted ungrouping; splitting it would make the same view state drift across hooks. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type {
  ZCodeGroupedTaskView,
  ZCodeGroupedTaskViewOrderInput,
  ZCodeGroupedTaskViewStructure,
  ZCodeGroupedTaskViewTopLevelNodeRef,
  ZCodeTaskGroup,
  ZCodeTaskGroupColor,
} from "@zcode/services";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useLocalWorkspaceScopes } from "@/hooks/useLocalWorkspaceScopes.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { logger } from "@/logger.js";
import { buildGroupedTaskViewFromSessions } from "@/lib/buildGroupedTaskViewFromSessions.js";
import { mergeTaskListMembershipFields } from "@/v4/taskListRowActivity.js";
import { fetchTaskListMembershipSets } from "@/lib/taskListMembershipSets.js";
import { useTaskListMembershipVersion } from "@/v4/taskListMembershipVersion.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { buildTaskEntityKey, buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { mergeTaskWithOptimisticMeta } from "@/lib/zcodeTaskMetaMerge.js";
import {
  useWorkspaceTaskOptimisticOverlayByWorkspaceKey,
  type WorkspaceOptimisticTaskOverlay,
} from "@/hooks/workspaceTaskListOptimisticOverlay.js";
import { moveTaskToGroupStart } from "@/workspace-grouped-tasks/view.js";
import { areStabilizedValuesEquivalent } from "@/v4/taskListItemStabilization.js";
import { taskKey as groupedTaskKey } from "@/workspace-grouped-tasks/ids.js";

function applyPromotedGroupPlacements(
  view: ZCodeGroupedTaskView,
  promotedDraftByTaskKey: ReadonlyMap<
    string,
    WorkspaceOptimisticTaskOverlay["promotedGroupedDraftTaskByTaskId"][string]
  >,
  optimisticTaskByKey: ReadonlyMap<string, ZCodeTaskMeta>,
): ZCodeGroupedTaskView {
  let nextView = view;
  for (const [taskKey, promotedDraft] of promotedDraftByTaskKey) {
    if (promotedDraft.placement.type === "top") {
      const rootIndex = nextView.nodes.findIndex(
        (node) => node.type === "task" && buildTaskEntityKey(node.task) === taskKey,
      );
      if (rootIndex <= 0) continue;
      // When sessions-index and grouped structure arrive asynchronously, tasks without order are temporarily appended to the end.
      // Before promotion settles, keep the draft’s root position at the top so the same row does not move to the bottom and then back to the top.
      const nodes = [...nextView.nodes];
      const [rootTask] = nodes.splice(rootIndex, 1);
      if (rootTask) nodes.unshift(rootTask);
      nextView = { nodes };
      continue;
    }
    const task = optimisticTaskByKey.get(taskKey);
    if (!task) {
      continue;
    }
    if (isTaskFirstInGroup(nextView, taskKey, promotedDraft.placement.groupId)) {
      continue;
    }
    nextView = moveTaskToGroupStart(nextView, {
      activeTaskKey: groupedTaskKey(task),
      groupId: promotedDraft.placement.groupId,
    });
  }
  return nextView;
}

function findTaskInGroupedView(
  view: ZCodeGroupedTaskView,
  taskEntityKey: string,
): ZCodeTaskMeta | undefined {
  for (const node of view.nodes) {
    if (node.type === "group") {
      const task = node.tasks.find((candidate) => buildTaskEntityKey(candidate) === taskEntityKey);
      if (task) return task;
      continue;
    }
    if (buildTaskEntityKey(node.task) === taskEntityKey) return node.task;
  }
  return undefined;
}

function isTaskFirstInGroup(
  view: ZCodeGroupedTaskView,
  taskEntityKey: string,
  groupId: string,
): boolean {
  const group = view.nodes.find((node) => node.type === "group" && node.group.id === groupId);
  return Boolean(
    group?.type === "group" &&
    group.tasks[0] &&
    buildTaskEntityKey(group.tasks[0]) === taskEntityKey,
  );
}

function buildWorkspaceScopes(workspaceTabs: WorkspaceTabState[]) {
  return workspaceTabs.map((tab) => ({
    workspacePath: tab.workspacePath,
    workspaceIdentity: tab.workspaceIdentity,
    workspacePurpose: tab.workspacePurpose,
  }));
}

function collectViewWorkspaceScopes(
  view: ZCodeGroupedTaskView,
): Array<{ workspacePath: string; workspaceIdentity?: string }> {
  const workspaceScopes = new Map<string, { workspacePath: string; workspaceIdentity?: string }>();
  const addTask = (task: ZCodeTaskMeta) => {
    const workspaceKey = buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity);
    workspaceScopes.set(workspaceKey, {
      workspacePath: task.workspacePath,
      workspaceIdentity: task.workspaceIdentity,
    });
  };

  for (const node of view.nodes) {
    if (node.type === "group") {
      node.tasks.forEach(addTask);
      continue;
    }
    addTask(node.task);
  }

  return [...workspaceScopes.values()];
}

function mergeGroupedTaskViewWithOptimistic(params: {
  view: ZCodeGroupedTaskView;
  optimisticOverlays: Iterable<WorkspaceOptimisticTaskOverlay>;
  visibleMissingTaskKeys: ReadonlySet<string>;
}): ZCodeGroupedTaskView {
  const optimisticTaskByKey = new Map<string, ZCodeTaskMeta>();
  const placementTaskByKey = new Map<string, ZCodeTaskMeta>();
  const promotedDraftByTaskKey = new Map<
    string,
    WorkspaceOptimisticTaskOverlay["promotedGroupedDraftTaskByTaskId"][string]
  >();

  for (const node of params.view.nodes) {
    if (node.type === "group") {
      for (const task of node.tasks) placementTaskByKey.set(buildTaskEntityKey(task), task);
      continue;
    }
    placementTaskByKey.set(buildTaskEntityKey(node.task), node.task);
  }

  for (const overlay of params.optimisticOverlays) {
    for (const task of overlay.tasks) {
      const taskKey = buildTaskEntityKey(task);
      optimisticTaskByKey.set(taskKey, task);
      placementTaskByKey.set(taskKey, task);
      // The optimistic overlay is a runtime object shared across hooks, and older tests/callers may not yet provide
      // promotedGroupedDraftTaskByTaskId. Use an empty object for the missing field so grouped merging does not crash
      // when draft position data is absent; by default, add it at the top like a regular optimistic task.
    }
    for (const [taskId, promotedDraft] of Object.entries(
      overlay.promotedGroupedDraftTaskByTaskId ?? {},
    )) {
      promotedDraftByTaskKey.set(
        buildTaskEntityKey({
          taskId,
          workspacePath: promotedDraft.workspacePath,
          workspaceIdentity: promotedDraft.workspaceIdentity,
        }),
        promotedDraft,
      );
    }
  }

  if (optimisticTaskByKey.size === 0 && promotedDraftByTaskKey.size === 0) {
    return params.view;
  }

  const visibleTaskKeys = new Set<string>();
  let changed = false;
  const nodes = params.view.nodes.map((node) => {
    if (node.type === "group") {
      let tasksChanged = false;
      const tasks = node.tasks.map((task) => {
        const taskKey = buildTaskEntityKey(task);
        visibleTaskKeys.add(taskKey);
        const optimisticTask = optimisticTaskByKey.get(taskKey);
        if (!optimisticTask) {
          return task;
        }
        tasksChanged = true;
        // Do not let grouped optimistic metadata replace the entire sessions-index object.
        // Otherwise, even when explicit sort_order has not changed, row timestamps/phase would be polluted by tasks-index timestamps.
        // The minimal overlay for a promoted grouped draft has an empty title; spreading the whole object
        // would keep overwriting the real title later supplied by sessions-index. Merge by task-meta field authority first,
        // then preserve membership/activity fields owned by sessions-index.
        return mergeTaskListMembershipFields(
          task,
          mergeTaskWithOptimisticMeta(task, optimisticTask),
        );
      });
      if (!tasksChanged) {
        return node;
      }
      changed = true;
      return { ...node, tasks };
    }

    const taskKey = buildTaskEntityKey(node.task);
    visibleTaskKeys.add(taskKey);
    const optimisticTask = optimisticTaskByKey.get(taskKey);
    if (!optimisticTask) {
      return node;
    }
    changed = true;
    return {
      ...node,
      task: mergeTaskListMembershipFields(
        node.task,
        mergeTaskWithOptimisticMeta(node.task, optimisticTask),
      ),
    };
  });

  const missingVisibleTasks = [...optimisticTaskByKey.entries()]
    .filter(
      ([taskKey]) => params.visibleMissingTaskKeys.has(taskKey) && !visibleTaskKeys.has(taskKey),
    )
    .map(([, task]) => task)
    .sort((left, right) => {
      if (right.updatedAt !== left.updatedAt) {
        return right.updatedAt - left.updatedAt;
      }
      if (right.createdAt !== left.createdAt) {
        return right.createdAt - left.createdAt;
      }
      return right.taskId.localeCompare(left.taskId);
    });

  if (missingVisibleTasks.length === 0) {
    return applyPromotedGroupPlacements(
      changed ? { nodes } : params.view,
      promotedDraftByTaskKey,
      placementTaskByKey,
    );
  }

  const groupMissingTasksByGroupId = new Map<string, ZCodeTaskMeta[]>();
  const topMissingTasks: ZCodeTaskMeta[] = [];
  for (const task of missingVisibleTasks) {
    const promotedDraft = promotedDraftByTaskKey.get(buildTaskEntityKey(task));
    if (promotedDraft?.placement.type === "group") {
      const groupTasks = groupMissingTasksByGroupId.get(promotedDraft.placement.groupId) ?? [];
      groupTasks.push(task);
      groupMissingTasksByGroupId.set(promotedDraft.placement.groupId, groupTasks);
      continue;
    }
    topMissingTasks.push(task);
  }

  const nodesWithGroupDraftTasks = nodes.map((node) => {
    if (node.type !== "group") {
      return node;
    }
    const groupTasks = groupMissingTasksByGroupId.get(node.group.id);
    if (!groupTasks?.length) {
      return node;
    }
    return { ...node, tasks: [...groupTasks, ...node.tasks] };
  });
  const missingGroupTasksWithoutGroup = [...groupMissingTasksByGroupId.entries()]
    .filter(([, tasks]) => tasks.length > 0)
    .flatMap(([groupId, tasks]) =>
      nodes.some((node) => node.type === "group" && node.group.id === groupId) ? [] : tasks,
    );

  // Grouped view previously showed only SQLite query results. A first-send task was written to the local optimistic
  // cache, but the server’s initial snapshot delayed broadcasting to avoid flashing “New session,” so the grouped list did not see it until restart
  // or the next full refresh. Add only optimistic tasks explicitly marked temporarily visible by the grouped hook,
  // so other local caches such as archived/pinned items are not accidentally inserted into the grouped root. A task promoted from a grouped draft
  // also keeps the temporary entity’s group/top position until saving the SQLite order is complete.
  return applyPromotedGroupPlacements(
    {
      nodes: [
        ...topMissingTasks.concat(missingGroupTasksWithoutGroup).map((task) => ({
          type: "task" as const,
          task,
        })),
        ...nodesWithGroupDraftTasks,
      ],
    },
    promotedDraftByTaskKey,
    placementTaskByKey,
  );
}

function collectGroupedViewTaskKeys(view: ZCodeGroupedTaskView): Set<string> {
  const taskKeys = new Set<string>();
  for (const node of view.nodes) {
    if (node.type === "group") {
      for (const task of node.tasks) {
        taskKeys.add(buildTaskEntityKey(task));
      }
      continue;
    }
    taskKeys.add(buildTaskEntityKey(node.task));
  }
  return taskKeys;
}

export function shouldHideGroupedTaskContent(params: {
  initialized: boolean;
  loading: boolean;
  hasNodes: boolean;
  /**
   * The gate should block only the first screen. Returning to a hidden state after the list has rendered is what makes the user see
   * “the whole grouped view flicker”—ancestor remounts and background refreshes can both reach this code.
   * After the first render, always continue showing the previous list; stale data is better than a blank screen.
   */
  hasPaintedOnce?: boolean;
}): boolean {
  if (params.hasPaintedOnce) {
    return false;
  }
  return !params.initialized || (params.loading && !params.hasNodes);
}

function isGroupedTaskViewInitialized(params: {
  remoteDataInitialized: boolean;
  hydratingEndpointKeys: readonly string[];
  /**
   * This gate is for the first screen only. Previously, it read the current hydrating state directly; each tool result from a running task made the Controller list query again (loading=true), closed the gate, and unmounted/remounted the entire grouped body—
   * causing the sidebar’s grouped list to jump. Once ready, stay ready permanently; background refreshes do not return to the initial loading state.
   */
  previouslyInitialized?: boolean;
}): boolean {
  if (params.previouslyInitialized) {
    return true;
  }
  return params.remoteDataInitialized && params.hydratingEndpointKeys.length === 0;
}

/**
 * Per-key single-flight cache for grouped structure/membership.
 *
 * When switching to grouped view, hook mounting and the first sessions-index frame can refresh concurrently. The old cache kept only
 * completed results, so each cache miss requested every workspace separately, causing an RPC storm and repeated loading generations.
 * Store in-flight Promises too, and use generation/sequence checks to prevent invalidated or stale keys from repopulating the cache.
 */
class GroupedRemoteDataSingleFlight<T> {
  private generation = 0;
  private requestSequence = 0;
  private completed: { key: string; value: T } | null = null;
  private readonly inFlightByKey = new Map<
    string,
    {
      generation: number;
      latestRequestSequence: number;
      promise: Promise<T> | null;
    }
  >();

  load(key: string, fetchValue: () => Promise<T>): Promise<T> {
    const requestSequence = this.requestSequence + 1;
    this.requestSequence = requestSequence;
    if (this.completed?.key === key) {
      return Promise.resolve(this.completed.value);
    }

    const generation = this.generation;
    const existing = this.inFlightByKey.get(key);
    if (existing?.generation === generation && existing.promise) {
      existing.latestRequestSequence = requestSequence;
      return existing.promise;
    }

    const inFlight = {
      generation,
      latestRequestSequence: requestSequence,
      promise: null as Promise<T> | null,
    };
    const promise = Promise.resolve()
      .then(fetchValue)
      .then((value) => {
        if (
          this.generation === generation &&
          this.requestSequence === inFlight.latestRequestSequence
        ) {
          this.completed = { key, value };
        }
        return value;
      })
      .finally(() => {
        if (this.inFlightByKey.get(key)?.promise === promise) {
          this.inFlightByKey.delete(key);
        }
      });
    inFlight.promise = promise;
    this.inFlightByKey.set(key, inFlight);
    return promise;
  }

  isCurrent(key: string, value: T): boolean {
    return this.completed?.key === key && this.completed.value === value;
  }

  invalidate(): void {
    this.generation += 1;
    this.completed = null;
    this.inFlightByKey.clear();
  }
}

function prependTaskGroupToView(
  view: ZCodeGroupedTaskView,
  group: ZCodeTaskGroup,
): ZCodeGroupedTaskView {
  if (view.nodes.some((node) => node.type === "group" && node.group.id === group.id)) {
    return view;
  }
  const minimumSortOrder = view.nodes.reduce(
    (minimum, node) => Math.min(minimum, node.sortOrder ?? 0),
    0,
  );
  return {
    nodes: [
      {
        type: "group",
        group,
        tasks: [],
        sortOrder: minimumSortOrder - 1000,
      },
      ...view.nodes,
    ],
  };
}

function reconcileGroupedOptimisticTaskKeys(params: {
  view: ZCodeGroupedTaskView;
  optimisticOverlays: Iterable<WorkspaceOptimisticTaskOverlay>;
  previousVisibleMissingTaskKeys: ReadonlySet<string>;
}): Set<string> {
  const groupedViewTaskKeys = collectGroupedViewTaskKeys(params.view);
  const optimisticTaskKeys = new Set<string>();
  const nextVisibleMissingTaskKeys = new Set<string>();

  for (const overlay of params.optimisticOverlays) {
    for (const task of overlay.tasks) {
      const taskKey = buildTaskEntityKey(task);
      optimisticTaskKeys.add(taskKey);
      if (overlay.activeTaskId === task.taskId && !groupedViewTaskKeys.has(taskKey)) {
        nextVisibleMissingTaskKeys.add(taskKey);
      }
    }
  }

  for (const taskKey of params.previousVisibleMissingTaskKeys) {
    if (groupedViewTaskKeys.has(taskKey) || !optimisticTaskKeys.has(taskKey)) {
      continue;
    }
    nextVisibleMissingTaskKeys.add(taskKey);
  }

  return nextVisibleMissingTaskKeys;
}

function groupedNodeIdentityKey(node: ZCodeGroupedTaskView["nodes"][number]): string {
  if (node.type === "group") {
    return `group:${node.group.id}`;
  }
  return `task:${buildTaskWorkspaceKey(node.task.workspacePath, node.task.workspaceIdentity)}:${node.task.taskId}`;
}

function areGroupedNodesEquivalent(
  previous: ZCodeGroupedTaskView["nodes"][number],
  next: ZCodeGroupedTaskView["nodes"][number],
): boolean {
  if (previous.type !== next.type || previous.sortOrder !== next.sortOrder) {
    return false;
  }
  if (previous.type === "group" && next.type === "group") {
    // Compare structure instead of using JSON.stringify: key order is not stable when group metadata is rebuilt through IPC/join,
    // so string comparison would always report inequality and silently make node stabilization return new references every frame.
    if (!areStabilizedValuesEquivalent(previous.group, next.group)) {
      return false;
    }
    // Task objects come from the sessions-index aggregation layer (references already stabilized) plus joinTaskListUnreadAt (preserves references when unchanged);
    // identical references at every position mean the content is equivalent.
    return (
      previous.tasks.length === next.tasks.length &&
      next.tasks.every((task, index) => task === previous.tasks[index])
    );
  }
  return previous.type === "task" && next.type === "task" && previous.task === next.task;
}

/**
 * Every grouped refresh rebuilt the entire view-object tree, even when nothing changed (or only one item changed),
 * giving every group/task row a new reference and rerendering the whole sidebar group list as if it were “reloading.”
 * Stabilize references per node: reuse old objects for equivalent nodes and return the old view when the whole tree is equivalent (setState bails on the same reference).
 */
function stabilizeGroupedView(
  previous: ZCodeGroupedTaskView,
  next: ZCodeGroupedTaskView,
): ZCodeGroupedTaskView {
  if (previous.nodes.length === 0) {
    return next;
  }
  const previousByKey = new Map(previous.nodes.map((node) => [groupedNodeIdentityKey(node), node]));
  let identical = previous.nodes.length === next.nodes.length;
  const nodes = next.nodes.map((node, index) => {
    const previousNode = previousByKey.get(groupedNodeIdentityKey(node));
    if (previousNode && areGroupedNodesEquivalent(previousNode, node)) {
      if (identical && previous.nodes[index] !== previousNode) {
        identical = false;
      }
      return previousNode;
    }
    identical = false;
    return node;
  });
  return identical ? previous : { nodes };
}

function nodeToTopLevelRef(
  node: ZCodeGroupedTaskView["nodes"][number],
): ZCodeGroupedTaskViewTopLevelNodeRef {
  if (node.type === "group") {
    return { type: "group", groupId: node.group.id };
  }
  return {
    type: "task",
    task: {
      workspacePath: node.task.workspacePath,
      workspaceIdentity: node.task.workspaceIdentity,
      taskId: node.task.taskId,
    },
  };
}

function viewToOrderInput(params: { view: ZCodeGroupedTaskView }): ZCodeGroupedTaskViewOrderInput {
  return {
    workspaceScopes: collectViewWorkspaceScopes(params.view),
    topLevelNodes: params.view.nodes.map(nodeToTopLevelRef),
    groups: params.view.nodes
      .filter((node) => node.type === "group")
      .map((node) => ({
        groupId: node.group.id,
        taskRefs: node.tasks.map((task) => ({
          workspacePath: task.workspacePath,
          workspaceIdentity: task.workspaceIdentity,
          taskId: task.taskId,
        })),
      })),
  };
}

/**
 * Grouped-view cache across mounts, bucketed by scope signature.
 *
 * Grouped is the only sidebar view that keeps the entire list in component-instance useState; timeline/pinned
 * render from a module-level query cache. If the section remounts because of an ancestor remount/HMR, grouped falls back to
 * “empty view + first-screen gate closed” until both RPCs return, making the whole group list flash. Keep the latest
 * authoritative view at module scope so remounts can render it immediately and RPCs only reconcile it.
 *
 * Stale-read window (an explicit contract, not a defect): the cache is written only after a successful refresh and is not actively invalidated.
 * Deletes/archives/group changes while the component is unmounted do not evict the cache, so those old rows are immediately visible
 * and clickable after remount until the mount effect's refresh returns—the window is at most one RPC round trip. This is the chosen
 * “stale data is better than blank” tradeoff; if users report clicking stale rows, consider adding a cache TTL or using placeholders rather than widening this window.
 */
const GROUPED_VIEW_CACHE_MAX_KEYS = 8;
const groupedViewCacheBySignature = new Map<string, ZCodeGroupedTaskView>();

function readCachedGroupedView(signature: string): ZCodeGroupedTaskView | undefined {
  return groupedViewCacheBySignature.get(signature);
}

function writeCachedGroupedView(signature: string, view: ZCodeGroupedTaskView): void {
  groupedViewCacheBySignature.delete(signature);
  groupedViewCacheBySignature.set(signature, view);
  while (groupedViewCacheBySignature.size > GROUPED_VIEW_CACHE_MAX_KEYS) {
    const oldestKey = groupedViewCacheBySignature.keys().next().value;
    if (oldestKey === undefined) break;
    groupedViewCacheBySignature.delete(oldestKey);
  }
}

export function useGroupedTaskView(params: { workspaceTabs: WorkspaceTabState[] }) {
  const services = useBaseWorkspaceServices();
  // Grouped remains local and workspace-only, but task facts must still come from the window Controller rather than a new sessions-index join in Renderer.
  // Group structure/order continues to come from the local task service to avoid expanding capabilities.
  const localWorkspaceTabs = useLocalWorkspaceScopes({
    workspaceTabs: params.workspaceTabs,
  });
  // Scopes were previously memoized by tabs-array identity. Rebuilding an equal array in a parent changed refresh identity,
  // rerunning the “refresh changed, so refresh” effect and calling setState, which triggered another render—a self-sustaining refresh loop.
  // Each frame sent RPCs and could flash the gate/empty state. Use a value signature instead, matching useGlobalTaskList.
  const localWorkspaceScopeSignature = JSON.stringify(
    localWorkspaceTabs
      .map(
        (tab) =>
          [
            buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity),
            tab.workspacePath,
            tab.workspaceIdentity ?? null,
            tab.workspacePurpose ?? null,
          ] as const,
      )
      .sort(
        (
          [leftKey, leftPath, leftIdentity, leftPurpose],
          [rightKey, rightPath, rightIdentity, rightPurpose],
        ) =>
          // Tie-break by each field: sorting only by workspaceKey returns 0 for tabs with the same key but different purposes.
          // Stable sort then preserves input order, so swapping them in the tabs array changes the signature and triggers an unnecessary refresh.
          String(leftKey).localeCompare(String(rightKey)) ||
          String(leftPath).localeCompare(String(rightPath)) ||
          String(leftIdentity ?? "").localeCompare(String(rightIdentity ?? "")) ||
          String(leftPurpose ?? "").localeCompare(String(rightPurpose ?? "")),
      ),
  );
  const scopes = useMemo(
    () => buildWorkspaceScopes(localWorkspaceTabs),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Reuse when the value signature is equal to avoid a refresh loop when the parent replaces the array identity.
    [localWorkspaceScopeSignature],
  );
  const sessionsIndexScopes = useMemo(
    () =>
      scopes.map((scope) => ({
        workspacePath: scope.workspacePath,
        ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      })),
    [scopes],
  );
  const [view, setView] = useState<ZCodeGroupedTaskView>(
    () => readCachedGroupedView(localWorkspaceScopeSignature) ?? { nodes: [] },
  );
  const viewRef = useRef(view);
  viewRef.current = view;
  const [loading, setLoading] = useState(false);
  const [remoteDataInitialized, setRemoteDataInitialized] = useState(
    () => readCachedGroupedView(localWorkspaceScopeSignature) !== undefined,
  );
  const [saving, setSaving] = useState(false);
  const requestIdRef = useRef(0);
  const taskListVersionSignature = useZCodeSessionStore((state) =>
    JSON.stringify(
      params.workspaceTabs.map((tab) => {
        const workspaceKey = buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity);
        const workspaceState = selectWorkspaceZCodeState(
          state,
          tab.workspacePath,
          tab.workspaceIdentity,
        );
        return [workspaceKey, workspaceState.taskListVersion] as const;
      }),
    ),
  );
  const controllerTaskFacts = useGlobalTaskList({
    kind: "active",
    workspaceTabs: localWorkspaceTabs,
    sortBy: "updated",
    searchQuery: "",
    expanded: true,
    collapsedLimit: 1,
  });
  const sessionsIndexItems = controllerTaskFacts.items;
  // A cache hit counts as initialized: after remount, the Controller list returns to loading. If the latch is not seeded from the cache too,
  // the gate will still close and flash on the first frame.
  const initializedLatchRef = useRef(
    readCachedGroupedView(localWorkspaceScopeSignature) !== undefined,
  );
  const initialized = isGroupedTaskViewInitialized({
    remoteDataInitialized,
    hydratingEndpointKeys: controllerTaskFacts.loading ? ["window-controller"] : [],
    previouslyInitialized: initializedLatchRef.current,
  });
  // Preconditions for writing a ref during render (do not copy this for non-monotonic state): this ref is a monotonic latch (false→true, never resets),
  // and its new value is derived entirely from this render's inputs. React 18 concurrent rendering may execute this assignment in a discarded render,
  // but “set early” is equivalent to “ready early” for a monotonic latch and only opens the gate sooner; it cannot create an incorrect state.
  // For any state that can revert or depends on commit order, this pattern can miss frames unpredictably; use an effect instead.
  initializedLatchRef.current = initialized;
  const sessionsIndexItemsRef = useRef(sessionsIndexItems);
  sessionsIndexItemsRef.current = sessionsIndexItems;
  // Version for pin/archive membership: bump after mutation so the grouped view (neither pinned nor archived) is authoritatively re-filtered.
  const membershipVersion = useTaskListMembershipVersion();
  const optimisticTaskOverlayByWorkspaceKey = useWorkspaceTaskOptimisticOverlayByWorkspaceKey(
    params.workspaceTabs,
  );
  const clearPromotedGroupedDraftTask = useZCodeSessionStore(
    (state) => state.clearPromotedGroupedDraftTask,
  );
  const visibleMissingTaskKeysRef = useRef<Set<string>>(new Set());
  const promotedGroupPersistenceRef = useRef<Set<string>>(new Set());
  const displayedViewRef = useRef<ZCodeGroupedTaskView>({ nodes: [] });
  const displayedView = useMemo(() => {
    const optimisticOverlays = [...optimisticTaskOverlayByWorkspaceKey.values()];
    const visibleMissingTaskKeys = reconcileGroupedOptimisticTaskKeys({
      view,
      optimisticOverlays,
      previousVisibleMissingTaskKeys: visibleMissingTaskKeysRef.current,
    });
    visibleMissingTaskKeysRef.current = visibleMissingTaskKeys;
    // Overlay frames (optimistic metadata updates for running tasks) bypass view-node stabilization,
    // producing new group/task objects each time and rerendering the whole sidebar list and remeasuring its virtualizer.
    // Stabilize the display view with the same node-level logic so even the array identity remains unchanged when equivalent.
    const nextDisplayedView = stabilizeGroupedView(
      displayedViewRef.current,
      mergeGroupedTaskViewWithOptimistic({
        view,
        optimisticOverlays,
        visibleMissingTaskKeys,
      }),
    );
    displayedViewRef.current = nextDisplayedView;
    return nextDisplayedView;
  }, [optimisticTaskOverlayByWorkspaceKey, view]);

  // Incremental updates: grouped structure (groups/order) and membership (pin/archive/unread) do not change with
  // sessions-index content frames (title/status). Cache by membershipVersion + structure version + scope signature;
  // a refresh triggered by a content frame performs only an in-memory join and sends no RPC. Group mutations explicitly invalidate it.
  const [remoteDataLoader] = useState(
    () =>
      new GroupedRemoteDataSingleFlight<{
        structure: ZCodeGroupedTaskViewStructure;
        membership: Awaited<ReturnType<typeof fetchTaskListMembershipSets>>;
      }>(),
  );
  const invalidateRemoteData = useCallback(() => {
    remoteDataLoader.invalidate();
  }, [remoteDataLoader]);

  const refresh = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    // loading means only “there are no authoritative nodes for the first screen yet.” A running task triggers a background
    // refresh for every tool result; setting loading unconditionally here would flash the empty state and first-screen gate each time.
    if (viewRef.current.nodes.length === 0) {
      setLoading(true);
    }
    try {
      // tasks-index provides both persistent task rows and group structure; sessions-index only enriches activity/detail.
      // The grouped sidebar must follow the currently open workspace scope; do not pass includeAllWorkspaces or groups from other workspaces will be included.
      const remoteDataKey = [
        membershipVersion,
        taskListVersionSignature,
        scopes
          .map((scope) => buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity))
          .join("|"),
      ].join("::");
      const remoteData = await remoteDataLoader.load(remoteDataKey, async () => {
        const [structureResult, membershipResult] = await Promise.all([
          services.zcodeTaskService.listGroupedTaskViewStructure({
            workspaceScopes: scopes,
          }),
          fetchTaskListMembershipSets({
            service: services.zcodeTaskService,
            scopes: sessionsIndexScopes,
          }),
        ]);
        return {
          structure: structureResult,
          membership: membershipResult,
        };
      });
      if (
        requestIdRef.current === requestId &&
        remoteDataLoader.isCurrent(remoteDataKey, remoteData)
      ) {
        const { structure, membership } = remoteData;
        const nextView = buildGroupedTaskViewFromSessions({
          structure,
          taskIndexItems: membership.taskIndexItems,
          sessions: sessionsIndexItemsRef.current,
          pinnedIds: membership.pinnedIds,
          archivedIds: membership.archivedIds,
          deletedIds: membership.deletedIds,
        });
        // Reuse the old view/node references when content is unchanged; setState bails on the same reference and avoids an unnecessary whole-list rerender.
        // Read the current view from viewRef instead of performing side effects in the updater, which StrictMode may call more than once.
        const stabilizedView = stabilizeGroupedView(viewRef.current, nextView);
        writeCachedGroupedView(localWorkspaceScopeSignature, stabilizedView);
        setView(stabilizedView);
      }
    } catch (error) {
      // Multiple refreshes may share the same remote Promise; log a failure only for the latest request to avoid recreating a log storm on the error path.
      // Older requests still reach finally, but must not clear loading for the latest generation.
      if (requestIdRef.current === requestId) {
        logger.error("[useGroupedTaskView] 加载 grouped task 视图失败", error);
      }
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false);
        // Whether the initial request succeeds or fails, release the initialization gate; failures are logged and show the empty state
        // instead of loading forever. Later refreshes preserve the existing list and do not return to the initial loading state.
        setRemoteDataInitialized(true);
      }
    }
  }, [
    localWorkspaceScopeSignature,
    membershipVersion,
    remoteDataLoader,
    scopes,
    sessionsIndexScopes,
    services.zcodeTaskService,
    taskListVersionSignature,
  ]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    const authoritativeTaskKeys = collectGroupedViewTaskKeys(view);
    const promotedGroupTasks: ZCodeTaskMeta[] = [];
    const settledRootTasks: ZCodeTaskMeta[] = [];
    for (const overlay of optimisticTaskOverlayByWorkspaceKey.values()) {
      for (const [taskId, promotedDraft] of Object.entries(
        overlay.promotedGroupedDraftTaskByTaskId ?? {},
      )) {
        const key = buildTaskEntityKey({
          taskId,
          workspacePath: promotedDraft.workspacePath,
          workspaceIdentity: promotedDraft.workspaceIdentity,
        });
        const task = findTaskInGroupedView(displayedView, key);
        if (promotedDraft?.placement.type === "top") {
          const firstNode = view.nodes[0];
          if (task && firstNode?.type === "task" && buildTaskEntityKey(firstNode.task) === key) {
            settledRootTasks.push(task);
          }
        } else if (
          task &&
          (authoritativeTaskKeys.has(key) || visibleMissingTaskKeysRef.current.has(key)) &&
          !isTaskFirstInGroup(view, key, promotedDraft.placement.groupId)
        ) {
          promotedGroupTasks.push(task);
        }
      }
    }
    for (const task of settledRootTasks) {
      clearPromotedGroupedDraftTask(task.workspacePath, task.taskId, task.workspaceIdentity);
    }
    if (promotedGroupTasks.length === 0) {
      return;
    }
    const signature = promotedGroupTasks.map(buildTaskEntityKey).sort().join("|");
    if (promotedGroupPersistenceRef.current.has(signature)) {
      return;
    }
    promotedGroupPersistenceRef.current.add(signature);
    // New task inside a group previously inherited the draft position only in the optimistic view, while SQLite pinned it as a root
    // task, so refresh moved it out of the group. Once the task enters the optimistic index, persist the same display view as a complete
    // ordering transaction so membership and its first position in the group converge together.
    void services.zcodeTaskService
      .applyGroupedTaskViewOrder(viewToOrderInput({ view: displayedView }))
      .then(() => {
        invalidateRemoteData();
        return refreshRef.current().then(() => {
          for (const task of promotedGroupTasks) {
            clearPromotedGroupedDraftTask(task.workspacePath, task.taskId, task.workspaceIdentity);
          }
        });
      })
      .catch((error) => {
        promotedGroupPersistenceRef.current.delete(signature);
        logger.error("[useGroupedTaskView] 保存 grouped 草稿提升位置失败", error);
      });
  }, [
    clearPromotedGroupedDraftTask,
    displayedView,
    invalidateRemoteData,
    optimisticTaskOverlayByWorkspaceKey,
    services.zcodeTaskService,
    view,
  ]);

  useEffect(() => {
    const disposables = scopes.map((scope) =>
      services.zcodeTaskService.onDynamicWorkspaceEvent(scope)((event) => {
        if (event.type !== "workspace_task_list_changed" || event.reason !== "task_created") {
          return;
        }
        // A visible sessions-index frame may arrive before SQLite writes grouped sort_order.
        // task_created marks the boundary where the initial order has been committed, so discard the old structure cache and reload;
        // otherwise the running view appends the task as an unordered node and recovers only after restart rebuilds the cache.
        invalidateRemoteData();
        void refreshRef.current();
      }),
    );
    return () => disposables.forEach((disposable) => disposable.dispose());
  }, [invalidateRemoteData, scopes, services.zcodeTaskService]);

  // The only automatic refresh entry point. refresh identity already includes membership/structure/scope versions;
  // sessions-index content changes trigger an in-memory join. This avoids duplicate requests from mount and index effects on the first frame.
  useEffect(() => {
    void refresh();
  }, [refresh, sessionsIndexItems]);

  const createGroup = useCallback(async (): Promise<ZCodeTaskGroup> => {
    setSaving(true);
    try {
      const group = await services.zcodeTaskService.createTaskGroup();
      // SQLite has already placed the new group first, but waiting for async refresh would briefly keep the old tree and
      // append it after unordered nodes. Optimistically insert it first using the same sort_order semantics, then reconcile from SQLite on refresh.
      setView((current) => prependTaskGroupToView(current, group));
      // Group structure changed; invalidate the remote data cache and rebuild it (the membershipVersion bump may arrive after the local refresh).
      invalidateRemoteData();
      await refresh();
      return group;
    } catch (error) {
      logger.error("[useGroupedTaskView] 创建 task group 失败", error);
      throw error;
    } finally {
      setSaving(false);
    }
  }, [invalidateRemoteData, refresh, services.zcodeTaskService]);

  const renameGroup = useCallback(
    async (groupId: string, title: string) => {
      const previousView = view;
      const groupNode = view.nodes.find(
        (node) => node.type === "group" && node.group.id === groupId,
      );
      const nextTitle = title.trim() || (groupNode?.type === "group" ? groupNode.group.title : "");
      if (!groupNode || groupNode.type !== "group" || groupNode.group.title === nextTitle) {
        return;
      }

      const optimisticView: ZCodeGroupedTaskView = {
        nodes: view.nodes.map((node) =>
          node.type === "group" && node.group.id === groupId
            ? {
                ...node,
                group: {
                  ...node.group,
                  title: nextTitle,
                  updatedAt: Date.now(),
                },
              }
            : node,
        ),
      };
      setView(optimisticView);
      setSaving(true);
      try {
        const renamedGroup = await services.zcodeTaskService.renameTaskGroup({
          groupId,
          title: nextTitle,
          workspaceScopes: collectViewWorkspaceScopes(optimisticView),
        });
        invalidateRemoteData();
        setView({
          nodes: optimisticView.nodes.map((node) =>
            node.type === "group" && node.group.id === groupId
              ? { ...node, group: renamedGroup }
              : node,
          ),
        });
      } catch (error) {
        setView(previousView);
        logger.error("[useGroupedTaskView] 重命名 task group 失败", error);
        throw error;
      } finally {
        setSaving(false);
      }
    },
    [invalidateRemoteData, scopes, services.zcodeTaskService, view],
  );

  const updateGroupColor = useCallback(
    async (groupId: string, color: ZCodeTaskGroupColor) => {
      const previousView = view;
      const groupNode = view.nodes.find(
        (node) => node.type === "group" && node.group.id === groupId,
      );
      if (!groupNode || groupNode.type !== "group" || groupNode.group.color === color) {
        return;
      }

      const optimisticView: ZCodeGroupedTaskView = {
        nodes: view.nodes.map((node) =>
          node.type === "group" && node.group.id === groupId
            ? {
                ...node,
                group: {
                  ...node.group,
                  color,
                  updatedAt: Date.now(),
                },
              }
            : node,
        ),
      };
      setView(optimisticView);
      setSaving(true);
      try {
        const updatedGroup = await services.zcodeTaskService.updateTaskGroupColor({
          groupId,
          color,
          workspaceScopes: collectViewWorkspaceScopes(optimisticView),
        });
        invalidateRemoteData();
        setView({
          nodes: optimisticView.nodes.map((node) =>
            node.type === "group" && node.group.id === groupId
              ? { ...node, group: updatedGroup }
              : node,
          ),
        });
      } catch (error) {
        setView(previousView);
        logger.error("[useGroupedTaskView] 更新 task group 颜色失败", error);
        throw error;
      } finally {
        setSaving(false);
      }
    },
    [invalidateRemoteData, scopes, services.zcodeTaskService, view],
  );

  const applyOrder = useCallback(
    async (nextView: ZCodeGroupedTaskView) => {
      const previousView = view;
      setView(nextView);
      setSaving(true);
      try {
        // The view returned by apply still joins from the tasks table (the old data source), so do not trust it.
        // After persistence succeeds, reconcile by rebuilding from structure + sessions-index (refresh).
        await services.zcodeTaskService.applyGroupedTaskViewOrder(
          viewToOrderInput({
            view: nextView,
          }),
        );
        invalidateRemoteData();
        await refreshRef.current();
      } catch (error) {
        // If writing the grouped view fails, roll back the local optimistic view and refresh once to converge to SQLite as the source of truth.
        setView(previousView);
        void refresh();
        logger.error("[useGroupedTaskView] 保存 grouped task 顺序失败", error);
        throw error;
      } finally {
        setSaving(false);
      }
    },
    [invalidateRemoteData, refresh, services.zcodeTaskService, view],
  );

  const ungroupGroup = useCallback(
    async (groupId: string) => {
      const groupNode = view.nodes.find(
        (node) => node.type === "group" && node.group.id === groupId,
      );
      if (!groupNode || groupNode.type !== "group") {
        return;
      }
      const nextView: ZCodeGroupedTaskView = {
        nodes: view.nodes.flatMap((node) =>
          node.type === "group" && node.group.id === groupId
            ? node.tasks.map((task) => ({ type: "task" as const, task }))
            : [node],
        ),
      };

      setSaving(true);
      try {
        await applyOrder(nextView);
        await services.zcodeTaskService.deleteTaskGroup({
          groupId,
          workspaceScopes: collectViewWorkspaceScopes(nextView),
        });
        invalidateRemoteData();
        await refresh();
      } catch (error) {
        logger.error("[useGroupedTaskView] 取消 task group 分组失败", error);
        throw error;
      } finally {
        setSaving(false);
      }
    },
    [applyOrder, invalidateRemoteData, refresh, scopes, services.zcodeTaskService, view],
  );

  return {
    view: displayedView,
    setView,
    loading,
    initialized,
    saving,
    refresh,
    createGroup,
    renameGroup,
    updateGroupColor,
    ungroupGroup,
    applyOrder,
  };
}

// Authoritative reads for persisted sidebar rows and pin/archive/groups. tasks-index.sqlite provides the row set and
// membership; sessions-index adds real-time activity/details only in a later projection.
// unread is also organizational state (setTaskUnread writes tasks-index), like pin/archive,
// and is not part of the frozen sessions-index schema; fetch an unreadAt map in parallel and join it while building lists.
import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";

export interface TaskListMembershipScope {
  workspacePath: string;
  workspaceIdentity?: string;
}

export type TaskListMembershipService = Pick<
  IZCodeTaskService,
  "listPinnedTaskIds" | "listArchivedTasks" | "listTasks" | "listPinnedTasks"
> &
  Partial<Pick<IZCodeTaskService, "listDeletedTaskIds">>;

export interface TaskListMembershipSets {
  /** Union of complete task rows from the three persisted tasks-index partitions (active/pinned/archived). */
  taskIndexItems: ZCodeTaskMeta[];
  pinnedIds: Set<string>;
  archivedIds: Set<string>;
  /** Persisted deletion tombstones from tasks-index; take precedence over every list kind. */
  deletedIds: Set<string>;
  /** taskId → unreadAt (tasks-index organizational state; absent from sessions-index and joined here). */
  unreadAtByTaskId: Map<string, number>;
  /** taskId → terminal status (tasks-index historical state; used to restore the cold-start stored-summary indicator). */
  terminalStatusByTaskId: Map<string, Extract<ZCodeTaskMeta["status"], "completed" | "error">>;
  /** Legacy manually assigned task titles by taskId. The v4 sessions-index primary list comes from the CLI session store, but old user renames exist only in tasks-index.title/titleOverridden. Include them alongside the existing membership read without migrating tables. */
  titleOverrideByTaskId: Map<string, string>;
  /** taskId → cronAutomationId (persisted identity in tasks-index; not included in the frozen sessions-index schema). */
  cronAutomationIdByTaskId: Map<string, string>;
}

export interface TaskListMembershipRefreshHoldState {
  armed: boolean;
  enteredCallCount: number;
  released: boolean;
}

interface ActiveTaskListMembershipRefreshHold {
  released: Promise<void>;
  release: () => void;
}

let activeTaskListMembershipRefreshHold: ActiveTaskListMembershipRefreshHold | null = null;
let taskListMembershipRefreshHoldState: TaskListMembershipRefreshHoldState = {
  armed: false,
  enteredCallCount: 0,
  released: true,
};

/** E2E only: pause a membership snapshot after reading finishes but before it is joined and returned to the renderer. TSL18 must deterministically create the window where an old running snapshot returns after the Stop terminal state; real SQLite is too fast for sleep-based timing. Exposed only through protected window.__testActions. */
export function armTaskListMembershipRefreshHoldForE2E(): void {
  if (activeTaskListMembershipRefreshHold) {
    throw new Error("task list membership refresh hold 已经启动");
  }
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  activeTaskListMembershipRefreshHold = { released, release };
  taskListMembershipRefreshHoldState = {
    armed: true,
    enteredCallCount: 0,
    released: false,
  };
  clearTaskListMembershipCache();
}

export function releaseTaskListMembershipRefreshHoldForE2E(): void {
  const hold = activeTaskListMembershipRefreshHold;
  if (!hold) {
    return;
  }
  activeTaskListMembershipRefreshHold = null;
  taskListMembershipRefreshHoldState = {
    ...taskListMembershipRefreshHoldState,
    armed: false,
    released: true,
  };
  hold.release();
}

export function getTaskListMembershipRefreshHoldStateForE2E(): TaskListMembershipRefreshHoldState {
  return { ...taskListMembershipRefreshHoldState };
}

async function holdTaskListMembershipRefreshResultForE2E(): Promise<void> {
  const hold = activeTaskListMembershipRefreshHold;
  if (!hold) {
    return;
  }
  taskListMembershipRefreshHoldState = {
    ...taskListMembershipRefreshHoldState,
    enteredCallCount: taskListMembershipRefreshHoldState.enteredCallCount + 1,
  };
  await hold.released;
}

/** M5 ③: Remote shard ownership is recorded in each endpoint’s tasks-index; fetch by endpoint and merge the results. */
export interface TaskListMembershipEndpoint {
  service: TaskListMembershipService;
  scopes: TaskListMembershipScope[];
}

function scopeParams(scope: TaskListMembershipScope): {
  workspacePath: string;
  workspaceIdentity?: string;
} {
  return {
    workspacePath: scope.workspacePath,
    ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
  };
}

/** If an optional auxiliary-set read fails, fall back to an empty set. */
async function listOrEmpty<T>(list: () => Promise<T[]>): Promise<T[]> {
  try {
    return await list();
  } catch {
    return [];
  }
}

async function listWithAvailability<T>(
  list: () => Promise<T[]>,
): Promise<{ items: T[]; available: boolean }> {
  try {
    return { items: await list(), available: true };
  } catch {
    return { items: [], available: false };
  }
}

function collectUnreadAt(unreadAtByTaskId: Map<string, number>, tasks: ZCodeTaskMeta[]): void {
  for (const task of tasks) {
    if (typeof task.unreadAt === "number") {
      unreadAtByTaskId.set(task.taskId, task.unreadAt);
    }
  }
}

function collectTerminalStatuses(
  terminalStatusByTaskId: TaskListMembershipSets["terminalStatusByTaskId"],
  tasks: ZCodeTaskMeta[],
): void {
  for (const task of tasks) {
    if (task.status === "completed" || task.status === "error") {
      terminalStatusByTaskId.set(task.taskId, task.status);
    }
  }
}

function collectTitleOverrides(
  titleOverrideByTaskId: Map<string, string>,
  tasks: ZCodeTaskMeta[],
): void {
  for (const task of tasks) {
    if (task.titleOverridden === true && task.title.trim().length > 0) {
      titleOverrideByTaskId.set(task.taskId, task.title);
    }
  }
}

function collectCronAutomationIds(
  cronAutomationIdByTaskId: Map<string, string>,
  tasks: ZCodeTaskMeta[],
): void {
  for (const task of tasks) {
    if (task.cronAutomationId) {
      cronAutomationIdByTaskId.set(task.taskId, task.cronAutomationId);
    }
  }
}

function mergeTaskIndexItems(lists: ZCodeTaskMeta[][]): ZCodeTaskMeta[] {
  const itemByEntityKey = new Map<string, ZCodeTaskMeta>();
  for (const task of lists.flat()) {
    itemByEntityKey.set(buildTaskEntityKey(task), task);
  }
  return [...itemByEntityKey.values()];
}

/** Fetch authoritative server task rows, pinned/archived IDs, and other persisted metadata. */
export async function fetchTaskListMembershipSets(params: {
  service: TaskListMembershipService;
  scopes: TaskListMembershipScope[];
}): Promise<TaskListMembershipSets> {
  const [
    pinnedList,
    archivedListResults,
    activeListResults,
    pinnedMetaListResults,
    deletedIdLists,
  ] = await Promise.all([
    listOrEmpty(() => params.service.listPinnedTaskIds()),
    Promise.all(
      params.scopes.map((scope) =>
        listWithAvailability(() => params.service.listArchivedTasks(scopeParams(scope))),
      ),
    ),
    // unread covers all three membership sets: active (listTasks = neither pinned nor archived), pinned, and archived.
    Promise.all(
      params.scopes.map((scope) =>
        listWithAvailability(() => params.service.listTasks(scopeParams(scope))),
      ),
    ),
    Promise.all(
      params.scopes.map((scope) =>
        listWithAvailability(() => params.service.listPinnedTasks(scopeParams(scope))),
      ),
    ),
    Promise.all(
      params.scopes.map((scope) =>
        params.service.listDeletedTaskIds
          ? listOrEmpty(() => params.service.listDeletedTaskIds!(scopeParams(scope)))
          : Promise.resolve([]),
      ),
    ),
  ]);
  await holdTaskListMembershipRefreshResultForE2E();
  // Task rows are now the left table for all sidebar lists. A failure in any partition RPC must not
  // be published as an authoritative empty set, which would clear the entire old cache; throw so the hook can preserve the previous view.
  if (
    activeListResults.some((result) => !result.available) ||
    archivedListResults.some((result) => !result.available) ||
    pinnedMetaListResults.some((result) => !result.available)
  ) {
    throw new Error("tasks-index task 行读取不完整");
  }
  const archivedLists = archivedListResults.map((result) => result.items);
  const activeLists = activeListResults.map((result) => result.items);
  const pinnedMetaLists = pinnedMetaListResults.map((result) => result.items);
  const unreadAtByTaskId = new Map<string, number>();
  const terminalStatusByTaskId: TaskListMembershipSets["terminalStatusByTaskId"] = new Map();
  const titleOverrideByTaskId = new Map<string, string>();
  const cronAutomationIdByTaskId = new Map<string, string>();
  collectUnreadAt(unreadAtByTaskId, archivedLists.flat());
  collectUnreadAt(unreadAtByTaskId, activeLists.flat());
  collectUnreadAt(unreadAtByTaskId, pinnedMetaLists.flat());
  collectTerminalStatuses(terminalStatusByTaskId, archivedLists.flat());
  collectTerminalStatuses(terminalStatusByTaskId, activeLists.flat());
  collectTerminalStatuses(terminalStatusByTaskId, pinnedMetaLists.flat());
  collectTitleOverrides(titleOverrideByTaskId, archivedLists.flat());
  collectTitleOverrides(titleOverrideByTaskId, activeLists.flat());
  collectTitleOverrides(titleOverrideByTaskId, pinnedMetaLists.flat());
  // After v4 sidebar data switched to sessions-index, frozen SessionSummary no longer contains
  // cronAutomationId. Collect it from tasks-index here or a value that is present in persisted storage will be lost from UI tasks.
  collectCronAutomationIds(cronAutomationIdByTaskId, archivedLists.flat());
  collectCronAutomationIds(cronAutomationIdByTaskId, activeLists.flat());
  collectCronAutomationIds(cronAutomationIdByTaskId, pinnedMetaLists.flat());
  return {
    // Existence of persisted task rows must be decided by tasks-index. Previously this kept only membership
    // sets and discarded task metadata already read, forcing every list to enumerate rows from sessions-index instead.
    taskIndexItems: mergeTaskIndexItems([
      activeLists.flat(),
      pinnedMetaLists.flat(),
      archivedLists.flat(),
    ]),
    // A pinned task row is itself evidence of membership; even if the auxiliary ID RPC briefly fails,
    // do not misclassify a successfully read pinned row into the timeline.
    pinnedIds: new Set([...pinnedList, ...pinnedMetaLists.flat().map((task) => task.taskId)]),
    archivedIds: new Set(archivedLists.flat().map((task) => task.taskId)),
    deletedIds: new Set(deletedIdLists.flat()),
    unreadAtByTaskId,
    terminalStatusByTaskId,
    titleOverrideByTaskId,
    cronAutomationIdByTaskId,
  };
}

// Incremental update fix: membership (pin/archive/unread) changes only with membership mutations (membershipVersion bump),
// independently of sessions-index content frames (title/status/lastActivity). Previously each frame refetched: one title update
// caused each list instance to send 1 + 3×scopes RPCs (over a hundred calls per frame with many workspaces/instances).
// Cache the in-flight promise by membershipVersion + endpoint signature so hook instances share it;
// a version bump or endpoint-topology change naturally uses a new key. Bound the cache to avoid retaining old versions.
const membershipPromiseByCacheKey = new Map<string, Promise<TaskListMembershipSets>>();
const MEMBERSHIP_CACHE_MAX_KEYS = 8;
// Include service-instance identity in the key so different endpoint services (including test mocks and new proxies after reconnect) never share cached reads.
const membershipServiceIds = new WeakMap<TaskListMembershipService, number>();
let nextMembershipServiceId = 1;

function membershipServiceIdOf(service: TaskListMembershipService): number {
  let id = membershipServiceIds.get(service);
  if (id === undefined) {
    id = nextMembershipServiceId++;
    membershipServiceIds.set(service, id);
  }
  return id;
}

export function fetchTaskListMembershipSetsForEndpointsCached(params: {
  /** Suggested format: `${membershipVersion}::${endpoints signature}`. */
  cacheKey: string;
  endpoints: TaskListMembershipEndpoint[];
}): Promise<TaskListMembershipSets> {
  const fullCacheKey = `${params.cacheKey}::svc=${params.endpoints
    .map((endpoint) => membershipServiceIdOf(endpoint.service))
    .join(",")}`;
  const cached = membershipPromiseByCacheKey.get(fullCacheKey);
  if (cached) {
    return cached;
  }
  const promise = fetchTaskListMembershipSetsForEndpoints(params.endpoints);
  membershipPromiseByCacheKey.set(fullCacheKey, promise);
  // Auxiliary sets may fall back to empty, but incomplete reads for task-row partitions must reject. Do not cache failures,
  // so a temporary RPC error is not stuck to the current version.
  promise.catch(() => membershipPromiseByCacheKey.delete(fullCacheKey));
  while (membershipPromiseByCacheKey.size > MEMBERSHIP_CACHE_MAX_KEYS) {
    const oldestKey = membershipPromiseByCacheKey.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    membershipPromiseByCacheKey.delete(oldestKey);
  }
  return promise;
}

/** Clear the membership cache for tests and error recovery. */
export function clearTaskListMembershipCache(): void {
  membershipPromiseByCacheKey.clear();
}

/** Fetch memberships concurrently by endpoint and compute their union (taskId is a sessionId and cannot collide across endpoints). */
export async function fetchTaskListMembershipSetsForEndpoints(
  endpoints: TaskListMembershipEndpoint[],
): Promise<TaskListMembershipSets> {
  const results = await Promise.all(
    endpoints
      .filter((endpoint) => endpoint.scopes.length > 0)
      .map((endpoint) =>
        fetchTaskListMembershipSets({
          service: endpoint.service,
          scopes: endpoint.scopes,
        }),
      ),
  );
  const merged: TaskListMembershipSets = {
    taskIndexItems: [],
    pinnedIds: new Set<string>(),
    archivedIds: new Set<string>(),
    deletedIds: new Set<string>(),
    unreadAtByTaskId: new Map<string, number>(),
    terminalStatusByTaskId: new Map(),
    titleOverrideByTaskId: new Map<string, string>(),
    cronAutomationIdByTaskId: new Map<string, string>(),
  };
  const taskIndexItemByEntityKey = new Map<string, ZCodeTaskMeta>();
  for (const result of results) {
    for (const task of result.taskIndexItems) {
      taskIndexItemByEntityKey.set(buildTaskEntityKey(task), task);
    }
    for (const taskId of result.pinnedIds) merged.pinnedIds.add(taskId);
    for (const taskId of result.archivedIds) merged.archivedIds.add(taskId);
    for (const taskId of result.deletedIds) merged.deletedIds.add(taskId);
    for (const [taskId, unreadAt] of result.unreadAtByTaskId) {
      merged.unreadAtByTaskId.set(taskId, unreadAt);
    }
    for (const [taskId, status] of result.terminalStatusByTaskId) {
      merged.terminalStatusByTaskId.set(taskId, status);
    }
    for (const [taskId, title] of result.titleOverrideByTaskId) {
      merged.titleOverrideByTaskId.set(taskId, title);
    }
    for (const [taskId, automationId] of result.cronAutomationIdByTaskId) {
      merged.cronAutomationIdByTaskId.set(taskId, automationId);
    }
  }
  merged.taskIndexItems = [...taskIndexItemByEntityKey.values()];
  return merged;
}

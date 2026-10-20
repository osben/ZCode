/* eslint-disable max-lines -- Controller source aggregation, routing, subscriptions, and lifecycle form one Host boundary. */
import { Emitter } from "@zcode/rpc";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type {
  ControllerSubscribeParams,
  WindowHostControllerTaskRow,
  WindowHostTaskAddress,
} from "@zcode/shared/zcode-protocol-v4";
import { matchesTaskListMembershipKind } from "@zcode/shared/zcode-protocol-v4";
import type {
  IWindowControllerService,
  WindowHostControllerFrame,
  WindowHostControllerTaskListItem,
  WindowHostControllerTaskListResult,
  WindowHostTaskUnreadSignal,
} from "./windowController.js";
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { IZCodeTaskService } from "../session/zcodeTaskService.js";
import type {
  ZCodeTaskListQuery,
  ZCodeTaskListWorkspaceScope,
} from "../session/zcodeTaskListTypes.js";
import {
  createWindowHostControllerProjection,
  type WindowHostControllerMutation,
  type WindowHostControllerMutationResult,
  type WindowHostControllerSessionOverlay,
  type WindowHostControllerSourceScope,
} from "./windowHostControllerProjection.js";
import {
  createWindowHostSessionsIndexObserver,
  type WindowHostSessionsIndexObserver,
} from "./windowHostSessionsIndexObserver.js";

export interface ResolvedWindowHostControllerSource {
  scope: WindowHostControllerSourceScope;
  taskService?: IZCodeTaskService;
  agentService?: IZCodeAgentService;
  sourceAvailability: "online" | "offline";
}

function sourceKey(scope: WindowHostControllerSourceScope): string {
  return `${scope.kind}\0${scope.kind === "remote" ? scope.remoteSessionId : "local"}\0${scope.workspaceIdentity?.trim() || scope.workspacePath}`;
}

function taskKey(task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">) {
  return `${task.workspaceIdentity?.trim() || task.workspacePath}\0${task.taskId}`;
}

function normalizeTaskMeta(
  meta: ZCodeTaskMeta,
  scope: WindowHostControllerSourceScope,
): ZCodeTaskMeta {
  return {
    ...meta,
    workspacePath: scope.workspacePath,
    ...(scope.workspaceIdentity
      ? { workspaceIdentity: scope.workspaceIdentity }
      : { workspaceIdentity: undefined }),
  };
}

function compareItems(
  left: WindowHostControllerTaskListItem,
  right: WindowHostControllerTaskListItem,
  sortBy: ZCodeTaskListQuery["sortBy"],
): number {
  const leftAt = sortBy === "created" ? left.createdAt : left.updatedAt;
  const rightAt = sortBy === "created" ? right.createdAt : right.updatedAt;
  return rightAt - leftAt || left.taskId.localeCompare(right.taskId);
}

function mutationParams(address: WindowHostTaskAddress) {
  return {
    taskId: address.taskId,
    workspacePath: address.workspacePath,
    ...(address.workspaceIdentity ? { workspaceIdentity: address.workspaceIdentity } : {}),
  };
}

function sessionOverlay(
  summary: import("@zcode/shared/zcode-protocol-v4").SessionSummary,
): WindowHostControllerSessionOverlay {
  const liveStatus: WindowHostControllerSessionOverlay["liveStatus"] =
    summary.pendingInteraction ||
    (summary.pendingInteractionSummary &&
      summary.pendingInteractionSummary.permissionCount +
        summary.pendingInteractionSummary.userInputCount >
        0)
      ? "waiting"
      : summary.phase === "prewarming" || summary.phase === "running"
        ? "running"
        : summary.phase === "error"
          ? "error"
          : summary.phase === "completedSuccess" || summary.phase === "completedInterrupted"
            ? "completed"
            : "idle";
  return {
    taskId: summary.sessionId,
    liveStatus,
    title: summary.title,
    ...(summary.titleSource ? { titleSource: summary.titleSource } : {}),
    updatedAt: summary.lastActivityAt,
    ...(summary.executionWorktree ? { executionWorktree: summary.executionWorktree } : {}),
    ...(summary.executionWorktreeMissing !== undefined
      ? { executionWorktreeMissing: summary.executionWorktreeMissing }
      : {}),
    ...(summary.incognito ? { incognito: true } : {}),
    ...(summary.worktreePreparation ? { worktreePreparation: summary.worktreePreparation } : {}),
    ...(summary.sideChatCount !== undefined ? { sideChatCount: summary.sideChatCount } : {}),
    ...(summary.subagentCount !== undefined ? { subagentCount: summary.subagentCount } : {}),
    ...(summary.runningSubagentCount !== undefined
      ? { runningSubagentCount: summary.runningSubagentCount }
      : {}),
    ...(summary.childSessions !== undefined ? { childSessions: summary.childSessions } : {}),
    ...(summary.pendingInteraction
      ? {
          pendingInteraction: {
            interactionId: summary.pendingInteraction.interactionId,
            kind: summary.pendingInteraction.kind,
            ...(summary.pendingInteraction.toolName
              ? { toolName: summary.pendingInteraction.toolName }
              : {}),
            ...(summary.pendingInteraction.autoResolution
              ? { autoResolution: summary.pendingInteraction.autoResolution }
              : {}),
          },
        }
      : {}),
    activity: {
      phase: summary.phase,
      lastActivityAt: summary.lastActivityAt,
      hasBackgroundWork: summary.hasBackgroundWork,
      ...(summary.pendingInteractionSummary
        ? { pendingInteractions: summary.pendingInteractionSummary }
        : {}),
      ...(summary.workflowActivity ? { workflowActivity: summary.workflowActivity } : {}),
    },
  };
}

function liveStatusFromMeta(meta: ZCodeTaskMeta): WindowHostControllerTaskRow["liveStatus"] {
  if (meta.status === "completed") return "completed";
  if (meta.status === "error") return "error";
  return "idle";
}

/**
 * WindowHostControllerRuntime is the aggregation authority inside the Local Host. It does not persist data; every online query rebuilds the projection from
 * the corresponding source's tasks-index, and disconnects freeze only the last successful in-memory snapshot.
 */
export function createWindowHostControllerRuntime(options: {
  createId: () => string;
  resolveSource: (scope: ZCodeTaskListWorkspaceScope) => ResolvedWindowHostControllerSource | null;
  maxSources?: number;
  maxConcurrentSourceRefreshes?: number;
  onSourceError?: (
    scope: WindowHostControllerSourceScope,
    operation: "refresh" | "search",
    error: unknown,
  ) => void;
}) {
  const projection = createWindowHostControllerProjection({ createId: options.createId });
  const registeredScopes = new Map<string, WindowHostControllerSourceScope>();
  const sourceAvailability = new Map<string, "online" | "offline">();
  const sourceTaskServices = new Map<string, IZCodeTaskService>();
  const sourceSnapshotTaskServices = new Map<string, IZCodeTaskService>();
  const sourceEventSubscriptions = new Map<string, { dispose(): void }>();
  const sourceRefreshFlights = new Map<
    string,
    { taskService: IZCodeTaskService; promise: Promise<void> }
  >();
  const sourceRefreshGenerations = new Map<string, number>();
  const sourceLiveOverlays = new Map<string, WindowHostControllerSessionOverlay[]>();
  const sourceSessionObservers = new Map<
    string,
    {
      agentService: IZCodeAgentService;
      observer: WindowHostSessionsIndexObserver;
    }
  >();
  // BUG-GWT-010 and incognito markers: facts already confirmed persisted in the source's tasks-index, so repeated
  // sessions-index publishes do not re-issue convergence writes. Entries are bound to the task-service instance that
  // confirmed them (persistSourceFacts): a replaced service starts from an empty set.
  type SourceFactSync = {
    taskService: IZCodeTaskService;
    acknowledged: Set<string>;
    inFlight: Set<string>;
  };
  // Execution-worktree facts (BUG-GWT-010): acknowledged per fact signature (task, path, branch).
  const sourceWorktreeFactSynced = new Map<string, SourceFactSync>();
  // Incognito markers (specs/incognito-session.md "Sidebar marker durability"): acknowledged per task id.
  const sourceIncognitoSynced = new Map<string, SourceFactSync>();
  const pendingReplacementByNextSourceKey = new Map<string, WindowHostControllerSourceScope>();
  let disposed = false;
  let activeSourceReads = 0;
  const sourceReadWaiters: Array<() => void> = [];

  function assertOpen(): void {
    if (disposed) throw new Error("Controller runtime is disposed");
  }

  function forgetRegisteredSource(scope: WindowHostControllerSourceScope): void {
    const key = sourceKey(scope);
    registeredScopes.delete(key);
    sourceAvailability.delete(key);
    sourceTaskServices.delete(key);
    sourceSnapshotTaskServices.delete(key);
    sourceEventSubscriptions.get(key)?.dispose();
    sourceEventSubscriptions.delete(key);
    sourceSessionObservers.get(key)?.observer.dispose();
    sourceSessionObservers.delete(key);
    sourceLiveOverlays.delete(key);
    sourceWorktreeFactSynced.delete(key);
    sourceIncognitoSynced.delete(key);
    sourceRefreshGenerations.set(key, (sourceRefreshGenerations.get(key) ?? 0) + 1);
    sourceRefreshFlights.delete(key);
  }

  // Shared in-flight/acknowledgement bookkeeping for the sessions-index convergence writes. `persist` writes one batch
  // of facts and resolves the signatures it confirmed as persisted. A failed batch stays unacknowledged, so the next
  // publish retries it; failures surface through onSourceError and never disturb the live overlay.
  function persistSourceFacts<F>(args: {
    synced: Map<string, SourceFactSync>;
    resolved: ResolvedWindowHostControllerSource;
    taskService: IZCodeTaskService;
    facts: ReadonlyArray<F>;
    signature: (fact: F) => string;
    persist: (pending: F[]) => Promise<ReadonlyArray<string>>;
  }): void {
    const { synced, resolved, taskService, facts, signature, persist } = args;
    const key = sourceKey(resolved.scope);
    let entry = synced.get(key);
    if (entry?.taskService !== taskService) {
      entry = { taskService, acknowledged: new Set(), inFlight: new Set() };
      synced.set(key, entry);
    }
    const { acknowledged, inFlight } = entry;
    // Facts already sent by an overlapping publish are excluded until that request settles.
    const pending = facts.filter((fact) => {
      const id = signature(fact);
      return !acknowledged.has(id) && !inFlight.has(id);
    });
    if (pending.length === 0) return;
    for (const fact of pending) inFlight.add(signature(fact));
    void persist(pending)
      .then((confirmed) => {
        for (const id of confirmed) acknowledged.add(id);
      })
      .catch((error) => {
        if (!disposed) options.onSourceError?.(resolved.scope, "refresh", error);
      })
      .finally(() => {
        for (const fact of pending) inFlight.delete(signature(fact));
      });
  }

  function sourceWorkspaceRequest(scope: WindowHostControllerSourceScope) {
    return {
      workspacePath: scope.workspacePath,
      ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
    };
  }

  // BUG-GWT-010 (docs/testing/git-worktree-qa/bugs/BUG-GWT-010.md): the execution-worktree fact reaches the
  // Host only through sessions-index summaries and used to live solely in the in-memory live overlay, so
  // sessions of closed workspaces lost the sidebar marker and Environment/Branch classification after a
  // restart. Converge the fact into the source's tasks-index meta at this boundary: the overlay stays the
  // freshness source, persisted meta becomes the durability source. Local scopes only — a remote workspace's
  // tasks-index belongs to its own host, whose controller converges the same facts there.
  function convergeExecutionWorktreeFacts(
    resolved: ResolvedWindowHostControllerSource,
    overlays: WindowHostControllerSessionOverlay[],
  ): void {
    if (resolved.scope.kind !== "local" || !resolved.taskService) return;
    const facts = overlays.flatMap((overlay) =>
      overlay.executionWorktree
        ? [{ taskId: overlay.taskId, executionWorktree: overlay.executionWorktree }]
        : [],
    );
    // An empty overlay (runtime restart gap) must not erase persisted facts; durability is meta's job.
    if (facts.length === 0) return;
    const taskService = resolved.taskService;
    const factSignature = (fact: (typeof facts)[number]) =>
      `${fact.taskId}\n${fact.executionWorktree.path}\n${fact.executionWorktree.branchName ?? ""}`;
    persistSourceFacts({
      synced: sourceWorktreeFactSynced,
      resolved,
      taskService,
      facts,
      signature: factSignature,
      persist: (pending) =>
        taskService
          .listTasks({ ...sourceWorkspaceRequest(resolved.scope), executionWorktreeFacts: pending })
          .then((tasks) => {
            // listTasks succeeding does not mean a fact was persisted: the repo skips facts whose task-index row
            // does not exist yet. Acknowledge only facts the returned rows now carry. Pinned/archived rows are
            // excluded from this read and are retried on the next publish; the repo checks the stored fact
            // read-only before taking the write lock, so that retry costs a list read, not a write transaction.
            const persisted = new Map(
              tasks.map((task) => [task.taskId, task.executionWorktree] as const),
            );
            return pending.flatMap((fact) => {
              const stored = persisted.get(fact.taskId);
              return stored?.path === fact.executionWorktree.path &&
                stored?.branchName === fact.executionWorktree.branchName
                ? [factSignature(fact)]
                : [];
            });
          }),
    });
  }

  // Incognito is frozen per session (specs/incognito-session.md), so the overlay's `true` is converged once into
  // meta_json and never cleared. Same ownership as the worktree fact: the overlay is the freshness source, the
  // persisted marker is the durability source that lets clients without a sessions-index observer show it.
  function convergeIncognitoFacts(
    resolved: ResolvedWindowHostControllerSource,
    overlays: WindowHostControllerSessionOverlay[],
  ): void {
    // Gate only on the owning tasks index: remote sources also carry a taskService and need the durable marker too.
    if (!resolved.taskService) return;
    const taskIds = overlays
      .filter((overlay) => overlay.incognito)
      .map((overlay) => overlay.taskId);
    if (taskIds.length === 0) return;
    const taskService = resolved.taskService;
    persistSourceFacts({
      synced: sourceIncognitoSynced,
      resolved,
      taskService,
      facts: taskIds,
      signature: (taskId) => taskId,
      // The repo confirms every id whose row carries the marker, including pinned and archived rows.
      persist: (pending) =>
        taskService.persistIncognitoMarkers({
          ...sourceWorkspaceRequest(resolved.scope),
          taskIds: pending,
        }),
    });
  }

  function ensureSourceSessionObserver(
    resolved: ResolvedWindowHostControllerSource,
  ): WindowHostSessionsIndexObserver | null {
    const key = sourceKey(resolved.scope);
    if (resolved.sourceAvailability !== "online") {
      return sourceSessionObservers.get(key)?.observer ?? null;
    }
    if (!resolved.agentService) {
      sourceSessionObservers.get(key)?.observer.dispose();
      sourceSessionObservers.delete(key);
      if (sourceLiveOverlays.delete(key)) {
        projection.replaceSourceSessionOverlays(resolved.scope, []);
      }
      return null;
    }
    const current = sourceSessionObservers.get(key);
    if (current?.agentService === resolved.agentService) return current.observer;
    current?.observer.dispose();
    if (sourceLiveOverlays.delete(key)) {
      projection.replaceSourceSessionOverlays(resolved.scope, []);
    }
    let observer!: WindowHostSessionsIndexObserver;
    observer = createWindowHostSessionsIndexObserver({
      agentService: resolved.agentService,
      target: {
        workspacePath: resolved.scope.workspacePath,
        ...(resolved.scope.workspaceIdentity
          ? { workspaceIdentity: resolved.scope.workspaceIdentity }
          : {}),
      },
      onSessionsChange: (sessions) => {
        if (sourceSessionObservers.get(key)?.observer !== observer) return;
        const overlays = sessions.map(sessionOverlay);
        sourceLiveOverlays.set(key, overlays);
        projection.replaceSourceSessionOverlays(resolved.scope, overlays);
        // Persist the freshly observed worktree facts after the live projection is updated, so a
        // convergence failure can never disturb the overlay path (BUG-GWT-010). Resolve the source again:
        // the captured `resolved.taskService` may have been replaced while the agent service stayed the same.
        const current = resolveCurrentSource(resolved.scope);
        if (current) {
          convergeExecutionWorktreeFacts(current, overlays);
          convergeIncognitoFacts(current, overlays);
        }
      },
      onError: (error) => options.onSourceError?.(resolved.scope, "refresh", error),
    });
    sourceSessionObservers.set(key, { agentService: resolved.agentService, observer });
    return observer;
  }

  function resolveCurrentSource(
    scope: WindowHostControllerSourceScope,
  ): ResolvedWindowHostControllerSource | null {
    return options.resolveSource({
      workspacePath: scope.workspacePath,
      ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
    });
  }

  async function executeMutation(
    scope: WindowHostControllerSourceScope,
    address: WindowHostTaskAddress,
    mutation: WindowHostControllerMutation,
  ): Promise<WindowHostControllerMutationResult> {
    const current = resolveCurrentSource(scope);
    if (!current?.taskService || current.sourceAvailability !== "online") {
      throw new Error(
        scope.kind === "remote" ? "远程 source 当前离线，禁止列表写操作" : "本地 source 当前不可用",
      );
    }
    const service = current.taskService;
    const base = mutationParams(address);
    switch (mutation.kind) {
      case "pin":
        await service.setTaskPinned({ ...base, pinned: mutation.pinned });
        break;
      case "archive":
        if (mutation.archived) {
          await service.archiveTask(base);
        } else {
          await service.unarchiveTask(base);
        }
        break;
      case "delete":
        await service.deleteTask(base);
        break;
      case "delete-archived":
        return service.deleteArchivedTask(base);
      case "delete-archived-batch":
        // The remote session may have been replaced while confirming; do not write a batch from the old address to a new source with the same identity.
        if (sourceKey(current.scope) !== sourceKey(scope)) {
          throw new Error("归档删除批次的 source 已替换");
        }
        return service.deleteArchivedTasks({
          workspacePath: base.workspacePath,
          workspaceIdentity: base.workspaceIdentity,
          taskIds: mutation.taskIds,
        });
      case "mark-read":
        await service.setTaskUnread({
          ...base,
          unread: false,
          ...(mutation.expectedUnreadAt != null
            ? { expectedUnreadAt: mutation.expectedUnreadAt }
            : {}),
        });
        break;
      case "mark-unread":
        await service.setTaskUnread({ ...base, unread: true });
        break;
      case "open":
      case "resume":
        // The Controller validates the unique source for open/resume; conversation operations still use the scoped facade.
        break;
      default: {
        const exhaustive: never = mutation;
        throw new Error(`未知 Controller mutation: ${String(exhaustive)}`);
      }
    }
  }

  function registerResolvedSource(resolved: ResolvedWindowHostControllerSource): void {
    assertOpen();
    const key = sourceKey(resolved.scope);
    if (!registeredScopes.has(key)) {
      if (options.maxSources !== undefined && registeredScopes.size >= options.maxSources) {
        throw new Error("Controller source limit exceeded");
      }
      registeredScopes.set(key, resolved.scope);
      projection.registerSource({
        scope: resolved.scope,
        mutate: (address, mutation) => executeMutation(resolved.scope, address, mutation),
      });
    }
    const previousAvailability = sourceAvailability.get(key);
    sourceAvailability.set(key, resolved.sourceAvailability);
    if (
      resolved.taskService &&
      sourceSnapshotTaskServices.has(key) &&
      sourceSnapshotTaskServices.get(key) !== resolved.taskService
    ) {
      sourceSnapshotTaskServices.delete(key);
    }
    if (
      resolved.taskService &&
      resolved.sourceAvailability === "online" &&
      typeof resolved.taskService.onDynamicWorkspaceEvent === "function" &&
      sourceTaskServices.get(key) !== resolved.taskService
    ) {
      sourceEventSubscriptions.get(key)?.dispose();
      sourceTaskServices.set(key, resolved.taskService);
      sourceEventSubscriptions.set(
        key,
        resolved.taskService.onDynamicWorkspaceEvent({
          workspacePath: resolved.scope.workspacePath,
          ...(resolved.scope.workspaceIdentity
            ? { workspaceIdentity: resolved.scope.workspaceIdentity }
            : {}),
        })(() => {
          // A workspace event may arrive while the first list refresh is reading; directly reusing
          // the single-flight would swallow the event. Wait for the in-flight read to finish, then merge events into the next refresh.
          const inFlight = sourceRefreshFlights.get(key)?.promise;
          void (async () => {
            await inFlight?.catch(() => {});
            if (disposed) return;
            const current = resolveCurrentSource(resolved.scope);
            if (current) await refreshSource(current, true);
          })().catch((error) => {
            if (!disposed) options.onSourceError?.(resolved.scope, "refresh", error);
          });
        }),
      );
    }
    if (resolved.sourceAvailability === "offline" && previousAvailability === "online") {
      sourceSessionObservers.get(key)?.observer.dispose();
      sourceSessionObservers.delete(key);
      sourceSnapshotTaskServices.delete(key);
      projection.disconnectSource(resolved.scope);
    }
  }

  async function readSourceTaskIndex(resolved: ResolvedWindowHostControllerSource) {
    if (!resolved.taskService || resolved.sourceAvailability !== "online") {
      throw new Error("Controller source 当前不可读取");
    }
    const request = {
      workspacePath: resolved.scope.workspacePath,
      ...(resolved.scope.workspaceIdentity
        ? { workspaceIdentity: resolved.scope.workspaceIdentity }
        : {}),
    };
    const [active, pinned, archived] = await Promise.all([
      resolved.taskService.listTasks(request),
      resolved.taskService.listPinnedTasks(request),
      resolved.taskService.listArchivedTasks(request),
    ]);
    const membershipByTaskKey = new Map<
      string,
      {
        meta: ZCodeTaskMeta;
        membership: { pinned: boolean; archived: boolean; active: boolean };
      }
    >();
    for (const task of active) {
      const normalized = normalizeTaskMeta(task, resolved.scope);
      membershipByTaskKey.set(taskKey(normalized), {
        meta: normalized,
        membership: { pinned: false, archived: false, active: true },
      });
    }
    for (const task of pinned) {
      const normalized = normalizeTaskMeta(task, resolved.scope);
      membershipByTaskKey.set(taskKey(normalized), {
        meta: normalized,
        membership: { pinned: true, archived: false, active: true },
      });
    }
    for (const task of archived) {
      const normalized = normalizeTaskMeta(task, resolved.scope);
      membershipByTaskKey.set(taskKey(normalized), {
        meta: normalized,
        membership: { pinned: false, archived: true, active: false },
      });
    }
    return Array.from(membershipByTaskKey.values());
  }

  async function refreshSource(
    resolved: ResolvedWindowHostControllerSource,
    force = false,
  ): Promise<void> {
    registerResolvedSource(resolved);
    if (!resolved.taskService || resolved.sourceAvailability !== "online") {
      return;
    }
    const key = sourceKey(resolved.scope);
    // Persisted rows must not wait for the Agent. Its independent observer publishes
    // live activity through Controller deltas when subscription startup finishes.
    void ensureSourceSessionObserver(resolved)
      ?.start()
      .catch((error) => {
        if (!disposed) options.onSourceError?.(resolved.scope, "refresh", error);
      });
    if (!force && sourceSnapshotTaskServices.get(key) === resolved.taskService) return;
    const existing = sourceRefreshFlights.get(key);
    if (existing?.taskService === resolved.taskService) return existing.promise;
    const generation = (sourceRefreshGenerations.get(key) ?? 0) + 1;
    sourceRefreshGenerations.set(key, generation);
    const promise = (async () => {
      const taskIndex = await readSourceTaskIndexBounded(resolved);
      assertOpen();
      if (sourceRefreshGenerations.get(key) !== generation) {
        throw new Error("Controller source refresh generation 已失效");
      }
      const previousScope = pendingReplacementByNextSourceKey.get(key);
      projection.replaceSourceSnapshot({
        scope: resolved.scope,
        ...(previousScope ? { replacesScope: previousScope } : {}),
        taskIndex,
        // Live facts remain in Host memory only; the observer uses existing-only, so listing does not start an Agent.
        sessionsIndex: sourceLiveOverlays.get(key) ?? [],
      });
      if (previousScope) {
        forgetRegisteredSource(previousScope);
        pendingReplacementByNextSourceKey.delete(key);
      }
      sourceAvailability.set(key, "online");
      sourceSnapshotTaskServices.set(key, resolved.taskService!);
    })();
    sourceRefreshFlights.set(key, { taskService: resolved.taskService, promise });
    try {
      await promise;
    } finally {
      if (sourceRefreshFlights.get(key)?.promise === promise) {
        sourceRefreshFlights.delete(key);
      }
    }
  }

  async function readSourceTaskIndexBounded(resolved: ResolvedWindowHostControllerSource) {
    const limit = options.maxConcurrentSourceRefreshes ?? Infinity;
    if (activeSourceReads >= limit) {
      await new Promise<void>((resolve) => sourceReadWaiters.push(resolve));
    } else {
      activeSourceReads += 1;
    }
    try {
      assertOpen();
      return await readSourceTaskIndex(resolved);
    } finally {
      // Transfer the reserved slot directly so a new request cannot overtake a waiter.
      const next = sourceReadWaiters.shift();
      if (next) next();
      else activeSourceReads -= 1;
    }
  }

  async function replaceDisconnectedSource(
    previousScope: WindowHostControllerSourceScope,
    resolved: ResolvedWindowHostControllerSource,
  ): Promise<void> {
    if (!resolved.taskService || resolved.sourceAvailability !== "online") {
      throw new Error("重连 source 尚未 online，不能替换离线投影");
    }
    registerResolvedSource(resolved);
    const previousKey = sourceKey(previousScope);
    const retainedPreviousScope =
      pendingReplacementByNextSourceKey.get(previousKey) ?? previousScope;
    if (sourceKey(retainedPreviousScope) !== previousKey) {
      // If repeated reconnects fail before the first snapshot, trusted rows still belong to an earlier source generation.
      // Remove intermediate empty sources and collapse the replacement chain to the last trusted scope so success does not leave an orphan projection.
      pendingReplacementByNextSourceKey.delete(previousKey);
      forgetRegisteredSource(previousScope);
      projection.removeSource(previousScope);
    }
    pendingReplacementByNextSourceKey.set(sourceKey(resolved.scope), retainedPreviousScope);
    await refreshSource(resolved, true);
  }

  function resolveQuerySources(
    scopes: ZCodeTaskListWorkspaceScope[],
  ): ResolvedWindowHostControllerSource[] {
    const resolved = new Map<string, ResolvedWindowHostControllerSource>();
    for (const scope of scopes) {
      const source = options.resolveSource(scope);
      if (!source) {
        continue;
      }
      resolved.set(sourceKey(source.scope), source);
    }
    if (
      options.maxSources !== undefined &&
      new Set([...registeredScopes.keys(), ...resolved.keys()]).size > options.maxSources
    ) {
      throw new Error("Controller source limit exceeded");
    }
    return Array.from(resolved.values());
  }

  async function listTaskList(
    query: ZCodeTaskListQuery,
  ): Promise<WindowHostControllerTaskListResult> {
    assertOpen();
    const resolvedSources = resolveQuerySources(query.workspaceScopes);
    const refreshErrors: unknown[] = [];
    await Promise.all(
      resolvedSources.map(async (source) => {
        try {
          await refreshSource(source);
        } catch (error) {
          refreshErrors.push(error);
          // A transient read failure in one remote source must not clear trusted projections from local or other remote sources.
          if (!disposed) options.onSourceError?.(source.scope, "refresh", error);
        }
      }),
    );
    assertOpen();
    // Keep trusted local/remote history on a partial refresh failure, but do not
    // acknowledge an uninitialized projection as a successfully empty list.
    if (
      refreshErrors.length > 0 &&
      !resolvedSources.some((source) => {
        const key = sourceKey(source.scope);
        return (
          sourceSnapshotTaskServices.has(key) ||
          pendingReplacementByNextSourceKey.has(key) ||
          projection
            .getTasks()
            .some(
              (row) =>
                row.address.workspacePath === source.scope.workspacePath &&
                row.address.workspaceIdentity === source.scope.workspaceIdentity &&
                row.address.remoteSessionId ===
                  (source.scope.kind === "remote" ? source.scope.remoteSessionId : undefined),
            )
        );
      })
    ) {
      throw refreshErrors[0];
    }

    const search = query.search?.trim();
    let items: WindowHostControllerTaskListItem[];
    if (search) {
      const results = await Promise.all(
        resolvedSources
          .filter((source) => source.sourceAvailability === "online" && source.taskService != null)
          .map(async (source) => {
            try {
              const result = await source.taskService!.listTaskList({
                ...query,
                workspaceScopes: [
                  {
                    workspacePath: source.scope.workspacePath,
                    ...(source.scope.workspaceIdentity
                      ? { workspaceIdentity: source.scope.workspaceIdentity }
                      : {}),
                  },
                ],
                limit: undefined,
              });
              return result.items.map((item) => {
                const normalized = normalizeTaskMeta(item, source.scope);
                const projected = projection
                  .getTasks()
                  .find(
                    (row) =>
                      row.address.taskId === normalized.taskId &&
                      row.address.workspacePath === normalized.workspacePath &&
                      row.address.workspaceIdentity === normalized.workspaceIdentity &&
                      row.address.remoteSessionId ===
                        (source.scope.kind === "remote" ? source.scope.remoteSessionId : undefined),
                  );
                return {
                  ...(projected?.meta ?? normalized),
                  ...(source.scope.kind === "remote"
                    ? { remoteSessionId: source.scope.remoteSessionId }
                    : {}),
                  sourceAvailability: "online" as const,
                  liveStatus: projected?.liveStatus ?? liveStatusFromMeta(normalized),
                  ...(projected?.executionWorktree
                    ? { executionWorktree: projected.executionWorktree }
                    : {}),
                  ...(projected?.executionWorktreeMissing !== undefined
                    ? { executionWorktreeMissing: projected.executionWorktreeMissing }
                    : {}),
                  ...(projected?.incognito ? { incognito: true } : {}),
                  ...(projected?.activity ? { activity: projected.activity } : {}),
                  ...(item.searchSnippets ? { searchSnippets: item.searchSnippets } : {}),
                };
              });
            } catch (error) {
              if (!disposed) options.onSourceError?.(source.scope, "search", error);
              return [];
            }
          }),
      );
      items = results.flat();
    } else {
      const selectedSources = new Set<string>();
      for (const source of resolvedSources) {
        const key = sourceKey(source.scope);
        selectedSources.add(key);
        const pendingPreviousScope = pendingReplacementByNextSourceKey.get(key);
        if (pendingPreviousScope) {
          // If the new source's first snapshot fails, keep showing the previous generation's trusted offline projection. Only a successful
          // replaceSourceSnapshot removes old rows and adds new rows in one delta frame.
          selectedSources.add(sourceKey(pendingPreviousScope));
        }
      }
      items = projection
        .getTasks()
        .filter((row) => {
          const scope: WindowHostControllerSourceScope = row.address.remoteSessionId
            ? {
                kind: "remote",
                remoteSessionId: row.address.remoteSessionId,
                workspacePath: row.address.workspacePath,
                workspaceIdentity: row.address.workspaceIdentity!,
              }
            : {
                kind: "local",
                workspacePath: row.address.workspacePath,
                ...(row.address.workspaceIdentity
                  ? { workspaceIdentity: row.address.workspaceIdentity }
                  : {}),
              };
          return (
            selectedSources.has(sourceKey(scope)) &&
            matchesTaskListMembershipKind(row.membership, query.kind)
          );
        })
        .map((row) => ({
          ...row.meta,
          ...(row.address.remoteSessionId ? { remoteSessionId: row.address.remoteSessionId } : {}),
          sourceAvailability: row.sourceAvailability,
          liveStatus: row.liveStatus,
          ...(row.executionWorktree ? { executionWorktree: row.executionWorktree } : {}),
          ...(row.executionWorktreeMissing !== undefined
            ? { executionWorktreeMissing: row.executionWorktreeMissing }
            : {}),
          ...(row.incognito ? { incognito: true } : {}),
          ...(row.worktreePreparation ? { worktreePreparation: row.worktreePreparation } : {}),
          ...(row.activity ? { activity: row.activity } : {}),
          ...(row.searchSnippets ? { searchSnippets: row.searchSnippets } : {}),
        }));
    }
    items.sort((left, right) => compareItems(left, right, query.sortBy));
    const total = items.length;
    const visible = query.limit == null ? items : items.slice(0, query.limit);
    return { items: visible, total, hasMore: total > visible.length };
  }

  function createAttachmentService(): IWindowControllerService & { dispose(): void } {
    const frameEmitter = new Emitter<WindowHostControllerFrame>();
    // Live-only unread signal (never replayed by snapshots). No producer is wired in the fork yet; the
    // unread mutation path still goes through setTaskUnread. Wiring it is part of the UI sidebar PR.
    const unreadSignalEmitter = new Emitter<WindowHostTaskUnreadSignal>();
    const subscriptions = new Map<string, { dispose(): void }>();
    return {
      listTaskList,
      async getTaskMeta({ address }) {
        // Projection-backed read; the owner-direct lookup needed for unread compare-and-swap is deferred.
        return (
          projection
            .getTasks()
            .find(
              (row) =>
                row.address.taskId === address.taskId &&
                row.address.workspacePath === address.workspacePath &&
                row.address.workspaceIdentity === address.workspaceIdentity &&
                row.address.remoteSessionId === address.remoteSessionId,
            )?.meta ?? null
        );
      },
      onDynamicTaskUnreadSignal() {
        return unreadSignalEmitter.event;
      },
      async deleteArchivedTasks({ address, taskIds }) {
        if (taskIds.length === 0) {
          return { deletedTaskIds: [], skippedTaskIds: [], failedTaskIds: [] };
        }
        const result = await projection.mutate(address, { kind: "delete-archived-batch", taskIds });
        if (!result || typeof result === "boolean") {
          throw new Error("归档删除批次未返回逐项目标结果");
        }
        const resolved = options.resolveSource({
          workspacePath: address.workspacePath,
          workspaceIdentity: address.workspaceIdentity,
        });
        if (resolved) {
          // Reconcile the projection only after the whole batch finishes, sharing a single-flight with one source event; refresh failure does not change committed results.
          await refreshSource(resolved, true).catch((error) =>
            options.onSourceError?.(resolved.scope, "refresh", error),
          );
        }
        return result;
      },
      async deleteArchivedTask({ address }) {
        const deleted = await projection.mutate(address, { kind: "delete-archived" });
        const resolved = options.resolveSource({
          workspacePath: address.workspacePath,
          workspaceIdentity: address.workspaceIdentity,
        });
        if (resolved) {
          // Deletion has already persisted successfully, so a failed list refresh must not report the deletion as failed; later events will refresh the projection.
          await refreshSource(resolved, true).catch((error) =>
            options.onSourceError?.(resolved.scope, "refresh", error),
          );
        }
        return deleted === true;
      },
      async mutateTask({ address, mutation }) {
        await projection.mutate(address, mutation as WindowHostControllerMutation);
        const resolved = options.resolveSource({
          workspacePath: address.workspacePath,
          ...(address.workspaceIdentity ? { workspaceIdentity: address.workspaceIdentity } : {}),
        });
        if (resolved) {
          await refreshSource(resolved, true);
        }
        return (
          projection
            .getTasks()
            .find(
              (row) =>
                row.address.taskId === address.taskId &&
                row.address.workspacePath === address.workspacePath &&
                row.address.workspaceIdentity === address.workspaceIdentity &&
                row.address.remoteSessionId === address.remoteSessionId,
            )?.meta ?? null
        );
      },
      async subscribeControllerV4(params: ControllerSubscribeParams) {
        assertOpen();
        const subscription = projection.subscribe({
          topic: params.topic,
          onFrame: (frame) => frameEmitter.fire(frame),
        });
        subscriptions.set(subscription.subscriptionId, subscription);
        return { ack: subscription.ack };
      },
      async resyncControllerV4(params) {
        assertOpen();
        return { ack: projection.resync(params.subscriptionId) };
      },
      async unsubscribeControllerV4(params) {
        subscriptions.get(params.subscriptionId)?.dispose();
        subscriptions.delete(params.subscriptionId);
      },
      onDynamicControllerFrame() {
        return frameEmitter.event;
      },
      dispose() {
        for (const subscription of subscriptions.values()) {
          subscription.dispose();
        }
        subscriptions.clear();
        frameEmitter.dispose();
        unreadSignalEmitter.dispose();
      },
    };
  }

  const service = createAttachmentService();
  return {
    service,
    createAttachmentService,
    replaceDisconnectedSource,
    async resolveTaskAddress(params: {
      taskId: string;
      workspacePath: string;
      workspaceIdentity?: string;
      attachmentScope?: import("@zcode/shared").WindowHostAttachmentScope;
      allowMissingTask?: boolean;
    }): Promise<WindowHostTaskAddress> {
      const remoteAttachmentScope =
        params.attachmentScope?.kind === "remote" ? params.attachmentScope : undefined;
      if (remoteAttachmentScope) {
        if (
          remoteAttachmentScope.workspacePath !== params.workspacePath ||
          remoteAttachmentScope.workspaceIdentity !== params.workspaceIdentity
        ) {
          throw new Error("列表 mutation 与 remote attachment scope 不匹配");
        }
      }
      const resolved = options.resolveSource({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      });
      if (
        remoteAttachmentScope &&
        (!resolved ||
          resolved.scope.kind !== "remote" ||
          resolved.scope.remoteSessionId !== remoteAttachmentScope.remoteSessionId ||
          resolved.scope.workspacePath !== remoteAttachmentScope.workspacePath ||
          resolved.scope.workspaceIdentity !== remoteAttachmentScope.workspaceIdentity)
      ) {
        throw new Error("列表 mutation 与 remote attachment source 不匹配");
      }
      if (resolved) {
        // Remote attachment previously returned the address directly and skipped source refresh. A newly bound
        // workspace had no projection row until the Controller list was read, causing the first unread/archive write to fail.
        // Materialize only a source validated with the full remoteSessionId + identity, preserving fail-closed behavior.
        await refreshSource(resolved);
      }
      const matches = projection
        .getTasks()
        .filter(
          (row) =>
            row.address.taskId === params.taskId &&
            row.address.workspacePath === params.workspacePath &&
            row.address.workspaceIdentity === params.workspaceIdentity &&
            (!remoteAttachmentScope ||
              row.address.remoteSessionId === remoteAttachmentScope.remoteSessionId),
        );
      if (matches.length !== 1) {
        if (matches.length === 0 && params.allowMissingTask && resolved) {
          // Conditional deletion lets the Repo idempotently skip a target already deleted by another client; source identity must still be fully validated.
          return {
            taskId: params.taskId,
            workspacePath: resolved.scope.workspacePath,
            ...(resolved.scope.workspaceIdentity
              ? { workspaceIdentity: resolved.scope.workspaceIdentity }
              : {}),
            ...(resolved.scope.kind === "remote"
              ? { remoteSessionId: resolved.scope.remoteSessionId }
              : {}),
          };
        }
        throw new Error(
          `列表 mutation 无法解析唯一 source，taskId=${params.taskId}, matches=${matches.length}`,
        );
      }
      return matches[0]!.address;
    },
    disconnectSource(scope: WindowHostControllerSourceScope): void {
      const key = sourceKey(scope);
      if (!registeredScopes.has(key) || sourceAvailability.get(key) === "offline") {
        return;
      }
      sourceAvailability.set(key, "offline");
      sourceRefreshGenerations.set(key, (sourceRefreshGenerations.get(key) ?? 0) + 1);
      sourceRefreshFlights.delete(key);
      sourceSessionObservers.get(key)?.observer.dispose();
      sourceSessionObservers.delete(key);
      sourceSnapshotTaskServices.delete(key);
      projection.disconnectSource(scope);
    },
    removeSource(scope: WindowHostControllerSourceScope): void {
      const key = sourceKey(scope);
      if (!registeredScopes.has(key)) {
        return;
      }
      const retainedPreviousScope = pendingReplacementByNextSourceKey.get(key);
      forgetRegisteredSource(scope);
      pendingReplacementByNextSourceKey.delete(key);
      for (const [nextKey, previousScope] of pendingReplacementByNextSourceKey) {
        if (sourceKey(previousScope) === key) {
          pendingReplacementByNextSourceKey.delete(nextKey);
        }
      }
      projection.removeSource(scope);
      if (retainedPreviousScope && sourceKey(retainedPreviousScope) !== key) {
        // Until a successful resync, the current logical session still borrows the previous generation's offline rows. Closing the current scope
        // also closes this history scope, so clear the retained projection as well.
        forgetRegisteredSource(retainedPreviousScope);
        projection.removeSource(retainedPreviousScope);
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      service.dispose();
      for (const scope of registeredScopes.values()) {
        projection.removeSource(scope);
      }
      for (const subscription of sourceEventSubscriptions.values()) {
        subscription.dispose();
      }
      registeredScopes.clear();
      sourceAvailability.clear();
      sourceTaskServices.clear();
      sourceSnapshotTaskServices.clear();
      sourceEventSubscriptions.clear();
      sourceRefreshFlights.clear();
      sourceRefreshGenerations.clear();
      for (const entry of sourceSessionObservers.values()) entry.observer.dispose();
      sourceSessionObservers.clear();
      sourceLiveOverlays.clear();
      pendingReplacementByNextSourceKey.clear();
    },
  };
}

/* eslint-disable max-lines -- Keep sharded workspace-task queries, cached display, and cross-platform membership subscription in one hook; splitting them would increase cache-consistency risk. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeWorkspaceEvent } from "@zcode/shared";
import { logger } from "@/logger.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeSessionStore, selectWorkspaceZCodeState } from "@/store/zcodeSessionStore.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import {
  buildTaskEntityKey,
  buildTaskListCacheDescriptor,
  buildTaskListCacheKeyFromDescriptor,
  buildTaskWorkspaceKey,
} from "@/lib/taskQueryCache.js";
import {
  markTaskQueryCacheScopesStale,
  useTaskQueryCacheStore,
} from "@/store/taskQueryCacheStore.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import {
  isRemoteWorkspaceTarget,
  resolveWorkspaceRemoteSessionId,
  resolveWorkspaceServices,
} from "@/lib/workspaceServiceResolver.js";
import { useWorkspaceTaskOptimisticOverlayByWorkspaceKey } from "@/hooks/workspaceTaskListOptimisticOverlay.js";
import {
  buildWorkspaceTaskListDisplayGroups,
  type WorkspaceTaskListGroup,
} from "@/hooks/workspaceTaskListDisplayGroups.js";
import {
  buildWorkspaceRemoteSessionSignature,
  buildWorkspaceTaskListVersionSignature,
} from "@/hooks/workspaceTaskListRefreshSignatures.js";
import { shouldRefetchTaskListMembershipForWorkspaceEvent } from "@/lib/taskListRefreshPolicy.js";
import { syncTaskUnreadFromStatusWorkspaceEvent } from "@/lib/taskStatusUnreadSync.js";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { fetchTaskListMembershipSetsForEndpointsCached } from "@/lib/taskListMembershipSets.js";
import { buildTaskListResult } from "@/v4/buildTaskListResultFromSessions.js";
import {
  bumpTaskListMembershipVersionForWorkspaceEvent,
  useTaskListMembershipVersion,
} from "@/v4/taskListMembershipVersion.js";
import {
  buildWorkspaceSessionsIndexSourceKey,
  useWorkspaceSessionsIndexItems,
} from "@/v4/useWorkspaceSessionsIndexItems.js";
import { resolveWorkspaceTaskVisibleLimit } from "@/lib/workspaceTaskPagination.js";

interface WorkspaceTaskListQueryConfig {
  scope: {
    workspacePath: string;
    workspaceIdentity?: string;
  };
  workspaceKey: string;
  remoteSessionId?: string;
  isRemoteWorkspace: boolean;
  visibleLimit: number;
  descriptor: ReturnType<typeof buildTaskListCacheDescriptor>;
  queryKey: string;
}

interface WorkspaceTaskListEndpointShard {
  shardKey: string;
  services: IServiceAccessor;
  configs: WorkspaceTaskListQueryConfig[];
}

interface WorkspaceTaskListGroupResult {
  workspacePath: string;
  workspaceIdentity?: string;
  items: ZCodeTaskMeta[];
  total: number;
  hasMore: boolean;
  unreadTaskKeys: string[];
}

interface WorkspaceTaskListRefreshFlight {
  requestId: number;
  signature: string;
  activityRevision: string;
  membershipVersion: number;
}

function updateBlockingLoadingState(
  current: Record<string, boolean>,
  blockingWorkspaceKeys: string[],
): Record<string, boolean> {
  const uniqueKeys = [...new Set(blockingWorkspaceKeys)];
  const currentKeys = Object.keys(current);
  if (
    currentKeys.length === uniqueKeys.length &&
    uniqueKeys.every((workspaceKey) => current[workspaceKey] === true)
  ) {
    return current;
  }
  return Object.fromEntries(uniqueKeys.map((workspaceKey) => [workspaceKey, true]));
}

// Workspace group results use tasks-index task rows as persisted records; sessions-index adds only activity/details.
// Remote shards use their own endpoint task service, which returns a group map shaped like the legacy protocol.
async function buildWorkspaceGroupsFromSessions(params: {
  service: IServiceAccessor["zcodeTaskService"];
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>;
  sessions: ZCodeTaskMeta[];
  sortBy: "created" | "updated";
  /** Incremental update: membership changes only with membershipVersion; cache by version so every content frame does not trigger another fetch. */
  membershipCacheKey: string;
}): Promise<Map<string, WorkspaceTaskListGroupResult>> {
  const {
    taskIndexItems,
    pinnedIds,
    archivedIds,
    deletedIds,
    unreadAtByTaskId,
    terminalStatusByTaskId,
    titleOverrideByTaskId,
    cronAutomationIdByTaskId,
  } = await fetchTaskListMembershipSetsForEndpointsCached({
    cacheKey: params.membershipCacheKey,
    endpoints: [{ service: params.service, scopes: params.scopes }],
  });
  const map = new Map<string, WorkspaceTaskListGroupResult>();
  for (const scope of params.scopes) {
    const scopeKey = buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity);
    const scopeSessions = params.sessions.filter(
      (task) => buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity) === scopeKey,
    );
    const scopeTaskIndexItems = taskIndexItems.filter(
      (task) => buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity) === scopeKey,
    );
    // The “workspace” view rule is !pinned && !archived, same as “timeline” (matchesTaskMembership).
    const result = buildTaskListResult({
      taskIndexItems: scopeTaskIndexItems,
      sessions: scopeSessions,
      kind: "timeline",
      pinnedIds,
      archivedIds,
      deletedIds,
      unreadAtByTaskId,
      terminalStatusByTaskId,
      titleOverrideByTaskId,
      cronAutomationIdByTaskId,
      sortBy: params.sortBy,
    });
    map.set(scopeKey, {
      workspacePath: scope.workspacePath,
      ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      items: result.items,
      total: result.total,
      hasMore: false,
      // Workspace tasks are paged before entering the query cache, so checking only visible items
      // would miss unread state in collapsed rows outside the current page. Freeze membership keys from the complete regular-task result first.
      unreadTaskKeys: result.items
        .filter((task) => typeof task.unreadAt === "number")
        .map((task) => buildTaskEntityKey(task)),
    });
  }
  return map;
}

/** Reference stabilization comes from the sessions-index aggregation layer: same item reference means equivalent content. Only workspaces containing items whose references differ between the two rounds are considered changed. */
function diffChangedWorkspaceKeys(previous: ZCodeTaskMeta[], next: ZCodeTaskMeta[]): Set<string> {
  const changed = new Set<string>();
  const previousSet = new Set(previous);
  const nextSet = new Set(next);
  for (const item of next) {
    if (!previousSet.has(item)) {
      changed.add(buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity));
    }
  }
  for (const item of previous) {
    if (!nextSet.has(item)) {
      changed.add(buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity));
    }
  }
  return changed;
}

function buildWorkspaceEventSubscriptionSignature(
  shards: WorkspaceTaskListEndpointShard[],
): string {
  return shards
    .map((shard) => {
      const workspaceKeys = [...new Set(shard.configs.map((config) => config.workspaceKey))].sort(
        (left, right) => left.localeCompare(right),
      );
      return `${shard.shardKey}:${workspaceKeys.join("|")}`;
    })
    .join("||");
}

export function useWorkspaceTaskLists(params: {
  workspaceTabs: WorkspaceTabState[];
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  sortBy: "created" | "updated";
  visibleLimitByWorkspaceKey: Readonly<Record<string, number>>;
  defaultVisibleLimit: number;
}) {
  const baseServices = useBaseWorkspaceServices();
  const sessionsById = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const sessionIdByWorkspaceIdentity = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspaceIdentity,
  );
  const sessionIdByWorkspacePath = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspacePath,
  );
  const serviceResolverState = useMemo(
    () => ({
      sessionsById,
      sessionIdByWorkspaceIdentity,
      sessionIdByWorkspacePath,
    }),
    [sessionIdByWorkspaceIdentity, sessionIdByWorkspacePath, sessionsById],
  );
  const setQueryResults = useTaskQueryCacheStore((state) => state.setQueryResults);
  const resultsByQueryKey = useTaskQueryCacheStore((state) => state.resultsByQueryKey);
  const taskMetaByEntityKey = useTaskQueryCacheStore((state) => state.taskMetaByEntityKey);
  const taskUnreadOverlayByEntityKey = useTaskQueryCacheStore(
    (state) => state.taskUnreadOverlayByEntityKey,
  );
  const inFlightRequestRef = useRef<WorkspaceTaskListRefreshFlight | null>(null);
  const nextRequestIdRef = useRef(0);
  const rerunRequestedRef = useRef(false);
  const groupCacheRef = useRef<Map<string, WorkspaceTaskListGroup>>(new Map());
  const taskListVersionSignature = useZCodeSessionStore((state) =>
    buildWorkspaceTaskListVersionSignature(
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
  const optimisticTaskOverlayByWorkspaceKey = useWorkspaceTaskOptimisticOverlayByWorkspaceKey(
    params.workspaceTabs,
  );
  const taskListVersionByWorkspaceKey = useMemo(
    () => new Map<string, number>(JSON.parse(taskListVersionSignature) as Array<[string, number]>),
    [taskListVersionSignature],
  );
  const remoteSessionSignature = useMemo(
    () =>
      buildWorkspaceRemoteSessionSignature(
        params.workspaceTabs.map((tab) => {
          const workspaceKey = buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity);
          const resolvedRemoteSessionId = resolveWorkspaceRemoteSessionId(
            tab,
            serviceResolverState,
          );
          return {
            workspaceKey,
            remoteSessionId: resolvedRemoteSessionId,
            ready: resolvedRemoteSessionId ? Boolean(sessionsById[resolvedRemoteSessionId]) : true,
          };
        }),
      ),
    [params.workspaceTabs, serviceResolverState, sessionsById],
  );
  const activeWorkspaceKey = useMemo(
    () => buildTaskWorkspaceKey(params.activeWorkspacePath, params.activeWorkspaceIdentity),
    [params.activeWorkspaceIdentity, params.activeWorkspacePath],
  );
  const activeWorkspaceRef = useRef({
    workspacePath: params.activeWorkspacePath,
    ...(params.activeWorkspaceIdentity
      ? { workspaceIdentity: params.activeWorkspaceIdentity }
      : {}),
  });
  // When switching workspaces, the old workspace keeps its own activeTaskId, and terminal subscriptions are
  // reused for each endpoint/workspace set. If the callback checks only that old activeTaskId or captures the
  // global focus from the first render, it can mistake a background task for one still being read and miss its unread marker.
  activeWorkspaceRef.current = {
    workspacePath: params.activeWorkspacePath,
    ...(params.activeWorkspaceIdentity
      ? { workspaceIdentity: params.activeWorkspaceIdentity }
      : {}),
  };
  const queryConfigs = useMemo(
    () =>
      params.workspaceTabs.map((tab) => {
        const scope = {
          workspacePath: tab.workspacePath,
          workspaceIdentity: tab.workspaceIdentity,
        };
        const resolvedRemoteSessionId = resolveWorkspaceRemoteSessionId(tab, serviceResolverState);
        const isRemoteWorkspace = isRemoteWorkspaceTarget(tab, resolvedRemoteSessionId);
        const workspaceKey = buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity);
        const visibleLimit = resolveWorkspaceTaskVisibleLimit(
          params.visibleLimitByWorkspaceKey,
          workspaceKey,
          params.defaultVisibleLimit,
        );
        const descriptor = buildTaskListCacheDescriptor({
          kind: "workspace",
          workspaceScopes: [scope],
          sortBy: params.sortBy,
          search: "",
          expanded: false,
          visibleLimit,
        });
        return {
          scope,
          workspaceKey,
          remoteSessionId: resolvedRemoteSessionId,
          isRemoteWorkspace,
          visibleLimit,
          descriptor,
          // Previously, each workspace group's queryKey included a version signature for all tabs.
          // Archiving a local task also changed every other workspace's queryKey and invalidated its cache;
          // with slower refreshes during remote connections, every local workspace could show No tasks yet.
          // Use only this workspace's version so unrelated workspaces are not cleared as a side effect.
          queryKey:
            buildTaskListCacheKeyFromDescriptor(descriptor) +
            `::version=${taskListVersionByWorkspaceKey.get(workspaceKey) ?? 0}`,
        };
      }),
    [
      params.defaultVisibleLimit,
      params.sortBy,
      params.visibleLimitByWorkspaceKey,
      params.workspaceTabs,
      serviceResolverState,
      taskListVersionByWorkspaceKey,
    ],
  );
  const endpointShards = useMemo(() => {
    const shardMap = new Map<
      string,
      {
        services: IServiceAccessor;
        configs: WorkspaceTaskListQueryConfig[];
      }
    >();

    for (const config of queryConfigs) {
      const resolvedServices = resolveWorkspaceServices(
        {
          ...config.scope,
          remoteSessionId: config.remoteSessionId,
        },
        baseServices,
        serviceResolverState,
      );
      if (!resolvedServices) {
        continue;
      }

      const shardKey = resolvedServices.remoteSessionId ?? "__base__";

      const shard = shardMap.get(shardKey) ?? {
        services: resolvedServices.services,
        configs: [],
      };
      shard.configs.push(config);
      shardMap.set(shardKey, shard);
    }

    return [...shardMap.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map<WorkspaceTaskListEndpointShard>(([shardKey, shard]) => ({
        shardKey,
        services: shard.services,
        configs: shard.configs,
      }));
  }, [baseServices, queryConfigs, serviceResolverState]);
  const endpointShardsRef = useRef(endpointShards);
  endpointShardsRef.current = endpointShards;
  const workspaceEventSubscriptionSignature = useMemo(
    () => buildWorkspaceEventSubscriptionSignature(endpointShards),
    [endpointShards],
  );
  // The list source is sessions-index. Remote shards (web, mobile remote control, and SSH workspaces) use it too:
  // each scope carries its endpoint dimension and that endpoint's agentService proxy. Tabs without a resolved
  // remote session (disconnected placeholders) are absent from endpointShards and get subscribed after reconnect.
  const sessionsIndexScopes = useMemo(
    () =>
      endpointShards.flatMap((shard) =>
        shard.configs.map((config) => ({
          workspacePath: config.scope.workspacePath,
          ...(config.scope.workspaceIdentity
            ? { workspaceIdentity: config.scope.workspaceIdentity }
            : {}),
          ...(shard.shardKey === "__base__" ? {} : { endpointKey: shard.shardKey }),
          agentService: shard.services.zcodeAgentService,
        })),
      ),
    [endpointShards],
  );
  const { items: sessionsIndexItems, sourceRevisionByScopeKey } =
    useWorkspaceSessionsIndexItems(sessionsIndexScopes);
  // Pin/archive membership version: bump after a mutation (local optimistic update or remote event) to trigger an authoritative re-filter.
  const membershipVersion = useTaskListMembershipVersion();
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const pendingConfigs = useMemo(() => {
    const pending = queryConfigs.filter((config) => {
      const cachedResult = resultsByQueryKey[config.queryKey];
      return cachedResult == null || cachedResult.stale;
    });
    const activePending = pending.filter((config) => config.workspaceKey === activeWorkspaceKey);
    if (activePending.length > 0) {
      // On cold start, querying every historical workspace at once competes with the active workspace's model
      // readState and can leave “Manage models / Loading” under the composer. Finish the active workspace's task
      // list and model state first, then fill other workspaces in the background after the current cache is saved.
      return activePending;
    }
    return pending;
  }, [activeWorkspaceKey, queryConfigs, resultsByQueryKey]);
  const sessionsIndexRevision = useMemo(
    () =>
      pendingConfigs
        .map((config) => {
          const sourceKey = buildWorkspaceSessionsIndexSourceKey({
            workspacePath: config.scope.workspacePath,
            ...(config.scope.workspaceIdentity
              ? { workspaceIdentity: config.scope.workspaceIdentity }
              : {}),
            ...(config.remoteSessionId ? { endpointKey: config.remoteSessionId } : {}),
          });
          return `${sourceKey}=${sourceRevisionByScopeKey[sourceKey] ?? "missing"}`;
        })
        .sort()
        .join("|"),
    [pendingConfigs, sourceRevisionByScopeKey],
  );
  const requestSignature = useMemo(
    () =>
      [
        params.sortBy,
        taskListVersionSignature,
        remoteSessionSignature,
        `activity=${sessionsIndexRevision}`,
        `membership=${membershipVersion}`,
        ...pendingConfigs.map(
          (config) =>
            `${config.workspaceKey}:${config.remoteSessionId ?? "base"}:limit=${config.visibleLimit}:${config.queryKey}:invalidation=${resultsByQueryKey[config.queryKey]?.invalidationVersion ?? 0}`,
        ),
      ].join("||"),
    [
      membershipVersion,
      pendingConfigs,
      params.sortBy,
      remoteSessionSignature,
      resultsByQueryKey,
      sessionsIndexRevision,
      taskListVersionSignature,
    ],
  );
  const latestRefreshInputRef = useRef({
    requestSignature,
    sessionsIndexRevision,
    membershipVersion,
  });
  latestRefreshInputRef.current = {
    requestSignature,
    sessionsIndexRevision,
    membershipVersion,
  };

  const refresh = useCallback(async () => {
    if (pendingConfigs.length === 0) {
      if (inFlightRequestRef.current === null) {
        setLoading((current) => updateBlockingLoadingState(current, []));
      }
      return;
    }

    const currentFlight = inFlightRequestRef.current;
    if (currentFlight) {
      if (currentFlight.signature !== requestSignature) {
        // While a membership RPC for the same list query is in flight, sessions-index may still transition from
        // running to completed/error. A single-flight keyed only by query signature would swallow the second
        // invalidation, so record that newer input arrived and rerun after the current flight settles.
        rerunRequestedRef.current = true;
      }
      return;
    }

    const requestId = ++nextRequestIdRef.current;
    const flight: WorkspaceTaskListRefreshFlight = {
      requestId,
      signature: requestSignature,
      activityRevision: sessionsIndexRevision,
      membershipVersion,
    };
    inFlightRequestRef.current = flight;
    const sessionsForRequest = sessionsIndexItems;
    const expectedInvalidationVersionByQueryKey = new Map(
      pendingConfigs.map((config) => [
        config.queryKey,
        resultsByQueryKey[config.queryKey]?.invalidationVersion ?? 0,
      ]),
    );
    // State/title changes in sessions-index mark existing queries stale and recalculate them in the background.
    // Stale results are safe to display; setting loading here would make the whole workspace row switch its
    // loading prop when clicking or restoring a historical task, and a hard invalidation could flash “Fetching tasks”.
    // Only first hydration with no cache is blocking; existing caches use stale-while-revalidate.
    const blockingWorkspaceKeys = pendingConfigs
      .filter((config) => {
        if (resultsByQueryKey[config.queryKey] != null) {
          return false;
        }
        const previousGroup = groupCacheRef.current.get(config.workspaceKey);
        return !previousGroup || (previousGroup.items.length === 0 && previousGroup.total === 0);
      })
      .map((config) => config.workspaceKey);
    setLoading((current) => updateBlockingLoadingState(current, blockingWorkspaceKeys));

    try {
      const pendingConfigKeys = new Set(pendingConfigs.map((config) => config.queryKey));
      const entries = (
        await Promise.all(
          endpointShards.map(async (shard) => {
            const shardConfigs = shard.configs.filter((config) =>
              pendingConfigKeys.has(config.queryKey),
            );
            if (shardConfigs.length === 0) {
              return [];
            }

            // Both local and remote shards use their endpoint's tasks-index as the item set, then enrich it with
            // sessions-index activity/details for the same endpoint and workspace.
            const groupByWorkspaceKey = await buildWorkspaceGroupsFromSessions({
              service: shard.services.zcodeTaskService,
              scopes: shardConfigs.map((config) => config.scope),
              sessions: sessionsForRequest,
              sortBy: params.sortBy,
              membershipCacheKey: `${membershipVersion}::workspace::${shard.shardKey}::${shardConfigs
                .map((config) => `${config.workspaceKey}@${taskListVersionSignature}`)
                .join("|")}`,
            });

            return shardConfigs.map((config) => {
              const group = groupByWorkspaceKey.get(config.workspaceKey) ?? {
                workspacePath: config.scope.workspacePath,
                workspaceIdentity: config.scope.workspaceIdentity,
                items: [],
                total: 0,
                hasMore: false,
                unreadTaskKeys: [],
              };
              const visibleItems = group.items.slice(0, config.visibleLimit);
              return {
                queryKey: config.queryKey,
                descriptor: config.descriptor,
                items: visibleItems,
                total: group.total,
                hasMore: group.total > visibleItems.length,
                unreadTaskKeys: group.unreadTaskKeys,
                expectedInvalidationVersion: expectedInvalidationVersionByQueryKey.get(
                  config.queryKey,
                ),
              };
            });
          }),
        )
      ).flat();

      // Previously each workspace queryKey wrote to the cache separately,
      // and the effect depended on all of resultsByQueryKey, so “write the first group, detect another missing group, refresh again” happened.
      // Batch writes into one cache update so a single query round creates one store update and stops the refresh loop.
      // A remote workspace’s task index is in remote SQLite; do not query local SQLite through base services.
      // Request by remoteSessionId shard; if the remote session is not registered, do not write an empty cache and retry automatically once it is available.
      const latestInput = latestRefreshInputRef.current;
      const canCommit =
        inFlightRequestRef.current?.requestId === requestId &&
        latestInput.requestSignature === flight.signature &&
        latestInput.sessionsIndexRevision === flight.activityRevision &&
        latestInput.membershipVersion === flight.membershipVersion;
      if (entries.length > 0 && canCommit) {
        setQueryResults(entries);
      } else if (!canCommit) {
        // Do not let stale activity/membership results update the entity cache or clear stale state; the latest round runs from finally.
        rerunRequestedRef.current = true;
      }
    } catch (error) {
      logger.error("[useWorkspaceTaskLists] 加载 workspace task 列表失败", error);
    } finally {
      if (inFlightRequestRef.current?.requestId === requestId) {
        inFlightRequestRef.current = null;
        setLoading((current) => updateBlockingLoadingState(current, []));
        const latestInput = latestRefreshInputRef.current;
        const shouldRerun =
          rerunRequestedRef.current ||
          latestInput.requestSignature !== flight.signature ||
          latestInput.sessionsIndexRevision !== flight.activityRevision ||
          latestInput.membershipVersion !== flight.membershipVersion;
        rerunRequestedRef.current = false;
        if (shouldRerun) {
          setRefreshTrigger((generation) => generation + 1);
        }
      }
    }
  }, [
    endpointShards,
    membershipVersion,
    pendingConfigs,
    params.sortBy,
    requestSignature,
    resultsByQueryKey,
    sessionsIndexItems,
    sessionsIndexRevision,
    setQueryResults,
  ]);
  useEffect(() => {
    if (pendingConfigs.length === 0) {
      return;
    }

    void refresh();
  }, [pendingConfigs.length, refresh, refreshTrigger, requestSignature]);

  // A sessions-index list update or pin/archive membership-version change marks the local scope cache stale,
  // triggering the refresh above to recompute with new data. sessions-index is a low-frequency conflated list event, not a high-frequency snapshot.
  // Prevent a loop: marking the cache stale triggers rerendering; if the parent recreates the workspaceTabs array on every render,
  // the scope-array identity also changes. React only to real changes in item references or membership version to avoid a setState loop.
  const lastSessionsRefreshRef = useRef<{
    items: ZCodeTaskMeta[];
    membershipVersion: number;
  } | null>(null);
  useEffect(() => {
    if (sessionsIndexScopes.length === 0) {
      return;
    }
    const last = lastSessionsRefreshRef.current;
    if (last && last.items === sessionsIndexItems && last.membershipVersion === membershipVersion) {
      return;
    }
    const membershipChanged = !last || last.membershipVersion !== membershipVersion;
    const previousItems = last?.items ?? null;
    lastSessionsRefreshRef.current = {
      items: sessionsIndexItems,
      membershipVersion,
    };
    if (membershipChanged || previousItems === null) {
      markTaskQueryCacheScopesStale(sessionsIndexScopes);
      return;
    }
    // The sessions-index aggregation layer already stabilizes references: unchanged item reference means equivalent content.
    // Previously every frame marked every workspace row cache stale and refetched them all,
    // making “open/close one task” reload the left-side lists for every workspace.
    // Diff actual workspace changes and mark only the corresponding scope stale.
    const changedWorkspaceKeys = diffChangedWorkspaceKeys(previousItems, sessionsIndexItems);
    if (changedWorkspaceKeys.size === 0) {
      return;
    }
    const changedScopes = sessionsIndexScopes.filter((scope) =>
      changedWorkspaceKeys.has(buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity)),
    );
    if (changedScopes.length > 0) {
      markTaskQueryCacheScopesStale(changedScopes);
    }
  }, [sessionsIndexItems, membershipVersion, sessionsIndexScopes]);

  useEffect(() => {
    const subscribedEndpointShards = endpointShardsRef.current;
    if (subscribedEndpointShards.length === 0) {
      return;
    }

    const disposables: Array<{ dispose(): void }> = [];
    for (const shard of subscribedEndpointShards) {
      const configByWorkspaceKey = new Map(
        shard.configs.map((config) => [config.workspaceKey, config]),
      );

      for (const config of configByWorkspaceKey.values()) {
        const disposable = shard.services.zcodeTaskService.onDynamicWorkspaceEvent({
          workspacePath: config.scope.workspacePath,
          ...(config.scope.workspaceIdentity
            ? { workspaceIdentity: config.scope.workspaceIdentity }
            : {}),
        })((event: ZCodeWorkspaceEvent) => {
          if (event.type !== "workspace_task_list_changed") {
            return;
          }
          const eventWorkspaceKey = buildTaskWorkspaceKey(
            event.workspacePath,
            event.workspaceIdentity,
          );
          if (eventWorkspaceKey !== config.workspaceKey) {
            return;
          }
          syncTaskUnreadFromStatusWorkspaceEvent({
            activeWorkspace: activeWorkspaceRef.current,
            event,
            service: shard.services.zcodeTaskService,
          });
          if (!shouldRefetchTaskListMembershipForWorkspaceEvent(event)) {
            return;
          }

          // When Web remote control archives/pins a task, the desktop workspace row has no local optimistic mutation.
          // Listen only for low-frequency membership events and invalidate the matching workspace query; do not refetch the whole table on message-stream events.
          logger.info(
            `[useWorkspaceTaskLists] 收到无法增量处理的 workspace_task_list_changed，刷新 workspace 行 workspace=${config.scope.workspacePath} reason=${event.reason}`,
          );
          // Pin/archive/unread membership is persisted in tasks-index and is invisible to sessions-index.
          // Membership events (also emitted by local mutations; unread/rename use task_meta_changed) bump the
          // version so derived lists reload their membership join. useGlobalTaskList also forwards and bumps the
          // same event through its shared subscription; deduplicate by event content so it triggers one global reload.
          bumpTaskListMembershipVersionForWorkspaceEvent(event);
          markTaskQueryCacheScopesStale([config.scope]);
        });
        disposables.push(disposable);
      }
    }

    return () => {
      for (const disposable of disposables) {
        disposable.dispose();
      }
    };
  }, [workspaceEventSubscriptionSignature]);

  const groups = useMemo(() => {
    const result = buildWorkspaceTaskListDisplayGroups({
      queryConfigs,
      resultsByQueryKey,
      taskMetaByEntityKey,
      taskUnreadOverlayByEntityKey,
      optimisticTaskOverlayByWorkspaceKey,
      previousGroupsByWorkspaceKey: groupCacheRef.current,
      sortBy: params.sortBy,
    });
    groupCacheRef.current = result.cache;
    return result.groups;
  }, [
    optimisticTaskOverlayByWorkspaceKey,
    params.sortBy,
    queryConfigs,
    resultsByQueryKey,
    taskMetaByEntityKey,
    taskUnreadOverlayByEntityKey,
  ]);

  return {
    groups,
    loadingByWorkspaceKey: loading,
    refresh,
  };
}

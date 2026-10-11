// Aggregate sessions from several workspace scopes into reactive ZCodeTaskMeta[]
// for live activity/detail input to sidebar lists; tasks-index provides the persisted row set.
// Shared by multiple consumers: sessionsIndexRegistry reference-counts subscriptions for the same endpoint+workspace.
// Each scope carries an endpoint dimension and that endpoint's agentService (from resolveWorkspaceServices);
// remote shards (web/mobile remote control/SSH workspace) use the same sessions-index path through the @zcode/rpc proxy.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import { mapSessionSummaryToTaskMeta } from "@/v4/mapSessionSummaryToTaskMeta.js";
import {
  buildTaskListItemIdentityKey,
  stabilizeTaskListItems,
} from "@/v4/taskListItemStabilization.js";
import {
  LOCAL_SESSIONS_INDEX_ENDPOINT,
  buildSessionsIndexEntryKey,
  type SessionsIndexAgentService,
  type SessionsIndexScope,
} from "@/v4/sessionsIndexRegistry.js";
import type { SessionsIndexStore } from "@/v4/sessionsIndexStore.js";
import {
  WorkspaceSessionsIndexSubscriptionSet,
  type WorkspaceSessionsIndexBinding,
} from "@/v4/workspaceSessionsIndexSubscriptionSet.js";

export interface WorkspaceSessionsIndexScope {
  workspacePath: string;
  workspaceIdentity?: string;
  /** Endpoint dimension (remoteSessionId for a remote shard); defaults to local __base__. */
  endpointKey?: string;
  /** Agent service for the scope's endpoint (from resolveWorkspaceServices); defaults to base services. */
  agentService?: SessionsIndexAgentService;
}

export interface WorkspaceSessionsIndexItemsResult {
  /** Aggregated session metadata (running first; remaining entries sorted by updatedAt descending; tick-driven recomputation with stable references). */
  items: ZCodeTaskMeta[];
  /**
   * Read-only generation for each endpoint + workspace scope. Includes service binding and the store's
   * logEpoch/seq so asynchronous tasks-index membership joins can reject stale activity snapshots precisely.
   */
  sourceRevisionByScopeKey: Readonly<Record<string, string>>;
  /**
   * Endpoints already subscribed but not yet sent their first snapshot (`"__base__"` or remoteSessionId).
   * Consumers use this to keep loading/syncing indicators visible instead of treating a remote list as empty before its first frame arrives.
   */
  hydratingEndpointKeys: string[];
}

/** Workspace reuse key = services resolveWorkspaceKey semantics (identity ?? path). */
function workspaceKeyOf(scope: WorkspaceSessionsIndexScope): string {
  return scope.workspaceIdentity?.trim() || scope.workspacePath;
}

function entryKeyOf(scope: WorkspaceSessionsIndexScope): string {
  return buildSessionsIndexEntryKey({
    workspaceKey: workspaceKeyOf(scope),
    ...(scope.endpointKey ? { endpointKey: scope.endpointKey } : {}),
  });
}

export function buildWorkspaceSessionsIndexSourceKey(
  scope: Pick<WorkspaceSessionsIndexScope, "workspacePath" | "workspaceIdentity" | "endpointKey">,
): string {
  return entryKeyOf(scope);
}

function toRegistryScope(scope: WorkspaceSessionsIndexScope): SessionsIndexScope {
  return {
    workspaceKey: workspaceKeyOf(scope),
    workspacePath: scope.workspacePath,
    ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
    ...(scope.endpointKey ? { endpointKey: scope.endpointKey } : {}),
  };
}

function buildScopeBindingKey(
  scope: WorkspaceSessionsIndexScope,
  agentService: SessionsIndexAgentService,
): string {
  return `${buildSessionsIndexEntryKey(toRegistryScope(scope), agentService)}\0path:${scope.workspacePath}`;
}

/** Store has no snapshot yet (connecting/first frame pending); error is not hydrating, avoiding permanent loading. */
function isHydratingStore(store: SessionsIndexStore): boolean {
  return (
    store.getState().workspaceId === null &&
    (store.getStatus() === "idle" || store.getStatus() === "connecting")
  );
}

/**
 * Subscribe to the sessions-index for given workspace scopes and aggregate ZCodeTaskMeta[] (running first, remaining entries by updatedAt descending).
 * Lifecycle: when the scope set changes, acquire/release shared stores by reference count; recompute whenever any store changes.
 * sessions-index changes are conflated low-frequency list events, not high-frequency snapshots.
 */
export function useWorkspaceSessionsIndexItems(
  scopes: WorkspaceSessionsIndexScope[],
): WorkspaceSessionsIndexItemsResult {
  const baseServices = useBaseWorkspaceServices();
  const baseAgentService = baseServices.zcodeAgentService;

  // Stabilize the scope signature to avoid coordinating again on every render; effects/memos use a ref to read the latest equivalent scopes.
  // Changes to endpointKey, workspacePath, or agentService generation produce a new signature.
  const signature = useMemo(
    () =>
      scopes
        .map((scope) => {
          const agentService = scope.agentService ?? baseAgentService;
          return agentService
            ? buildScopeBindingKey(scope, agentService)
            : `${entryKeyOf(scope)} ${scope.workspacePath} service-unavailable`;
        })
        .sort()
        .join("|"),
    [scopes, baseAgentService],
  );
  const scopesRef = useRef(scopes);
  scopesRef.current = scopes;

  // Tick: increment on any store change to recompute the aggregate memo.
  const [tick, setTick] = useState(0);
  const bumpTick = useCallback(() => setTick((n) => n + 1), []);
  const subscriptionSetRef = useRef<WorkspaceSessionsIndexSubscriptionSet | null>(null);
  if (subscriptionSetRef.current === null) {
    subscriptionSetRef.current = new WorkspaceSessionsIndexSubscriptionSet(bumpTick);
  }
  const subscriptionSet = subscriptionSetRef.current;

  useEffect(() => {
    const bindings: WorkspaceSessionsIndexBinding[] = [];
    for (const scope of scopesRef.current) {
      // Defensive: tests/fallback environments may lack zcodeAgentService (the sessions-index transport); do not subscribe to this scope then.
      const agentService = scope.agentService ?? baseAgentService;
      if (!agentService) {
        continue;
      }
      bindings.push({ scope: toRegistryScope(scope), agentService });
    }
    subscriptionSet.reconcile(bindings);
    // The signature covers changes to scopes, endpoint, workspacePath, and service generation;
    // reconcile acquires/releases only bindings that actually changed.
  }, [signature, baseAgentService, subscriptionSet]);

  useEffect(
    () => () => {
      subscriptionSet.dispose();
    },
    [subscriptionSet],
  );

  // Aggregate sessions from each store → ZCodeTaskMeta + hydration status (tick-driven recomputation with stable references).
  const previousItemsRef = useRef<ZCodeTaskMeta[]>([]);
  const previousHydratingRef = useRef<string[]>([]);
  return useMemo(() => {
    const metas: ZCodeTaskMeta[] = [];
    const hydratingEndpointKeys = new Set<string>();
    const sourceRevisionByScopeKey: Record<string, string> = {};
    const previousByKey = new Map(
      previousItemsRef.current.map((meta) => [buildTaskListItemIdentityKey(meta), meta]),
    );
    for (const scope of scopesRef.current) {
      const sourceKey = entryKeyOf(scope);
      const agentService = scope.agentService ?? baseAgentService;
      const bindingRevision = agentService
        ? buildScopeBindingKey(scope, agentService)
        : `${sourceKey} service-unavailable`;
      const store = subscriptionSet.getStore({
        workspaceKey: workspaceKeyOf(scope),
        ...(scope.endpointKey ? { endpointKey: scope.endpointKey } : {}),
      });
      if (!store) {
        sourceRevisionByScopeKey[sourceKey] = `${bindingRevision}:missing`;
        continue;
      }
      const storeState = store.getState();
      sourceRevisionByScopeKey[sourceKey] =
        `${bindingRevision}:${storeState.logEpoch ?? "none"}:${storeState.seq}:${store.getStatus()}`;
      if (isHydratingStore(store)) {
        hydratingEndpointKeys.add(scope.endpointKey ?? LOCAL_SESSIONS_INDEX_ENDPOINT);
      }
      for (const summary of store.getSessions()) {
        metas.push(
          mapSessionSummaryToTaskMeta(summary, {
            workspacePath: scope.workspacePath,
            ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
            previous: previousByKey.get(buildSummaryIdentityKey(scope, summary.sessionId)),
          }),
        );
      }
    }
    metas.sort((a, b) => compareZCodeTaskListItems(a, b, "updated"));
    // Every tick rebuilt all metadata even when content had not changed (for example, cold recovery replacing a seed with
    // a live projection that changes only the unused preview field). Downstream code treats a "new array reference" as new data:
    // the grouped view refreshes its whole tree, workspace-row caches are invalidated, and every list republishes—
    // making the left sidebar reload when opening an old task. Stabilize references item by item:
    // reuse old objects for equivalent content and reuse the whole array when the table is equivalent, short-circuiting effects that depend on array identity.
    const items = stabilizeTaskListItems(previousItemsRef.current, metas);
    previousItemsRef.current = items;
    const nextHydrating = [...hydratingEndpointKeys].sort();
    const hydrating =
      nextHydrating.length === previousHydratingRef.current.length &&
      nextHydrating.every((key, index) => key === previousHydratingRef.current[index])
        ? previousHydratingRef.current
        : nextHydrating;
    previousHydratingRef.current = hydrating;
    return {
      items,
      sourceRevisionByScopeKey,
      hydratingEndpointKeys: hydrating,
    };
  }, [signature, subscriptionSet, tick]);
}

function buildSummaryIdentityKey(scope: WorkspaceSessionsIndexScope, sessionId: string): string {
  return `${scope.workspaceIdentity?.trim() || scope.workspacePath}::${sessionId}`;
}

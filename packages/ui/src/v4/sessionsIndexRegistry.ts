// Reference-counted SessionsIndexStore registry keyed by endpoint + workspaceKey—the foundation for parallel subscriptions from multiple panes/lists:
// multiple consumers of the same endpoint and workspace share one sessions-index subscription. Consumers such as useGlobalTaskList,
// which handle a workspace-scope array when the sidebar switches data sources and cannot call a hook per scope, use this registry.
// It mirrors SessionDataLayer's per-session acquire/release. The reuse key includes endpoint: remote shards (web/mobile remote control/SSH workspace)
// access sessions-index through each endpoint's agentService proxy, so stores cannot be shared across endpoints even when workspaceKey matches.
import type { IZCodeAgentService } from "@zcode/services";
import { logger } from "@/logger.js";
import { remoteAgentServiceGeneration } from "@/lib/remoteAgentServiceGeneration.js";
import { findRemoteWorkspaceSessionIdForAgentService } from "@/store/remoteWorkspaceSessionStore.js";
import { createAgentSessionsIndexTransport } from "@/v4/agentSessionsIndexTransport.js";
import { SessionsIndexStore } from "@/v4/sessionsIndexStore.js";

/** Narrow agentService interface required by the registry (= transport dependency surface, convenient for test injection). */
export type SessionsIndexAgentService = Pick<
  IZCodeAgentService,
  | "subscribeSessionsIndexV4"
  | "resyncSessionsIndexV4"
  | "helloConversationV4"
  | "initializeConversationV4"
  | "unsubscribeSessionsIndexV4"
  | "onDynamicSessionsIndexFrame"
  | "onAgentRuntimeRestarted"
>;

interface RegistryEntry {
  key: string;
  agentService: SessionsIndexAgentService;
  agentServiceGeneration: number;
  store: SessionsIndexStore;
  refCount: number;
}

const registry = new Map<string, RegistryEntry>();
const entriesByStore = new WeakMap<SessionsIndexStore, RegistryEntry>();
/** Scopes with a reported endpoint mismatch; repeated acquire for the same scope (rerender/multiple consumers) logs only once. */
const reportedScopeEndpointMismatches = new Set<string>();

/** Reserved key for the local endpoint (matching task-list shardKey semantics). */
export const LOCAL_SESSIONS_INDEX_ENDPOINT = "__base__";

export interface SessionsIndexScope {
  /** Workspace reuse key (= services resolveWorkspaceKey semantics: workspaceIdentity ?? workspacePath). */
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  /** Endpoint dimension: remoteSessionId for remote shards; defaults to local __base__. */
  endpointKey?: string;
}

/**
 * Diagnostics: the endpoint declared by the scope must match the remote session that owns agentService. Otherwise the same remote
 * workspace is registered twice and sends two subscriptions to the same topic, while the CLI keeps only the latest per connection/topic—the earlier
 * subscription is silently replaced, and the sidebar stops receiving frames with no error. These key mismatches
 * (for example, Root dropping remoteSessionId when a Settings tab overrides it) leave no renderer trace in production logs and can only be inferred from
 * RPC fingerprints. Record them on the lifecycle channel so users can see them directly in logs. Log only; do not rewrite the key.
 */
function reportScopeEndpointMismatch(
  scope: SessionsIndexScope,
  agentService: SessionsIndexAgentService,
): void {
  const remoteSessionId = findRemoteWorkspaceSessionIdForAgentService(agentService);
  if (!remoteSessionId) return;
  const endpointKey = scope.endpointKey ?? LOCAL_SESSIONS_INDEX_ENDPOINT;
  if (endpointKey === remoteSessionId) return;
  const reportKey = `${endpointKey}\0${scope.workspaceKey}\0${remoteSessionId}`;
  if (reportedScopeEndpointMismatches.has(reportKey)) return;
  reportedScopeEndpointMismatches.add(reportKey);
  logger.lifecycle.warn("[v4-sessions-index] scope endpoint 与远程代理归属不一致", {
    event: "v4.sessions_index.scope_endpoint_mismatch",
    endpointKey,
    remoteSessionId,
    workspaceKey: scope.workspaceKey,
    workspacePath: scope.workspacePath,
  });
}

function createSessionsIndexTransport(
  scope: SessionsIndexScope,
  agentService: SessionsIndexAgentService,
) {
  const workspaceIdentity = scope.workspaceIdentity?.trim();
  return createAgentSessionsIndexTransport(agentService, {
    workspacePath: scope.workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  });
}

/** Registry entry key = endpoint + workspaceKey (different endpoints do not share a store even with the same workspaceKey). */
export function buildSessionsIndexEntryKey(
  scope: Pick<SessionsIndexScope, "workspaceKey" | "endpointKey">,
  agentService?: SessionsIndexAgentService,
): string {
  const entryKey = `${scope.endpointKey ?? LOCAL_SESSIONS_INDEX_ENDPOINT}\0${scope.workspaceKey}`;
  return agentService
    ? `${entryKey}\0service-generation:${remoteAgentServiceGeneration(agentService)}`
    : entryKey;
}

/** Get or create the shared sessions-index store for an endpoint+workspace and increment refCount (the first acquire starts the subscription). */
export function acquireSessionsIndex(
  scope: SessionsIndexScope,
  agentService: SessionsIndexAgentService,
): SessionsIndexStore {
  reportScopeEndpointMismatch(scope, agentService);
  const entryKey = buildSessionsIndexEntryKey(scope);
  const incomingServiceGeneration = remoteAgentServiceGeneration(agentService);
  const existing = registry.get(entryKey);
  if (existing?.agentService === agentService) {
    existing.refCount += 1;
    return existing.store;
  }
  if (
    existing &&
    (scope.endpointKey ?? LOCAL_SESSIONS_INDEX_ENDPOINT) !== LOCAL_SESSIONS_INDEX_ENDPOINT
  ) {
    existing.refCount += 1;
    // During remote RPC proxy replacement, different React consumers may briefly hold old and new services.
    // The CLI keeps only the latest subscription per connection/topic; if a second store is created here, the old store
    // will continue to show a live/empty snapshot but never receive frames. Reuse the same store for a remote scope and switch transport
    // serially in one direction by service generation; a late old consumer cannot switch transport back.
    if (incomingServiceGeneration > existing.agentServiceGeneration) {
      existing.agentService = agentService;
      existing.agentServiceGeneration = incomingServiceGeneration;
      const transport = createSessionsIndexTransport(scope, agentService);
      // subscribe on any intermediate proxy may remain pending forever, so replacement cannot queue behind
      // the previous I/O. The store generation synchronously detaches the old transport and invalidates late results.
      void existing.store.replaceTransport(transport).catch((error) => {
        logger.warn("[v4-sessions-index] remote transport replacement failed", error);
      });
    }
    return existing.store;
  }
  if (existing) {
    // Local __base__ retains its original lifecycle: create a new store when the service instance changes. Existing consumers
    // release by store identity during cleanup and cannot decrement the new entry's refCount by mistake.
    registry.delete(entryKey);
    if (existing.refCount <= 0) {
      existing.store.close();
      entriesByStore.delete(existing.store);
    }
  }
  const store = new SessionsIndexStore();
  const transport = createSessionsIndexTransport(scope, agentService);
  // Initial subscribe may remain pending forever after the old RPC proxy is destroyed. The replacement queue cannot
  // wait for that old I/O; replaceTransport invalidates late results using the store generation.
  void store.connect(transport, { forceSnapshot: true });
  const entry: RegistryEntry = {
    key: entryKey,
    agentService,
    agentServiceGeneration: incomingServiceGeneration,
    store,
    refCount: 1,
  };
  registry.set(entryKey, entry);
  entriesByStore.set(store, entry);
  return store;
}

/** Decrement refCount; when it reaches zero, close and remove the store (unsubscribe + detach listeners). */
export function releaseSessionsIndex(
  scope: Pick<SessionsIndexScope, "workspaceKey" | "endpointKey">,
  store: SessionsIndexStore,
): void {
  const entryKey = buildSessionsIndexEntryKey(scope);
  const entry = entriesByStore.get(store);
  if (!entry || entry.key !== entryKey) return;
  entry.refCount -= 1;
  if (entry.refCount <= 0) {
    entry.store.close();
    entriesByStore.delete(entry.store);
    if (registry.get(entryKey) === entry) registry.delete(entryKey);
  }
}

// Conversation connection registry reused by endpoint + workspaceKey (reference-counted + keep-warm)
//—the connection layer for split panes across workspaces.
// Multiple panes for the same endpoint and workspace share one transport + one SessionDataLayer
// (multiple panes for one session are consolidated by the layer’s per-topic refCount into a single subscription, avoiding CLI
// (connectionId, topic) resubscription/replacement). Structurally like sessionsIndexRegistry, with two additions:
// - 30s keep-warm: do not dispose immediately when refCount reaches zero (prevents churn when panes open/close or layout changes);
// - when agentService changes generation, remote entries retain layer/transport identity and switch one-way to the latest proxy;
// the local __base__ entry is rebuilt with the new service.
import type { IZCodeAgentService } from "@zcode/services";
import { createAgentConversationTransport } from "@/v4/agentConversationTransport.js";
import { remoteAgentServiceGeneration } from "@/lib/remoteAgentServiceGeneration.js";
import { ReplaceableConversationTransport } from "@/v4/replaceableConversationTransport.js";
import { SessionDataLayer } from "@/v4/sessionDataLayer.js";
import type { ConversationTransport } from "@/v4/transport.js";
import { logger } from "@/logger.js";

/** Narrow agentService surface required by the registry (= dependencies of the conversation transport; supports test injection). */
export type WorkspaceConnectionAgentService = Pick<
  IZCodeAgentService,
  | "helloConversationV4"
  | "initializeConversationV4"
  | "subscribeConversationV4"
  | "resyncConversationV4"
  | "unsubscribeConversationV4"
  | "sendConversationCommandV4"
  | "queryConversationCommandsV4"
  | "conversationRowsRangeV4"
  | "conversationPlansV4"
  | "conversationWorkflowRunEventsV4"
  | "conversationWorkflowRunsV4"
  | "conversationWorkflowRunArtifactsV4"
  | "conversationWorkflowRunArtifactDataV4"
  | "conversationWorkflowRunArtifactReadV4"
  | "conversationWorkflowRunWorkspaceV4"
  | "conversationWorkflowRunNodeResultV4"
  | "conversationFileChangesV4"
  | "conversationFileRewindPreviewV4"
  | "attachmentBeginV4"
  | "attachmentChunkV4"
  | "attachmentCommitV4"
  | "attachmentAbortV4"
  | "attachmentPreviewSourceV4"
  | "attachmentReadV4"
  | "onDynamicConversationFrame"
  | "onDynamicLocalTtftFacts"
  | "onAgentRuntimeRestarted"
>;

interface WorkspaceConnectionScope {
  /** = primary workspace bound to the pane (connection routing key). */
  workspacePath: string;
  workspaceIdentity?: string;
  /** Endpoint scope: remote shard’s remoteSessionId; defaults to local __base__. */
  remoteSessionId?: string;
}

/** Connection lease held by a pane; release is idempotent. */
/** The inferred return type of useSavedWorkflowLauncher includes the lease, so declaration generation requires a named export. @lintignore */
export interface WorkspaceConnectionLease {
  readonly layer: SessionDataLayer;
  readonly transport: ConversationTransport;
  /** Activate the remote service carried by this lease after React commit; a local lease is a no-op. */
  activateRemoteService(): void;
  release(): void;
}

interface RegistryEntry {
  key: string;
  agentService: WorkspaceConnectionAgentService;
  agentServiceGeneration: number;
  transport: ConversationTransport;
  replaceableTransport: ReplaceableConversationTransport | null;
  layer: SessionDataLayer;
  refCount: number;
  keepWarmTimer: ReturnType<typeof setTimeout> | null;
  /** Old local-service generation removed from the registry: dispose immediately when its final lease is released. */
  stale: boolean;
}

const registry = new Map<string, RegistryEntry>();

/** Reserved key for the local endpoint (same convention as sessionsIndexRegistry / task-list shardKey). */
const LOCAL_WORKSPACE_CONNECTION_ENDPOINT = "__base__";

/** Delay before release when the reference count reaches zero (ms); same scale as SessionDataLayer keep-warm. */
const WORKSPACE_CONNECTION_KEEP_WARM_MS = 30_000;

/** Registry entry key = endpoint + workspaceKey (different endpoints never share an entry, even for the same workspaceKey). */
function buildWorkspaceConnectionKey(scope: WorkspaceConnectionScope): string {
  const workspaceKey = scope.workspaceIdentity?.trim() || scope.workspacePath;
  return `${scope.remoteSessionId ?? LOCAL_WORKSPACE_CONNECTION_ENDPOINT} ${workspaceKey}`;
}

function disposeEntry(entry: RegistryEntry): void {
  if (entry.keepWarmTimer !== null) {
    clearTimeout(entry.keepWarmTimer);
    entry.keepWarmTimer = null;
  }
  entry.layer.dispose();
}

function releaseEntry(entry: RegistryEntry): void {
  entry.refCount -= 1;
  if (entry.refCount > 0) {
    logger.lifecycle.info("v4 workspace connection lease released", {
      event: "v4.workspace_connection.release",
      key: entry.key,
      module: "ui.v4.workspace_connection_registry",
      refCount: entry.refCount,
      status: "completed",
    });
    return;
  }
  if (entry.stale) {
    // This entry has been replaced and removed from the registry; no new consumer can find it, so clean it up immediately.
    disposeEntry(entry);
    logger.lifecycle.info("v4 stale workspace connection disposed", {
      event: "v4.workspace_connection.stale_disposed",
      key: entry.key,
      module: "ui.v4.workspace_connection_registry",
      refCount: 0,
      status: "completed",
    });
    return;
  }
  // Closing a pane does not stop the session: delay unsubscribe to prevent repeated connect/unsubscribe during layout jitter.
  entry.keepWarmTimer = setTimeout(() => {
    if (registry.get(entry.key) === entry) {
      registry.delete(entry.key);
    }
    entry.layer.dispose();
    logger.lifecycle.info("v4 workspace connection keep-warm expired", {
      event: "v4.workspace_connection.keep_warm_expired",
      key: entry.key,
      module: "ui.v4.workspace_connection_registry",
      refCount: 0,
      status: "completed",
    });
  }, WORKSPACE_CONNECTION_KEEP_WARM_MS);
  logger.lifecycle.info("v4 workspace connection lease released", {
    event: "v4.workspace_connection.release",
    keepWarmMs: WORKSPACE_CONNECTION_KEEP_WARM_MS,
    key: entry.key,
    module: "ui.v4.workspace_connection_registry",
    refCount: 0,
    status: "keep_warm",
  });
}

/**
 * Get/create a shared conversation connection for an endpoint+workspace and increment refCount.
 * agentService is resolved by the caller (V4PaneConversationProvider via useWorkspaceServicesResolution);
 * the caller enters this layer only for local-ready/remote-ready. remote-waiting does not create a registry entry with a disconnected proxy,
 * and still cannot fall back to base services or start an independent runtime for the pane.
 */
export function acquireWorkspaceConnection(
  scope: WorkspaceConnectionScope,
  agentService: WorkspaceConnectionAgentService,
  createLocalMediaPreviewUrl?: (path: string) => string,
): WorkspaceConnectionLease {
  const key = buildWorkspaceConnectionKey(scope);
  const existing = registry.get(key);
  const incomingServiceGeneration = remoteAgentServiceGeneration(agentService);
  const isRemote =
    (scope.remoteSessionId ?? LOCAL_WORKSPACE_CONNECTION_ENDPOINT) !==
    LOCAL_WORKSPACE_CONNECTION_ENDPOINT;
  let entry: RegistryEntry;
  if (existing && (existing.agentService === agentService || isRemote)) {
    existing.refCount += 1;
    if (existing.keepWarmTimer !== null) {
      clearTimeout(existing.keepWarmTimer);
      existing.keepWarmTimer = null;
    }
    entry = existing;
    logger.lifecycle.info("v4 workspace connection reused", {
      event: "v4.workspace_connection.reused",
      isRemote,
      key,
      module: "ui.v4.workspace_connection_registry",
      refCount: entry.refCount,
      serviceGeneration: incomingServiceGeneration,
      status: "completed",
    });
  } else {
    if (existing) {
      // The local __base__ service was replaced: invalidate and remove the old entry;
      // clean it up immediately if unowned, or let the last holder release it.
      registry.delete(key);
      existing.stale = true;
      if (existing.refCount <= 0) {
        disposeEntry(existing);
      }
    }
    const initialTransport = createAgentConversationTransport(agentService, {
      workspacePath: scope.workspacePath,
      ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      ...(createLocalMediaPreviewUrl ? { createLocalMediaPreviewUrl } : {}),
    });
    const replaceableTransport = isRemote
      ? new ReplaceableConversationTransport(initialTransport)
      : null;
    const transport = replaceableTransport ?? initialTransport;
    entry = {
      key,
      agentService,
      agentServiceGeneration: incomingServiceGeneration,
      transport,
      replaceableTransport,
      layer: new SessionDataLayer({ transport }),
      refCount: 1,
      keepWarmTimer: null,
      stale: false,
    };
    registry.set(key, entry);
    logger.lifecycle.info("v4 workspace connection created", {
      event: "v4.workspace_connection.created",
      isRemote,
      key,
      module: "ui.v4.workspace_connection_registry",
      refCount: 1,
      serviceGeneration: incomingServiceGeneration,
      status: "completed",
    });
  }

  let released = false;
  return {
    layer: entry.layer,
    transport: entry.transport,
    activateRemoteService: () => {
      if (
        released ||
        !isRemote ||
        entry.stale ||
        entry.agentService === agentService ||
        incomingServiceGeneration <= entry.agentServiceGeneration
      ) {
        return;
      }
      // acquire runs during React render; replacing synchronously here would update an external store through
      // the runtimeRestart listener and issue RPC. The lease captures only the candidate service;
      // Provider activates it explicitly during commit while keeping generation changes one-way.
      if (!entry.replaceableTransport) {
        throw new Error("远程 conversation registry 条目缺少可换代 transport");
      }
      entry.agentService = agentService;
      entry.agentServiceGeneration = incomingServiceGeneration;
      entry.replaceableTransport.replace(
        createAgentConversationTransport(agentService, {
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
        }),
      );
    },
    release: () => {
      if (released) return;
      released = true;
      releaseEntry(entry);
    },
  };
}

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  type ReactNode,
} from "react";
import type {
  CommandAck,
  CommandEnvelope,
  V4AttachmentPutParams,
  V4AttachmentPutResult,
  V4ConversationFileChangesParams,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewParams,
  V4ConversationFileRewindPreviewResult,
  V4ConversationWorkflowRunArtifactDataParams,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadParams,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsParams,
  V4ConversationWorkflowRunArtifactsResult,
  V4ConversationWorkflowRunNodeResultParams,
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationWorkflowRunWorkspaceParams,
  V4ConversationWorkflowRunWorkspaceResult,
  V4ConversationWorkflowRunEventsParams,
  V4ConversationWorkflowRunsParams,
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunsResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { IServiceAccessor } from "@zcode/services";
import { ServiceProvider } from "@/hooks/useServices.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { createAgentConversationTransport } from "@/v4/agentConversationTransport.js";
import type { ConversationAttachmentReadParams, ConversationTransport } from "@/v4/transport.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { SessionDataLayer } from "@/v4/sessionDataLayer.js";
import { acquireWorkspaceConnection } from "@/v4/workspaceConnectionRegistry.js";
import type { AttachmentUploadOptions } from "@/v4/attachmentUploadTransaction.js";
import { ConversationTelemetryPaneAttachment } from "@/v4/telemetry/ConversationTelemetryAttachment.js";

export interface V4ConversationContextValue {
  layer: SessionDataLayer;
  sendCommand(envelope: CommandEnvelope): Promise<CommandAck>;
  fileChanges(params: V4ConversationFileChangesParams): Promise<V4ConversationFileChangesResult>;
  fileRewindPreview(
    params: V4ConversationFileRewindPreviewParams,
  ): Promise<V4ConversationFileRewindPreviewResult>;
  /** Paginated workflow run event log (details-page audit surface); read-only, stateless, and safe to retry after timeout. */
  workflowRunEvents(
    params: V4ConversationWorkflowRunEventsParams,
  ): Promise<V4ConversationWorkflowRunEventsResult>;
  /** Enumerate workflow runs (journal-backed discovery surface after restart). */
  workflowRuns(params: V4ConversationWorkflowRunsParams): Promise<V4ConversationWorkflowRunsResult>;
  /**
   * List of **user-facing artifacts** for a workflow run (durable read path for cold recovery). ⚠ Terminology: artifact = output published to the user by a script through
   * `artifact.*`, not the run’s top-level return value.
   */
  workflowRunArtifacts(
    params: V4ConversationWorkflowRunArtifactsParams,
  ): Promise<V4ConversationWorkflowRunArtifactsResult>;
  /** Paginated preset dashboard items (cursor = journal sequence). */
  workflowRunArtifactData(
    params: V4ConversationWorkflowRunArtifactDataParams,
  ): Promise<V4ConversationWorkflowRunArtifactDataResult>;
  /** Read content artifact bytes one chunk at a time (≤ 512 KiB); the caller’s hook assembles them. */
  workflowRunArtifactRead(
    params: V4ConversationWorkflowRunArtifactReadParams,
  ): Promise<V4ConversationWorkflowRunArtifactReadResult>;
  /** List of dwf script transcript entries (files.* / git.* / world.run rows, without bodies). */
  workflowRunWorkspace(
    params: V4ConversationWorkflowRunWorkspaceParams,
  ): Promise<V4ConversationWorkflowRunWorkspaceResult>;
  /** Bounded body for a workflow node (fetched only when expanded). */
  workflowRunNodeResult(
    params: V4ConversationWorkflowRunNodeResultParams,
  ): Promise<V4ConversationWorkflowRunNodeResultResult>;
  /** High-level UI put semantics; the transport internally uses only begin/chunk/commit/abort. */
  attachmentPut(
    params: V4AttachmentPutParams,
    options?: AttachmentUploadOptions,
  ): Promise<V4AttachmentPutResult>;
  attachmentRead(
    params: ConversationAttachmentReadParams,
  ): ReturnType<ConversationTransport["attachmentRead"]>;
  attachmentReadRange(
    params: Parameters<ConversationTransport["attachmentReadRange"]>[0],
  ): ReturnType<ConversationTransport["attachmentReadRange"]>;
  onRuntimeRestart(listener: () => void): () => void;
  /**
   * Exists only when the hosting transport exposes runtime liveness (see ConversationTransport.onRuntimeLifecycle).
   * unavailable arrives at workspace-dispose and is the only reliable signal for rebuilding draft prewarm state across a generation change.
   */
  onRuntimeLifecycle?(listener: (state: "available" | "unavailable") => void): () => void;
}

// Export the context itself: static replay views provide their own static transport,
// and inject the assembled value directly through the Provider, without going through V4ConversationProvider’s workspace resolution.
export const V4ConversationContext = createContext<V4ConversationContextValue | null>(null);

interface V4ConversationProviderProps {
  workspacePath: string;
  workspaceIdentity?: string;
  children: ReactNode;
}

function ReadyV4ConversationProvider({
  workspacePath,
  workspaceIdentity,
  children,
  services,
  remoteSessionId,
}: V4ConversationProviderProps & {
  services: IServiceAccessor;
  remoteSessionId: string | null;
}) {
  const { zcodeAgentService } = services;
  const platform = usePlatform();
  const bundle = useMemo(() => {
    const transport = createAgentConversationTransport(zcodeAgentService, {
      workspacePath,
      workspaceIdentity,
      // The main workspace resolver already recognizes remote endpoints, but this code previously dropped
      // remoteSessionId, causing remote absolute paths to be passed to local zcode-media. Inject the converter only for local endpoints.
      ...(remoteSessionId === null && platform.createLocalMediaPreviewUrl
        ? { createLocalMediaPreviewUrl: platform.createLocalMediaPreviewUrl }
        : {}),
    });
    const layer = new SessionDataLayer({ transport });
    return {
      layer,
      sendCommand: (envelope: CommandEnvelope) => transport.sendCommand(envelope),
      fileChanges: (params: V4ConversationFileChangesParams) => transport.fileChanges(params),
      fileRewindPreview: (params: V4ConversationFileRewindPreviewParams) =>
        transport.fileRewindPreview(params),
      workflowRunEvents: (params: V4ConversationWorkflowRunEventsParams) =>
        transport.workflowRunEvents(params),
      workflowRunArtifacts: (params: V4ConversationWorkflowRunArtifactsParams) =>
        transport.workflowRunArtifacts(params),
      workflowRunArtifactData: (params: V4ConversationWorkflowRunArtifactDataParams) =>
        transport.workflowRunArtifactData(params),
      workflowRunArtifactRead: (params: V4ConversationWorkflowRunArtifactReadParams) =>
        transport.workflowRunArtifactRead(params),
      workflowRunWorkspace: (params: V4ConversationWorkflowRunWorkspaceParams) =>
        transport.workflowRunWorkspace(params),
      workflowRunNodeResult: (params: V4ConversationWorkflowRunNodeResultParams) =>
        transport.workflowRunNodeResult(params),
      workflowRuns: (params: V4ConversationWorkflowRunsParams) => transport.workflowRuns(params),
      attachmentPut: (params: V4AttachmentPutParams, options?: AttachmentUploadOptions) =>
        transport.attachmentPut(params, options),
      attachmentRead: (params) => transport.attachmentRead(params),
      attachmentReadRange: (params) => transport.attachmentReadRange(params),
      onRuntimeRestart: (listener: () => void) => transport.onRuntimeRestart(listener),
      ...(transport.onRuntimeLifecycle
        ? {
            onRuntimeLifecycle: (listener: (state: "available" | "unavailable") => void) =>
              transport.onRuntimeLifecycle?.(listener) ?? (() => {}),
          }
        : {}),
    } satisfies V4ConversationContextValue;
  }, [
    platform.createLocalMediaPreviewUrl,
    remoteSessionId,
    workspacePath,
    workspaceIdentity,
    zcodeAgentService,
  ]);

  useEffect(() => {
    return () => {
      bundle.layer.dispose();
    };
  }, [bundle]);

  return (
    <ServiceProvider services={services}>
      <V4ConversationContext.Provider value={bundle}>{children}</V4ConversationContext.Provider>
    </ServiceProvider>
  );
}

/** One host connection and one SessionDataLayer per workspace. */
export function V4ConversationProvider({
  workspacePath,
  workspaceIdentity,
  children,
}: V4ConversationProviderProps) {
  const resolution = useWorkspaceServicesResolution(workspacePath, undefined, workspaceIdentity);
  if (!resolution.rpcReady) {
    return null;
  }

  return (
    <ReadyV4ConversationProvider
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      services={resolution.services}
      remoteSessionId={resolution.remoteSessionId}
    >
      {children}
    </ReadyV4ConversationProvider>
  );
}

export function useV4Conversation(): V4ConversationContextValue {
  const ctx = useContext(V4ConversationContext);
  if (!ctx) {
    throw new Error("useV4Conversation 必须在 V4ConversationProvider 内使用");
  }
  return ctx;
}

/**
 * Whether a conversation context is available. Used by components that **can** render inside a host without a session (static rendering, replay,
 * completed cards in transcripts) to decide whether to mount the data-fetching layer—if mounted, context must exist; otherwise render the cold state.
 */
export function useHasV4Conversation(): boolean {
  return useContext(V4ConversationContext) !== null;
}

interface V4PaneConversationProviderProps {
  /** Primary workspace for this pane (connection routing key). */
  scope: PaneWorkspaceScope;
  children: ReactNode;
}

/**
 * Per-pane data surface: the connection is leased from workspaceConnectionRegistry
 * (panes with the same endpoint+workspaceKey share one transport + SessionDataLayer,
 * with refCount + 30s keep-warm), and the pane’s own services are injected into the subtree—hooks such as attachment upload
 * and sessions-index guards use the pane accessor instead of accidentally using the shell’s current workspace.
 *
 * A remote target remains remote-waiting until the session store registers real services, and does not mount the child data layer,
 * so it cannot create a connection or subscribe through a disconnected proxy. It also never falls back to base services or starts a separate pane runtime (remote-control safety constraint). Once reconnection is ready, the services reference changes → the registry preserves
 * the original layer/transport identity and activates the latest proxy one-way during commit.
 */
export function V4PaneConversationProvider({ scope, children }: V4PaneConversationProviderProps) {
  const targetResolution = useWorkspaceServicesResolution(
    scope.workspacePath,
    scope.remoteSessionId ?? null,
    scope.workspaceIdentity ?? null,
  );
  const resolvedScope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: scope.workspacePath,
      ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      ...(targetResolution.remoteSessionId
        ? { remoteSessionId: targetResolution.remoteSessionId }
        : {}),
    }),
    [scope.workspaceIdentity, scope.workspacePath, targetResolution.remoteSessionId],
  );
  if (!targetResolution.rpcReady) {
    return null;
  }

  // A remote pane being restored may have only workspaceIdentity. The resolver has already found the actual
  // remoteSessionId; if the original scope is still passed to the registry, it creates one data layer under __base__ and another under the remote endpoint,
  // so terminal state may land in the invisible store. Always use the resolved scope once ready.
  return (
    <ReadyV4PaneConversationProvider scope={resolvedScope} services={targetResolution.services}>
      {children}
    </ReadyV4PaneConversationProvider>
  );
}

function ReadyV4PaneConversationProvider({
  scope,
  services,
  children,
}: Pick<V4PaneConversationProviderProps, "scope" | "children"> & {
  services: IServiceAccessor;
}) {
  const agentService = services.zcodeAgentService;
  const platform = usePlatform();

  // Use the same synchronous useMemo connection setup as V4ConversationProvider (the renderer has no StrictMode,
  // so memo is not invoked twice). When dependencies change, acquire the new lease before releasing the old one in effect cleanup—
  // with the same key, the refCount never reaches zero, and keep-warm covers brief changes across keys.
  const bundle = useMemo(() => {
    const lease = acquireWorkspaceConnection(
      {
        workspacePath: scope.workspacePath,
        ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
        ...(scope.remoteSessionId ? { remoteSessionId: scope.remoteSessionId } : {}),
      },
      agentService,
      scope.remoteSessionId ? undefined : platform.createLocalMediaPreviewUrl,
    );
    return {
      lease,
      value: {
        layer: lease.layer,
        sendCommand: (envelope: CommandEnvelope) => lease.transport.sendCommand(envelope),
        fileChanges: (params: V4ConversationFileChangesParams) =>
          lease.transport.fileChanges(params),
        fileRewindPreview: (params: V4ConversationFileRewindPreviewParams) =>
          lease.transport.fileRewindPreview(params),
        workflowRunEvents: (params: V4ConversationWorkflowRunEventsParams) =>
          lease.transport.workflowRunEvents(params),
        workflowRunArtifacts: (params: V4ConversationWorkflowRunArtifactsParams) =>
          lease.transport.workflowRunArtifacts(params),
        workflowRunArtifactData: (params: V4ConversationWorkflowRunArtifactDataParams) =>
          lease.transport.workflowRunArtifactData(params),
        workflowRunArtifactRead: (params: V4ConversationWorkflowRunArtifactReadParams) =>
          lease.transport.workflowRunArtifactRead(params),
        workflowRunWorkspace: (params: V4ConversationWorkflowRunWorkspaceParams) =>
          lease.transport.workflowRunWorkspace(params),
        workflowRunNodeResult: (params: V4ConversationWorkflowRunNodeResultParams) =>
          lease.transport.workflowRunNodeResult(params),
        workflowRuns: (params: V4ConversationWorkflowRunsParams) =>
          lease.transport.workflowRuns(params),
        attachmentPut: (params: V4AttachmentPutParams, options?: AttachmentUploadOptions) =>
          lease.transport.attachmentPut(params, options),
        attachmentRead: (params) => lease.transport.attachmentRead(params),
        attachmentReadRange: (params) => lease.transport.attachmentReadRange(params),
        onRuntimeRestart: (listener: () => void) => lease.transport.onRuntimeRestart(listener),
        ...(lease.transport.onRuntimeLifecycle
          ? {
              onRuntimeLifecycle: (listener: (state: "available" | "unavailable") => void) =>
                lease.transport.onRuntimeLifecycle?.(listener) ?? (() => {}),
            }
          : {}),
      } satisfies V4ConversationContextValue,
    };
  }, [
    agentService,
    platform.createLocalMediaPreviewUrl,
    scope.workspacePath,
    scope.workspaceIdentity,
    scope.remoteSessionId,
  ]);

  useLayoutEffect(() => {
    // acquire runs during render and only creates a stable lease; store updates caused by remote-proxy changes and
    // resubscription must wait until commit to avoid synchronously updating an existing pane during render.
    bundle.lease.activateRemoteService();
  }, [bundle]);

  useEffect(() => {
    return () => {
      bundle.lease.release();
    };
  }, [bundle]);

  return (
    <ServiceProvider services={services}>
      <ConversationTelemetryPaneAttachment services={services} scope={scope}>
        <V4ConversationContext.Provider value={bundle.value}>
          {children}
        </V4ConversationContext.Provider>
      </ConversationTelemetryPaneAttachment>
    </ServiceProvider>
  );
}

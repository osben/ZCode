// Transport seam for the V4 conversation data layer (dependency injection).
// Desktop uses preload/MessagePort and web uses a WebSocket relay—the data layer is unaware of either,
// implementing the principle that dependency injection handles desktop/web compatibility in the V4 data layer.
import type {
  CommandAck,
  CommandEnvelope,
  CommandsQueryParams,
  CommandsQueryResult,
  ConversationRowTarget,
  ConversationTopicFrame,
  TopicFrameDeliveryKind,
  SubscribeParams,
  V4AttachmentPutParams,
  V4AttachmentPutResult,
  V4ConversationFileChangesParams,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewParams,
  V4ConversationFileRewindPreviewResult,
  V4ConversationPlansParams,
  V4ConversationPlansResult,
  V4ConversationRowsRangeParams,
  V4ConversationRowsRangeResult,
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
  ConversationResyncParams,
  V4ConversationResyncResult,
  V4ConversationSubscribeResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { AttachmentUploadOptions } from "@/v4/attachmentUploadTransaction.js";

/**
 * V4 conversation transport surface for one host connection.
 * For split views across workspaces, the UI shell holds a Map<workspaceKey, ConversationTransport>,
 * with one SessionDataLayer per connection.
 */
export interface ConversationTransport {
  /** v4/conversation/subscribe. The transport implementation fills in connectionId; it is not exposed to the UI layer. */
  subscribe(params: SubscribeParams): Promise<V4ConversationSubscribeResult>;
  /** Activate after the store writes the ACK subscriptionId, then release notifications received before the ACK in their original order. */
  activate(subscriptionId: string): void;
  /** Recover a same-subscription active subscription; look up topic/connection/profile from the host-owned registry. */
  resync(params: ConversationResyncParams): Promise<V4ConversationResyncResult>;
  /** v4/conversation/unsubscribe。 */
  unsubscribe(subscriptionId: string): Promise<void>;
  /** v4/command。 */
  sendCommand(envelope: CommandEnvelope): Promise<CommandAck>;
  /** v4/commands/query: reconcile by commandId against CLI-authoritative facts after reconnecting. */
  queryCommands(params: CommandsQueryParams): Promise<CommandsQueryResult>;
  /** v4/conversation/rowsRange (loadOlder): fetch one window of older rows using a cursor. */
  rowsRange(params: V4ConversationRowsRangeParams): Promise<V4ConversationRowsRangeResult>;
  /** v4/conversation/plans: all terminal plans in the currently active branch. */
  plans(params: V4ConversationPlansParams): Promise<V4ConversationPlansResult>;
  /** v4/conversation/workflowRunEvents: paginate the workflow run event log (cursor = journal sequence). */
  workflowRunEvents(
    params: V4ConversationWorkflowRunEventsParams,
  ): Promise<V4ConversationWorkflowRunEventsResult>;
  /** v4/conversation/workflowRuns: enumerate workflow runs (the journal-backed discovery surface after restart). */
  workflowRuns(params: V4ConversationWorkflowRunsParams): Promise<V4ConversationWorkflowRunsResult>;
  /**
   * v4/conversation/workflowRunArtifacts: list of **user-facing artifacts** for a workflow run (durable read path for cold recovery).
   *
   * ⚠ Terminology: artifact = output published to the user by a script through `artifact.*` (file / markdown / preset dashboard),
   * not the run's top-level return value.
   */
  workflowRunArtifacts(
    params: V4ConversationWorkflowRunArtifactsParams,
  ): Promise<V4ConversationWorkflowRunArtifactsResult>;
  /** v4/conversation/workflowRunArtifactData: paginate preset dashboard items (cursor = journal sequence). */
  workflowRunArtifactData(
    params: V4ConversationWorkflowRunArtifactDataParams,
  ): Promise<V4ConversationWorkflowRunArtifactDataResult>;
  /** v4/conversation/workflowRunArtifactRead: read content artifact bytes one chunk at a time (≤ 512 KiB). */
  workflowRunArtifactRead(
    params: V4ConversationWorkflowRunArtifactReadParams,
  ): Promise<V4ConversationWorkflowRunArtifactReadResult>;
  /**
   * v4/conversation/workflowRunWorkspace: list of script transcript entries for a workflow run
   * (journal rows for files.* / git.* / world.run, without their bodies).
   */
  workflowRunWorkspace(
    params: V4ConversationWorkflowRunWorkspaceParams,
  ): Promise<V4ConversationWorkflowRunWorkspaceResult>;
  /** v4/conversation/workflowRunNodeResult: bounded body for a workflow node (fetched only when expanded). */
  workflowRunNodeResult(
    params: V4ConversationWorkflowRunNodeResultParams,
  ): Promise<V4ConversationWorkflowRunNodeResultResult>;
  /** v4/conversation/fileChanges: expand a turn row into file summary details and a read-only diff. */
  fileChanges(params: V4ConversationFileChangesParams): Promise<V4ConversationFileChangesResult>;
  /** v4/conversation/fileRewindPreview: preview workspace-only file rewind by turn row. */
  fileRewindPreview(
    params: V4ConversationFileRewindPreviewParams,
  ): Promise<V4ConversationFileRewindPreviewResult>;
  /** High-level UI attachment upload; production wire operations are begin/chunk/commit/abort. */
  attachmentPut(
    params: V4AttachmentPutParams,
    options?: AttachmentUploadOptions,
  ): Promise<V4AttachmentPutResult>;
  /** High-level reads for sent images/videos; local Desktop videos may return an authorized URL, while other reads loop over small chunks. */
  attachmentRead(
    params: ConversationAttachmentReadParams,
  ): Promise<{ bytes: Uint8Array; mediaType: string } | { url: string; mediaType: string }>;
  /** Authorized range reads for sent PDFs; the entire file is not loaded into the renderer first. */
  attachmentReadRange(
    params: ConversationAttachmentReadParams & { offset: number; limit: number },
  ): Promise<{
    bytes: Uint8Array;
    mediaType: string;
    totalBytes: number;
    nextOffset: number | null;
  }>;
  /** Register a listener for incoming frames (v4/conversation/frame) and return an unsubscribe function. */
  onFrame(
    listener: (
      frame: ConversationTopicFrame,
      context?: { deliveryKind: TopicFrameDeliveryKind },
    ) => void,
  ): () => void;
  /** Physical assembly fails atomically; the projection remains unchanged and the store starts a single-flight resync. */
  onAssemblyFault(
    listener: (fault: {
      topic: string;
      subscriptionId: string;
      reasonCode?: string;
      deliveryKind?: TopicFrameDeliveryKind;
    }) => void,
  ): () => void;
  /** The CLI runtime or hosting proxy has changed generation; the transport has already cleared ownership/barrier/assembler state. */
  onRuntimeRestart(listener: (reason?: "runtimeRestart" | "transportReplaced") => void): () => void;
  /**
   * CLI runtime liveness. unavailable arrives at workspace-dispose (the new runtime does not exist yet,
   * so it cannot be resubscribed); available arrives when the new process spawns, at the same time and with the same meaning as onRuntimeRestart.
   *
   * onRuntimeRestart is emitted only when the new process spawns, but the agent starts lazily. If no one starts it after CUA Helper readiness
   * triggers dispose, the generation-change notification never arrives, the draft-prewarm session is not rebuilt, and attachments stay in
   * waitingSession until the user manually sends something. This event is the only signal observable at dispose time.
   *
   * Consumers subscribe through one of the two established sessionsIndexStore paths (if this method exists, do not subscribe to onRuntimeRestart),
   * preventing the same generation change from being processed through both channels. This method is absent when the host does not expose runtime lifecycle.
   */
  onRuntimeLifecycle?(listener: (state: "available" | "unavailable") => void): () => void;
}

export interface ConversationAttachmentReadParams {
  sessionId: string;
  ref: string;
  /** Used only to decide whether to query the Desktop local video source; the final MIME type is still returned authoritatively by the CLI. */
  mediaType?: string;
  /** New rows have stable identity; retain ref-only compatibility when an older snapshot lacks it. */
  target?: ConversationRowTarget;
  attachmentIndex?: number;
  /** Stop subsequent chunk requests when the dialog closes, switches, or unmounts. */
  signal?: AbortSignal;
}

/** Conversation topic key (paired with parseConversationTopic on the CLI side), re-exported from the protocol package. */
export { conversationTopic } from "@zcode/shared/zcode-protocol-v4";

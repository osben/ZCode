import { sendWithConversationDelayE2E } from "@/v4/conversationTransportDelayE2E.js";
import { getLocalTtftObserver } from "@/v4/telemetry/localTtftObserver.js";
import { calibrateLocalTtftClock, INCOGNITO_UNSUPPORTED_ERROR, localTtftNow } from "@zcode/shared";
/* oxlint-disable eslint(max-lines) -- Keep uploads, chunked reads, and runtime lifecycle within one host boundary for this transport. */
// Desktop/host implementation of ConversationTransport: bridges to the v4 forwarding surface of IZCodeAgentService
// (dependency injection keeps host details out of the data layer;
// web can swap in another implementation when connecting directly to the ws relay).
import type { IZCodeAgentService } from "@zcode/services";
import {
  conversationTopicFrameSchema,
  PROTOCOL_V4_LIMITS,
  parseConversationTopic,
  TopicWireFrameAssembler,
  type CommandAck,
  type CommandEnvelope,
  type CommandsQueryParams,
  type CommandsQueryResult,
  type ConversationTopicFrame,
  type ConversationTopicWireCandidate,
  type ConversationResyncParams,
  type SubscribeParams,
  type TopicFrameDeliveryKind,
  type V4AttachmentPutParams,
  type V4AttachmentPutResult,
  type V4ConversationFileChangesParams,
  type V4ConversationFileChangesResult,
  type V4ConversationFileRewindPreviewParams,
  type V4ConversationFileRewindPreviewResult,
  type V4ConversationPlansParams,
  type V4ConversationPlansResult,
  type V4ConversationRowsRangeParams,
  type V4ConversationRowsRangeResult,
  type V4ConversationSubscribeResult,
  type V4ConversationResyncResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTransport } from "@/v4/transport.js";
import { ensureAgentV4ConnectionHandshake } from "@/v4/agentV4ConnectionHandshake.js";
import { createWorkflowRunTransportMethods } from "@/v4/agentConversationTransportWorkflowRuns.js";
import { createAckActivationBarrier } from "@/v4/ackActivationBarrier.js";
import { createTopicWireDecoder } from "@/v4/topicWireDecoder.js";
import { logger } from "@/logger.js";
import {
  uploadAttachmentTransaction,
  type AttachmentUploadOptions,
} from "@/v4/attachmentUploadTransaction.js";

export interface AgentConversationTransportTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  /** Desktop local media protocol URL; Web/remote do not inject it and therefore keep chunked reads. */
  createLocalMediaPreviewUrl?: (path: string) => string;
}

type ConversationV4AgentService = Pick<
  IZCodeAgentService,
  | "subscribeConversationV4"
  | "resyncConversationV4"
  | "helloConversationV4"
  | "initializeConversationV4"
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
> &
  Partial<Pick<IZCodeAgentService, "onAgentRuntimeLifecycle">>;

/**
 * v4 conversation transport surface for one host connection (= one workspace).
 * The host provides connectionId; this handles workspace resolution and frame-listener lifecycle only.
 */
export function createAgentConversationTransport(
  agentService: ConversationV4AgentService,
  target: AgentConversationTransportTarget,
): ConversationTransport {
  const workspace = {
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
  };
  let calibrationFlight: Promise<void> | undefined;
  const calibrate = () => {
    const observer = getLocalTtftObserver();
    if (
      target.workspaceIdentity?.trim() ||
      !observer?.needsCalibration(target.workspacePath) ||
      calibrationFlight
    )
      return;
    const start = localTtftNow();
    calibrationFlight = agentService
      .queryConversationCommandsV4({
        ...workspace,
        commands: [{ sessionId: null, commandId: `ttft-clock-${crypto.randomUUID()}` }],
        clock: true,
      })
      .then((result) => {
        const clock = result.clock && calibrateLocalTtftClock(start, localTtftNow(), result.clock);
        if (clock) observer.calibrate(target.workspacePath, clock);
      })
      .catch(() => {})
      .finally(() => {
        calibrationFlight = undefined;
      });
  };
  const ensureHandshake = async () => {
    const hello = await ensureAgentV4ConnectionHandshake(agentService);
    calibrate();
    return hello;
  };
  const listeners = new Set<
    (frame: ConversationTopicFrame, context?: { deliveryKind: TopicFrameDeliveryKind }) => void
  >();
  const faultListeners = new Set<
    (fault: {
      topic: string;
      subscriptionId: string;
      reasonCode?: string;
      deliveryKind?: TopicFrameDeliveryKind;
    }) => void
  >();
  const runtimeRestartListeners = new Set<
    Parameters<ConversationTransport["onRuntimeRestart"]>[0]
  >();
  const runtimeLifecycleListeners = new Set<(state: "available" | "unavailable") => void>();
  const decoder = createTopicWireDecoder(
    new TopicWireFrameAssembler(conversationTopicFrameSchema),
    (frame: ConversationTopicFrame, deliveryKind) => {
      try {
        if (!target.workspaceIdentity?.trim()) {
          getLocalTtftObserver()?.receive(target.workspacePath, frame, deliveryKind);
          // Cause: calibration was refreshed only as part of ensureHandshake, and no transport call occurred while queued/slow sends waited.
          // By the first output, calibration had exceeded its 60-second validity and was discarded across processes. Refresh expired calibration when a content frame arrives.
          calibrate();
        }
      } catch (error) {
        logger.debug("[local-ttft] observation failed", { error });
      }
      for (const listener of listeners) listener(frame, { deliveryKind });
    },
    (fault) => {
      for (const listener of faultListeners) listener(fault);
    },
  );
  const barrier = createAckActivationBarrier<ConversationTopicWireCandidate>((wire) => {
    decoder.accept(wire);
  });
  const topicBySubscriptionId = new Map<string, string>();
  let ttftUpstream: { dispose(): void } | undefined;
  let upstream: { dispose(): void } | null = null;
  let runtimeRestartUpstream: { dispose(): void } | null = null;
  let runtimeLifecycleUpstream: { dispose(): void } | null = null;
  let runtimeGeneration = 0;
  const targetWorkspaceKey = target.workspaceIdentity?.trim() || target.workspacePath;
  const lifecycleContext = {
    workspaceKey: targetWorkspaceKey,
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
  };

  const decodeBase64Chunk = (value: string): Uint8Array => {
    const decoded = atob(value);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }
    return bytes;
  };
  return {
    async subscribe(params: SubscribeParams): Promise<V4ConversationSubscribeResult> {
      const sessionId = parseConversationTopic(params.topic);
      if (!sessionId) {
        return Promise.reject(new Error(`Unsupported v4 topic: ${params.topic}`));
      }
      const startedAt = Date.now();
      logger.lifecycle.info("v4 conversation subscription started", {
        ...lifecycleContext,
        event: "v4.conversation.subscribe.started",
        module: "ui.v4.conversation_transport",
        runtimeGeneration,
        sessionId,
        status: "started",
        topic: params.topic,
      });
      let pending: ReturnType<typeof barrier.begin> | undefined;
      try {
        await ensureHandshake();
        pending = barrier.begin(params.topic);
        const subscribeRuntimeGeneration = runtimeGeneration;
        const result = await agentService.subscribeConversationV4({
          ...workspace,
          sessionId,
          ...(params.base ? { base: params.base } : {}),
          ...(params.visibility ? { visibility: params.visibility } : {}),
        });
        if (subscribeRuntimeGeneration !== runtimeGeneration) {
          // A late ACK from an old runtime may reuse a new runtime's subId; here, only
          // clear local pending state and do not blindly unsubscribe a same-named subscription from the new runtime.
          barrier.cancel(pending);
          logger.lifecycle.warn("v4 conversation subscription ACK became stale", {
            ...lifecycleContext,
            durationMs: Date.now() - startedAt,
            event: "v4.conversation.subscribe.stale_ack",
            module: "ui.v4.conversation_transport",
            runtimeGeneration,
            sessionId,
            status: "failed",
            topic: params.topic,
          });
          throw new Error("fault.subscription.runtimeRestarted");
        }
        try {
          barrier.bind(pending, result.ack.subscriptionId);
        } catch (error) {
          // If the physical batch exceeds limits before ACK, it is already incomplete. Revoke the host
          // subscription and return an explicit fault to the caller; do not return an ACK that can be activated.
          try {
            await agentService.unsubscribeConversationV4({
              ...workspace,
              subscriptionId: result.ack.subscriptionId,
            });
          } catch (cleanupError) {
            logger.warn("[v4-conversation] failed to undo rejected subscription", cleanupError);
          }
          throw error;
        }
        topicBySubscriptionId.set(result.ack.subscriptionId, params.topic);
        logger.lifecycle.info("v4 conversation subscription acknowledged", {
          ...lifecycleContext,
          durationMs: Date.now() - startedAt,
          event: "v4.conversation.subscribe.acknowledged",
          module: "ui.v4.conversation_transport",
          runtimeGeneration,
          sessionId,
          status: "completed",
          subscriptionId: result.ack.subscriptionId,
          topic: params.topic,
        });
        return result;
      } catch (error) {
        if (pending) barrier.cancel(pending);
        logger.lifecycle.warn("v4 conversation subscription failed", {
          ...lifecycleContext,
          durationMs: Date.now() - startedAt,
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "v4.conversation.subscribe.failed",
          module: "ui.v4.conversation_transport",
          runtimeGeneration,
          sessionId,
          status: "failed",
          topic: params.topic,
        });
        throw error;
      }
    },
    activate(subscriptionId: string): void {
      const activation = barrier.activate(subscriptionId);
      if (activation?.previousSubscriptionId) {
        decoder.discard(activation.topic, activation.previousSubscriptionId);
        topicBySubscriptionId.delete(activation.previousSubscriptionId);
      }
      logger.lifecycle.info("v4 conversation subscription activated", {
        ...lifecycleContext,
        event: "v4.conversation.subscribe.activated",
        module: "ui.v4.conversation_transport",
        runtimeGeneration,
        status: "completed",
        subscriptionId,
        ...(activation?.topic ? { topic: activation.topic } : {}),
      });
    },
    async resync(params: ConversationResyncParams): Promise<V4ConversationResyncResult> {
      await ensureHandshake();
      const topic = topicBySubscriptionId.get(params.subscriptionId);
      if (!topic) throw new Error("fault.subscription.notOwned");
      // Open the decoder's fail-closed gate before the RPC; the assembler ordinal tombstone remains,
      // so a K+1 recovery that arrives during the same read before the Promise continuation can enter, while <=K is still dropped.
      decoder.recover(topic, params.subscriptionId);
      return agentService.resyncConversationV4({
        ...workspace,
        subscriptionId: params.subscriptionId,
        base: params.base,
        ...(params.forceSnapshot !== undefined ? { forceSnapshot: params.forceSnapshot } : {}),
      });
    },
    async unsubscribe(subscriptionId: string): Promise<void> {
      // Release local ownership first; do not continue forwarding frames if the old service proxy's handshake/RPC has already failed.
      const startedAt = Date.now();
      barrier.forget(subscriptionId);
      const subscriptionTopic = topicBySubscriptionId.get(subscriptionId);
      topicBySubscriptionId.delete(subscriptionId);
      if (subscriptionTopic) decoder.discard(subscriptionTopic, subscriptionId);
      logger.lifecycle.info("v4 conversation unsubscription started", {
        ...lifecycleContext,
        event: "v4.conversation.unsubscribe.started",
        module: "ui.v4.conversation_transport",
        runtimeGeneration,
        status: "started",
        subscriptionId,
        ...(subscriptionTopic ? { topic: subscriptionTopic } : {}),
      });
      try {
        await ensureHandshake();
        await agentService.unsubscribeConversationV4({
          ...workspace,
          subscriptionId,
        });
        logger.lifecycle.info("v4 conversation unsubscription completed", {
          ...lifecycleContext,
          durationMs: Date.now() - startedAt,
          event: "v4.conversation.unsubscribe.completed",
          module: "ui.v4.conversation_transport",
          runtimeGeneration,
          status: "completed",
          subscriptionId,
          ...(subscriptionTopic ? { topic: subscriptionTopic } : {}),
        });
      } catch (error) {
        logger.lifecycle.warn("v4 conversation unsubscription failed", {
          ...lifecycleContext,
          durationMs: Date.now() - startedAt,
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "v4.conversation.unsubscribe.failed",
          module: "ui.v4.conversation_transport",
          runtimeGeneration,
          status: "failed",
          subscriptionId,
          ...(subscriptionTopic ? { topic: subscriptionTopic } : {}),
        });
        throw error;
      }
    },
    async sendCommand(envelope: CommandEnvelope): Promise<CommandAck> {
      const hello = await ensureHandshake();
      const payload = envelope.payload as {
        planEnabled?: boolean;
        config?: { planEnabled?: boolean };
        firstInput?: { planEnabled?: boolean };
      };
      // Old Hosts strip unknown fields; do not accidentally send yolo + Plan as full-access execution.
      if (
        hello.capabilities.independentPlanState !== true &&
        (payload.planEnabled || payload.config?.planEnabled || payload.firstInput?.planEnabled)
      ) {
        throw new Error("proto.independentPlanUnsupported");
      }
      // Old Hosts strip unknown fields; an incognito create must never run as a normal session.
      if (
        envelope.type === "createSession" &&
        (envelope.payload as { incognito?: unknown }).incognito !== undefined &&
        (hello.capabilities.incognitoSession !== true ||
          hello.capabilities.incognitoProfileV2 !== true)
      ) {
        throw new Error(INCOGNITO_UNSUPPORTED_ERROR);
      }
      return sendWithConversationDelayE2E(envelope, () =>
        agentService.sendConversationCommandV4({ ...workspace, envelope }),
      );
    },
    async queryCommands(params: CommandsQueryParams): Promise<CommandsQueryResult> {
      await ensureHandshake();
      return agentService.queryConversationCommandsV4({
        ...workspace,
        commands: params.commands,
      });
    },
    async rowsRange(params: V4ConversationRowsRangeParams): Promise<V4ConversationRowsRangeResult> {
      await ensureHandshake();
      return agentService.conversationRowsRangeV4({
        ...workspace,
        sessionId: params.sessionId,
        ...(params.beforeRowId !== undefined ? { beforeRowId: params.beforeRowId } : {}),
        limit: params.limit,
      });
    },
    async plans(params: V4ConversationPlansParams): Promise<V4ConversationPlansResult> {
      await ensureHandshake();
      return agentService.conversationPlansV4({
        ...workspace,
        sessionId: params.sessionId,
      });
    },
    // The two read-only dwf journal queries are split into agentConversationTransportWorkflowRuns.ts (max-lines boundary).
    ...createWorkflowRunTransportMethods({ agentService, ensureHandshake, workspace }),
    async fileChanges(
      params: V4ConversationFileChangesParams,
    ): Promise<V4ConversationFileChangesResult> {
      await ensureHandshake();
      return agentService.conversationFileChangesV4({
        ...workspace,
        sessionId: params.sessionId,
        target: params.target,
        baseRevision: params.baseRevision,
        baseLogEpoch: params.baseLogEpoch,
      });
    },
    async fileRewindPreview(
      params: V4ConversationFileRewindPreviewParams,
    ): Promise<V4ConversationFileRewindPreviewResult> {
      await ensureHandshake();
      return agentService.conversationFileRewindPreviewV4({
        ...workspace,
        sessionId: params.sessionId,
        target: params.target,
        baseRevision: params.baseRevision,
        baseLogEpoch: params.baseLogEpoch,
      });
    },
    async attachmentPut(
      params: V4AttachmentPutParams,
      options?: AttachmentUploadOptions,
    ): Promise<V4AttachmentPutResult> {
      await ensureHandshake();
      return uploadAttachmentTransaction(agentService, workspace, params, options);
    },
    async attachmentRead(params) {
      params.signal?.throwIfAborted();
      await ensureHandshake();
      params.signal?.throwIfAborted();
      if (target.createLocalMediaPreviewUrl && params.mediaType?.startsWith("video/")) {
        const source = await agentService.attachmentPreviewSourceV4({
          ...workspace,
          sessionId: params.sessionId,
          ref: params.ref,
          ...(params.target ? { target: params.target } : {}),
          ...(params.attachmentIndex !== undefined
            ? { attachmentIndex: params.attachmentIndex }
            : {}),
        });
        params.signal?.throwIfAborted();
        if (source.kind === "local_path") {
          return {
            url: target.createLocalMediaPreviewUrl(source.path),
            mediaType: source.mediaType,
          };
        }
      }
      const chunks: Uint8Array[] = [];
      let offset = 0;
      let totalBytes: number | null = null;
      let mediaType: string | null = null;

      for (let chunkIndex = 0; ; chunkIndex += 1) {
        params.signal?.throwIfAborted();
        // Sent-video reads previously used the 64-chunk upload-transaction limit, preventing previews for videos over 20 MiB.
        if (chunkIndex >= PROTOCOL_V4_LIMITS.attachmentPreviewMaxChunks) {
          throw new Error("fault.attachment.previewTooManyChunks");
        }
        const result = await agentService.attachmentReadV4({
          ...workspace,
          sessionId: params.sessionId,
          ref: params.ref,
          ...(params.target ? { target: params.target } : {}),
          ...(params.attachmentIndex !== undefined
            ? { attachmentIndex: params.attachmentIndex }
            : {}),
          offset,
          limit: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
        });
        // The old request-id guard only ignored late results; reading could continue after the Dialog closed,
        // fetching up to 30 MiB of video. The high-level read supports cancellation and stops as soon as each in-flight chunk returns.
        params.signal?.throwIfAborted();
        totalBytes ??= result.totalBytes;
        mediaType ??= result.mediaType;
        if (result.totalBytes !== totalBytes || result.mediaType !== mediaType) {
          throw new Error("fault.attachment.previewChangedDuringRead");
        }
        const chunk = decodeBase64Chunk(result.dataBase64);
        const nextOffset = offset + chunk.byteLength;
        if (nextOffset > totalBytes) {
          throw new Error("fault.attachment.previewSizeMismatch");
        }
        if (result.nextOffset !== null && result.nextOffset !== nextOffset) {
          throw new Error("fault.attachment.previewOffsetMismatch");
        }
        chunks.push(chunk);
        if (result.nextOffset === null) {
          if (nextOffset !== totalBytes) {
            throw new Error("fault.attachment.previewTruncated");
          }
          params.signal?.throwIfAborted();
          const bytes = new Uint8Array(totalBytes);
          let writeOffset = 0;
          for (const part of chunks) {
            bytes.set(part, writeOffset);
            writeOffset += part.byteLength;
          }
          return { bytes, mediaType };
        }
        if (chunk.byteLength === 0) {
          throw new Error("fault.attachment.previewEmptyChunk");
        }
        offset = result.nextOffset;
      }
    },
    async attachmentReadRange(params) {
      params.signal?.throwIfAborted();
      await ensureHandshake();
      params.signal?.throwIfAborted();
      const result = await agentService.attachmentReadV4({
        ...workspace,
        sessionId: params.sessionId,
        ref: params.ref,
        ...(params.target ? { target: params.target } : {}),
        ...(params.attachmentIndex !== undefined
          ? { attachmentIndex: params.attachmentIndex }
          : {}),
        offset: params.offset,
        limit: params.limit,
      });
      params.signal?.throwIfAborted();
      return {
        bytes: decodeBase64Chunk(result.dataBase64),
        mediaType: result.mediaType,
        totalBytes: result.totalBytes,
        nextOffset: result.nextOffset,
      };
    },
    onFrame(
      listener: (
        frame: ConversationTopicFrame,
        context?: { deliveryKind: TopicFrameDeliveryKind },
      ) => void,
    ): () => void {
      listeners.add(listener);
      if (!upstream) {
        if (!target.workspaceIdentity?.trim())
          ttftUpstream = agentService.onDynamicLocalTtftFacts?.(workspace)((facts) => {
            try {
              getLocalTtftObserver()?.checkpoint(target.workspacePath, facts);
              // CLI emits checkpoints at admitted/execution and each preparation phase, so queued input gets fresh calibration
              // within 60 seconds before first output without an extra timer or protocol.
              calibrate();
            } catch (error) {
              logger.debug("[local-ttft] checkpoint failed", { error });
            }
          });
        upstream = agentService.onDynamicConversationFrame(workspace)((frame) =>
          barrier.accept(frame),
        );
        logger.lifecycle.info("v4 conversation frame upstream attached", {
          ...lifecycleContext,
          event: "v4.conversation.frames.upstream_attached",
          listenerCount: listeners.size,
          module: "ui.v4.conversation_transport",
          runtimeGeneration,
          status: "completed",
        });
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          upstream?.dispose();
          ttftUpstream?.dispose();
          ttftUpstream = undefined;
          upstream = null;
          logger.lifecycle.info("v4 conversation frame upstream detached", {
            ...lifecycleContext,
            event: "v4.conversation.frames.upstream_detached",
            listenerCount: 0,
            module: "ui.v4.conversation_transport",
            runtimeGeneration,
            status: "completed",
          });
        }
      };
    },
    onAssemblyFault(listener) {
      faultListeners.add(listener);
      return () => faultListeners.delete(listener);
    },
    onRuntimeRestart(listener) {
      runtimeRestartListeners.add(listener);
      runtimeRestartUpstream ??= agentService.onAgentRuntimeRestarted((event) => {
        if (event.workspaceKey !== targetWorkspaceKey) return;
        if (!target.workspaceIdentity?.trim())
          getLocalTtftObserver()?.interrupt(target.workspacePath);
        runtimeGeneration += 1;
        // Runtime generations may reuse subId/ordinal; ownership and assembler state must be invalidated atomically.
        barrier.clear();
        decoder.clear();
        topicBySubscriptionId.clear();
        for (const restartListener of runtimeRestartListeners) restartListener("runtimeRestart");
      });
      return () => {
        runtimeRestartListeners.delete(listener);
        if (runtimeRestartListeners.size === 0) {
          runtimeRestartUpstream?.dispose();
          runtimeRestartUpstream = null;
        }
      };
    },
    ...(agentService.onAgentRuntimeLifecycle
      ? {
          onRuntimeLifecycle(listener: (state: "available" | "unavailable") => void) {
            runtimeLifecycleListeners.add(listener);
            runtimeLifecycleUpstream ??=
              agentService.onAgentRuntimeLifecycle?.((event) => {
                if (event.workspaceKey !== targetWorkspaceKey) return;
                if (event.state === "unavailable" && !target.workspaceIdentity?.trim())
                  getLocalTtftObserver()?.interrupt(target.workspacePath);
                // Forward only; do not change runtimeGeneration/barrier/decoder/topicBySubscriptionId. Those belong to
                // onRuntimeRestart, when the new runtime exists and can be safely resubscribed. When unavailable,
                // the old CLI is dead and will send no more frames; incrementing generation early would misalign ownership checks during the later restart.
                // If available and restart arrive simultaneously, that path performs the cleanup.
                for (const lifecycleListener of runtimeLifecycleListeners) {
                  lifecycleListener(event.state);
                }
              }) ?? null;
            return () => {
              runtimeLifecycleListeners.delete(listener);
              if (runtimeLifecycleListeners.size === 0) {
                runtimeLifecycleUpstream?.dispose();
                runtimeLifecycleUpstream = null;
              }
            };
          },
        }
      : {}),
  };
}

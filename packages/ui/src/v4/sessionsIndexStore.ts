/* eslint-disable max-lines -- The index projection, applied base, and recovery flight must be coordinated by one atomic store. */
// Renderer read-only store for the sessions-index topic:
// snapshot frames replace the full state; apply delta frames only when their range is contiguous (frame.fromSeq === watermark).
// Do not guess or buffer around gaps—resubscribe and let the server decide whether to resume or send a full snapshot (same policy as ConversationProjectionStore).
import {
  isDeterministicContentFault,
  PROTOCOL_V4_LIMITS,
  SUBSCRIPTION_CONTENT_REJECTED,
  type SessionSummary,
  type SessionsIndexTopicFrame,
  type TopicFrameDeliveryKind,
} from "@zcode/shared/zcode-protocol-v4";
import { isZCodeFileLockTimeoutError } from "@zcode/shared";
import { ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE } from "@zcode/services";
import { logger } from "@/logger.js";
import type { SessionsIndexTransport } from "@/v4/agentSessionsIndexTransport.js";

export interface SessionsIndexState {
  /** Known workspaceId; null = no snapshot yet. */
  workspaceId: string | null;
  logEpoch: string | null;
  /** Frame-range watermark (= toSeq of the latest frame). */
  seq: number;
  /** Conversation summaries indexed by sessionId (conflated). */
  sessions: Map<string, SessionSummary>;
}

export const EMPTY_SESSIONS_INDEX_STATE: SessionsIndexState = {
  workspaceId: null,
  logEpoch: null,
  seq: 0,
  sessions: new Map(),
};

export type SessionsIndexStoreStatus = "idle" | "dormant" | "connecting" | "live" | "error";

const RUNTIME_RESTART_RECONNECT_BASE_DELAY_MS = 100;
const RUNTIME_RESTART_RECONNECT_MAX_DELAY_MS = 5_000;
const RUNTIME_RESTART_BURST_RESET_MS = 30_000;
const TRANSIENT_SUBSCRIBE_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;
const ERROR_RECOVERY_RETRY_DELAYS_MS = [5_000, 15_000, 60_000] as const;

function isTransientSubscribeError(error: unknown): boolean {
  if (isZCodeFileLockTimeoutError(error)) {
    return true;
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  if (["EBUSY", "EMFILE", "ENFILE"].includes(code)) {
    return true;
  }
  if (code === "EEXIST" && message.includes("config.json.lock")) {
    return true;
  }
  return /\b(?:EBUSY|EMFILE|ENFILE)\b/.test(message) || message.includes("config.json.lock");
}

function isRuntimeUnavailableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE
  );
}

async function unsubscribeIgnoringFailure(
  transport: SessionsIndexTransport,
  subscriptionId: string,
): Promise<void> {
  try {
    await transport.unsubscribe(subscriptionId);
  } catch (error) {
    // After a service-proxy handoff, cleanup from the old store may still call a disconnected RPC.
    // Cleanup failure must not become an unhandled rejection or affect the new-generation registry entry.
    logger.warn(
      `[v4-sessions-index] unsubscribe ${subscriptionId} 失败（忽略）: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export interface ApplySessionsIndexResult {
  state: SessionsIndexState;
  /** true = frame-range gap (fromSeq is not contiguous with the watermark); the caller should resubscribe. */
  gap: boolean;
}

/** Pure apply: snapshots replace the full state; deltas upsert/remove items only when contiguous. */
export function applySessionsIndexFrame(
  current: SessionsIndexState,
  frame: SessionsIndexTopicFrame,
): ApplySessionsIndexResult {
  if (frame.payload.kind === "snapshot") {
    const snapshot = frame.payload.snapshot;
    const sessions = new Map<string, SessionSummary>();
    for (const session of snapshot.sessions) {
      sessions.set(session.sessionId, session);
    }
    return {
      gap: false,
      state: {
        workspaceId: snapshot.workspaceId,
        logEpoch: snapshot.logEpoch,
        seq: frame.toSeq,
        sessions,
      },
    };
  }
  if (frame.toSeq <= current.seq) {
    return { state: current, gap: false };
  }
  // Deltas must be contiguous (fromSeq === current watermark); otherwise this is a gap.
  if (frame.fromSeq !== current.seq) {
    return { state: current, gap: true };
  }
  const sessions = new Map(current.sessions);
  for (const delta of frame.payload.deltas) {
    if (delta.op === "session.upserted") {
      sessions.set(delta.session.sessionId, delta.session);
    } else {
      sessions.delete(delta.sessionId);
    }
  }
  return {
    gap: false,
    state: { ...current, seq: frame.toSeq, sessions },
  };
}

/**
 * Read-only store compatible with useSyncExternalStore: subscribe + getState return stable references.
 * The state itself and pure applyFrame can be tested independently; transport binding (connect/handleFrame/close)
 * owns the subscription lifecycle and gap recovery.
 */
export class SessionsIndexStore {
  private state: SessionsIndexState = EMPTY_SESSIONS_INDEX_STATE;
  private readonly listeners = new Set<() => void>();
  /** Cached ordered list (stable getSessions reference avoids rerenders from creating a new array each time). */
  private cachedList: SessionSummary[] | null = null;
  // Transport binding (optional; pure applyFrame tests do not need it).
  private transport: SessionsIndexTransport | null = null;
  private frameUnsub: (() => void) | null = null;
  private faultUnsub: (() => void) | null = null;
  private restartUnsub: (() => void) | null = null;
  private lifecycleUnsub: (() => void) | null = null;
  private subscriptionId: string | null = null;
  private awaitingInitial: { subscriptionId: string; mode: "snapshot" | "resume" } | null = null;
  private subscriptionHasAppliedBase = false;
  private recovery: {
    subscriptionId: string;
    requestInFlight: boolean;
    ackReceived: boolean;
    validFrameSeen: boolean;
    upgradePending: boolean;
    ackMode: "snapshot" | "resume" | null;
    forceSnapshot: boolean;
    postRecoveryGapPending: boolean;
    frameDeadline: ReturnType<typeof setTimeout> | null;
    /** This flight was started for a deterministic content failure: finish as contentRejected and do not retry forever with backoff. */
    contentFault: boolean;
  } | null = null;
  private status: SessionsIndexStoreStatus = "idle";
  private generation = 0;
  private closed = false;
  private runtimeRestartReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private runtimeRestartBurstCount = 0;
  private lastRuntimeRestartAt = 0;
  private subscribeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private errorRecoveryRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private errorRecoveryRetryAttempt = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): SessionsIndexState => this.state;

  getStatus(): SessionsIndexStoreStatus {
    return this.status;
  }

  /**
   * Bind the transport and subscribe: register the frame listener + subscribe (watermark invariant: include base only when holding consistent state).
   * A gap frame triggers a resubscribe without base (from handleFrame). After close, connect may run again
   * through the same path (for React effect unmount/remount, including StrictMode's double invocation).
   */
  async connect(
    transport: SessionsIndexTransport,
    options: {
      forceSnapshot?: boolean;
      initialOverflowRetry?: boolean;
      subscribeRetryAttempt?: number;
      errorRecoveryRetryAttempt?: number;
    } = {},
  ): Promise<void> {
    if (this.runtimeRestartReconnectTimer) {
      clearTimeout(this.runtimeRestartReconnectTimer);
      this.runtimeRestartReconnectTimer = null;
    }
    this.clearSubscribeRetry();
    if (options.errorRecoveryRetryAttempt === undefined) {
      this.clearErrorRecoveryRetry();
      this.errorRecoveryRetryAttempt = 0;
    }
    this.closed = false;
    this.transport = transport;
    if (!this.frameUnsub) {
      this.frameUnsub = transport.onFrame((frame, context) => this.handleFrame(frame, context));
      this.faultUnsub = transport.onAssemblyFault((fault) => {
        if (fault.subscriptionId === this.subscriptionId) {
          this.handleAssemblyFault(fault.subscriptionId, fault.deliveryKind, fault.reasonCode);
        }
      });
      if (transport.onRuntimeLifecycle) {
        this.lifecycleUnsub = transport.onRuntimeLifecycle((state) => {
          if (state === "available") this.handleRuntimeAvailable();
          else this.handleRuntimeUnavailable();
        });
      } else {
        this.restartUnsub = transport.onRuntimeRestart(() => this.handleRuntimeRestart());
      }
    }
    const generation = ++this.generation;
    this.discardRecovery();
    this.status = "connecting";
    this.emit();
    const base =
      options.forceSnapshot || this.state.logEpoch === null
        ? undefined
        : { logEpoch: this.state.logEpoch, seq: this.state.seq };
    try {
      const result = await transport.subscribe(base ? { base } : {});
      if (generation !== this.generation || this.closed) {
        void unsubscribeIgnoringFailure(transport, result.ack.subscriptionId);
        return;
      }
      // Same reason as conversationProjectionStore.connect (production notOwned deadlock):
      // while awaiting the subscribe ACK, the old subscription may create same-sub recovery, even though the host
      // scope silently evicts old ownership when the new ACK calls remember(). Once handoff succeeds, discard old recovery
      // so its late failure does not mark the live new subscription as error.
      this.discardRecovery();
      this.subscriptionId = result.ack.subscriptionId;
      this.status = "live";
      this.clearErrorRecoveryRetry();
      this.errorRecoveryRetryAttempt = 0;
      this.subscriptionHasAppliedBase = Boolean(
        base && result.ack.mode === "resume" && result.ack.logEpoch === base.logEpoch,
      );
      this.awaitingInitial = {
        subscriptionId: result.ack.subscriptionId,
        mode: result.ack.mode,
      };
      // Initial frames arrive only through notifications; bind the generation first, then activate to release frames queued before the ACK.
      transport.activate(result.ack.subscriptionId);
      this.emit();
    } catch (error) {
      if (generation !== this.generation || this.closed) return;
      this.awaitingInitial = null;
      this.subscriptionHasAppliedBase = false;
      if (isRuntimeUnavailableError(error)) {
        // Passive list subscriptions for restored workspaces previously treated a missing runtime as a normal failure
        // and retried with backoff, eventually causing getClient to start the CLI in bulk. A dormant state waits for lifecycle events without a timer.
        this.handleRuntimeUnavailable();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("fault.subscription.initialFrameStagingOverflow") &&
        !options.initialOverflowRetry
      ) {
        await this.connect(transport, {
          forceSnapshot: true,
          initialOverflowRetry: true,
          ...(options.errorRecoveryRetryAttempt !== undefined
            ? { errorRecoveryRetryAttempt: options.errorRecoveryRetryAttempt }
            : {}),
        });
        return;
      }
      const retryAttempt = options.subscribeRetryAttempt ?? 0;
      const retryDelay = TRANSIENT_SUBSCRIBE_RETRY_DELAYS_MS[retryAttempt];
      if (isTransientSubscribeError(error) && retryDelay !== undefined) {
        // During Host cold start, the provider registry's configuration lock may conflict briefly. If the first
        // subscribe failure were permanently set to error, the aggregation layer would publish an empty list and show “No conversations.”
        // Keep transient file-lock errors hydrating and resubscribe with bounded backoff; retain any existing snapshot.
        this.status = "connecting";
        logger.warn(`[v4-sessions-index] subscribe 瞬时失败，${retryDelay}ms 后重试: ${message}`);
        this.subscribeRetryTimer = setTimeout(() => {
          this.subscribeRetryTimer = null;
          if (this.closed || generation !== this.generation) return;
          void this.connect(transport, {
            ...(options.forceSnapshot ? { forceSnapshot: true } : {}),
            subscribeRetryAttempt: retryAttempt + 1,
            ...(options.errorRecoveryRetryAttempt !== undefined
              ? { errorRecoveryRetryAttempt: options.errorRecoveryRetryAttempt }
              : {}),
          });
        }, retryDelay);
        this.emit();
        return;
      }
      this.failAndScheduleRecovery(`subscribe:${message}`);
    }
  }

  /**
   * Replace the transport in place when the remote RPC proxy changes generation.
   *
   * Synchronously detach local listeners from the old transport, then force a snapshot from the new one. Remote unsubscribe is
   * best-effort and must not block the new proxy takeover. The server unsubscribes by subscriptionId, so late cleanup
   * cannot remove the new generation. Concurrent handoffs invalidate old results by store generation while preserving store identity and the last projection.
   */
  async replaceTransport(transport: SessionsIndexTransport): Promise<void> {
    if (!this.closed && this.transport === transport) return;

    const generation = ++this.generation;
    const previous = this.detachTransport();
    this.status = "connecting";
    this.emit();

    if (previous.transport && previous.subscriptionId) {
      // The old RPC may never settle after proxy handoff; waiting for it would leave the new transport
      // stuck connecting forever. Finish local detach first and let exact remote unsubscribe finish asynchronously.
      void unsubscribeIgnoringFailure(previous.transport, previous.subscriptionId);
    }
    if (generation !== this.generation || this.closed) return;

    await this.connect(transport, { forceSnapshot: true });
  }

  /** Frame-routing entry point (initial / online notification). A gap triggers resubscription. */
  handleFrame(
    frame: SessionsIndexTopicFrame,
    delivery?: { deliveryKind: TopicFrameDeliveryKind },
  ): void {
    if (this.closed) return;
    // Generation gate: workspace-level fan-out also delivers frames from other subscribers of the same topic
    // (the host-side task-index syncer subscribes to sessions-index persistently with a separate connectionId).
    // Without filtering by our subscriptionId, another subscriber's (fromSeq, toSeq] window looks like a gap and triggers a resubscribe storm.
    // The transport stages our initial frame with a bounded buffer until subscriptionId is available; activate releases it after binding.
    // Other old-generation or foreign frames are discarded here.
    if (this.subscriptionId === null || frame.subscriptionId !== this.subscriptionId) {
      return;
    }
    const awaitingInitial =
      this.awaitingInitial?.subscriptionId === frame.subscriptionId ? this.awaitingInitial : null;
    const deliveryKind = delivery?.deliveryKind ?? "online";
    const initial = deliveryKind === "initial" ? awaitingInitial : null;
    if (initial || (deliveryKind === "recovery" && awaitingInitial)) {
      this.awaitingInitial = null;
    }
    if (deliveryKind === "online" && this.recovery && frame.payload.kind === "snapshot") {
      const gap = this.applyFrame(frame);
      if (!gap) this.subscriptionHasAppliedBase = true;
      return;
    }
    if (deliveryKind === "online" && this.recovery) {
      if (frame.toSeq > this.state.seq) {
        this.recovery.postRecoveryGapPending ||= this.recovery.validFrameSeen;
      }
      return;
    }
    if (frame.payload.kind === "deltas" && !this.subscriptionHasAppliedBase) {
      this.requestRecovery(deliveryKind === "recovery");
      return;
    }
    const gap = this.applyFrame(frame);
    if (gap && this.transport) {
      logger.warn(
        `[v4-sessions-index] 帧断档 fromSeq=${frame.fromSeq} local=${this.state.seq}，重订阅`,
      );
      if (initial) void this.connect(this.transport, { forceSnapshot: true });
      else this.requestRecovery(deliveryKind === "recovery");
      return;
    }
    this.subscriptionHasAppliedBase = true;
    if (deliveryKind === "recovery") this.markRecoveryFrameSeen();
  }

  private handleAssemblyFault(
    subscriptionId: string,
    deliveryKind?: TopicFrameDeliveryKind,
    reasonCode?: string,
  ): void {
    if (subscriptionId !== this.subscriptionId) return;
    if (
      this.awaitingInitial?.subscriptionId === subscriptionId &&
      (deliveryKind === "initial" || deliveryKind === "recovery" || deliveryKind === undefined)
    ) {
      this.awaitingInitial = null;
    }
    // Deterministic content failures do not enter the transient retry ladder (04-sync closed rule 11): resume would resend the same rejected content.
    // Go straight to the forced snapshot, the only action that may produce different bytes, and stop if it is also rejected.
    // This store's fail-closed path clears the projection and resubscribes with bounded backoff, which would be a never-ending loop for deterministic failures.
    if (isDeterministicContentFault(reasonCode)) {
      this.requestRecovery(true, { contentFault: true });
      return;
    }
    if (deliveryKind === "online" && this.recovery) {
      this.recovery.postRecoveryGapPending ||= this.recovery.validFrameSeen;
      return;
    }
    this.requestRecovery(
      deliveryKind === "recovery" || (deliveryKind === undefined && this.recovery !== null),
    );
  }

  private requestRecovery(recoveryEvent = false, options: { contentFault?: boolean } = {}): void {
    const transport = this.transport;
    const subscriptionId = this.subscriptionId;
    if (this.closed || !transport || !subscriptionId) return;
    const contentFault = options.contentFault === true;
    const existing = this.recovery;
    if (existing) {
      // Once this flight has had a content failure, its terminal status remains content failure; a later transient fault must not erase that result.
      if (contentFault) existing.contentFault = true;
      if (!recoveryEvent) return;
      if (existing.forceSnapshot) {
        this.failRecovery("fault.subscription.recoveryFailed");
        return;
      }
      if (existing.requestInFlight || !existing.ackReceived) {
        existing.upgradePending = true;
        return;
      }
      if (existing.ackMode === "resume") this.issueRecovery(existing, true);
      else this.failRecovery("fault.subscription.recoveryFailed");
      return;
    }
    const recovery = {
      subscriptionId,
      requestInFlight: false,
      ackReceived: false,
      validFrameSeen: false,
      upgradePending: false,
      ackMode: null as "snapshot" | "resume" | null,
      forceSnapshot: false,
      postRecoveryGapPending: false,
      frameDeadline: null,
      contentFault,
    };
    this.recovery = recovery;
    // Content failures skip resume and force a snapshot; transient failures still try resume first, as before.
    this.issueRecovery(recovery, contentFault);
  }

  private issueRecovery(
    recovery: NonNullable<SessionsIndexStore["recovery"]>,
    forceSnapshot: boolean,
  ): void {
    const transport = this.transport;
    if (!transport) return;
    this.clearRecoveryDeadline(recovery);
    const effectiveForceSnapshot = forceSnapshot || !this.subscriptionHasAppliedBase;
    recovery.requestInFlight = true;
    recovery.ackReceived = false;
    recovery.ackMode = null;
    recovery.validFrameSeen = false;
    recovery.upgradePending = false;
    recovery.forceSnapshot = effectiveForceSnapshot;
    recovery.postRecoveryGapPending = false;
    void transport
      .resync({
        subscriptionId: recovery.subscriptionId,
        base:
          !this.subscriptionHasAppliedBase || this.state.logEpoch === null
            ? null
            : { logEpoch: this.state.logEpoch, seq: this.state.seq },
        ...(effectiveForceSnapshot ? { forceSnapshot: true } : {}),
      })
      .then((result) => {
        if (this.closed || this.recovery !== recovery) return;
        if (result.ack.subscriptionId !== recovery.subscriptionId) {
          throw new Error("fault.subscription.resyncGenerationMismatch");
        }
        recovery.requestInFlight = false;
        recovery.ackReceived = true;
        recovery.ackMode = result.ack.mode;
        this.settleRecovery(recovery);
      })
      .catch((error) => {
        if (this.closed || this.recovery !== recovery) return;
        this.clearRecoveryDeadline(recovery);
        this.recovery = null;
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[v4-sessions-index] resync 失败: ${message}`);
        if (isRuntimeUnavailableError(error)) {
          this.handleRuntimeUnavailable();
          return;
        }
        if (message.includes("fault.subscription.notOwned") && this.transport) {
          // Same reason as conversationProjectionStore.issueRecovery (production event):
          // notOwned is a deterministic ownership-state mismatch, not a transient fault; remaining in error would leave
          // the conversation list stuck forever. A fresh subscribe with the current watermark lets the server choose resume/snapshot
          // and self-heal. Special-case only notOwned to avoid reconnect storms from transient errors.
          void this.connect(this.transport);
          return;
        }
        this.failAndScheduleRecovery(`resync:${message}`);
      });
  }

  private markRecoveryFrameSeen(): void {
    const recovery = this.recovery;
    if (!recovery) return;
    recovery.validFrameSeen = true;
    this.settleRecovery(recovery);
  }

  private settleRecovery(recovery: NonNullable<SessionsIndexStore["recovery"]>): void {
    if (this.recovery !== recovery || !recovery.ackReceived || recovery.requestInFlight) return;
    if (recovery.upgradePending) {
      this.clearRecoveryDeadline(recovery);
      if (!recovery.forceSnapshot && recovery.ackMode === "resume") {
        this.issueRecovery(recovery, true);
      } else {
        this.failRecovery("fault.subscription.recoveryFailed");
      }
      return;
    }
    if (recovery.validFrameSeen) {
      this.clearRecoveryDeadline(recovery);
      if (recovery.postRecoveryGapPending) this.issueRecovery(recovery, false);
      else this.recovery = null;
      return;
    }
    if (recovery.frameDeadline) return;
    recovery.frameDeadline = setTimeout(() => {
      recovery.frameDeadline = null;
      if (this.closed || this.recovery !== recovery || recovery.validFrameSeen) return;
      if (!recovery.forceSnapshot) this.issueRecovery(recovery, true);
      else
        this.failRecovery("fault.subscription.recoveryFrameTimedOut", { contentEligible: false });
    }, PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
  }

  private clearRecoveryDeadline(recovery: NonNullable<SessionsIndexStore["recovery"]>): void {
    if (!recovery.frameDeadline) return;
    clearTimeout(recovery.frameDeadline);
    recovery.frameDeadline = null;
  }

  private discardRecovery(): void {
    if (this.recovery) this.clearRecoveryDeadline(this.recovery);
    this.recovery = null;
  }

  private clearSubscribeRetry(): void {
    if (!this.subscribeRetryTimer) return;
    clearTimeout(this.subscribeRetryTimer);
    this.subscribeRetryTimer = null;
  }

  private clearErrorRecoveryRetry(): void {
    if (!this.errorRecoveryRetryTimer) return;
    clearTimeout(this.errorRecoveryRetryTimer);
    this.errorRecoveryRetryTimer = null;
  }

  /**
   * Deterministic content failure: distinguish the terminal code from transport failure and **do not schedule a backoff resubscribe**—
   * resubscription would return the same unreadable content, turning this store's backoff into a never-ending loop
   * (clear projection → resubscribe → reject again → …). Recovery paths remain: runtime handoff, fresh connect, and user reconnect all resubscribe;
   * only the loop is removed.
   *
   * Use `contentEligible: false` for **timeout** terminal states: not receiving a recovery frame before the deadline is a transport symptom,
   * not contentRejected, and must not cancel a retry that may still succeed.
   */
  private failRecovery(reasonCode: string, options: { contentEligible?: boolean } = {}): void {
    // Read contentFault before discardRecovery.
    const contentFault = this.recovery?.contentFault === true && options.contentEligible !== false;
    this.failAndScheduleRecovery(contentFault ? SUBSCRIPTION_CONTENT_REJECTED : reasonCode, {
      scheduleRetry: !contentFault,
    });
  }

  /**
   * If recovery/subscribe fails, revoke the old projection's proof of liveness and fetch an authoritative snapshot again with bounded backoff.
   * Keep the error externally observable; retry only while the transport/runtime still belongs to the current generation.
   *
   * Use `scheduleRetry: false` only for deterministic failures: when a retry must return the same result, do not schedule it.
   */
  private failAndScheduleRecovery(
    reasonCode: string,
    options: { scheduleRetry?: boolean } = {},
  ): void {
    const transport = this.transport;
    const previousSubscriptionId = this.subscriptionId;
    this.discardRecovery();
    this.subscriptionId = null;
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.state = EMPTY_SESSIONS_INDEX_STATE;
    this.cachedList = null;
    this.status = "error";
    logger.warn(`[v4-sessions-index] recovery fail-closed: ${reasonCode}`);
    if (transport && previousSubscriptionId) {
      void unsubscribeIgnoringFailure(transport, previousSubscriptionId);
    }
    this.clearErrorRecoveryRetry();
    if (transport && !this.closed && options.scheduleRetry !== false) {
      const attempt = this.errorRecoveryRetryAttempt;
      const delayMs =
        ERROR_RECOVERY_RETRY_DELAYS_MS[
          Math.min(attempt, ERROR_RECOVERY_RETRY_DELAYS_MS.length - 1)
        ];
      const nextAttempt = Math.min(attempt + 1, ERROR_RECOVERY_RETRY_DELAYS_MS.length - 1);
      const generation = this.generation;
      this.errorRecoveryRetryAttempt = nextAttempt;
      this.errorRecoveryRetryTimer = setTimeout(() => {
        this.errorRecoveryRetryTimer = null;
        if (this.closed || this.transport !== transport || this.generation !== generation) {
          return;
        }
        void this.connect(transport, {
          forceSnapshot: true,
          errorRecoveryRetryAttempt: nextAttempt,
        });
      }, delayMs);
    }
    this.emit();
  }

  private handleRuntimeRestart(): void {
    if (this.closed || !this.transport) return;
    const transport = this.transport;
    const now = Date.now();
    if (now - this.lastRuntimeRestartAt >= RUNTIME_RESTART_BURST_RESET_MS) {
      this.runtimeRestartBurstCount = 0;
    }
    this.lastRuntimeRestartAt = now;
    const delayMs =
      this.runtimeRestartBurstCount === 0
        ? 0
        : Math.min(
            RUNTIME_RESTART_RECONNECT_BASE_DELAY_MS *
              2 ** Math.min(this.runtimeRestartBurstCount - 1, 16),
            RUNTIME_RESTART_RECONNECT_MAX_DELAY_MS,
          );
    this.runtimeRestartBurstCount += 1;
    this.generation += 1;
    this.clearErrorRecoveryRetry();
    this.errorRecoveryRetryAttempt = 0;
    this.subscriptionId = null;
    this.awaitingInitial = null;
    this.discardRecovery();
    this.subscriptionHasAppliedBase = false;
    if (this.status !== "connecting") {
      this.status = "connecting";
      this.emit();
    }
    if (this.runtimeRestartReconnectTimer) {
      clearTimeout(this.runtimeRestartReconnectTimer);
    }
    // Do not connect immediately for every runtimeRestarted event. If an upstream bug publishes repeated restarts,
    // subscribe can trigger more runtime launches and create an unbounded reconnect storm. Coalesce the burst into one fresh subscribe
    // and apply exponential backoff by consecutive count; after 30 seconds of stability, return to immediate reconnects.
    this.runtimeRestartReconnectTimer = setTimeout(() => {
      this.runtimeRestartReconnectTimer = null;
      if (this.closed || this.transport !== transport) return;
      void this.connect(transport, { forceSnapshot: true });
    }, delayMs);
  }

  private handleRuntimeAvailable(): void {
    if (this.closed || !this.transport) return;
    this.handleRuntimeRestart();
  }

  private handleRuntimeUnavailable(): void {
    if (this.closed) return;
    this.generation += 1;
    this.subscriptionId = null;
    this.awaitingInitial = null;
    this.discardRecovery();
    this.subscriptionHasAppliedBase = false;
    this.clearSubscribeRetry();
    this.clearErrorRecoveryRetry();
    this.errorRecoveryRetryAttempt = 0;
    if (this.runtimeRestartReconnectTimer) {
      clearTimeout(this.runtimeRestartReconnectTimer);
      this.runtimeRestartReconnectTimer = null;
    }
    // When the runtime no longer exists, running/attention in old summaries no longer has live proof. Persistent task rows remain in
    // tasks-index; clear the sessions-index projection to avoid orphaned spinners.
    this.state = EMPTY_SESSIONS_INDEX_STATE;
    this.cachedList = null;
    this.status = "dormant";
    this.emit();
  }

  /** Release the subscription and listeners (component unmount / workspace switch). */
  close(): void {
    this.closed = true;
    this.generation += 1;
    this.status = "idle";
    const previous = this.detachTransport();
    if (previous.subscriptionId && previous.transport) {
      void unsubscribeIgnoringFailure(previous.transport, previous.subscriptionId);
    }
  }

  private detachTransport(): {
    transport: SessionsIndexTransport | null;
    subscriptionId: string | null;
  } {
    const previous = {
      transport: this.transport,
      subscriptionId: this.subscriptionId,
    };
    if (this.runtimeRestartReconnectTimer) {
      clearTimeout(this.runtimeRestartReconnectTimer);
      this.runtimeRestartReconnectTimer = null;
    }
    this.runtimeRestartBurstCount = 0;
    this.lastRuntimeRestartAt = 0;
    this.clearSubscribeRetry();
    this.clearErrorRecoveryRetry();
    this.errorRecoveryRetryAttempt = 0;
    this.frameUnsub?.();
    this.frameUnsub = null;
    this.faultUnsub?.();
    this.faultUnsub = null;
    this.restartUnsub?.();
    this.restartUnsub = null;
    this.lifecycleUnsub?.();
    this.lifecycleUnsub = null;
    this.transport = null;
    this.subscriptionId = null;
    this.awaitingInitial = null;
    this.discardRecovery();
    this.subscriptionHasAppliedBase = false;
    return previous;
  }

  /** Apply a frame; return true on a gap (the caller should resubscribe). */
  applyFrame(frame: SessionsIndexTopicFrame): boolean {
    const { state, gap } = applySessionsIndexFrame(this.state, frame);
    if (gap) return true;
    if (state !== this.state) {
      this.state = state;
      this.cachedList = null;
      this.emit();
    }
    return false;
  }

  /** Clear on gaps/reconnect and wait for a new snapshot. */
  reset(): void {
    this.discardRecovery();
    this.subscriptionHasAppliedBase = false;
    this.state = EMPTY_SESSIONS_INDEX_STATE;
    this.cachedList = null;
    this.emit();
  }

  /** Conversation list (defaults to descending lastActivityAt; grouping/pinning belongs to a higher layer). */
  getSessions(): SessionSummary[] {
    if (this.cachedList === null) {
      this.cachedList = [...this.state.sessions.values()].sort(
        (a, b) => b.lastActivityAt - a.lastActivityAt,
      );
    }
    return this.cachedList;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

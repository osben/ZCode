/* eslint-disable max-lines -- projection/base/recovery/optimistic must share one atomic store state machine; splitting them would reintroduce races across objects. */
// Per-session projection store (read-only projection store).
// Subscription pushes are the only writers; the UI only reads. The client follows three rules:
//   1. snapshot → replace the whole state; never merge;
//   2. apply delta frames only when the ranges connect (frame.fromSeq === snapshot.seq); never guess or buffer gaps for later repair;
//   3. the base and state live and die together—on a gap, the state remains untouched and is resubscribed with the current watermark; the server decides resume vs. snapshot.
// Apart from the optimistic overlay (displaying pending commands), this store creates no conversation facts.
import {
  applyConversationDeltas,
  isDeterministicContentFault,
  parseConversationTopic,
  PROTOCOL_V4_LIMITS,
  type ConversationDelta,
  SUBSCRIPTION_CONTENT_REJECTED,
  type ConversationRow,
  type ConversationSnapshot,
  type ConversationOpenTiming,
  type ConversationTopicFrame,
  type SessionModelTransition,
  type ToolCallRow,
  type TopicFrameDeliveryKind,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import type { ConversationTurnNavigatorHydrationResult } from "@/v4/conversationTurnNavigatorHelpers.js";
import type { ConversationTransport } from "@/v4/transport.js";
import { ConversationRowPool } from "@/v4/conversationRowSharing.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

/** Backoff schedule after a runtime replacement interrupts subscribe. When the CUA Helper becomes ready on cold start, recycleUntilStable → disposeWorkspace reclaims the agent runtime and rejectAll interrupts in-flight subscribe calls. If this transient failure is left at status="error", the lazily started agent may not be brought back after dispose, so onRuntimeRestart never arrives and the panel can only recover when the user clicks "Reconnect". subscribeConversationV4 uses start-if-needed, so resubscribing also starts the runtime. Use the bounded backoff pattern already established by sessionsIndexStore. */
const RUNTIME_RECYCLE_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;

/** Grace period for the authoritative input projection after an accepted ACK. The core admission ACK does not wait for the TurnStarted/QueueItem/userInput projection; normally these paths differ by only one renderer/network round trip. A 2-second window covers typical desktop/mobile latency while quickly recovering from a half-open channel where the CLI keeps working but the subscription is completely silent. A timeout restores only the subscription; it does not replay the command. */
export const ACCEPTED_INPUT_PROJECTION_GRACE_MS = 2_000;
const ACCEPTED_INPUT_COMMAND_TYPES = new Set(["sendText", "editUserQuery"]);

export function requiresAcceptedInputProjection(type: string): boolean {
  return ACCEPTED_INPUT_COMMAND_TYPES.has(type);
}

/** lastError shown to the user when backoff is exhausted (for replacement paths with no underlying error object to reference). */
const RUNTIME_RECYCLED_ERROR = "ZCode agent runtime 已被回收，重连未成功";

function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function roundedDuration(startedAt: number, endedAt: number): number {
  return Math.max(0, Math.round(endedAt - startedAt));
}

/** Whether a transient subscribe failure was caused by runtime replacement or reclamation. All three messages can result from the same reclamation: ZCodeProtocolClient.rejectAll interrupts an in-flight request when the transport closes (transport closed), assertNotDisposed exits early when reusing a reclaimed client (client disposed), or fail-fast runs before the runtime starts again (runtime is not running). */
function isRuntimeRecycleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    // A cold subscription may start a new runtime itself; after restart invalidates an in-flight ACK, retry within bounds instead of remaining in error.
    message.includes("fault.subscription.runtimeRestarted") ||
    message.includes("ZCode agent transport closed") ||
    message.includes("ZCode Protocol client disposed") ||
    message.includes("ZCode Protocol client is disposed") ||
    message.includes("ZCode Agent runtime is not running")
  );
}

export function hasAcceptedInputProjection(
  snapshot: ConversationSnapshot | null,
  commandId: string,
): boolean {
  if (!snapshot) return false;
  if (snapshot.queue.items.some((item) => item.sourceCommandId === commandId)) return true;
  return snapshot.rows.window.some(
    (row) =>
      row.kind === "userInput" && row.origin === "realUser" && row.sourceCommandId === commandId,
  );
}

/**
 * Reconcile predicate for the optimistic first-input row (specs/first-submission-instant-ux.md
 * P1): only a visible real realUser row hides it — never the queue-item projection, which was
 * the header-preview blink. The first submission is definitionally its session's first user
 * row, so any visible realUser row hides the optimistic bubble; this also covers projections
 * that omit the optional sourceCommandId (a strict id-only match could strand a permanent
 * duplicate bubble instead).
 */
export function hasVisibleRealUserFirstInputRow(rows: readonly ConversationRow[]): boolean {
  return rows.some((row) => row.kind === "userInput" && row.origin === "realUser");
}

export type ConversationStoreStatus =
  // subscribe in flight (initial connection or resubscription after a gap).
  | "connecting"
  // Subscribed, with a continuous frame sequence.
  | "live"
  // subscribe failed; waiting for retry().
  | "error"
  // Released (after SessionDataLayer unsubscribes); no further operations are accepted.
  | "closed";

/** Optimistic overlay entry: the command was sent, but the server has not confirmed it in the projection yet. */
export interface OptimisticCommand {
  commandId: string;
  type: string;
  issuedAt: number;
}

export interface ConversationStoreState {
  status: ConversationStoreStatus;
  snapshot: ConversationSnapshot | null;
  subscriptionId: string | null;
  lastError: string | null;
  /** Low-frequency Host/CLI timing for the first conversation subscription; not part of snapshot facts. */
  openTiming?: ConversationOpenTiming;
  /** Renderer first-frame timing; notify it with the snapshot to prevent the UI from reading a partially updated diagnostic state. */
  rendererTiming?: SessionOpenRendererTiming;
  optimisticCommands: readonly OptimisticCommand[];
  /** In-flight loadOlder flag (prevents reentry during automatic prefetch). */
  loadingOlder: boolean;
  /** Terminal plan directory returned by the CLI's complete, valid projection. */
  sessionPlans: readonly ToolCallRow[];
  /** Used only to trigger a read-only plan-directory query; not a conversation protocol fact. */
  planDirectoryRevision: number;
  plansLoading: boolean;
  /** Invalidation generation for the question navigation directory (turn navigator). The not-enough-queries terminal result used to be validated only by logEpoch, but whether there are at least two navigable queries is derived from incremental changes. logEpoch identifies a log generation, not immutable content. Increment this revision when real-user queries change (row.appended/row.upserted matches realUser userInput, or row.removed truncates a branch) and when the snapshot is replaced, invalidating the terminal-result cache. */
  turnNavigatorDirectoryRevision: number;
}

export interface SessionOpenRendererTiming {
  rendererPrepareMs?: number;
  initialFrameTransportMs?: number;
  rendererSnapshotApplyMs?: number;
  snapshotAppliedAt?: number;
}

const INITIAL_STATE: ConversationStoreState = {
  status: "connecting",
  snapshot: null,
  subscriptionId: null,
  lastError: null,
  rendererTiming: undefined,
  optimisticCommands: [],
  loadingOlder: false,
  sessionPlans: [],
  planDirectoryRevision: 0,
  plansLoading: false,
  turnNavigatorDirectoryRevision: 0,
};

const TERMINAL_PLAN_STATUSES: ReadonlySet<ToolCallRow["status"]> = new Set([
  "success",
  "error",
  "cancelled",
]);

function shouldInvalidatePlanDirectory(frame: ConversationTopicFrame): boolean {
  if (frame.payload.kind === "snapshot") return true;
  return frame.payload.deltas.some((delta) => {
    if (delta.op === "row.removed") return true;
    if (delta.op !== "row.appended" && delta.op !== "row.upserted") return false;
    const row = delta.row;
    return (
      row.kind === "toolCall" &&
      row.toolName === "ExitPlanMode" &&
      TERMINAL_PLAN_STATUSES.has(row.status)
    );
  });
}

/** Whether the question navigation directory needs invalidation. The not-enough-queries terminal result used to be validated only by logEpoch, so adding a real-user query within the same epoch left the cache permanently valid. Conditions: full snapshot replacement invalidates it; row.removed invalidates it because rewind/branch pruning changes the navigable query set; row.appended/row.upserted matching realUser userInput invalidates it because a user question was added or changed; other deltas (streaming assistant text, tools, reasoning) do not trigger a re-probe. */
function shouldInvalidateTurnNavigatorDirectory(frame: ConversationTopicFrame): boolean {
  if (frame.payload.kind === "snapshot") return true;
  return frame.payload.deltas.some((delta) => {
    if (delta.op === "row.removed") return true;
    if (delta.op !== "row.appended" && delta.op !== "row.upserted") return false;
    const row = delta.row;
    return row.kind === "userInput" && row.origin === "realUser";
  });
}

function logSubagentProjectionTransition(
  topic: string,
  previous: ConversationSnapshot | null,
  next: ConversationSnapshot,
  delivery: "snapshot" | "deltas",
): void {
  const previousIds = previous?.subagents?.running.map((item) => item.childSessionId) ?? [];
  const nextIds = next.subagents?.running.map((item) => item.childSessionId) ?? [];
  if (
    previousIds.length === nextIds.length &&
    previousIds.every((childSessionId, index) => childSessionId === nextIds[index])
  ) {
    return;
  }
  // The interaction bug originates in subscription snapshot handoff, not the React DOM; only record lightweight identity and watermarks when the Agent runtime set changes.
  // This allows local reproduction to distinguish a valid terminal state from an overwritten late snapshot.
  logger.info("[v4-store] running subagent projection changed", {
    delivery,
    nextBackgroundWorkIds: next.backgroundWorks
      .filter((work) => work.kind === "subagent" && work.status === "running")
      .map((work) => work.childSessionId ?? work.workId),
    nextIds,
    nextSeq: next.seq,
    previousIds,
    previousSeq: previous?.seq ?? null,
    topic,
  });
}

// Earlier history is available iff the first row in the window is not the first row in total order (determined by firstRowId).
export function hasOlderRows(snapshot: ConversationSnapshot | null): boolean {
  if (!snapshot) return false;
  const first = snapshot.rows.window[0];
  if (!first || snapshot.rows.firstRowId === null) return false;
  return first.rowId > snapshot.rows.firstRowId;
}

// Shared pure function for stores and components; missing snapshots, empty windows, or unknown firstRowId values return false.
export function shouldAutoLoadIncompleteLeadingTurn(
  snapshot: ConversationSnapshot | null,
  loadingOlder: boolean,
): boolean {
  if (loadingOlder || !hasOlderRows(snapshot) || !snapshot) return false;
  const leadingTurnId = snapshot.rows.window[0]?.turnId;
  if (!leadingTurnId) return false;
  return !snapshot.rows.window.some(
    (row) => row.turnId === leadingTurnId && row.kind === "turnHeader",
  );
}

/** Whether the tail window of a cold snapshot starts in the middle of a turn. turnHeader is the authoritative start of a complete turn; the first row may be a lightBoundary, so checking only the first row kind is insufficient. Check whether the first turn has a header in the current window. */
export function mergeOlderRows(
  window: readonly ConversationRow[],
  fetched: readonly ConversationRow[],
): ConversationRow[] | null {
  const firstRowId = window[0]?.rowId ?? Number.POSITIVE_INFINITY;
  const older = fetched.filter((row) => row.rowId < firstRowId);
  if (older.length === 0) return null;
  return [...older, ...window];
}

/** Yield one macrotask. Microtasks would not release the renderer main thread, so chunked prepends use this between commits. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Merge rows/range results into the local window: key by rowId, accept only rows before the first row in the window, deduplicate, then prepend; sort by rowId ascending (total order). Return null when there are no rows to merge (the window is unchanged, so callers keep the same reference). */
/** External store (useSyncExternalStore compatible: subscribe + getState return stable references). SessionDataLayer owns its lifecycle (reference counting + keep-warm); components do not instantiate it directly. */
// Memory diagnostics counters: track the number of live stores and total rows in their rows.window collections to observe window-data growth. Add on construction and remove on close().
const liveProjectionStores = new Set<ConversationProjectionStore>();
uiMemoryDiagnosticsRegistry.register("projection", () => {
  let rows = 0;
  for (const store of liveProjectionStores) {
    rows += store.countProjectionRows();
  }
  return { stores: liveProjectionStores.size, rows };
});

export class ConversationProjectionStore {
  private state: ConversationStoreState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly modelTransitionListeners = new Set<
    (transition: SessionModelTransition) => void
  >();
  /** Side-channel listener for live-only deltas (plugin resource notifications); fires only after applying a delta frame, not a snapshot frame. */
  private readonly liveDeltaListeners = new Set<(deltas: readonly ConversationDelta[]) => void>();
  private observedModelTransitionEventId: string | null = null;
  // Subscription generation: concurrent connect calls accept only the newest generation; immediately unsubscribe stale results to prevent server-side leaks.
  private generation = 0;
  // Before the first subscription receives an ACK, runtime available is just the normal completion signal for the current startup flow.
  // Track in-flight calls so lifecycle notifications do not start another connect and create a same-topic subscription replacement race.
  private connectInFlight = 0;
  /** Keep subscribe ACK mode until the first logical frame of this generation; do not rely only on the synchronous activate stack, because a notification may arrive asynchronously after the ACK Promise resolves. */
  private awaitingInitial: { subscriptionId: string; mode: "snapshot" | "resume" } | null = null;
  /** Whether the current subscription watermark has been validated by an older applied base or a logical frame in this generation. */
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
    /** This flight was started for a deterministic content failure; classify its terminal result as contentRejected, outside transient-failure statistics. */
    contentFault: boolean;
  } | null = null;
  private readonly offAssemblyFault: () => void;
  private readonly offRuntimeRestart: (() => void) | null = null;
  private readonly offRuntimeLifecycle: (() => void) | null = null;
  private runtimeRecycleRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private runtimeRecycleRetryAttempt = 0;
  private sessionOpenRendererTiming: SessionOpenRendererTiming = {};
  private initialSubscribeAckAt: number | null = null;
  private planQueryInFlight = false;
  private planQueryPending = false;
  /** Projection confirmation watchdog for accepted input; it carries no commands and creates no local facts. */
  private readonly acceptedInputProjectionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Cached hydrated/not-enough-queries terminal result. It used to be validated only by
  // logEpoch, so adding a real-user query in the same epoch left it permanently valid. Add
  // directoryRevision; changes to real-user queries increment it, invalidating the terminal result and triggering a re-probe.
  private turnNavigatorHydrationTerminal:
    | (Extract<
        ConversationTurnNavigatorHydrationResult,
        { status: "hydrated" | "not-enough-queries" }
      > & { directoryRevision: number })
    | null = null;
  private closed = false;
  /**
   * Terminal flag: a subscribe failed with fault.subscribe.sessionNotFound (deleted draft prewarm /
   * removed session). Re-subscription can never succeed, and a keep-warm store would otherwise
   * re-subscribe on every workspace runtime-restart broadcast and error again.
   */
  private sessionGone = false;

  constructor(
    readonly topic: string,
    private readonly transport: ConversationTransport,
    // Row-structure sharing pool (docs/performance/conversation-row-structural-sharing.md).
    // SessionDataLayer injects a pool shared across stores; when constructed independently, sharing is scoped to this store.
    private readonly rowPool: ConversationRowPool = new ConversationRowPool(),
    /** Called once when the session is known gone; SessionDataLayer drops the keep-warm entry. */
    private readonly onSessionGone?: () => void,
  ) {
    liveProjectionStores.add(this);
    this.offAssemblyFault = transport.onAssemblyFault((fault) => {
      if (fault.topic === this.topic) {
        this.handleAssemblyFault(fault.subscriptionId, fault.deliveryKind, fault.reasonCode);
      }
    });
    // As in sessionsIndexStore, runtime replacement (a CLI process replacement) primarily uses the lifecycle channel: only unavailable is observable at dispose time, while onRuntimeRestart waits for the new process to spawn and may never arrive with lazy startup.
    // At dispose time, only unavailable can be observed; onRuntimeRestart waits for the new process to spawn and may never arrive with lazy startup.
    if (transport.onRuntimeLifecycle) {
      this.offRuntimeLifecycle = transport.onRuntimeLifecycle((state) => {
        if (state === "available") this.handleRuntimeAvailable();
        else this.handleRuntimeUnavailable();
      });
      // Proxy handoff is not runtime replacement; only the restart channel carries that meaning.
      // ReplaceableConversationTransport.replace() broadcasts only to runtimeRestartListeners and emits no lifecycle events.
      // If the restart channel were dropped here as an exclusive alternative, no one would handle proxy replacement in remote workspaces:
      // replace() best-effort unsubscribes the old proxy subscription, while the store remains live with the old
      // subscriptionId and the frame stream silently stops without recovering.
      // Listening only for transportReplaced keeps the paths distinct: an underlying runtime restart is forwarded by bindRuntimeRestartListener
      // as listener() (with no reason), and lifecycle available handles it.
      this.offRuntimeRestart = transport.onRuntimeRestart((reason) => {
        if (reason !== "transportReplaced") return;
        this.handleRuntimeRestart(reason);
      });
    } else {
      this.offRuntimeRestart = transport.onRuntimeRestart((reason) =>
        this.handleRuntimeRestart(reason),
      );
    }
  }

  getState(): ConversationStoreState {
    return this.state;
  }

  getSessionOpenRendererTiming(): SessionOpenRendererTiming {
    return { ...this.sessionOpenRendererTiming };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Subscribe to the list of deltas applied after each frame. Used for live-only `pluginUi.*` deltas
   * (they do not change rows or appear in snapshots); regular row state still uses subscribe + getState.
   */
  onLiveDeltas(listener: (deltas: readonly ConversationDelta[]) => void): () => void {
    this.liveDeltaListeners.add(listener);
    return () => this.liveDeltaListeners.delete(listener);
  }

  onOnlineModelTransition(listener: (transition: SessionModelTransition) => void): () => void {
    this.modelTransitionListeners.add(listener);
    return () => this.modelTransitionListeners.delete(listener);
  }

  private setState(patch: Partial<ConversationStoreState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Start or restart the subscription. Take base from the current snapshot watermark (include it only when we hold the consistent state at that point); forceSnapshot is the fallback when resumed frames still contain a gap, and dropping base requests a full snapshot. */
  async connect(
    options: {
      forceSnapshot?: boolean;
      retryInitialization?: string;
      initialOverflowRetry?: boolean;
      rendererPrepareStartedAt?: number;
    } = {},
  ): Promise<void> {
    if (this.closed || this.sessionGone) return;
    const generation = ++this.generation;
    this.discardRecovery();
    const snapshot = options.forceSnapshot ? null : this.state.snapshot;
    const connectStartedAt = options.rendererPrepareStartedAt ?? monotonicNow();
    const subscribeStartedAt = monotonicNow();
    logger.lifecycle.info("v4 conversation store connect started", {
      event: "v4.conversation.store.connect.started",
      generation,
      hasBase: Boolean(snapshot),
      module: "ui.v4.conversation_projection_store",
      status: "started",
      topic: this.topic,
    });
    this.sessionOpenRendererTiming = {
      rendererPrepareMs: roundedDuration(connectStartedAt, subscribeStartedAt),
    };
    this.initialSubscribeAckAt = null;
    this.connectInFlight += 1;
    this.setState({ status: "connecting", rendererTiming: this.sessionOpenRendererTiming });
    try {
      const result = await this.transport.subscribe({
        topic: this.topic,
        base: snapshot ? { logEpoch: snapshot.logEpoch, seq: snapshot.seq } : undefined,
        ...(options.retryInitialization
          ? { retryInitialization: options.retryInitialization }
          : {}),
      });
      if (generation !== this.generation || this.closed) {
        // Stale generation: no one consumes this subscription anymore, so unsubscribe immediately.
        logger.lifecycle.warn("v4 conversation store connect ACK became stale", {
          event: "v4.conversation.store.connect.stale_ack",
          generation,
          currentGeneration: this.generation,
          module: "ui.v4.conversation_projection_store",
          status: "failed",
          subscriptionId: result.ack.subscriptionId,
          topic: this.topic,
        });
        void this.transport.unsubscribe(result.ack.subscriptionId);
        return;
      }
      // Root cause of the production fault.subscription.notOwned hang: connect() only calls discardRecovery when starting.
      // A same-sub recovery can still be created for the old subscription while awaiting the subscribe ACK, but host scope
      // silently evicts the old subscription by ownershipKey when the new ACK calls remember(). Any in-flight resync from that recovery
      // is then rejected as notOwned. Discard old recovery as soon as replacement succeeds—the new subscription initial frame
      // atomically replaces the whole projection, making the old recovery stream useless; otherwise its late failure can put the new live subscription into error.
      this.discardRecovery();
      this.runtimeRecycleRetryAttempt = 0;
      this.initialSubscribeAckAt = monotonicNow();
      this.setState({
        status: "live",
        subscriptionId: result.ack.subscriptionId,
        lastError: null,
        openTiming: result.ack.openTiming,
      });
      this.subscriptionHasAppliedBase = Boolean(
        snapshot && result.ack.mode === "resume" && result.ack.logEpoch === snapshot.logEpoch,
      );
      // The public result is already ACK-only; initial and online frames both use notifications.
      // Store subscriptionId before activate so it can synchronously release its own initial frame buffered in the same read.
      this.awaitingInitial = {
        subscriptionId: result.ack.subscriptionId,
        mode: result.ack.mode,
      };
      this.transport.activate(result.ack.subscriptionId);
      logger.lifecycle.info("v4 conversation store connect completed", {
        durationMs: roundedDuration(subscribeStartedAt, monotonicNow()),
        event: "v4.conversation.store.connect.completed",
        generation,
        logEpoch: result.ack.logEpoch,
        mode: result.ack.mode,
        module: "ui.v4.conversation_projection_store",
        status: "completed",
        subscriptionId: result.ack.subscriptionId,
        topic: this.topic,
      });
    } catch (error) {
      if (generation !== this.generation || this.closed) return;
      const message = error instanceof Error ? error.message : String(error);
      this.awaitingInitial = null;
      this.subscriptionHasAppliedBase = false;
      if (
        message.includes("fault.subscription.initialFrameStagingOverflow") &&
        !options.initialOverflowRetry
      ) {
        // The physical batch was already incomplete before ACK, and there is no active same-sub yet; only a fresh
        // subscribe with a forced snapshot can recover. Retry automatically at most once to avoid a retry storm from a faulty peer.
        await this.connect({ forceSnapshot: true, initialOverflowRetry: true });
        return;
      }
      if (message.includes("fault.subscribe.sessionNotFound")) {
        // The session is gone for good: re-subscription can never succeed. Stop every reconnect path
        // (manual retry, runtime-restart/available broadcasts) and let the data layer drop the entry.
        this.clearRuntimeRecycleRetry();
        this.discardRecovery();
        this.awaitingInitial = null;
        this.sessionGone = true;
        logger.lifecycle.warn("v4 conversation store session gone", {
          durationMs: roundedDuration(subscribeStartedAt, monotonicNow()),
          errorMessage: message,
          event: "v4.conversation.store.connect.session_gone",
          generation,
          module: "ui.v4.conversation_projection_store",
          status: "failed",
          topic: this.topic,
        });
        logger.warn(`[v4-store] subscribe ${this.topic} 失败: 会话已删除，停止重连`);
        this.setState({ status: "error", lastError: message });
        this.onSessionGone?.();
        return;
      }
      if (this.scheduleRuntimeRecycleRetry(error, generation)) {
        logger.lifecycle.warn("v4 conversation store connect retry scheduled", {
          durationMs: roundedDuration(subscribeStartedAt, monotonicNow()),
          errorMessage: message,
          event: "v4.conversation.store.connect.retry_scheduled",
          generation,
          module: "ui.v4.conversation_projection_store",
          status: "retrying",
          topic: this.topic,
        });
        logger.warn(`[v4-store] subscribe ${this.topic} 被 runtime 换代打断，退避重连: ${message}`);
        return;
      }
      logger.lifecycle.warn("v4 conversation store connect failed", {
        durationMs: roundedDuration(subscribeStartedAt, monotonicNow()),
        errorMessage: message,
        event: "v4.conversation.store.connect.failed",
        generation,
        module: "ui.v4.conversation_projection_store",
        status: "failed",
        topic: this.topic,
      });
      logger.warn(`[v4-store] subscribe ${this.topic} 失败: ${message}`);
      this.setState({ status: "error", lastError: message });
    } finally {
      this.connectInFlight -= 1;
    }
  }

  private clearRuntimeRecycleRetry(): void {
    if (this.runtimeRecycleRetryTimer === null) return;
    clearTimeout(this.runtimeRecycleRetryTimer);
    this.runtimeRecycleRetryTimer = null;
  }

  /**
   * Subscribe failed because the runtime changed: stay connecting and retry with bounded backoff.
   * Returning true means this method took over the failure; callers should not set error.
   */
  private scheduleRuntimeRecycleRetry(error: unknown, generation: number): boolean {
    if (!isRuntimeRecycleError(error)) return false;
    return this.scheduleRuntimeRecycleReconnect(generation);
  }

  /**
   * Reconnect with bounded backoff. Resubscription uses start-if-needed (`zcodeAgentService.subscribeConversationV4`),
   * which can start the lazy runtime itself—the only self-healing path when available never arrives.
   * Returning true means this method took over; callers should not set error.
   */
  private scheduleRuntimeRecycleReconnect(generation: number): boolean {
    if (this.closed || this.sessionGone) return false;
    const delayMs = RUNTIME_RECYCLE_RETRY_DELAYS_MS[this.runtimeRecycleRetryAttempt];
    if (delayMs === undefined) return false;
    this.runtimeRecycleRetryAttempt += 1;
    this.clearRuntimeRecycleRetry();
    // Keep the old snapshot: the projection remains unpolluted during replacement and is atomically replaced after reconnect succeeds.
    this.setState({ status: "connecting" });
    this.runtimeRecycleRetryTimer = setTimeout(() => {
      this.runtimeRecycleRetryTimer = null;
      if (this.closed || generation !== this.generation) return;
      void this.connect();
    }, delayMs);
    return true;
  }

  /** At workspace-dispose: the old runtime is dead and the new one does not exist yet, so resubscription is not possible. */
  private handleRuntimeUnavailable(): void {
    if (this.closed || this.sessionGone) return;
    this.clearRuntimeRecycleRetry();
    this.discardRecovery();
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.generation += 1;
    // The old subscriptionId belongs to a dead runtime; do not unsubscribe because its host-side owner is already invalid.
    this.setState({ status: "connecting", subscriptionId: null });
    // Do not just become dormant and wait for available: the Agent starts lazily, and after dispose no one may start it,
    // so that signal would never arrive and the panel would spin forever. Backoff reconnect starts the runtime itself; if available arrives first, reset attempts and reconnect immediately.
    if (this.scheduleRuntimeRecycleReconnect(this.generation)) return;
    // When the retry budget is exhausted (runtime repeatedly recycled), set error to expose a Reconnect entry.
    // Otherwise connecting with no timer would spin forever with no manual retry available.
    this.setState({ status: "error", lastError: RUNTIME_RECYCLED_ERROR });
  }

  /** New runtime is ready: same as onRuntimeRestart, resubscribing from the original watermark. */
  private handleRuntimeAvailable(): void {
    if (this.closed || this.sessionGone) return;
    this.clearRuntimeRecycleRetry();
    this.runtimeRecycleRetryAttempt = 0;
    if (this.connectInFlight > 0) {
      // A cold-start spawn can broadcast available before the first subscribe ACK returns.
      // If we connect again here, the server replaces the old subscription on the same connection/topic; local generation protection
      // then unsubscribes the old ACK, racing first-frame handoff and potentially leaving the panel without a snapshot forever.
      // The current in-flight connect already handles this startup, so do not resubscribe again.
      return;
    }
    this.handleRuntimeRestart("runtimeRestart");
  }

  /** Manual retry after a subscription failure (target of the pane-level Reconnect button). */
  retry(): Promise<void> {
    if (this.sessionGone) return Promise.resolve();
    this.clearRuntimeRecycleRetry();
    this.runtimeRecycleRetryAttempt = 0;
    const initialization = this.state.snapshot?.runtimeInitialization;
    return this.connect(
      initialization?.status === "failed" ? { retryInitialization: initialization.attemptId } : {},
    );
  }

  /** Epoch/entity authority for a row command/query became invalid; recover through same-sub recovery. */
  recoverFromStaleAuthority(): void {
    this.requestRecovery();
  }

  /** Frame-routing entry point for SessionDataLayer. */
  handleFrame(
    frame: ConversationTopicFrame,
    delivery?: { deliveryKind: TopicFrameDeliveryKind },
  ): void {
    if (this.closed) return;
    // Generation guard: discard late frames from old subscriptions.
    if (frame.subscriptionId !== this.state.subscriptionId) return;
    const awaitingInitial =
      this.awaitingInitial?.subscriptionId === frame.subscriptionId ? this.awaitingInitial : null;
    const deliveryKind = delivery?.deliveryKind ?? "online";
    const frameReceivedAt = monotonicNow();
    // RPC timing cannot prove a frame's purpose. Only an initial frame marked by the publisher consumes
    // awaitingInitial; recovery must clear this state first so a recovery gap is not mistaken for an original-subscribe gap that needs a new subId.
    // A late duplicate online frame must not consume any gate.
    const initial = deliveryKind === "initial" ? awaitingInitial : null;
    if (initial || (deliveryKind === "recovery" && awaitingInitial)) {
      this.awaitingInitial = null;
    }
    if (deliveryKind === "online" && this.recovery && frame.payload.kind === "snapshot") {
      // An online overflow snapshot is complete authoritative state and can establish an applied base, but it does not count as
      // recovery delivery; the flight still waits for its own recovery frame/ACK to close.
      this.applyFrame(frame, { subscribeMode: null, recovery: false, online: true });
      return;
    }
    if (deliveryKind === "online" && this.recovery) {
      // An online frame after the recovery reservation may arrive in the same read as the ACK. If a non-duplicate online frame
      // appears after the recovery logical frame has applied, start a successor flight when the ACK closes.
      if (frame.toSeq > (this.state.snapshot?.seq ?? 0)) {
        this.recovery.postRecoveryGapPending ||= this.recovery.validFrameSeen;
      }
      return;
    }
    if (frame.payload.kind === "deltas" && !this.subscriptionHasAppliedBase) {
      // ACK(snapshot) does not establish an applied base. If initial was lost, matching fromSeq with the old projection by chance
      // still does not allow deltas from a new epoch to be applied to old state.
      this.requestRecovery(deliveryKind === "recovery");
      return;
    }
    this.applyFrame(frame, {
      subscribeMode: initial?.mode ?? null,
      recovery: deliveryKind === "recovery",
      online: deliveryKind === "online",
      frameReceivedAt,
    });
  }

  private applyFrame(
    frame: ConversationTopicFrame,
    context: {
      subscribeMode: "snapshot" | "resume" | null;
      recovery: boolean;
      online: boolean;
      frameReceivedAt?: number;
    },
  ): void {
    if (frame.payload.kind === "snapshot") {
      const hadAppliedBase = this.subscriptionHasAppliedBase;
      const snapshot = this.shareSnapshotRows(frame.payload.snapshot);
      logSubagentProjectionTransition(this.topic, this.state.snapshot, snapshot, "snapshot");
      // Rule 1: replace everything with the new snapshot (row objects reuse old references when their values match, but semantics remain full replacement).
      this.setState({
        snapshot,
        planDirectoryRevision: this.state.planDirectoryRevision + 1,
        // Replacing the whole snapshot may change the real-user query set, so invalidate terminal-state caches.
        turnNavigatorDirectoryRevision: this.state.turnNavigatorDirectoryRevision + 1,
      });
      this.subscriptionHasAppliedBase = true;
      this.reconcileOptimistic(snapshot);
      this.reconcileAcceptedInputProjection(snapshot);
      // Root cause: when initial is lost, the publisher allows a complete online snapshot to establish the first
      // applied base. Persistent transitions in it may predate this subscription and must not be reported as new live events.
      // The first frame seeds the observation baseline; only later online transitions notify the pane.
      this.observeModelTransition(snapshot, context.online && hadAppliedBase);
      if (context.subscribeMode !== null && context.frameReceivedAt !== undefined) {
        const snapshotAppliedAt = monotonicNow();
        this.sessionOpenRendererTiming = {
          ...this.sessionOpenRendererTiming,
          ...(this.initialSubscribeAckAt === null
            ? {}
            : {
                initialFrameTransportMs: roundedDuration(
                  this.initialSubscribeAckAt,
                  context.frameReceivedAt,
                ),
              }),
          rendererSnapshotApplyMs: roundedDuration(context.frameReceivedAt, snapshotAppliedAt),
          snapshotAppliedAt,
        };
        this.setState({ rendererTiming: this.sessionOpenRendererTiming });
      }
      if (context.recovery) this.markRecoveryFrameSeen();
      return;
    }
    const current = this.state.snapshot;
    // Rule 2a: silently discard late/duplicate logical frames. If this is an aligned recovery `(N,N]` after ACK,
    // close the flight without applying it again.
    if (current && frame.toSeq <= current.seq) {
      if (context.recovery) this.markRecoveryFrameSeen();
      return;
    }
    if (!current || frame.fromSeq !== current.seq) {
      // Rule 2: do not guess across a gap. The current state remains a consistent projection at seq=current.seq (this frame did not change it),
      // so the base remains valid; resubscribe and let the server choose resume or full snapshot. If the gap is in a subscribe-resume
      // frame (the server already tried resuming once and still did not connect), drop the base and force a snapshot to prevent a loop.
      logger.warn(
        `[v4-store] ${this.topic} 帧断档 fromSeq=${frame.fromSeq} local=${current?.seq ?? "none"}，重订阅`,
      );
      if (context.subscribeMode !== null) {
        // If the resume initial from a fresh subscribe still has a gap, create a new subscription and force a snapshot.
        // Gaps on an active subscription's online/recovery frames remain same-sub.
        void this.connect({ forceSnapshot: true });
      } else {
        this.requestRecovery(context.recovery);
      }
      return;
    }
    const applied = applyConversationDeltas(current, frame.payload.deltas);
    // seq is the snapshot-alignment watermark (R-03); after applying a delta frame, advance it to the frame's right endpoint.
    const next = this.shareDeltaRows({ ...applied, seq: frame.toSeq }, frame.payload.deltas);
    logSubagentProjectionTransition(this.topic, current, next, "deltas");
    const removedFromRowId = frame.payload.deltas.reduce<number | null>(
      (earliest, delta) =>
        delta.op === "row.removed"
          ? Math.min(earliest ?? delta.fromRowId, delta.fromRowId)
          : earliest,
      null,
    );
    this.setState({
      snapshot: next,
      // row.removed provides the authoritative truncation boundary, so remove stale branch plans from the cached directory immediately.
      // The full query still restores earlier plans outside the wire tail that belong to the current branch.
      ...(removedFromRowId === null
        ? {}
        : {
            sessionPlans: this.state.sessionPlans.filter((row) => row.rowId < removedFromRowId),
          }),
      ...(shouldInvalidatePlanDirectory(frame)
        ? { planDirectoryRevision: this.state.planDirectoryRevision + 1 }
        : {}),
      // Add/remove real-user queries (row.appended/row.upserted matches a realUser userInput, or row.removed truncates a branch)
      // increments the navigation-directory revision, invalidating terminal caches so they can be checked again.
      ...(shouldInvalidateTurnNavigatorDirectory(frame)
        ? {
            turnNavigatorDirectoryRevision: this.state.turnNavigatorDirectoryRevision + 1,
          }
        : {}),
    });
    this.subscriptionHasAppliedBase = true;
    this.reconcileOptimistic(next);
    this.reconcileAcceptedInputProjection(next);
    this.observeModelTransition(next, context.online);
    if (context.recovery) this.markRecoveryFrameSeen();
    for (const listener of this.liveDeltaListeners) listener(frame.payload.deltas);
  }

  /**
   * Root cause: all rows in a snapshot are newly deserialized objects, and when closure chains
   * retain historical snapshots, each holds its own copy of large strings (for example, hundreds
   * of copies of the same inputText). Replace rows/children with equal values by their older pooled references.
   */
  /** Share historical rows fetched through rows/range with older rows still alive in the pool (common when scrolling up after a cold open). */
  private shareRows(rows: readonly ConversationRow[]): ConversationRow[] {
    return rows.map((row) => this.rowPool.shareRow(this.topic, row));
  }

  private shareSnapshotRows(snapshot: ConversationSnapshot): ConversationSnapshot {
    const window = this.rowPool.shareWindow(
      this.topic,
      snapshot.rows.window,
      this.state.snapshot?.rows.window,
    );
    return window === snapshot.rows.window
      ? snapshot
      : { ...snapshot, rows: { ...snapshot.rows, window } };
  }

  /** Share new rows from row.upserted/row.appended; register row.delta only to avoid deep comparison on every streaming frame. */
  private shareDeltaRows(
    snapshot: ConversationSnapshot,
    deltas: readonly ConversationDelta[],
  ): ConversationSnapshot {
    const shareIds = new Set<number>();
    const rememberIds = new Set<number>();
    for (const delta of deltas) {
      if (delta.op === "row.upserted" || delta.op === "row.appended") shareIds.add(delta.row.rowId);
      else if (delta.op === "row.delta") rememberIds.add(delta.rowId);
    }
    if (shareIds.size === 0 && rememberIds.size === 0) return snapshot;
    let window: ConversationRow[] | null = null;
    snapshot.rows.window.forEach((row, index) => {
      if (shareIds.has(row.rowId)) {
        const shared = this.rowPool.shareRow(this.topic, row);
        if (shared !== row) {
          window ??= [...snapshot.rows.window];
          window[index] = shared;
        }
      } else if (rememberIds.has(row.rowId)) {
        this.rowPool.remember(this.topic, row);
      }
    });
    return window === null ? snapshot : { ...snapshot, rows: { ...snapshot.rows, window } };
  }

  private observeModelTransition(snapshot: ConversationSnapshot, online: boolean): void {
    const transition = snapshot.modelTransition;
    const eventId = transition?.eventId ?? null;
    if (eventId === this.observedModelTransitionEventId) return;
    // Persistent transitions replay with initial/recovery snapshots. If IDs are recorded only when showing a toast,
    // a later ordinary online snapshot may mistake an old fallback for a new event. Update the observation baseline on every valid frame;
    // notify the current client only on the first live online transition.
    this.observedModelTransitionEventId = eventId;
    if (!online || !transition) return;
    for (const listener of this.modelTransitionListeners) listener(transition);
  }

  /** Physical assembly fault: keep the old projection visible and recover with a single flight on the active subscription. */
  handleAssemblyFault(
    subscriptionId: string,
    deliveryKind?: TopicFrameDeliveryKind,
    reasonCode?: string,
  ): void {
    if (this.closed || subscriptionId !== this.state.subscriptionId) return;
    if (
      this.awaitingInitial?.subscriptionId === subscriptionId &&
      (deliveryKind === "initial" || deliveryKind === "recovery" || deliveryKind === undefined)
    ) {
      this.awaitingInitial = null;
    }
    // Deterministic content failures skip the transient retry ladder (04-sync closed rule 11): resume would deliver the same deltas
    // again and they would certainly be rejected. deliveryKind does not change this; this client cannot understand the content.
    // A forced snapshot is the only way to get different bytes, so jump directly to it and stop if it too is rejected for content,
    // rather than wasting the subscription on retries that must fail.
    if (isDeterministicContentFault(reasonCode)) {
      this.requestRecovery(true, { contentFault: true });
      return;
    }
    // A missing/fabricated deliveryKind arrives as an undefined typed fault. If recovery is already in flight,
    // fail closed/upgrade instead of treating the malformed recovery as an ordinary burst and waiting forever.
    const recoveryFault =
      deliveryKind === "recovery" || (deliveryKind === undefined && this.recovery !== null);
    if (deliveryKind === "online" && this.recovery) {
      this.recovery.postRecoveryGapPending ||= this.recovery.validFrameSeen;
      return;
    }
    this.requestRecovery(recoveryFault);
  }

  private requestRecovery(recoveryEvent = false, options: { contentFault?: boolean } = {}): void {
    if (this.closed) return;
    const subscriptionId = this.state.subscriptionId;
    if (!subscriptionId) {
      void this.connect({ forceSnapshot: true });
      return;
    }
    const contentFault = options.contentFault === true;
    const existing = this.recovery;
    if (existing) {
      // Once this flight has had a content failure, its terminal result remains a content failure; later transient faults must not erase that.
      if (contentFault) existing.contentFault = true;
      if (!recoveryEvent) return;
      if (existing.forceSnapshot) {
        this.failRecovery("fault.subscription.recoveryFailed");
        return;
      }
      // A recovery logical frame/fault may arrive before the ACK Promise continuation; remember the upgrade intent,
      // then force a snapshot immediately after ACK=resume. Ordinary burst gaps do not set this marker.
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
      ackMode: null,
      forceSnapshot: false,
      postRecoveryGapPending: false,
      frameDeadline: null,
      contentFault,
    };
    this.recovery = recovery;
    // Content failures skip the resume step and force a snapshot; transient failures still try resume first using the original ladder.
    this.issueRecovery(recovery, contentFault);
  }

  private issueRecovery(
    recovery: NonNullable<ConversationProjectionStore["recovery"]>,
    forceSnapshot: boolean,
  ): void {
    this.clearRecoveryDeadline(recovery);
    const snapshot = this.state.snapshot;
    const effectiveForceSnapshot = forceSnapshot || !this.subscriptionHasAppliedBase;
    recovery.requestInFlight = true;
    recovery.ackReceived = false;
    recovery.ackMode = null;
    recovery.upgradePending = false;
    recovery.validFrameSeen = false;
    recovery.forceSnapshot = effectiveForceSnapshot;
    recovery.postRecoveryGapPending = false;
    void this.transport
      .resync({
        subscriptionId: recovery.subscriptionId,
        base:
          this.subscriptionHasAppliedBase && snapshot
            ? { logEpoch: snapshot.logEpoch, seq: snapshot.seq }
            : null,
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
        logger.warn(`[v4-store] resync ${this.topic} 失败: ${message}`);
        if (message.includes("fault.subscription.notOwned")) {
          // Online event: notOwned means a layer no longer recognizes this subscription's ownership
          // (scope replacement silently evicted it, mismatched unsubscribe, or another state divergence). This is deterministic invalidation,
          // not a transient fault; stopping in error and waiting for manual reconnect would leave the session stuck forever.
          // The local snapshot is still consistent, so a fresh subscribe from the current watermark lets the server choose resume/snapshot
          // (04-sync rule 3) and recover. Special-case only notOwned to avoid reconnect storms on transient errors.
          void this.connect();
          return;
        }
        this.setState({ status: "error", lastError: message });
      });
  }

  private markRecoveryFrameSeen(): void {
    const recovery = this.recovery;
    if (!recovery) return;
    recovery.validFrameSeen = true;
    this.settleRecovery(recovery);
  }

  private settleRecovery(recovery: NonNullable<ConversationProjectionStore["recovery"]>): void {
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
      if (recovery.postRecoveryGapPending) {
        this.issueRecovery(recovery, false);
      } else {
        this.recovery = null;
      }
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

  private clearRecoveryDeadline(
    recovery: NonNullable<ConversationProjectionStore["recovery"]>,
  ): void {
    if (!recovery.frameDeadline) return;
    clearTimeout(recovery.frameDeadline);
    recovery.frameDeadline = null;
  }

  private discardRecovery(): void {
    if (this.recovery) this.clearRecoveryDeadline(this.recovery);
    this.recovery = null;
  }

  /**
   * `contentEligible: false` is used for a **timeout** terminal state: not receiving a recovery frame before the deadline is a transport symptom.
   * Even if a content failure started the flight, do not relabel it as contentRejected; that would also cancel a still-useful retry.
   */
  private failRecovery(reasonCode: string, options: { contentEligible?: boolean } = {}): void {
    if (!this.recovery) return;
    // Deterministic content failures and transport failures must remain distinct: reconnecting cannot fix the former, and telemetry
    // aggregated by code should not read a version mismatch as network instability (see reasonCode vocabulary in wire-fault.ts).
    const contentFault = this.recovery.contentFault && options.contentEligible !== false;
    const code = contentFault ? SUBSCRIPTION_CONTENT_REJECTED : reasonCode;
    this.discardRecovery();
    logger.warn(`[v4-store] ${this.topic} recovery fail-closed: ${code}`);
    this.setState({ status: "error", lastError: code });
  }

  private handleRuntimeRestart(reason?: "runtimeRestart" | "transportReplaced"): void {
    if (this.closed || this.sessionGone) return;
    // The transport has already invalidated the old ownership/assembler. Do not unsubscribe the old transport/runtime subId;
    // subscribe fresh and keep the old snapshot until the new snapshot replaces it atomically.
    this.generation += 1;
    this.discardRecovery();
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.setState({ status: "connecting", subscriptionId: null });
    // Proxy handoff is not a CLI runtime restart. Forcing a snapshot would replace user-loaded older rows with the tail window.
    // Handoff preserves a consistent projection watermark, letting the server choose resume or snapshot by logEpoch/seq;
    // a real runtime restart still uses full subscribe.
    if (reason === "transportReplaced") void this.connect();
    else void this.connect({ forceSnapshot: true });
  }

  /**
   * loadOlder: use the first row in the window as a cursor, fetch one page of older history, and prepend it.
   * - Single flight: repeated calls while in flight are no-ops (`loadingOlder` prevents re-entry).
   * - Stale-read guard: discard the whole result when atLogEpoch ≠ the current snapshot epoch (for example, after a CLI restart).
   * - Merge by rowId, consistent with subscription row.upserted/removed frames;
   *   deltas received in flight are unaffected because they update only rows ≥ the first row in the window.
   */
  async loadOlder(limit: number = PROTOCOL_V4_LIMITS.snapshotTailWindowRows): Promise<void> {
    if (this.closed || this.state.loadingOlder) return;
    const snapshot = this.state.snapshot;
    if (!hasOlderRows(snapshot) || !snapshot) return;
    const sessionId = parseConversationTopic(this.topic);
    if (!sessionId) return;
    const beforeRowId = snapshot.rows.window[0]?.rowId;
    if (beforeRowId === undefined) return;
    this.setState({ loadingOlder: true });
    try {
      const result = await this.transport.rowsRange({
        sessionId,
        beforeRowId,
        limit,
      });
      if (this.closed) return;
      const current = this.state.snapshot;
      if (!current || result.atLogEpoch !== current.logEpoch) {
        logger.warn(
          `[v4-store] ${this.topic} rows/range 纪元不匹配（${result.atLogEpoch}），整体丢弃`,
        );
        return;
      }
      // If the cursor becomes invalid in flight (row.removed truncation / full snapshot resync), discard the result
      // so history removed by the authority is not revived. The next trigger fetches from the new window.
      if (current.rows.window[0]?.rowId !== beforeRowId) return;
      const window = mergeOlderRows(current.rows.window, this.shareRows(result.rows));
      if (window === null) return;
      this.setState({
        snapshot: { ...current, rows: { ...current.rows, window } },
      });
    } catch (error) {
      // The query is read-only and can be repeated; on failure, do not enter error state and let the next trigger retry.
      logger.warn(
        `[v4-store] rowsRange ${this.topic} 失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (!this.closed) this.setState({ loadingOlder: false });
    }
  }

  /**
   * Full question directory: use the existing rows/range cursor to fetch the entire currently valid branch.
   *
   * Question navigation used to scan the renderer's tail window directly, so a 1000-turn session showed only the few dozen loaded turns.
   * Page up to the protocol limit here. Validation is all-or-nothing: no page is committed until every page has been fetched and checked.
   * The validated pages are then prepended one page per chunk, yielding to the event loop between chunks. Render units are cached per turnId,
   * so each chunk costs O(new turns) and one ~570 ms commit of the whole branch would block the renderer main thread.
   * `loadingOlder` stays true until the last chunk, which keeps scroll-triggered loadOlder and find auto-load suspended.
   */
  async loadAllOlder(): Promise<ConversationTurnNavigatorHydrationResult> {
    const stale = (logEpoch = this.state.snapshot?.logEpoch ?? "unknown") => ({
      status: "stale" as const,
      logEpoch,
    });
    if (this.closed || this.state.loadingOlder) return stale();
    const snapshot = this.state.snapshot;
    if (!snapshot) return stale();
    // A terminal result must match both logEpoch and directoryRevision. logEpoch identifies the log generation,
    // not immutable content; adding/removing real-user queries increments revision to invalidate the terminal result and allow a new scan.
    const directoryRevision = this.state.turnNavigatorDirectoryRevision;
    if (
      this.turnNavigatorHydrationTerminal?.logEpoch === snapshot.logEpoch &&
      this.turnNavigatorHydrationTerminal.directoryRevision === directoryRevision
    ) {
      return this.turnNavigatorHydrationTerminal;
    }
    if (!hasOlderRows(snapshot)) return stale(snapshot.logEpoch);
    const sessionId = parseConversationTopic(this.topic);
    const initialBeforeRowId = snapshot.rows.window[0]?.rowId;
    if (!sessionId || initialBeforeRowId === undefined) return stale(snapshot.logEpoch);

    const initialLogEpoch = snapshot.logEpoch;
    const preserveIncompleteLeadingTurn = shouldAutoLoadIncompleteLeadingTurn(snapshot, false);
    const pages: ConversationRow[][] = [];
    let beforeRowId = initialBeforeRowId;
    let committed = false;
    this.setState({ loadingOlder: true });
    logger.debug("[v4-store] 完整问题目录开始补拉历史 rows", {
      beforeRowId,
      loadedRows: snapshot.rows.window.length,
      sessionId,
      totalRows: snapshot.rows.totalCount,
    });

    try {
      while (true) {
        const result = await this.transport.rowsRange({
          sessionId,
          beforeRowId,
          limit: PROTOCOL_V4_LIMITS.rowsRangeMaxLimit,
        });
        if (this.closed) return stale(initialLogEpoch);
        const current = this.state.snapshot;
        if (
          !current ||
          result.atLogEpoch !== initialLogEpoch ||
          current.logEpoch !== initialLogEpoch ||
          current.rows.window[0]?.rowId !== initialBeforeRowId
        ) {
          logger.warn("[v4-store] 完整问题目录补拉期间投影游标失效，整批丢弃", {
            currentBeforeRowId: current?.rows.window[0]?.rowId,
            expectedBeforeRowId: initialBeforeRowId,
            resultLogEpoch: result.atLogEpoch,
            sessionId,
          });
          return stale(initialLogEpoch);
        }

        const older = result.rows.filter((row) => row.rowId < beforeRowId);
        const nextBeforeRowId = older[0]?.rowId;
        if (nextBeforeRowId === undefined || nextBeforeRowId >= beforeRowId) {
          logger.warn("[v4-store] 完整问题目录 rows/range 未推进游标，停止补拉", {
            beforeRowId,
            hasMore: result.hasMore,
            sessionId,
          });
          return { status: "retryable-failure", logEpoch: initialLogEpoch };
        }
        pages.push(older);
        beforeRowId = nextBeforeRowId;
        if (!result.hasMore) break;
      }

      const current = this.state.snapshot;
      if (
        !current ||
        current.logEpoch !== initialLogEpoch ||
        current.rows.window[0]?.rowId !== initialBeforeRowId
      ) {
        return stale(initialLogEpoch);
      }
      const olderRows = [...pages].reverse().flat();
      const realUserQueryCount = [...olderRows, ...current.rows.window].reduce(
        (count, row) => (row.kind === "userInput" && row.origin === "realUser" ? count + 1 : count),
        0,
      );
      if (realUserQueryCount < 2) {
        if (preserveIncompleteLeadingTurn) {
          const outcome = await this.prependOlderPagesInChunks(
            pages,
            initialLogEpoch,
            initialBeforeRowId,
          );
          if (outcome === "stale") return stale(initialLogEpoch);
          committed = true;
          // The navigator already has the authoritative rows needed to complete the first turn; commit them before hiding the rail.
          logger.debug("[v4-store] 完整问题目录不足两条 query，保留首轮补齐 rows", {
            loadedRows: this.state.snapshot?.rows.window.length ?? 0,
            pages: pages.length,
            sessionId,
          });
        }
        // The wire snapshot keeps only the last 60 rows. Zero/one query in the tail does not prove the full branch contains a single query.
        // On wide screens, scan to the branch start; if fewer than two are confirmed, do not merge the scanned pages,
        // avoiding retention of full history in the renderer projection for a rail that will not be shown.
        logger.debug("[v4-store] 完整问题目录探测后不足两条 query", {
          pages: pages.length,
          preservedIncompleteLeadingTurn: preserveIncompleteLeadingTurn,
          realUserQueryCount,
          sessionId,
        });
        const result = {
          status: "not-enough-queries" as const,
          logEpoch: initialLogEpoch,
          directoryRevision,
        };
        this.turnNavigatorHydrationTerminal = result;
        return result;
      }
      const outcome = await this.prependOlderPagesInChunks(
        pages,
        initialLogEpoch,
        initialBeforeRowId,
      );
      if (outcome === "stale") return stale(initialLogEpoch);
      committed = true;
      logger.debug("[v4-store] 完整问题目录历史 rows 补拉完成", {
        loadedRows: this.state.snapshot?.rows.window.length ?? 0,
        pages: pages.length,
        sessionId,
      });
      const result = {
        status: "hydrated" as const,
        logEpoch: initialLogEpoch,
        directoryRevision,
      };
      this.turnNavigatorHydrationTerminal = result;
      return result;
    } catch (error) {
      logger.warn(
        `[v4-store] 完整问题目录 rowsRange ${this.topic} 失败: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { status: "retryable-failure", logEpoch: initialLogEpoch };
    } finally {
      if (!this.closed && !committed) this.setState({ loadingOlder: false });
    }
  }

  /**
   * Prepend validated history pages one page per chunk, starting with the page adjacent to the window so the window grows top-ward.
   * Before every chunk the snapshot must still be on the same logEpoch and its first rowId must equal the cursor this chunk extends.
   * If either changed (forced snapshot, head-moving row.removed, epoch change, or close), stop without committing the remaining chunks.
   * The caller then returns stale without setting the terminal result. Chunks already committed remain valid rows of that epoch.
   * Only the last chunk clears loadingOlder, so the flag stays true for the whole prepend.
   */
  private async prependOlderPagesInChunks(
    pages: readonly ConversationRow[][],
    logEpoch: string,
    initialBeforeRowId: number,
  ): Promise<"committed" | "stale"> {
    if (pages.length === 0) return "stale";
    let expectedHeadRowId = initialBeforeRowId;
    for (const [index, page] of pages.entries()) {
      // Yield between chunks so input, paint and Timeline effects run before the next chunk commits.
      if (index > 0) await yieldToEventLoop();
      const current = this.state.snapshot;
      if (
        this.closed ||
        !current ||
        current.logEpoch !== logEpoch ||
        current.rows.window[0]?.rowId !== expectedHeadRowId
      ) {
        logger.warn("[v4-store] 完整问题目录分块提交期间投影游标失效，停止后续分块", {
          chunk: index + 1,
          chunks: pages.length,
          currentBeforeRowId: current?.rows.window[0]?.rowId,
          expectedBeforeRowId: expectedHeadRowId,
          topic: this.topic,
        });
        return "stale";
      }
      const window = mergeOlderRows(current.rows.window, this.shareRows(page));
      const nextHeadRowId = window?.[0]?.rowId;
      if (window === null || nextHeadRowId === undefined) return "stale";
      expectedHeadRowId = nextHeadRowId;
      const isLastChunk = index === pages.length - 1;
      this.setState({
        ...(isLastChunk ? { loadingOlder: false } : {}),
        snapshot: { ...current, rows: { ...current.rows, window } },
      });
    }
    return "committed";
  }

  /**
   * Coalesce concurrent plan-directory queries by the local invalidation revision.
   * Older plans may predate the snapshot tail, while edit/retry row.removed frames immediately stale an in-flight
   * query. Validate both revision and epoch so plans from an old branch cannot be written back to the UI.
   */
  async refreshPlans(): Promise<void> {
    if (this.closed) return;
    if (this.planQueryInFlight) {
      this.planQueryPending = true;
      return;
    }
    const snapshot = this.state.snapshot;
    const sessionId = parseConversationTopic(this.topic);
    if (!snapshot || !sessionId) return;
    const requestedGeneration = this.generation;
    const requestedRevision = this.state.planDirectoryRevision;
    this.planQueryInFlight = true;
    this.setState({ plansLoading: true });
    try {
      const result = await this.transport.plans({ sessionId });
      if (this.closed) return;
      if (this.generation !== requestedGeneration) return;
      const current = this.state.snapshot;
      if (!current || current.logEpoch !== result.atLogEpoch) {
        return;
      }
      if (this.state.planDirectoryRevision !== requestedRevision) {
        this.planQueryPending = true;
        return;
      }
      this.setState({ sessionPlans: result.plans });
    } catch (error) {
      if (!this.closed) {
        logger.warn(
          `[v4-store] plans ${this.topic} 失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      this.planQueryInFlight = false;
      if (!this.closed) this.setState({ plansLoading: false });
      if (this.planQueryPending && !this.closed) {
        this.planQueryPending = false;
        void this.refreshPlans();
      }
    }
  }

  /** Register an overlay before sending a command (for pending/stopping display). */
  markCommandPending(command: OptimisticCommand): void {
    if (this.closed) return;
    this.setState({
      optimisticCommands: [...this.state.optimisticCommands, command],
    });
  }

  /**
   * After ACK accepted/duplicate, register an input command that must become visible in the authoritative projection.
   *
   * Command RPC and conversation topic are independent channels. A gap is detectable only when a later
   * delta arrives; if the topic is completely silent after ACK, the CLI continues working but the UI never receives the user row.
   * Do not fabricate a message here; after a bounded wait, reuse the existing same-sub recovery. The watchdog closes as soon as the authoritative projection includes a queue/user row.
   */
  expectAcceptedInputProjection(commandId: string): void {
    if (this.closed || this.acceptedInputProjectionTimers.has(commandId)) return;
    const command = this.state.optimisticCommands.find((item) => item.commandId === commandId);
    if (!command || !requiresAcceptedInputProjection(command.type)) return;
    if (hasAcceptedInputProjection(this.state.snapshot, commandId)) {
      this.settleCommand(commandId);
      return;
    }
    const timer = setTimeout(() => {
      this.acceptedInputProjectionTimers.delete(commandId);
      if (
        this.closed ||
        !this.state.optimisticCommands.some((item) => item.commandId === commandId)
      ) {
        return;
      }
      if (hasAcceptedInputProjection(this.state.snapshot, commandId)) {
        this.settleCommand(commandId);
        return;
      }
      logger.warn("[v4-store] accepted input projection silent, trigger same-sub recovery", {
        commandId,
        topic: this.topic,
      });
      this.requestRecovery();
    }, ACCEPTED_INPUT_PROJECTION_GRACE_MS);
    this.acceptedInputProjectionTimers.set(commandId, timer);
  }

  private clearAcceptedInputProjectionWatch(commandId: string): void {
    const timer = this.acceptedInputProjectionTimers.get(commandId);
    if (timer !== undefined) clearTimeout(timer);
    this.acceptedInputProjectionTimers.delete(commandId);
  }

  /** Remove the overlay when the command is locally finalized as rejected/failed, etc. */
  settleCommand(commandId: string): void {
    this.clearAcceptedInputProjectionWatch(commandId);
    const remaining = this.state.optimisticCommands.filter(
      (command) => command.commandId !== commandId,
    );
    if (remaining.length !== this.state.optimisticCommands.length) {
      this.setState({ optimisticCommands: remaining });
    }
  }

  // Once the server projection includes this commandId (pendingCommands / userInput.sourceCommandId anchor), the authoritative side owns the display and the overlay is removed.
  private reconcileOptimistic(snapshot: ConversationSnapshot): void {
    if (this.state.optimisticCommands.length === 0) return;
    const acknowledged = new Set<string>(
      snapshot.pendingCommands.map((command) => command.commandId),
    );
    const inputProjectionIds = new Set<string>();
    for (const item of snapshot.queue.items) {
      inputProjectionIds.add(item.sourceCommandId);
    }
    for (const row of snapshot.rows.window) {
      if (row.kind === "userInput" && row.sourceCommandId) {
        acknowledged.add(row.sourceCommandId);
        if (row.origin === "realUser") inputProjectionIds.add(row.sourceCommandId);
      }
    }
    const remaining = this.state.optimisticCommands.filter((command) =>
      requiresAcceptedInputProjection(command.type)
        ? !inputProjectionIds.has(command.commandId)
        : !acknowledged.has(command.commandId),
    );
    if (remaining.length !== this.state.optimisticCommands.length) {
      this.setState({ optimisticCommands: remaining });
    }
  }

  private reconcileAcceptedInputProjection(snapshot: ConversationSnapshot): void {
    for (const commandId of this.acceptedInputProjectionTimers.keys()) {
      if (!hasAcceptedInputProjection(snapshot, commandId)) continue;
      this.clearAcceptedInputProjectionWatch(commandId);
      this.settleCommand(commandId);
    }
  }

  /** In-memory diagnostic: number of rows in the current rows.window; read-only. */
  countProjectionRows(): number {
    return this.state.snapshot?.rows.window.length ?? 0;
  }

  /** Unsubscribe and dispose this store (called only by SessionDataLayer). */
  async close(): Promise<void> {
    if (this.closed) return;
    liveProjectionStores.delete(this);
    const closeStartedAt = monotonicNow();
    logger.lifecycle.info("v4 conversation store close started", {
      event: "v4.conversation.store.close.started",
      generation: this.generation,
      module: "ui.v4.conversation_projection_store",
      status: "started",
      subscriptionId: this.state.subscriptionId,
      topic: this.topic,
    });
    this.closed = true;
    this.offAssemblyFault();
    this.offRuntimeRestart?.();
    this.offRuntimeLifecycle?.();
    this.clearRuntimeRecycleRetry();
    for (const timer of this.acceptedInputProjectionTimers.values()) clearTimeout(timer);
    this.acceptedInputProjectionTimers.clear();
    this.modelTransitionListeners.clear();
    this.discardRecovery();
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.generation++;
    const { subscriptionId } = this.state;
    this.setState({ status: "closed", subscriptionId: null });
    if (subscriptionId) {
      try {
        await this.transport.unsubscribe(subscriptionId);
      } catch (error) {
        logger.lifecycle.warn("v4 conversation store close unsubscribe failed", {
          durationMs: roundedDuration(closeStartedAt, monotonicNow()),
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "v4.conversation.store.close.unsubscribe_failed",
          module: "ui.v4.conversation_projection_store",
          status: "failed",
          subscriptionId,
          topic: this.topic,
        });
        logger.warn(`[v4-store] unsubscribe ${this.topic} 失败（忽略）: ${String(error)}`);
      }
    }
    logger.lifecycle.info("v4 conversation store close completed", {
      durationMs: roundedDuration(closeStartedAt, monotonicNow()),
      event: "v4.conversation.store.close.completed",
      module: "ui.v4.conversation_projection_store",
      status: "completed",
      topic: this.topic,
    });
  }
}

// Conversation topic publisher (transport shell).
// Authoritative CLI runtime: bounded in-memory delta log (logEpoch + retention window) +
// subscribe(base) decision (resume/snapshot) + per-subscriber flush pipeline
// (filter → coalesce → frame).
//
// Responsibilities:
// - This class owns authoritative accounting from events to frames, but performs no network I/O
//   or timer work. The host drives flush timing (the host channel schedules by
//   profile.flushWindowMs; tests call it manually), keeping advancement deterministic and testable.
// - Resume and streaming share one pipeline: the initial resume frame is the retained-window
//   delta in (base.seq, current], filtered by the subscriber profile and then coalesced. The
//   golden test "snapshot(W)+stream ≡ full replay" therefore directly covers recovery.
// - Resubscription replaces: subscribing again with the same connectionId invalidates the old
//   subscription and clears its flush buffer. The old subscriptionId emits no more frames, and
//   the client drops frames from older generations by subId.
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type {
  CommandEnvelope,
  ConversationDelta,
  ConversationRowTarget,
  ConversationSnapshot,
  ConversationTopicFrame,
  DeliveryProfile,
  DeliveryProfileName,
  QueueItem,
  SubscribeAck,
  ToolCallRow,
  TopicFrameDeliveryKind,
  V4ConversationPlansResult,
  V4ConversationRowsRangeResult,
} from "@zcode/shared/zcode-protocol-v4";
import {
  DELIVERY_PROFILES,
  PROTOCOL_V4_LIMITS,
  clampWorkflowRunsForLegacy,
  coalesceConversationDeltas,
  filterConversationDeltasForProfile,
  filterConversationRowsForProfile,
  utf8JsonByteLength,
} from "@zcode/shared/zcode-protocol-v4";
import { Buffer } from "node:buffer";
import {
  encodeConversationDeltasForLegacy,
  workflowRunDeltaGrowthUpperBound,
} from "./conversation-workflow-run-deltas.js";
import {
  ProductProjection,
  type ConversationRowTargetAction,
  type ConversationRowTargetResolution,
  type SessionConfigSeed,
  type SessionSubagentsSeed,
  type SessionUsageSeed,
  type StableForkCandidateResolution,
} from "./product-projection.js";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";

interface LogEntry {
  seq: number;
  deltas: ConversationDelta[];
}

const TERMINAL_PLAN_STATUSES: ReadonlySet<ToolCallRow["status"]> = new Set([
  "success",
  "error",
  "cancelled",
]);

/**
 * Cold replay measures temporary deltas frequently; TextEncoder would allocate a full Uint8Array
 * for every measurement. The CLI is guaranteed to run in Node, so calculate the exact UTF-8 byte
 * count directly from the same JSON text instead of estimating.
 */
export function coldHydrationJsonByteLength(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasPlanMarkdown(row: ToolCallRow): boolean {
  if (isRecord(row.input)) {
    const plan = row.input.plan;
    if (typeof plan === "string" && plan.trim().length > 0) return true;
  }
  if (!row.inputText.trim()) return false;
  try {
    const parsed: unknown = JSON.parse(row.inputText);
    return isRecord(parsed) && typeof parsed.plan === "string" && parsed.plan.trim().length > 0;
  } catch {
    return false;
  }
}

interface Subscription {
  subscriptionId: string;
  connectionId: string;
  profile: DeliveryProfile;
  /**
   * Whether this subscription understands `workflowRun.*` key-level deltas (a handshake
   * capability injected by the trusted host). false means an old consumer: fold deltas into
   * whole-key patches and trim snapshots to the legacy boundary
   * (conversation-workflow-run-deltas.ts).
   */
  workflowRunDeltas: boolean;
  /** Flush buffer: profile filtering and per-subscription encoding happen on push; flush coalesces them into a frame. */
  buffer: ConversationDelta[];
  bufferBytes: number;
  /** After buffer overflow, keep only the recovery intent; do not keep accumulating deltas for a slow subscriber. */
  resyncRequired: boolean;
  /** Frame interval accounting watermark: fromSeq of the next frame ((fromSeq, toSeq] semantics). */
  sentSeq: number;
  /** Stable logical frame reserved during encoding/writing. */
  inFlight: TopicFrameReservation<ConversationTopicFrame> | null;
  /** Metadata snapshot requests that arrived after the current frame was reserved. */
  snapshotRequestGeneration: number;
  nextLogicalFrameOrdinal: number;
}

export interface ConversationSubscribeParams {
  connectionId: string;
  base?: { logEpoch: string; seq: number };
  /** Defaults to replayable (the WebSocket default; MessagePort hosts explicitly pass continuous). */
  deliveryProfile?: DeliveryProfileName;
  /**
   * Whether this connection's clientHello declared support for `workflowRun.*` deltas. Like
   * deliveryProfile, this is injected by the trusted host and cannot be selected by UI subscribe.
   * Defaults to false; absent capability means legacy consumer.
   */
  workflowRunDeltas?: boolean;
}

export interface ConversationSubscribeResult {
  ack: SubscribeAck;
  reservation: TopicFrameReservation<ConversationTopicFrame> | null;
  /** Atomically restore the replaced subscription if initial encoding fails before ACK admission. */
  rollback(): boolean;
  /** Snapshot frame or resume continuation frame; null for resume with no new data (client watermark is aligned). */
  readonly frame: ConversationTopicFrame | null;
}

export interface ConversationResyncRequest {
  base: { logEpoch: string; seq: number } | null;
  forceSnapshot?: boolean;
}

export interface ConversationTopicPublisherOptions {
  /** CLI clock (source for frame.sentAt / clockOffset estimation). */
  now?: () => number;
  /** Event retention window (entry count), defaults to PROTOCOL_V4_LIMITS.eventRetentionPerSession. */
  retention?: number;
  /** Per-subscriber op limit after coalescing; mainly for protocol configuration and boundary tests. */
  subscriberBufferMaxOps?: number;
  /** Per-subscriber UTF-8 byte limit for the logical deltas payload. */
  subscriberBufferMaxBytes?: number;
}

export interface ConversationSubscriberBufferLimits {
  maxOps?: number;
  /** Byte floor (default 1MiB); for the effective limit see conversationSubscriberBufferByteLimit. */
  maxBytes?: number;
  /** Conservative upper bound of the current wire snapshot logical frame; default 0 means the floor alone decides. */
  snapshotBytesUpperBound?: number;
}

export class ProjectionPayloadTooLargeError extends Error {
  readonly reasonCode = "proto.payloadTooLarge";

  constructor(readonly logicalBytes: number) {
    super(
      `conversation projection exceeds ${PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes} bytes`,
    );
    this.name = "ProjectionPayloadTooLargeError";
  }
}

// While running, leave room for the bounded terminal patch from TurnError/TurnComplete; otherwise,
// if the body reaches 16 MiB exactly, the terminal state that stops the turn cannot fit in a
// transportable snapshot either.
export const PROJECTION_TERMINAL_RESERVE_BYTES = 64 * 1024;

// The row.actions schema has only four true booleans and one short enum; including JSON keys and
// parent wrappers it is under 128 bytes. Reserve the full amount for each wire-tail row between
// batch checkpoints so deferred materialization cannot underestimate the payload upper bound.
const HYDRATION_ACTION_BYTES_PER_WIRE_ROW = 128;
const HYDRATION_EVENT_WIRE_OVERHEAD_BYTES = 64;
// In a logical snapshot frame, the sequence number appears in both frame.toSeq and snapshot.seq.
const HYDRATION_SEQUENCE_NUMBER_OCCURRENCES = 2;

function hydrationSequenceNumberBytes(sequenceNumber: number): number {
  return String(sequenceNumber).length * HYDRATION_SEQUENCE_NUMBER_OCCURRENCES;
}

export type ConversationSubscriberBufferResult =
  | {
      kind: "buffered";
      deltas: ConversationDelta[];
      encodedBytes: number;
    }
  | { kind: "overflow" };

function nonNegativeHardBound(value: number | undefined, maximum: number, name: string): number {
  const resolved = value ?? maximum;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return Math.min(Math.floor(resolved), maximum);
}

/**
 * The subscriber buffer's effective byte limit = min(max(floor, snapshot upper bound), 16MiB - 64KiB) (05 §3).
 * Fix rationale: overflow exists to trade a backlog of deltas for a smaller snapshot; the old implementation fixed it at 1MiB, so a single large
 * delta (for example a tool row upsert carrying 3MiB of bash output) would degrade to a snapshot, yet the snapshot is larger still because the
 * same row remains in the tail window. It also made the client replace the whole state and drop already-paginated history rows, so the turn
 * navigator re-paginated in full—once per turn in long sessions. The outer clamp leaves assembly headroom for the frame shell; deltas frames stay <=16MiB.
 */
export function conversationSubscriberBufferByteLimit(
  floorBytes: number,
  snapshotBytesUpperBound: number,
): number {
  return Math.min(
    Math.max(floorBytes, snapshotBytesUpperBound),
    PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes - PROJECTION_TERMINAL_RESERVE_BYTES,
  );
}

/**
 * Deltas after profile filtering enter this pure function; merge them with the existing buffer
 * and coalesce first, then enforce both op and UTF-8 byte limits. Limits must actually be
 * enforced: storing raw delta[] without checking them would keep accumulating data for slow
 * subscribers and eventually produce an unbounded frame.
 */
export function appendConversationSubscriberBuffer(
  current: readonly ConversationDelta[],
  incoming: readonly ConversationDelta[],
  limits: ConversationSubscriberBufferLimits = {},
): ConversationSubscriberBufferResult {
  const maxOps = nonNegativeHardBound(
    limits.maxOps,
    PROTOCOL_V4_LIMITS.subscriberBufferMaxOps,
    "maxOps",
  );
  const maxBytes = nonNegativeHardBound(
    limits.maxBytes,
    PROTOCOL_V4_LIMITS.subscriberBufferMaxBytes,
    "maxBytes",
  );
  const byteLimit = conversationSubscriberBufferByteLimit(
    maxBytes,
    limits.snapshotBytesUpperBound ?? 0,
  );
  const deltas = coalesceConversationDeltas([...current, ...incoming]);
  if (deltas.length > maxOps) return { kind: "overflow" };
  const encodedBytes = utf8JsonByteLength({ kind: "deltas", deltas });
  if (encodedBytes > byteLimit) return { kind: "overflow" };
  return { kind: "buffered", deltas, encodedBytes };
}

export class ConversationTopicPublisher {
  readonly topic: string;
  private projection: ProductProjection;
  private readonly now: () => number;
  private readonly retention: number;
  private readonly subscriberBufferMaxOps: number;
  private readonly subscriberBufferMaxBytes: number;
  /** Bounded log in ascending seq order; resume is valid only within (floorSeq, currentSeq]. */
  private readonly log: LogEntry[] = [];
  /** Retention floor: a resume request with base.seq < floorSeq cannot continue losslessly, so it must use a snapshot. */
  private floorSeq = 0;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly subscriptionIdByConnection = new Map<string, string>();
  private nextSubscriptionSerial = 1;
  private nextLogicalFrameSerial = 1;
  /** Preparation metadata is not sequenced with conversation events; keep its history for reconnect decisions. */
  private worktreePreparationWasSeeded = false;
  /** Conservative upper bound for the current logical snapshot frame; streaming appends accumulate only deltas and serialize exactly near the limit. */
  private wireSnapshotBytesUpperBound: number;

  constructor(
    private readonly sessionId: string,
    private readonly logEpoch: string,
    options: ConversationTopicPublisherOptions = {},
  ) {
    this.topic = `conversation/${sessionId}`;
    this.projection = new ProductProjection(sessionId, logEpoch);
    this.now = options.now ?? Date.now;
    this.retention = options.retention ?? PROTOCOL_V4_LIMITS.eventRetentionPerSession;
    this.subscriberBufferMaxOps = nonNegativeHardBound(
      options.subscriberBufferMaxOps,
      PROTOCOL_V4_LIMITS.subscriberBufferMaxOps,
      "subscriberBufferMaxOps",
    );
    this.subscriberBufferMaxBytes = nonNegativeHardBound(
      options.subscriberBufferMaxBytes,
      PROTOCOL_V4_LIMITS.subscriberBufferMaxBytes,
      "subscriberBufferMaxBytes",
    );
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  getSnapshot(): ConversationSnapshot {
    return this.projection.getSnapshot();
  }

  /** Logical TopicFrame byte measure shared by tests/gates (not the bare snapshot size). */
  getWireSnapshotLogicalBytes(): number {
    return this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  resolveStableForkCandidate(rowId: number): StableForkCandidateResolution {
    return this.projection.resolveStableForkCandidate(rowId);
  }

  /** Inject a config seed: update the projection's initial value directly without producing a delta or entering the event log. See ProductProjection.seedConfig. */
  seedConfig(seed: SessionConfigSeed): void {
    this.projection.seedConfig(seed);
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  /** Share-import hints are static read-only metadata; they do not enter delta/revision and can be seeded idempotently after hydration. */
  seedSharedContextImport(
    source: ConversationSnapshot["sharedContextImport"] | null | undefined,
  ): void {
    this.projection.seedSharedContextImport(source);
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  /** Worktree preparation is Host-owned setup metadata; it does not enter transcript deltas. */
  seedWorktreePreparation(
    preparation: ConversationSnapshot["meta"]["worktreePreparation"] | null | undefined,
  ): void {
    if (preparation) this.worktreePreparationWasSeeded = true;
    this.projection.seedWorktreePreparation(preparation);
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  /** Invalidate each subscriber's pending frame and make its next flush carry the current snapshot. */
  requestSnapshotForSubscribers(): void {
    for (const subscription of this.subscriptions.values()) {
      subscription.buffer = [];
      subscription.bufferBytes = 0;
      subscription.resyncRequired = true;
      subscription.snapshotRequestGeneration += 1;
    }
  }

  /** Inject a usage seed: on cold restore, persisted token watermarks replace the 0 placeholders synthesized from the transcript. */
  seedUsage(seed: SessionUsageSeed): void {
    this.projection.seedUsage(seed);
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  /** Store-verified subagent manifest for cold hydration; does not produce a delta. */
  seedSubagents(seed: SessionSubagentsSeed): void {
    this.projection.seedSubagents(seed);
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  /**
   * Snapshot sent over the wire: rows contain only the tail window (snapshotTailWindowRows),
   * while totalCount/firstRowId preserve full-order semantics. The client uses
   * `window[0].rowId === firstRowId` to detect reaching the top; older history is fetched through
   * rows/range cursors. The projection's internal snapshot remains full because rows/range data
   * sources and findRow/messageId anchors depend on it; truncate only at the frame boundary.
   */
  private getWireSnapshot(snapshot = this.projection.getSnapshot()): ConversationSnapshot {
    return this.getWireSnapshotForProfile(DELIVERY_PROFILES.continuous, snapshot);
  }

  private getWireSnapshotForProfile(
    profile: DeliveryProfile,
    snapshot = this.projection.getSnapshot(),
  ): ConversationSnapshot {
    const visibleRows = filterConversationRowsForProfile(snapshot.rows.window, profile);
    const visibleSnapshot: ConversationSnapshot = {
      ...snapshot,
      rows: {
        ...snapshot.rows,
        window: visibleRows,
        totalCount: visibleRows.length,
        firstRowId: visibleRows[0]?.rowId ?? null,
      },
    };
    const limit = PROTOCOL_V4_LIMITS.snapshotTailWindowRows;
    if (visibleRows.length <= limit) return visibleSnapshot;
    return {
      ...visibleSnapshot,
      rows: { ...visibleSnapshot.rows, window: visibleRows.slice(-limit) },
    };
  }

  /**
   * Snapshot frame for one subscriber: profile determines row visibility, and the capability
   * bit determines whether `workflowRuns` is sent in full or at the legacy boundary.
   *
   * Snapshot and deltas must use the same capability level: if a client receiving legacy
   * whole-key patches suddenly gets 512 nodes in a snapshot, its `.max(256)` rejects the
   * **entire frame** (a parse error on a known key does not merely strip that key).
   */
  private getWireSnapshotForSubscription(subscription: Subscription): ConversationSnapshot {
    const snapshot = this.getWireSnapshotForProfile(subscription.profile);
    if (subscription.workflowRunDeltas || snapshot.workflowRuns === undefined) return snapshot;
    const workflowRuns = clampWorkflowRunsForLegacy(snapshot.workflowRuns);
    return workflowRuns === snapshot.workflowRuns ? snapshot : { ...snapshot, workflowRuns };
  }

  /**
   * **Per-subscriber** encoding for a delta batch: profile filtering + whole-key folding for legacy consumers.
   *
   * Folding reads the **current** projection state, so replaying historical deltas during resume
   * folds them into the terminal state: intermediate states are skipped, and the final state
   * matches. This follows the existing coalesce behavior (see the header of
   * conversation-workflow-run-deltas.ts).
   */
  private encodeDeltasForSubscription(
    deltas: readonly ConversationDelta[],
    subscription: Subscription,
  ): readonly ConversationDelta[] {
    const filtered = filterConversationDeltasForProfile(deltas, subscription.profile);
    if (subscription.workflowRunDeltas) return filtered;
    return encodeConversationDeltasForLegacy(filtered, this.projection.getSnapshot().workflowRuns);
  }

  /**
   * Candidate projection for input admission: represent the same intent as a complete QueueItem,
   * including text and attachment references. QueueItem metadata is at least as large as the
   * eventual user row after immediate startup, so an input accepted here will not become
   * untransportable only when the first snapshot is sent. This method is read-only and does not
   * write admission or the event log.
   */
  measureInputAdmissionProjectionBytes(
    envelope: CommandEnvelope,
    admission: { admissionSeq: number; admittedAt: number; queueItemId: string },
  ): number | null {
    const raw = envelope.payload as {
      text?: string;
      displayText?: string;
      attachments?: QueueItem["attachments"];
      firstInput?: { text: string; attachments?: QueueItem["attachments"] };
    };
    const input = envelope.type === "createSession" ? raw.firstInput : raw;
    if (
      !input ||
      (envelope.type !== "createSession" &&
        envelope.type !== "sendText" &&
        envelope.type !== "sendGoalCommand" &&
        envelope.type !== "compact")
    ) {
      return null;
    }
    const snapshot = this.projection.getSnapshot();
    const queueItem: QueueItem = {
      sourceCommandId: envelope.commandId,
      queueItemId: admission.queueItemId,
      clientId: envelope.clientId || "cli",
      kind:
        envelope.type === "compact"
          ? "compact"
          : envelope.type === "sendGoalCommand"
            ? "sendGoalCommand"
            : "sendText",
      text:
        envelope.type === "compact"
          ? "/compact"
          : envelope.type === "sendGoalCommand"
            ? raw.displayText?.trim() || `/goal ${(input.text ?? "").trim()}`
            : (input.text ?? ""),
      attachments: input.attachments ?? [],
      delivery: { requested: "queue", admitted: "queue" },
      order: {
        admissionSeq: admission.admissionSeq,
        queuePosition: snapshot.queue.items.length,
      },
      steer: { state: "notRequested" },
      dispatch: { state: "queued" },
      admittedAt: admission.admittedAt,
    };
    const candidate: ConversationSnapshot = {
      ...snapshot,
      queue: { ...snapshot.queue, items: [...snapshot.queue.items, queueItem] },
    };
    return this.measureWireSnapshotBytes(this.getWireSnapshot(candidate));
  }

  private measureWireSnapshotBytes(snapshot: ConversationSnapshot): number {
    // Use the longest normal subscriptionId/time/seq representations this publisher can emit so
    // the measurement accounts for more than just the payload.
    const frame: ConversationTopicFrame = {
      topic: this.topic,
      subscriptionId: `sub-${this.logEpoch}-${Number.MAX_SAFE_INTEGER}`,
      fromSeq: 0,
      toSeq: snapshot.seq,
      sentAt: Number.MAX_SAFE_INTEGER,
      payload: { kind: "snapshot", snapshot },
    };
    return utf8JsonByteLength(frame);
  }

  /**
   * rows/range (cursor-based): return the last `limit` rows whose rowId is less than beforeRowId
   * (in ascending rowId order). The source is all projection rows (populated by event replay or
   * transcript hydration), using the same reduction as the subscription stream and naturally
   * matching the full-replay prefix byte for byte.
   * Read-only, stateless, and safe to retry after timeout; the client uses atLogEpoch to discard
   * stale reads as a whole.
   */
  getRowsRange(
    params: { beforeRowId?: number; limit: number },
    deliveryProfile: DeliveryProfileName = "replayable",
  ): V4ConversationRowsRangeResult {
    const snapshot = this.projection.getSnapshot();
    const limit = Math.max(1, Math.min(params.limit, PROTOCOL_V4_LIMITS.rowsRangeMaxLimit));
    const visibleRows = filterConversationRowsForProfile(
      snapshot.rows.window,
      DELIVERY_PROFILES[deliveryProfile],
    );
    const eligible =
      params.beforeRowId === undefined
        ? visibleRows
        : visibleRows.filter((row) => row.rowId < (params.beforeRowId as number));
    const rows = eligible.slice(-limit);
    return {
      rows,
      atSeq: snapshot.seq,
      atRevision: snapshot.revision,
      atLogEpoch: this.logEpoch,
      hasMore: eligible.length > rows.length,
    };
  }

  /**
   * Return the complete terminal plan directory from the current valid branch.
   * The wire snapshot keeps only the tail window, so scanning visible rows in the renderer would
   * miss earlier plans. After edit/retry, it could also retain stale directory entries already
   * removed by the authoritative projection.
   */
  getPlans(): V4ConversationPlansResult {
    const snapshot = this.projection.getSnapshot();
    const plans = snapshot.rows.window
      .filter(
        (row): row is ToolCallRow =>
          row.kind === "toolCall" &&
          row.toolName === "ExitPlanMode" &&
          TERMINAL_PLAN_STATUSES.has(row.status) &&
          hasPlanMarkdown(row),
      )
      .toSorted((left, right) => right.rowId - left.rowId);
    return {
      plans,
      atSeq: snapshot.seq,
      atLogEpoch: this.logEpoch,
    };
  }

  /** rowId → authoritative messageId (translation for forkAssistant/editUserQuery bridging). */
  getMessageIdForRow(rowId: number): string | null {
    return this.projection.getMessageIdForRow(rowId);
  }

  resolveRowActionTarget(
    target: ConversationRowTarget,
    action: ConversationRowTargetAction,
  ): ConversationRowTargetResolution {
    return this.projection.resolveRowActionTarget(target, action);
  }

  /** rowId → all transcript messageIds within the same product turn. */
  getMessageIdsForTurnRow(rowId: number): string[] {
    return this.projection.getMessageIdsForTurnRow(rowId);
  }

  /** A fork target must be the final assistantText segment in its turn. */
  isLatestAssistantSegmentRow(rowId: number): boolean {
    return this.projection.isLatestAssistantSegmentRow(rowId);
  }

  /** latestAssistantRetryOnly: retry target must be the newest assistantText in the full timeline with a realUser cause. */
  isLatestRetryAssistantRow(rowId: number): boolean {
    return this.projection.isLatestRetryAssistantRow(rowId);
  }

  /** latestQueryEditOnly: only the realUser userInput row in the final turn can be edited. */
  isLatestEditableUserRow(rowId: number): boolean {
    return this.projection.isLatestEditableUserRow(rowId);
  }

  /** rowId → product turnId (look up user messageId for editUserQuery when no assistant anchor exists). */
  getTurnIdForRow(rowId: number): string | null {
    return this.projection.getTurnIdForRow(rowId);
  }

  /** Assistant conservation: count of rejected body-stream events (>0 means the projection may be incomplete). */
  getDroppedContentStreamEventCount(): number {
    return this.projection.getDroppedContentStreamEventCount();
  }

  /** rowId → rewind anchor messageId for its turn (locates the editUserQuery user row). */
  getTurnRewindAnchor(rowId: number): string | null {
    return this.projection.getTurnRewindAnchor(rowId);
  }

  private get currentSeq(): number {
    return this.projection.getSnapshot().seq;
  }

  /** Apply an authoritative event: advance the projection, account for it in the log, and fan it out to each subscriber's flush buffer. */
  ingest(event: SessionEvent): void {
    const projectionLimit =
      event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError
        ? PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes
        : PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes - PROJECTION_TERMINAL_RESERVE_BYTES;
    const streamingAppend = this.projection.establishedStreamingAppend(event);
    const streamingUpperBound =
      streamingAppend === null ? null : utf8JsonByteLength(streamingAppend) + 64;
    let deltas: ConversationDelta[] | null;
    if (
      streamingUpperBound !== null &&
      this.wireSnapshotBytesUpperBound + streamingUpperBound <= projectionLimit
    ) {
      deltas = this.projection.applyEvent(event);
      this.wireSnapshotBytesUpperBound += streamingUpperBound;
    } else {
      let candidateBytes = 0;
      let nextUpperBound = 0;
      deltas = this.projection.applyEventAtomically(event, (snapshot, produced) => {
        // dwf fast path: when this event produces only key-level deltas, their byte count is an
        // upper bound on snapshot growth (an upsert adds at most its own content; removed only
        // shrinks the snapshot). Avoid serializing the entire snapshot again; that JSON.stringify
        // costs megabytes per engine event and was the other half of this optimization.
        // The condition uses **actual output**, not a preview, so a diff that falls back to a
        // whole-key patch naturally uses the exact path.
        const growth = workflowRunDeltaGrowthUpperBound(produced);
        if (growth !== null && this.wireSnapshotBytesUpperBound + growth <= projectionLimit) {
          nextUpperBound = this.wireSnapshotBytesUpperBound + growth;
          return true;
        }
        candidateBytes = this.measureWireSnapshotBytes(this.getWireSnapshot(snapshot));
        nextUpperBound = candidateBytes;
        return candidateBytes <= projectionLimit;
      });
      if (deltas === null) throw new ProjectionPayloadTooLargeError(candidateBytes);
      this.wireSnapshotBytesUpperBound = nextUpperBound;
    }
    this.log.push({ seq: event.sequenceNumber, deltas });
    while (this.log.length > this.retention) {
      const evicted = this.log.shift();
      if (evicted) this.floorSeq = evicted.seq;
    }
    if (deltas.length === 0) return;
    for (const subscription of this.subscriptions.values()) {
      if (subscription.resyncRequired) continue;
      const filtered = this.encodeDeltasForSubscription(deltas, subscription);
      const next = appendConversationSubscriberBuffer(
        subscription.buffer,
        filtered,
        this.subscriberBufferLimits(),
      );
      if (next.kind === "overflow") {
        subscription.buffer = [];
        subscription.bufferBytes = 0;
        subscription.resyncRequired = true;
        continue;
      }
      subscription.buffer = next.deltas;
      subscription.bufferBytes = next.encodedBytes;
    }
  }

  /**
   * Rematerialize the projection within the existing publisher while preserving connection-owned subscriptions.
   *
   * The gateway previously deleted the publisher and created a new instance. Although the
   * projection was restored, the old instance's subscription registry, ownership, and in-flight
   * reservations were lost. Rematerialization replaces state within the same topic authority;
   * existing subscriptions should resync, but the publisher identity should not change.
   */
  rehydrate(
    events: readonly SessionEvent[],
    options: { onPayloadTooLarge?: (error: ProjectionPayloadTooLargeError) => void } = {},
  ): void {
    // Do not clear the current projection/log/subscription delivery and replay in place:
    // any reducer exception would leave the topic half-replayed. A candidate publisher owns no
    // subscriptions; adopt its authoritative data surface only after full replay (including
    // logical-size validation) succeeds.
    let candidate = new ConversationTopicPublisher(this.sessionId, this.logEpoch, {
      now: this.now,
      retention: this.retention,
      subscriberBufferMaxOps: this.subscriberBufferMaxOps,
      subscriberBufferMaxBytes: this.subscriberBufferMaxBytes,
    });
    const usedBatchHydration = candidate.tryBatchHydration(events);
    if (!usedBatchHydration) {
      // Exceeding the conservative upper bound does not prove the authoritative projection is
      // over limit. Retry from an empty candidate using the original per-event atomic admission,
      // preserving the 16 MiB fail-closed limit and the old behavior of rejecting one oversized
      // event while continuing to terminal state.
      candidate = new ConversationTopicPublisher(this.sessionId, this.logEpoch, {
        now: this.now,
        retention: this.retention,
        subscriberBufferMaxOps: this.subscriberBufferMaxOps,
        subscriberBufferMaxBytes: this.subscriberBufferMaxBytes,
      });
      for (const event of events) {
        try {
          candidate.ingest(event);
        } catch (error) {
          if (!(error instanceof ProjectionPayloadTooLargeError)) throw error;
          if (!options.onPayloadTooLarge) throw error;
          options.onPayloadTooLarge(error);
        }
      }
    }

    this.projection = candidate.projection;
    if (usedBatchHydration) {
      // Batch replay defers derived actions until final materialization. If clients could resume
      // this log from intermediate bases in old per-event snapshots, stale canEdit/canRetry
      // values never held by the batch could not be revoked precisely. Rehydrate already
      // requires all existing subscriptions to resync, so establish a snapshot recovery boundary
      // at the current seq. New events can resume normally from that watermark, preserving
      // replayable recovery semantics.
      this.log.splice(0, this.log.length);
      this.floorSeq = candidate.currentSeq;
    } else {
      // Strict fallback has no deferred materialization and preserves the original retained-log recovery semantics.
      this.log.splice(0, this.log.length, ...candidate.log);
      this.floorSeq = candidate.floorSeq;
    }
    this.wireSnapshotBytesUpperBound = candidate.wireSnapshotBytesUpperBound;
    for (const subscription of this.subscriptions.values()) {
      subscription.buffer = [];
      subscription.bufferBytes = 0;
      subscription.resyncRequired = true;
      subscription.sentSeq = 0;
      // After adoption, frames reserved on the old projection can no longer commit; failed replay never touched those reservations.
      subscription.inFlight = null;
    }
  }

  /**
   * Cold-restore fast path: update only an unpublished candidate. The protocol wire snapshot
   * always contains only the last 60 rows, so row updates accumulate deltas only for rows still
   * in the tail, then reserve the full per-row schema upper bound for actions not yet
   * materialized. When the payload limit is approached, exact measurement removes conservative
   * growth from rows that have already left the tail. Finally converge actions across all rows
   * once; total cost grows linearly with event/row count.
   */
  private tryBatchHydration(events: readonly SessionEvent[]): boolean {
    this.projection.beginHydrationReplay();
    let measuredBytes = this.wireSnapshotBytesUpperBound;
    let measuredSequenceNumberBytes = hydrationSequenceNumberBytes(
      this.projection.getSnapshot().seq,
    );
    let encodedGrowthSinceMeasurement = 0;

    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      const deltas = this.projection.applyHydrationEvent(event);
      const finalEvent = index === events.length - 1;
      const projectionLimit = this.projectionLimitForEvent(event);
      const mustMeasureSnapshot = finalEvent || deltas.some((delta) => delta.op === "row.removed");

      if (finalEvent) this.projection.completeHydrationReplay();
      const snapshot = this.projection.getSnapshot();
      if (!mustMeasureSnapshot && deltas.length > 0) {
        let wireRowIds: Set<number> | undefined;
        const wireDeltas = deltas.filter((delta) => {
          if (delta.op === "state.updated" || delta.op === "row.appended") return true;
          if (delta.op === "row.removed") return false;
          // 4b-2: plugin resource notifications go through live deltas only and are excluded from cold-start measurement.
          if (
            delta.op === "pluginUi.resourceUpdated" ||
            delta.op === "pluginUi.resourceListChanged" ||
            delta.op === "pluginUi.appToolCall" ||
            delta.op === "pluginUi.instanceClosed"
          )
            return false;
          // Key-level deltas apply to state keys, not the 60-row wire tail, so they are always
          // counted even if they are no longer in the window, matching state.updated.
          if (delta.op === "workflowRun.updated" || delta.op === "workflowRun.removed") return true;
          wireRowIds ??= new Set(
            snapshot.rows.window
              .slice(-PROTOCOL_V4_LIMITS.snapshotTailWindowRows)
              .map((row) => row.rowId),
          );
          const rowId = delta.op === "row.upserted" ? delta.row.rowId : delta.rowId;
          return wireRowIds.has(rowId);
        });
        if (wireDeltas.length > 0) {
          encodedGrowthSinceMeasurement +=
            coldHydrationJsonByteLength({ kind: "deltas", deltas: wireDeltas }) +
            HYDRATION_EVENT_WIRE_OVERHEAD_BYTES;
        }
      }

      const actionBytesUpperBound = finalEvent
        ? 0
        : Math.min(snapshot.rows.window.length, PROTOCOL_V4_LIMITS.snapshotTailWindowRows) *
          HYDRATION_ACTION_BYTES_PER_WIRE_ROW;
      const currentSequenceNumberBytes = hydrationSequenceNumberBytes(snapshot.seq);
      const sequenceNumberGrowth = Math.max(
        0,
        currentSequenceNumberBytes - measuredSequenceNumberBytes,
      );
      let upperBound =
        measuredBytes +
        encodedGrowthSinceMeasurement +
        sequenceNumberGrowth +
        actionBytesUpperBound;
      if (mustMeasureSnapshot || upperBound > projectionLimit) {
        // Falling back to strict as soon as the conservative delta total exceeds the limit would
        // cause false fallbacks for repeated upserts that do not enlarge the snapshot. Retesting
        // every 32 events would also repeatedly serialize the checkpoint.
        measuredBytes = this.measureWireSnapshotBytes(this.getWireSnapshot());
        measuredSequenceNumberBytes = currentSequenceNumberBytes;
        encodedGrowthSinceMeasurement = 0;
        upperBound = measuredBytes + actionBytesUpperBound;
      }
      if (upperBound > projectionLimit) return false;
    }

    if (events.length === 0) {
      this.projection.completeHydrationReplay();
      measuredBytes = this.measureWireSnapshotBytes(this.getWireSnapshot());
    }
    this.wireSnapshotBytesUpperBound = measuredBytes;
    return true;
  }

  private projectionLimitForEvent(event: SessionEvent): number {
    return event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError
      ? PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes
      : PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes - PROJECTION_TERMINAL_RESERVE_BYTES;
  }

  /**
   * Subscription decision: resume if base.logEpoch matches and base.seq is within the retention
   * window; otherwise send a snapshot. Resubscribe with the same connectionId to replace the old
   * subscription and clear its flush buffer.
   */
  subscribe(params: ConversationSubscribeParams): ConversationSubscribeResult {
    const result = this.subscribeReserved(params);
    result.reservation?.commit();
    return result;
  }

  /** Production gateway entry point: wait until the entire physical batch is accepted before committing the initial frame too. */
  subscribeReserved(params: ConversationSubscribeParams): ConversationSubscribeResult {
    const previousId = this.subscriptionIdByConnection.get(params.connectionId);
    const previousSubscription =
      previousId === undefined ? undefined : this.subscriptions.get(previousId);
    if (previousId !== undefined) this.subscriptions.delete(previousId);

    const profile = DELIVERY_PROFILES[params.deliveryProfile ?? "replayable"];
    const subscription: Subscription = {
      subscriptionId: `sub-${this.logEpoch}-${this.nextSubscriptionSerial++}`,
      connectionId: params.connectionId,
      profile,
      workflowRunDeltas: params.workflowRunDeltas === true,
      buffer: [],
      bufferBytes: 0,
      resyncRequired: false,
      sentSeq: 0,
      inFlight: null,
      snapshotRequestGeneration: 0,
      nextLogicalFrameOrdinal: 1,
    };
    this.subscriptions.set(subscription.subscriptionId, subscription);
    this.subscriptionIdByConnection.set(params.connectionId, subscription.subscriptionId);
    const rollback = (): boolean => {
      // After the initial reservation is committed, the replacement is admitted; reject any late rollback.
      if (
        subscription.inFlight === null ||
        this.subscriptions.get(subscription.subscriptionId) !== subscription ||
        this.subscriptionIdByConnection.get(params.connectionId) !== subscription.subscriptionId
      ) {
        return false;
      }
      this.subscriptions.delete(subscription.subscriptionId);
      if (previousId !== undefined && previousSubscription) {
        this.subscriptions.set(previousId, previousSubscription);
        this.subscriptionIdByConnection.set(params.connectionId, previousId);
      } else {
        this.subscriptionIdByConnection.delete(params.connectionId);
      }
      return true;
    };

    const base = params.base;
    // Host-owned preparation metadata is seeded outside the conversation event log. A matching
    // transcript watermark therefore cannot prove that a reconnecting client has the latest
    // preparing/failed state; send an authoritative snapshot while that metadata is present.
    const resumable =
      !this.worktreePreparationWasSeeded &&
      base !== undefined &&
      base.logEpoch === this.logEpoch &&
      base.seq >= this.floorSeq &&
      base.seq <= this.currentSeq;

    if (!resumable) {
      const reservation = this.reserveFrame(
        subscription,
        {
          ...this.frameShell(subscription),
          fromSeq: 0,
          toSeq: this.currentSeq,
          payload: {
            kind: "snapshot",
            snapshot: this.getWireSnapshotForSubscription(subscription),
          },
        },
        false,
        "initial",
      );
      return this.subscribeResult(this.ackFor(subscription, "snapshot"), reservation, rollback);
    }

    // Resume: replay (base.seq, current] within the retention window through the same
    // filter→encode→coalesce pipeline as live streaming.
    const replay = coalesceConversationDeltas(
      this.encodeDeltasForSubscription(
        this.log.flatMap((entry) => (entry.seq > base.seq ? entry.deltas : [])),
        subscription,
      ),
    );
    if (base.seq === this.currentSeq) {
      subscription.sentSeq = base.seq;
      return this.subscribeResult(this.ackFor(subscription, "resume"), null, () => false);
    }
    subscription.sentSeq = base.seq;
    const reservation = this.reserveFrame(
      subscription,
      {
        ...this.frameShell(subscription),
        fromSeq: base.seq,
        toSeq: this.currentSeq,
        payload: { kind: "deltas", deltas: replay },
      },
      false,
      "initial",
    );
    return this.subscribeResult(this.ackFor(subscription, "resume"), reservation, rollback);
  }

  unsubscribe(subscriptionId: string, connectionId?: string): void {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return;
    if (connectionId !== undefined && subscription.connectionId !== connectionId) {
      return;
    }
    this.subscriptions.delete(subscriptionId);
    if (this.subscriptionIdByConnection.get(subscription.connectionId) === subscriptionId) {
      this.subscriptionIdByConnection.delete(subscription.connectionId);
    }
  }

  hasSubscription(subscriptionId: string, connectionId?: string): boolean {
    const subscription = this.subscriptions.get(subscriptionId);
    return Boolean(
      subscription && (connectionId === undefined || subscription.connectionId === connectionId),
    );
  }

  /** Resident reclamation check: do not deactivate the session while any subscriber remains. */
  hasSubscribers(): boolean {
    return this.subscriptions.size > 0;
  }

  connectionIdForSubscription(subscriptionId: string): string | null {
    return this.subscriptions.get(subscriptionId)?.connectionId ?? null;
  }

  /**
   * Drain one subscriber's flush buffer into a frame (the host drives this by flushWindowMs).
   * Return null if there is no new content. The frame interval (sentSeq, currentSeq] includes
   * seq values filtered out along the way, keeping the client's `frame.fromSeq === store.seq`
   * continuity check independent of profile filtering.
   */
  reserveFlush(subscriptionId: string): TopicFrameReservation<ConversationTopicFrame> | null {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return null;
    if (subscription.inFlight) return subscription.inFlight;
    if (subscription.resyncRequired) {
      subscription.buffer = [];
      subscription.bufferBytes = 0;
      return this.reserveFrame(
        subscription,
        {
          ...this.frameShell(subscription),
          fromSeq: 0,
          toSeq: this.currentSeq,
          payload: {
            kind: "snapshot",
            snapshot: this.getWireSnapshotForSubscription(subscription),
          },
        },
        true,
        "online",
      );
    }
    if (subscription.buffer.length === 0 && subscription.sentSeq === this.currentSeq) {
      return null;
    }
    const deltas = subscription.buffer;
    const frame: ConversationTopicFrame = {
      ...this.frameShell(subscription),
      fromSeq: subscription.sentSeq,
      toSeq: this.currentSeq,
      payload: { kind: "deltas", deltas },
    };
    subscription.buffer = [];
    subscription.bufferBytes = 0;
    return this.reserveFrame(subscription, frame, false, "online");
  }

  /** Convenience surface for legacy unit tests; production gateways must reserve, then commit only after emit-all succeeds. */
  flush(subscriptionId: string): ConversationTopicFrame | null {
    const reservation = this.reserveFlush(subscriptionId);
    if (!reservation || !reservation.commit()) return null;
    return reservation.frame;
  }

  /**
   * Recover an active subscription with the same sub: the client's base is the only valid
   * recovery point; do not guess client progress from sentSeq. New recovery admission invalidates
   * the old reservation, so a late commit returns false because its inFlight identity no longer matches.
   */
  resyncReserved(
    subscriptionId: string,
    request: ConversationResyncRequest,
  ): ConversationSubscribeResult | null {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return null;

    const previous = {
      buffer: subscription.buffer,
      bufferBytes: subscription.bufferBytes,
      resyncRequired: subscription.resyncRequired,
      sentSeq: subscription.sentSeq,
      inFlight: subscription.inFlight,
    };

    // Old resync first committed the current reservation, then sent a snapshot based on the
    // server's sentSeq, incorrectly recording a frame the client never received as delivered.
    // Same-sub recovery must supersede the reservation directly.
    subscription.inFlight = null;
    subscription.buffer = [];
    subscription.bufferBytes = 0;
    subscription.resyncRequired = false;

    const base = request.base;
    const resumable =
      !request.forceSnapshot &&
      !this.worktreePreparationWasSeeded &&
      base !== null &&
      base.logEpoch === this.logEpoch &&
      base.seq >= this.floorSeq &&
      base.seq <= this.currentSeq;

    if (!resumable) {
      subscription.sentSeq = 0;
      const reservation = this.reserveFrame(
        subscription,
        {
          ...this.frameShell(subscription),
          fromSeq: 0,
          toSeq: this.currentSeq,
          payload: {
            kind: "snapshot",
            snapshot: this.getWireSnapshotForSubscription(subscription),
          },
        },
        false,
        "recovery",
      );
      return this.subscribeResult(
        this.ackFor(subscription, "snapshot"),
        reservation,
        this.resyncRollback(subscription, reservation, previous),
      );
    }

    subscription.sentSeq = base.seq;
    const replay = coalesceConversationDeltas(
      this.encodeDeltasForSubscription(
        this.log.flatMap((entry) => (entry.seq > base.seq ? entry.deltas : [])),
        subscription,
      ),
    );
    const reservation = this.reserveFrame(
      subscription,
      {
        ...this.frameShell(subscription),
        fromSeq: base.seq,
        toSeq: this.currentSeq,
        payload: { kind: "deltas", deltas: replay },
      },
      false,
      "recovery",
    );
    return this.subscribeResult(
      this.ackFor(subscription, "resume"),
      reservation,
      this.resyncRollback(subscription, reservation, previous),
    );
  }

  private resyncRollback(
    subscription: Subscription,
    reservation: TopicFrameReservation<ConversationTopicFrame>,
    previous: Pick<
      Subscription,
      "buffer" | "bufferBytes" | "resyncRequired" | "sentSeq" | "inFlight"
    >,
  ): () => boolean {
    let rolledBack = false;
    return (): boolean => {
      if (rolledBack) return true;
      if (
        this.subscriptions.get(subscription.subscriptionId) !== subscription ||
        subscription.inFlight !== reservation
      ) {
        return false;
      }
      const recoveryBuffer = subscription.buffer;
      const recoveryResyncRequired = subscription.resyncRequired;
      const merged = appendConversationSubscriberBuffer(
        previous.buffer,
        recoveryBuffer,
        this.subscriberBufferLimits(),
      );
      if (merged.kind === "overflow" || previous.resyncRequired || recoveryResyncRequired) {
        subscription.buffer = [];
        subscription.bufferBytes = 0;
        subscription.resyncRequired = true;
      } else {
        subscription.buffer = merged.deltas;
        subscription.bufferBytes = merged.encodedBytes;
        subscription.resyncRequired = false;
      }
      subscription.sentSeq = previous.sentSeq;
      subscription.inFlight = previous.inFlight;
      rolledBack = true;
      return true;
    };
  }

  private subscriberBufferLimits(): ConversationSubscriberBufferLimits {
    return {
      maxOps: this.subscriberBufferMaxOps,
      maxBytes: this.subscriberBufferMaxBytes,
      snapshotBytesUpperBound: this.wireSnapshotBytesUpperBound,
    };
  }

  /** Overflow fallback (05 § two-tier backpressure): clear the buffer and send a snapshot frame to realign. */
  resync(subscriptionId: string): ConversationTopicFrame | null {
    const reservation = this.resyncReserved(subscriptionId, {
      base: null,
      forceSnapshot: true,
    })?.reservation;
    if (!reservation || !reservation.commit()) return null;
    return reservation.frame;
  }

  private reserveFrame(
    subscription: Subscription,
    frame: ConversationTopicFrame,
    snapshotRecovery: boolean,
    deliveryKind: TopicFrameDeliveryKind,
  ): TopicFrameReservation<ConversationTopicFrame> {
    let committed = false;
    const snapshotRequestGeneration = subscription.snapshotRequestGeneration;
    const reservation: TopicFrameReservation<ConversationTopicFrame> = {
      deliveryKind,
      logicalFrameId: `${subscription.subscriptionId}-lf-${this.nextLogicalFrameSerial++}`,
      logicalFrameOrdinal: subscription.nextLogicalFrameOrdinal++,
      frame,
      commit: () => {
        if (committed) return true;
        if (
          this.subscriptions.get(subscription.subscriptionId) !== subscription ||
          subscription.inFlight !== reservation
        ) {
          return false;
        }
        subscription.sentSeq = frame.toSeq;
        subscription.inFlight = null;
        if (subscription.snapshotRequestGeneration > snapshotRequestGeneration) {
          // Metadata may have changed while this frame waited for transport admission. Keep the
          // current ACK/resync reservation intact, then send a fresh authoritative snapshot.
          subscription.resyncRequired = true;
        } else if (snapshotRecovery) {
          // While a snapshot is in flight, resyncRequired stops accepting deltas.
          // If the authoritative watermark advances again, the next reservation must send the latest snapshot.
          subscription.resyncRequired = this.currentSeq > frame.toSeq;
        }
        committed = true;
        return true;
      },
    };
    subscription.inFlight = reservation;
    return reservation;
  }

  private subscribeResult(
    ack: SubscribeAck,
    reservation: TopicFrameReservation<ConversationTopicFrame> | null,
    rollback: () => boolean,
  ): ConversationSubscribeResult {
    return {
      ack,
      reservation,
      rollback,
      // Compatibility for older publisher unit tests: reading frame means the local transport accepted it.
      // Production gateways read only the reservation and do not trigger this getter.
      get frame() {
        reservation?.commit();
        return reservation?.frame ?? null;
      },
    };
  }

  private ackFor(subscription: Subscription, mode: SubscribeAck["mode"]): SubscribeAck {
    return {
      subscriptionId: subscription.subscriptionId,
      mode,
      logEpoch: this.logEpoch,
    };
  }

  private frameShell(
    subscription: Subscription,
  ): Pick<ConversationTopicFrame, "topic" | "subscriptionId" | "sentAt"> {
    return {
      topic: this.topic,
      subscriptionId: subscription.subscriptionId,
      sentAt: this.now(),
    };
  }
}

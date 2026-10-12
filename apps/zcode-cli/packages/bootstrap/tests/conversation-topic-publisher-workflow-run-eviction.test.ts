// ConversationTopicPublisher × eviction (DESIGN-2 §2/§3).
// When the table is full the reducer no longer just "rejects new" but **removes** terminal entries to make room
// for live newcomers, so key-level deltas carry `removedActors` / `removedNodes` for the first time. This suite
// pins three things that previously could not happen and were therefore never tested:
//   1. The ingest fast path's byte upper bound remains an upper bound after "one op both deletes and adds, and
//      carries unlistedByPhase / truncated for the first time" — if it were computed loosely, the 16MiB gate
//      would be computed loosely too;
//   2. A legacy consumer receives whole-key patches (it doesn't even recognize the `workflowRun.*` discriminant),
//      and after a batch of evictions it must still converge with the authoritative state onto the same legacy-cap
//      clamp;
//   3. When an overflowed run re-arms, **one op clears both tables** (1024 deletions each) — the largest single op
//      in the whole protocol; if it breaches the wire schema's .max or either subscriber bound of 500 ops / 1 MiB,
//      that subscription goes silent.
// The cap isn't injected from the CLI side (the projection calls the reducer without limits), so what runs here is
// the **real cap of 1024**.
import { describe, expect, it } from "vitest";
import type { EventId, SessionEvent, SessionId, TraceId } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import type {
  ConversationDelta,
  ConversationSnapshot,
  ConversationTopicFrame,
  WorkflowRunUpdatedDelta,
  WorkflowRunsState,
} from "@zcode/shared/zcode-protocol-v4";
import {
  PROTOCOL_V4_LIMITS,
  WORKFLOW_RUNS_LEGACY_LIMITS,
  WORKFLOW_RUNS_LIMITS,
  applyConversationDeltas,
  clampWorkflowRunsForLegacy,
  conversationTopicFrameSchema,
  utf8JsonByteLength,
  workflowRunUpdateWithinWireBounds,
} from "@zcode/shared/zcode-protocol-v4";
import { ConversationTopicPublisher } from "../src/zcode-protocol-v4/index.js";

const RUN_ID = "dwfrun-1";
/** This many live newcomers arrive after the table is full: each needs the reducer to remove one finished group to fit. */
const EVICTION_ROUNDS = 16;
const MODERN = "sub-epoch-1-1";
const LEGACY = "sub-epoch-1-2";

/** The conservative upper bound is a private field; asserting its **direction** has no other observation surface (the same opening as the existing suite). */
function upperBoundOf(publisher: ConversationTopicPublisher): number {
  return (publisher as unknown as { wireSnapshotBytesUpperBound: number })
    .wireSnapshotBytesUpperBound;
}

/**
 * Pin the upper bound **back to truth** before sampling. Without pinning, this test can't bite: the fast path only
 * adds and never removes, so by the eviction window the bound has drifted to about four times the exact value, at
 * which point `bound ≥ exact` couldn't stop even a wildly wrong accounting. After pinning to truth, `bound ≥ exact`
 * is precisely the statement this step proves — the growth one op reports covers how much the snapshot really grew.
 */
function pinUpperBoundToTruth(publisher: ConversationTopicPublisher): void {
  (publisher as unknown as { wireSnapshotBytesUpperBound: number }).wireSnapshotBytesUpperBound =
    publisher.getWireSnapshotLogicalBytes();
}

function snapshotOf(frame: ConversationTopicFrame | null): ConversationSnapshot {
  expect(frame?.payload.kind).toBe("snapshot");
  return (frame!.payload as { kind: "snapshot"; snapshot: ConversationSnapshot }).snapshot;
}

function deltasOf(frame: ConversationTopicFrame | null): ConversationDelta[] {
  // The deltas frame is itself the observable surface of "no overflow": if any fallback fired, what arrives here
  // would be a snapshot.
  expect(frame?.payload.kind).toBe("deltas");
  return (frame!.payload as { kind: "deltas"; deltas: ConversationDelta[] }).deltas;
}

function onlyUpdate(deltas: readonly ConversationDelta[]): WorkflowRunUpdatedDelta {
  expect(deltas.map((delta) => delta.op)).toEqual(["workflowRun.updated"]);
  return deltas[0] as WorkflowRunUpdatedDelta;
}

/**
 * The same set of ops, but with both removal tables wiped — the counter-proof of "removals are **load-bearing**".
 *
 * Why every convergence assertion gets a companion: a consumer that takes the op apart and reassembles it but
 * misses these two new keys (the projection, legacy consumer encoding, hydration accounting — anywhere) produces
 * a state that looks fine everywhere else, except the table carries a few entries that should have left. Without
 * this negative, "applied state equals the authoritative state" would still pass when removals are dropped — it
 * couldn't prove what it claims to prove.
 */
function withoutRemovals(deltas: readonly ConversationDelta[]): ConversationDelta[] {
  return deltas.map((delta) => {
    if (delta.op !== "workflowRun.updated") return delta;
    const { removedActors: _actors, removedNodes: _nodes, ...rest } = delta;
    return rest;
  });
}

interface EvictionScenario {
  events: readonly SessionEvent[];
  /** (conservative upper bound, exact bytes) sampled event by event across the eviction window; the bound is pinned to truth before sampling. */
  boundSamples: readonly { upper: number; exact: number }[];
  /** The same readings for the re-arm event, plus the exact bytes before it (this step's snapshot **shrinks**). */
  resumeSample: { upper: number; exact: number; before: number };
  modernBase: ConversationSnapshot;
  legacyBase: ConversationSnapshot;
  evictionModern: ConversationDelta[];
  evictionLegacy: ConversationDelta[];
  evictedRuns: WorkflowRunsState;
  resumeModern: ConversationDelta[];
  resumeLegacy: ConversationDelta[];
  resumedRuns: WorkflowRunsState;
}

let cached: EvictionScenario | undefined;

/**
 * The whole fill → evict → re-arm stretch. One pass over three thousand events takes half a second, so it is
 * memoized per module and each of the three tests looks at its own side; they all read facts recorded by this
 * single run, and none of them writes back.
 */
function scenario(): EvictionScenario {
  if (cached) return cached;
  const events: SessionEvent[] = [];
  const publisher = new ConversationTopicPublisher("session-1", "epoch-1", { now: () => 0 });
  const ingest = (type: SessionEventType, payload: unknown): void => {
    const event: SessionEvent = {
      id: `event-${events.length + 1}` as EventId,
      sessionId: "session-1" as SessionId,
      type,
      timestamp: new Date(1_700_000_000_000 + events.length * 1000),
      traceId: "trace-1" as TraceId,
      sequenceNumber: events.length + 1,
      payload,
    };
    events.push(event);
    publisher.ingest(event);
  };
  const progress = (eventType: string, payload: Record<string, unknown>): void => {
    ingest(SessionEventType.DynamicWorkflowRunProgress, {
      runId: RUN_ID,
      toolCallId: "tc-1",
      sequence: events.length,
      eventType,
      payload,
    });
  };
  /** One subagent finishing one unit of work: these three events create exactly one **finished group** (the eviction victim). */
  const finishedGroup = (ordinal: number, phaseName: string): void => {
    const actor = { siteId: "agent#1", ordinal };
    const instance = { siteId: "ask#1", ordinal };
    progress("actor-created", { actor, name: `agent-${ordinal}`, phaseName });
    progress("node-queued", { instance, actor, kind: "ask", phaseName });
    progress("node-settled", { instance, outcome: "ok" });
  };

  ingest(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
  progress("run-started", { runId: RUN_ID });
  for (let ordinal = 1; ordinal <= WORKFLOW_RUNS_LIMITS.maxNodes; ordinal += 1) {
    finishedGroup(ordinal, `phase-${ordinal % 4}`);
  }

  // Subscription happens after the fill, before the evictions: both subscribers' baselines are the table with
  // "not a single entry removed yet".
  const modernBase = snapshotOf(
    publisher.subscribe({ connectionId: "modern", workflowRunDeltas: true }).frame,
  );
  const legacyBase = snapshotOf(publisher.subscribe({ connectionId: "legacy" }).frame);

  const boundSamples: { upper: number; exact: number }[] = [];
  /** One sample per event; the bound is pinned to truth before sampling (see {@link pinUpperBoundToTruth}). */
  const sampled = (eventType: string, payload: Record<string, unknown>): void => {
    pinUpperBoundToTruth(publisher);
    progress(eventType, payload);
    boundSamples.push({
      upper: upperBoundOf(publisher),
      exact: publisher.getWireSnapshotLogicalBytes(),
    });
  };
  for (let round = 1; round <= EVICTION_ROUNDS; round += 1) {
    const ordinal = WORKFLOW_RUNS_LIMITS.maxNodes + round;
    const actor = { siteId: "agent#1", ordinal };
    // actor table full → one finished group is removed (the actor and its node leave together), the newcomer
    // takes the seat;
    // this node-queued then lands on the just-freed node slot.
    sampled("actor-created", { actor, name: `agent-${ordinal}`, phaseName: "late" });
    sampled("node-queued", {
      instance: { siteId: "ask#1", ordinal },
      actor,
      kind: "ask",
      phaseName: "late",
    });
  }
  const evictionModern = deltasOf(publisher.flush(MODERN));
  const evictionLegacy = deltasOf(publisher.flush(LEGACY));
  const evictedRuns = publisher.getSnapshot().workflowRuns!;

  // Re-arm: the overflowed run restarts from empty tables in a new life (workflowRunTablesForNewLife).
  pinUpperBoundToTruth(publisher);
  const resumeExactBefore = publisher.getWireSnapshotLogicalBytes();
  progress("run-started", { runId: RUN_ID });
  const resumeSample = {
    upper: upperBoundOf(publisher),
    exact: publisher.getWireSnapshotLogicalBytes(),
    before: resumeExactBefore,
  };
  const resumeModern = deltasOf(publisher.flush(MODERN));
  const resumeLegacy = deltasOf(publisher.flush(LEGACY));
  const resumedRuns = publisher.getSnapshot().workflowRuns!;

  cached = {
    events,
    boundSamples,
    resumeSample,
    modernBase,
    legacyBase,
    evictionModern,
    evictionLegacy,
    evictedRuns,
    resumeModern,
    resumeLegacy,
    resumedRuns,
  };
  return cached;
}

describe("ingest fast path × eviction", () => {
  /**
   * The fast path treats "this batch of ops' bytes" as an upper bound on snapshot growth. Eviction adds two new
   * shapes to that argument: one op carrying both deletions and upserts, and the two header keys `unlistedByPhase`
   * / `truncated` appearing **for the first time** at some step. Here the bound and the exact value are compared
   * step by step on the real cap of 1024 — the moment the bound dips below the exact value, the 16MiB gate has
   * been computed loosely, and the consequence of that gate failing to hold is the whole frame never going out.
   *
   * (The byte-by-byte form of the same argument on a small cap is in the property tests of
   * conversation-workflow-run-deltas.test.ts.)
   */
  it("真界 1024 上的每一次腾位：保守上界都不低于精确字节数", () => {
    const { boundSamples } = scenario();
    expect(boundSamples).toHaveLength(EVICTION_ROUNDS * 2);
    for (const sample of boundSamples) {
      expect(sample.upper).toBeGreaterThanOrEqual(sample.exact);
    }
    // The bound was pinned back to truth before sampling, so the slack is "the growth this op reports" minus "how
    // much the snapshot really grew" — an eviction op carries one actor, one node, and two deletions, so the slack
    // is on the order of a few hundred bytes. Pinning it is what makes this test bite: if the accounting gets the
    // magnitude wrong, the assertions above flip immediately; if someone widens the bound to the whole snapshot,
    // this one flips.
    const slack = boundSamples.map((sample) => sample.upper - sample.exact);
    expect(Math.max(...slack)).toBeLessThan(2048);
  });

  /**
   * Deletion only shrinks the snapshot, so the re-arm op carrying 1024 + 1024 deletions has an **extremely** loose
   * bound (it adds two thousand deletions' bytes onto a snapshot that just shrank by over two hundred thousand
   * bytes). The loose direction is the safe side — and that direction is exactly what this pins:
   * it only ever over-measures once, and never judges a actually-small run as over-limit (when the fast path
   * misfires, ingest falls back to exact measurement).
   */
  it("重臂那一条 op：快照缩了，上界只会偏保守", () => {
    const { resumeSample } = scenario();
    expect(resumeSample.exact).toBeLessThan(resumeSample.before);
    expect(resumeSample.upper).toBeGreaterThanOrEqual(resumeSample.exact);
  });

  it("腾位的可观察面：两张表停在界上，被摘掉的条目仍然可数", () => {
    const run = scenario().evictedRuns.runs[0]!;
    expect(run.actors).toHaveLength(WORKFLOW_RUNS_LIMITS.maxActors);
    expect(run.nodes).toHaveLength(WORKFLOW_RUNS_LIMITS.maxNodes);
    expect(run.truncated).toBe(true);
    // Each round removes one finished group = one actor + its settled node.
    expect(run.usage.nodesUnlisted).toBe(EVICTION_ROUNDS);
    expect(run.usage.nodesUnlistedSettled).toBe(EVICTION_ROUNDS);
    const byPhase = run.unlistedByPhase ?? [];
    expect(byPhase.reduce((sum, bucket) => sum + bucket.actors, 0)).toBe(EVICTION_ROUNDS);
    // The newcomers' own bucket isn't in there: what was removed are finished old groups, not the ones that just
    // sat down.
    expect(byPhase.some((bucket) => bucket.phaseName === "late")).toBe(false);
  });
});

describe("legacy consumer × eviction", () => {
  /**
   * A legacy consumer doesn't even recognize the `workflowRun.*` discriminant (discriminatedUnion parse failure →
   * whole frame dropped), so what it receives is the whole-key patch. Deletions are therefore **free** for it —
   * what it gets is already the full clamp of the current projection. This pins that "free" isn't taken for
   * granted: after a batch of evictions its terminal state must be byte-equal to
   * clampWorkflowRunsForLegacy(authoritative state).
   */
  it("一批淘汰之后，旧订阅者的终态 = clampWorkflowRunsForLegacy(权威态)", () => {
    const { legacyBase, evictionLegacy, evictedRuns } = scenario();
    expect(evictionLegacy.map((delta) => delta.op)).toEqual(["state.updated"]);
    const settled = applyConversationDeltas(legacyBase, evictionLegacy);
    expect(JSON.stringify(settled.workflowRuns)).toBe(
      JSON.stringify(clampWorkflowRunsForLegacy(evictedRuns)),
    );
    const run = settled.workflowRuns!.runs[0]!;
    expect(run.actors).toHaveLength(WORKFLOW_RUNS_LEGACY_LIMITS.maxActors);
    expect(run.nodes).toHaveLength(WORKFLOW_RUNS_LEGACY_LIMITS.maxNodes);
    // The clamp keeps the still-moving ones first: these are exactly who sits in the seats freed by eviction, and
    // they must not be shut out by "the first 256".
    expect(run.nodes.filter((node) => node.phase !== "settled").length).toBe(EVICTION_ROUNDS);
  });

  it("增量订阅者施加同一批 op 之后与权威态逐字节一致", () => {
    const { modernBase, evictionModern, evictedRuns } = scenario();
    const op = onlyUpdate(evictionModern);
    // Merging (rule 6) folds this window's 16 evictions into one op: removals take the union, later upserts
    // override.
    expect(op.removedActors).toHaveLength(EVICTION_ROUNDS);
    expect(op.removedNodes).toHaveLength(EVICTION_ROUNDS);
    expect(workflowRunUpdateWithinWireBounds(op)).toBe(true);
    const settled = applyConversationDeltas(modernBase, evictionModern);
    expect(JSON.stringify(settled.workflowRuns)).toBe(JSON.stringify(evictedRuns));

    // Removals are load-bearing: drop these two keys and the table gains 16 entries that should have left (see
    // withoutRemovals).
    const dropped = applyConversationDeltas(modernBase, withoutRemovals(evictionModern));
    expect(dropped.workflowRuns!.runs[0]!.actors).toHaveLength(
      WORKFLOW_RUNS_LIMITS.maxActors + EVICTION_ROUNDS,
    );
    expect(JSON.stringify(dropped.workflowRuns)).not.toBe(JSON.stringify(evictedRuns));
  });
});

describe("re-arm: one op clears both tables", () => {
  /**
   * The overflowed run's `run-started` is the largest single op in the whole protocol: two full tables exit
   * entirely, 1024 + 1024 deletions packed into one `workflowRun.updated`. It must pass four gates — the wire
   * schema's `.max(1024)` (a parse error on a known key doesn't just strip one key; it drops the whole frame),
   * the subscriber's 500 ops and 1 MiB, and the fast path's byte upper bound.
   */
  it("1024 + 1024 条删除仍在 wire 与订阅者两道兜底之内", () => {
    const { resumeModern } = scenario();
    const op = onlyUpdate(resumeModern);
    expect(op.removedActors).toHaveLength(WORKFLOW_RUNS_LIMITS.maxActors);
    expect(op.removedNodes).toHaveLength(WORKFLOW_RUNS_LIMITS.maxNodes);
    // `unlistedByPhase` is the previous life's "where the cap was spent"; it leaves with the two tables — the
    // delta must be able to say it became absent.
    expect(op.cleared).toContain("unlistedByPhase");
    expect(workflowRunUpdateWithinWireBounds(op)).toBe(true);
    expect(() =>
      conversationTopicFrameSchema.parse({
        topic: "conversation/session-1",
        subscriptionId: MODERN,
        fromSeq: 0,
        toSeq: 1,
        sentAt: 0,
        payload: { kind: "deltas", deltas: resumeModern },
      }),
    ).not.toThrow();
    expect(resumeModern.length).toBeLessThan(PROTOCOL_V4_LIMITS.subscriberBufferMaxOps);
    expect(utf8JsonByteLength({ kind: "deltas", deltas: resumeModern })).toBeLessThan(
      PROTOCOL_V4_LIMITS.subscriberBufferMaxBytes,
    );
  });

  it("两种订阅者各自施加之后都落在空表上", () => {
    const {
      modernBase,
      evictionModern,
      resumeModern,
      legacyBase,
      evictionLegacy,
      resumeLegacy,
      resumedRuns,
    } = scenario();
    const modern = applyConversationDeltas(
      applyConversationDeltas(modernBase, evictionModern),
      resumeModern,
    );
    expect(JSON.stringify(modern.workflowRuns)).toBe(JSON.stringify(resumedRuns));
    expect(modern.workflowRuns!.runs[0]!.actors).toHaveLength(0);
    expect(modern.workflowRuns!.runs[0]!.nodes).toHaveLength(0);
    // Drop the removal tables and the new life starts carrying the previous life's two full tables — every
    // instance both listed and counted.
    const dropped = applyConversationDeltas(
      applyConversationDeltas(modernBase, evictionModern),
      withoutRemovals(resumeModern),
    );
    expect(dropped.workflowRuns!.runs[0]!.nodes).toHaveLength(WORKFLOW_RUNS_LIMITS.maxNodes);

    const legacy = applyConversationDeltas(
      applyConversationDeltas(legacyBase, evictionLegacy),
      resumeLegacy,
    );
    expect(JSON.stringify(legacy.workflowRuns)).toBe(
      JSON.stringify(clampWorkflowRunsForLegacy(resumedRuns)),
    );
  });

  /**
   * Cold re-materialization walks different accounting (tryBatchHydration accumulates wire bytes per op class
   * instead of measuring the whole snapshot once per event). One op carrying two thousand deletions is the only
   * shape on that path that **shrinks** the snapshot while **growing** the estimate —
   * the estimate only errs conservative (worst case it measures once more), but the terminal state must match to
   * the byte.
   */
  it("冷重物化同一段日志：终态与逐事件 live 逐字节一致", () => {
    const { events, resumedRuns } = scenario();
    const rehydrated = new ConversationTopicPublisher("session-1", "epoch-1", { now: () => 0 });
    rehydrated.rehydrate(events);
    expect(JSON.stringify(rehydrated.getSnapshot().workflowRuns)).toBe(JSON.stringify(resumedRuns));
    expect(upperBoundOf(rehydrated)).toBeGreaterThanOrEqual(
      rehydrated.getWireSnapshotLogicalBytes(),
    );
  });
});

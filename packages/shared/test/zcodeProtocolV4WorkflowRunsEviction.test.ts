// **Eviction** when the table is full: evict what has already finished so the running ones can
// stay in the table.
//
// The fact this rule protects is short: the read surface (a run card's subagent rows, the run
// pane's station roster) draws the subagents **running right now**, while the old overflow
// semantics was reject-new — so once a wide fan-out run passed 1024, not a single new subagent
// could get in and the pane stayed stuck on the earliest batch of already-finished ones.
// Eviction flips this: terminal entries yield, live ones come in.
//
// Eviction must therefore satisfy four things at once; this file pins each one:
//   - eviction happens only when a **live newcomer** hits a full table, and only once the event
//     has lifted the watermark (replay never evicts);
//   - the victim is a settled loose node or a completed group, a pure function of run state (cold
//     replay evicts the same set);
//   - an actor never outlives its last listed node (otherwise it becomes a badge stuck on
//     pending forever);
//   - evicted entries **remain countable**: two run-level counters plus one bucket per birth
//     phase.
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_RUNS_LIMITS,
  applyConversationDeltas,
  coalesceConversationDeltas,
  conversationDeltaSchema,
  diffWorkflowRunsState,
  reduceWorkflowRunsState,
  workflowRunStepCounts,
  workflowRunsStateSchema,
  type ConversationDelta,
  type ConversationSnapshot,
  type WorkflowRunEntryLimits,
  type WorkflowRunProgressEnvelope,
  type WorkflowRunState,
  type WorkflowRunsState,
} from "../src/zcode-protocol-v4/index.js";

const RUN_ID = "dwfrun-1";

/**
 * Small limits for the tests. Limits must be injectable rather than constants: hitting 1024
 * entries takes three thousand-plus events, and with a round-trip assertion at every step that
 * becomes minutes of runtime, while the rules under test are independent of the **size** of the
 * limits.
 */
const LIMITS: WorkflowRunEntryLimits = { maxActors: 3, maxNodes: 3, maxPhases: 2 };

function snapshotWith(workflowRuns: WorkflowRunsState | undefined): ConversationSnapshot {
  const base = {
    protocolVersion: 1,
    sessionId: "s-1",
    logEpoch: "epoch-1",
    seq: 0,
    revision: 0,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
  return (workflowRuns === undefined
    ? base
    : { ...base, workflowRuns }) as unknown as ConversationSnapshot;
}

/** Event driver for one run: sequence auto-increments per call, state advances in place, replay feeds the original envelope again. */
function driver(limits: WorkflowRunEntryLimits = LIMITS, runId = RUN_ID) {
  let sequence = -1;
  let state: WorkflowRunsState | undefined;
  return {
    send(
      eventType: string,
      payload: Record<string, unknown> = {},
      extra: Partial<WorkflowRunProgressEnvelope> = {},
    ): WorkflowRunProgressEnvelope {
      sequence += 1;
      const envelope: WorkflowRunProgressEnvelope = {
        runId,
        toolCallId: "tc-1",
        sequence,
        eventType,
        payload,
        ...extra,
      };
      state = reduceWorkflowRunsState(state, envelope, limits) ?? state;
      return envelope;
    },
    /** Replay an already-sent envelope: returns the reduction result (null = byte-for-byte no change). */
    replay(envelope: WorkflowRunProgressEnvelope): WorkflowRunsState | null {
      return reduceWorkflowRunsState(state, envelope, limits);
    },
    get run(): WorkflowRunState {
      return state!.runs[0]!;
    },
    get state(): WorkflowRunsState {
      return state!;
    },
  };
}

const actorRef = (index: number) => ({ siteId: `actor#${index}`, ordinal: 1 });
const askRef = (index: number) => ({ siteId: `ask#${index}`, ordinal: 1 });
const worldRef = (index: number) => ({ siteId: `world#${index}`, ordinal: 1 });

const nodeKeys = (run: WorkflowRunState) => run.nodes.map((node) => node.siteId);
const actorKeys = (run: WorkflowRunState) => run.actors.map((actor) => actor.siteId);

/** One subagent runs a single ask: create actor, dispatch once, settle. `outcome` decides whether the group counts as failed. */
function runOneAsk(
  driven: ReturnType<typeof driver>,
  index: number,
  options: { outcome?: "ok" | "failed" | "cancelled"; phaseName?: string; settle?: boolean } = {},
): void {
  const phase = options.phaseName === undefined ? {} : { phaseName: options.phaseName };
  driven.send("actor-created", { actor: actorRef(index), name: `a${index}`, ...phase });
  driven.send("node-queued", {
    instance: askRef(index),
    kind: "ask",
    actor: actorRef(index),
    ...phase,
  });
  driven.send("node-dispatched", { instance: askRef(index) });
  driven.send("node-executing", { instance: askRef(index) });
  if (options.settle === false) return;
  driven.send("node-settled", { instance: askRef(index), outcome: options.outcome ?? "ok" });
}

/**
 * `node-dispatched` carrying **birth facts** (the engine's Part A): at dispatch time it re-sends,
 * verbatim, the same facts this instance's `node-queued` and its subagent's `actor-created`
 * carried, so the reduction can put an unlisted instance and its subagent back on the table "at
 * the moment of dispatch".
 */
function dispatchWithFacts(
  driven: ReturnType<typeof driver>,
  index: number,
  options: {
    phaseName?: string;
    instructionsHead?: string;
    instance?: { siteId: string; ordinal: number };
  } = {},
): WorkflowRunProgressEnvelope {
  return driven.send(
    "node-dispatched",
    {
      instance: options.instance ?? askRef(index),
      kind: "ask",
      actor: actorRef(index),
      actorName: `a${index}`,
      ...(options.phaseName === undefined
        ? {}
        : { actorPhaseName: options.phaseName, phaseName: options.phaseName }),
      ...(options.instructionsHead === undefined
        ? {}
        : { instructionsHead: options.instructionsHead }),
    },
    { actorSessionId: `sess-${index}` },
  );
}

describe("2.1 什么时候淘汰", () => {
  it("actor 表满 + 活的新人：淘汰一个已完成组，新人入座", () => {
    const driven = driver({ maxActors: 3, maxNodes: 6, maxPhases: 2 });
    runOneAsk(driven, 1);
    runOneAsk(driven, 2);
    runOneAsk(driven, 3, { settle: false });
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#2", "actor#3"]);

    driven.send("actor-created", { actor: actorRef(4), name: "a4" });
    // Two completed groups, same phase, same kind: take the earliest one in the table.
    expect(actorKeys(driven.run)).toEqual(["actor#2", "actor#3", "actor#4"]);
    // The group is the actor plus every listed node under it: they go together.
    expect(nodeKeys(driven.run)).toEqual(["ask#2", "ask#3"]);
    expect(driven.run.usage).toMatchObject({ nodesUnlisted: 1, nodesUnlistedSettled: 1 });
    expect(driven.run.truncated).toBe(true);
  });

  it("node 表满 + 活的新人：先淘汰已结算的游离节点（world-read 不是任何人的组）", () => {
    const driven = driver({ maxActors: 4, maxNodes: 3, maxPhases: 2 });
    driven.send("node-queued", { instance: worldRef(1), kind: "world-read" });
    driven.send("node-settled", { instance: worldRef(1), outcome: "ok" });
    runOneAsk(driven, 1);
    runOneAsk(driven, 2, { settle: false });
    expect(nodeKeys(driven.run)).toEqual(["world#1", "ask#1", "ask#2"]);

    driven.send("node-queued", { instance: askRef(3), kind: "ask", actor: actorRef(2) });
    // Loose nodes go first: evicting one only removes a row, evicting a group also removes an
    // actor.
    expect(nodeKeys(driven.run)).toEqual(["ask#1", "ask#2", "ask#3"]);
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#2"]);
    // Eviction still sets truncated: this run's table can no longer hold its own facts, and
    // run-started decides by exactly this bit whether a new life restarts from an empty table.
    expect(driven.run.truncated).toBe(true);
  });

  it("没有游离节点时淘汰一个已完成组（actor 与它的节点一起走）", () => {
    const driven = driver({ maxActors: 4, maxNodes: 3, maxPhases: 2 });
    runOneAsk(driven, 1);
    runOneAsk(driven, 2, { settle: false });
    driven.send("node-queued", { instance: askRef(9), kind: "ask", actor: actorRef(2) });
    expect(nodeKeys(driven.run)).toEqual(["ask#1", "ask#2", "ask#9"]);

    driven.send("actor-created", { actor: actorRef(3), name: "a3" });
    driven.send("node-queued", { instance: askRef(3), kind: "ask", actor: actorRef(3) });
    expect(nodeKeys(driven.run)).toEqual(["ask#2", "ask#9", "ask#3"]);
    expect(actorKeys(driven.run)).toEqual(["actor#2", "actor#3"]);
  });

  it("重放的事件永不淘汰：水位没抬过，表照旧拒新", () => {
    const driven = driver({ maxActors: 4, maxNodes: 3, maxPhases: 2 });
    runOneAsk(driven, 1);
    runOneAsk(driven, 2, { settle: false });
    const queued = driven.send("node-queued", {
      instance: askRef(9),
      kind: "ask",
      actor: actorRef(2),
    });
    const before = driven.run;
    // Feeding the same envelope again: the table already has this instance → byte-for-byte no
    // change.
    expect(driven.replay(queued)).toBeNull();
    expect(driven.run).toBe(before);
  });

  it("缓存命中的 node-settled 出生即结算，永不淘汰：它被拒，只进计数", () => {
    const driven = driver({ maxActors: 4, maxNodes: 3, maxPhases: 2 });
    runOneAsk(driven, 1);
    runOneAsk(driven, 2, { settle: false });
    driven.send("node-queued", { instance: askRef(9), kind: "ask", actor: actorRef(2) });
    const before = nodeKeys(driven.run);

    driven.send("actor-created", { actor: actorRef(3), name: "a3" });
    driven.send("node-settled", {
      instance: askRef(3),
      actor: actorRef(3),
      outcome: "ok",
      cached: true,
    });
    // The completed group is still in the table (ask#1), but a born-settled instance has no
    // standing to push it out.
    expect(nodeKeys(driven.run)).toEqual(before);
    expect(driven.run.usage).toMatchObject({ nodesUnlisted: 1, nodesUnlistedSettled: 1 });
  });

  it("一个可淘汰的受害者都没有时，照旧拒新并置 truncated", () => {
    const driven = driver({ maxActors: 4, maxNodes: 2, maxPhases: 2 });
    runOneAsk(driven, 1, { settle: false });
    runOneAsk(driven, 2, { settle: false });
    const before = nodeKeys(driven.run);

    driven.send("node-queued", { instance: askRef(3), kind: "ask", actor: actorRef(1) });
    expect(nodeKeys(driven.run)).toEqual(before);
    expect(driven.run.truncated).toBe(true);
    expect(driven.run.usage).toMatchObject({ nodesUnlisted: 1 });
    expect(driven.run.usage.nodesUnlistedSettled).toBeUndefined();
  });
});

describe("2.2 受害者顺序", () => {
  it("未失败的先走：失败是读者唯一还想找回来的已结算事实", () => {
    const driven = driver({ maxActors: 2, maxNodes: 6, maxPhases: 2 });
    runOneAsk(driven, 1, { outcome: "failed" });
    runOneAsk(driven, 2, { outcome: "ok" });
    driven.send("actor-created", { actor: actorRef(3), name: "a3" });
    // actor#1 is earlier in the table, but it failed: the one that yields is the unfailed
    // actor#2.
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#3"]);
    expect(nodeKeys(driven.run)).toEqual(["ask#1"]);
  });

  it("cancelled 与 failed 同类：都算这个组失败了", () => {
    const driven = driver({ maxActors: 2, maxNodes: 6, maxPhases: 2 });
    runOneAsk(driven, 1, { outcome: "cancelled" });
    runOneAsk(driven, 2, { outcome: "ok" });
    driven.send("actor-created", { actor: actorRef(3), name: "a3" });
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#3"]);
  });

  it("取候选最多的那个阶段：界花在条目拥挤的地方", () => {
    const driven = driver({ maxActors: 3, maxNodes: 8, maxPhases: 4 });
    runOneAsk(driven, 1, { phaseName: "p1" });
    runOneAsk(driven, 2, { phaseName: "p2" });
    runOneAsk(driven, 3, { phaseName: "p2" });
    driven.send("actor-created", { actor: actorRef(4), name: "a4", phaseName: "p3" });
    // p1 has one candidate, p2 has two: the victim comes from p2, the earliest in-table actor#2
    // within it.
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#3", "actor#4"]);
  });

  it("组的阶段是它 actor 的出生阶段（节点的戳不参与）", () => {
    const driven = driver({ maxActors: 3, maxNodes: 8, maxPhases: 4 });
    driven.send("actor-created", { actor: actorRef(1), name: "a1", phaseName: "p1" });
    driven.send("node-queued", {
      instance: askRef(1),
      kind: "ask",
      actor: actorRef(1),
      phaseName: "p2",
    });
    driven.send("node-settled", { instance: askRef(1), outcome: "ok" });
    runOneAsk(driven, 2, { phaseName: "p2" });
    runOneAsk(driven, 3, { phaseName: "p2" });
    driven.send("actor-created", { actor: actorRef(4), name: "a4" });
    // actor#1's node is stamped p2, but the actor itself was born in p1 — p2 still has only
    // actor#2 / actor#3 as candidates.
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#3", "actor#4"]);
  });

  it("新节点自己那个 actor 的组绝不当受害者（否则它会变成一条没有徽章的活节点）", () => {
    const driven = driver({ maxActors: 4, maxNodes: 3, maxPhases: 2 });
    // actor#1 runs two asks, both settled; actor#2 has also finished one.
    driven.send("actor-created", { actor: actorRef(1), name: "a1" });
    driven.send("node-queued", { instance: askRef(1), kind: "ask", actor: actorRef(1) });
    driven.send("node-settled", { instance: askRef(1), outcome: "ok" });
    driven.send("node-queued", { instance: askRef(2), kind: "ask", actor: actorRef(1) });
    driven.send("node-settled", { instance: askRef(2), outcome: "ok" });
    runOneAsk(driven, 3);
    expect(nodeKeys(driven.run)).toEqual(["ask#1", "ask#2", "ask#3"]);

    // actor#1's third ask hits the full table: its own "completed" group is about to start work
    // again, so it cannot be spent to pay the bill.
    driven.send("node-queued", { instance: askRef(4), kind: "ask", actor: actorRef(1) });
    expect(actorKeys(driven.run)).toContain("actor#1");
    expect(nodeKeys(driven.run)).toEqual(["ask#1", "ask#2", "ask#4"]);
    expect(actorKeys(driven.run)).toEqual(["actor#1"]);
  });

  it("未结算的节点与带着未结算节点的 actor 永远不是受害者", () => {
    const driven = driver({ maxActors: 4, maxNodes: 3, maxPhases: 2 });
    // actor#1 has two asks, one settled and one running → the whole group does not count as
    // completed.
    driven.send("actor-created", { actor: actorRef(1), name: "a1" });
    driven.send("node-queued", { instance: askRef(1), kind: "ask", actor: actorRef(1) });
    driven.send("node-settled", { instance: askRef(1), outcome: "ok" });
    driven.send("node-queued", { instance: askRef(2), kind: "ask", actor: actorRef(1) });
    driven.send("node-executing", { instance: askRef(2) });
    driven.send("node-queued", { instance: worldRef(1), kind: "world-read" });
    const before = nodeKeys(driven.run);

    driven.send("node-queued", { instance: askRef(3), kind: "ask", actor: actorRef(1) });
    // The loose node has not settled and the group is not complete → no victim, reject-new as
    // usual.
    expect(nodeKeys(driven.run)).toEqual(before);
    expect(driven.run.truncated).toBe(true);
  });
});

describe("2.3 孤儿规则", () => {
  it("出生即结算的节点被拒时，名下一个已列节点都没有的 actor 一起摘掉", () => {
    const driven = driver({ maxActors: 4, maxNodes: 2, maxPhases: 2 });
    runOneAsk(driven, 1, { settle: false });
    runOneAsk(driven, 2, { settle: false });
    driven.send("actor-created", { actor: actorRef(3), name: "a3", phaseName: "p1" });
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#2", "actor#3"]);

    driven.send("node-settled", {
      instance: askRef(3),
      actor: actorRef(3),
      outcome: "ok",
      cached: true,
      phaseName: "p1",
    });
    // A completed subagent that cannot bring in its own node does not join the table: keeping it
    // would be a pending badge that never moves.
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#2"]);
    expect(driven.run.unlistedByPhase).toEqual([
      { phaseName: "p1", actors: 1, actorsSettled: 1, settled: 1 },
    ]);
  });

  it("actor 还有别的已列节点时不摘（它不是孤儿）", () => {
    const driven = driver({ maxActors: 4, maxNodes: 2, maxPhases: 2 });
    runOneAsk(driven, 1, { settle: false });
    driven.send("actor-created", { actor: actorRef(2), name: "a2" });
    driven.send("node-queued", { instance: askRef(2), kind: "ask", actor: actorRef(2) });
    driven.send("node-executing", { instance: askRef(2) });

    driven.send("node-settled", {
      instance: askRef(9),
      actor: actorRef(2),
      outcome: "ok",
      cached: true,
    });
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#2"]);
  });

  it("失败的孤儿进 actorsFailed", () => {
    const driven = driver({ maxActors: 4, maxNodes: 2, maxPhases: 2 });
    runOneAsk(driven, 1, { settle: false });
    runOneAsk(driven, 2, { settle: false });
    driven.send("actor-created", { actor: actorRef(3), name: "a3", phaseName: "p1" });
    driven.send("node-settled", {
      instance: askRef(3),
      actor: actorRef(3),
      outcome: "failed",
      cached: true,
      phaseName: "p1",
    });
    expect(driven.run.unlistedByPhase).toEqual([
      { phaseName: "p1", actors: 1, actorsSettled: 1, actorsFailed: 1, settled: 1 },
    ]);
  });
});

describe("2.4 计数", () => {
  it("被淘汰的节点进 run 级两个计数器，步数读法照旧算得对", () => {
    const driven = driver({ maxActors: 2, maxNodes: 6, maxPhases: 2 });
    runOneAsk(driven, 1);
    runOneAsk(driven, 2, { settle: false });
    driven.send("actor-created", { actor: actorRef(3), name: "a3" });
    expect(driven.run.usage).toMatchObject({ nodesUnlisted: 1, nodesUnlistedSettled: 1 });
    // 1 in-table entry (ask#2, unsettled) + 1 unlisted (settled).
    expect(workflowRunStepCounts(driven.run)).toEqual({ total: 2, settled: 1 });
  });

  it("unlistedByPhase 按**出生阶段**分格，失败的另计一格子键", () => {
    const driven = driver({ maxActors: 2, maxNodes: 6, maxPhases: 4 });
    runOneAsk(driven, 1, { phaseName: "p1", outcome: "failed" });
    runOneAsk(driven, 2, { phaseName: "p2" });
    // The unfailed yield first: p2 steps aside.
    driven.send("actor-created", { actor: actorRef(3), name: "a3" });
    expect(driven.run.unlistedByPhase).toEqual([
      { phaseName: "p2", actors: 1, actorsSettled: 1, settled: 1 },
    ]);
    // One more newcomer → only the failed group remains evictable.
    driven.send("actor-created", { actor: actorRef(4), name: "a4" });
    expect(driven.run.unlistedByPhase).toEqual([
      { phaseName: "p2", actors: 1, actorsSettled: 1, settled: 1 },
      { phaseName: "p1", actors: 1, actorsSettled: 1, actorsFailed: 1, settled: 1 },
    ]);
    expect(driven.run.usage).toMatchObject({ nodesUnlisted: 2, nodesUnlistedSettled: 2 });
  });

  it("没有阶段戳的实例进**无阶段**那一格", () => {
    const driven = driver({ maxActors: 2, maxNodes: 6, maxPhases: 2 });
    runOneAsk(driven, 1);
    runOneAsk(driven, 2, { settle: false });
    driven.send("actor-created", { actor: actorRef(3), name: "a3" });
    // The unphased bucket's key is the **absent phaseName**, not an empty string (the same key as
    // the site side's "no phase() mark").
    expect(driven.run.unlistedByPhase).toEqual([{ actors: 1, actorsSettled: 1, settled: 1 }]);
  });

  it("阶段格满了丢归属，run 级计数照旧准", () => {
    // maxPhases = 1 → the bucket table holds at most 2 entries (one unphased + one named).
    const driven = driver({ maxActors: 2, maxNodes: 8, maxPhases: 1 });
    runOneAsk(driven, 1, { phaseName: "p1" });
    runOneAsk(driven, 2, { phaseName: "p2" });
    driven.send("actor-created", { actor: actorRef(3), name: "a3" });
    runOneAsk(driven, 4, { phaseName: "p3" });
    driven.send("actor-created", { actor: actorRef(5), name: "a5" });
    driven.send("actor-created", { actor: actorRef(6), name: "a6" });
    const buckets = driven.run.unlistedByPhase!;
    expect(buckets).toHaveLength(2);
    // Three phases have had evictions, but the bucket table only fits two — the third loses its
    // attribution, the total does not.
    const attributed = buckets.reduce((sum, bucket) => sum + bucket.settled, 0);
    expect(attributed).toBeLessThan(driven.run.usage.nodesUnlistedSettled!);
    expect(driven.run.usage).toMatchObject({ nodesUnlisted: 3, nodesUnlistedSettled: 3 });
  });

  it("一条都没被拒 / 淘汰过的 run 一个新键都不多", () => {
    const driven = driver({ maxActors: 6, maxNodes: 6, maxPhases: 2 });
    runOneAsk(driven, 1, { phaseName: "p1" });
    expect(driven.run).not.toHaveProperty("unlistedByPhase");
    expect(driven.run.usage).not.toHaveProperty("nodesUnlisted");
    expect(driven.run).not.toHaveProperty("truncated");
  });

  it("产出始终过 schema（unlistedByPhase 是协议线上的键）", () => {
    const driven = driver({ maxActors: 2, maxNodes: 4, maxPhases: 2 });
    runOneAsk(driven, 1, { phaseName: "p1" });
    runOneAsk(driven, 2, { phaseName: "p2", outcome: "failed" });
    driven.send("actor-created", { actor: actorRef(3), name: "a3" });
    expect(workflowRunsStateSchema.safeParse(driven.state).success).toBe(true);
  });
});

describe("2.5 resume：溢出过的 run 从空表重开", () => {
  it("truncated 的 run 在 run-started 后清空两张表并摘掉 unlistedByPhase", () => {
    const driven = driver({ maxActors: 2, maxNodes: 4, maxPhases: 2 });
    driven.send("run-started", {});
    runOneAsk(driven, 1, { phaseName: "p1" });
    runOneAsk(driven, 2, { phaseName: "p1", settle: false });
    driven.send("actor-created", { actor: actorRef(3), name: "a3" });
    expect(driven.run.truncated).toBe(true);
    expect(driven.run.unlistedByPhase).toBeDefined();

    driven.send("run-started", {});
    expect(driven.run.actors).toEqual([]);
    expect(driven.run.nodes).toEqual([]);
    expect(driven.run).not.toHaveProperty("unlistedByPhase");
    expect(driven.run.usage).toEqual({ spentTokens: 0, nodesUsed: 0 });
  });

  it("没溢出过的 run 照旧留着两张表（普通 resume 的历史不该被抹掉）", () => {
    const driven = driver({ maxActors: 6, maxNodes: 6, maxPhases: 2 });
    driven.send("run-started", {});
    runOneAsk(driven, 1);
    const actors = driven.run.actors;
    const nodes = driven.run.nodes;
    driven.send("run-started", {});
    expect(driven.run.actors).toBe(actors);
    expect(driven.run.nodes).toBe(nodes);
  });

  it("两世之后总数不翻倍：新一世每条实例只被列或只被计一次", () => {
    const driven = driver({ maxActors: 2, maxNodes: 2, maxPhases: 2 });
    driven.send("run-started", {});
    runOneAsk(driven, 1);
    runOneAsk(driven, 2);
    runOneAsk(driven, 3, { settle: false });
    const firstLife = workflowRunStepCounts(driven.run);
    expect(firstLife.total).toBe(3);

    // Second life: the engine re-sends the whole prefix (finished asks go through cache-hit
    // settles, unfinished ones re-queue).
    driven.send("run-started", {});
    driven.send("actor-created", { actor: actorRef(1), name: "a1" });
    driven.send("node-settled", {
      instance: askRef(1),
      actor: actorRef(1),
      outcome: "ok",
      cached: true,
    });
    driven.send("actor-created", { actor: actorRef(2), name: "a2" });
    driven.send("node-settled", {
      instance: askRef(2),
      actor: actorRef(2),
      outcome: "ok",
      cached: true,
    });
    runOneAsk(driven, 3, { settle: false });
    // Three instances, not one more: in-table + unlisted equals exactly the instances born this
    // life.
    expect(workflowRunStepCounts(driven.run).total).toBe(3);
    expect(workflowRunStepCounts(driven.run).settled).toBe(2);
  });
});

describe("B2 溢出之后，认不出主人的 queued 不上表", () => {
  it("truncated 的 run 里 actor 不在表上的 node-queued 被拒——哪怕节点表还空着", () => {
    const driven = driver({ maxActors: 1, maxNodes: 6, maxPhases: 2 });
    runOneAsk(driven, 1, { settle: false });
    driven.send("actor-created", { actor: actorRef(2), name: "a2" });
    expect(driven.run.truncated).toBe(true);
    const before = nodeKeys(driven.run);

    driven.send("node-queued", { instance: askRef(2), kind: "ask", actor: actorRef(2) });
    // The node table still has five free slots, but this node cannot draw a badge (pills filter
    // by run.actors); listing it would just burn a slot that the dispatches coming next actually
    // need.
    expect(nodeKeys(driven.run)).toEqual(before);
    expect(driven.run.usage).toMatchObject({ nodesUnlisted: 1 });
  });

  it("游离节点不受这条规则约束（world-read 本来就没有主人）", () => {
    const driven = driver({ maxActors: 1, maxNodes: 6, maxPhases: 2 });
    runOneAsk(driven, 1, { settle: false });
    driven.send("actor-created", { actor: actorRef(2), name: "a2" });
    driven.send("node-queued", { instance: worldRef(1), kind: "world-read" });
    expect(nodeKeys(driven.run)).toContain("world#1");
  });

  it("界之下照旧：没溢出过的 run 里这条 queued 正常上表", () => {
    const driven = driver({ maxActors: 6, maxNodes: 6, maxPhases: 2 });
    driven.send("node-queued", { instance: askRef(2), kind: "ask", actor: actorRef(2) });
    expect(nodeKeys(driven.run)).toEqual(["ask#2"]);
    expect(driven.run).not.toHaveProperty("truncated");
  });
});

describe("B3 派发即入座", () => {
  /** Incident shape: create all actors first, queue all work, then dispatch FIFO. */
  function incident(driven: ReturnType<typeof driver>, agents: number): void {
    for (let index = 1; index <= agents; index += 1) {
      driven.send(
        "actor-created",
        { actor: actorRef(index), name: `a${index}`, phaseName: "p1" },
        { actorSessionId: `sess-${index}` },
      );
    }
    for (let index = 1; index <= agents; index += 1) {
      driven.send("node-queued", {
        instance: askRef(index),
        kind: "ask",
        actor: actorRef(index),
        phaseName: "p1",
        instructionsHead: `do ${index}`,
      });
    }
  }

  it("被拒的子代理在**被派活的那一刻**连人带活回到表上", () => {
    const driven = driver({ maxActors: 2, maxNodes: 2, maxPhases: 2 });
    incident(driven, 3);
    // At birth not a single terminal entry exists: the first two fill the table, and the third is
    // rejected along with its work.
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#2"]);
    expect(nodeKeys(driven.run)).toEqual(["ask#1", "ask#2"]);
    expect(driven.run.usage).toMatchObject({ nodesUnlisted: 1 });

    dispatchWithFacts(driven, 1, { phaseName: "p1", instructionsHead: "do 1" });
    driven.send("node-settled", { instance: askRef(1), outcome: "ok" });
    dispatchWithFacts(driven, 2, { phaseName: "p1", instructionsHead: "do 2" });
    driven.send("node-settled", { instance: askRef(2), outcome: "ok" });

    dispatchWithFacts(driven, 3, { phaseName: "p1", instructionsHead: "do 3" });
    expect(actorKeys(driven.run)).toEqual(["actor#2", "actor#3"]);
    expect(driven.run.actors.at(-1)).toEqual({
      siteId: "actor#3",
      ordinal: 1,
      name: "a3",
      sessionId: "sess-3",
      status: "waiting",
      phaseName: "p1",
    });
    expect(driven.run.nodes.at(-1)).toMatchObject({
      siteId: "ask#3",
      kind: "ask",
      phase: "dispatched",
      actorSiteId: "actor#3",
      actorOrdinal: 1,
      phaseName: "p1",
      instructionsHead: "do 3",
    });
    // Three instances, not one more: two in-table + one unlisted (the evicted ask#1).
    expect(workflowRunStepCounts(driven.run)).toEqual({ total: 3, settled: 2 });
  });

  it("只缺 actor 位时已完成组先于空闲组让位", () => {
    const driven = driver({ maxActors: 3, maxNodes: 4, maxPhases: 2 });
    incident(driven, 4);
    dispatchWithFacts(driven, 1, { phaseName: "p1", instructionsHead: "do 1" });
    driven.send("node-settled", { instance: askRef(1), outcome: "ok" });

    dispatchWithFacts(driven, 4, { phaseName: "p1", instructionsHead: "do 4" });
    // actor#1 has completed, actor#2 / actor#3 are merely queued — the completed one yields.
    expect(actorKeys(driven.run)).toEqual(["actor#2", "actor#3", "actor#4"]);
  });

  it("只剩空闲组时让位的是**表内最靠后**的那个（FIFO 下它最后才轮到）", () => {
    const driven = driver({ maxActors: 3, maxNodes: 6, maxPhases: 2 });
    incident(driven, 4);
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#2", "actor#3"]);

    dispatchWithFacts(driven, 4, { phaseName: "p1", instructionsHead: "do 4" });
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#2", "actor#4"]);
    expect(nodeKeys(driven.run)).toEqual(["ask#1", "ask#2", "ask#4"]);
    // What yields is a **queued** node: it enters nodesUnlisted, but not one of them has settled.
    expect(driven.run.usage.nodesUnlisted).toBe(1);
    expect(driven.run.usage.nodesUnlistedSettled).toBeUndefined();
  });

  it("只缺节点位时先淘汰已结算的游离节点", () => {
    const driven = driver({ maxActors: 2, maxNodes: 2, maxPhases: 2 });
    driven.send("actor-created", { actor: actorRef(1), name: "a1" });
    driven.send("actor-created", { actor: actorRef(2), name: "a2" });
    driven.send("node-queued", { instance: worldRef(1), kind: "world-read" });
    driven.send("node-queued", { instance: askRef(1), kind: "ask", actor: actorRef(1) });
    // world#1 has not settled → no victim at all, ask#2 is rejected.
    driven.send("node-queued", { instance: askRef(2), kind: "ask", actor: actorRef(2) });
    expect(nodeKeys(driven.run)).toEqual(["world#1", "ask#1"]);
    driven.send("node-settled", { instance: worldRef(1), outcome: "ok" });

    dispatchWithFacts(driven, 2);
    expect(nodeKeys(driven.run)).toEqual(["ask#1", "ask#2"]);
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#2"]);
    expect(driven.run.usage).toMatchObject({ nodesUnlisted: 1, nodesUnlistedSettled: 1 });
  });

  it("只缺节点位时，先丢自己名下最老的那条已结算节点（actor 留着，徽章就留着）", () => {
    const driven = driver({ maxActors: 2, maxNodes: 2, maxPhases: 2 });
    driven.send("actor-created", { actor: actorRef(1), name: "a1" });
    driven.send("actor-created", { actor: actorRef(2), name: "a2" });
    driven.send("node-queued", { instance: askRef(1), kind: "ask", actor: actorRef(1) });
    driven.send("node-settled", { instance: askRef(1), outcome: "ok" });
    driven.send("node-queued", { instance: askRef(2), kind: "ask", actor: actorRef(2) });
    // actor#1's second ask hits the full table: at birth it cannot displace anyone (its own group
    // cannot pay the bill, everyone else's is still queued) → rejected.
    const second = { siteId: "ask#1", ordinal: 2 };
    driven.send("node-queued", { instance: second, kind: "ask", actor: actorRef(1) });
    expect(nodeKeys(driven.run)).toEqual(["ask#1", "ask#2"]);

    dispatchWithFacts(driven, 1, { instance: second });
    // What yields is **its own** settled node: actor#1 stays on the table (the badge does not
    // move) and the other idle group does not lose a single row — a subagent gives up its own
    // history before taking someone else's slot.
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#2"]);
    expect(driven.run.nodes.map((node) => `${node.siteId}#${node.ordinal}`)).toEqual([
      "ask#2#1",
      "ask#1#2",
    ]);
    // Bookkeeping matches evicting a loose node: both counters +1, the bucket table gains only
    // the node's bucket.
    expect(driven.run.usage).toMatchObject({ nodesUnlisted: 1, nodesUnlistedSettled: 1 });
    expect(driven.run.unlistedByPhase).toEqual([{ actors: 0, settled: 1 }]);
  });

  it("自己那个**组**仍然绝不当受害者：没有自己的已结算节点可丢时才动别人", () => {
    const driven = driver({ maxActors: 2, maxNodes: 2, maxPhases: 2 });
    driven.send("actor-created", { actor: actorRef(1), name: "a1" });
    driven.send("actor-created", { actor: actorRef(2), name: "a2" });
    // actor#1 has only one **queued** node under it: not disposable history.
    driven.send("node-queued", { instance: askRef(1), kind: "ask", actor: actorRef(1) });
    driven.send("node-queued", { instance: askRef(2), kind: "ask", actor: actorRef(2) });
    const second = { siteId: "ask#1", ordinal: 2 };
    driven.send("node-queued", { instance: second, kind: "ask", actor: actorRef(1) });

    dispatchWithFacts(driven, 1, { instance: second });
    // What moves is the other idle group; actor#1 keeps itself and both of its asks.
    expect(actorKeys(driven.run)).toEqual(["actor#1"]);
    expect(driven.run.nodes.map((node) => `${node.siteId}#${node.ordinal}`)).toEqual([
      "ask#1#1",
      "ask#1#2",
    ]);
  });

  it("在跑的组永远不是受害者：腾不出位就照旧拒新", () => {
    const driven = driver({ maxActors: 1, maxNodes: 1, maxPhases: 2 });
    runOneAsk(driven, 1, { settle: false });
    driven.send("actor-created", { actor: actorRef(2), name: "a2" });
    driven.send("node-queued", { instance: askRef(2), kind: "ask", actor: actorRef(2) });
    const before = driven.run.usage.nodesUnlisted;

    dispatchWithFacts(driven, 2);
    expect(actorKeys(driven.run)).toEqual(["actor#1"]);
    expect(nodeKeys(driven.run)).toEqual(["ask#1"]);
    expect(driven.run.usage.nodesUnlisted).toBe(before);
  });

  it("最后一档：一张全是零节点 actor 的表也腾得出位（resume 的形状）", () => {
    const driven = driver({ maxActors: 3, maxNodes: 2, maxPhases: 2 });
    // First let this run have overflowed (truncated): the zero-node tier only applies after an
    // overflow, and only at activation.
    driven.send("node-queued", { instance: worldRef(1), kind: "world-read", phaseName: "p1" });
    driven.send("node-queued", { instance: worldRef(2), kind: "world-read", phaseName: "p1" });
    driven.send("node-queued", { instance: worldRef(3), kind: "world-read", phaseName: "p1" });
    expect(driven.run.truncated).toBe(true);
    driven.send("node-settled", { instance: worldRef(1), outcome: "ok" });

    // Resume shape: the actors are re-created, while the cache-hit settles arrive **without the
    // actor** (the engine's node-settled has no such field), so these subagents end up with not a
    // single listed node — under all three older tiers none of them qualifies.
    for (const index of [1, 2, 3]) {
      driven.send(
        "actor-created",
        { actor: actorRef(index), name: `a${index}`, phaseName: "p1" },
        { actorSessionId: `sess-${index}` },
      );
    }
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#2", "actor#3"]);
    for (const actor of driven.run.actors) expect(nodesOfActor(driven.run, actor)).toEqual([]);

    // The fourth subagent is rejected at birth (table full, not a single completed group): one
    // bucket is recorded first.
    driven.send(
      "actor-created",
      { actor: actorRef(4), name: "a4", phaseName: "p1" },
      { actorSessionId: "sess-4" },
    );
    expect(driven.run.unlistedByPhase).toEqual([{ phaseName: "p1", actors: 1, settled: 0 }]);

    // It gets dispatched: table full, no group at all, so what yields is the **latest in-table**
    // zero-node actor.
    dispatchWithFacts(driven, 4, { phaseName: "p1", instructionsHead: "do 4" });
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#2", "actor#4"]);
    expect(driven.run.nodes.at(-1)).toMatchObject({
      siteId: "ask#4",
      phase: "dispatched",
      actorSiteId: "actor#4",
    });
    // A zero-node actor's exit records only actors: this bucket cannot know its outcome (never
    // settled, or maybe simply never asked yet).
    // After one in and one out the bucket is still 1, and that 1 is precisely actor#3 that yielded;
    // the settled on the same bucket comes from the loose node that gave up its node slot.
    expect(driven.run.unlistedByPhase).toEqual([{ phaseName: "p1", actors: 1, settled: 1 }]);

    // And the next time it is dispatched it gets back in all the same — that is exactly why this
    // tier is safe.
    driven.send("node-settled", { instance: askRef(4), outcome: "ok" });
    dispatchWithFacts(driven, 3, { phaseName: "p1", instructionsHead: "do 3" });
    expect(actorKeys(driven.run)).toContain("actor#3");
  });

  it("不带事实的 dispatch 照老样子（旧 journal、world-read 的派发）", () => {
    const driven = driver({ maxActors: 2, maxNodes: 2, maxPhases: 2 });
    incident(driven, 3);
    driven.send("node-dispatched", { instance: askRef(3) });
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#2"]);
    expect(nodeKeys(driven.run)).toEqual(["ask#1", "ask#2"]);
  });

  it("重放的 dispatch 不入座：水位没抬过", () => {
    const driven = driver({ maxActors: 2, maxNodes: 2, maxPhases: 2 });
    incident(driven, 3);
    const stale: WorkflowRunProgressEnvelope = {
      runId: RUN_ID,
      toolCallId: "tc-1",
      sequence: 0,
      eventType: "node-dispatched",
      payload: { instance: askRef(3), kind: "ask", actor: actorRef(3), actorName: "a3" },
      actorSessionId: "sess-3",
    };
    expect(driven.replay(stale)).toBeNull();
  });

  it("界之下不凭空造 actor：没溢出过的 run 照旧只落节点", () => {
    const driven = driver({ maxActors: 6, maxNodes: 6, maxPhases: 2 });
    dispatchWithFacts(driven, 1, { phaseName: "p1" });
    expect(driven.run.actors).toEqual([]);
    expect(nodeKeys(driven.run)).toEqual(["ask#1"]);
  });

  it("两次 ask 之间被淘汰的子代理，在下一次派发时拿回自己的徽章", () => {
    const driven = driver({ maxActors: 2, maxNodes: 3, maxPhases: 2 });
    driven.send(
      "actor-created",
      { actor: actorRef(1), name: "a1", phaseName: "p1" },
      { actorSessionId: "sess-1" },
    );
    driven.send("node-queued", { instance: askRef(1), kind: "ask", actor: actorRef(1) });
    driven.send("node-dispatched", { instance: askRef(1) });
    driven.send("node-settled", { instance: askRef(1), outcome: "ok" });
    driven.send("actor-created", { actor: actorRef(2), name: "a2" });
    driven.send("node-queued", { instance: askRef(2), kind: "ask", actor: actorRef(2) });
    driven.send("node-dispatched", { instance: askRef(2) });
    // actor#3 is born → the completed group actor#1 yields, leaving together with ask#1.
    driven.send("actor-created", { actor: actorRef(3), name: "a3" });
    driven.send("node-queued", { instance: askRef(3), kind: "ask", actor: actorRef(3) });
    expect(actorKeys(driven.run)).toEqual(["actor#2", "actor#3"]);

    // The script dispatches actor#1's second ask: the queued event cannot recognize its owner and
    // is rejected; at dispatch it comes back along with its work.
    const second = { siteId: "ask#1", ordinal: 2 };
    driven.send("node-queued", { instance: second, kind: "ask", actor: actorRef(1) });
    dispatchWithFacts(driven, 1, { instance: second, phaseName: "p1" });
    expect(driven.run.actors.at(-1)).toEqual({
      siteId: "actor#1",
      ordinal: 1,
      name: "a1",
      sessionId: "sess-1",
      status: "waiting",
      phaseName: "p1",
    });
  });
});

describe("B4 表外的子代理也按出生阶段可数", () => {
  it("被拒的 actor-created 记一格 actors", () => {
    const driven = driver({ maxActors: 1, maxNodes: 4, maxPhases: 2 });
    runOneAsk(driven, 1, { phaseName: "p1", settle: false });
    driven.send("actor-created", { actor: actorRef(2), name: "a2", phaseName: "p2" });
    expect(driven.run.unlistedByPhase).toEqual([{ phaseName: "p2", actors: 1, settled: 0 }]);
  });

  it("已完成组让位：actors 与 actorsSettled 一起加，失败的再加一格", () => {
    const driven = driver({ maxActors: 2, maxNodes: 6, maxPhases: 4 });
    runOneAsk(driven, 1, { phaseName: "p1", outcome: "failed" });
    runOneAsk(driven, 2, { phaseName: "p2" });
    driven.send("actor-created", { actor: actorRef(3), name: "a3", phaseName: "p3" });
    expect(driven.run.unlistedByPhase).toEqual([
      { phaseName: "p2", actors: 1, actorsSettled: 1, settled: 1 },
    ]);
    driven.send("actor-created", { actor: actorRef(4), name: "a4", phaseName: "p3" });
    expect(driven.run.unlistedByPhase).toEqual([
      { phaseName: "p2", actors: 1, actorsSettled: 1, settled: 1 },
      { phaseName: "p1", actors: 1, actorsSettled: 1, actorsFailed: 1, settled: 1 },
    ]);
  });

  it("空闲组让位只加 actors；回表的子代理把自己那一格减回去，归零即摘格", () => {
    const driven = driver({ maxActors: 2, maxNodes: 6, maxPhases: 4 });
    for (const index of [1, 2, 3]) {
      driven.send(
        "actor-created",
        { actor: actorRef(index), name: `a${index}`, phaseName: `p${index}` },
        { actorSessionId: `sess-${index}` },
      );
    }
    for (const index of [1, 2, 3]) {
      driven.send("node-queued", {
        instance: askRef(index),
        kind: "ask",
        actor: actorRef(index),
        phaseName: `p${index}`,
      });
    }
    expect(driven.run.unlistedByPhase).toEqual([{ phaseName: "p3", actors: 1, settled: 0 }]);

    dispatchWithFacts(driven, 3, { phaseName: "p3" });
    // The idle group actor#2 yields (only actors +1, its work has not started); actor#3 returns
    // to the table, p3's bucket reaches zero and is removed.
    expect(driven.run.unlistedByPhase).toEqual([{ phaseName: "p2", actors: 1, settled: 0 }]);
    expect(driven.run.usage.nodesUnlistedSettled).toBeUndefined();
  });

  it("被拒的出生即结算节点：actor 不在表上时**只**记节点那一格", () => {
    const driven = driver({ maxActors: 1, maxNodes: 1, maxPhases: 4 });
    runOneAsk(driven, 1, { phaseName: "p1", settle: false });
    driven.send("actor-created", { actor: actorRef(2), name: "a2", phaseName: "p2" });
    driven.send("node-settled", {
      instance: askRef(2),
      actor: actorRef(2),
      outcome: "failed",
      cached: true,
      phaseName: "p2",
    });
    // This settle does **not** record actorsSettled: the subagent is already counted as actors on
    // **its own** birth phase, and the node's phase stamp is not necessarily the same one; worse,
    // a subagent with two cache hits would thereby be recorded as "finished" twice.
    // It is still an unlisted subagent, and the read surface counts it as pending until it is
    // back on the table.
    expect(driven.run.unlistedByPhase).toEqual([{ phaseName: "p2", actors: 1, settled: 1 }]);
  });

  it("每一格恒满足 actorsFailed ≤ actorsSettled ≤ actors（夹取是这一格的法律）", () => {
    const driven = driver({ maxActors: 1, maxNodes: 2, maxPhases: 4 });
    // actor#1 runs one ask (failed), then is pushed out by actor#2's birth: p1's bucket records
    // "one left, settled, and failed at that".
    runOneAsk(driven, 1, { phaseName: "p1", outcome: "failed" });
    driven.send("actor-created", { actor: actorRef(2), name: "a2", phaseName: "p2" });
    expect(driven.run.unlistedByPhase).toEqual([
      { phaseName: "p1", actors: 1, actorsSettled: 1, actorsFailed: 1, settled: 1 },
    ]);

    // actor#1 actually has a second ask. When queued it cannot be recognized (B2 rejects it); at
    // dispatch it pushes out actor#2's idle group and returns to the table.
    driven.send("node-queued", { instance: askRef(2), kind: "ask", actor: actorRef(2) });
    const second = { siteId: "ask#1", ordinal: 2 };
    driven.send("node-queued", { instance: second, kind: "ask", actor: actorRef(1) });
    dispatchWithFacts(driven, 1, { phaseName: "p1", instance: second });
    expect(actorKeys(driven.run)).toEqual(["actor#1"]);

    // Returning to the table zeroes p1's actors, and the bucket cannot tell who came back —
    // clamping pulls actorsSettled and actorsFailed back to zero too, so the read surface never
    // counts a running subagent as completed.
    expect(driven.run.unlistedByPhase).toEqual([
      { phaseName: "p1", actors: 0, settled: 1 },
      { phaseName: "p2", actors: 1, settled: 0 },
    ]);
    for (const bucket of driven.run.unlistedByPhase ?? []) {
      expect(bucket.actorsFailed ?? 0).toBeLessThanOrEqual(bucket.actorsSettled ?? 0);
      expect(bucket.actorsSettled ?? 0).toBeLessThanOrEqual(bucket.actors);
    }
  });
});

// ── Invariants I1–I6: drive the real reduction with a generated single-life event stream ─────

/** Deterministic PRNG: randomized input must be reproducible, otherwise one red run stays red forever. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

interface GeneratedStream {
  envelopes: WorkflowRunProgressEnvelope[];
  /** Instance keys born this life (node-queued, or a born-settled cached settle). */
  born: Set<string>;
  /** Instance keys settled this life. */
  settled: Set<string>;
}

/**
 * A **single-life** event stream: a few phases, 1–3 asks per subagent, world-reads interleaved,
 * a few failures, plus a few **replays** (the original envelope fed again). Deliberately wider
 * than the limits: the eviction paths must be fully exercised.
 */
function generateLife(seed: number, agents: number): GeneratedStream {
  const random = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const envelopes: WorkflowRunProgressEnvelope[] = [];
  const born = new Set<string>();
  const settled = new Set<string>();
  let sequence = -1;
  const emit = (eventType: string, payload: Record<string, unknown>) => {
    sequence += 1;
    const envelope: WorkflowRunProgressEnvelope = {
      runId: RUN_ID,
      toolCallId: "tc-1",
      sequence,
      eventType,
      payload,
    };
    envelopes.push(envelope);
    return envelope;
  };
  const phases = ["p1", "p2", "p3", "p4"];
  emit("run-started", {});
  for (let index = 1; index <= agents; index += 1) {
    const phaseName = pick(phases);
    if (random() < 0.2) emit("phase-entered", { name: phaseName, ordinal: 1 });
    if (random() < 0.25) {
      // Loose node: a world-read belongs to nobody's group.
      const world = worldRef(index);
      const worldKey = `${world.siteId}\u0000${world.ordinal}`;
      if (random() < 0.5) {
        emit("node-settled", { instance: world, outcome: "ok", cached: true, phaseName });
      } else {
        emit("node-queued", { instance: world, kind: "world-read", phaseName });
        emit("node-settled", { instance: world, outcome: "ok" });
      }
      born.add(worldKey);
      settled.add(worldKey);
    }
    emit("actor-created", { actor: actorRef(index), name: `a${index}`, phaseName });
    const asks = 1 + Math.floor(random() * 3);
    for (let ask = 0; ask < asks; ask += 1) {
      const instance = { siteId: `ask#${index}`, ordinal: ask };
      const key = `${instance.siteId}\u0000${instance.ordinal}`;
      if (random() < 0.2) {
        // Resume cache hit: born settled, without going through queued.
        emit("node-settled", {
          instance,
          actor: actorRef(index),
          outcome: "ok",
          cached: true,
          phaseName,
        });
        born.add(key);
        settled.add(key);
        continue;
      }
      const queued = emit("node-queued", {
        instance,
        kind: "ask",
        actor: actorRef(index),
        phaseName,
      });
      born.add(key);
      emit("node-dispatched", { instance });
      emit("node-executing", { instance });
      // A few replays: the original envelope once more, verbatim; the reduction must treat it as
      // nonexistent.
      if (random() < 0.15) envelopes.push(queued);
      if (random() < 0.85) {
        emit("node-settled", { instance, outcome: pick(["ok", "ok", "failed", "cancelled"]) });
        settled.add(key);
      }
    }
  }
  return { envelopes, born, settled };
}

const entryKey = (entry: { siteId: string; ordinal: number }) =>
  `${entry.siteId}\u0000${entry.ordinal}`;
const nodeKeySet = (run: WorkflowRunState) => new Set(run.nodes.map(entryKey));
const actorKeySet = (run: WorkflowRunState) => new Set(run.actors.map(entryKey));
const nodesOfActor = (run: WorkflowRunState, actor: { siteId: string; ordinal: number }) =>
  run.nodes.filter(
    (node) => node.actorSiteId === actor.siteId && node.actorOrdinal === actor.ordinal,
  );

/** Every step the reduction took: the state before applying that step's delta, and the delta it produced. */
interface ReducedStep {
  prior: WorkflowRunsState | undefined;
  deltas: ConversationDelta[];
}

/**
 * Coalesce contract: any choice of windows, merged then applied, is byte-for-byte identical to
 * applying them one by one.
 *
 * The second limit set (`tight`) forces out rule 6's **merge-rejected** branch: under the real
 * limit of 1024 it takes thousands of events to reach, and it is exactly where "merge equals
 * sequential apply" breaks most easily — after a rejection the window holds more than one op of
 * the same run, and a later op must fold into the **last** one, otherwise its upsert would land
 * before that middle op's delete.
 */
function expectCoalesceEquivalence(steps: readonly ReducedStep[], seed: number): void {
  const random = rng(seed + 99);
  const tight = { maxActors: 1, maxNodes: 1 };
  let declined = 0;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const from = Math.floor(random() * steps.length);
    const to = Math.min(steps.length, from + 1 + Math.floor(random() * 20));
    const window = steps.slice(from, to).flatMap((step) => step.deltas);
    const base = snapshotWith(steps[from]!.prior);
    const direct = applyConversationDeltas(base, window);
    for (const bounds of [undefined, tight]) {
      const merged = coalesceConversationDeltas(window, bounds);
      expect(JSON.stringify(applyConversationDeltas(base, merged).workflowRuns)).toBe(
        JSON.stringify(direct.workflowRuns),
      );
      if (bounds !== undefined && merged.length > 1) declined += 1;
    }
  }
  // This assertion guards the comment above: the small limits really did get a merge rejected,
  // otherwise that branch was never exercised.
  expect(declined).toBeGreaterThan(0);
}

describe("不变量 I1–I6（生成的单世事件流）", () => {
  for (const seed of [1, 7, 42, 1_337]) {
    it(`seed ${seed}：界、淘汰对象、孤儿、总数、幂等、归属都成立`, () => {
      const limits: WorkflowRunEntryLimits = { maxActors: 5, maxNodes: 7, maxPhases: 3 };
      const { envelopes, born, settled } = generateLife(seed, 24);
      let state: WorkflowRunsState | undefined;
      const everListed = new Set<string>();
      const steps: ReducedStep[] = [];

      for (const envelope of envelopes) {
        const next = reduceWorkflowRunsState(state, envelope, limits);
        // I5 (first half): replaying a just-reduced event is a complete no-op.
        if (next !== null) {
          expect(reduceWorkflowRunsState(next, envelope, limits)).toBeNull();
        }
        if (next === null) continue;
        const prior = state;
        const run = next.runs[0]!;

        // I1: both tables stay within the limits.
        expect(run.actors.length).toBeLessThanOrEqual(limits.maxActors);
        expect(run.nodes.length).toBeLessThanOrEqual(limits.maxNodes);

        if (prior !== undefined) {
          const priorRun = prior.runs[0]!;
          const keptNodes = nodeKeySet(run);
          const keptActors = actorKeySet(run);
          // I2: a departed node has definitely settled; a departed actor has not a single
          // unsettled node under it.
          for (const node of priorRun.nodes) {
            if (keptNodes.has(entryKey(node))) continue;
            expect(node.phase).toBe("settled");
          }
          for (const actor of priorRun.actors) {
            if (keptActors.has(entryKey(actor))) continue;
            for (const node of nodesOfActor(priorRun, actor)) expect(node.phase).toBe("settled");
          }
        }

        // I3: an actor that ever listed a node never drops to zero nodes.
        for (const actor of run.actors) {
          const key = entryKey(actor);
          if (nodesOfActor(run, actor).length > 0) {
            everListed.add(key);
            continue;
          }
          expect(everListed.has(key)).toBe(false);
        }

        // I6: the sum of attributions never exceeds the run-level settled count, and every bucket
        // always satisfies actorsFailed ≤ actorsSettled ≤ actors.
        const attributed = (run.unlistedByPhase ?? []).reduce(
          (sum, bucket) => sum + bucket.settled,
          0,
        );
        expect(attributed).toBeLessThanOrEqual(run.usage.nodesUnlistedSettled ?? 0);
        for (const bucket of run.unlistedByPhase ?? []) {
          expect(bucket.actorsFailed ?? 0).toBeLessThanOrEqual(bucket.actorsSettled ?? 0);
          expect(bucket.actorsSettled ?? 0).toBeLessThanOrEqual(bucket.actors);
        }

        // diff contract: applying the deltas to prior is byte-for-byte identical to next.
        const deltas = diffWorkflowRunsState(prior, next);
        expect(deltas.some((delta) => delta.op === "state.updated")).toBe(false);
        for (const delta of deltas) {
          expect(conversationDeltaSchema.safeParse(delta).success).toBe(true);
        }
        const applied = applyConversationDeltas(snapshotWith(prior), deltas);
        expect(JSON.stringify(applied.workflowRuns)).toBe(JSON.stringify(next));
        expect(workflowRunsStateSchema.safeParse(next).success).toBe(true);
        steps.push({ prior, deltas });
        state = next;
      }

      const run = state!.runs[0]!;
      // I4: in-table + unlisted = the instances born this life; settled likewise.
      expect(run.nodes.length + (run.usage.nodesUnlisted ?? 0)).toBe(born.size);
      expect(workflowRunStepCounts(run)).toEqual({ total: born.size, settled: settled.size });

      // I5 (other half): cold-replaying the same event stream yields a byte-for-byte identical
      // state.
      let replayed: WorkflowRunsState | undefined;
      for (const envelope of envelopes) {
        replayed = reduceWorkflowRunsState(replayed, envelope, limits) ?? replayed;
      }
      expect(JSON.stringify(replayed)).toBe(JSON.stringify(state));

      expectCoalesceEquivalence(steps, seed);
    });
  }

  it("界之下的乱序投递一条都不丢：在线事件先开头、journal 前缀随后补齐", () => {
    // This one guards that the tightened rule must **not** apply below the limits. The reduction
    // still applies below-watermark events as usual (it only refuses to pull the watermark back
    // down), and the CLI's cold materialization feeds the journal replay and live events into the
    // same reduction: if a live event really opened a run first, that run's entire journal prefix
    // falls below the watermark. Tightening indiscriminately by watermark would leave this run's
    // card empty — a regression for every ordinary below-limit run, bought for a problem that only
    // exists after an overflow.
    const limits: WorkflowRunEntryLimits = { maxActors: 64, maxNodes: 64, maxPhases: 8 };
    const { envelopes, born } = generateLife(11, 10);
    const reduceSeq = (stream: readonly WorkflowRunProgressEnvelope[]) => {
      let state: WorkflowRunsState | undefined;
      for (const envelope of stream)
        state = reduceWorkflowRunsState(state, envelope, limits) ?? state;
      return state!.runs[0]!;
    };
    const inOrder = reduceSeq(envelopes);
    // The last envelope arrives first, lifting the watermark straight to the top; the rest falls
    // entirely below it.
    const seeded = reduceSeq([envelopes.at(-1)!, ...envelopes]);
    expect(inOrder.nodes).toHaveLength(born.size);
    expect(new Set(seeded.nodes.map(entryKey))).toEqual(new Set(inOrder.nodes.map(entryKey)));
    expect(new Set(seeded.actors.map(entryKey))).toEqual(new Set(inOrder.actors.map(entryKey)));
    // Never hit the limits → nothing rejected, nothing evicted.
    expect(seeded).not.toHaveProperty("truncated");
    expect(seeded.usage).not.toHaveProperty("nodesUnlisted");
  });

  it("真实的界（1024）下也照样跑：小界不是规则的前提", () => {
    const { envelopes } = generateLife(3, 12);
    let state: WorkflowRunsState | undefined;
    for (const envelope of envelopes) {
      state = reduceWorkflowRunsState(state, envelope) ?? state;
    }
    const run = state!.runs[0]!;
    // Never hit the limits → nothing evicted, not a single new key.
    expect(run.actors.length).toBeLessThanOrEqual(WORKFLOW_RUNS_LIMITS.maxActors);
    expect(run).not.toHaveProperty("unlistedByPhase");
    expect(run).not.toHaveProperty("truncated");
  });
});

// ── Invariants I7 / I8: engine-shaped event streams ────────────────────────
//
// The generator above **interleaves** birth and settlement (create one, run one, settle one), so
// the table always holds a just-finished group that can yield — and the 2026-09-20 incident
// (5 × 2000 subagents, concurrency 13) was exactly the shape it failed to catch: one phase
// fires **all** actor-created events and **all** node-queued events within the first seconds,
// the first 1024 are still queued and already fill both tables with not one terminal entry, so
// the remaining 976 subagents are rejected along with their work; the scheduler then dispatches
// FIFO, and from number 1025 on **not one running subagent is on the table**.
//
// So this generator follows the engine's shape: create all actors first, queue all first asks,
// then dispatch FIFO within the concurrency cap, with every node-dispatched carrying birth facts.
// A subagent runs 1–3 asks in a row, some fail, world-reads are interleaved (their dispatch
// carries no facts), and an envelope is occasionally replayed.

/** One subagent in a generated stream: runs `asks` asks serially; ask k+1 queues only after ask k settles. */
interface EngineAgent {
  index: number;
  phaseName: string;
  asks: number;
  /** How many times it has started, which is also the next ask's ordinal. */
  done: number;
}

/** The shape of a generated stream. The **relative sizes** of the concurrency cap and the two table limits decide whether I7's exemption is needed. */
interface EngineShape {
  phases: number;
  agentsPerPhase: number;
  concurrency: number;
  /**
   * Probability an ask hits the completion cache (replay / amend-resume short circuit): it never
   * queues or dispatches, it just emits a born-settled `node-settled { cached: true }`.
   */
  cachedRate: number;
  /**
   * Whether cache settles carry birth facts. The current engine does (kind / actor / actorSeq /
   * instructionsHead, imported hits additionally carry the predecessor's `sourceSessionId`, and
   * the envelope supplements this run's `actorSessionId`), so it lands as a node attributed to
   * the subagent; older journals do not, so it lands as a loose node. Both shapes must run: cold
   * replay of an old run still produces the latter.
   */
  cachedNamesActor: boolean;
  /**
   * The first life is cut off at the nth settle (user stop), then `run-started` opens a new one:
   * an overflowed run restarts from an empty table, the replayed prefix re-creates **all**
   * actors, adds a no-actor cached settle for each finished ask, re-queues the unfinished ones,
   * and dispatches FIFO as before. 0 = run a single life.
   */
  interruptAfter: number;
  /** How many asks a subagent may run at most (1 = one and done, so "settled" equals "fully done"). */
  maxAsks: number;
}

function generateEngineLife(seed: number, shape: EngineShape): WorkflowRunProgressEnvelope[] {
  const random = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const envelopes: WorkflowRunProgressEnvelope[] = [];
  let sequence = -1;
  let worldNumber = 0;
  const emit = (
    eventType: string,
    payload: Record<string, unknown>,
    extra: Partial<WorkflowRunProgressEnvelope> = {},
  ): WorkflowRunProgressEnvelope => {
    sequence += 1;
    const envelope: WorkflowRunProgressEnvelope = {
      runId: RUN_ID,
      toolCallId: "tc-1",
      sequence,
      eventType,
      payload,
      ...extra,
    };
    envelopes.push(envelope);
    return envelope;
  };
  /** Occasionally feed a just-sent envelope again, verbatim: the reduction must treat it as nonexistent. */
  const maybeReplay = (envelope: WorkflowRunProgressEnvelope): void => {
    if (random() < 0.12) envelopes.push(envelope);
  };
  const askInstance = (agent: EngineAgent) => ({
    siteId: `ask#${agent.index}`,
    ordinal: agent.done,
  });
  const instructionsHead = (agent: EngineAgent) => `task ${agent.index}.${agent.done}`;
  /**
   * The cache-hit settle (scheduler.ts's tryImportedSettle / settleCachedAsk). `imported` is true
   * only on first-life hits: those are the amend-run's imported hits, with the answer read from
   * the predecessor's session; the second life's prefix is this run's own replay.
   */
  const settleCached = (agent: EngineAgent, phaseName: string, imported: boolean): void => {
    const facts = shape.cachedNamesActor
      ? {
          kind: "ask",
          actor: actorRef(agent.index),
          actorSeq: agent.done,
          instructionsHead: instructionsHead(agent),
          ...(imported ? { sourceSessionId: `sess-a-${agent.index}` } : {}),
        }
      : {};
    maybeReplay(
      emit(
        "node-settled",
        { instance: askInstance(agent), outcome: "ok", cached: true, phaseName, ...facts },
        shape.cachedNamesActor ? { actorSessionId: `sess-${agent.index}` } : {},
      ),
    );
  };
  // The scheduler's node-queued (scheduler.ts): kind / actor / actorSeq / instructionsHead land
  // here; the engine stamps the birth phase name afterwards (engine-phase-stamp.ts).
  const queueAsk = (agent: EngineAgent): void => {
    maybeReplay(
      emit("node-queued", {
        instance: askInstance(agent),
        kind: "ask",
        actor: actorRef(agent.index),
        actorSeq: agent.done,
        phaseName: agent.phaseName,
        instructionsHead: instructionsHead(agent),
      }),
    );
  };
  // Dispatch re-sends the birth facts (DESIGN-3 Part A): kind / actor / the node's phase stamp /
  // the task summary come from this instance's node-queued, the name and birth phase from its
  // actor-created, and the session id rides the same envelope field as actor-created
  // (dynamic-workflow-run-launch.ts's actorSessionRefOf supplements it on both event kinds).
  const dispatchAsk = (agent: EngineAgent): void => {
    maybeReplay(
      emit(
        "node-dispatched",
        {
          instance: askInstance(agent),
          kind: "ask",
          actor: actorRef(agent.index),
          actorName: `a${agent.index}`,
          actorPhaseName: agent.phaseName,
          phaseName: agent.phaseName,
          instructionsHead: instructionsHead(agent),
        },
        { actorSessionId: `sess-${agent.index}` },
      ),
    );
    emit("node-executing", { instance: askInstance(agent) });
    // A reading from a resolved turn. Not a lifecycle event (no phase, no step count), but it
    // does sit between those two, and for an **unlisted** instance it must be a complete no-op —
    // otherwise it would conjure a row for an unlisted instance out of thin air.
    if (random() < 0.4) {
      emit("node-progress", {
        instance: askInstance(agent),
        turn: 1,
        toolCalls: 1,
        lastTool: { name: "submit_result" },
      });
    }
  };
  const worldRead = (phaseName: string): void => {
    worldNumber += 1;
    const instance = worldRef(worldNumber);
    emit("node-queued", { instance, kind: "world-read", phaseName });
    // The world-read's dispatch follows its own queueing and carries **no facts**
    // (engine-world.ts).
    emit("node-dispatched", { instance });
    emit("node-settled", { instance, outcome: "ok" });
  };
  /**
   * Start this subagent's next ask. Cache hits settle immediately, then look at the one after;
   * only genuinely-runnable asks queue.
   * Serial here means: a subagent has at most one ask in the queue or running at any moment.
   */
  const beginNextAsk = (agent: EngineAgent, queue: EngineAgent[]): void => {
    while (agent.done < agent.asks) {
      if (random() < shape.cachedRate) {
        settleCached(agent, agent.phaseName, true);
        agent.done += 1;
        continue;
      }
      queueAsk(agent);
      queue.push(agent);
      return;
    }
  };

  emit("run-started", {});
  let agentNumber = 0;
  let settles = 0;
  let interrupted = false;
  /** Every subagent of each phase, in birth order: the second life's replayed prefix must walk it again verbatim. */
  const roster: EngineAgent[][] = [];
  for (let phase = 1; phase <= shape.phases; phase += 1) {
    const phaseName = `p${phase}`;
    emit("phase-entered", { name: phaseName, ordinal: 1 });
    const agents: EngineAgent[] = [];
    roster.push(agents);
    // Create **all** of this phase's actors first: the incident's 2000 actor-created events were
    // fired in one burst right here.
    for (let index = 0; index < shape.agentsPerPhase; index += 1) {
      agentNumber += 1;
      const agent: EngineAgent = {
        index: agentNumber,
        phaseName,
        asks: 1 + Math.floor(random() * shape.maxAsks),
        done: 0,
      };
      agents.push(agent);
      maybeReplay(
        emit(
          "actor-created",
          { actor: actorRef(agent.index), name: `a${agent.index}`, phaseName },
          { actorSessionId: `sess-${agent.index}` },
        ),
      );
    }
    // Then queue **all** first asks, none dispatched yet: the table is full at this instant, with
    // not one terminal entry.
    const queue: EngineAgent[] = [];
    for (const agent of agents) beginNextAsk(agent, queue);
    const running: EngineAgent[] = [];
    while (queue.length > 0 || running.length > 0) {
      while (running.length < shape.concurrency && queue.length > 0) {
        const agent = queue.shift()!;
        dispatchAsk(agent);
        running.push(agent);
      }
      if (random() < 0.2) worldRead(phaseName);
      const agent = running.splice(Math.floor(random() * running.length), 1)[0]!;
      emit("node-settled", {
        instance: askInstance(agent),
        outcome: pick(["ok", "ok", "ok", "failed", "cancelled"]),
      });
      agent.done += 1;
      settles += 1;
      // The user pressed stop: in-flight asks and queued ones stay where they are; the script
      // does not advance.
      if (shape.interruptAfter > 0 && settles >= shape.interruptAfter) {
        interrupted = true;
        break;
      }
      beginNextAsk(agent, queue);
    }
    if (interrupted) break;
  }
  if (!interrupted) return envelopes;

  // ── Second life (resume). An overflowed run restarts from an empty table and the script reruns
  // in full: each phase's actors are all re-created, finished asks get a cached settle (the old
  // shape without the actor lands as a loose node leaving the subagent with not a single listed
  // node; the new shape with it lands as one of its settled nodes), unfinished asks re-queue, and
  // dispatching proceeds as before.
  emit("run-started", {});
  for (const agents of roster) {
    const phaseName = agents[0]!.phaseName;
    emit("phase-entered", { name: phaseName, ordinal: 1 });
    for (const agent of agents) {
      maybeReplay(
        emit(
          "actor-created",
          { actor: actorRef(agent.index), name: `a${agent.index}`, phaseName },
          { actorSessionId: `sess-${agent.index}` },
        ),
      );
    }
    const queue: EngineAgent[] = [];
    for (const agent of agents) {
      const replayed = agent.done;
      agent.done = 0;
      for (; agent.done < replayed; agent.done += 1) settleCached(agent, phaseName, false);
      beginNextAsk(agent, queue);
    }
    const running: EngineAgent[] = [];
    while (queue.length > 0 || running.length > 0) {
      while (running.length < shape.concurrency && queue.length > 0) {
        const agent = queue.shift()!;
        dispatchAsk(agent);
        running.push(agent);
      }
      if (random() < 0.2) worldRead(phaseName);
      const agent = running.splice(Math.floor(random() * running.length), 1)[0]!;
      emit("node-settled", {
        instance: askInstance(agent),
        outcome: pick(["ok", "ok", "ok", "failed", "cancelled"]),
      });
      agent.done += 1;
      beginNextAsk(agent, queue);
    }
  }
  return envelopes;
}

/**
 * The number of entries the table could currently yield for one newcomer. Legal rejection
 * requires this to be 0 — the only exemption I7 / I8 allow.
 *
 * Two kinds of missing slot must be counted separately, because their victims are different
 * things:
 *   - Missing an **actor slot** (this subagent is not on the table, actor table full): only a
 *     whole row can free an actor slot — non-live groups and zero-node actors; loose nodes and
 *     the newcomer's own nodes cannot. The exemption therefore tightens to "every listed actor is
 *     running".
 *   - Only a **node slot** is missing: the newcomer's own settled nodes count first (dropping one
 *     costs a row of history, the badge stays), then settled loose nodes, and only then other
 *     groups' — a zero-node actor cannot help here; what it frees is an actor slot.
 */
function spareRoomFor(
  run: WorkflowRunState,
  instance: { siteId: string; ordinal: number },
  owner: { siteId: string; ordinal: number },
  limits: WorkflowRunEntryLimits,
): number {
  const ownerKey = entryKey(owner);
  let groups = 0;
  let zeroNode = 0;
  for (const actor of run.actors) {
    if (entryKey(actor) === ownerKey) continue;
    const owned = nodesOfActor(run, actor);
    if (owned.length === 0) {
      zeroNode += 1;
      continue;
    }
    // Any non-live group may yield: fully settled (work done) or still queued (waiting for a
    // slot).
    if (owned.every((node) => node.phase === "settled" || node.phase === "queued")) groups += 1;
  }
  const needsActorSlot = !actorKeySet(run).has(ownerKey) && run.actors.length >= limits.maxActors;
  if (needsActorSlot) return groups + zeroNode;
  if (nodeKeySet(run).has(entryKey(instance)) || run.nodes.length < limits.maxNodes) return 1;
  let rows = 0;
  for (const node of run.nodes) {
    if (node.phase !== "settled") continue;
    const loose = node.actorSiteId === undefined;
    const own = node.actorSiteId === owner.siteId && node.actorOrdinal === owner.ordinal;
    if (loose || own) rows += 1;
  }
  return groups + rows;
}

/** Everything one generated-stream run must assert. */
interface EngineCase extends Omit<EngineShape, "cachedNamesActor"> {
  seed: number;
  limits: WorkflowRunEntryLimits;
}

const ENGINE_CASES: readonly EngineCase[] = [
  // The incident's proportions (concurrency far below the table limits).
  {
    seed: 2,
    phases: 2,
    agentsPerPhase: 12,
    concurrency: 3,
    cachedRate: 0,
    interruptAfter: 0,
    maxAsks: 3,
    limits: { maxActors: 6, maxNodes: 12, maxPhases: 3 },
  },
  // The node limit is so tight that not even 3 × concurrency fits: running subagents sit on
  // their own settled history, and only the "drop your own first" rule can free the slots.
  // Before that rule, this limit set would push the 3 running subagents off the table.
  {
    seed: 13,
    phases: 3,
    agentsPerPhase: 10,
    concurrency: 5,
    cachedRate: 0,
    interruptAfter: 0,
    maxAsks: 3,
    limits: { maxActors: 7, maxNodes: 9, maxPhases: 4 },
  },
  // The live incident run's concurrency (13) and its proportions (far more subagents than table
  // slots).
  {
    seed: 71,
    phases: 2,
    agentsPerPhase: 30,
    concurrency: 13,
    cachedRate: 0,
    interruptAfter: 0,
    maxAsks: 3,
    limits: { maxActors: 20, maxNodes: 45, maxPhases: 3 },
  },
  // Concurrency **above** the actor table limit: a table of all-live groups frees nothing, and
  // only now should the exemption apply.
  {
    seed: 404,
    phases: 2,
    agentsPerPhase: 14,
    concurrency: 9,
    cachedRate: 0,
    interruptAfter: 0,
    maxAsks: 3,
    limits: { maxActors: 5, maxNodes: 7, maxPhases: 2 },
  },
  // Completion-cache hits interleaved: born-settled loose nodes + a batch of actors with no
  // listed nodes at all.
  {
    seed: 909,
    phases: 3,
    agentsPerPhase: 9,
    concurrency: 6,
    cachedRate: 0.25,
    interruptAfter: 0,
    maxAsks: 3,
    limits: { maxActors: 8, maxNodes: 10, maxPhases: 4 },
  },
  // Two lives: the first cut off halfway, the second replays the whole prefix — all actors
  // re-created + cache settles without the actor, so the actor table fills first with a batch of
  // **zero-node** actors. Without the zero-node tier, every second-life dispatch would be
  // rejected.
  {
    seed: 5_150,
    phases: 2,
    agentsPerPhase: 12,
    concurrency: 4,
    cachedRate: 0,
    interruptAfter: 8,
    // One ask per agent: the 8 settled in the first life are **fully done** in the second, so the
    // replay only gives them a cache settle without the actor — the actor table therefore fills
    // with zero-node actors, with no group to yield.
    maxAsks: 1,
    limits: { maxActors: 6, maxNodes: 8, maxPhases: 3 },
  },
];

describe("不变量 I1–I9（引擎形状：先建全部 actor、再入队、FIFO 派活）", () => {
  const CACHE_SHAPES = [
    { cachedNamesActor: true, label: "缓存结算带出生事实" },
    { cachedNamesActor: false, label: "老 journal：缓存结算不带 actor" },
  ] as const;
  const CASES = CACHE_SHAPES.flatMap(({ cachedNamesActor, label }) =>
    ENGINE_CASES.map((engineCase) => ({ shape: { ...engineCase, cachedNamesActor }, label })),
  );
  for (const { shape, label } of CASES) {
    const { seed, limits } = shape;
    it(`seed ${seed}（并发 ${shape.concurrency} / actor 界 ${limits.maxActors}，${label}）：两张账都对得上`, () => {
      const envelopes = generateEngineLife(seed, shape);
      let state: WorkflowRunsState | undefined;
      const bornNodes = new Set<string>();
      const settledNodes = new Set<string>();
      const bornAgents = new Set<string>();
      const everListed = new Set<string>();
      /** Currently running instance → its actor key (world-read records null). */
      const live = new Map<string, string | null>();
      /** Instances that had no slot at the moment of dispatch: I8 exempts them, same reason as I7. */
      const homeless = new Set<string>();
      const steps: ReducedStep[] = [];
      let activations = 0;
      let truncatedAt = -1;

      for (const [step, envelope] of envelopes.entries()) {
        const priorRun = state?.runs[0];
        const advanced = envelope.sequence! > (priorRun?.lastEventSequence ?? -1);
        const payload = envelope.payload as Record<string, unknown>;
        const instance = payload.instance as { siteId: string; ordinal: number } | undefined;
        const actor = payload.actor as { siteId: string; ordinal: number } | undefined;

        const next = reduceWorkflowRunsState(state, envelope, limits);
        // I5 (first half): replaying a just-reduced event is a complete no-op.
        if (next !== null) {
          expect(reduceWorkflowRunsState(next, envelope, limits)).toBeNull();
        }
        const run = (next ?? state)!.runs[0]!;

        // A new life: an overflowed run restarts from an empty table, so these local ledgers also
        // restart. I4 compares against the instances born **this life**, and run-started is
        // exactly the event that zeroes the two counters.
        if (envelope.eventType === "run-started" && advanced) {
          bornNodes.clear();
          settledNodes.clear();
          bornAgents.clear();
          everListed.clear();
          live.clear();
          homeless.clear();
        }

        if (envelope.eventType === "actor-created" && actor !== undefined) {
          bornAgents.add(entryKey(actor));
        }
        if (instance !== undefined) {
          const key = entryKey(instance);
          if (envelope.eventType === "node-queued" || payload.cached === true) bornNodes.add(key);
          if (envelope.eventType === "node-settled") {
            settledNodes.add(key);
            live.delete(key);
          }
          // Only subagent asks count: a world-read has no owner and draws no badge; I8 is about
          // "running subagents".
          if (envelope.eventType === "node-dispatched" && actor !== undefined) {
            live.set(key, entryKey(actor));
          }
        }

        // I1: both tables stay within the limits.
        expect(run.actors.length).toBeLessThanOrEqual(limits.maxActors);
        expect(run.nodes.length).toBeLessThanOrEqual(limits.maxNodes);

        // I2: a departed node can only be settled or still queued; a departed actor has not a
        // single **running** node under it.
        // `run-started` is exempt: an overflowed run's new life restarts from an **empty** table —
        // that is a reset, not an eviction.
        if (priorRun !== undefined && envelope.eventType !== "run-started") {
          const keptNodes = nodeKeySet(run);
          const keptActors = actorKeySet(run);
          for (const node of priorRun.nodes) {
            if (keptNodes.has(entryKey(node))) continue;
            expect(["settled", "queued"]).toContain(node.phase);
          }
          for (const actor_ of priorRun.actors) {
            if (keptActors.has(entryKey(actor_))) continue;
            for (const node of nodesOfActor(priorRun, actor_)) {
              expect(["settled", "queued"]).toContain(node.phase);
            }
          }
        }

        // I3: an actor that ever listed a node never drops to zero nodes.
        for (const actor_ of run.actors) {
          const key = entryKey(actor_);
          if (nodesOfActor(run, actor_).length > 0) {
            everListed.add(key);
            continue;
          }
          expect(everListed.has(key)).toBe(false);
        }

        // I7: after a dispatch with facts, the instance and its subagent are both on the table —
        // unless at that instant the table held not a single yieldable group (all groups running,
        // or actors with no listed node at all).
        if (
          envelope.eventType === "node-dispatched" &&
          advanced &&
          instance !== undefined &&
          actor !== undefined
        ) {
          const nodeListed = nodeKeySet(run).has(entryKey(instance));
          const actorListed = actorKeySet(run).has(entryKey(actor));
          if (nodeListed && actorListed) {
            if (!nodeKeySet(priorRun ?? run).has(entryKey(instance))) activations += 1;
          } else {
            expect(spareRoomFor(priorRun!, instance, actor, limits)).toBe(0);
            homeless.add(entryKey(instance));
          }
        }

        // I9: a listed node naming a subagent must have that subagent on the table too. The
        // converse is a row that can never be evicted (it is not a loose node, and groups are
        // built from listed actors) — after cached settles re-send the actor ref, B2 must reject
        // it along with the node, otherwise this row would pin a node slot forever in an
        // overflowed run.
        for (const node of run.nodes) {
          if (node.actorSiteId === undefined || node.actorOrdinal === undefined) continue;
          expect(
            actorKeySet(run).has(
              entryKey({ siteId: node.actorSiteId, ordinal: node.actorOrdinal }),
            ),
          ).toBe(true);
        }

        // I8: every currently running instance (and its subagent) is on the table; exemption same
        // as I7.
        const listedNodes = nodeKeySet(run);
        const listedActors = actorKeySet(run);
        for (const [key, owner] of live) {
          if (homeless.has(key)) continue;
          expect(listedNodes.has(key)).toBe(true);
          expect(listedActors.has(owner)).toBe(true);
        }

        // I6: every bucket always satisfies actorsFailed ≤ actorsSettled ≤ actors (clamping is
        // this bucket's law),
        // and Σ actors is exactly the number of subagents "born but not currently on the table" —
        // no buckets before the overflow; after it, every rejection, eviction, and return to the
        // table must reconcile.
        for (const bucket of run.unlistedByPhase ?? []) {
          expect(bucket.actorsFailed ?? 0).toBeLessThanOrEqual(bucket.actorsSettled ?? 0);
          expect(bucket.actorsSettled ?? 0).toBeLessThanOrEqual(bucket.actors);
        }
        if (run.truncated === true && truncatedAt < 0) truncatedAt = step;
        const attributedActors = (run.unlistedByPhase ?? []).reduce(
          (sum, bucket) => sum + bucket.actors,
          0,
        );
        let unlistedAgents = 0;
        for (const key of bornAgents) if (!listedActors.has(key)) unlistedAgents += 1;
        expect(attributedActors).toBe(unlistedAgents);

        if (next === null) continue;
        // diff contract: applying the deltas to prior is byte-for-byte identical to next.
        const deltas = diffWorkflowRunsState(state, next);
        for (const delta of deltas) {
          expect(conversationDeltaSchema.safeParse(delta).success).toBe(true);
        }
        const applied = applyConversationDeltas(snapshotWith(state), deltas);
        expect(JSON.stringify(applied.workflowRuns)).toBe(JSON.stringify(next));
        expect(workflowRunsStateSchema.safeParse(next).success).toBe(true);
        steps.push({ prior: state, deltas });
        state = next;
      }

      const run = state!.runs[0]!;
      // This stream really crossed the limits, and really exercised the dispatch-reinstates path.
      expect(truncatedAt).toBeGreaterThan(0);
      expect(activations).toBeGreaterThan(0);
      // I4: in-table + unlisted = the instances born this life; settled likewise.
      expect(run.nodes.length + (run.usage.nodesUnlisted ?? 0)).toBe(bornNodes.size);
      expect(workflowRunStepCounts(run)).toEqual({
        total: bornNodes.size,
        settled: settledNodes.size,
      });

      // I5 (other half): cold-replaying the same event stream yields a byte-for-byte identical
      // state.
      let replayed: WorkflowRunsState | undefined;
      for (const envelope of envelopes) {
        replayed = reduceWorkflowRunsState(replayed, envelope, limits) ?? replayed;
      }
      expect(JSON.stringify(replayed)).toBe(JSON.stringify(state));

      expectCoalesceEquivalence(steps, seed);
    });
  }
});

// The subagent model (docs/dynamic-workflow/presentation.md "Reduction"): `actor-created`'s
// `model`, plus `node-dispatched`'s `actorModel` on the dispatch-reinstates path — the two birth
// paths grow the same entry.
describe("子代理的模型", () => {
  it("actor-created 带 model 即落进条目；超界整个丢掉，不截断", () => {
    const driven = driver({ maxActors: 3, maxNodes: 3, maxPhases: 2 });
    driven.send("actor-created", { actor: actorRef(1), name: "a1", model: "zhipu/GLM-5.3$high" });
    driven.send("actor-created", {
      actor: actorRef(2),
      name: "a2",
      model: "x".repeat(WORKFLOW_RUNS_LIMITS.maxSubagentModelLength + 1),
    });
    driven.send("actor-created", { actor: actorRef(3), name: "a3" });
    expect(driven.run.actors.map((actor) => actor.model)).toEqual([
      "zhipu/GLM-5.3$high",
      undefined,
      undefined,
    ]);
    expect(workflowRunsStateSchema.safeParse(driven.state).success).toBe(true);
  });

  it("被拒的子代理在派发时回到表上，带着 actorModel", () => {
    const driven = driver({ maxActors: 2, maxNodes: 2, maxPhases: 2 });
    // All three subagents carry a model; the third is rejected at birth with the table full,
    // together with its `model`.
    for (let index = 1; index <= 3; index += 1) {
      driven.send(
        "actor-created",
        {
          actor: actorRef(index),
          name: `a${index}`,
          phaseName: "p1",
          model: "zhipu/GLM-5.3-Flash",
        },
        { actorSessionId: `sess-${index}` },
      );
      driven.send("node-queued", {
        instance: askRef(index),
        kind: "ask",
        actor: actorRef(index),
        phaseName: "p1",
      });
    }
    expect(actorKeys(driven.run)).toEqual(["actor#1", "actor#2"]);
    dispatchWithFacts(driven, 1, { phaseName: "p1" });
    driven.send("node-settled", { instance: askRef(1), outcome: "ok" });
    dispatchWithFacts(driven, 2, { phaseName: "p1" });
    driven.send("node-settled", { instance: askRef(2), outcome: "ok" });

    driven.send(
      "node-dispatched",
      {
        instance: askRef(3),
        kind: "ask",
        actor: actorRef(3),
        actorName: "a3",
        actorPhaseName: "p1",
        actorPersonaModel: "GLM-5.3-Flash",
        actorModel: "zhipu/GLM-5.3-Flash",
        phaseName: "p1",
      },
      { actorSessionId: "sess-3" },
    );
    expect(driven.run.actors.at(-1)).toMatchObject({
      siteId: "actor#3",
      name: "a3",
      model: "zhipu/GLM-5.3-Flash",
    });
  });

  it("已在表上的子代理：派发不改写它的条目", () => {
    const driven = driver({ maxActors: 3, maxNodes: 3, maxPhases: 2 });
    driven.send("actor-created", { actor: actorRef(1), name: "a1", model: "zhipu/GLM-5.3" });
    driven.send("node-queued", { instance: askRef(1), kind: "ask", actor: actorRef(1) });
    driven.send("node-dispatched", {
      instance: askRef(1),
      kind: "ask",
      actor: actorRef(1),
      actorName: "a1",
    });
    expect(driven.run.actors[0]?.model).toBe("zhipu/GLM-5.3");
  });
});

// Key-level deltas for workflowRuns (workflow-runs-delta.ts + the two ops in delta.ts + apply's two twins).
//
// This file pins **one** contract; all other assertions serve it: for any reducer-produced (prior, next) pair,
//   JSON.stringify(apply(snapshot with prior, diff(prior, next)).workflowRuns) === JSON.stringify(next)
// byte-for-byte, not deep-equal — if key order differed, the desktop's and CLI's two copies of state would silently
// diverge elsewhere (snapshot hashes, replay comparisons), and such divergence only looks like "an occasional refresh".
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_RUNS_LIMITS,
  WORKFLOW_RUN_HEADER_KEYS,
  applyConversationDeltas,
  applyConversationDeltasMutable,
  canonicalWorkflowRun,
  coalesceConversationDeltas,
  conversationDeltaSchema,
  createMutableConversationSnapshotAccumulator,
  diffWorkflowRunsState,
  isCompleteWorkflowRunHeader,
  reduceWorkflowRunsState,
  workflowRunSchema,
  workflowRunsStateSchema,
  type ConversationDelta,
  type ConversationSnapshot,
  type WorkflowRunProgressEnvelope,
  type WorkflowRunState,
  type WorkflowRunsState,
} from "../src/zcode-protocol-v4/index.js";

const RUN_ID = "dwfrun-1";

/**
 * Contains only the two spots apply touches: the rows window (the mutable accumulator reads it to build its index) and the state key.
 * The other fields are irrelevant to this file's contract; writing them all out would drown the real assertions in fixtures.
 */
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

/** Event envelope factory: sequence auto-increments per call, mimicking the journal's monotonic assignment (same idiom as the reducer tests). */
function progressLog(runId = RUN_ID) {
  let sequence = -1;
  return function progress(
    eventType: string,
    payload: Record<string, unknown> = {},
    extra: Partial<WorkflowRunProgressEnvelope> = {},
  ): WorkflowRunProgressEnvelope {
    sequence += 1;
    return { runId, toolCallId: "tc-1", sequence, eventType, payload, ...extra };
  };
}

const ASK = { siteId: "ask#1", ordinal: 1 };
const ACTOR = { siteId: "actor#1", ordinal: 1 };

/**
 * One run that walks the full lifecycle: birth, phases, subagents, all node phases, progress readings, usage, a report,
 * an artifact, an escalation (`cleared` path's only source: pendingQuestions drops to zero so the whole key goes absent),
 * a cache-hit settle, a second subagent, and the terminal state.
 */
function fullRunEvents(): WorkflowRunProgressEnvelope[] {
  const progress = progressLog();
  return [
    progress("run-started", {
      caps: { maxConcurrency: 2 },
      concurrencyCeiling: 8,
      subagentModel: "glm/glm-5",
      resumedFrom: "dwfrun-0",
    }),
    progress("run-launched", { phaseNames: ["调研", "实现"], phaseAlongside: [[1], [0]] }),
    progress("phase-entered", { name: "调研", ordinal: 1 }),
    progress(
      "actor-created",
      { actor: ACTOR, name: "reader", phaseName: "调研" },
      { actorSessionId: "sess_dwf-1-actor.1" },
    ),
    progress("node-queued", {
      instance: ASK,
      kind: "ask",
      actor: ACTOR,
      instructionsHead: "读一遍 a.ts",
      phaseName: "调研",
    }),
    progress("node-dispatched", { instance: ASK }),
    progress("node-executing", { instance: ASK }),
    progress("node-progress", {
      instance: ASK,
      turn: 2,
      toolCalls: 3,
      lastTool: { name: "Read", target: "a.ts" },
    }),
    progress("node-waiting", { instance: ASK }),
    progress("usage-updated", { spentTokens: 1_200 }),
    progress("report", { instance: { siteId: "report#1", ordinal: 1 }, item: "第一条发现" }),
    progress("artifact-published", {
      artifact: { id: "art-1", kind: "markdown", version: 1, title: "报告" },
    }),
    progress("escalation-raised", {
      qid: "dwfq-1",
      actor: ACTOR,
      actorName: "reader",
      question: "门是不是坏了？",
      askedAt: 1_756_000_000_000,
    }),
    // Striking the last parked question → the whole key goes absent; this is diff's `cleared` path.
    progress("escalation-resolved", { qid: "dwfq-1", answer: "坏了，跳过。" }),
    progress("node-settled", { instance: ASK, outcome: "ok" }),
    // Resume's completed-hit short-circuit: straight to settled, never through queued, and it is this node's birth event.
    progress("node-settled", {
      instance: { siteId: "world-read#1", ordinal: 1 },
      outcome: "ok",
      cached: true,
    }),
    progress("phase-entered", { name: "实现", ordinal: 1 }),
    progress(
      "actor-created",
      { actor: { siteId: "actor#2", ordinal: 1 }, name: "writer", phaseName: "实现" },
      { actorSessionId: "sess_dwf-1-actor.2" },
    ),
    progress("node-queued", {
      instance: { siteId: "ask#2", ordinal: 1 },
      kind: "ask",
      actor: { siteId: "actor#2", ordinal: 1 },
    }),
    progress("node-dispatched", { instance: { siteId: "ask#2", ordinal: 1 } }),
    progress("concurrency-changed", { key: "glm/glm-5", previous: 8, next: 3, reason: "backoff" }),
    progress("usage-updated", { spentTokens: 4_800 }),
    progress("node-settled", { instance: { siteId: "ask#2", ordinal: 1 }, outcome: "failed" }),
    progress("run-settled", { status: "completed" }),
  ];
}

/** A second run's minimal lifecycle: two runs coexist in one state; diff may only touch the changed one. */
function secondRunEvents(): WorkflowRunProgressEnvelope[] {
  const progress = progressLog("dwfrun-2");
  return [
    progress("run-started", { caps: { maxConcurrency: 1 } }),
    progress("actor-created", { actor: ACTOR, name: "planner" }),
    progress("node-queued", { instance: ASK, kind: "ask", actor: ACTOR }),
    progress("node-dispatched", { instance: ASK }),
    progress("run-settled", { status: "stopped", stopReason: "user", resumable: true }),
  ];
}

/** Squeezes out the oldest runs: maxRuns + 2 new runs, each with one run-started. */
function evictionEvents(): WorkflowRunProgressEnvelope[] {
  return Array.from({ length: WORKFLOW_RUNS_LIMITS.maxRuns + 2 }, (_, index) => ({
    runId: `dwfrun-evict-${index}`,
    sequence: 0,
    eventType: "run-started",
    payload: { caps: { maxConcurrency: 1 } },
  }));
}

/**
 * Contract referee: reduce one by one, and at each step push prior to next with the diff's deltas; both apply twins must
 * yield workflowRuns **byte-identical** to next. Returns every delta produced so callers can assert further.
 */
function expectRoundTrip(envelopes: readonly WorkflowRunProgressEnvelope[]): ConversationDelta[] {
  let state: WorkflowRunsState | undefined;
  const all: ConversationDelta[] = [];
  for (const envelope of envelopes) {
    const next = reduceWorkflowRunsState(state, envelope);
    if (next === null) continue;
    const deltas = diffWorkflowRunsState(state, next);
    all.push(...deltas);
    const prior = snapshotWith(state);

    const immutable = applyConversationDeltas(prior, deltas);
    expect(JSON.stringify(immutable.workflowRuns)).toBe(JSON.stringify(next));

    const accumulator = createMutableConversationSnapshotAccumulator(prior);
    applyConversationDeltasMutable(accumulator, deltas);
    expect(JSON.stringify(accumulator.snapshot.workflowRuns)).toBe(JSON.stringify(next));

    // Deltas must not be able to assemble an illegal state: the client-side product also passes the strict schema.
    expect(workflowRunsStateSchema.safeParse(immutable.workflowRuns).success).toBe(true);
    state = next;
  }
  return all;
}

describe("diffWorkflowRunsState × apply：逐事件往返", () => {
  it("一条走完全程的 run：每一步的终态逐字节一致", () => {
    const deltas = expectRoundTrip(fullRunEvents());
    // Not a single whole-key resend on the way — one would mean diff failed to recognize some structural change and byte counts regressed to pre-rework levels.
    expect(deltas.some((delta) => delta.op === "state.updated")).toBe(false);
  });

  it("两条 run 并存 + 最旧淘汰：淘汰说得出口（workflowRun.removed）", () => {
    const deltas = expectRoundTrip([...fullRunEvents(), ...secondRunEvents(), ...evictionEvents()]);
    expect(deltas.some((delta) => delta.op === "state.updated")).toBe(false);
    const removed = deltas.filter((delta) => delta.op === "workflowRun.removed");
    // Two old runs + maxRuns + 2 new runs arrive; the four oldest are squeezed out in arrival order.
    expect(removed.map((delta) => (delta.op === "workflowRun.removed" ? delta.runId : ""))).toEqual(
      [RUN_ID, "dwfrun-2", "dwfrun-evict-0", "dwfrun-evict-1"],
    );
  });

  it("停驻问题清零走 cleared（「零条 ⇒ 键缺席」的键必须说得出它没了）", () => {
    const progress = progressLog();
    const raised = reduceWorkflowRunsState(
      reduceWorkflowRunsState(undefined, progress("run-started", { caps: { maxConcurrency: 1 } })),
      progress("escalation-raised", { qid: "dwfq-1", question: "门坏了吗？" }),
    )!;
    const resolved = reduceWorkflowRunsState(
      raised,
      progress("escalation-resolved", { qid: "dwfq-1", answer: "坏了" }),
    )!;
    const deltas = diffWorkflowRunsState(raised, resolved);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ op: "workflowRun.updated", cleared: ["pendingQuestions"] });
    const applied = applyConversationDeltas(snapshotWith(raised), deltas);
    expect(applied.workflowRuns?.runs[0]).not.toHaveProperty("pendingQuestions");
    expect(JSON.stringify(applied.workflowRuns)).toBe(JSON.stringify(resolved));
  });

  it("一条节点事件只搬这条节点：增量里不出现没动过的条目", () => {
    const progress = progressLog();
    let state = reduceWorkflowRunsState(undefined, progress("run-started", {}))!;
    for (let ordinal = 1; ordinal <= 20; ordinal += 1) {
      state = reduceWorkflowRunsState(
        state,
        progress("node-queued", { instance: { siteId: "ask#1", ordinal }, kind: "ask" }),
      )!;
    }
    const next = reduceWorkflowRunsState(
      state,
      progress("node-dispatched", { instance: { siteId: "ask#1", ordinal: 7 } }),
    )!;
    const deltas = diffWorkflowRunsState(state, next);
    expect(deltas).toHaveLength(1);
    const op = deltas[0]!;
    expect(op.op).toBe("workflowRun.updated");
    if (op.op !== "workflowRun.updated") return;
    expect(op.nodes).toEqual([{ siteId: "ask#1", ordinal: 7, kind: "ask", phase: "dispatched" }]);
    expect(op.actors).toBeUndefined();
    // Dispatch step-counting changed usage, so the header carries only this key + the watermark.
    expect(Object.keys(op.run ?? {}).sort()).toEqual(["lastEventSequence", "usage"]);
  });

  // Deletion has a vocabulary (removedActors / removedNodes, used for making room), **reordering does not**. So the first
  // input below takes the keyed path and the second can only fall back to a whole-key resend — the round-trip cases above
  // assert "not a single state.updated on the way"; the day someone makes the reducer reorder entries, those turn red immediately.
  it("条目被删走键化路径，被重排则退回整键重发", () => {
    const state = expectRoundTripFinal(fullRunEvents());
    const run = state.runs[0]!;
    const shortened: WorkflowRunsState = {
      revision: state.revision + 1,
      runs: [{ ...run, nodes: run.nodes.slice(0, -1) }],
    };
    expect(diffWorkflowRunsState(state, shortened)).toEqual([
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: shortened.revision,
        removedNodes: [{ siteId: run.nodes.at(-1)!.siteId, ordinal: run.nodes.at(-1)!.ordinal }],
      },
    ]);
    expect(
      JSON.stringify(
        applyConversationDeltas(snapshotWith(state), diffWorkflowRunsState(state, shortened))
          .workflowRuns,
      ),
    ).toBe(JSON.stringify(shortened));

    const reordered: WorkflowRunsState = {
      revision: state.revision + 1,
      runs: [{ ...run, nodes: [...run.nodes].reverse() }],
    };
    expect(diffWorkflowRunsState(state, reordered)).toEqual([
      { op: "state.updated", patch: { workflowRuns: reordered } },
    ]);
    // The fallback itself stays correct: byte-identical after the whole-key replacement.
    const applied = applyConversationDeltas(
      snapshotWith(state),
      diffWorkflowRunsState(state, reordered),
    );
    expect(JSON.stringify(applied.workflowRuns)).toBe(JSON.stringify(reordered));
  });

  it("冷启动（客户端还没有这个键）：整条 header + 全部条目的诞生增量", () => {
    const state = expectRoundTripFinal(fullRunEvents());
    const deltas = diffWorkflowRunsState(undefined, state);
    expect(deltas).toHaveLength(1);
    const op = deltas[0]!;
    if (op.op !== "workflowRun.updated") throw new Error("诞生必须是一条 workflowRun.updated");
    expect(isCompleteWorkflowRunHeader(op.run)).toBe(true);
    expect(op.nodes).toHaveLength(state.runs[0]!.nodes.length);
    const applied = applyConversationDeltas(snapshotWith(undefined), deltas);
    expect(JSON.stringify(applied.workflowRuns)).toBe(JSON.stringify(state));
  });
});

/** Runs the full event sequence and returns the final state (the round-trip assertions live in expectRoundTrip; only the state is needed here). */
function expectRoundTripFinal(
  envelopes: readonly WorkflowRunProgressEnvelope[],
): WorkflowRunsState {
  let state: WorkflowRunsState | undefined;
  for (const envelope of envelopes) state = reduceWorkflowRunsState(state, envelope) ?? state;
  return state!;
}

describe("coalesce 规则 6 × diff 产出的真实增量", () => {
  /** Interleaves two runs' events into one flush window and collects every delta step-wise diffing produces. */
  function windowOf(...streams: readonly WorkflowRunProgressEnvelope[][]): {
    deltas: ConversationDelta[];
    final: WorkflowRunsState;
  } {
    const interleaved: WorkflowRunProgressEnvelope[] = [];
    const longest = Math.max(...streams.map((stream) => stream.length));
    for (let index = 0; index < longest; index += 1) {
      for (const stream of streams) {
        const envelope = stream[index];
        if (envelope !== undefined) interleaved.push(envelope);
      }
    }
    let state: WorkflowRunsState | undefined;
    const deltas: ConversationDelta[] = [];
    for (const envelope of interleaved) {
      const next = reduceWorkflowRunsState(state, envelope);
      if (next === null) continue;
      deltas.push(...diffWorkflowRunsState(state, next));
      state = next;
    }
    return { deltas, final: state! };
  }

  it("合并前后终态逐字节一致，且每条 run 在窗口里塌成一条增量", () => {
    const { deltas, final } = windowOf(fullRunEvents(), secondRunEvents());
    const base = snapshotWith(undefined);
    const direct = applyConversationDeltas(base, deltas);
    const coalesced = coalesceConversationDeltas(deltas);
    expect(JSON.stringify(applyConversationDeltas(base, coalesced).workflowRuns)).toBe(
      JSON.stringify(direct.workflowRuns),
    );
    // One-by-one delivery should converge to the reducer's final state anyway; coalescing is merely forbidden from changing it.
    expect(JSON.stringify(direct.workflowRuns)).toBe(JSON.stringify(final));
    // Collapse: dozens of engine events → one delta per run, independent of fan-out width (the origin of the 500-frame bound).
    expect(deltas.length).toBeGreaterThan(20);
    expect(coalesced).toHaveLength(2);
  });

  it("窗口里夹着整键重发的屏障时，屏障两侧各自塌缩且终态不变", () => {
    const { deltas, final } = windowOf(fullRunEvents(), secondRunEvents());
    const half = Math.floor(deltas.length / 2);
    const midpoint = applyConversationDeltas(
      snapshotWith(undefined),
      deltas.slice(0, half),
    ).workflowRuns!;
    const withBarrier: ConversationDelta[] = [
      ...deltas.slice(0, half),
      { op: "state.updated", patch: { workflowRuns: midpoint } },
      ...deltas.slice(half),
    ];
    const base = snapshotWith(undefined);
    const direct = applyConversationDeltas(base, withBarrier);
    const coalesced = coalesceConversationDeltas(withBarrier);
    expect(JSON.stringify(applyConversationDeltas(base, coalesced).workflowRuns)).toBe(
      JSON.stringify(direct.workflowRuns),
    );
    expect(JSON.stringify(direct.workflowRuns)).toBe(JSON.stringify(final));
    expect(coalesced.filter((delta) => delta.op === "state.updated")).toHaveLength(1);
  });

  it("淘汰吞掉同 run 此前的增量，终态仍与逐条投递一致", () => {
    const { deltas, final } = windowOf(fullRunEvents(), secondRunEvents(), evictionEvents());
    const base = snapshotWith(undefined);
    const direct = applyConversationDeltas(base, deltas);
    const coalesced = coalesceConversationDeltas(deltas);
    expect(JSON.stringify(applyConversationDeltas(base, coalesced).workflowRuns)).toBe(
      JSON.stringify(direct.workflowRuns),
    );
    expect(JSON.stringify(direct.workflowRuns)).toBe(JSON.stringify(final));
    // The evicted run: deltas before the barrier are swallowed cleanly (birth + eviction in one window = the client never saw it). One more
    // delta may appear after the barrier — a late event brings this runId back as a **new entry** at the tail; that is a different matter and must not be swallowed.
    const removedAt = coalesced.findIndex(
      (delta) => delta.op === "workflowRun.removed" && delta.runId === RUN_ID,
    );
    expect(removedAt).toBeGreaterThanOrEqual(0);
    const firstUpdate = coalesced.findIndex(
      (delta) => delta.op === "workflowRun.updated" && delta.runId === RUN_ID,
    );
    expect(firstUpdate === -1 || firstUpdate > removedAt).toBe(true);
  });
});

describe("apply：workflowRun.* 的边界语义", () => {
  const born: ConversationDelta = {
    op: "workflowRun.updated",
    runId: RUN_ID,
    revision: 3,
    run: {
      runId: RUN_ID,
      status: "running",
      usage: { spentTokens: 0, nodesUsed: 0 },
      lastEventSequence: 0,
    },
  };

  it("未知 run + 完整 header = 诞生；条目缺席按空表建", () => {
    const applied = applyConversationDeltas(snapshotWith(undefined), [born]);
    expect(applied.workflowRuns).toEqual({
      revision: 3,
      runs: [
        {
          runId: RUN_ID,
          status: "running",
          usage: { spentTokens: 0, nodesUsed: 0 },
          actors: [],
          nodes: [],
          lastEventSequence: 0,
        },
      ],
    });
    expect(workflowRunsStateSchema.safeParse(applied.workflowRuns).success).toBe(true);
  });

  it("未知 run + 残缺 header = 不建条目（与 row.upserted 命中未加载行同一条裁决）", () => {
    const applied = applyConversationDeltas(snapshotWith(undefined), [
      { op: "workflowRun.updated", runId: "dwfrun-ghost", revision: 5, run: { status: "running" } },
      { op: "workflowRun.updated", runId: "dwfrun-ghost", revision: 6, nodes: [ASK_NODE] },
    ]);
    expect(applied.workflowRuns?.runs).toEqual([]);
    // The container revision still keeps up: the producer's claim about the version and whether it can place this run are two different things.
    expect(applied.workflowRuns?.revision).toBe(6);
  });

  it("removed 命中未知 runId 只让 revision 跟上，不抛", () => {
    const seeded = applyConversationDeltas(snapshotWith(undefined), [born]);
    const applied = applyConversationDeltas(seeded, [
      { op: "workflowRun.removed", runId: "dwfrun-别的", revision: 9 },
    ]);
    expect(applied.workflowRuns?.runs.map((run) => run.runId)).toEqual([RUN_ID]);
    expect(applied.workflowRuns?.revision).toBe(9);
  });

  it("revision 取 max：合并后靠前的 op 携带靠后的 revision 也不会把容器版本拉回去", () => {
    const seeded = applyConversationDeltas(snapshotWith(undefined), [born]);
    const applied = applyConversationDeltas(seeded, [
      { op: "workflowRun.updated", runId: RUN_ID, revision: 12, run: { status: "completed" } },
      { op: "workflowRun.updated", runId: RUN_ID, revision: 7, run: { lastEventSequence: 4 } },
    ]);
    expect(applied.workflowRuns?.revision).toBe(12);
  });

  it("身份：没动过的 run 与条目保持引用，动过的那条 run 与容器是新对象", () => {
    const twoRuns = applyConversationDeltas(snapshotWith(undefined), [
      born,
      { ...born, runId: "dwfrun-2", run: { ...born.run, runId: "dwfrun-2" } } as ConversationDelta,
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 4,
        nodes: [ASK_NODE, { siteId: "ask#2", ordinal: 1, phase: "queued" }],
      },
    ]);
    const before = twoRuns.workflowRuns!;
    const after = applyConversationDeltas(twoRuns, [
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 5,
        nodes: [{ siteId: "ask#2", ordinal: 1, phase: "dispatched" }],
      },
    ]).workflowRuns!;

    expect(after).not.toBe(before);
    expect(after.runs[0]).not.toBe(before.runs[0]);
    // The other run and the untouched node inside the changed run keep their references — the GUI's two-level memo relies on exactly this.
    expect(after.runs[1]).toBe(before.runs[1]);
    expect(after.runs[0]!.nodes[0]).toBe(before.runs[0]!.nodes[0]);
    expect(after.runs[0]!.nodes[1]).not.toBe(before.runs[0]!.nodes[1]);
    // actors was not mentioned by this op: the whole table keeps its reference.
    expect(after.runs[0]!.actors).toBe(before.runs[0]!.actors);
  });

  it("客户端从不自行施加上界：maxRuns 之外的诞生照样落表（只有生产者淘汰，且必须说出来）", () => {
    const births = Array.from({ length: WORKFLOW_RUNS_LIMITS.maxRuns + 3 }, (_, index) => ({
      ...born,
      runId: `dwfrun-${index}`,
      revision: index + 1,
      run: { ...born.run, runId: `dwfrun-${index}` },
    })) as ConversationDelta[];
    const applied = applyConversationDeltas(snapshotWith(undefined), births);
    // Client-side trimming would only make the two sides silently diverge: runs the producer believes it sent would not exist here at all.
    expect(applied.workflowRuns?.runs).toHaveLength(WORKFLOW_RUNS_LIMITS.maxRuns + 3);
  });

  it("两个 apply twin 在 workflowRun.* 上逐字节等价", () => {
    const deltas: ConversationDelta[] = [
      born,
      { op: "workflowRun.updated", runId: RUN_ID, revision: 4, nodes: [ASK_NODE] },
      {
        op: "workflowRun.updated",
        runId: "dwfrun-2",
        revision: 5,
        run: { ...born.run, runId: "dwfrun-2" },
      },
      { op: "workflowRun.removed", runId: RUN_ID, revision: 6 },
    ];
    const base = snapshotWith(undefined);
    const immutable = applyConversationDeltas(base, deltas);
    const accumulator = createMutableConversationSnapshotAccumulator(base);
    applyConversationDeltasMutable(accumulator, deltas);
    expect(JSON.stringify(accumulator.snapshot.workflowRuns)).toBe(
      JSON.stringify(immutable.workflowRuns),
    );
    expect(immutable.workflowRuns?.runs.map((run) => run.runId)).toEqual(["dwfrun-2"]);
    // Inputs are not mutated.
    expect(base.workflowRuns).toBeUndefined();
  });
});

const ASK_NODE = { siteId: "ask#1", ordinal: 1, phase: "queued" } as const;

// ── Wire expression of entry eviction: removedActors / removedNodes ────────────────────────
//
// After reduction hits a bound, terminal entries are evicted to make room for live newcomers (workflow-runs-eviction.ts),
// so for the first time this model needs to say "this one left". What is pinned below is still the file-header contract
// (diff applied to prior equals next byte-for-byte), only with deletions added to the inputs; plus one more: merging two
// deltas must equal applying them in order.

/** Hand-built run: this section tests the algebra of diff/apply/merge; running the reducer would only obscure the inputs. */
function runWithNodes(
  nodes: readonly { siteId: string; ordinal: number; phase: string }[],
  actors: readonly { siteId: string; ordinal: number; status: string }[] = [],
): WorkflowRunState {
  return canonicalWorkflowRun({
    runId: RUN_ID,
    status: "running",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: actors as WorkflowRunState["actors"],
    nodes: nodes as WorkflowRunState["nodes"],
    lastEventSequence: 1,
  } as WorkflowRunState);
}

const queued = (siteId: string) => ({ siteId, ordinal: 1, phase: "queued" as const });
const settled = (siteId: string) => ({ siteId, ordinal: 1, phase: "settled" as const });
const waiting = (siteId: string) => ({ siteId, ordinal: 1, status: "waiting" as const });

/** Single-run diff that extracts the updated op (none of this section's inputs trigger a whole-key resend). */
function updateBetween(before: WorkflowRunState, after: WorkflowRunState) {
  const deltas = diffWorkflowRunsState(
    { revision: 1, runs: [before] },
    { revision: 2, runs: [after] },
  );
  expect(deltas).toHaveLength(1);
  const op = deltas[0]!;
  if (op.op !== "workflowRun.updated") throw new Error("应当是一条 workflowRun.updated");
  // Contract: applying to prior is byte-identical to next.
  const applied = applyConversationDeltas(snapshotWith({ revision: 1, runs: [before] }), deltas);
  expect(JSON.stringify(applied.workflowRuns)).toBe(JSON.stringify({ revision: 2, runs: [after] }));
  return op;
}

describe("diff：条目被删时走键化路径", () => {
  it("中间少了一条：removedNodes 说出来，其余条目一个字节都不重发", () => {
    const op = updateBetween(
      runWithNodes([queued("a"), queued("b"), queued("c")]),
      runWithNodes([queued("a"), queued("c")]),
    );
    expect(op.removedNodes).toEqual([{ siteId: "b", ordinal: 1 }]);
    expect(op.nodes).toBeUndefined();
  });

  it("删除 + 追加 + 幸存者变化同时发生", () => {
    const op = updateBetween(
      runWithNodes([queued("a"), queued("b"), queued("c")]),
      runWithNodes([settled("a"), queued("c"), queued("d")]),
    );
    expect(op.removedNodes).toEqual([{ siteId: "b", ordinal: 1 }]);
    expect(op.nodes).toEqual([settled("a"), queued("d")]);
  });

  it("两张表各自走各自的路径：actors 删、nodes 只追加", () => {
    const op = updateBetween(
      runWithNodes([queued("a")], [waiting("x"), waiting("y")]),
      runWithNodes([queued("a"), queued("b")], [waiting("y")]),
    );
    expect(op.removedActors).toEqual([{ siteId: "x", ordinal: 1 }]);
    expect(op.removedNodes).toBeUndefined();
    expect(op.nodes).toEqual([queued("b")]);
  });

  it("整张表被清空（溢出过的 run 在 resume 时重开）", () => {
    const op = updateBetween(
      runWithNodes([queued("a"), queued("b")], [waiting("x")]),
      runWithNodes([], []),
    );
    expect(op.removedNodes).toEqual([
      { siteId: "a", ordinal: 1 },
      { siteId: "b", ordinal: 1 },
    ]);
    expect(op.removedActors).toEqual([{ siteId: "x", ordinal: 1 }]);
  });

  it("重排仍然退回整键重发：删除之外的顺序变化这个模型表达不了", () => {
    const before = { revision: 1, runs: [runWithNodes([queued("a"), queued("b")])] };
    const after = { revision: 2, runs: [runWithNodes([queued("b"), queued("a")])] };
    expect(diffWorkflowRunsState(before, after)).toEqual([
      { op: "state.updated", patch: { workflowRuns: after } },
    ]);
  });
});

describe("apply：一条 op 内先删后加", () => {
  it("同一个键在一条 op 里被删又被加 → 落在表尾", () => {
    const seeded = applyConversationDeltas(snapshotWith(undefined), [
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 1,
        run: {
          runId: RUN_ID,
          status: "running",
          usage: { spentTokens: 0, nodesUsed: 0 },
          lastEventSequence: 0,
        },
        nodes: [queued("a"), queued("b")],
      },
    ]);
    const applied = applyConversationDeltas(seeded, [
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 2,
        removedNodes: [{ siteId: "a", ordinal: 1 }],
        nodes: [settled("a")],
      },
    ]);
    expect(applied.workflowRuns?.runs[0]?.nodes).toEqual([queued("b"), settled("a")]);
  });

  it("删到一条不剩 + 未命中的键是 no-op；没被提到的表保持引用", () => {
    const seeded = applyConversationDeltas(snapshotWith(undefined), [
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 1,
        run: {
          runId: RUN_ID,
          status: "running",
          usage: { spentTokens: 0, nodesUsed: 0 },
          lastEventSequence: 0,
        },
        actors: [waiting("x")],
        nodes: [queued("a")],
      },
    ]);
    const applied = applyConversationDeltas(seeded, [
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 2,
        removedNodes: [
          { siteId: "a", ordinal: 1 },
          { siteId: "从来没有过", ordinal: 7 },
        ],
      },
    ]);
    expect(applied.workflowRuns?.runs[0]?.nodes).toEqual([]);
    expect(applied.workflowRuns?.runs[0]?.actors).toBe(seeded.workflowRuns?.runs[0]?.actors);
  });
});

describe("merge（coalesce 规则 6 的载荷）：合并必须等于顺序施加", () => {
  const birth: ConversationDelta = {
    op: "workflowRun.updated",
    runId: RUN_ID,
    revision: 1,
    run: {
      runId: RUN_ID,
      status: "running",
      usage: { spentTokens: 0, nodesUsed: 0 },
      lastEventSequence: 0,
    },
    nodes: [queued("a"), queued("b"), queued("c")],
  };

  /** Referee: apply-after-merge and sequential application are byte-identical (both ops sit on the table birth built). */
  function expectMergeEqualsSequential(
    earlier: ConversationDelta,
    later: ConversationDelta,
  ): ConversationDelta {
    const base = applyConversationDeltas(snapshotWith(undefined), [birth]);
    const sequential = applyConversationDeltas(base, [earlier, later]);
    const merged = coalesceConversationDeltas([earlier, later]);
    expect(merged).toHaveLength(1);
    expect(JSON.stringify(applyConversationDeltas(base, merged).workflowRuns)).toBe(
      JSON.stringify(sequential.workflowRuns),
    );
    expect(conversationDeltaSchema.safeParse(merged[0]).success).toBe(true);
    return merged[0]!;
  }

  it("先删后加同一个键：合并后它仍然落在表尾", () => {
    const merged = expectMergeEqualsSequential(
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 2,
        removedNodes: [{ siteId: "a", ordinal: 1 }],
      },
      { op: "workflowRun.updated", runId: RUN_ID, revision: 3, nodes: [settled("a")] },
    );
    if (merged.op !== "workflowRun.updated") throw new Error("应合并成一条 updated");
    expect(merged.removedNodes).toEqual([{ siteId: "a", ordinal: 1 }]);
    expect(merged.nodes).toEqual([settled("a")]);
  });

  it("先者 upsert 的键被后者删掉：合并后它从 upsert 里消失", () => {
    const merged = expectMergeEqualsSequential(
      { op: "workflowRun.updated", runId: RUN_ID, revision: 2, nodes: [settled("b"), queued("d")] },
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 3,
        removedNodes: [{ siteId: "d", ordinal: 1 }],
      },
    );
    if (merged.op !== "workflowRun.updated") throw new Error("应合并成一条 updated");
    expect(merged.nodes).toEqual([settled("b")]);
    expect(merged.removedNodes).toEqual([{ siteId: "d", ordinal: 1 }]);
  });

  it("两侧的删除取并集、按首次出现去重", () => {
    const merged = expectMergeEqualsSequential(
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 2,
        removedNodes: [
          { siteId: "a", ordinal: 1 },
          { siteId: "b", ordinal: 1 },
        ],
      },
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 3,
        removedNodes: [
          { siteId: "b", ordinal: 1 },
          { siteId: "c", ordinal: 1 },
        ],
      },
    );
    if (merged.op !== "workflowRun.updated") throw new Error("应合并成一条 updated");
    expect(merged.removedNodes).toEqual([
      { siteId: "a", ordinal: 1 },
      { siteId: "b", ordinal: 1 },
      { siteId: "c", ordinal: 1 },
    ]);
  });

  it("先加新键、后删另一个旧键：新键仍追在幸存者后面", () => {
    expectMergeEqualsSequential(
      { op: "workflowRun.updated", runId: RUN_ID, revision: 2, nodes: [queued("d")] },
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 3,
        removedNodes: [{ siteId: "a", ordinal: 1 }],
      },
    );
  });

  it("合并出来会超界时**不合并**：超界的帧会被整帧丢掉，订阅从此静默", () => {
    // Before eviction, "distinct keys touched in one window ≤ table bound" was structural (the table only grew); after eviction it is not.
    const ref = (ordinal: number) => ({ siteId: "ask#1", ordinal });
    const wide = (revision: number, from: number, count: number): ConversationDelta => ({
      op: "workflowRun.updated",
      runId: RUN_ID,
      revision,
      removedNodes: Array.from({ length: count }, (_, index) => ref(from + index)),
    });
    const deltas = [wide(2, 0, WORKFLOW_RUNS_LIMITS.maxNodes), wide(3, 100_000, 100)];
    const coalesced = coalesceConversationDeltas(deltas);
    expect(coalesced).toHaveLength(2);
    for (const delta of coalesced) {
      expect(conversationDeltaSchema.safeParse(delta).success).toBe(true);
    }
    // Not merging does not change the final state: one-by-one delivery and the "merged" sequence apply to the same state.
    const base = applyConversationDeltas(snapshotWith(undefined), [
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 1,
        run: {
          runId: RUN_ID,
          status: "running",
          usage: { spentTokens: 0, nodesUsed: 0 },
          lastEventSequence: 0,
        },
        nodes: [queued("a"), { siteId: "ask#1", ordinal: 3, phase: "settled" }],
      },
    ]);
    expect(JSON.stringify(applyConversationDeltas(base, coalesced).workflowRuns)).toBe(
      JSON.stringify(applyConversationDeltas(base, deltas).workflowRuns),
    );
    // Two in-bound ones still merge as usual (this gate only blocks when it genuinely does not fit).
    expect(coalesceConversationDeltas([wide(2, 0, 10), wide(3, 100, 10)])).toHaveLength(1);
  });

  it("合并被拒之后，后来的 op 只能并进**最后**那条——并回更早那条会吃掉一个先删后加的键", () => {
    const ref = (ordinal: number) => ({ siteId: "ask#9", ordinal });
    const key = { siteId: "ask#1", ordinal: 1 };
    const base = applyConversationDeltas(snapshotWith(undefined), [
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 1,
        run: {
          runId: RUN_ID,
          status: "running",
          usage: { spentTokens: 0, nodesUsed: 0 },
          lastEventSequence: 0,
        },
        nodes: [queued("ask#1"), queued("x")],
      },
    ]);
    // A pushes the removal table onto the bound → B cannot merge in and must stand alone; if C crossed B back into A,
    // C's upsert would land **before** B's removal and ask#1 would vanish into thin air.
    const deltas: ConversationDelta[] = [
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 2,
        removedNodes: Array.from({ length: WORKFLOW_RUNS_LIMITS.maxNodes }, (_, i) => ref(i)),
      },
      { op: "workflowRun.updated", runId: RUN_ID, revision: 3, removedNodes: [key] },
      { op: "workflowRun.updated", runId: RUN_ID, revision: 4, nodes: [settled("ask#1")] },
    ];
    const coalesced = coalesceConversationDeltas(deltas);
    expect(coalesced).toHaveLength(2);
    const direct = applyConversationDeltas(base, deltas);
    expect(JSON.stringify(applyConversationDeltas(base, coalesced).workflowRuns)).toBe(
      JSON.stringify(direct.workflowRuns),
    );
    // The delete-then-add key lands at the table tail instead of being swallowed.
    expect(direct.workflowRuns?.runs[0]?.nodes).toEqual([queued("x"), settled("ask#1")]);
  });

  it("actors 与 nodes 各删各的，互不相干", () => {
    expectMergeEqualsSequential(
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 2,
        removedNodes: [{ siteId: "a", ordinal: 1 }],
        actors: [waiting("x")],
      },
      {
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 3,
        removedActors: [{ siteId: "x", ordinal: 1 }],
        nodes: [settled("c")],
      },
    );
  });
});

describe("canonicalWorkflowRun：规范键序", () => {
  it("按 schema 声明序重建，undefined 值的键按缺席处理", () => {
    const scrambled = {
      lastEventSequence: 3,
      nodes: [],
      status: "running",
      actors: [],
      usage: { spentTokens: 0, nodesUsed: 0 },
      runId: RUN_ID,
      error: undefined,
    } as unknown as WorkflowRunState;
    expect(Object.keys(canonicalWorkflowRun(scrambled))).toEqual([
      "runId",
      "status",
      "usage",
      "actors",
      "nodes",
      "lastEventSequence",
    ]);
  });

  it("header 键表就是 schema 的键减去两张增量表", () => {
    expect(WORKFLOW_RUN_HEADER_KEYS).toEqual(
      Object.keys(workflowRunSchema.shape).filter((key) => key !== "actors" && key !== "nodes"),
    );
  });

  it("归约产出的 run 已经是规范序（diff 的字节等价不靠调用方再排一次）", () => {
    const state = expectRoundTripFinal(fullRunEvents());
    const run = state.runs[0]!;
    expect(Object.keys(run)).toEqual(Object.keys(canonicalWorkflowRun(run)));
  });
});

describe("conversationDeltaSchema：两条新 op", () => {
  it("增量 op 解析通过，并保住 cleared / 条目载荷", () => {
    const parsed = conversationDeltaSchema.parse({
      op: "workflowRun.updated",
      runId: RUN_ID,
      revision: 7,
      run: { status: "completed", lastEventSequence: 9 },
      cleared: ["pendingQuestions"],
      actors: [{ siteId: "actor#1", ordinal: 1, status: "completed" }],
      nodes: [ASK_NODE],
    });
    expect(parsed).toMatchObject({ op: "workflowRun.updated", cleared: ["pendingQuestions"] });
    expect(
      conversationDeltaSchema.parse({ op: "workflowRun.removed", runId: RUN_ID, revision: 1 }),
    ).toMatchObject({ op: "workflowRun.removed" });
  });

  it("条目淘汰的两个载荷：只带身份，界与两张表同值", () => {
    const parsed = conversationDeltaSchema.parse({
      op: "workflowRun.updated",
      runId: RUN_ID,
      revision: 8,
      removedActors: [{ siteId: "actor#1", ordinal: 1 }],
      removedNodes: [{ siteId: "ask#1", ordinal: 1 }],
    });
    expect(parsed).toMatchObject({ removedNodes: [{ siteId: "ask#1", ordinal: 1 }] });
    // Eviction payloads carry **identity**, not entries: extra keys are stripped and do not turn the op into an upsert.
    expect(
      conversationDeltaSchema.safeParse({
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 1,
        removedNodes: [{ siteId: "ask#1" }],
      }).success,
    ).toBe(false);
    const ref = (ordinal: number) => ({ siteId: "ask#1", ordinal });
    expect(
      conversationDeltaSchema.safeParse({
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 1,
        removedNodes: Array.from({ length: WORKFLOW_RUNS_LIMITS.maxNodes }, (_, i) => ref(i)),
      }).success,
    ).toBe(true);
    expect(
      conversationDeltaSchema.safeParse({
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 1,
        removedNodes: Array.from({ length: WORKFLOW_RUNS_LIMITS.maxNodes + 1 }, (_, i) => ref(i)),
      }).success,
    ).toBe(false);
  });

  it("坏载荷一律拒收：负 revision、空 runId、非 header 键的 cleared", () => {
    expect(
      conversationDeltaSchema.safeParse({ op: "workflowRun.updated", runId: RUN_ID, revision: -1 })
        .success,
    ).toBe(false);
    expect(
      conversationDeltaSchema.safeParse({ op: "workflowRun.updated", runId: "", revision: 1 })
        .success,
    ).toBe(false);
    // nodes / actors are not header keys: they have their own delta payloads and cannot be cleared.
    expect(
      conversationDeltaSchema.safeParse({
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 1,
        cleared: ["nodes"],
      }).success,
    ).toBe(false);
    // Bad values on the state key are equally excluded (run is a partial of the header, not an arbitrary object).
    expect(
      conversationDeltaSchema.safeParse({
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 1,
        run: { status: "exploded" },
      }).success,
    ).toBe(false);
  });

  it("条目表的界与状态键同值：增量拼不出一个非法状态", () => {
    const node = (ordinal: number) => ({ siteId: "ask#1", ordinal, phase: "queued" });
    const withinBound = Array.from({ length: WORKFLOW_RUNS_LIMITS.maxNodes }, (_, i) => node(i));
    expect(
      conversationDeltaSchema.safeParse({
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 1,
        nodes: withinBound,
      }).success,
    ).toBe(true);
    expect(
      conversationDeltaSchema.safeParse({
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 1,
        nodes: [...withinBound, node(9_999)],
      }).success,
    ).toBe(false);
    const actor = (ordinal: number) => ({ siteId: "actor#1", ordinal, status: "waiting" });
    expect(
      conversationDeltaSchema.safeParse({
        op: "workflowRun.updated",
        runId: RUN_ID,
        revision: 1,
        actors: Array.from({ length: WORKFLOW_RUNS_LIMITS.maxActors + 1 }, (_, i) => actor(i)),
      }).success,
    ).toBe(false);
  });
});

// The three things workflowRuns' **bounds** leave behind: counters for rejected instances, a whole-key entry budget, and trimming for old consumers.
//
// Before the rework nodes/actors were capped at 256 because state keys were resent wholesale per event, making unbounded state O(N²) bytes;
// once key-level deltas landed that reason was gone and the bound rose to 1024. Raising the bound is not free: a 50-way fan-out
// wide workflow can still push the whole table to several MB, hence the new **cross-run** entry budget; and hitting a bound still rejects
// instances, so the read side must be able to say "how many steps never entered the table" — the entire reason the two counters exist.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  WORKFLOW_RUNS_LEGACY_LIMITS,
  WORKFLOW_RUNS_LIMITS,
  applyConversationDeltas,
  clampWorkflowRunsForLegacy,
  diffWorkflowRunsState,
  reduceWorkflowRunsState,
  workflowRunActorSchema,
  workflowRunNodeSchema,
  workflowRunSchema,
  workflowRunStepCounts,
  workflowRunsStateSchema,
  type ConversationSnapshot,
  type WorkflowRunNode,
  type WorkflowRunProgressEnvelope,
  type WorkflowRunState,
  type WorkflowRunsState,
} from "../src/zcode-protocol-v4/index.js";

const RUN_ID = "dwfrun-1";

/** A hand-built run: fills the table directly, saving thousands of reductions (what is under test is what happens after a bound is hit). */
function runWith(
  overrides: Partial<WorkflowRunState> & { runId?: string } = {},
  nodeCount = 0,
  actorCount = 0,
): WorkflowRunState {
  return {
    runId: overrides.runId ?? RUN_ID,
    // Event envelopes always carry tc-1: without pre-filling it in the fixture, the first event would produce a change by "backfilling toolCallId",
    // turning every "this event must change nothing" assertion in this file into a false positive.
    toolCallId: "tc-1",
    status: "running",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: Array.from({ length: actorCount }, (_, index) => ({
      siteId: "actor#1",
      ordinal: index,
      status: "completed" as const,
    })),
    nodes: Array.from({ length: nodeCount }, (_, index) => ({
      siteId: "ask#1",
      ordinal: index,
      phase: "settled" as const,
    })),
    lastEventSequence: 100,
    ...overrides,
  };
}

function stateWith(...runs: WorkflowRunState[]): WorkflowRunsState {
  return { revision: 10, runs };
}

/** Event envelope: sequence given explicitly; most assertions in this file watch the watermark. */
function event(
  eventType: string,
  payload: Record<string, unknown>,
  sequence: number,
  runId = RUN_ID,
): WorkflowRunProgressEnvelope {
  return { runId, toolCallId: "tc-1", sequence, eventType, payload };
}

const FULL_NODES = WORKFLOW_RUNS_LIMITS.maxNodes;
/**
 * A run whose table is full and where **not a single entry can be evicted**: every new instance after this gets rejected.
 *
 * Having all nodes stuck in `executing` is the point of this fixture: making room only evicts terminal entries
 * (workflow-runs-eviction.ts), so a full table of live nodes is exactly the old "reject new" path,
 * and what this section pins is how rejected instances stay countable. The eviction path lives in …WorkflowRunsEviction.test.ts.
 */
const fullRun = () =>
  runWith(
    {
      truncated: true,
      nodes: Array.from({ length: FULL_NODES }, (_, index) => ({
        siteId: "ask#1",
        ordinal: index,
        phase: "executing" as const,
      })),
    },
    FULL_NODES,
  );
/** An instance not in the table (ordinal far beyond the bound). */
const rejected = (ordinal: number) => ({ siteId: "ask#9", ordinal });

describe("WORKFLOW_RUNS_LIMITS：抬界之后的两条界", () => {
  it("nodes 与 actors 同界 1024；条目预算 6144 小于「满 8 条 run」的 16384", () => {
    expect(WORKFLOW_RUNS_LIMITS.maxNodes).toBe(1_024);
    expect(WORKFLOW_RUNS_LIMITS.maxActors).toBe(WORKFLOW_RUNS_LIMITS.maxNodes);
    expect(WORKFLOW_RUNS_LIMITS.maxTotalEntries).toBe(6_144);
    const worstCaseWithoutBudget =
      WORKFLOW_RUNS_LIMITS.maxRuns *
      (WORKFLOW_RUNS_LIMITS.maxNodes + WORKFLOW_RUNS_LIMITS.maxActors);
    expect(WORKFLOW_RUNS_LIMITS.maxTotalEntries).toBeLessThan(worstCaseWithoutBudget);
  });

  it("旧消费者的界是 256，且**永远不能变**（它是别人编译进去的校验界）", () => {
    expect(WORKFLOW_RUNS_LEGACY_LIMITS).toEqual({ maxActors: 256, maxNodes: 256 });
  });
});

describe("被拒实例的计数器（usage.nodesUnlisted / nodesUnlistedSettled）", () => {
  it("node-queued 撞界 → nodesUnlisted +1，表本身不增长", () => {
    const next = reduceWorkflowRunsState(
      stateWith(fullRun()),
      event("node-queued", { instance: rejected(5_000), kind: "ask" }, 101),
    );
    expect(next?.runs[0]?.nodes).toHaveLength(FULL_NODES);
    expect(next?.runs[0]?.usage).toEqual({
      spentTokens: 0,
      nodesUsed: 0,
      nodesUnlisted: 1,
    });
    expect(workflowRunsStateSchema.safeParse(next).success).toBe(true);
  });

  it("缓存命中的结算是**出生**：两个计数器一起 +1", () => {
    const next = reduceWorkflowRunsState(
      stateWith(fullRun()),
      event("node-settled", { instance: rejected(5_000), outcome: "ok", cached: true }, 101),
    );
    expect(next?.runs[0]?.usage).toMatchObject({ nodesUnlisted: 1, nodesUnlistedSettled: 1 });
  });

  it("普通 node-settled 只 +settled：它的出生（queued）此前已经计过", () => {
    const queued = reduceWorkflowRunsState(
      stateWith(fullRun()),
      event("node-queued", { instance: rejected(5_000), kind: "ask" }, 101),
    )!;
    const settled = reduceWorkflowRunsState(
      queued,
      event("node-settled", { instance: rejected(5_000), outcome: "ok" }, 102),
    );
    expect(settled?.runs[0]?.usage).toMatchObject({ nodesUnlisted: 1, nodesUnlistedSettled: 1 });
  });

  it("被拒实例的中间相位一个都不计（dispatched / executing / waiting / repairing / nudged / progress）", () => {
    let state: WorkflowRunsState = stateWith(fullRun());
    let sequence = 100;
    for (const eventType of [
      "node-dispatched",
      "node-executing",
      "node-waiting",
      "node-repairing",
      "node-nudged",
      "node-progress",
    ]) {
      sequence += 1;
      state =
        reduceWorkflowRunsState(state, event(eventType, { instance: rejected(5_000) }, sequence)) ??
        state;
    }
    expect(state.runs[0]?.usage).not.toHaveProperty("nodesUnlisted");
    expect(state.runs[0]?.usage).not.toHaveProperty("nodesUnlistedSettled");
    // `nodesUsed` is a different matter and is **pre-existing** behavior: the first dispatch counts a step even for rejected instances —
    // step count is a run-level fact, not constrained by the display bound (see the firstDispatch comment in the reducer's main file).
    expect(state.runs[0]?.usage.nodesUsed).toBe(1);
    // The watermark still advances: the event having arrived is a fact; it just does not change "how many steps never entered the table".
    expect(state.runs[0]?.lastEventSequence).toBe(sequence);
  });

  it("**在表里**的实例永远不计：queued 与 settled 都只更新那一行", () => {
    const state = stateWith(runWith({}, 3));
    const queued = reduceWorkflowRunsState(
      state,
      event("node-queued", { instance: { siteId: "ask#1", ordinal: 1 }, kind: "ask" }, 101),
    )!;
    expect(queued.runs[0]?.usage).toEqual({ spentTokens: 0, nodesUsed: 0 });
    const settled = reduceWorkflowRunsState(
      queued,
      event("node-settled", { instance: { siteId: "ask#1", ordinal: 1 }, outcome: "ok" }, 102),
    )!;
    expect(settled.runs[0]?.usage).toEqual({ spentTokens: 0, nodesUsed: 0 });
    expect(settled.runs[0]?.nodes).toHaveLength(3);
  });

  it("同一条事件重放仍是 null no-op：只有抬过水位的事件才计数", () => {
    // This is the counters' only idempotence pivot. Without this guard, one retransmitted tail event would push the
    // counters ever higher, and the counters are **additive** with no deduplicable identity (rejected instances are not in the table at all).
    const replayed = event("node-queued", { instance: rejected(5_000), kind: "ask" }, 101);
    const once = reduceWorkflowRunsState(stateWith(fullRun()), replayed)!;
    expect(once.runs[0]?.usage).toMatchObject({ nodesUnlisted: 1 });
    expect(reduceWorkflowRunsState(once, replayed)).toBeNull();
  });

  it("迟到的低 sequence 事件不计数（水位没被抬过）", () => {
    const late = reduceWorkflowRunsState(
      stateWith(fullRun()),
      event("node-queued", { instance: rejected(5_000), kind: "ask" }, 50),
    );
    // No change in content whatsoever: table full, watermark does not retreat, counters untouched → no change at all.
    expect(late).toBeNull();
  });

  it("run-started 清零两个计数器：resume 会把整段脚本前缀重发一遍", () => {
    // On a fresh life the engine resends the cached settles of completed instances and the queued of new instances;
    // not resetting would add the previous life's "steps that never entered" to this life's.
    const counted = reduceWorkflowRunsState(
      stateWith(fullRun()),
      event("node-settled", { instance: rejected(5_000), outcome: "ok", cached: true }, 101),
    )!;
    expect(counted.runs[0]?.usage).toMatchObject({ nodesUnlisted: 1, nodesUnlistedSettled: 1 });
    const rearmed = reduceWorkflowRunsState(
      counted,
      event("run-started", { caps: { maxConcurrency: 2 } }, 102),
    )!;
    expect(rearmed.runs[0]?.usage).toEqual({ spentTokens: 0, nodesUsed: 0 });
  });

  it("零时整个键缺席（不是 0）：没撞过界的 run 一个新键都不多", () => {
    const next = reduceWorkflowRunsState(
      stateWith(runWith({}, 3)),
      event("node-queued", { instance: { siteId: "ask#2", ordinal: 1 }, kind: "ask" }, 101),
    );
    expect(next?.runs[0]?.usage).not.toHaveProperty("nodesUnlisted");
    expect(next?.runs[0]?.usage).not.toHaveProperty("nodesUnlistedSettled");
  });

  it("settled 永不超过 unlisted：每次结算的出生此前都计过（一世之内）", () => {
    // Within one life the engine sends at most one queued and at most one settled per instance (the scheduler's settled latch),
    // while a cache-hit settle carries its own birth. So this invariant is **structural**, not a squeeze argument.
    let state: WorkflowRunsState = stateWith(fullRun());
    let sequence = 100;
    const step = (eventType: string, payload: Record<string, unknown>) => {
      sequence += 1;
      state = reduceWorkflowRunsState(state, event(eventType, payload, sequence)) ?? state;
    };
    for (let ordinal = 5_000; ordinal < 5_005; ordinal += 1) {
      step("node-queued", { instance: rejected(ordinal), kind: "ask" });
      step("node-dispatched", { instance: rejected(ordinal) });
      step("node-settled", { instance: rejected(ordinal), outcome: "ok" });
    }
    // One cache-hit-only one (no queued).
    step("node-settled", { instance: rejected(6_000), outcome: "ok", cached: true });
    // One queued but never settled in this life (the engine does not send a follow-up cancelled on run-level failure).
    step("node-queued", { instance: rejected(7_000), kind: "ask" });
    const usage = state.runs[0]!.usage;
    expect(usage.nodesUnlisted).toBe(7);
    expect(usage.nodesUnlistedSettled).toBe(6);
    expect(usage.nodesUnlistedSettled!).toBeLessThanOrEqual(usage.nodesUnlisted!);
  });
});

describe("workflowRunStepCounts：表内 + 表外的唯一读法", () => {
  it("总数与已结算数都把被拒实例算进去", () => {
    const run = runWith(
      {
        usage: { spentTokens: 0, nodesUsed: 0, nodesUnlisted: 5, nodesUnlistedSettled: 2 },
        nodes: [
          { siteId: "ask#1", ordinal: 1, phase: "settled" },
          { siteId: "ask#1", ordinal: 2, phase: "executing" },
          { siteId: "ask#1", ordinal: 3, phase: "settled" },
        ] satisfies WorkflowRunNode[],
      },
      0,
    );
    expect(workflowRunStepCounts(run)).toEqual({ total: 8, settled: 4 });
  });

  it("计数器缺席时退化成「表里有多少算多少」", () => {
    const run = runWith({
      nodes: [
        { siteId: "ask#1", ordinal: 1, phase: "settled" },
        { siteId: "ask#1", ordinal: 2, phase: "queued" },
      ] satisfies WorkflowRunNode[],
    });
    expect(workflowRunStepCounts(run)).toEqual({ total: 2, settled: 1 });
  });
});

describe("条目预算：整键 6144 条，淘汰最旧的终态 run", () => {
  // A **full-bound** run is 1024 + 1024 = 2048 entries, so the budget fits exactly three. "Four full-bound runs" is
  // therefore the smallest realistic scenario for this rule: evicting one returns to budget without evicting an extra one.
  const FULL_RUN_ENTRIES = WORKFLOW_RUNS_LIMITS.maxNodes + WORKFLOW_RUNS_LIMITS.maxActors;
  const big = (runId: string, status: WorkflowRunState["status"]) =>
    runWith(
      { runId, status, truncated: true },
      WORKFLOW_RUNS_LIMITS.maxNodes,
      WORKFLOW_RUNS_LIMITS.maxActors,
    );
  const queueOne = (state: WorkflowRunsState) =>
    reduceWorkflowRunsState(
      state,
      event("node-queued", { instance: { siteId: "ask#new", ordinal: 1 }, kind: "ask" }, 101),
    )!;

  it("四条满界 run 超预算：淘汰最旧的终态 run，回到预算内就停手", () => {
    expect(FULL_RUN_ENTRIES * 4).toBeGreaterThan(WORKFLOW_RUNS_LIMITS.maxTotalEntries);
    expect(FULL_RUN_ENTRIES * 3).toBeLessThanOrEqual(WORKFLOW_RUNS_LIMITS.maxTotalEntries);
    const next = queueOne(
      stateWith(
        big("dwfrun-old-1", "completed"),
        big("dwfrun-old-2", "stopped"),
        big("dwfrun-live", "running"),
        big(RUN_ID, "running"),
      ),
    );
    // Only one is evicted: the second-oldest is terminal too, but evicting the oldest already returns to budget.
    expect(next.runs.map((run) => run.runId)).toEqual(["dwfrun-old-2", "dwfrun-live", RUN_ID]);
  });

  it("绝不淘汰在跑的 run，也绝不淘汰事件所属的那条 run", () => {
    const next = queueOne(
      stateWith(
        big("dwfrun-live-1", "running"),
        big("dwfrun-live-2", "pending"),
        big("dwfrun-live-3", "running"),
        big(RUN_ID, "completed"),
      ),
    );
    // The only terminal run is the one the event belongs to → nobody can be evicted, and it stays over budget (honesty beats saving bytes).
    expect(next.runs.map((run) => run.runId)).toEqual([
      "dwfrun-live-1",
      "dwfrun-live-2",
      "dwfrun-live-3",
      RUN_ID,
    ]);
  });

  it("预算之内不动任何东西：run 对象保持引用（增量的快路径靠它）", () => {
    const state = stateWith(
      runWith({ runId: "dwfrun-old", status: "completed" }, 10),
      runWith({}, 10),
    );
    const next = queueOne(state);
    expect(next.runs).toHaveLength(2);
    expect(next.runs[0]).toBe(state.runs[0]);
  });

  it("预算淘汰在增量上说得出口：一条 workflowRun.removed，往返逐字节一致", () => {
    const state = stateWith(
      big("dwfrun-old-1", "completed"),
      big("dwfrun-old-2", "completed"),
      big("dwfrun-live", "running"),
      big(RUN_ID, "running"),
    );
    const next = queueOne(state);
    expect(next.runs.map((run) => run.runId)).toEqual(["dwfrun-old-2", "dwfrun-live", RUN_ID]);
    const deltas = diffWorkflowRunsState(state, next);
    expect(deltas[0]).toEqual({
      op: "workflowRun.removed",
      runId: "dwfrun-old-1",
      revision: next.revision,
    });
    const applied = applyConversationDeltas(snapshotWith(state), deltas);
    expect(JSON.stringify(applied.workflowRuns)).toBe(JSON.stringify(next));
  });
});

describe("clampWorkflowRunsForLegacy：没有增量能力的消费者", () => {
  // What old consumers compiled in is .max(256): an over-bound frame makes the **entire state.updated patch** fail to parse and the whole frame is
  // dropped, so that subscription goes silent from then on. This trim is the producer-side second gate; "the first 256 entries" is exactly the old reducer's (reject-new) product.
  const legacyStateSchema = z.object({
    revision: z.number().int().nonnegative(),
    runs: z
      .array(
        workflowRunSchema.extend({
          actors: z.array(workflowRunActorSchema).max(WORKFLOW_RUNS_LEGACY_LIMITS.maxActors),
          nodes: z.array(workflowRunNodeSchema).max(WORKFLOW_RUNS_LEGACY_LIMITS.maxNodes),
        }),
      )
      .max(WORKFLOW_RUNS_LIMITS.maxRuns),
  });

  it("每条 run 各裁到前 256，并置 truncated", () => {
    const state = stateWith(runWith({ runId: "dwfrun-wide" }, 900, 700));
    const clamped = clampWorkflowRunsForLegacy(state);
    expect(clamped.runs[0]?.nodes).toHaveLength(WORKFLOW_RUNS_LEGACY_LIMITS.maxNodes);
    expect(clamped.runs[0]?.actors).toHaveLength(WORKFLOW_RUNS_LEGACY_LIMITS.maxActors);
    expect(clamped.runs[0]?.truncated).toBe(true);
    // All fixture entries are terminal with nothing to protect first → what remains is exactly the earliest instances.
    expect(clamped.runs[0]?.nodes[0]?.ordinal).toBe(0);
    expect(clamped.runs[0]?.nodes.at(-1)?.ordinal).toBe(WORKFLOW_RUNS_LEGACY_LIMITS.maxNodes - 1);
    expect(legacyStateSchema.safeParse(clamped).success).toBe(true);
  });

  // The trim keeps **what is still moving**: an old phone receives a whole-key snapshot, and what it needs to draw is
  // the same "who is running right now" as the new client. A blunt first-256 would leave a wide run stuck forever on the earliest finished batch in old clients.
  it("还在动的先留：未结算的 node 与状态不是 completed 的 actor 不会被裁掉", () => {
    const live = (ordinal: number, phase: WorkflowRunNode["phase"]) => ({
      siteId: "ask#1",
      ordinal,
      phase,
    });
    const nodes: WorkflowRunNode[] = [
      ...Array.from({ length: 300 }, (_, index) => live(index, "settled")),
      live(300, "executing"),
      live(301, "queued"),
    ];
    const actors = [
      ...Array.from({ length: 300 }, (_, index) => ({
        siteId: "actor#1",
        ordinal: index,
        status: "completed" as const,
      })),
      { siteId: "actor#1", ordinal: 300, status: "running" as const },
    ];
    const clamped = clampWorkflowRunsForLegacy(stateWith(runWith({ nodes, actors }, 0, 0)));
    const keptNodes = clamped.runs[0]!.nodes;
    expect(keptNodes).toHaveLength(WORKFLOW_RUNS_LEGACY_LIMITS.maxNodes);
    expect(keptNodes.map((node) => node.ordinal)).toContain(300);
    expect(keptNodes.map((node) => node.ordinal)).toContain(301);
    // Output still follows the original table order: the two kept live nodes go last, and the remaining slots are filled with the earliest entries in table order.
    expect(keptNodes.map((node) => node.ordinal)).toEqual([
      ...Array.from({ length: WORKFLOW_RUNS_LEGACY_LIMITS.maxNodes - 2 }, (_, index) => index),
      300,
      301,
    ]);
    expect(clamped.runs[0]!.actors.map((actor) => actor.ordinal)).toContain(300);
    expect(legacyStateSchema.safeParse(clamped).success).toBe(true);
  });

  it("活条目多过旧界时按表序取前 256 条活的（仍然有界）", () => {
    const nodes: WorkflowRunNode[] = Array.from({ length: 400 }, (_, index) => ({
      siteId: "ask#1",
      ordinal: index,
      phase: "executing" as const,
    }));
    const clamped = clampWorkflowRunsForLegacy(stateWith(runWith({ nodes }, 0, 0)));
    expect(clamped.runs[0]!.nodes.map((node) => node.ordinal)).toEqual(
      Array.from({ length: WORKFLOW_RUNS_LEGACY_LIMITS.maxNodes }, (_, index) => index),
    );
  });

  it("没什么可裁时返回**同一个对象**（每次 flush 都要跑一遍，身份不能白丢）", () => {
    const state = stateWith(runWith({}, 10, 10), runWith({ runId: "dwfrun-2" }, 0, 0));
    expect(clampWorkflowRunsForLegacy(state)).toBe(state);
  });

  it("只裁该裁的那条 run，其余保持引用", () => {
    const narrow = runWith({ runId: "dwfrun-narrow" }, 5, 5);
    const state = stateWith(narrow, runWith({ runId: "dwfrun-wide" }, 400, 0));
    const clamped = clampWorkflowRunsForLegacy(state);
    expect(clamped).not.toBe(state);
    expect(clamped.runs[0]).toBe(narrow);
    expect(clamped.runs[1]?.nodes).toHaveLength(WORKFLOW_RUNS_LEGACY_LIMITS.maxNodes);
  });

  it("裁剪产物始终过旧界 schema：满界的 8 条 run 也一样", () => {
    const state: WorkflowRunsState = {
      revision: 3,
      runs: Array.from({ length: WORKFLOW_RUNS_LIMITS.maxRuns }, (_, index) =>
        runWith({ runId: `dwfrun-${index}` }, WORKFLOW_RUNS_LIMITS.maxNodes, 300),
      ),
    };
    const clamped = clampWorkflowRunsForLegacy(state);
    expect(legacyStateSchema.safeParse(clamped).success).toBe(true);
    // The new-bound schema passes too, of course — trimming only removes, never adds.
    expect(workflowRunsStateSchema.safeParse(clamped).success).toBe(true);
  });
});

/** Contains only the two spots apply touches (same reason as …WorkflowRunsDelta.test.ts). */
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

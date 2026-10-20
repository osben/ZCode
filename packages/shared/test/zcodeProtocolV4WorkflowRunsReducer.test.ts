// workflowRuns' pure reducer (workflow-runs-reducer.ts).
// This reducer previously grew inside bootstrap's v4 product-projection and was extracted for the TUI mirror to share
// (docs/dynamic-workflow/launch.md "The inline card").
//
// Equivalence with the desktop/protocol side is backed by bootstrap's product-projection*.test.ts (assertions unchanged);
// what this file pins is the reducer's own contract: per-event reduction, bounding, eviction, monotonic revision, derived
// actor status, idempotent replay. Every case calls only pure functions — no projection, no clock, no I/O.
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_RUNS_LIMITS,
  reduceWorkflowRunsState,
  workflowRunsStateSchema,
  type WorkflowRunProgressEnvelope,
  type WorkflowRunsState,
} from "../src/zcode-protocol-v4/index.js";

const RUN_ID = "dwfrun-1";

/** Reduces a stream of events one by one; on null (no change) keeps the previous state, synonymous with the projection producing no delta. */
function reduceAll(
  envelopes: readonly WorkflowRunProgressEnvelope[],
  initial?: WorkflowRunsState,
): WorkflowRunsState | undefined {
  let state = initial;
  for (const envelope of envelopes) {
    state = reduceWorkflowRunsState(state, envelope) ?? state;
  }
  return state;
}

/**
 * Reduces one event that is **expected to produce a change**.
 *
 * The reducer takes `previous: | undefined` but returns `| null`, so calls cannot be chained directly — deliberate:
 * "no change" must be handled explicitly by the caller, never passed along as an empty state (that would wipe the whole state).
 */
function step(
  state: WorkflowRunsState | undefined,
  envelope: WorkflowRunProgressEnvelope,
): WorkflowRunsState {
  const next = reduceWorkflowRunsState(state, envelope);
  if (next === null) throw new Error(`事件本应产生变化却返回 null：${envelope.eventType}`);
  return next;
}

/** Event envelope factory: sequence auto-increments per call, mimicking the journal's monotonic assignment. */
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

const started = (caps: Record<string, unknown> = { maxConcurrency: 4 }) => ({
  caps,
  runId: RUN_ID,
});

describe("reduceWorkflowRunsState：逐事件归约", () => {
  it("run-started 建条目：running + 零用量，产出过 strict schema", () => {
    const progress = progressLog();
    const state = reduceWorkflowRunsState(
      undefined,
      progress("run-started", started({ maxConcurrency: 2 })),
    );
    expect(state).toEqual({
      revision: 1,
      runs: [
        {
          runId: RUN_ID,
          toolCallId: "tc-1",
          status: "running",
          usage: { spentTokens: 0, nodesUsed: 0 },
          actors: [],
          nodes: [],
          lastEventSequence: 0,
        },
      ],
    });
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  it("节点相位按 (siteId, ordinal) upsert：四条事件一个条目", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("node-queued", {
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
      }),
      progress("node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 } }),
      progress("node-repairing", { instance: { siteId: "ask#1", ordinal: 1 }, attempt: 1 }),
      progress("node-settled", { instance: { siteId: "ask#1", ordinal: 1 }, outcome: "ok" }),
    ]);
    expect(state?.runs[0]?.nodes).toEqual([
      {
        siteId: "ask#1",
        ordinal: 1,
        // kind is carried only on queued; later phases inherit it from the previous entry.
        kind: "ask",
        phase: "settled",
        outcome: "ok",
        // actor attribution is inherited the same way — dispatched/settled do not repeat it.
        actorSiteId: "actor#1",
        actorOrdinal: 1,
      },
    ]);
  });

  it("cached 命中直接发 node-settled（不经 queued），kind 缺省而条目仍成立", () => {
    // engine.ts:228/232 — resume's completed-hit short-circuit, so kind is unobservable.
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("node-settled", {
        instance: { siteId: "world-read#1", ordinal: 1 },
        outcome: "ok",
        cached: true,
      }),
    ]);
    expect(state?.runs[0]?.nodes).toEqual([
      { siteId: "world-read#1", ordinal: 1, phase: "settled", outcome: "ok", cached: true },
    ]);
  });

  it("用量：spentTokens 直接取 usage-updated 载荷，nodesUsed 按首次派发计步", () => {
    // docs/dynamic-workflow/authoring.md: events carry the spent total (written in sync with dwf_run.spent_tokens).
    const progress = progressLog();
    const dispatched = (siteId: string) => [
      progress("node-queued", {
        instance: { siteId, ordinal: 1 },
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
      }),
      progress("node-dispatched", { instance: { siteId, ordinal: 1 } }),
    ];
    const state = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 1 } }),
      ...dispatched("ask#1"),
      progress("usage-updated", { spentTokens: 1_234 }),
      ...dispatched("ask#2"),
      ...dispatched("ask#3"),
      progress("usage-updated", { spentTokens: 2_000 }),
    ]);
    expect(state?.runs[0]?.usage).toEqual({ spentTokens: 2_000, nodesUsed: 3 });
  });

  it("步数幂等：同一实例的 node-dispatched 重放不重复计步；usage-updated 缺载荷时保持已知值", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("node-queued", { instance: { siteId: "ask#1", ordinal: 1 }, kind: "ask" }),
      progress("node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 } }),
      progress("node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 } }),
      progress("node-executing", { instance: { siteId: "ask#1", ordinal: 1 } }),
      progress("usage-updated", { spentTokens: 9 }),
      progress("usage-updated", {}),
    ]);
    expect(state?.runs[0]?.usage).toEqual({ spentTokens: 9, nodesUsed: 1 });
  });

  it("run-settled 落终态与错误文案，且错误按上限截断", () => {
    const progress = progressLog();
    const long = "长".repeat(WORKFLOW_RUNS_LIMITS.maxErrorLength + 50);
    const state = reduceAll([
      progress("run-started", started()),
      progress("run-settled", {
        status: "errored",
        error: { code: "ReportCapExceeded", message: long },
      }),
    ]);
    expect(state?.runs[0]?.status).toBe("errored");
    expect(state?.runs[0]?.error).toHaveLength(WORKFLOW_RUNS_LIMITS.maxErrorLength);
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  // Fix rationale (2026-09-15): words outside the closed set used to be "always ignored", so a pre-2026-09-14 journal's
  // run-settled{cancelled|failed} left the run in running after cold replay. Once settled, a run must not still be alive.
  it("run-settled 的未知 status → errored 落终态，文案说明是哪个词，不亮 Resume", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("run-settled", { status: "exploded" }),
    ]);
    expect(state?.runs[0]?.status).toBe("errored");
    expect(state?.runs[0]?.error).toContain("exploded");
    expect(state?.runs[0]?.resumable).toBeUndefined();
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  it.each(["cancelled", "failed"] as const)(
    "旧词表 run-settled{%s}（2026-09-14 之前的 journal）→ errored，保留事件自带的文案",
    (status) => {
      const progress = progressLog();
      const state = reduceAll([
        progress("run-started", started()),
        progress("run-settled", { status, error: { code: "DriverError", message: "old words" } }),
      ]);
      expect(state?.runs[0]?.status).toBe("errored");
      expect(state?.runs[0]?.error).toBe("old words");
    },
  );

  it("同 runId 再收 run-started：清掉上一世的 error 与 stopReason", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("run-settled", {
        status: "stopped",
        stopReason: "interrupted",
        error: { code: "Interrupted", message: "owner exited" },
      }),
      progress("run-started", started()),
    ]);
    expect(state?.runs).toHaveLength(1);
    expect(state?.runs[0]).toMatchObject({ runId: RUN_ID, status: "running" });
    expect(state?.runs[0]?.error).toBeUndefined();
    // 上一世的停止原因同属结算残影。
    expect(state?.runs[0]?.stopReason).toBeUndefined();
  });

  it("log / compaction 不进图，但仍抬 lastEventSequence（事件日志需要知道有新内容）", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("log", { message: "开始" }),
    ]);
    expect(state?.runs[0]?.nodes).toEqual([]);
    expect(state?.runs[0]?.actors).toEqual([]);
    expect(state?.runs[0]?.lastEventSequence).toBe(1);
  });

  it("缺 runId 或 eventType 的信封整条无效，返回 null", () => {
    expect(
      reduceWorkflowRunsState(undefined, { eventType: "run-started", sequence: 0 }),
    ).toBeNull();
    expect(reduceWorkflowRunsState(undefined, { runId: RUN_ID, sequence: 0 })).toBeNull();
  });

  it("无法定位的 instance / actor 不建条目，只抬水位", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      // ordinal absent → cannot locate.
      progress("node-queued", { instance: { siteId: "ask#1" }, kind: "ask" }),
      progress("actor-created", { actor: { ordinal: 1 }, name: "planner" }),
    ]);
    expect(state?.runs[0]?.nodes).toEqual([]);
    expect(state?.runs[0]?.actors).toEqual([]);
    expect(state?.runs[0]?.lastEventSequence).toBe(2);
  });

  // Bugfix 2026-09-04: a script assembled a 131-char subagent name from a file path, the reducer passed it through, but the
  // wire schema pins `actor.name` at 128 — so every frame after the parent session (online / recovery / initial) was rejected
  // by the renderer and the subscription died with fault.subscription.recoveryFailed. Producers must trim to the schema bound first.
  it("子代理名超过线上上界时按上界裁剪，归约结果始终通过 schema", () => {
    const progress = progressLog();
    const longName = `reader-${"sections-x.tex+".repeat(12)}`;
    expect(longName.length).toBeGreaterThan(WORKFLOW_RUNS_LIMITS.maxActorNameLength);
    const state = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 6 }, name: longName }),
      progress("escalation-raised", {
        qid: "q-1",
        question: "路径读不到",
        actor: { siteId: "actor#1", ordinal: 6 },
        actorName: longName,
      }),
    ]);
    const run = state?.runs[0];
    expect(run?.actors[0]?.name).toBe(longName.slice(0, WORKFLOW_RUNS_LIMITS.maxActorNameLength));
    expect(run?.pendingQuestions?.[0]?.actorName).toBe(
      longName.slice(0, WORKFLOW_RUNS_LIMITS.maxActorNameLength),
    );
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  it("首见事件不是 run-started 时条目落 pending（引擎事件流被截断的中途接入）", () => {
    const state = reduceWorkflowRunsState(undefined, {
      runId: RUN_ID,
      sequence: 7,
      eventType: "log",
      payload: { message: "中途接入" },
    });
    expect(state?.runs[0]).toMatchObject({ status: "pending", lastEventSequence: 7 });
    expect(state?.runs[0]).not.toHaveProperty("toolCallId");
  });

  it("toolCallId 只在首次出现时补齐，之后不被后续事件改写", () => {
    const first = step(undefined, {
      runId: RUN_ID,
      sequence: 0,
      eventType: "run-started",
      payload: started(),
    });
    expect(first.runs[0]).not.toHaveProperty("toolCallId");
    const withTool = step(first, {
      runId: RUN_ID,
      toolCallId: "tc-late",
      sequence: 1,
      eventType: "log",
      payload: {},
    });
    expect(withTool.runs[0]?.toolCallId).toBe("tc-late");
    const relabeled = step(withTool, {
      runId: RUN_ID,
      toolCallId: "tc-other",
      sequence: 2,
      eventType: "log",
      payload: {},
    });
    expect(relabeled.runs[0]?.toolCallId).toBe("tc-late");
  });
});

// Both ends of lineage (docs/dynamic-workflow/presentation.md "The run card"): `run-started` carries resumedFrom,
// `run-settled` carries supersededBy only when superseded; the reducer merely transports, both pass strict schemas.
describe("reduceWorkflowRunsState：lineage", () => {
  it("run-started 的 resumedFrom 与 run-settled 的 supersededBy 都进状态", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", { ...started(), resumedFrom: "dwfrun-prev" }),
      progress("run-settled", {
        status: "stopped",
        stopReason: "superseded",
        supersededBy: "dwfrun-next",
      }),
    ]);
    expect(state?.runs[0]).toMatchObject({
      status: "stopped",
      stopReason: "superseded",
      resumedFrom: "dwfrun-prev",
      supersededBy: "dwfrun-next",
    });
    // A superseded run is not resumable: the CLI sends no resumable, and none appears here either.
    expect(state?.runs[0]?.resumable).toBeUndefined();
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  it("supersededBy 只随 superseded 搬运；没有 lineage 的 run 两个键都缺席", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("run-settled", { status: "stopped", stopReason: "user", supersededBy: "dwfrun-x" }),
    ]);
    expect(state?.runs[0]?.supersededBy).toBeUndefined();
    expect(state?.runs[0]?.resumedFrom).toBeUndefined();
  });
});

// The resumable status bit (docs/dynamic-workflow/presentation.md "Cold replay"): the CLI decides by the resume gate on
// the run-settled payload and the reducer only transports — present only when true; UI and TUI never re-derive it from status.
describe("reduceWorkflowRunsState：resumable 状态位", () => {
  it("run-settled 携 resumable: true → 状态位在场，且过 strict schema", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("run-settled", {
        status: "stopped",
        stopReason: "interrupted",
        error: { code: "Interrupted", message: "owning process exited" },
        resumable: true,
      }),
    ]);
    expect(state?.runs[0]).toMatchObject({
      status: "stopped",
      stopReason: "interrupted",
      resumable: true,
    });
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  it("run-settled 不携该位（或携 false）→ 键缺席，哪怕 status 是 stopped", () => {
    const progress = progressLog();
    const stopped = reduceAll([
      progress("run-started", started()),
      progress("run-settled", { status: "stopped", stopReason: "user" }),
    ]);
    expect(stopped?.runs[0]?.resumable).toBeUndefined();
    const explicit = reduceAll([
      progress("run-started", started()),
      progress("run-settled", { status: "errored", resumable: false }),
    ]);
    expect(explicit?.runs[0]?.resumable).toBeUndefined();
  });

  // Stop reason (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md): transported only on stopped; outside the
  // closed set and on other terminal states it is always dropped — the reducer does not invent reasons for the CLI.
  it("run-settled 的 stopReason 只在 stopped 上搬运，且只收四个值", () => {
    const progress = progressLog();
    for (const stopReason of ["user", "model", "provider", "interrupted"] as const) {
      const state = reduceAll([
        progress("run-started", started()),
        progress("run-settled", { status: "stopped", stopReason, resumable: true }),
      ]);
      expect(state?.runs[0]).toMatchObject({ status: "stopped", stopReason });
      expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
    }
    const bogus = reduceAll([
      progress("run-started", started()),
      progress("run-settled", { status: "stopped", stopReason: "crash" }),
    ]);
    expect(bogus?.runs[0]?.status).toBe("stopped");
    expect(bogus?.runs[0]?.stopReason).toBeUndefined();
    const errored = reduceAll([
      progress("run-started", started()),
      progress("run-settled", { status: "errored", stopReason: "user" }),
    ]);
    expect(errored?.runs[0]?.stopReason).toBeUndefined();
  });

  it("run-stalled 是纯观察事件：不改 run 的任何状态键", () => {
    const progress = progressLog();
    const before = reduceAll([progress("run-started", started())]);
    const after = reduceAll(
      [progress("run-stalled", { sinceMs: 1_200_000, reason: "rate_limited", cap: 2 })],
      before,
    );
    expect(after?.runs[0]?.status).toBe("running");
    expect(workflowRunsStateSchema.safeParse(after).success).toBe(true);
  });

  it("同 runId 再收 run-started（resume 开跑）→ 上一世的 resumable 随 error 一起清掉", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("run-settled", { status: "stopped", stopReason: "user", resumable: true }),
      progress("run-started", started()),
    ]);
    expect(state?.runs[0]).toMatchObject({ status: "running" });
    expect(state?.runs[0]?.resumable).toBeUndefined();
  });
});

describe("reduceWorkflowRunsState：派生 actor 状态", () => {
  it("actor 状态由自己名下节点的相位派生（有在飞节点 → running）", () => {
    // Boundary C emits no actor lifecycle events besides actor-created, so status can only be derived.
    const progress = progressLog();
    const created = reduceAll([
      progress("run-started", started()),
      progress(
        "actor-created",
        { actor: { siteId: "actor#1", ordinal: 1 }, name: "planner" },
        { actorSessionId: "sess_dwf-1-actor.1" },
      ),
    ]);
    expect(created?.runs[0]?.actors).toEqual([
      {
        siteId: "actor#1",
        ordinal: 1,
        name: "planner",
        sessionId: "sess_dwf-1-actor.1",
        // Created but never asked, run not terminal: waiting (decision 39).
        status: "waiting",
      },
    ]);

    const dispatched = reduceAll(
      [
        progress("node-queued", {
          instance: { siteId: "ask#1", ordinal: 1 },
          kind: "ask",
          actor: { siteId: "actor#1", ordinal: 1 },
        }),
        progress("node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 } }),
      ],
      created,
    );
    // dispatched only means "session ready, first request not yet admitted": still waiting; actually running is said by node-executing.
    expect(dispatched?.runs[0]?.actors[0]?.status).toBe("waiting");

    const executing = reduceAll(
      [progress("node-executing", { instance: { siteId: "ask#1", ordinal: 1 } })],
      dispatched,
    );
    expect(executing?.runs[0]?.actors[0]?.status).toBe("running");

    const settled = reduceAll(
      [progress("node-settled", { instance: { siteId: "ask#1", ordinal: 1 }, outcome: "ok" })],
      executing,
    );
    expect(settled?.runs[0]?.actors[0]?.status).toBe("completed");
  });

  it("executing / repairing / nudged 算在跑；queued / dispatched / waiting 算在等", () => {
    const progress = progressLog();
    const base = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 1 } }),
      progress("node-queued", {
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
      }),
    ]);
    expect(base?.runs[0]?.actors[0]?.status).toBe("waiting");
    for (const phase of ["executing", "repairing", "nudged"] as const) {
      const busy = reduceAll(
        [progress(`node-${phase}`, { instance: { siteId: "ask#1", ordinal: 1 } })],
        base,
      );
      expect(busy?.runs[0]?.actors[0]?.status).toBe("running");
    }
    for (const phase of ["dispatched", "waiting"] as const) {
      const idle = reduceAll(
        [progress(`node-${phase}`, { instance: { siteId: "ask#1", ordinal: 1 } })],
        base,
      );
      expect(idle?.runs[0]?.actors[0]?.status).toBe("waiting");
    }
  });

  it("失败的 ask 也是「干完了」：completed 不区分 outcome（结果在节点上）", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 1 } }),
      progress("node-queued", {
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
      }),
      progress("node-executing", { instance: { siteId: "ask#1", ordinal: 1 } }),
      progress("node-settled", { instance: { siteId: "ask#1", ordinal: 1 }, outcome: "failed" }),
    ]);
    expect(state?.runs[0]?.actors[0]?.status).toBe("completed");
  });

  it("run 终态让每个 actor 都变 completed——包括建了却从未被 ask 的、和节点还挂在 queued 上的", () => {
    const progress = progressLog();
    const running = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 1 } }),
      progress("actor-created", { actor: { siteId: "actor#2", ordinal: 1 } }),
      progress("node-queued", {
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
      }),
    ]);
    expect(running?.runs[0]?.actors.map((actor) => actor.status)).toEqual(["waiting", "waiting"]);
    for (const status of ["completed", "errored", "stopped"] as const) {
      const settled = reduceAll([progress("run-settled", { status })], running);
      expect(settled?.runs[0]?.actors.map((actor) => actor.status)).toEqual([
        "completed",
        "completed",
      ]);
    }
  });

  it("无 actor 归属的节点（world-read）不会把任何 actor 点亮", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 1 } }),
      progress("node-executing", { instance: { siteId: "world-read#1", ordinal: 1 } }),
    ]);
    expect(state?.runs[0]?.actors[0]?.status).toBe("waiting");
  });

  it("同 siteId 的不同 ordinal 是不同 actor：一个在飞不点亮另一个", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 1 } }),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 2 } }),
      progress("node-executing", {
        instance: { siteId: "ask#1", ordinal: 1 },
        actor: { siteId: "actor#1", ordinal: 2 },
      }),
    ]);
    expect(state?.runs[0]?.actors.map((actor) => [actor.ordinal, actor.status])).toEqual([
      [1, "waiting"],
      [2, "running"],
    ]);
  });

  it("派生键有分隔符：(a,12) 与 (a1,2) 是两个 actor，不互相点亮", () => {
    // This pair is the minimal counterexample where **naive concatenation collides**: "a"+12 and "a1"+2 both equal "a12".
    // The reducer keys on `${siteId}\0${ordinal}` (keeping the original implementation's NUL-separator semantics when moved,
    // writing the raw NUL byte as the escaped `\0` — the same runtime character. The same-siteId case above would pass with any
    // separator, even none, so what truly pins the separator's existence is this one).
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: { siteId: "a", ordinal: 12 } }),
      progress("actor-created", { actor: { siteId: "a1", ordinal: 2 } }),
      // Only ("a1", 2) owns a running node.
      progress("node-executing", {
        instance: { siteId: "ask#1", ordinal: 1 },
        actor: { siteId: "a1", ordinal: 2 },
      }),
    ]);
    expect(
      state?.runs[0]?.actors.map((actor) => [actor.siteId, actor.ordinal, actor.status]),
    ).toEqual([
      ["a", 12, "waiting"],
      ["a1", 2, "running"],
    ]);
  });
});

describe("reduceWorkflowRunsState：有界化与淘汰", () => {
  it("nodes 触上限置 truncated 且不再增长，但已在表内的实例仍可更新相位", () => {
    const progress = progressLog();
    let state: WorkflowRunsState | undefined = step(undefined, progress("run-started", started()));
    for (let ordinal = 1; ordinal <= WORKFLOW_RUNS_LIMITS.maxNodes + 5; ordinal += 1) {
      state = reduceAll(
        [progress("node-queued", { instance: { siteId: "ask#1", ordinal }, kind: "ask" })],
        state,
      );
    }
    expect(state?.runs[0]?.nodes).toHaveLength(WORKFLOW_RUNS_LIMITS.maxNodes);
    expect(state?.runs[0]?.truncated).toBe(true);

    // Over the bound only **new** instances are rejected: freezing a running instance at queued is more misleading than listing one fewer.
    const updated = reduceAll(
      [progress("node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 } })],
      state,
    );
    expect(updated?.runs[0]?.nodes[0]?.phase).toBe("dispatched");
    expect(workflowRunsStateSchema.safeParse(updated).success).toBe(true);
  });

  it("actors 触上限同样置 truncated，且 truncated 一旦置位不再回落", () => {
    const progress = progressLog();
    let state: WorkflowRunsState | undefined = step(undefined, progress("run-started", started()));
    for (let ordinal = 1; ordinal <= WORKFLOW_RUNS_LIMITS.maxActors + 2; ordinal += 1) {
      state = reduceAll(
        [progress("actor-created", { actor: { siteId: "actor#1", ordinal } })],
        state,
      );
    }
    expect(state?.runs[0]?.actors).toHaveLength(WORKFLOW_RUNS_LIMITS.maxActors);
    expect(state?.runs[0]?.truncated).toBe(true);

    const later = reduceAll(
      [progress("node-queued", { instance: { siteId: "ask#1", ordinal: 1 }, kind: "ask" })],
      state,
    );
    expect(later?.runs[0]?.truncated).toBe(true);
  });

  it("runs ≤ maxRuns 且按最旧淘汰（终态事实仍在 journal）", () => {
    let state: WorkflowRunsState | undefined;
    const total = WORKFLOW_RUNS_LIMITS.maxRuns + 3;
    for (let index = 0; index < total; index += 1) {
      state = step(state, {
        runId: `dwfrun-${index}`,
        sequence: 0,
        eventType: "run-started",
        payload: { runId: `dwfrun-${index}`, caps: { maxConcurrency: 1 } },
      });
    }
    expect(state?.runs).toHaveLength(WORKFLOW_RUNS_LIMITS.maxRuns);
    expect(state?.runs.map((run) => run.runId)).toEqual(
      Array.from({ length: WORKFLOW_RUNS_LIMITS.maxRuns }, (_, offset) => `dwfrun-${offset + 3}`),
    );
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  it("被淘汰的 run 再来事件时作为新条目回到队尾（不复活旧事实）", () => {
    let state: WorkflowRunsState | undefined;
    for (let index = 0; index < WORKFLOW_RUNS_LIMITS.maxRuns + 1; index += 1) {
      state = step(state, {
        runId: `dwfrun-${index}`,
        sequence: 0,
        eventType: "run-started",
        payload: { runId: `dwfrun-${index}`, caps: { maxConcurrency: 1 } },
      });
    }
    expect(state?.runs.map((run) => run.runId)).not.toContain("dwfrun-0");
    const revived = reduceWorkflowRunsState(state, {
      runId: "dwfrun-0",
      sequence: 9,
      eventType: "log",
      payload: { message: "迟到的日志" },
    });
    expect(revived?.runs.at(-1)).toMatchObject({
      runId: "dwfrun-0",
      status: "pending",
      lastEventSequence: 9,
    });
    expect(revived?.runs).toHaveLength(WORKFLOW_RUNS_LIMITS.maxRuns);
  });
});

describe("reduceWorkflowRunsState：revision 与 sequence 单调", () => {
  it("每次有效变化抬一格 revision", () => {
    const progress = progressLog();
    const first = step(undefined, progress("run-started", started()));
    expect(first.revision).toBe(1);
    const second = step(
      first,
      progress("node-queued", { instance: { siteId: "ask#1", ordinal: 1 }, kind: "ask" }),
    );
    expect(second.revision).toBe(2);
    const third = step(
      second,
      progress("node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 } }),
    );
    expect(third.revision).toBe(3);
    expect(third.runs[0]?.lastEventSequence).toBe(2);
  });

  it("revision 承接传入态：非零起点继续抬，不重置", () => {
    const seeded: WorkflowRunsState = { revision: 41, runs: [] };
    const next = reduceWorkflowRunsState(seeded, {
      runId: RUN_ID,
      sequence: 0,
      eventType: "run-started",
      payload: started(),
    });
    expect(next?.revision).toBe(42);
  });

  it("lastEventSequence 单调：迟到/乱序事件仍归约内容，但水位不回退", () => {
    // Below the bound everything is **accepted as-is**: cold materialization feeds journal replay and online events into the same
    // reduction, and if an online event opens a run first its entire prefix lies below the watermark — dropping it would leave the
    // card empty. Tightening only happens on overflowed runs; see the next case.
    const state = reduceAll([
      { runId: RUN_ID, sequence: 5, eventType: "run-started", payload: started() },
      {
        runId: RUN_ID,
        sequence: 2,
        eventType: "node-queued",
        payload: { instance: { siteId: "ask#1", ordinal: 1 }, kind: "ask" },
      },
    ]);
    expect(state?.runs[0]?.lastEventSequence).toBe(5);
    expect(state?.runs[0]?.nodes).toHaveLength(1);
  });

  it("溢出过的 run 才收紧：水位之下的事件开不出新条目，但照常更新已有的", () => {
    // Rationale lives in admitsNewEntry: making room shortens the table, and a freed slot could let an instance already
    // counted in nodesUnlisted back in, leaving it both listed and counted.
    const progress = progressLog();
    const seeded = reduceAll([
      progress("run-started", started()),
      progress("node-queued", { instance: { siteId: "ask#1", ordinal: 1 }, kind: "ask" }),
    ])!;
    const overflowed: WorkflowRunsState = {
      ...seeded,
      runs: [{ ...seeded.runs[0]!, truncated: true }],
    };
    const late = (eventType: string, siteId: string) => ({
      runId: RUN_ID,
      sequence: 1,
      eventType,
      payload: { instance: { siteId, ordinal: 1 }, kind: "ask" },
    });
    const updated = reduceWorkflowRunsState(overflowed, late("node-executing", "ask#1"))!;
    expect(updated.runs[0]?.nodes.map((node) => node.phase)).toEqual(["executing"]);
    const ignored = reduceWorkflowRunsState(updated, late("node-queued", "ask#2"));
    expect(ignored).toBeNull();
  });

  it("sequence 缺席按 0 处理，且不会把已有水位拉低", () => {
    const state = reduceAll([
      { runId: RUN_ID, sequence: 3, eventType: "run-started", payload: started() },
      { runId: RUN_ID, eventType: "log", payload: {} },
    ]);
    expect(state?.runs[0]?.lastEventSequence).toBe(3);
  });
});

describe("reduceWorkflowRunsState：幂等重放", () => {
  it("同一条事件重放返回 null：不抬 revision、不改状态", () => {
    const progress = progressLog();
    const settle = progress("node-settled", {
      instance: { siteId: "ask#1", ordinal: 1 },
      outcome: "ok",
    });
    const state = reduceAll([progress("run-started", started()), settle]);
    expect(reduceWorkflowRunsState(state, settle)).toBeNull();
  });

  it("每一条事件在它自己刚归约完之后立刻重放都是 no-op（逐步幂等）", () => {
    // Idempotence is scoped to "the event that just arrived": the journal delivers in order, retransmission only retransmits the tail.
    const progress = progressLog();
    const events = [
      progress("run-started", started()),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 1 }, name: "planner" }),
      progress("node-queued", {
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
      }),
      progress("node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 } }),
      progress("usage-updated", { spentTokens: 12 }),
      progress("run-settled", { status: "completed" }),
    ];
    let state: WorkflowRunsState | undefined;
    for (const event of events) {
      state = reduceWorkflowRunsState(state, event) ?? state;
      expect(reduceWorkflowRunsState(state, event)).toBeNull();
    }
    expect(state?.revision).toBe(events.length);
  });

  it("整串事件从终态再跑一遍不是 no-op：run-started 就是重开一世（记录在案）", () => {
    // Idempotence does **not** extend to out-of-order / whole-stream replay: run-started clears settlement residue and pulls the run
    // back to running, and node-queued has no phase-monotonic guard, so it would drag an already-dispatched node back to queued.
    // Ordered journal delivery keeps both from happening in production; they are pinned here so no one later assumes a guard exists.
    const progress = progressLog();
    const events = [
      progress("run-started", started()),
      progress("node-queued", { instance: { siteId: "ask#1", ordinal: 1 }, kind: "ask" }),
      progress("node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 } }),
      progress("run-settled", { status: "completed" }),
    ];
    const once = reduceAll(events)!;
    expect(once.runs[0]?.status).toBe("completed");

    const replayed = reduceAll(events, once)!;
    expect(replayed.runs[0]?.status).toBe("completed");
    expect(replayed.revision).toBe(once.revision + events.length);
    // The watermark is the only quantity with a monotonic guard: even a whole-stream replay cannot pull it back.
    expect(replayed.runs[0]?.lastEventSequence).toBe(once.runs[0]?.lastEventSequence);
  });
});

// ── Escalations (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md) ──────────────────────────────
// Two events maintain one "who is still owed an answer" table: raised adds, resolved removes. Identity is the qid
// (globally unique, across runs), not a site instance — escalations have no site identity, write no dwf_node row, and consume no maxNodes.
describe("reduceWorkflowRunsState：升级问答", () => {
  const ASKED_AT = 1_756_000_000_000;
  const raised = (overrides: Record<string, unknown> = {}) => ({
    qid: "dwfq-dwfrun1-1",
    actor: { siteId: "actor#1", ordinal: 1 },
    actorName: "poet",
    question: "评分上限是 95，但通过门槛是 96，这个门是不是坏了？",
    askedAt: ASKED_AT,
    ...overrides,
  });

  it("escalation-raised 建一条停驻问题（qid 为键，actor 身份、名字与提问时刻随事件带上）", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("escalation-raised", raised({ context: "已经试过 4 轮，最高分 95。" })),
    ]);
    expect(state?.runs[0]?.pendingQuestions).toEqual([
      {
        qid: "dwfq-dwfrun1-1",
        actorSiteId: "actor#1",
        actorOrdinal: 1,
        actorName: "poet",
        question: "评分上限是 95，但通过门槛是 96，这个门是不是坏了？",
        context: "已经试过 4 轮，最高分 95。",
        // The ask time can only come from the event — this module is a pure reduction with no clock available.
        askedAt: ASKED_AT,
      },
    ]);
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  it("askedAt 缺席（老 journal 重放出的事件）时字段整个不落，其余照常成条", () => {
    // The event-side askedAt is required, but a journal from an older dev machine may replay events from before the field was added.
    // Absence is not an error: the renderer hides the wait duration accordingly instead of inventing a "just now".
    const progress = progressLog();
    const { askedAt: _legacy, ...preAmendment } = raised();
    const state = reduceAll([
      progress("run-started", started()),
      progress("escalation-raised", preAmendment),
    ]);
    const pending = state?.runs[0]?.pendingQuestions?.[0];
    expect(pending).not.toHaveProperty("askedAt");
    expect(pending?.question).toBe("评分上限是 95，但通过门槛是 96，这个门是不是坏了？");
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  it("askedAt 不是有限数时按缺席处理，不把 NaN / Infinity 落进状态", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("escalation-raised", raised({ qid: "dwfq-nan", askedAt: Number.NaN })),
      progress("escalation-raised", raised({ qid: "dwfq-inf", askedAt: Number.POSITIVE_INFINITY })),
      progress("escalation-raised", raised({ qid: "dwfq-str", askedAt: "刚刚" })),
    ]);
    for (const pending of state?.runs[0]?.pendingQuestions ?? []) {
      expect(pending).not.toHaveProperty("askedAt");
    }
    // JSON cannot carry NaN/Infinity; letting them in would turn the whole frame patch into null on the wire.
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  it("匿名 actor 与无补充说明时字段整个缺席，不落空串", () => {
    // The event side deliberately does not synthesize fallback labels (engine/types.ts's actorName comment), and the reduction does not invent one:
    // rendering "unnamed" is the consumer's decision.
    const progress = progressLog();
    const { actorName: _anonymous, ...anonymous } = raised();
    const state = reduceAll([
      progress("run-started", started()),
      progress("escalation-raised", anonymous),
    ]);
    const pending = state?.runs[0]?.pendingQuestions?.[0];
    expect(pending).not.toHaveProperty("actorName");
    expect(pending).not.toHaveProperty("context");
    expect(pending?.qid).toBe("dwfq-dwfrun1-1");
  });

  it("actor ref 读不动时**仍然**建条目：身份是 qid，actor 只是属性", () => {
    // Deliberately unlike the node/actor tables (where an unlocatable ref means no entry): hiding a question over a broken
    // ref would destroy the one fallback value "a stuck question must stay visible".
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("escalation-raised", raised({ actor: { siteId: "actor#1" } })),
    ]);
    const pending = state?.runs[0]?.pendingQuestions?.[0];
    expect(pending?.qid).toBe("dwfq-dwfrun1-1");
    expect(pending).not.toHaveProperty("actorSiteId");
    expect(pending).not.toHaveProperty("actorOrdinal");
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  it("缺 qid 或 question 的事件不建条目，只抬水位", () => {
    const progress = progressLog();
    const { qid: _noQid, ...withoutQid } = raised();
    const { question: _noQuestion, ...withoutQuestion } = raised();
    const state = reduceAll([
      progress("run-started", started()),
      progress("escalation-raised", withoutQid),
      progress("escalation-raised", withoutQuestion),
    ]);
    expect(state?.runs[0]?.pendingQuestions).toBeUndefined();
    expect(state?.runs[0]?.lastEventSequence).toBe(2);
  });

  it("升级不进图也不动 actor 状态：不写节点、不计步（等待不是工作量）", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 1 }, name: "poet" }),
      progress("node-queued", {
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
      }),
      progress("node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 } }),
      progress("node-executing", { instance: { siteId: "ask#1", ordinal: 1 } }),
      progress("escalation-raised", raised()),
    ]);
    expect(state?.runs[0]?.nodes).toHaveLength(1);
    // That ask's dispatch already counted a step; the escalation adds no more.
    expect(state?.runs[0]?.usage.nodesUsed).toBe(1);
    // The asking actor is still running — its ask is still executing; being parked does not mean idle.
    expect(state?.runs[0]?.actors[0]?.status).toBe("running");
  });

  it("同一条 raised 重放是 no-op（按 qid upsert，不是 push）", () => {
    const progress = progressLog();
    const event = progress("escalation-raised", raised());
    const state = reduceAll([progress("run-started", started()), event]);
    expect(state?.runs[0]?.pendingQuestions).toHaveLength(1);
    expect(reduceWorkflowRunsState(state, event)).toBeNull();
  });

  it("escalation-resolved 划掉对应那条，最后一条走后整个键缺席（不留空数组）", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("escalation-raised", raised()),
      progress("escalation-resolved", { qid: "dwfq-dwfrun1-1", answer: "门确实坏了，跳过它。" }),
    ]);
    // "Zero entries ⇒ key absent" is a protocol convention: the sidebar skips the whole section accordingly instead of leaving an empty shell.
    expect(state?.runs[0]).not.toHaveProperty("pendingQuestions");
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  it("多个问题并存时 resolve 只动对应那条（一轮里可以并行发出几个 escalate）", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("escalation-raised", raised({ qid: "dwfq-a" })),
      progress(
        "escalation-raised",
        raised({ qid: "dwfq-b", actorName: "critic", question: "用哪版风格指南？" }),
      ),
      progress("escalation-raised", raised({ qid: "dwfq-c" })),
      progress("escalation-resolved", { qid: "dwfq-b", answer: "用 v2。" }),
    ]);
    expect(state?.runs[0]?.pendingQuestions?.map((pending) => pending.qid)).toEqual([
      "dwfq-a",
      "dwfq-c",
    ]);
  });

  it("resolve 一个不在表里的 qid 不动那张表，只抬水位（与 log 同族）", () => {
    // qids are globally unique (across runs), so a resolved event serialized onto the wrong run necessarily finds no entry. It is still an
    // event that arrived, so the watermark advances — "no change" only holds for **content** (the idempotence case is the next one).
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("escalation-raised", raised()),
    ]);
    const next = reduceWorkflowRunsState(state, {
      runId: RUN_ID,
      toolCallId: "tc-1",
      sequence: 9,
      eventType: "escalation-resolved",
      payload: { qid: "dwfq-别的-run", answer: "无关" },
    });
    expect(next?.runs[0]?.pendingQuestions?.map((pending) => pending.qid)).toEqual([
      "dwfq-dwfrun1-1",
    ]);
    expect(next?.runs[0]?.lastEventSequence).toBe(9);
  });

  it("同一条 resolved 重放是 no-op：不抬 revision、不改状态", () => {
    // When replaying the same event the sequence matches too, so the watermark does not move and the whole run is byte-identical → null.
    // This is where "idempotent" actually lands (ordered journal delivery; retransmission only retransmits the tail).
    const progress = progressLog();
    const parked = reduceAll([
      progress("run-started", started()),
      progress("escalation-raised", raised()),
    ]);
    const resolve = progress("escalation-resolved", {
      qid: "dwfq-dwfrun1-1",
      answer: "门确实坏了，跳过它。",
    });
    const state = reduceAll([resolve], parked);
    expect(state?.runs[0]).not.toHaveProperty("pendingQuestions");
    expect(reduceWorkflowRunsState(state, resolve)).toBeNull();
  });

  it("run 从没有过停驻问题时，resolved 不凭空造出一个空数组", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("escalation-resolved", { qid: "dwfq-dwfrun1-1", answer: "…" }),
    ]);
    expect(state?.runs[0]).not.toHaveProperty("pendingQuestions");
  });

  it.each(["completed", "errored", "stopped"] as const)(
    "run-settled（%s）清空停驻问题：终态 run 没有在听的人",
    (status) => {
      // The truth is the in-process parked deferreds. On cancel they are rejected with cancelAsk; if the process dies the whole
      // registry disappears — a `resolved` event will never come. Keeping them would display a question that can never be answered.
      const progress = progressLog();
      const state = reduceAll([
        progress("run-started", started()),
        progress("escalation-raised", raised()),
        progress("run-settled", { status }),
      ]);
      expect(state?.runs[0]?.status).toBe(status);
      expect(state?.runs[0]).not.toHaveProperty("pendingQuestions");
    },
  );

  it("停止后重新开始，可以用新 qid 建立停驻问题", () => {
    // 新的一世里那个 ask 会重跑、actor 重新提问、得一个新 qid；旧的留着只会是永远等不到
    // 答案、也再没有人在等它的残影。
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("escalation-raised", raised()),
      progress("run-settled", { status: "stopped", stopReason: "user" }),
      progress("run-started", started()),
      progress("escalation-raised", raised({ qid: "dwfq-dwfrun1-2" })),
    ]);
    expect(state?.runs[0]?.status).toBe("running");
    expect(state?.runs[0]?.pendingQuestions?.map((pending) => pending.qid)).toEqual([
      "dwfq-dwfrun1-2",
    ]);
  });

  it("触上限置 truncated 且不再增长，但表内已有的 qid 仍可被更新与划掉", () => {
    const progress = progressLog();
    let state: WorkflowRunsState | undefined = step(undefined, progress("run-started", started()));
    for (let index = 1; index <= WORKFLOW_RUNS_LIMITS.maxPendingQuestions + 3; index += 1) {
      state = reduceAll([progress("escalation-raised", raised({ qid: `dwfq-${index}` }))], state);
    }
    expect(state?.runs[0]?.pendingQuestions).toHaveLength(WORKFLOW_RUNS_LIMITS.maxPendingQuestions);
    expect(state?.runs[0]?.truncated).toBe(true);
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);

    const resolved = reduceAll(
      [progress("escalation-resolved", { qid: "dwfq-1", answer: "好" })],
      state,
    );
    expect(resolved?.runs[0]?.pendingQuestions).toHaveLength(
      WORKFLOW_RUNS_LIMITS.maxPendingQuestions - 1,
    );
  });

  it("超长问题按上限截断，产出仍过 strict schema", () => {
    const progress = progressLog();
    const long = "问".repeat(WORKFLOW_RUNS_LIMITS.maxQuestionLength + 50);
    const state = reduceAll([
      progress("run-started", started()),
      progress("escalation-raised", raised({ question: long, context: long })),
    ]);
    const pending = state?.runs[0]?.pendingQuestions?.[0];
    expect(pending?.question).toHaveLength(WORKFLOW_RUNS_LIMITS.maxQuestionLength);
    // The ellipsis makes truncation visible in the UI (same idiom as the report preview).
    expect(pending?.question.endsWith("…")).toBe(true);
    expect(pending?.context).toHaveLength(WORKFLOW_RUNS_LIMITS.maxQuestionLength);
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });
});

describe("reduceWorkflowRunsState：纯度", () => {
  it("不改动传入态（新态是新对象，旧态逐字节不变）", () => {
    const progress = progressLog();
    const before = reduceAll([progress("run-started", started())])!;
    const frozen = JSON.parse(JSON.stringify(before)) as WorkflowRunsState;
    const after = reduceWorkflowRunsState(
      before,
      progress("node-queued", {
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
      }),
    );
    expect(before).toEqual(frozen);
    expect(after).not.toBe(before);
    expect(after?.runs[0]).not.toBe(before.runs[0]);
  });

  it("payload 非 record 时退化成空 payload，不抛", () => {
    const state = reduceWorkflowRunsState(undefined, {
      runId: RUN_ID,
      sequence: 0,
      eventType: "run-started",
      payload: undefined,
    });
    expect(state?.runs[0]).toMatchObject({
      status: "running",
      usage: { spentTokens: 0, nodesUsed: 0 },
    });
  });
});

// ── Adaptive concurrency (docs/dynamic-workflow/concurrency.md "Protocol and UI"): the node-waiting / node-executing /
// concurrency-changed observation events. They are the same family as escalations — the engine makes no decisions from
// them; they are facts observed by the driver / governor recorded via record(); the reduction likewise only "writes it down" and derives no clocks.
describe("reduceWorkflowRunsState：自适应并发", () => {
  const ASK = { siteId: "ask#1", ordinal: 1 };
  const ACTOR = { siteId: "actor#1", ordinal: 1 };

  function dispatchedState() {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: ACTOR, name: "planner" }),
      progress("node-queued", { instance: ASK, kind: "ask", actor: ACTOR, actorSeq: 1 }),
      progress("node-dispatched", { instance: ASK }),
    ]);
    return { progress, state };
  }

  it("node-executing：相位 executing、actor running，过 strict schema", () => {
    const { progress, state } = dispatchedState();
    const next = step(state, progress("node-executing", { instance: ASK }));
    expect(next.runs[0]?.nodes[0]).toEqual({
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      phase: "executing",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
    });
    expect(next.runs[0]?.actors[0]?.status).toBe("running");
    expect(() => workflowRunsStateSchema.parse(next)).not.toThrow();
  });

  it("node-waiting（slot / backoff）：相位 waiting、actor waiting；载荷细节不进状态（只在事件日志）", () => {
    const { progress, state } = dispatchedState();
    for (const payload of [
      { instance: ASK, cause: "slot" },
      {
        instance: ASK,
        cause: "backoff",
        reason: "rate_limited",
        attempt: 2,
        delayMs: 20_000,
        retryAfterMs: 20_000,
      },
    ]) {
      const next = step(
        step(state, progress("node-executing", { instance: ASK })),
        progress("node-waiting", payload),
      );
      expect(next.runs[0]?.nodes[0]).toEqual({
        siteId: "ask#1",
        ordinal: 1,
        kind: "ask",
        phase: "waiting",
        actorSiteId: "actor#1",
        actorOrdinal: 1,
      });
      expect(next.runs[0]?.actors[0]?.status).toBe("waiting");
      expect(() => workflowRunsStateSchema.parse(next)).not.toThrow();
    }
  });

  it("waiting → executing → settled：来回切换后结算，actor 走 waiting → running → completed", () => {
    const { progress, state } = dispatchedState();
    const waiting = step(state, progress("node-waiting", { instance: ASK, cause: "slot" }));
    expect(waiting.runs[0]?.actors[0]?.status).toBe("waiting");
    const executing = step(waiting, progress("node-executing", { instance: ASK }));
    expect(executing.runs[0]?.nodes[0]).toMatchObject({ phase: "executing" });
    expect(executing.runs[0]?.actors[0]?.status).toBe("running");
    const settled = step(executing, progress("node-settled", { instance: ASK, outcome: "ok" }));
    expect(settled.runs[0]?.nodes[0]).toMatchObject({ phase: "settled", outcome: "ok" });
    expect(settled.runs[0]?.actors[0]?.status).toBe("completed");
  });

  it("concurrency-changed：cap=next，ceiling 取见过的最大 previous/next，cooldownMs 与 key 透传", () => {
    const { progress, state } = dispatchedState();
    const next = step(
      state,
      progress("concurrency-changed", {
        key: "anthropic/claude-x",
        previous: 14,
        next: 7,
        reason: "rate_limited",
        cooldownMs: 20_000,
      }),
    );
    expect(next.runs[0]?.concurrency).toEqual({
      key: "anthropic/claude-x",
      cap: 7,
      ceiling: 14,
      cooldownMs: 20_000,
    });
    expect(() => workflowRunsStateSchema.parse(next)).not.toThrow();
  });

  it("ceiling 只升不降：后续 recovered 事件把 cap 抬回去时 ceiling 不变；无 Retry-After 的减半不带 cooldownMs", () => {
    const { progress, state } = dispatchedState();
    const halved = step(
      state,
      progress("concurrency-changed", { key: "k", previous: 14, next: 7, reason: "rate_limited" }),
    );
    expect(halved.runs[0]?.concurrency).toEqual({ key: "k", cap: 7, ceiling: 14 });
    const recovered = step(
      halved,
      progress("concurrency-changed", { key: "k", previous: 7, next: 8, reason: "recovered" }),
    );
    expect(recovered.runs[0]?.concurrency).toEqual({ key: "k", cap: 8, ceiling: 14 });
  });

  it("idle_reset 清掉冷却：桶回到天花板不是冷却", () => {
    const { progress, state } = dispatchedState();
    const cooled = step(
      state,
      progress("concurrency-changed", {
        key: "k",
        previous: 14,
        next: 7,
        reason: "rate_limited",
        cooldownMs: 60_000,
      }),
    );
    const reset = step(
      cooled,
      progress("concurrency-changed", {
        key: "k",
        previous: 7,
        next: 14,
        reason: "idle_reset",
        cooldownMs: 1,
      }),
    );
    expect(reset.runs[0]?.concurrency).toEqual({ key: "k", cap: 14, ceiling: 14 });
  });

  it("run-settled 摘掉 cooldownMs、保留 cap/ceiling（历史事实）", () => {
    const { progress, state } = dispatchedState();
    const cooled = step(
      state,
      progress("concurrency-changed", {
        previous: 14,
        next: 7,
        reason: "provider_overloaded",
        cooldownMs: 60_000,
      }),
    );
    const settled = step(cooled, progress("run-settled", { status: "completed" }));
    expect(settled.runs[0]?.concurrency).toEqual({ cap: 7, ceiling: 14 });
  });

  it("concurrency-changed 不碰 nodes / actors，next 读不动时只抬水位", () => {
    const { progress, state } = dispatchedState();
    const before = state!.runs[0]!;
    const next = step(
      state,
      progress("concurrency-changed", { previous: 14, next: 7, reason: "rate_limited" }),
    );
    expect(next.runs[0]?.nodes).toEqual(before.nodes);
    expect(next.runs[0]?.actors).toEqual(before.actors);
    const malformed = step(next, progress("concurrency-changed", { previous: 7, next: "x" }));
    expect(malformed.runs[0]?.concurrency).toEqual(next.runs[0]?.concurrency);
    expect(malformed.runs[0]?.lastEventSequence).toBeGreaterThan(next.runs[0]!.lastEventSequence);
  });

  it("幂等：同一条 node-waiting / concurrency-changed 重放得到 null", () => {
    const { progress, state } = dispatchedState();
    const waitingEvent = progress("node-waiting", { instance: ASK, cause: "slot" });
    const once = step(state, waitingEvent);
    expect(reduceWorkflowRunsState(once, waitingEvent)).toBeNull();
    const changeEvent = progress("concurrency-changed", {
      previous: 14,
      next: 7,
      reason: "rate_limited",
      cooldownMs: 5_000,
    });
    const changed = step(once, changeEvent);
    expect(reduceWorkflowRunsState(changed, changeEvent)).toBeNull();
  });

  // ── This run's own bound (docs/dynamic-workflow/concurrency.md "Two bounds on a run") ──
  // The `run-started` payload carries the engine's `caps.maxConcurrency` and the default concurrency D at the moment the CLI
  // forged the payload (the wire key `concurrencyCeiling` predates "default concurrency" and is kept for old-client compatibility).
  // The two bounds are unrelated: the governor squeezes the shared bucket, the user sets this one — above or below D, either is fine.

  const LIMITED = { ...started({ maxConcurrency: 3 }), concurrencyCeiling: 8 };

  it("run-started：maxConcurrency 低于默认时落 limit，共享 cap 从默认起步", () => {
    const progress = progressLog();
    const state = step(undefined, progress("run-started", LIMITED));
    expect(state.runs[0]?.concurrency).toEqual({ cap: 8, ceiling: 8, limit: 3 });
    expect(() => workflowRunsStateSchema.parse(state)).not.toThrow();
  });

  it.each([
    ["跑在默认上", { ...started({ maxConcurrency: 8 }), concurrencyCeiling: 8 }],
    ["老 CLI 不发默认", started({ maxConcurrency: 3 })],
    ["maxConcurrency 读不动", { ...started({ maxConcurrency: 0 }), concurrencyCeiling: 8 }],
    ["天花板读不动", { ...started({ maxConcurrency: 3 }), concurrencyCeiling: "8" }],
    ["caps 整块读不动", { caps: "nope", concurrencyCeiling: 8, runId: RUN_ID }],
  ])("%s：整个 concurrency 键缺席（没有可显示的东西）", (_case, payload) => {
    const state = step(undefined, progressLog()("run-started", payload));
    expect(state.runs[0]).not.toHaveProperty("concurrency");
  });

  it("run-started：maxConcurrency 高于默认同样落 limit——默认是起点不是上限", () => {
    const progress = progressLog();
    const state = step(
      undefined,
      progress("run-started", { ...started({ maxConcurrency: 20 }), concurrencyCeiling: 8 }),
    );
    expect(state.runs[0]?.concurrency).toEqual({ cap: 8, ceiling: 8, limit: 20 });
    expect(() => workflowRunsStateSchema.parse(state)).not.toThrow();
  });

  it("默认已知时 concurrency.ceiling 就是 D：共享桶长到 D 之上也不抬它", () => {
    const progress = progressLog();
    const state = step(
      undefined,
      progress("run-started", { ...started({ maxConcurrency: 20 }), concurrencyCeiling: 8 }),
    );
    const grown = step(
      state,
      progress("concurrency-changed", { key: "k", previous: 11, next: 12, reason: "recovered" }),
    );
    expect(grown.runs[0]?.concurrency).toEqual({ key: "k", cap: 12, ceiling: 8, limit: 20 });
    const lowered = step(
      grown,
      progress("concurrency-changed", { key: "k", previous: 12, next: 9, reason: "limit_lowered" }),
    );
    expect(lowered.runs[0]?.concurrency).toEqual({ key: "k", cap: 9, ceiling: 8, limit: 20 });
    // Runs at default are the same: the ceiling is no longer "the largest cap ever seen".
    const plain = progressLog();
    const atDefault = step(
      undefined,
      plain("run-started", { ...started({ maxConcurrency: 8 }), concurrencyCeiling: 8 }),
    );
    const cut = step(
      atDefault,
      plain("concurrency-changed", { key: "k", previous: 14, next: 10, reason: "rate_limited" }),
    );
    expect(cut.runs[0]?.concurrency).toEqual({ key: "k", cap: 10, ceiling: 8 });
  });

  it("concurrency-changed 照搬 limit：共享桶的涨落改不了用户定的界", () => {
    const progress = progressLog();
    const state = step(undefined, progress("run-started", LIMITED));
    const cut = step(
      state,
      progress("concurrency-changed", { previous: 8, next: 6, reason: "rate_limited" }),
    );
    expect(cut.runs[0]?.concurrency).toEqual({ cap: 6, ceiling: 8, limit: 3 });
    // Terminal state only strips the cooldown; both bounds are historical facts of "what concurrency this run ran at" and are kept.
    const settled = step(cut, progress("run-settled", { status: "completed" }));
    expect(settled.runs[0]?.concurrency).toEqual({ cap: 6, ceiling: 8, limit: 3 });
  });

  it("resume 再发一条 run-started：不拿天花板盖掉进程里已经学到的 cap", () => {
    const progress = progressLog();
    const first = step(undefined, progress("run-started", LIMITED));
    const throttled = step(
      first,
      progress("concurrency-changed", { key: "k", previous: 8, next: 2, reason: "rate_limited" }),
    );
    expect(throttled.runs[0]?.concurrency).toEqual({ key: "k", cap: 2, ceiling: 8, limit: 3 });
    const resumed = step(throttled, progress("run-started", LIMITED));
    expect(resumed.runs[0]?.concurrency).toEqual({ key: "k", cap: 2, ceiling: 8, limit: 3 });
  });

  // The ceiling is recorded separately (docs/dynamic-workflow/concurrency.md "Protocol state"): the "settings" popover's
  // stepper rests there, while runs running at the ceiling have no `concurrency` to hang it on.
  it("run-started 记下 concurrencyCeiling，不论本 run 是否低于它", () => {
    const progress = progressLog();
    const atCeiling = step(
      undefined,
      progress("run-started", { ...started({ maxConcurrency: 8 }), concurrencyCeiling: 8 }),
    );
    expect(atCeiling.runs[0]?.concurrencyCeiling).toBe(8);
    expect(atCeiling.runs[0]).not.toHaveProperty("concurrency");
    const limited = step(undefined, progressLog()("run-started", LIMITED));
    expect(limited.runs[0]?.concurrencyCeiling).toBe(8);
    expect(() => workflowRunsStateSchema.parse(atCeiling)).not.toThrow();
  });

  it.each([
    ["老 CLI 不发天花板", started({ maxConcurrency: 3 })],
    ["天花板读不动", { ...started({ maxConcurrency: 3 }), concurrencyCeiling: "8" }],
    ["天花板越界", { ...started({ maxConcurrency: 3 }), concurrencyCeiling: 100_000 }],
  ])("%s：没有 concurrencyCeiling 键；已知值被后来读不出的载荷沿用", (_case, payload) => {
    const fresh = step(undefined, progressLog()("run-started", payload));
    expect(fresh.runs[0]).not.toHaveProperty("concurrencyCeiling");
    const progress = progressLog();
    const known = step(undefined, progress("run-started", LIMITED));
    const again = step(known, progress("run-started", payload));
    expect(again.runs[0]?.concurrencyCeiling).toBe(8);
  });

  // ── In-flight bound changes (docs/dynamic-workflow/concurrency.md) ──────────────────────────────────
  // Revisions that only change `max_concurrency` take effect in place: they do not stop the run or start another; the engine
  // changes caps and emits `run-caps-changed`. The payload has the same shape as `run-started` (`caps` + the CLI-assembled
  // `concurrencyCeiling`), so the reduction must reach the same state as `run-started` — one number entering via two paths must not yield two readings.

  /** The `run-caps-changed` payload; `ceiling: null` = this payload carries no ceiling (the same old-CLI case as run-started). */
  const capsChanged = (maxConcurrency: unknown, previous = 3, ceiling: unknown = 8) => ({
    runId: RUN_ID,
    caps: { maxConcurrency },
    previous: { maxConcurrency: previous },
    ...(ceiling === null ? {} : { concurrencyCeiling: ceiling }),
  });

  it("run-caps-changed：limit 就地改成新值，共享桶那一侧一个字不动", () => {
    const progress = progressLog();
    const state = step(undefined, progress("run-started", LIMITED));
    const throttled = step(
      state,
      progress("concurrency-changed", { key: "k", previous: 8, next: 6, reason: "rate_limited" }),
    );
    const retuned = step(throttled, progress("run-caps-changed", capsChanged(2)));
    expect(retuned.runs[0]?.concurrency).toEqual({ key: "k", cap: 6, ceiling: 8, limit: 2 });
    expect(() => workflowRunsStateSchema.parse(retuned)).not.toThrow();
    // Later shared-bucket swings still do not touch the new bound (the same rule as a bound delivered via run-started).
    const recovered = step(
      retuned,
      progress("concurrency-changed", { key: "k", previous: 6, next: 8, reason: "recovered" }),
    );
    expect(recovered.runs[0]?.concurrency).toEqual({ key: "k", cap: 8, ceiling: 8, limit: 2 });
  });

  it("run-caps-changed 抬到默认之上：同样落 limit", () => {
    const progress = progressLog();
    const state = step(undefined, progress("run-started", LIMITED));
    const raised = step(state, progress("run-caps-changed", capsChanged(24)));
    expect(raised.runs[0]?.concurrency).toEqual({ cap: 8, ceiling: 8, limit: 24 });
  });

  it("从默认之上调回默认：共享 cap 在 D 之上也算无话可说，整个 concurrency 键缺席", () => {
    const progress = progressLog();
    const state = step(
      undefined,
      progress("run-started", { ...started({ maxConcurrency: 20 }), concurrencyCeiling: 8 }),
    );
    const grown = step(
      state,
      progress("concurrency-changed", { key: "k", previous: 11, next: 12, reason: "recovered" }),
    );
    const back = step(grown, progress("run-caps-changed", capsChanged(8, 20)));
    expect(back.runs[0]).not.toHaveProperty("concurrency");
    expect(back.runs[0]?.concurrencyCeiling).toBe(8);
  });

  it("run-caps-changed 也能给一个从未被压低的 run 立一条界：共享 cap 从默认起步", () => {
    const progress = progressLog();
    const atCeiling = step(
      undefined,
      progress("run-started", { ...started({ maxConcurrency: 8 }), concurrencyCeiling: 8 }),
    );
    expect(atCeiling.runs[0]).not.toHaveProperty("concurrency");
    const limited = step(atCeiling, progress("run-caps-changed", capsChanged(3, 8)));
    expect(limited.runs[0]?.concurrency).toEqual({ cap: 8, ceiling: 8, limit: 3 });
  });

  it("调回默认：limit 摘掉；共享桶无话可说时整个 concurrency 键随之缺席", () => {
    const progress = progressLog();
    const state = step(undefined, progress("run-started", LIMITED));
    expect(state.runs[0]?.concurrency).toEqual({ cap: 8, ceiling: 8, limit: 3 });
    const lifted = step(state, progress("run-caps-changed", capsChanged(8)));
    // Byte-identical to a run that was never throttled (the ceiling is recorded separately on concurrencyCeiling).
    expect(lifted.runs[0]).not.toHaveProperty("concurrency");
    expect(lifted.runs[0]?.concurrencyCeiling).toBe(8);
  });

  it.each([
    ["共享桶被压低", { key: "k", previous: 8, next: 6, reason: "rate_limited" }, { cap: 6 }],
    [
      "还在冷却",
      { key: "k", previous: 8, next: 8, reason: "rate_limited", cooldownMs: 30_000 },
      { cap: 8, cooldownMs: 30_000 },
    ],
  ])("调回默认但%s：只摘 limit，共享桶那一侧留着", (_case, changed, expected) => {
    const progress = progressLog();
    const state = step(undefined, progress("run-started", LIMITED));
    const shared = step(state, progress("concurrency-changed", changed));
    const lifted = step(shared, progress("run-caps-changed", capsChanged(8)));
    expect(lifted.runs[0]?.concurrency).toEqual({ key: "k", ceiling: 8, ...expected });
  });

  it.each([
    ["caps 整块读不动", { runId: RUN_ID, caps: "nope", concurrencyCeiling: 8 }],
    ["maxConcurrency 读不动", capsChanged("2")],
    ["maxConcurrency 非正", capsChanged(0)],
  ])("%s：界一个字不改（只抬水位，与 concurrency-changed 同一条兜底）", (_case, payload) => {
    const progress = progressLog();
    const state = step(undefined, progress("run-started", LIMITED));
    const after = step(state, progress("run-caps-changed", payload));
    expect(after.runs[0]?.concurrency).toEqual({ cap: 8, ceiling: 8, limit: 3 });
    expect(after.runs[0]?.concurrencyCeiling).toBe(8);
  });

  it("载荷不带天花板：退回本 run 已知的那个（天花板是整条 run 恒定的进程事实）", () => {
    const progress = progressLog();
    const state = step(undefined, progress("run-started", LIMITED));
    const retuned = step(state, progress("run-caps-changed", capsChanged(2, 3, null)));
    expect(retuned.runs[0]?.concurrency).toEqual({ cap: 8, ceiling: 8, limit: 2 });
    // The ceiling was never known (an old CLI's run): whether this number was throttled cannot be judged, so the bound is untouched.
    const blind = progressLog();
    const unknown = step(undefined, blind("run-started", started({ maxConcurrency: 3 })));
    const after = step(unknown, blind("run-caps-changed", capsChanged(2, 3, null)));
    expect(after.runs[0]).not.toHaveProperty("concurrency");
    expect(after.runs[0]).not.toHaveProperty("concurrencyCeiling");
  });

  it("run-caps-changed 记下载荷里的天花板（与 run-started 同一条）", () => {
    const progress = progressLog();
    const state = step(undefined, progress("run-started", started({ maxConcurrency: 3 })));
    expect(state.runs[0]).not.toHaveProperty("concurrencyCeiling");
    const retuned = step(state, progress("run-caps-changed", capsChanged(2)));
    expect(retuned.runs[0]?.concurrencyCeiling).toBe(8);
    expect(retuned.runs[0]?.concurrency).toEqual({ cap: 8, ceiling: 8, limit: 2 });
  });

  it("幂等：同一条 run-caps-changed 重放得到 null", () => {
    const progress = progressLog();
    const state = step(undefined, progress("run-started", LIMITED));
    const event = progress("run-caps-changed", capsChanged(2));
    const retuned = step(state, event);
    expect(reduceWorkflowRunsState(retuned, event)).toBeNull();
  });
});

// ── Subagent model (docs/dynamic-workflow/launch.md) ─────────────────────────────────────────
// `CreateWorkflow` / `AmendWorkflow`'s `subagent_model` lands on the `run-started` payload as
// `subagentModel` (the canonical `providerId/modelId` string, optionally with a `$reasoningLevel` suffix). Same family as
// `concurrency.limit`: a condition the user set for this run, immutable for its whole life. The main agent always stays on
// the session model, so this key speaks only of the subagent side.
describe("reduceWorkflowRunsState：子代理模型", () => {
  const withModel = (subagentModel: unknown) => ({ ...started(), subagentModel });

  it("run-started 带 subagentModel 时记下它，产出过 strict schema", () => {
    const state = step(undefined, progressLog()("run-started", withModel("zhipu/glm-5.3-flash")));

    expect(state.runs[0]?.subagentModel).toBe("zhipu/glm-5.3-flash");
    expect(() => workflowRunsStateSchema.parse(state)).not.toThrow();
  });

  it("带推理档后缀的规范串原样留着：档位是模型选择的一部分，不是可丢的修饰", () => {
    const state = step(undefined, progressLog()("run-started", withModel("anthropic/opus-5$high")));

    expect(state.runs[0]?.subagentModel).toBe("anthropic/opus-5$high");
  });

  it("两侧空白裁掉：显示的是模型 id，不是载荷的排版", () => {
    const state = step(undefined, progressLog()("run-started", withModel("  zhipu/glm-5.3  ")));

    expect(state.runs[0]?.subagentModel).toBe("zhipu/glm-5.3");
  });

  it("后续事件改不了它：整条 run 自始至终说的是同一个模型", () => {
    const progress = progressLog();
    const state = step(undefined, progress("run-started", withModel("zhipu/glm-5.3-flash")));
    const used = step(state, progress("usage-updated", { spentTokens: 4_096 }));
    const throttled = step(
      used,
      progress("concurrency-changed", { previous: 8, next: 4, reason: "rate_limited" }),
    );
    const settled = step(throttled, progress("run-settled", { status: "completed" }));

    expect(settled.runs[0]?.subagentModel).toBe("zhipu/glm-5.3-flash");
  });

  it("重臂不带这个键时保留已知值，而不是让 run 看上去换回了会话模型", () => {
    // Old CLIs do not send it; erasing an already-displayed model is the worst kind of degradation (the reading changed, the fact did not).
    const progress = progressLog();
    const first = step(undefined, progress("run-started", withModel("zhipu/glm-5.3-flash")));
    const resumed = step(first, progress("run-started", started()));

    expect(resumed.runs[0]?.subagentModel).toBe("zhipu/glm-5.3-flash");
  });

  it.each([
    ["缺席（子代理跟随会话模型）", started()],
    ["空串", withModel("")],
    ["只有空白", withModel("   ")],
    ["不是字符串", withModel({ providerId: "zhipu", modelId: "glm-5.3-flash" })],
    [
      "超过线上上界（截断出来的模型 id 是假话）",
      withModel(`zhipu/${"x".repeat(WORKFLOW_RUNS_LIMITS.maxSubagentModelLength)}`),
    ],
  ])("%s：整个键缺席，而不是一个 undefined 值", (_case, payload) => {
    const state = step(undefined, progressLog()("run-started", payload));

    expect(state.runs[0]).not.toHaveProperty("subagentModel");
    expect(() => workflowRunsStateSchema.parse(state)).not.toThrow();
  });
});

// ── User-facing artifacts (docs/dynamic-workflow/authoring.md "How the user sees them") ─────────────────
// ⚠ Terminology: the artifact here is output a script published to the **user** via `artifact.*`, not the "script top-level
// return value" behind resultPreview (also called artifact inside the engine, shown to the model). See workflow-artifacts.ts.
//
// Three reduction rules, each with its own key:
//   artifact-published ⇒ upsert by **artifact id** (republishing the same id = a new version overwriting the same card)
//   artifact-failed    ⇒ touches no state (a failed publish claims no id / kind / version; it only enters the event log)
//   report(artifactId) ⇒ that id's itemCount +1 (the dedup key is still (siteId, ordinal))
describe("reduceWorkflowRunsState：用户面产物", () => {
  const PUBLISHED_AT = 1_756_100_000_000;
  const record = (overrides: Record<string, unknown> = {}) => ({
    id: "book",
    kind: "file",
    version: 1,
    title: "注意力之书",
    contentType: "application/pdf",
    bytes: 4_194_304,
    uri: "zcode-artifact://session-1/tool-result-abc",
    sourcePath: "out/book.pdf",
    publishedAt: PUBLISHED_AT,
    ...overrides,
  });

  it("artifact-published 建一张卡，且只留最新版元数据（不带 uri / sourcePath / publishedAt）", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("artifact-published", {
        instance: { siteId: "artifact#1", ordinal: 1 },
        artifact: record(),
      }),
    ]);
    // Trimming is this key's entire reason to exist: high-frequency state frames only answer "what exists, which version, did it change".
    expect(state?.runs[0]?.artifacts).toEqual([
      {
        id: "book",
        kind: "file",
        title: "注意力之书",
        version: 1,
        contentType: "application/pdf",
        bytes: 4_194_304,
      },
    ]);
    expect(workflowRunsStateSchema.parse(state)).toEqual(state);
  });

  it("交付物的 primary 进快照（UI 据它排先后与选形态）；description 仍被裁掉", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("artifact-published", {
        instance: { siteId: "artifact#1", ordinal: 1 },
        artifact: record({ primary: true, description: "一本书" }),
      }),
    ]);
    expect(state?.runs[0]?.artifacts).toEqual([
      {
        id: "book",
        kind: "file",
        title: "注意力之书",
        version: 1,
        contentType: "application/pdf",
        bytes: 4_194_304,
        primary: true,
      },
    ]);
    expect(workflowRunsStateSchema.parse(state)).toEqual(state);
  });

  it("预置看板的声明也走 artifact-published：无 contentType / bytes，spec 不进快照", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("artifact-published", {
        instance: { siteId: "artifact#1", ordinal: 1 },
        artifact: {
          id: "perf",
          kind: "chart",
          version: 1,
          title: "每轮查询耗时",
          spec: { x: { field: "round" }, y: { field: "queryMs" } },
          publishedAt: PUBLISHED_AT,
        },
      }),
    ]);
    expect(state?.runs[0]?.artifacts).toEqual([
      { id: "perf", kind: "chart", title: "每轮查询耗时", version: 1 },
    ]);
    expect(workflowRunsStateSchema.parse(state)).toEqual(state);
  });

  it("同 id 再发布 = 新版本覆盖同一张卡（按产物 id 去重，不是按站点实例）", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("artifact-published", {
        instance: { siteId: "artifact#1", ordinal: 1 },
        artifact: record(),
      }),
      // The second publish comes from a **different** site instance — deduping by instance would grow a second card, which is wrong.
      progress("artifact-published", {
        instance: { siteId: "artifact#2", ordinal: 1 },
        artifact: record({ version: 2, bytes: 5_000_000, title: "注意力之书（第二版）" }),
      }),
    ]);
    expect(state?.runs[0]?.artifacts).toEqual([
      {
        id: "book",
        kind: "file",
        title: "注意力之书（第二版）",
        version: 2,
        contentType: "application/pdf",
        bytes: 5_000_000,
      },
    ]);
  });

  it("新版本覆盖时**保留** itemCount：正在被喂数据的看板不能被清零", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("artifact-published", {
        instance: { siteId: "artifact#1", ordinal: 1 },
        artifact: { id: "perf", kind: "chart", version: 1, publishedAt: PUBLISHED_AT },
      }),
      progress("report", {
        instance: { siteId: "report#1", ordinal: 1 },
        item: { round: 1 },
        artifactId: "perf",
      }),
      progress("report", {
        instance: { siteId: "report#1", ordinal: 2 },
        item: { round: 2 },
        artifactId: "perf",
      }),
      // A duplicate declaration of the same spec is a no-op on the engine side, but if a version record really arrives again the count must survive:
      // zeroing it would zero the refresh signal and the board would stop fetching incrementally.
      progress("artifact-published", {
        instance: { siteId: "artifact#1", ordinal: 2 },
        artifact: { id: "perf", kind: "chart", version: 1, publishedAt: PUBLISHED_AT },
      }),
    ]);
    expect(state?.runs[0]?.artifacts).toEqual([
      { id: "perf", kind: "chart", version: 1, itemCount: 2 },
    ]);
  });

  it("artifact-failed 不动任何状态：失败的发布不认领 id / 种类 / 版本", () => {
    const progress = progressLog();
    const started1 = step(undefined, progress("run-started", started()));
    const failed = step(
      started1,
      progress("artifact-failed", {
        instance: { siteId: "artifact#1", ordinal: 1 },
        id: "book",
        op: "file",
        error: { code: "ArtifactSourceMissing", message: "out/book.pdf does not exist" },
      }),
    );
    // The card never appears — showing a failure card for a deliverable that does not exist would make the user see something
    // that is not there, and the script very likely caught it and republished successfully after the subagent rewrote it.
    expect(failed.runs[0]?.artifacts).toBeUndefined();
    // But the watermark still advances: the event log needs to know there is new content.
    expect(failed.runs[0]?.lastEventSequence).toBeGreaterThan(started1.runs[0]!.lastEventSequence);
  });

  it("artifact-failed 也不擦掉同 id 已发布成功的旧版本（第 2 版失败，第 1 版仍在）", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("artifact-published", {
        instance: { siteId: "artifact#1", ordinal: 1 },
        artifact: record(),
      }),
      progress("artifact-failed", {
        instance: { siteId: "artifact#1", ordinal: 2 },
        id: "book",
        op: "file",
        error: { code: "ArtifactTooLarge", message: "too large" },
      }),
    ]);
    expect(state?.runs[0]?.artifacts).toEqual([
      {
        id: "book",
        kind: "file",
        title: "注意力之书",
        version: 1,
        contentType: "application/pdf",
        bytes: 4_194_304,
      },
    ]);
  });

  it("载荷读不动（缺 id / 种类不在闭集 / version 非正整数）时不建卡，只抬水位", () => {
    const progress = progressLog();
    const base = step(undefined, progress("run-started", started()));
    for (const artifact of [
      { kind: "file", version: 1 },
      { id: "x", kind: "spreadsheet", version: 1 },
      { id: "x", kind: "file", version: 0 },
      { id: "x", kind: "file", version: 1.5 },
      { id: "x", kind: "file" },
      "not-a-record",
    ]) {
      const next = step(
        base,
        progress("artifact-published", {
          instance: { siteId: "artifact#1", ordinal: 1 },
          artifact,
        }),
      );
      expect(next.runs[0]?.artifacts).toBeUndefined();
      expect(next.runs[0]?.lastEventSequence).toBeGreaterThan(base.runs[0]!.lastEventSequence);
    }
  });

  it("标签 report 计数：itemCount 随条目增长，条目本身照旧进 reports", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("artifact-published", {
        instance: { siteId: "artifact#1", ordinal: 1 },
        artifact: { id: "perf", kind: "chart", version: 1, publishedAt: PUBLISHED_AT },
      }),
      progress("report", {
        instance: { siteId: "report#1", ordinal: 1 },
        item: { round: 1 },
        artifactId: "perf",
      }),
      progress("report", {
        instance: { siteId: "report#1", ordinal: 2 },
        item: { round: 2 },
        artifactId: "perf",
      }),
      // Untagged entries still go only to the Results section and touch no artifacts.
      progress("report", { instance: { siteId: "report#2", ordinal: 1 }, item: "plain" }),
    ]);
    expect(state?.runs[0]?.artifacts).toEqual([
      { id: "perf", kind: "chart", version: 1, itemCount: 2 },
    ]);
    // One channel, one bound set: tagging only adds a destination, it does not reroute.
    expect(state?.runs[0]?.reports).toEqual([
      { siteId: "report#1", ordinal: 1, preview: '{\n  "round": 1\n}', artifactId: "perf" },
      { siteId: "report#1", ordinal: 2, preview: '{\n  "round": 2\n}', artifactId: "perf" },
      { siteId: "report#2", ordinal: 1, preview: "plain" },
    ]);
    expect(workflowRunsStateSchema.parse(state)).toEqual(state);
  });

  it("计数幂等：同一条标签 report 重放不重复计数（去重键与 reports 表同为 (siteId, ordinal)）", () => {
    const progress = progressLog();
    const declared = reduceAll([
      progress("run-started", started()),
      progress("artifact-published", {
        instance: { siteId: "artifact#1", ordinal: 1 },
        artifact: { id: "perf", kind: "chart", version: 1, publishedAt: PUBLISHED_AT },
      }),
    ]);
    const event = progress("report", {
      instance: { siteId: "report#1", ordinal: 1 },
      item: { round: 1 },
      artifactId: "perf",
    });
    const once = step(declared, event);
    expect(once.runs[0]?.artifacts?.[0]?.itemCount).toBe(1);
    // Byte-identical ⇒ the top-level comparison returns null ⇒ no revision bump, no state change.
    expect(reduceWorkflowRunsState(once, event)).toBeNull();
    expect(once.runs[0]?.artifacts?.[0]?.itemCount).toBe(1);
  });

  it("标签指向未在表里的 id 时忽略计数，条目仍进 reports（运行期已 failRun，这里只是防御）", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("artifact-published", {
        instance: { siteId: "artifact#1", ordinal: 1 },
        artifact: { id: "perf", kind: "chart", version: 1, publishedAt: PUBLISHED_AT },
      }),
      progress("report", {
        instance: { siteId: "report#1", ordinal: 1 },
        item: { round: 1 },
        artifactId: "ghost",
      }),
    ]);
    expect(state?.runs[0]?.artifacts).toEqual([{ id: "perf", kind: "chart", version: 1 }]);
    expect(state?.runs[0]?.reports).toEqual([
      { siteId: "report#1", ordinal: 1, preview: '{\n  "round": 1\n}', artifactId: "ghost" },
    ]);
  });

  it("一张产物都没有时标签 report 不凭空造出一个 artifacts 键", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("report", {
        instance: { siteId: "report#1", ordinal: 1 },
        item: 1,
        artifactId: "perf",
      }),
    ]);
    expect(state?.runs[0]?.artifacts).toBeUndefined();
    expect(state?.runs[0]?.reports).toHaveLength(1);
  });

  it("零件时整个键缺席（不是空数组）——Artifacts 区据此整区不渲染", () => {
    const progress = progressLog();
    const state = reduceAll([progress("run-started", started()), progress("log", { text: "hi" })]);
    expect(state?.runs[0]).not.toHaveProperty("artifacts");
  });

  it("触上限置 truncated 且不再增长，但表内已有的 id 仍可更新版本与计数", () => {
    const progress = progressLog();
    let state = step(undefined, progress("run-started", started()));
    for (let index = 0; index < WORKFLOW_RUNS_LIMITS.maxArtifacts; index += 1) {
      state = step(
        state,
        progress("artifact-published", {
          instance: { siteId: `artifact#${index + 1}`, ordinal: 1 },
          artifact: { id: `a${index}`, kind: "markdown", version: 1, publishedAt: PUBLISHED_AT },
        }),
      );
    }
    expect(state.runs[0]?.artifacts).toHaveLength(WORKFLOW_RUNS_LIMITS.maxArtifacts);
    expect(state.runs[0]?.truncated).toBeUndefined();
    const overflowed = step(
      state,
      progress("artifact-published", {
        instance: { siteId: "artifact#33", ordinal: 1 },
        artifact: { id: "a33", kind: "markdown", version: 1, publishedAt: PUBLISHED_AT },
      }),
    );
    expect(overflowed.runs[0]?.artifacts).toHaveLength(WORKFLOW_RUNS_LIMITS.maxArtifacts);
    expect(overflowed.runs[0]?.truncated).toBe(true);
    // Reject-new but keep updating existing ones: freezing a card's version at v1 is more misleading than listing one fewer card.
    const updated = step(
      overflowed,
      progress("artifact-published", {
        instance: { siteId: "artifact#1", ordinal: 2 },
        artifact: { id: "a0", kind: "markdown", version: 2, publishedAt: PUBLISHED_AT },
      }),
    );
    expect(updated.runs[0]?.artifacts?.[0]).toEqual({ id: "a0", kind: "markdown", version: 2 });
    expect(workflowRunsStateSchema.parse(updated)).toEqual(updated);
  });

  it("产物不进图也不计步：nodes / actors / usage 一个字不动", () => {
    const progress = progressLog();
    const before = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 1 }, name: "writer" }),
    ]);
    const after = step(
      before,
      progress("artifact-published", {
        instance: { siteId: "artifact#1", ordinal: 1 },
        artifact: record(),
      }),
    );
    expect(after.runs[0]?.nodes).toEqual(before?.runs[0]?.nodes);
    expect(after.runs[0]?.actors).toEqual(before?.runs[0]?.actors);
    expect(after.runs[0]?.usage).toEqual(before?.runs[0]?.usage);
  });

  it("幂等：同一条 artifact-published / artifact-failed 重放得到 null", () => {
    const progress = progressLog();
    const base = step(undefined, progress("run-started", started()));
    const publishEvent = progress("artifact-published", {
      instance: { siteId: "artifact#1", ordinal: 1 },
      artifact: record(),
    });
    const published = step(base, publishEvent);
    expect(reduceWorkflowRunsState(published, publishEvent)).toBeNull();
    // artifact-failed changes no **display** state but still advances the watermark (the event log must know there is new content),
    // so its first occurrence is not null; only the replay is.
    const failEvent = progress("artifact-failed", {
      instance: { siteId: "artifact#2", ordinal: 1 },
      id: "gone",
      op: "file",
      error: { code: "ArtifactSourceMissing", message: "missing" },
    });
    const failedOnce = step(published, failEvent);
    expect(reduceWorkflowRunsState(failedOnce, failEvent)).toBeNull();
  });
});

// ── Phase entry records (docs/dynamic-workflow/presentation.md) ──────────
describe("workflowRuns reducer · run-launched（声明阶段表）", () => {
  it("run-launched 携 phaseNames → run.phaseNames 按声明序落位，裁到 maxPhases × maxPhaseNameLength", () => {
    const progress = progressLog();
    const long = "p".repeat(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength + 5);
    const many = Array.from({ length: WORKFLOW_RUNS_LIMITS.maxPhases + 2 }, (_, i) => `s${i}`);
    const state = step(
      step(undefined, progress("run-started", started())),
      progress("run-launched", { inputId: "in-1", phaseNames: ["plan", long, ...many] }),
    );
    const run = state.runs[0]!;
    expect(run.phaseNames).toHaveLength(WORKFLOW_RUNS_LIMITS.maxPhases);
    expect(run.phaseNames?.[0]).toBe("plan");
    expect(run.phaseNames?.[1]).toBe("p".repeat(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength));
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  it("没有 phaseNames（旧 CLI / 无标记脚本）或空表 → 只抬水位，不建键", () => {
    const progress = progressLog();
    const base = step(undefined, progress("run-started", started()));
    const anchored = step(base, progress("run-launched", { inputId: "in-1" }));
    expect(anchored.runs[0]?.phaseNames).toBeUndefined();
    expect(anchored.runs[0]?.lastEventSequence).toBe(1);
    const empty = step(anchored, progress("run-launched", { inputId: "in-1", phaseNames: [] }));
    expect(empty.runs[0]?.phaseNames).toBeUndefined();
  });

  it("run-launched 携 phaseAlongside → 裁到被接受的名字表，越界 / 自指 / 重复 / 非整数丢掉", () => {
    const progress = progressLog();
    const state = step(
      step(undefined, progress("run-started", started())),
      progress("run-launched", {
        inputId: "in-1",
        phaseNames: ["A", "B", "C"],
        // B runs in parallel with A; every other item must be dropped: self-reference, out of range, negative, fractional, duplicate, and a fourth row outside the name table.
        phaseAlongside: [[], [0, 1, 7, -1, 1.5, 0], [3], [0]],
      }),
    );
    const run = state.runs[0]!;
    // 表按被接受的名字表裁齐——下标指向的就是它，多出来的一行没有站可依。
    expect(run.phaseAlongside).toEqual([[], [0], []]);
    expect(workflowRunsStateSchema.safeParse(state).success).toBe(true);
  });

  it("phaseNames 不在场、或没有一项并行 → phaseAlongside 一起不建键", () => {
    const progress = progressLog();
    const base = step(undefined, progress("run-started", started()));
    // When the name table is rejected (absent) the indexes have no table to point at; the whole table is dropped.
    const nameless = step(
      base,
      progress("run-launched", { inputId: "in-1", phaseAlongside: [[1], [0]] }),
    );
    expect(nameless.runs[0]?.phaseNames).toBeUndefined();
    expect(nameless.runs[0]?.phaseAlongside).toBeUndefined();
    // The name table stands but nothing remains: absence means "this track is a straight line", not an array of empty arrays.
    const straight = step(
      base,
      progress("run-launched", {
        inputId: "in-1",
        phaseNames: ["A", "B"],
        phaseAlongside: [[], [1]],
      }),
    );
    expect(straight.runs[0]?.phaseNames).toEqual(["A", "B"]);
    expect(straight.runs[0]?.phaseAlongside).toBeUndefined();
  });

  it("resume 的 run-started 不清 phaseNames（同一世只记一次，重放幂等）", () => {
    const progress = progressLog();
    const launched = step(
      step(undefined, progress("run-started", started())),
      progress("run-launched", { inputId: "in-1", phaseNames: ["plan", "verify"] }),
    );
    const settled = step(
      launched,
      progress("run-settled", { status: "stopped", stopReason: "user" }),
    );
    const resumed = step(settled, progress("run-started", started()));
    expect(resumed.runs[0]?.phaseNames).toEqual(["plan", "verify"]);
    expect(
      reduceWorkflowRunsState(
        resumed,
        progress(
          "run-launched",
          { inputId: "in-1", phaseNames: ["plan", "verify"] },
          { sequence: 3 },
        ),
      ),
    ).toBeNull();
  });
});

describe("workflowRuns reducer · phase-entered", () => {
  it("首进建条、再入取 max、currentPhase 跟最后一条；不碰 nodes", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("phase-entered", { name: "plan", ordinal: 1 }),
      progress("phase-entered", { name: "verify", ordinal: 1 }),
      progress("phase-entered", { name: "plan", ordinal: 2 }),
    ]);
    expect(state?.runs[0]?.phases).toEqual([
      { name: "plan", rounds: 2 },
      { name: "verify", rounds: 1 },
    ]);
    expect(state?.runs[0]?.currentPhase).toBe("plan");
    expect(state?.runs[0]?.nodes).toEqual([]);
    expect(workflowRunsStateSchema.parse(state)).toEqual(state);
  });

  it("重放幂等：resume 重跑的前缀逐条无变化（rounds 取 max，不是 +1）", () => {
    const progress = progressLog();
    const base = reduceAll([
      progress("run-started", started()),
      progress("phase-entered", { name: "plan", ordinal: 1 }),
      progress("phase-entered", { name: "plan", ordinal: 2 }),
    ]);
    // The engine counts from 1 and resends on resume: rounds must not become 3, 4.
    const replayed = reduceAll(
      [
        progress("phase-entered", { name: "plan", ordinal: 1 }),
        progress("phase-entered", { name: "plan", ordinal: 2 }),
      ],
      base,
    );
    expect(replayed?.runs[0]?.phases).toEqual([{ name: "plan", rounds: 2 }]);
  });

  it("从未进入过任何阶段时两键缺席；ordinal 缺席按 1 记；名字截到上界", () => {
    const progress = progressLog();
    const started1 = step(undefined, progress("run-started", started()));
    expect(started1.runs[0]?.phases).toBeUndefined();
    expect(started1.runs[0]?.currentPhase).toBeUndefined();
    const long = "长".repeat(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength + 10);
    const next = step(started1, progress("phase-entered", { name: long }));
    expect(next.runs[0]?.phases).toEqual([
      { name: "长".repeat(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength), rounds: 1 },
    ]);
    expect(workflowRunsStateSchema.parse(next)).toEqual(next);
  });

  it("触界：第 33 个不同阶段不建条但置 truncated，已有条目照常更新", () => {
    const progress = progressLog();
    const envelopes = [progress("run-started", started())];
    for (let i = 0; i < WORKFLOW_RUNS_LIMITS.maxPhases; i += 1) {
      envelopes.push(progress("phase-entered", { name: `p${i}`, ordinal: 1 }));
    }
    envelopes.push(progress("phase-entered", { name: "overflow", ordinal: 1 }));
    envelopes.push(progress("phase-entered", { name: "p0", ordinal: 2 }));
    const state = reduceAll(envelopes);
    expect(state?.runs[0]?.phases).toHaveLength(WORKFLOW_RUNS_LIMITS.maxPhases);
    expect(state?.runs[0]?.phases?.[0]).toEqual({ name: "p0", rounds: 2 });
    expect(state?.runs[0]?.truncated).toBe(true);
    // currentPhase still follows the last one — an out-of-bound phase cannot enter the table, but "where control flow is" is a fact.
    expect(state?.runs[0]?.currentPhase).toBe("p0");
  });
});

// ── Birth-phase coordinates of instances (docs/dynamic-workflow/presentation.md) ──────
// The static causality graph shares sites across phases, so runtime instances must carry the same coordinate, otherwise every
// card would claim every instance ("all subagents appear in all phases"). The engine stamps only on **birth events**:
// actor-created / node-queued / node-settled { cached }; other node events do not carry it, and this reducer carries it forward following the actorSiteId precedent.
describe("workflowRuns reducer · phaseName（实例的出生阶段）", () => {
  it("actor 从 actor-created 取 phaseName", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("phase-entered", { name: "调查", ordinal: 1 }),
      progress("actor-created", {
        actor: { siteId: "actor#1", ordinal: 1 },
        name: "reader",
        phaseName: "调查",
      }),
      // Instances born before the marker carry no stamp (the engine's currentPhase was undefined at the time).
      progress("actor-created", { actor: { siteId: "actor#0", ordinal: 1 } }),
    ]);
    expect(state?.runs[0]?.actors).toEqual([
      { siteId: "actor#1", ordinal: 1, name: "reader", phaseName: "调查", status: "waiting" },
      { siteId: "actor#0", ordinal: 1, status: "waiting" },
    ]);
    expect(workflowRunsStateSchema.parse(state)).toEqual(state);
  });

  it("节点从 node-queued 取，并在 dispatched / executing / settled 上携带", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("node-queued", {
        instance: { siteId: "ask#1", ordinal: 37 },
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 37 },
        phaseName: "第三阶段",
      }),
      progress("node-dispatched", { instance: { siteId: "ask#1", ordinal: 37 } }),
      progress("node-executing", { instance: { siteId: "ask#1", ordinal: 37 } }),
      progress("node-settled", { instance: { siteId: "ask#1", ordinal: 37 }, outcome: "ok" }),
    ]);
    expect(state?.runs[0]?.nodes).toEqual([
      {
        siteId: "ask#1",
        ordinal: 37,
        kind: "ask",
        phase: "settled",
        outcome: "ok",
        actorSiteId: "actor#1",
        actorOrdinal: 37,
        phaseName: "第三阶段",
      },
    ]);
    expect(workflowRunsStateSchema.parse(state)).toEqual(state);
  });

  it("cached settle 没有前序 queued，戳直接从这条事件取", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      // resume / amend-resume's completed-hit short-circuit: never through node-queued, so the settle is its birth event.
      progress("node-settled", {
        instance: { siteId: "ask#1", ordinal: 2 },
        actor: { siteId: "actor#1", ordinal: 2 },
        outcome: "ok",
        cached: true,
        phaseName: "复核",
      }),
    ]);
    expect(state?.runs[0]?.nodes).toEqual([
      {
        siteId: "ask#1",
        ordinal: 2,
        phase: "settled",
        outcome: "ok",
        cached: true,
        actorSiteId: "actor#1",
        actorOrdinal: 2,
        phaseName: "复核",
      },
    ]);
  });

  it("名字截到上界（128），actor 与 node 同一条界", () => {
    const progress = progressLog();
    const long = "长".repeat(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength + 10);
    const bounded = "长".repeat(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength);
    const state = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 1 }, phaseName: long }),
      progress("node-queued", {
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
        phaseName: long,
      }),
    ]);
    expect(state?.runs[0]?.actors[0]?.phaseName).toBe(bounded);
    expect(state?.runs[0]?.nodes[0]?.phaseName).toBe(bounded);
    // Still within bounds after trimming: a 138-char phase name must not get every frame after the parent session rejected by the renderer.
    expect(workflowRunsStateSchema.parse(state)).toEqual(state);
  });

  it("旧载荷（无该键）归约结果逐字节不变：状态里不出现 phaseName", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 1 }, name: "reader" }),
      progress("node-queued", {
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
      }),
      progress("node-settled", { instance: { siteId: "ask#1", ordinal: 1 }, outcome: "ok" }),
    ]);
    // The projection compares snapshots byte-wise as JSON to decide "changed or not": not even a key with an undefined value may appear.
    expect(JSON.stringify(state)).not.toContain("phaseName");
    expect(state?.runs[0]?.actors).toEqual([
      { siteId: "actor#1", ordinal: 1, name: "reader", status: "completed" },
    ]);
    expect(state?.runs[0]?.nodes).toEqual([
      {
        siteId: "ask#1",
        ordinal: 1,
        kind: "ask",
        phase: "settled",
        outcome: "ok",
        actorSiteId: "actor#1",
        actorOrdinal: 1,
      },
    ]);
    expect(workflowRunsStateSchema.parse(state)).toEqual(state);
  });

  it("空串 / 非字符串戳不上线，也不擦掉已携带的戳", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: { siteId: "actor#1", ordinal: 1 }, phaseName: "" }),
      progress("node-queued", {
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
        phaseName: "调查",
      }),
      progress("node-dispatched", { instance: { siteId: "ask#1", ordinal: 1 }, phaseName: 7 }),
    ]);
    expect(state?.runs[0]?.actors[0]).not.toHaveProperty("phaseName");
    expect(state?.runs[0]?.nodes[0]?.phaseName).toBe("调查");
  });
});

describe("run-launched：发起锚点事件只抬水位（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Token telemetry for subagents」）", () => {
  it("run-started 之后的 run-launched 不改状态，只推进 lastEventSequence", () => {
    const progress = progressLog();
    const started = step(
      undefined,
      progress("run-started", { caps: { maxConcurrency: 2 }, runId: RUN_ID }),
    );
    const before = started.runs[0];
    const after = step(
      started,
      progress("run-launched", { inputId: "launch-input-1", toolCallId: "tc-1" }),
    );
    expect(after.runs[0]).toEqual({ ...before, lastEventSequence: 1 });
    expect(workflowRunsStateSchema.parse(after)).toEqual(after);
  });
});

// ── One ask's progress readings (docs/dynamic-workflow/presentation.md "The run state the pane draws") ──
// A phase can only say "running", not what is running or how far along; these keys are the raw material for GetWorkflowRun's situation report.
describe("workflowRuns reducer · node-progress（ask 的任务与进度读数）", () => {
  const ASK = { siteId: "ask#1", ordinal: 1 };
  const ACTOR = { siteId: "actor#1", ordinal: 1 };

  /** A dispatched ask: born with a task summary, then dispatched. */
  function assignedState(instructionsHead = "把 packages/shared 下的协议测试跑一遍并修掉红的") {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("actor-created", { actor: ACTOR, name: "planner" }),
      progress("node-queued", { instance: ASK, kind: "ask", actor: ACTOR, instructionsHead }),
      progress("node-dispatched", { instance: ASK }),
    ]);
    return { progress, state };
  }

  it("node-queued 带 instructionsHead → 落到节点上，并被后续生命周期事件向前携带", () => {
    const { progress, state } = assignedState();
    expect(state?.runs[0]?.nodes[0]).toEqual({
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      phase: "dispatched",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      instructionsHead: "把 packages/shared 下的协议测试跑一遍并修掉红的",
    });
    const settled = step(state, progress("node-settled", { instance: ASK, outcome: "ok" }));
    expect(settled.runs[0]?.nodes[0]).toMatchObject({
      phase: "settled",
      instructionsHead: "把 packages/shared 下的协议测试跑一遍并修掉红的",
    });
    expect(workflowRunsStateSchema.parse(settled)).toEqual(settled);
  });

  it("node-progress 更新三个读数：不动相位、不计步、不动 actor 状态（一个轮次解析不是生命周期跃迁）", () => {
    const { progress, state } = assignedState();
    const executing = step(state, progress("node-executing", { instance: ASK }));
    const before = executing.runs[0]!;
    const next = step(
      executing,
      progress("node-progress", {
        instance: ASK,
        turn: 2,
        toolCalls: 7,
        lastTool: { name: "Bash", target: "pnpm exec vitest run packages/shared" },
      }),
    );
    expect(next.runs[0]?.nodes[0]).toEqual({
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      phase: "executing",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      instructionsHead: "把 packages/shared 下的协议测试跑一遍并修掉红的",
      turn: 2,
      toolCalls: 7,
      lastTool: { name: "Bash", target: "pnpm exec vitest run packages/shared" },
    });
    // Only the watermark advances; not one other run-level fact moves.
    expect(next.runs[0]?.usage).toEqual(before.usage);
    expect(next.runs[0]?.actors).toEqual(before.actors);
    expect(next.runs[0]?.lastEventSequence).toBe(before.lastEventSequence + 1);
    expect(workflowRunsStateSchema.parse(next)).toEqual(next);
  });

  it("读数被后续生命周期事件向前携带（不携带的话 node-progress 的下一条事件就把它擦了）", () => {
    const { progress, state } = assignedState();
    const withProgress = step(
      step(state, progress("node-executing", { instance: ASK })),
      progress("node-progress", {
        instance: ASK,
        turn: 3,
        toolCalls: 12,
        lastTool: { name: "Read" },
      }),
    );
    const waiting = step(withProgress, progress("node-waiting", { instance: ASK, cause: "slot" }));
    expect(waiting.runs[0]?.nodes[0]).toMatchObject({
      phase: "waiting",
      turn: 3,
      toolCalls: 12,
      lastTool: { name: "Read" },
    });
    const settled = step(waiting, progress("node-settled", { instance: ASK, outcome: "ok" }));
    expect(settled.runs[0]?.nodes[0]).toMatchObject({ phase: "settled", turn: 3, toolCalls: 12 });
  });

  it("再次 node-queued（resume 重跑同一站点）清掉上一世的读数：新一次 ask 的轮次从 1 重新数", () => {
    const { progress, state } = assignedState();
    const withProgress = step(
      state,
      progress("node-progress", {
        instance: ASK,
        turn: 7,
        toolCalls: 40,
        lastTool: { name: "Bash" },
      }),
    );
    const requeued = step(
      withProgress,
      progress("node-queued", {
        instance: ASK,
        kind: "ask",
        actor: ACTOR,
        instructionsHead: "改一版",
      }),
    );
    const node = requeued.runs[0]?.nodes[0];
    expect(node).toMatchObject({ phase: "queued", instructionsHead: "改一版" });
    expect(node).not.toHaveProperty("turn");
    expect(node).not.toHaveProperty("toolCalls");
    expect(node).not.toHaveProperty("lastTool");
    // The new life's first progress event is round 1: with max this would show 7, and the UI would read a freshly started ask as one running for ages.
    const restarted = step(
      requeued,
      progress("node-progress", { instance: ASK, turn: 1, toolCalls: 0 }),
    );
    expect(restarted.runs[0]?.nodes[0]).toMatchObject({
      instructionsHead: "改一版",
      turn: 1,
      toolCalls: 0,
    });
    expect(restarted.runs[0]?.nodes[0]).not.toHaveProperty("lastTool");
  });

  it("缓存命中的结算也是出生事件：读数清空，任务摘要留着（完结缓存按输入哈希命中，指令逐字相同）", () => {
    // This pins "a node that did zero steps must not display the previous life's readings". It exercises resume's completed-hit
    // short-circuit (engine.ts:228/232): that node-settled has no preceding queued — it is itself the birth event.
    const { progress, state } = assignedState();
    const lived = step(
      state,
      progress("node-progress", {
        instance: ASK,
        turn: 9,
        toolCalls: 40,
        lastTool: { name: "Bash", target: "pnpm test" },
      }),
    );
    const cached = step(
      step(lived, progress("run-started", started())),
      progress("node-settled", { instance: ASK, outcome: "ok", cached: true }),
    );
    const node = cached.runs[0]?.nodes[0];
    expect(node).toMatchObject({
      phase: "settled",
      outcome: "ok",
      cached: true,
      instructionsHead: "把 packages/shared 下的协议测试跑一遍并修掉红的",
    });
    expect(node).not.toHaveProperty("turn");
    expect(node).not.toHaveProperty("toolCalls");
    expect(node).not.toHaveProperty("lastTool");
    expect(workflowRunsStateSchema.parse(cached)).toEqual(cached);
  });

  it("queued → settled(cached) 之间没有任何进度事件时三键始终缺席（不是 0）", () => {
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("node-queued", {
        instance: ASK,
        kind: "ask",
        actor: ACTOR,
        instructionsHead: "查一遍",
      }),
      progress("node-settled", { instance: ASK, outcome: "ok", cached: true }),
    ]);
    const node = state?.runs[0]?.nodes[0];
    expect(node).toEqual({
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      phase: "settled",
      outcome: "ok",
      cached: true,
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      instructionsHead: "查一遍",
    });
  });

  it("没有 cached 的普通 node-settled 照常携带读数（结算不是出生，跑过的账要留下）", () => {
    const { progress, state } = assignedState();
    const lived = step(
      state,
      progress("node-progress", {
        instance: ASK,
        turn: 5,
        toolCalls: 18,
        lastTool: { name: "Edit" },
      }),
    );
    const settled = step(lived, progress("node-settled", { instance: ASK, outcome: "ok" }));
    expect(settled.runs[0]?.nodes[0]).toMatchObject({
      phase: "settled",
      turn: 5,
      toolCalls: 18,
      lastTool: { name: "Edit" },
    });
  });

  it("指向表里没有的实例时不建条目，只抬水位（与其他节点事件对未知实例同族）", () => {
    const { progress, state } = assignedState();
    const before = state!.runs[0]!;
    const next = step(
      state,
      progress("node-progress", {
        instance: { siteId: "ask#9", ordinal: 9 },
        turn: 1,
        toolCalls: 0,
      }),
    );
    expect(next.runs[0]?.nodes).toEqual(before.nodes);
    expect(next.runs[0]?.lastEventSequence).toBe(before.lastEventSequence + 1);
  });

  it("instance 读不动、或三个读数一个都读不出来时，节点逐字节不变", () => {
    const { progress, state } = assignedState();
    const before = state!.runs[0]!.nodes;
    for (const payload of [
      { instance: { ordinal: 1 } },
      { instance: ASK },
      { instance: ASK, turn: 0 },
      { instance: ASK, turn: 1.5 },
      { instance: ASK, turn: Number.NaN },
      { instance: ASK, toolCalls: -1 },
      { instance: ASK, lastTool: { name: "" } },
      { instance: ASK, lastTool: "Bash" },
    ]) {
      const next = step(state, progress("node-progress", payload));
      expect(next.runs[0]?.nodes).toEqual(before);
    }
  });

  it("读不出的单个字段保持已知值，读得出的照常覆盖（后来者覆盖，不是取 max）", () => {
    const { progress, state } = assignedState();
    const first = step(
      state,
      progress("node-progress", {
        instance: ASK,
        turn: 4,
        toolCalls: 11,
        lastTool: { name: "Edit", target: "packages/shared/src/index.ts" },
      }),
    );
    // The one carrying only toolCalls: turn and lastTool are kept, not erased.
    const second = step(first, progress("node-progress", { instance: ASK, toolCalls: 12 }));
    expect(second.runs[0]?.nodes[0]).toMatchObject({
      turn: 4,
      toolCalls: 12,
      lastTool: { name: "Edit", target: "packages/shared/src/index.ts" },
    });
    // Taking max would freeze this at 4; last-writer-wins is what lets a re-run's ask go back to 1.
    const third = step(second, progress("node-progress", { instance: ASK, turn: 1, toolCalls: 0 }));
    expect(third.runs[0]?.nodes[0]).toMatchObject({ turn: 1, toolCalls: 0 });
  });

  it("三个字符串按线上界裁剪（生产侧已切，这里是第二道闸），产出仍过 strict schema", () => {
    const limits = WORKFLOW_RUNS_LIMITS;
    const progress = progressLog();
    const state = reduceAll([
      progress("run-started", started()),
      progress("node-queued", {
        instance: ASK,
        kind: "ask",
        instructionsHead: "指".repeat(limits.maxInstructionsHeadLength + 20),
      }),
      progress("node-progress", {
        instance: ASK,
        turn: 1,
        toolCalls: 1,
        lastTool: {
          name: "T".repeat(limits.maxLastToolNameLength + 10),
          target: "p".repeat(limits.maxLastToolTargetLength + 10),
        },
      }),
    ]);
    const node = state?.runs[0]?.nodes[0];
    expect(node?.instructionsHead).toHaveLength(limits.maxInstructionsHeadLength);
    expect(node?.lastTool?.name).toHaveLength(limits.maxLastToolNameLength);
    expect(node?.lastTool?.target).toHaveLength(limits.maxLastToolTargetLength);
    expect(workflowRunsStateSchema.parse(state)).toEqual(state);
  });

  it("幂等：同一条 node-progress 立刻重放只抬水位，内容不变", () => {
    const { progress, state } = assignedState();
    const payload = { instance: ASK, turn: 2, toolCalls: 3, lastTool: { name: "Read" } };
    const first = step(state, progress("node-progress", payload));
    const second = step(first, progress("node-progress", payload));
    expect(second.runs[0]?.nodes).toEqual(first.runs[0]?.nodes);
    // Only replaying the same event (same sequence) is true "no change": the watermark does not move and the reducer returns null.
    const replay = reduceWorkflowRunsState(first, {
      runId: RUN_ID,
      toolCallId: "tc-1",
      sequence: first.runs[0]!.lastEventSequence,
      eventType: "node-progress",
      payload,
    });
    expect(replay).toBeNull();
  });

  it("更新的 CLI 发来的未知事件仍然落到 default：只抬水位，不建节点", () => {
    const { progress, state } = assignedState();
    const before = state!.runs[0]!;
    const next = step(
      state,
      progress("node-heartbeat", { instance: { siteId: "ask#2", ordinal: 1 } }),
    );
    expect(next.runs[0]).toEqual({ ...before, lastEventSequence: before.lastEventSequence + 1 });
  });
});

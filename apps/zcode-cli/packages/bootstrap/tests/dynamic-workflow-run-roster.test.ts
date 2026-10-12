// The rules layer of the situation snapshot (docs/dynamic-workflow/launch.md "`GetWorkflowRun`"): the set of judgments
// that derive the phase table, the subagent roster, and the three health field groups from
// "journal events + node rows + actor rows + reduced state".
//
// This deliberately touches neither SQLite nor the engine: rule density is high (the decision order of status words,
// the reading of absences, the single source of time), and the real data-fetching surface is prohibitively expensive
// in tests. Events and rows are hand-built; the reduced state goes through the production minting chain
// (toProgressPayload → reduceWorkflowRunsState) — the one shared by the run panel and cold replay, not a second copy.
// Whether the wiring works is proven by dynamic-workflow-run-service.test.ts's real-database cases.
import { describe, expect, it } from "vitest";
import type {
  ActorRecord,
  NodeRecord,
  NodeRecordStatus,
  RunEvent,
  StoredEvent,
} from "@zcode/dynamic-workflow";
import {
  reduceWorkflowRunsState,
  type WorkflowRunsState,
  type WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import { toProgressPayload } from "../src/app/dynamic-workflow-run-launch.js";
import { buildWorkflowRunRoster } from "../src/app/dynamic-workflow-run-roster.js";

const RUN_ID = "dwfrun-roster";
/** The base instant of event times (2023-11-14T22:13:20Z); assertions always write `T0 + offset`. */
const T0 = 1_700_000_000_000;
/** The instant of this read: after all events, so the upper clamp never engages and the assertions read the events' own times. */
const NOW = T0 + 600_000;

type Entry = readonly [offset: number | undefined, event: RunEvent];

/** Hand-built event track: sequence allocated in order; an `undefined` offset means "this event has no timestamp" (old journal). */
function evented(entries: readonly Entry[]): StoredEvent[] {
  return entries.map(([offset, event], index) => ({
    sequence: index + 1,
    event,
    ...(offset === undefined ? {} : { timeCreated: T0 + offset }),
  }));
}

/**
 * The same minting chain as production: events → progress payload → the run panel's exact reduced state.
 *
 * `ceiling` is the default concurrency at payload-minting time (the wire key `concurrencyCeiling`, only landing on
 * `run-started`). With it, the reduced state can recognize "this run set its own bound different from the default" —
 * the two numbers of the concurrency health surface are computed from exactly that bound.
 */
function reduceOf(events: readonly StoredEvent[], ceiling?: number): WorkflowRunState | undefined {
  let state: WorkflowRunsState | undefined;
  for (const stored of events) {
    const payload = toProgressPayload({
      event: stored.event,
      runId: RUN_ID,
      sequence: stored.sequence,
      ...(ceiling === undefined ? {} : { concurrencyCeiling: ceiling }),
    });
    state = reduceWorkflowRunsState(state, payload) ?? state;
  }
  return state?.runs.find((run) => run.runId === RUN_ID);
}

function actorRow(siteId: string, name: string): ActorRecord {
  return { runId: RUN_ID, siteId, ordinal: 1, name };
}

function askRow(input: {
  siteId: string;
  ordinal?: number;
  actorSiteId: string;
  actorSeq: number;
  status: NodeRecordStatus;
  tokens?: number;
}): NodeRecord {
  const ordinal = input.ordinal ?? 1;
  return {
    runId: RUN_ID,
    siteId: input.siteId,
    ordinal,
    kind: "ask",
    actorSiteId: input.actorSiteId,
    actorOrdinal: 1,
    actorSeq: input.actorSeq,
    inputHash: `hash-${input.siteId}-${ordinal}`,
    status: input.status,
    ...(input.tokens === undefined
      ? {}
      : { stats: { tokens: input.tokens, toolCalls: 3, turns: 2 } }),
  };
}

// ── (a) An in-flight run: four subagents each in one situation ──────────────────────────────────────
describe("情势截面 — 在飞的 run", () => {
  const events = evented([
    [0, { type: "run-started", runId: RUN_ID, caps: { maxConcurrency: 4 } }],
    [0, { type: "run-launched", inputId: "in-1", phaseNames: ["collect", "verify"] }],
    [1_000, { type: "phase-entered", name: "collect", ordinal: 1 }],

    // ① scout: the model request is genuinely running; two progress events say it is still moving.
    [
      1_100,
      {
        type: "actor-created",
        actor: { siteId: "agent#1", ordinal: 1 },
        name: "scout",
        phaseName: "collect",
      },
    ],
    [
      1_200,
      {
        type: "node-queued",
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "agent#1", ordinal: 1 },
        actorSeq: 1,
        phaseName: "collect",
        instructionsHead: "Read the release notes and list every regression you can name.",
      },
    ],
    [1_300, { type: "node-dispatched", instance: { siteId: "ask#1", ordinal: 1 } }],
    [1_400, { type: "node-executing", instance: { siteId: "ask#1", ordinal: 1 } }],
    [
      2_000,
      {
        type: "node-progress",
        instance: { siteId: "ask#1", ordinal: 1 },
        turn: 1,
        toolCalls: 2,
        lastTool: { name: "Read", target: "docs/release.md" },
      },
    ],
    [2_010, { type: "usage-updated", spentTokens: 400 }],
    [
      2_100,
      {
        type: "node-progress",
        instance: { siteId: "ask#1", ordinal: 1 },
        turn: 2,
        toolCalls: 5,
        lastTool: { name: "Bash", target: "rg -n regression" },
      },
    ],
    [2_110, { type: "usage-updated", spentTokens: 900 }],

    // ② runner: on the backoff ladder, emitting two node-waiting in a row.
    [
      3_000,
      {
        type: "actor-created",
        actor: { siteId: "agent#2", ordinal: 1 },
        name: "runner",
        phaseName: "collect",
      },
    ],
    [
      3_100,
      {
        type: "node-queued",
        instance: { siteId: "ask#2", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "agent#2", ordinal: 1 },
        actorSeq: 1,
        phaseName: "collect",
        instructionsHead: "Re-run the failing suite and report the first red test.",
      },
    ],
    [3_200, { type: "node-dispatched", instance: { siteId: "ask#2", ordinal: 1 } }],
    [3_300, { type: "node-executing", instance: { siteId: "ask#2", ordinal: 1 } }],
    [
      4_000,
      {
        type: "node-waiting",
        instance: { siteId: "ask#2", ordinal: 1 },
        cause: "backoff",
        reason: "provider returned 429",
        attempt: 1,
        retryAfterMs: 30_000,
      },
    ],
    [
      5_000,
      {
        type: "node-waiting",
        instance: { siteId: "ask#2", ordinal: 1 },
        cause: "backoff",
        reason: "provider returned 429",
        attempt: 2,
        retryAfterMs: 60_000,
      },
    ],

    // ③ asker: escalated its question to the main agent and is stopped there waiting for the answer.
    [
      6_000,
      {
        type: "actor-created",
        actor: { siteId: "agent#3", ordinal: 1 },
        name: "asker",
        phaseName: "collect",
      },
    ],
    [
      6_100,
      {
        type: "node-queued",
        instance: { siteId: "ask#3", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "agent#3", ordinal: 1 },
        actorSeq: 1,
        phaseName: "collect",
        instructionsHead: "Decide which fixture to keep.",
      },
    ],
    [6_200, { type: "node-dispatched", instance: { siteId: "ask#3", ordinal: 1 } }],
    [6_300, { type: "node-executing", instance: { siteId: "ask#3", ordinal: 1 } }],
    [
      6_400,
      {
        type: "escalation-raised",
        qid: "dwfq-roster-1",
        actor: { siteId: "agent#3", ordinal: 1 },
        actorName: "asker",
        question: "Which fixture should survive?",
        askedAt: T0 + 6_400,
      },
    ],

    // ④ idler: both asks settled; the latter was a replay hit (no queued, settled is its birth event).
    [
      7_000,
      {
        type: "actor-created",
        actor: { siteId: "agent#4", ordinal: 1 },
        name: "idler",
        phaseName: "collect",
      },
    ],
    [
      7_100,
      {
        type: "node-queued",
        instance: { siteId: "ask#4", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "agent#4", ordinal: 1 },
        actorSeq: 1,
        phaseName: "collect",
        instructionsHead: "Summarise the findings.",
      },
    ],
    [7_200, { type: "node-dispatched", instance: { siteId: "ask#4", ordinal: 1 } }],
    [7_300, { type: "node-settled", instance: { siteId: "ask#4", ordinal: 1 }, outcome: "ok" }],
    [
      7_400,
      {
        type: "node-settled",
        instance: { siteId: "ask#4", ordinal: 2 },
        outcome: "ok",
        cached: true,
        phaseName: "collect",
      },
    ],

    // ⑤ Run-level observation: the gate was pushed down by rate limiting, then no progress for a while.
    [
      10_000,
      {
        type: "concurrency-changed",
        key: "zhipu/glm-4",
        previous: 4,
        next: 2,
        reason: "rate_limited",
        cooldownMs: 5_000,
      },
    ],
    [11_000, { type: "run-stalled", sinceMs: 120_000, reason: "no turn resolved", cap: 2 }],
  ]);

  const nodes: NodeRecord[] = [
    askRow({ siteId: "ask#1", actorSiteId: "agent#1", actorSeq: 1, status: "running" }),
    askRow({ siteId: "ask#2", actorSiteId: "agent#2", actorSeq: 1, status: "running" }),
    askRow({ siteId: "ask#3", actorSiteId: "agent#3", actorSeq: 1, status: "running" }),
    askRow({
      siteId: "ask#4",
      actorSiteId: "agent#4",
      actorSeq: 1,
      status: "completed",
      tokens: 120,
    }),
    askRow({
      siteId: "ask#4",
      ordinal: 2,
      actorSiteId: "agent#4",
      actorSeq: 2,
      status: "completed",
      tokens: 80,
    }),
  ];

  const roster = buildWorkflowRunRoster({
    run: reduceOf(events),
    events,
    nodes,
    actors: [
      actorRow("agent#1", "scout"),
      actorRow("agent#2", "runner"),
      actorRow("agent#3", "asker"),
      actorRow("agent#4", "idler"),
    ],
    status: "running",
    pendingQuestions: [
      {
        qid: "dwfq-roster-1",
        actor: "agent#3@1",
        actorName: "asker",
        question: "Which fixture should survive?",
        askedAt: T0 + 6_400,
      },
    ],
    now: NOW,
  });

  const subagentOf = (siteId: string) =>
    roster.subagents.find((subagent) => subagent.siteId === siteId);

  it("正在跑的子代理带任务摘要、轮次读数与最近一次工具（时刻取那条 node-progress）", () => {
    expect(subagentOf("agent#1")).toMatchObject({
      name: "scout",
      state: "executing",
      phaseName: "collect",
      currentAsk: {
        siteId: "ask#1",
        ordinal: 1,
        actorSeq: 1,
        instructionsHead: "Read the release notes and list every regression you can name.",
        // The start instant is node-dispatched, not node-queued: queueing is not running.
        startedAt: T0 + 1_300,
        turn: 2,
        toolCalls: 5,
        lastTool: { name: "Bash", target: "rg -n regression", at: T0 + 2_100 },
      },
      stepsSettled: 0,
      tokens: 0,
      // The run-level usage-updated carries no instance, so it does not count against **this** subagent.
      lastProgressAt: T0 + 2_100,
    });
  });

  it("退避中的子代理报 waiting，since 是**进入**这次等待的时刻而不是最后一条观察", () => {
    expect(subagentOf("agent#2")).toMatchObject({
      state: "waiting",
      wait: {
        cause: "backoff",
        reason: "provider returned 429",
        // The ladder's second entry brings a new retry interval, but "how long stuck" counts from the first one.
        retryAfterMs: 60_000,
        since: T0 + 4_000,
      },
    });
    // Waiting is not progress: the last progress is still the moment it started running.
    expect(subagentOf("agent#2")?.lastProgressAt).toBe(T0 + 3_300);
    // On an ask without node-progress, all three readings are absent — never 0.
    const currentAsk = subagentOf("agent#2")?.currentAsk;
    expect(currentAsk).toBeDefined();
    expect("turn" in currentAsk!).toBe(false);
    expect("toolCalls" in currentAsk!).toBe(false);
    expect("lastTool" in currentAsk!).toBe(false);
  });

  it("停驻等答案的子代理报 parked 而不是 executing（它确实有 ask 在跑，但那不是它此刻的处境）", () => {
    expect(subagentOf("agent#3")).toMatchObject({
      state: "parked",
      parkedOn: "dwfq-roster-1",
      currentAsk: { siteId: "ask#3", ordinal: 1 },
    });
  });

  it("活着的 run 里全部结算完的子代理是 idle（done 是终态才有的词），token 只累计已结算的 ask", () => {
    const idler = subagentOf("agent#4");
    expect(idler).toMatchObject({
      state: "idle",
      stepsSettled: 2,
      stepsFailed: 0,
      tokens: 200,
      lastProgressAt: T0 + 7_400,
    });
    expect("currentAsk" in idler!).toBe(false);
  });

  it("阶段表：走到的那个是 current，声明了没走到的是 ahead 且 rounds 为 0", () => {
    expect(roster.phases).toEqual([
      {
        name: "collect",
        state: "current",
        rounds: 1,
        nodesSettled: 2,
        nodesRunning: 3,
        enteredAt: T0 + 1_000,
      },
      { name: "verify", state: "ahead", rounds: 0, nodesSettled: 0, nodesRunning: 0 },
    ]);
  });

  it("健康：停滞时刻是最后一条 run-stalled（其后没有进度），并发报的是「自己那条界里放行了几个」", () => {
    expect(roster.health).toEqual({
      // The last progress is idler's cached settlement; neither concurrency-changed nor run-stalled counts as progress.
      lastProgressAt: T0 + 7_400,
      stalledSince: T0 + 11_000,
      concurrency: { effective: 2, cap: 4, reason: "rate_limited", since: T0 + 10_000 },
      consecutiveFailures: 0,
      cachedSteps: 1,
      pendingQuestionsKnown: true,
    });
  });
});

// ── Definition of progress: the script moving itself counts; waiting for a slot does not ────────────────────────────────────
describe("情势截面 — 什么算进度", () => {
  function healthOf(events: readonly StoredEvent[]) {
    return buildWorkflowRunRoster({
      run: reduceOf(events),
      events,
      nodes: [],
      actors: [],
      status: "running",
      pendingQuestions: [],
      now: NOW,
    }).health;
  }

  it("停滞之后的一行 log 就把停滞清掉，并把最后进度推到那一刻：那是脚本在往前走", () => {
    // A script that runs a batch of world reads between two asks sends no ask events at all; exclude log and that
    // whole stretch would be misreported as stalled.
    const narrated = evented([
      [0, { type: "run-started", runId: RUN_ID, caps: { maxConcurrency: 4 } }],
      [1_000, { type: "run-stalled", sinceMs: 120_000, reason: "no turn resolved" }],
      [2_000, { type: "log", message: "scanning the workspace" }],
    ]);
    const health = healthOf(narrated);
    expect("stalledSince" in health).toBe(false);
    expect(health.lastProgressAt).toBe(T0 + 2_000);
  });

  it("一次 phase-entered 同样算进度：刚进阶段、正在派发的 run 不该读成停滞", () => {
    const advanced = evented([
      [0, { type: "run-started", runId: RUN_ID, caps: { maxConcurrency: 4 } }],
      [1_000, { type: "run-stalled", sinceMs: 120_000, reason: "no turn resolved" }],
      [3_000, { type: "phase-entered", name: "verify", ordinal: 1 }],
    ]);
    const health = healthOf(advanced);
    expect("stalledSince" in health).toBe(false);
    expect(health.lastProgressAt).toBe(T0 + 3_000);
  });

  it("停滞之后只剩等待观察时，停滞仍然在场：那段等待正是停滞本身", () => {
    const stuck = evented([
      [0, { type: "run-started", runId: RUN_ID, caps: { maxConcurrency: 4 } }],
      [
        1_000,
        {
          type: "node-queued",
          instance: { siteId: "ask#1", ordinal: 1 },
          kind: "ask",
          actor: { siteId: "agent#1", ordinal: 1 },
          actorSeq: 1,
        },
      ],
      [2_000, { type: "run-stalled", sinceMs: 120_000, reason: "no slot" }],
      [3_000, { type: "node-waiting", instance: { siteId: "ask#1", ordinal: 1 }, cause: "slot" }],
      [
        4_000,
        {
          type: "concurrency-changed",
          key: "zhipu/glm-4",
          previous: 4,
          next: 1,
          reason: "rate_limited",
        },
      ],
    ]);
    const health = healthOf(stuck);
    expect(health.stalledSince).toBe(T0 + 2_000);
    // The last real progress is still that queueing.
    expect(health.lastProgressAt).toBe(T0 + 1_000);
  });
});

// ── Concurrency health surface: the two numbers say "how many it admitted within its own bound" ──────────────────────────
describe("情势截面 — 并发", () => {
  /** This run set 3, the machine ceiling 6; the governor pressed the shared gate to 2. */
  const throttled = evented([
    [0, { type: "run-started", runId: RUN_ID, caps: { maxConcurrency: 3 } }],
    [
      1_000,
      {
        type: "concurrency-changed",
        key: "zhipu/glm-4",
        previous: 6,
        next: 2,
        reason: "rate_limited",
      },
    ],
  ]);

  function healthOf(events: readonly StoredEvent[], ceiling: number) {
    return buildWorkflowRunRoster({
      run: reduceOf(events, ceiling),
      events,
      nodes: [],
      actors: [],
      status: "running",
      pendingQuestions: [],
      now: NOW,
    }).health;
  }

  it("cap 是**本 run 自己的**上界而不是机器天花板（否则 3 核的 run 永远显示成被限流）", () => {
    expect(healthOf(throttled, 6).concurrency).toEqual({
      effective: 2,
      cap: 3,
      reason: "rate_limited",
      since: T0 + 1_000,
    });
  });

  it("跑满自己那条界的 run：整个 concurrency 字段缺席（在场即「正被限着」）", () => {
    // Only this run's own bound is below the ceiling and the shared gate never moved ⇒ effective === cap ⇒ nothing to say.
    const unthrottled = evented([
      [0, { type: "run-started", runId: RUN_ID, caps: { maxConcurrency: 3 } }],
    ]);
    expect("concurrency" in healthOf(unthrottled, 6)).toBe(false);
  });
});

// ── (b) A completed run: the full phase table + the terminal state's three status words ──────────────────────────────
describe("情势截面 — 已完成的 run", () => {
  const events = evented([
    [0, { type: "run-started", runId: RUN_ID, caps: { maxConcurrency: 4 } }],
    [
      0,
      {
        type: "run-launched",
        inputId: "in-2",
        phaseNames: ["plan", "build", "verify", "publish"],
      },
    ],
    [1_000, { type: "phase-entered", name: "plan", ordinal: 1 }],
    [1_100, { type: "actor-created", actor: { siteId: "agent#1", ordinal: 1 }, name: "planner" }],
    [
      1_200,
      {
        type: "node-queued",
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "agent#1", ordinal: 1 },
        actorSeq: 1,
        phaseName: "plan",
        instructionsHead: "Draft the plan.",
      },
    ],
    [1_300, { type: "node-dispatched", instance: { siteId: "ask#1", ordinal: 1 } }],
    [1_400, { type: "node-settled", instance: { siteId: "ask#1", ordinal: 1 }, outcome: "ok" }],

    [2_000, { type: "phase-entered", name: "build", ordinal: 1 }],
    [2_100, { type: "actor-created", actor: { siteId: "agent#2", ordinal: 1 }, name: "builder" }],
    [
      2_200,
      {
        type: "node-queued",
        instance: { siteId: "ask#2", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "agent#2", ordinal: 1 },
        actorSeq: 1,
        phaseName: "build",
        instructionsHead: "Build it.",
      },
    ],
    [2_300, { type: "node-dispatched", instance: { siteId: "ask#2", ordinal: 1 } }],
    [2_400, { type: "node-settled", instance: { siteId: "ask#2", ordinal: 1 }, outcome: "failed" }],
    [
      2_500,
      {
        type: "node-queued",
        instance: { siteId: "ask#2", ordinal: 2 },
        kind: "ask",
        actor: { siteId: "agent#2", ordinal: 1 },
        actorSeq: 2,
        phaseName: "build",
        instructionsHead: "Build it again.",
      },
    ],
    [2_600, { type: "node-dispatched", instance: { siteId: "ask#2", ordinal: 2 } }],
    [2_700, { type: "node-settled", instance: { siteId: "ask#2", ordinal: 2 }, outcome: "failed" }],

    // Back edge: control flow went back into plan once more, then went to verify.
    [3_000, { type: "phase-entered", name: "plan", ordinal: 2 }],
    [4_000, { type: "phase-entered", name: "verify", ordinal: 1 }],
    [5_000, { type: "run-settled", status: "completed" }],
  ]);

  const roster = buildWorkflowRunRoster({
    run: reduceOf(events),
    events,
    nodes: [
      askRow({
        siteId: "ask#1",
        actorSiteId: "agent#1",
        actorSeq: 1,
        status: "completed",
        tokens: 50,
      }),
      askRow({
        siteId: "ask#2",
        actorSiteId: "agent#2",
        actorSeq: 1,
        status: "failed",
        tokens: 10,
      }),
      askRow({
        siteId: "ask#2",
        ordinal: 2,
        actorSiteId: "agent#2",
        actorSeq: 2,
        status: "failed",
        tokens: 20,
      }),
    ],
    actors: [actorRow("agent#1", "planner"), actorRow("agent#2", "builder")],
    status: "completed",
    pendingQuestions: [],
    now: NOW,
  });

  it("阶段表按声明序，回边的阶段取**最近一次**进入，离开时刻是下一个异名阶段进入的那一刻", () => {
    expect(roster.phases).toEqual([
      {
        name: "plan",
        state: "done",
        // Entered twice; the second instant is taken, not the first.
        rounds: 2,
        nodesSettled: 1,
        nodesRunning: 0,
        enteredAt: T0 + 3_000,
        exitedAt: T0 + 4_000,
      },
      {
        name: "build",
        state: "done",
        rounds: 1,
        nodesSettled: 2,
        nodesRunning: 0,
        enteredAt: T0 + 2_000,
        exitedAt: T0 + 3_000,
      },
      // The last-entered phase has no exit instant; the run is already terminal, so it is not current either.
      {
        name: "verify",
        state: "done",
        rounds: 1,
        nodesSettled: 0,
        nodesRunning: 0,
        enteredAt: T0 + 4_000,
      },
      { name: "publish", state: "ahead", rounds: 0, nodesSettled: 0, nodesRunning: 0 },
    ]);
  });

  it("终态 run 的状态词只剩 done / failed，末尾连败被数成 2", () => {
    expect(roster.subagents).toMatchObject([
      { name: "planner", state: "done", stepsSettled: 1, stepsFailed: 0, tokens: 50 },
      { name: "builder", state: "failed", stepsSettled: 2, stepsFailed: 2, tokens: 30 },
    ]);
    expect(roster.health).toMatchObject({ consecutiveFailures: 2, cachedSteps: 0 });
    // No leftover rows: the whole field is absent (0 is noise).
    expect("leftoverRunning" in roster.health).toBe(false);
  });
});

// ── (c) An interrupted run not held by this session ─────────────────────────────────────────
describe("情势截面 — 被打断且查不到停驻表的 run", () => {
  const events = evented([
    [0, { type: "run-started", runId: RUN_ID, caps: { maxConcurrency: 4 } }],
    [0, { type: "run-launched", inputId: "in-3", phaseNames: ["work"] }],
    [1_000, { type: "phase-entered", name: "work", ordinal: 1 }],
    [1_100, { type: "actor-created", actor: { siteId: "agent#1", ordinal: 1 }, name: "worker" }],
    [
      1_200,
      {
        type: "node-queued",
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "agent#1", ordinal: 1 },
        actorSeq: 1,
        phaseName: "work",
        instructionsHead: "Do the long thing.",
      },
    ],
    [1_300, { type: "node-dispatched", instance: { siteId: "ask#1", ordinal: 1 } }],
    [1_400, { type: "node-executing", instance: { siteId: "ask#1", ordinal: 1 } }],
  ]);

  const roster = buildWorkflowRunRoster({
    run: reduceOf(events),
    events,
    nodes: [askRow({ siteId: "ask#1", actorSiteId: "agent#1", actorSeq: 1, status: "running" })],
    actors: [actorRow("agent#1", "worker")],
    status: "stopped",
    // The parked table is unreadable: the run belongs to another process, and this read cannot tell "nobody waiting" from "unknown".
    now: NOW,
  });

  it("行还标着 running 的子代理在终态 run 上是 unfinished，并被数进 leftoverRunning", () => {
    expect(roster.subagents[0]).toMatchObject({ name: "worker", state: "unfinished" });
    expect(roster.health.leftoverRunning).toBe(1);
  });

  it("查不到停驻表时 pendingQuestionsKnown 为假，且没有任何子代理被报成 parked", () => {
    expect(roster.health.pendingQuestionsKnown).toBe(false);
    expect(roster.subagents.every((subagent) => !("parkedOn" in subagent))).toBe(true);
  });

  it("终态 run 上仍有在飞 ask 的阶段是 unfinished，不是 done", () => {
    expect(roster.phases).toEqual([
      {
        name: "work",
        state: "unfinished",
        rounds: 1,
        nodesSettled: 0,
        nodesRunning: 1,
        enteredAt: T0 + 1_000,
      },
    ]);
  });
});

// ── (d) Old journal: no node-progress, no instructionsHead, no timestamps ──────────
describe("情势截面 — 老 journal", () => {
  const events = evented([
    [undefined, { type: "run-started", runId: RUN_ID, caps: { maxConcurrency: 4 } }],
    [undefined, { type: "phase-entered", name: "work", ordinal: 1 }],
    [
      undefined,
      { type: "actor-created", actor: { siteId: "agent#1", ordinal: 1 }, name: "veteran" },
    ],
    [
      undefined,
      {
        type: "node-queued",
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "agent#1", ordinal: 1 },
        actorSeq: 1,
        phaseName: "work",
      },
    ],
    [undefined, { type: "node-dispatched", instance: { siteId: "ask#1", ordinal: 1 } }],
    [undefined, { type: "node-executing", instance: { siteId: "ask#1", ordinal: 1 } }],
  ]);

  const roster = buildWorkflowRunRoster({
    run: reduceOf(events),
    events,
    nodes: [askRow({ siteId: "ask#1", actorSiteId: "agent#1", actorSeq: 1, status: "running" })],
    actors: [actorRow("agent#1", "veteran")],
    status: "running",
    pendingQuestions: [],
    now: NOW,
  });

  it("所有时刻整个缺席，绝不用读的那一刻兜底，也绝不出现 NaN", () => {
    const subagent = roster.subagents[0]!;
    expect(subagent.state).toBe("executing");
    expect("lastProgressAt" in subagent).toBe(false);
    expect("startedAt" in subagent.currentAsk!).toBe(false);
    expect("lastProgressAt" in roster.health).toBe(false);
    expect("enteredAt" in roster.phases![0]!).toBe(false);
    // A JSON round-trip guards the whole tree: any NaN would turn into null here and be caught by the assertion.
    expect(JSON.stringify(roster)).not.toContain("null");
    expect(JSON.stringify(roster)).not.toContain("NaN");
  });

  it("没有 node-queued 任务摘要、没有 node-progress 读数时，那几个键一个都不编", () => {
    const currentAsk = roster.subagents[0]!.currentAsk!;
    expect(currentAsk).toEqual({ siteId: "ask#1", ordinal: 1, actorSeq: 1 });
  });

  it("run 一条事件都没有时：阶段表整个缺席、花名册为空、健康全零", () => {
    const empty = buildWorkflowRunRoster({
      run: undefined,
      events: [],
      nodes: [],
      actors: [],
      status: "pending",
      pendingQuestions: [],
      now: NOW,
    });
    expect(empty).toEqual({
      subagents: [],
      health: { consecutiveFailures: 0, cachedSteps: 0, pendingQuestionsKnown: true },
    });
  });
});

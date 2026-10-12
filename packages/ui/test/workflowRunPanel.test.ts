// Pure logic of the dwf run detail page: Cancel availability, result/failure panel decisions, event-log line summaries.
// All without jsdom or components — these are the only "rule-bearing" parts of the detail page, and enumerating them
// needs no rendered picture. See docs/dynamic-workflow/presentation.md "The run pane", "Cancel semantics", "Event log".
import { describe, expect, it } from "vitest";
import type {
  WorkflowRunNode,
  WorkflowRunState,
  WorkflowRunActor,
} from "@zcode/shared/zcode-protocol-v4";
import {
  isWorkflowRunCancellable,
  isWorkflowRunResumable,
  workflowActorStartState,
  type WorkflowActorSlotRef,
  workflowRunEventLines,
  workflowRunResultView,
} from "@/app-shell/workflowRunPanel.js";
// The escalation Q&A rules live in the sibling workflowRunQuestions.ts (split out to respect the max-lines gate),
// but they belong to the same family of "pure detail-page rules" as the groups above, so they are pinned in the same suite.
import { workflowRunQuestionWaitedLabel } from "@/app-shell/workflowRunQuestions.js";

/** Test formatMessage: returns the id verbatim; with interpolation it joins as `id:v1/v2`, making it easy to assert which key was picked. */
const format = (descriptor: { id: string }, values?: Record<string, string>) =>
  values ? `${descriptor.id}:${Object.values(values).join("/")}` : descriptor.id;

function run(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    runId: "dwfrun-1",
    status: "running",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [],
    nodes: [],
    lastEventSequence: 0,
    ...overrides,
  };
}

describe("isWorkflowRunCancellable", () => {
  it("只有 running 可取消", () => {
    expect(isWorkflowRunCancellable(run({ status: "running" }))).toBe(true);
    for (const status of ["pending", "completed", "errored", "stopped"] as const) {
      expect(isWorkflowRunCancellable(run({ status }))).toBe(false);
    }
  });

  it("run 不在投影里（被淘汰 / 冷启动）时不可取消", () => {
    expect(isWorkflowRunCancellable(undefined)).toBe(false);
  });
});

describe("workflowRunResultView", () => {
  it("pending / running 没有结果面板", () => {
    expect(workflowRunResultView(run({ status: "pending" })).kind).toBe("none");
    expect(workflowRunResultView(run({ status: "running" })).kind).toBe("none");
  });

  it("completed 且无 resultPreview 时只报完成、绝不编造结果", () => {
    // resultPreview is always absent at this stage (the script's artifact lives only in RunSettlement.artifact —
    // neither on the run-settled event nor in the journal). The artifact's destination is the background result turn
    // in the conversation; the detail page can only point there.
    const view = workflowRunResultView(run({ status: "completed" }));
    expect(view).toEqual({ kind: "completed" });
  });

  it("completed 且真带 resultPreview 时如实展示（schema 允许，本阶段不可达）", () => {
    const view = workflowRunResultView(run({ status: "completed", resultPreview: "42 files" }));
    expect(view).toEqual({ kind: "completed", preview: "42 files" });
  });

  it("errored / stopped 报错误原文；error 缺省时仍进错误面板；stopped 带原因词", () => {
    expect(workflowRunResultView(run({ status: "errored", error: "boom" }))).toEqual({
      kind: "error",
      status: "errored",
      message: "boom",
    });
    expect(workflowRunResultView(run({ status: "stopped" }))).toEqual({
      kind: "error",
      status: "stopped",
    });
    expect(
      workflowRunResultView(run({ status: "stopped", stopReason: "provider", error: "expired" })),
    ).toEqual({ kind: "error", status: "stopped", stopReason: "provider", message: "expired" });
  });

  it("run 缺席时是 absent，而不是伪造一个 pending", () => {
    expect(workflowRunResultView(undefined)).toEqual({ kind: "absent" });
  });
});

// Wait duration for pending questions (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md). `now` is injected by the caller instead of reading the clock:
// a waiting run precisely sends no events, so the component itself feeds fresh instants at a fixed interval, while the rules stay here to be enumerated.
describe("workflowRunQuestionWaitedLabel", () => {
  const NOW = 1_756_000_000_000;
  const MINUTE = 60_000;

  it("按分钟 / 小时 / 天分档，不足一分钟说「刚刚」", () => {
    const at = (elapsedMs: number) => workflowRunQuestionWaitedLabel(NOW - elapsedMs, NOW, format);
    expect(at(0)).toBe("sidePane.time.justNow");
    expect(at(59_999)).toBe("sidePane.time.justNow");
    expect(at(MINUTE)).toBe("sidePane.time.minutesAgo:1");
    expect(at(42 * MINUTE)).toBe("sidePane.time.minutesAgo:42");
    expect(at(59 * MINUTE + 59_999)).toBe("sidePane.time.minutesAgo:59");
    expect(at(60 * MINUTE)).toBe("sidePane.time.hoursAgo:1");
    expect(at(23 * 60 * MINUTE)).toBe("sidePane.time.hoursAgo:23");
    expect(at(24 * 60 * MINUTE)).toBe("sidePane.time.daysAgo:1");
    // The ladder stops at "days": the spec rejected a timeout, and by design a question may wait indefinitely.
    expect(at(9 * 24 * 60 * MINUTE)).toBe("sidePane.time.daysAgo:9");
  });

  it("askedAt 缺席时整段不渲染，而不是编一个「刚刚」出来", () => {
    // Events replayed from an old journal lack this field. Showing a fake instant is worse than showing nothing.
    expect(workflowRunQuestionWaitedLabel(undefined, NOW, format)).toBeUndefined();
    expect(workflowRunQuestionWaitedLabel(Number.NaN, NOW, format)).toBeUndefined();
  });

  it("时钟偏斜把 askedAt 推到未来时钳到「刚刚」，绝不给出负数时长", () => {
    // The asked instant is minted by the CLI process; in a remote session it is not even on the same machine as the renderer.
    expect(workflowRunQuestionWaitedLabel(NOW + 5 * MINUTE, NOW, format)).toBe(
      "sidePane.time.justNow",
    );
  });
});

describe("workflowRunEventLines", () => {
  it("把引擎实际发出的每个种类摘成可读一行，而不是 dump JSON", () => {
    const lines = workflowRunEventLines(
      [
        {
          sequence: 1,
          type: "run-started",
          payload: { runId: "dwfrun-1", caps: { maxConcurrency: 8 } },
        },
        {
          sequence: 2,
          type: "actor-created",
          payload: { actor: { siteId: "actor#1", ordinal: 1 }, name: "planner" },
        },
        {
          sequence: 3,
          type: "node-queued",
          payload: { instance: { siteId: "ask#1", ordinal: 1 }, kind: "ask" },
        },
        {
          sequence: 4,
          type: "node-dispatched",
          payload: { instance: { siteId: "ask#1", ordinal: 1 } },
        },
        {
          sequence: 5,
          type: "node-repairing",
          payload: { instance: { siteId: "ask#1", ordinal: 1 }, attempt: 2, violations: [{}, {}] },
        },
        {
          sequence: 6,
          type: "node-nudged",
          payload: { instance: { siteId: "ask#1", ordinal: 1 } },
        },
        {
          sequence: 7,
          type: "node-settled",
          payload: { instance: { siteId: "ask#1", ordinal: 1 }, outcome: "ok" },
        },
        { sequence: 8, type: "usage-updated", payload: { spentTokens: 1_234 } },
        { sequence: 9, type: "log", payload: { message: "scanning workspace" } },
        {
          sequence: 10,
          type: "import-cache-closed",
          payload: { instance: { siteId: "ask#2", ordinal: 1 }, cause: "mutating-tool", actorName: "fixer" },
        },
        { sequence: 11, type: "run-settled", payload: { status: "completed" } },
      ],
      format,
    );

    expect(lines.map((line) => line.label)).toEqual([
      "chat.toolCall.workflow.run.event.runStarted",
      "chat.toolCall.workflow.run.event.actorCreated",
      "chat.toolCall.workflow.run.event.nodeQueued",
      "chat.toolCall.workflow.run.event.nodeDispatched",
      "chat.toolCall.workflow.run.event.nodeRepairing:2",
      "chat.toolCall.workflow.run.event.nodeNudged",
      "chat.toolCall.workflow.run.event.nodeSettled:chat.toolCall.workflow.run.outcome.ok",
      "chat.toolCall.workflow.run.event.usageUpdated",
      "chat.toolCall.workflow.run.event.log",
      "chat.toolCall.workflow.run.event.importCacheClosed",
      "chat.toolCall.workflow.run.event.runSettled:chat.toolCall.workflow.run.status.completed",
    ]);
    // Identity goes in detail; label carries only the localized half of the sentence.
    expect(lines[1]!.detail).toBe("planner · actor#1@1");
    // Gate-closing events name who closed it: subagent name + instance; a gate closed by world.run carries only the instance.
    expect(lines[9]!.detail).toBe("fixer · ask#2@1");
    expect(lines[2]!.detail).toBe("ask#1@1 · ask");
    expect(lines[3]!.detail).toBe("ask#1@1");
    expect(lines[8]!.detail).toBe("scanning workspace");
    // No line leaks raw JSON.
    for (const line of lines) expect(line.detail ?? "").not.toContain("{");
  });

  it("cached 命中在 settled 行上明说，failed 行带错误原文并标成失败色", () => {
    const [cached, failed] = workflowRunEventLines(
      [
        {
          sequence: 1,
          type: "node-settled",
          payload: { instance: { siteId: "ask#2", ordinal: 3 }, outcome: "ok", cached: true },
        },
        {
          sequence: 2,
          type: "node-settled",
          payload: {
            instance: { siteId: "ask#2", ordinal: 4 },
            outcome: "failed",
            error: { message: "schema mismatch" },
          },
        },
      ],
      format,
    );

    expect(cached!.label).toBe(
      "chat.toolCall.workflow.run.event.nodeSettledCached:chat.toolCall.workflow.run.outcome.ok",
    );
    expect(cached!.tone).toBe("default");
    expect(failed!.detail).toBe("ask#2@4 · schema mismatch");
    expect(failed!.tone).toBe("failed");
  });

  /**
   * Escalation Q&A (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md). Neither may fall into the
   * unknown fallback: they are this feature's only two traces on the audit surface, and showing "unknown event
   * escalation-raised" equals not having implemented it.
   */
  it("升级两行自成一类：qid 打头（唯一的关联键），actor 名缺席时退回站点实例", () => {
    const [named, anonymous, answered] = workflowRunEventLines(
      [
        {
          sequence: 1,
          type: "escalation-raised",
          payload: {
            qid: "dwfq-dwfrun1-1",
            actor: { siteId: "actor#1", ordinal: 1 },
            actorName: "poet",
            question: "评分上限 95，门槛 96，这个门是不是坏了？",
          },
        },
        {
          sequence: 2,
          type: "escalation-raised",
          payload: {
            qid: "dwfq-dwfrun1-2",
            actor: { siteId: "actor#2", ordinal: 3 },
            question: "用哪版风格指南？",
          },
        },
        {
          sequence: 3,
          type: "escalation-resolved",
          payload: { qid: "dwfq-dwfrun1-1", answer: "门确实坏了，按 95 通过。" },
        },
      ],
      format,
    );

    expect(named!.label).toBe("chat.toolCall.workflow.run.event.escalationRaised");
    expect(named!.detail).toBe("dwfq-dwfrun1-1 · poet · 评分上限 95，门槛 96，这个门是不是坏了？");
    // Escalation is not failure: the actor did nothing wrong; it is waiting for an answer.
    expect(named!.tone).toBe("default");
    // An anonymous actor falls back to `site@ordinal` — this line would rather say actor#2@3 than not say who it is.
    expect(anonymous!.detail).toBe("dwfq-dwfrun1-2 · actor#2@3 · 用哪版风格指南？");

    expect(answered!.label).toBe("chat.toolCall.workflow.run.event.escalationResolved");
    // resolved carries only qid and the answer: it usually sits dozens of lines away from the question line; qid is the only thing that can link them.
    expect(answered!.detail).toBe("dwfq-dwfrun1-1 · 门确实坏了，按 95 通过。");
    expect(answered!.tone).toBe("default");
  });

  it("升级行的长正文按 detail 列的既有上限截断（完整正文归待答问题区）", () => {
    const long = "很长的问题".repeat(100);
    const [raised] = workflowRunEventLines(
      [
        {
          sequence: 1,
          type: "escalation-raised",
          payload: { qid: "dwfq-1", actor: { siteId: "a", ordinal: 1 }, question: long },
        },
      ],
      format,
    );
    expect(raised!.detail!.length).toBeLessThan(long.length);
    expect(raised!.detail!.endsWith("…")).toBe(true);
  });

  it("升级行的字段残缺时只丢那一截，不整行空白（有界化可能削掉深层字段）", () => {
    const [noActor, noAnswer] = workflowRunEventLines(
      [
        {
          sequence: 1,
          type: "escalation-raised",
          payload: { qid: "dwfq-1", question: "还在吗？" },
        },
        { sequence: 2, type: "escalation-resolved", payload: { qid: "dwfq-1" } },
      ],
      format,
    );
    expect(noActor!.detail).toBe("dwfq-1 · 还在吗？");
    expect(noAnswer!.detail).toBe("dwfq-1");
  });

  it("run-settled 的出错/停止同样标成失败色", () => {
    const [failed, cancelled] = workflowRunEventLines(
      [
        {
          sequence: 1,
          type: "run-settled",
          payload: { status: "errored", error: { message: "aborted by cap" } },
        },
        { sequence: 2, type: "run-settled", payload: { status: "stopped", stopReason: "user" } },
      ],
      format,
    );
    expect(failed!.tone).toBe("failed");
    expect(failed!.detail).toBe("aborted by cap");
    expect(cancelled!.tone).toBe("failed");
  });

  /**
   * report gets its own line and must not fall into the unknown fallback: the spec's Invariants state explicitly that
   * report goes both to the event log and to the Results pane (while `log` goes only to the event log); displaying it
   * as "unknown event report" would be self-contradictory.
   */
  it("report 自成一行：带实例，条目只给短摘要（完整预览归 Results 区）", () => {
    const [text, object, empty] = workflowRunEventLines(
      [
        {
          sequence: 1,
          type: "report",
          payload: { instance: { siteId: "report#1", ordinal: 1 }, item: "3 stale imports" },
        },
        {
          sequence: 2,
          type: "report",
          payload: { instance: { siteId: "report#2", ordinal: 4 }, item: { file: "a.ts" } },
        },
        { sequence: 3, type: "report", payload: { instance: { siteId: "report#3", ordinal: 1 } } },
      ],
      format,
    );

    expect(text!.label).toBe("chat.toolCall.workflow.run.event.report");
    expect(text!.detail).toBe("report#1@1 · 3 stale imports");
    expect(text!.tone).toBe("default");
    // Objects collapse to single-line JSON (one event per log line; multi-line JSON would stretch it into a second artifact view).
    expect(object!.detail).toBe('report#2@4 · {"file":"a.ts"}');
    // A missing item (trimmed by bounding / the script reported undefined) leaves only identity, never a blank.
    expect(empty!.detail).toBe("report#3@1");
  });

  it("phase-entered 自成一行：名字，第二次起带轮次", () => {
    const [first, second, bare] = workflowRunEventLines(
      [
        { sequence: 1, type: "phase-entered", payload: { name: "Verify", ordinal: 1 } },
        { sequence: 2, type: "phase-entered", payload: { name: "Verify", ordinal: 2 } },
        { sequence: 3, type: "phase-entered", payload: {} },
      ],
      format,
    );
    expect(first!.label).toBe("chat.toolCall.workflow.run.event.phaseEntered");
    expect(first!.detail).toBe("Verify");
    expect(second!.detail).toBe("Verify · 2");
    expect(bare!.detail).toBeUndefined();
    expect(bare!.tone).toBe("default");
  });

  it("未知种类退化成 type + 截断 JSON，既不崩也不假装认识它", () => {
    // compaction is the kind the engine reserved for long-context compression (v1 never emits it). Whenever it
    // appears in the future, the event log must still show an informative line, not a blank or an exception.
    const [line] = workflowRunEventLines(
      [{ sequence: 1, type: "compaction", payload: { actor: { siteId: "actor#1", ordinal: 1 } } }],
      format,
    );
    expect(line!.label).toBe("chat.toolCall.workflow.run.event.unknown:compaction");
    expect(line!.detail).toContain("actor#1");
  });

  it("超长未知载荷被截断，不把整条 journal 灌进 DOM", () => {
    const [line] = workflowRunEventLines(
      [{ sequence: 1, type: "mystery", payload: { blob: "x".repeat(5_000) } }],
      format,
    );
    expect(line!.detail!.length).toBeLessThanOrEqual(200);
    expect(line!.detail!.endsWith("…")).toBe(true);
  });

  it("载荷形状不符时不抛异常（有界化可能已经削掉字段）", () => {
    const lines = workflowRunEventLines(
      [
        { sequence: 1, type: "node-settled", payload: {} },
        { sequence: 2, type: "actor-created", payload: { actor: "not-a-ref" } },
        { sequence: 3, type: "log", payload: {} },
      ],
      format,
    );
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => typeof line.label === "string")).toBe(true);
  });

  it("truncated 事件原样透出标记，让读者知道原始事实要去 journal 取", () => {
    const [line] = workflowRunEventLines(
      [{ sequence: 9, type: "log", payload: { message: "partial" }, truncated: true }],
      format,
    );
    expect(line!.truncated).toBe(true);
    expect(line!.sequence).toBe(9);
  });
});

function actor(overrides: Partial<WorkflowRunActor> = {}): WorkflowRunActor {
  return {
    siteId: "actor#1",
    ordinal: 1,
    sessionId: "dwf-run1-actor_1@1",
    status: "waiting",
    ...overrides,
  };
}

describe("workflowActorStartState", () => {
  // The actor-not-started gate (docs/dynamic-workflow/presentation.md "Subagent transcripts", identity switched to
  // slots: docs/dynamic-workflow/presentation.md "The pill"). Of the three values, the most important is the boundary
  // between unknown and notStarted: blocking one bucket wrong locks away a still-readable transcript; missing one
  // bucket wrong returns to that dead error panel.
  const node = (overrides: Partial<WorkflowRunNode> = {}): WorkflowRunNode => ({
    siteId: "ask#1",
    ordinal: 1,
    phase: "queued",
    actorSiteId: "actor#1",
    actorOrdinal: 1,
    ...overrides,
  });
  const slot = (overrides: Partial<WorkflowActorSlotRef> = {}): WorkflowActorSlotRef => ({
    runId: "dwfrun-1",
    siteId: "actor#1",
    ordinal: 1,
    ...overrides,
  });

  it("actor 在投影里但一个节点都没有 → notStarted，会话 id 取投影", () => {
    const runs = [run({ actors: [actor({ sessionId: "s-a" })] })];
    expect(workflowActorStartState(runs, slot())).toEqual({
      state: "notStarted",
      sessionId: "s-a",
    });
  });

  it("只有 queued 节点 → notStarted：队列里的节点不构成会话已落库的证据", () => {
    // The persistence-order guarantee hangs on "before dispatch" (the workflow-driver awaits session persistence
    // before the first dispatch), so queued cannot open the gate — exactly the 5 seconds of clicking-too-early observed live.
    const runs = [
      run({ actors: [actor({ sessionId: "s-a" })], nodes: [node(), node({ ordinal: 2 })] }),
    ];
    expect(workflowActorStartState(runs, slot()).state).toBe("notStarted");
  });

  it("dispatched / repairing / nudged / settled（含 cached）都算 started，订阅投影里的会话", () => {
    for (const phase of ["dispatched", "repairing", "nudged", "settled"] as const) {
      const runs = [
        run({
          actors: [actor({ sessionId: "s-a" })],
          nodes: [node(), node({ ordinal: 2, phase })],
        }),
      ];
      expect(workflowActorStartState(runs, slot())).toEqual({ state: "started", sessionId: "s-a" });
    }
    // A cached hit sends node-settled directly (through neither queued nor ensureSession): the gate still opens and
    // subscribes to the actor's sessionId in the projection — the reducer points it at the session holding the
    // transcript (workflowCachedSettleAttribution.test.ts pins the revised-run kind against the real reducer).
    const cached = [
      run({
        actors: [actor({ sessionId: "s-a" })],
        nodes: [node({ phase: "settled", outcome: "ok", cached: true })],
      }),
    ];
    expect(workflowActorStartState(cached, slot()).state).toBe("started");
  });

  it("actor 不在投影里、tab 带会话 id → unknown：run 被淘汰、冷恢复、投影整体缺席", () => {
    // Tabs deliberately have no GC and outlive the 8-run eviction. This bucket must never be notStarted: that would
    // lock away a finished run's only persistent view, when subscribing directly could have read it. The subscription
    // target is exactly the id the tab carries.
    const expected = { state: "unknown", sessionId: "s-a" };
    const runs = [run({ actors: [actor({ ordinal: 2, sessionId: "s-other" })] })];
    expect(workflowActorStartState(runs, slot({ actorSessionId: "s-a" }))).toEqual(expected);
    expect(workflowActorStartState([], slot({ actorSessionId: "s-a" }))).toEqual(expected);
    expect(workflowActorStartState(undefined, slot({ actorSessionId: "s-a" }))).toEqual(expected);
    // The same name and ordinal in another run does not count as a hit: identity includes runId.
    const other = [
      run({
        runId: "dwfrun-2",
        actors: [actor({ sessionId: "s-a" })],
        nodes: [node({ phase: "dispatched" })],
      }),
    ];
    expect(workflowActorStartState(other, slot({ actorSessionId: "s-a" }))).toEqual(expected);
  });

  it("actor 不在投影里、tab 没有会话 id → notStarted：未启动药丸开的槽位，没有可订阅的东西", () => {
    expect(workflowActorStartState([run()], slot())).toEqual({ state: "notStarted" });
    expect(workflowActorStartState(undefined, slot())).toEqual({ state: "notStarted" });
  });

  it("投影里的会话 id 优先于 tab 带的；投影没有时才用 tab 的；两边都没有就只有处境", () => {
    const live = [
      run({ actors: [actor({ sessionId: "s-live" })], nodes: [node({ phase: "dispatched" })] }),
    ];
    expect(workflowActorStartState(live, slot({ actorSessionId: "s-stale" }))).toEqual({
      state: "started",
      sessionId: "s-live",
    });
    // An actor whose sessionId has not landed in the projection yet (schema-optional): the tab's id is the fallback.
    const bare = [
      run({ actors: [actor({ sessionId: undefined })], nodes: [node({ phase: "dispatched" })] }),
    ];
    expect(workflowActorStartState(bare, slot({ actorSessionId: "s-tab" }))).toEqual({
      state: "started",
      sessionId: "s-tab",
    });
    expect(workflowActorStartState(bare, slot())).toEqual({ state: "started" });
  });

  it("跨多 run 按 runId 命中正确的 actor，而不是同名同序号的邻居", () => {
    const runs = [
      run({
        runId: "dwfrun-1",
        actors: [actor({ sessionId: "s-a" })],
        nodes: [node({ phase: "dispatched" })],
      }),
      run({
        runId: "dwfrun-2",
        actors: [actor({ sessionId: "s-b" })],
        nodes: [node()],
      }),
    ];
    expect(workflowActorStartState(runs, slot({ runId: "dwfrun-1" }))).toEqual({
      state: "started",
      sessionId: "s-a",
    });
    // The same siteId@ordinal in the other run: the node was only ever dispatched in the first run.
    expect(workflowActorStartState(runs, slot({ runId: "dwfrun-2" }))).toEqual({
      state: "notStarted",
      sessionId: "s-b",
    });
  });

  it("别的 actor 的节点、以及无 actor 的 world-read 节点，都不算它启动了", () => {
    const runs = [
      run({
        actors: [actor({ sessionId: "s-a" }), actor({ ordinal: 2, sessionId: "s-b" })],
        nodes: [
          // Same site, different ordinal: the instance is part of identity; a wrong ordinal means a different actor.
          node({ phase: "dispatched", actorOrdinal: 2 }),
          // world-read has no actor attribution; it opens the gate for nobody.
          node({
            siteId: "world-read#1",
            phase: "settled",
            actorSiteId: undefined,
            actorOrdinal: undefined,
          }),
        ],
      }),
    ];
    expect(workflowActorStartState(runs, slot()).state).toBe("notStarted");
    expect(workflowActorStartState(runs, slot({ ordinal: 2 })).state).toBe("started");
  });
});

// Resume availability (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md; docs/dynamic-workflow/presentation.md
// 2026-09-09 "cold replay"): a single source of truth — the projection run's `resumable` status bit, computed by the
// CLI with the same predicate as the resume gate and landed into state via the run-settled payload; the UI never
// derives it itself from status + failureCode.
describe("isWorkflowRunResumable", () => {
  it("状态位在场 → 可恢复，无论 stopped 的原因是什么", () => {
    expect(isWorkflowRunResumable(run({ status: "stopped", resumable: true }))).toBe(true);
    expect(
      isWorkflowRunResumable(
        run({ status: "stopped", stopReason: "interrupted", resumable: true }),
      ),
    ).toBe(true);
  });

  it("状态位缺席 → 不可恢复，哪怕 status 是 stopped（旧 CLI 不发该位；宁可少一个按钮）", () => {
    for (const status of ["pending", "running", "completed", "errored", "stopped"] as const) {
      expect(isWorkflowRunResumable(run({ status }))).toBe(false);
    }
  });

  it("投影缺席（被淘汰）→ 不可恢复", () => {
    expect(isWorkflowRunResumable(undefined)).toBe(false);
  });
});

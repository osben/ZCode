// **Out-of-turn append** of dwf run progress: when run events arrive, the parent session may be
// running a turn or completely idle, and both cases must land. See
// docs/dynamic-workflow/presentation.md "The run state the pane draws".
//
// Why a public method on the runtime is needed: BackgroundTask* goes through core internals
// (the tool executor's deps.emitEvent -> runtime.appendEvent), while dwf's event source lives in
// bootstrap's run service, a layer with no access to AgentRuntimeInternal. The existing precedent
// of the same shape is recordTargetChanged (bootstrap's session-facade appends TargetChanged
// out-of-turn exactly that way).
import { describe, expect, it, vi } from "vitest";
import {
  SessionEventType,
  createSessionId,
  createToolCallId,
  type SessionEvent,
} from "@zcode/contracts";
import { AgentRuntime } from "../src/index.js";
import { createTestSessionEventStore } from "./test-event-store.js";

function makeRuntime(name: string): { runtime: AgentRuntime; events: SessionEvent[] } {
  const runtime = new AgentRuntime(
    createSessionId(name),
    { agentName: "dwf-progress-test", workingDirectory: "/tmp/zcode-dwf-progress" },
    { eventStore: createTestSessionEventStore(), modelAdapter: {} as never },
  );
  const events: SessionEvent[] = [];
  runtime.subscribeEvents({ onSessionEvent: (event) => events.push(event) });
  return { runtime, events };
}

const progress = {
  runId: "dwfrun-1",
  sequence: 3,
  eventType: "node-dispatched",
  payload: { instance: { siteId: "ask#1", ordinal: 1 } },
};

describe("recordDynamicWorkflowRunProgress", () => {
  it("会话空闲时也能追加（run 事件不等回合）", async () => {
    const { runtime, events } = makeRuntime("dwf-progress-idle");
    expect(runtime.getActiveTurnInfo()).toBeUndefined();

    await runtime.recordDynamicWorkflowRunProgress(progress);

    const appended = events.filter(
      (event) => event.type === SessionEventType.DynamicWorkflowRunProgress,
    );
    expect(appended).toHaveLength(1);
    expect(appended[0]?.payload).toEqual(progress);
    // Events appended while idle must not claim any turn: turnId must be empty, otherwise cold
    // recovery would stuff them into the previous turn's tail.
    expect(appended[0]?.turnId).toBeUndefined();
  });

  it("事件经 event store 补号后才发布（live 与 replay 共用同一套顺序事实）", async () => {
    const { runtime, events } = makeRuntime("dwf-progress-seq");
    await runtime.recordDynamicWorkflowRunProgress(progress);
    await runtime.recordDynamicWorkflowRunProgress({ ...progress, sequence: 4 });

    const appended = events.filter(
      (event) => event.type === SessionEventType.DynamicWorkflowRunProgress,
    );
    expect(appended.map((event) => event.sequenceNumber)).toEqual([1, 2]);
    // The sequence inside the payload is the **journal** sequence — a different ruler from the
    // session event's sequenceNumber.
    expect(appended.map((event) => (event.payload as typeof progress).sequence)).toEqual([3, 4]);
  });

  it("toolCallId 透传（工具卡 → 详情页的关联键）", async () => {
    const { runtime, events } = makeRuntime("dwf-progress-toolcall");
    const toolCallId = createToolCallId("create-workflow-call");
    await runtime.recordDynamicWorkflowRunProgress({ ...progress, toolCallId });

    const appended = events.find(
      (event) => event.type === SessionEventType.DynamicWorkflowRunProgress,
    );
    expect((appended?.payload as { toolCallId?: string }).toolCallId).toBe(toolCallId);
  });
});

// ————————————————————————————————————————————————
// In-run escalation notifications (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md "How progress and completion reach the app and the main agent").
//
// This is the **only** "someone is waiting for you" signal the main agent proactively receives:
// the actor is parked inside its own escalate call, and no timeout backstops it. Three things are
// therefore pinned: exactly one notification, carrying the qid and the verbatim next step, and
// escalation-resolved sends no second one (the responder is the main agent itself; the receipt is
// already that tool call's result).
// ————————————————————————————————————————————————

interface CapturedEscalationMeta {
  kind: "escalation";
  qid: string;
  actor: string;
  question: string;
  context?: string;
  askedAt?: number;
}

interface CapturedNotification {
  text: string;
  taskId?: string;
  originMeta?: {
    backgroundSource?: string;
    title?: string;
    workId?: string;
    workflowNotification?: CapturedEscalationMeta;
  };
}

/** Notifications are produced on the runtime (enqueueBackgroundTaskNotification is a prototype method), so an instance stub can intercept them. */
function captureNotifications(runtime: AgentRuntime): CapturedNotification[] {
  const captured: CapturedNotification[] = [];
  (runtime as unknown as { enqueueBackgroundTaskNotification: (n: CapturedNotification) => void })
    .enqueueBackgroundTaskNotification = (notification) => {
    captured.push(notification);
  };
  return captured;
}

const raised = {
  runId: "dwfrun-esc",
  sequence: 7,
  eventType: "escalation-raised",
  payload: {
    qid: "dwfq-esc12345-1",
    actor: { siteId: "actor#1", ordinal: 2 },
    actorName: "implementer",
    question: "评分上限是 95，通过线是 96，这个门不可能过。",
    context: "已经试了 6 轮，最高 95。",
  },
};

describe("escalation-raised → run 中通知", () => {
  it("恰好一条通知，载 qid、问题、上下文与逐字的下一步", async () => {
    const { runtime } = makeRuntime("dwf-progress-escalation");
    const captured = captureNotifications(runtime);

    await runtime.recordDynamicWorkflowRunProgress(raised);

    expect(captured).toHaveLength(1);
    const text = captured[0]?.text ?? "";
    expect(text).toContain("dwfq-esc12345-1");
    expect(text).toContain("评分上限是 95，通过线是 96，这个门不可能过。");
    expect(text).toContain("已经试了 6 轮，最高 95。");
    // Verbatim next step: after reading this notification the model must know which tool to call and with what.
    expect(text).toContain('ResolveWorkflowQuestion with question_id="dwfq-esc12345-1"');
    // The run has not stopped: without this sentence the model would think the whole workflow is
    // waiting on it and drop everything else it is doing.
    expect(text).toContain("The run is still running");
    // Query fallback after a dropped notification (GetWorkflowRun's pendingQuestions).
    expect(text).toContain("GetWorkflowRun");
    // The synthetic user message must not be misread as user speech.
    expect(text).toContain("[SYSTEM NOTIFICATION - NOT USER INPUT]");
  });

  it("actorName 在场时用人名；匿名 actor 落到结构化 ref site@ordinal", async () => {
    const { runtime } = makeRuntime("dwf-progress-escalation-actor");
    const captured = captureNotifications(runtime);

    await runtime.recordDynamicWorkflowRunProgress(raised);
    await runtime.recordDynamicWorkflowRunProgress({
      ...raised,
      sequence: 8,
      payload: { ...raised.payload, actorName: undefined, qid: "dwfq-esc12345-2" },
    });

    expect(captured[0]?.text).toContain("implementer");
    // The engine deliberately does not synthesize a fallback label for anonymous actors (actorName
    // absent); the rendering fallback lives on the read side.
    expect(captured[1]?.text).toContain("actor#1@2");
  });

  it("展示名走 registry 的 description，缺席时回落到 runId", async () => {
    const { runtime } = makeRuntime("dwf-progress-escalation-label");
    const captured = captureNotifications(runtime);

    // The registry has no such run (not yet registered / already exited) -> the display name falls
    // back to the runId, never left empty.
    await runtime.recordDynamicWorkflowRunProgress(raised);
    expect(captured[0]?.text).toContain("dwfrun-esc");
    expect(captured[0]?.originMeta).toEqual({
      backgroundSource: "workflow",
      title: "dwfrun-esc",
      // workId ≡ runId: the same display anchor as the run's terminal notification.
      workId: "dwfrun-esc",
      // The manifest payload (escalation discriminated branch) travels the whole pipeline inside originMeta.
      workflowNotification: {
        kind: "escalation",
        qid: "dwfq-esc12345-1",
        actor: "implementer",
        question: "评分上限是 95，通过线是 96，这个门不可能过。",
        context: "已经试了 6 轮，最高 95。",
      },
    });
    expect(captured[0]?.taskId).toBe("dwfrun-esc");
  });

  it("manifest 载荷：qid/actor/question/context/askedAt 同源，缺 askedAt 即字段缺席", async () => {
    const { runtime } = makeRuntime("dwf-progress-escalation-manifest");
    const captured = captureNotifications(runtime);

    // askedAt present: read into the payload directly as a number (stringField cannot read a number).
    await runtime.recordDynamicWorkflowRunProgress({
      ...raised,
      payload: { ...raised.payload, askedAt: 1_725_000_000_000 },
    });
    // askedAt absent: the whole field is absent, not set to 0.
    await runtime.recordDynamicWorkflowRunProgress({
      ...raised,
      sequence: 8,
      payload: { ...raised.payload, qid: "dwfq-esc12345-9" },
    });

    expect(captured[0]?.originMeta?.workflowNotification).toEqual({
      kind: "escalation",
      qid: "dwfq-esc12345-1",
      actor: "implementer",
      question: "评分上限是 95，通过线是 96，这个门不可能过。",
      context: "已经试了 6 轮，最高 95。",
      askedAt: 1_725_000_000_000,
    });
    expect(captured[1]?.originMeta?.workflowNotification?.askedAt).toBeUndefined();
    expect(captured[1]?.originMeta?.workflowNotification?.qid).toBe("dwfq-esc12345-9");
  });

  it("匿名 actor 的载荷 actor 落到结构化 ref site@ordinal（与通知文本同一条兜底链）", async () => {
    const { runtime } = makeRuntime("dwf-progress-escalation-manifest-anon");
    const captured = captureNotifications(runtime);

    await runtime.recordDynamicWorkflowRunProgress({
      ...raised,
      payload: { ...raised.payload, actorName: undefined },
    });
    expect(captured[0]?.originMeta?.workflowNotification?.actor).toBe("actor#1@2");
  });

  it("超界 question/context 在发射侧就地截断到 ≤4000（shared schema 同界）", async () => {
    const { runtime } = makeRuntime("dwf-progress-escalation-manifest-cap");
    const captured = captureNotifications(runtime);

    const longQuestion = "问".repeat(5_000);
    const longContext = "境".repeat(5_000);
    await runtime.recordDynamicWorkflowRunProgress({
      ...raised,
      payload: { ...raised.payload, question: longQuestion, context: longContext },
    });
    const meta = captured[0]?.originMeta?.workflowNotification;
    expect(meta?.question.length).toBe(4_000);
    expect(meta?.context?.length).toBe(4_000);
  });

  it("escalation-resolved 不产生通知（主代理就是作答方，回执已在工具结果里）", async () => {
    const { runtime, events } = makeRuntime("dwf-progress-escalation-resolved");
    const captured = captureNotifications(runtime);

    await runtime.recordDynamicWorkflowRunProgress({
      runId: "dwfrun-esc",
      sequence: 9,
      eventType: "escalation-resolved",
      payload: { qid: "dwfq-esc12345-1", answer: "按 95 通过。" },
    });

    expect(captured).toHaveLength(0);
    // The event itself still lands in the store as usual (the GUI's event log must render it) —
    // not sending a notification and not recording the event are two different things.
    expect(
      events.filter((event) => event.type === SessionEventType.DynamicWorkflowRunProgress),
    ).toHaveLength(1);
  });

  it("其他 run 事件不产生通知", async () => {
    const { runtime } = makeRuntime("dwf-progress-escalation-other");
    const captured = captureNotifications(runtime);
    await runtime.recordDynamicWorkflowRunProgress(progress);
    expect(captured).toHaveLength(0);
  });

  it("载荷缺 qid 或 question 时跳过通知，但事件照常落库", async () => {
    const { runtime, events } = makeRuntime("dwf-progress-escalation-malformed");
    const captured = captureNotifications(runtime);
    const logged = vi.fn();
    (runtime as unknown as { logger?: unknown }).logger = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      warn: logged,
    };

    await runtime.recordDynamicWorkflowRunProgress({
      ...raised,
      payload: { actor: { siteId: "actor#1", ordinal: 1 } },
    });

    // The progress surface is an observation surface: a malformed payload only skips the
    // notification and leaves a trace; it must never take down a running run.
    expect(captured).toHaveLength(0);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(
      events.filter((event) => event.type === SessionEventType.DynamicWorkflowRunProgress),
    ).toHaveLength(1);
  });
});

// ————————————————————————————————————————————————
// Run-level stall (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md "Terminal states"): `run-stalled` -> one in-run notification.
// ————————————————————————————————————————————————

const stalled = {
  runId: "dwfrun-stall",
  sequence: 11,
  eventType: "run-stalled",
  payload: { sinceMs: 1_200_000, reason: "rate_limited", cap: 2 },
};

describe("run-stalled → run 中通知", () => {
  it("恰好一条通知：run 仍在跑、不需要模型做什么、不要取消或重建", async () => {
    const { runtime } = makeRuntime("dwf-progress-stall");
    const captured = captureNotifications(runtime);

    await runtime.recordDynamicWorkflowRunProgress(stalled);

    expect(captured).toHaveLength(1);
    const text = captured[0]?.text ?? "";
    expect(text).toContain("[SYSTEM NOTIFICATION - NOT USER INPUT]");
    expect(text).toContain("<workflow-stall>");
    expect(text).toContain("<since-ms>1200000</since-ms>");
    expect(text).toContain("<dominant-reason>rate_limited</dominant-reason>");
    expect(text).toContain("<cap>2</cap>");
    expect(text).toContain("has not completed a model request in 20 minutes");
    expect(text).toContain("rate_limited");
    expect(text).toContain("It is still running and needs nothing from you.");
    expect(text).toContain("Do not cancel or rebuild it on your own.");
    expect(captured[0]?.taskId).toBe("dwfrun-stall");
    expect(captured[0]?.originMeta).toEqual({
      backgroundSource: "workflow",
      title: "dwfrun-stall",
      workId: "dwfrun-stall",
      workflowNotification: { kind: "stall", sinceMs: 1_200_000, reason: "rate_limited", cap: 2 },
    });
  });

  it("reason / cap 缺席即字段缺席；sinceMs 形状不对则整条跳过", async () => {
    const { runtime } = makeRuntime("dwf-progress-stall-shape");
    const captured = captureNotifications(runtime);

    await runtime.recordDynamicWorkflowRunProgress({
      ...stalled,
      payload: { sinceMs: 1_500_000 },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.originMeta?.workflowNotification).toEqual({
      kind: "stall",
      sinceMs: 1_500_000,
    });
    expect(captured[0]?.text).toContain("the provider keeps failing requests");
    expect(captured[0]?.text).not.toContain("<cap>");

    await runtime.recordDynamicWorkflowRunProgress({
      ...stalled,
      sequence: 12,
      payload: { sinceMs: "soon" },
    });
    expect(captured).toHaveLength(1);
  });
});

// ————————————————————————————————————————————————
// Holes (the `hole` payload in docs/dynamic-workflow/transcript-and-notifications.md and "What the
// model reads"): `hole-reached` -> exactly one in-run notification, with the payload filled in from
// the snapshot's `holes[]` for type / line / surrounding phases, and the draft path from the
// snapshot's `scriptPath`; `hole-filled` sends no notification (the filler is the main agent
// itself; the receipt is already in the tool result).
// ————————————————————————————————————————————————

interface CapturedHoleMeta {
  kind: "hole";
  siteId: string;
  ordinal: number;
  name: string;
  type: string;
  prompt?: string;
  draftPath?: string;
  line?: number;
  before?: string;
  after?: string;
  reachedAt?: number;
}

const reached = {
  runId: "dwfrun-hole",
  sequence: 21,
  eventType: "hole-reached",
  payload: {
    instance: { siteId: "hole#1", ordinal: 1 },
    name: "决定分组",
    prompt: "把 7 个候选按风险分成两组。",
    phaseName: "收集",
  },
};

function attachHoleSnapshot(
  runtime: AgentRuntime,
  holes: unknown[] | undefined,
  scriptPath?: string,
): string[] {
  const calls: string[] = [];
  (runtime as unknown as { dynamicWorkflowRunPort: unknown }).dynamicWorkflowRunPort = {
    async getTask(runId: string) {
      calls.push(runId);
      return {
        runId,
        taskId: runId,
        status: "running",
        startedAt: new Date(0),
        ...(scriptPath === undefined ? {} : { scriptPath }),
        ...(holes === undefined ? {} : { holes }),
      };
    },
  };
  return calls;
}

describe("hole-reached → run 中通知", () => {
  const waiting = {
    siteId: "hole#1",
    ordinal: 1,
    name: "决定分组",
    type: "Verdict",
    state: "waiting",
    since: 1_725_000_000_000,
    line: 12,
    before: "收集",
    after: "汇总",
  };

  it("恰好一条通知，载荷从快照补齐，文本带逐字的下一步", async () => {
    const { runtime } = makeRuntime("dwf-progress-hole");
    const captured = captureNotifications(runtime);
    const calls = attachHoleSnapshot(
      runtime,
      [waiting],
      "/repo/.zcode/workflow-drafts/triage.dwf.ts",
    );

    await runtime.recordDynamicWorkflowRunProgress(reached);

    expect(calls).toEqual(["dwfrun-hole"]);
    expect(captured).toHaveLength(1);
    const meta = captured[0]?.originMeta?.workflowNotification as unknown as CapturedHoleMeta;
    expect(meta).toEqual({
      kind: "hole",
      siteId: "hole#1",
      ordinal: 1,
      name: "决定分组",
      type: "Verdict",
      prompt: "把 7 个候选按风险分成两组。",
      draftPath: "/repo/.zcode/workflow-drafts/triage.dwf.ts",
      line: 12,
      before: "收集",
      after: "汇总",
      reachedAt: 1_725_000_000_000,
    });
    expect(captured[0]?.taskId).toBe("dwfrun-hole");
    expect(captured[0]?.originMeta?.workId).toBe("dwfrun-hole");
    const text = captured[0]?.text ?? "";
    expect(text).toContain("[SYSTEM NOTIFICATION - NOT USER INPUT]");
    expect(text).toContain("<workflow-hole>");
    expect(text).toContain("<run-id>dwfrun-hole</run-id>");
    expect(text).toContain("<hole-id>hole#1</hole-id>");
    expect(text).toContain("<name>决定分组</name>");
    expect(text).toContain("<type>Verdict</type>");
    expect(text).toContain("<prompt>把 7 个候选按风险分成两组。</prompt>");
    expect(text).toContain("<draft>/repo/.zcode/workflow-drafts/triage.dwf.ts</draft>");
    expect(text).toContain("<line>12</line>");
    expect(text).toContain("<before>收集</before>");
    expect(text).toContain("<after>汇总</after>");
    // Verbatim next step: read the draft, write the function body, call FillWorkflowHole with hole_id.
    expect(text).toContain('FillWorkflowHole with run_id="dwfrun-hole" and hole_id="hole#1"');
    expect(text).toContain("Only this branch of the script is parked");
    expect(text).toContain("nothing times out");
    expect(text).toContain("compiled where the hole stands");
    expect(text).toContain("must return a value of type `Verdict`");
    expect(text).toContain("GetWorkflowRun");
  });

  it("快照缺席时仍发通知，只带载荷自己说得出的字段；prompt 超界截到 4000 并以 … 收尾", async () => {
    const { runtime } = makeRuntime("dwf-progress-hole-noport");
    const captured = captureNotifications(runtime);

    await runtime.recordDynamicWorkflowRunProgress({
      ...reached,
      payload: { ...reached.payload, prompt: "问".repeat(5_000) },
    });

    expect(captured).toHaveLength(1);
    const meta = captured[0]?.originMeta?.workflowNotification as unknown as CapturedHoleMeta;
    expect(meta.type).toBe("unknown");
    expect("draftPath" in meta).toBe(false);
    expect("line" in meta).toBe(false);
    expect(meta.prompt?.length).toBe(4_000);
    expect(meta.prompt?.endsWith("…")).toBe(true);
    expect(captured[0]?.text).not.toContain("<draft>");
  });

  it("hole-filled 不产生通知；载荷缺 name 时跳过并留痕，事件照常落库", async () => {
    const { runtime, events } = makeRuntime("dwf-progress-hole-filled");
    const captured = captureNotifications(runtime);
    const logged = vi.fn();
    (runtime as unknown as { logger?: unknown }).logger = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      warn: logged,
    };

    await runtime.recordDynamicWorkflowRunProgress({
      runId: "dwfrun-hole",
      sequence: 22,
      eventType: "hole-filled",
      payload: { siteId: "hole#1", filledAt: 5, phaseNames: ["收集", "决定分组", "汇总"] },
    });
    await runtime.recordDynamicWorkflowRunProgress({
      ...reached,
      sequence: 23,
      payload: { instance: { siteId: "hole#1", ordinal: 2 } },
    });

    expect(captured).toHaveLength(0);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(
      events.filter((event) => event.type === SessionEventType.DynamicWorkflowRunProgress),
    ).toHaveLength(2);
  });
});

// Recursive holes: nested site ids (`hole#1/hole#1`) appear verbatim in the payload and the text so
// the model can copy them back into FillWorkflowHole exactly.
describe("hole-reached -> nested ids pass through verbatim", () => {
  it("载荷 siteId 与 <hole-id> / hole_id 都是嵌套 id 原文", async () => {
    const { runtime } = makeRuntime("dwf-progress-hole-nested");
    const captured = captureNotifications(runtime);
    attachHoleSnapshot(runtime, [
      {
        siteId: "hole#1/hole#1",
        ordinal: 1,
        name: "内层裁决",
        type: "Inner",
        state: "waiting",
        since: 7,
      },
    ]);
    await runtime.recordDynamicWorkflowRunProgress({
      ...reached,
      payload: { instance: { siteId: "hole#1/hole#1", ordinal: 1 }, name: "内层裁决" },
    });
    expect(captured).toHaveLength(1);
    const meta = captured[0]?.originMeta?.workflowNotification as unknown as CapturedHoleMeta;
    expect(meta).toMatchObject({
      kind: "hole",
      siteId: "hole#1/hole#1",
      type: "Inner",
      reachedAt: 7,
    });
    const text = captured[0]?.text ?? "";
    expect(text).toContain("<hole-id>hole#1/hole#1</hole-id>");
    expect(text).toContain('hole_id="hole#1/hole#1"');
  });
});

// @vitest-environment jsdom

// Tail-of-turn digest (docs/dynamic-workflow/presentation.md "The run card"): two states,
// collapsed by default — collapsed is the header + phase line, expanded drops pills under their
// stations; cold state is a single line. Interactions (chevron, ⤢, Resume, chips, pills) go
// through the real DOM.
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement, Profiler, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";
import type { TimelinePill } from "@/components/workflow-timeline/timeline-model.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

// The tooltip only renders children (no DOM shape change) but records title / description: the
// Stop button's second line "You can resume later" lives only in the tooltip — that is the half of
// the sentence this rename pins down.
const tooltips = vi.hoisted(() => ({
  calls: [] as Array<{ title: unknown; description?: string }>,
}));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({
    children,
    title,
    description,
  }: {
    children?: ReactNode;
    title?: unknown;
    description?: string;
  }) => {
    tooltips.calls.push({ title, ...(description === undefined ? {} : { description }) });
    return children;
  },
}));

// The wiring layer's card only reads the provider name of the workspace-scoped operator proxy
// model; this does not verify that line, so an empty implementation saves building a whole session
// store for it.
vi.mock("@/hooks/useWorkflowSubagentModelProviderName.js", () => ({
  useWorkflowSubagentModelProviderName: () => undefined,
}));

// eslint-disable-next-line import/first -- the component under test must be imported after the tooltip mock.
import {
  WorkflowRunDigest,
  type WorkflowRunDigestProps,
} from "@/components/workflow-timeline/WorkflowRunDigest.js";
// eslint-disable-next-line import/first -- same as above.
import { ConversationWorkflowDigests } from "@/v4/ConversationWorkflowDigests.js";
// eslint-disable-next-line import/first -- same as above.
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
// eslint-disable-next-line import/first -- same as above; the entries are used only for bilingual existence assertions.
import enUS from "../src/i18n/locales/en-US.js";
// eslint-disable-next-line import/first -- same as above.
import zhCN from "../src/i18n/locales/zh-CN.js";

afterEach(() => {
  cleanup();
  tooltips.calls.length = 0;
});

// plan → verify, verify back to plan (same fixture as the tool-card tests).
const LOOP_GRAPH = {
  steps: [
    {
      id: "ask#1",
      kind: "ask",
      label: "plan",
      line: 2,
      column: 21,
      lane: "actor#1",
      phase: "phase#a",
    },
    {
      id: "ask#2",
      kind: "ask",
      label: "verify",
      line: 5,
      column: 21,
      lane: "actor#2",
      phase: "phase#b",
    },
  ],
  lanes: [
    { id: "actor#1", name: "planner", line: 1, column: 11 },
    { id: "actor#2", name: "checker", line: 4, column: 11 },
  ],
  participants: [
    { id: "phase#a:actor#1", phase: "phase#a", lane: "actor#1", steps: ["ask#1"] },
    { id: "phase#b:actor#2", phase: "phase#b", lane: "actor#2", steps: ["ask#2"] },
  ],
  handoffs: [],
  phases: [
    { id: "phase#a", name: "plan", line: 1 },
    { id: "phase#b", name: "verify", line: 4 },
  ],
  phaseEdges: [
    { from: "phase#a", to: "phase#b" },
    { from: "phase#b", to: "phase#a", back: true },
  ],
  exits: ["phase#b"],
} as const;

function runState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    runId: "dwfrun-42",
    toolCallId: "tool-create-workflow",
    status: "running",
    usage: { spentTokens: 1_234, nodesUsed: 2 },
    actors: [
      { siteId: "actor#1", ordinal: 1, name: "Ada", sessionId: "s-1", status: "completed" },
      { siteId: "actor#2", ordinal: 1, name: "Bob", sessionId: "s-2", status: "running" },
    ],
    nodes: [
      {
        siteId: "ask#1",
        ordinal: 1,
        phase: "settled",
        outcome: "ok",
        actorSiteId: "actor#1",
        actorOrdinal: 1,
      },
      { siteId: "ask#2", ordinal: 1, phase: "executing", actorSiteId: "actor#2", actorOrdinal: 1 },
    ] as WorkflowRunState["nodes"],
    lastEventSequence: 7,
    ...overrides,
  };
}

function joined(
  overrides: Partial<WorkflowRunState> = {},
  extra: Partial<WorkflowRunCardSummary> = {},
): WorkflowRunCardSummary {
  const run = runState(overrides);
  return {
    runId: run.runId,
    toolCallId: run.toolCallId,
    status: run.status,
    nodesSettled: run.nodes.filter((node) => node.phase === "settled").length,
    nodesTotal: run.nodes.length,
    run,
    ...extra,
  };
}

function renderDigest(
  props: Partial<WorkflowRunDigestProps> & { summary: WorkflowRunCardSummary | undefined },
  locale: "en-US" | "zh-CN" = "en-US",
) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(WorkflowRunDigest, {
        graph: LOOP_GRAPH as unknown as WorkflowRunDigestProps["graph"],
        name: "implement-verify",
        runId: props.summary?.runId ?? "dwfrun-42",
        testIdKey: "t",
        ...props,
      }),
    ),
  );
}

// The neutral card for a run not in the live projection (evicted by the eight-entry cap / cold
// recovery with no journal hit) (docs/dynamic-workflow/presentation.md "The run card"): any source
// that names a runId produces a card, and if the join fails it degrades to a single line — the
// kind word says "ended" without impersonating a terminal state.
describe("WorkflowRunDigest 中性卡（summary 缺席）", () => {
  it("单行：种类词「Workflow ended」，无灯无轨道无 Cancel / Resume，⤢ 仍在；status 属性为 absent", () => {
    const onOpenRun = vi.fn();
    const view = renderDigest({
      summary: undefined,
      onOpenRun,
      onResume: vi.fn(),
      onCancel: vi.fn(),
    });
    const root = view.container.querySelector("[data-workflow-run-digest]")!;
    expect(root.getAttribute("data-workflow-run-id")).toBe("dwfrun-42");
    expect(root.getAttribute("data-workflow-run-status")).toBe("absent");
    expect(root.getAttribute("role")).toBeNull();
    expect(view.getByTestId("workflow-card-kind").textContent).toBe("Workflow ended");
    expect(view.getByTestId("workflow-card-name").textContent).toBe("implement-verify");
    expect(view.queryByTestId("workflow-digest-plot")).toBeNull();
    expect(view.queryByTestId("workflow-card-detail")).toBeNull();
    expect(view.queryByTestId("workflow-digest-cancel")).toBeNull();
    expect(view.queryByTestId("workflow-digest-resume")).toBeNull();
    fireEvent.click(view.getByTestId("workflow-card-open-details"));
    expect(onOpenRun).toHaveBeenCalledTimes(1);
  });

  it("双语言词条在场", () => {
    expect(enUS["chat.toolCall.workflow.card.ended"]).toBe("Workflow ended");
    expect(zhCN["chat.toolCall.workflow.card.ended"]).toBeTruthy();
    const view = renderDigest({ summary: undefined }, "zh-CN");
    expect(view.getByTestId("workflow-card-kind").textContent).toBe(
      zhCN["chat.toolCall.workflow.card.ended"],
    );
  });
});

// ── The "n more" row on a roster station (docs/dynamic-workflow/presentation.md "Past six participants") ──
// Desktop-observed: that row in the tail digest used to be a static span, and clicking it bubbled
// up to the whole-block toggle and folded the card. It is a door: open the run details, landing on
// that station; the station head stays part of the toggle.
describe("WorkflowRunDigest 「还有 n 个」", () => {
  const FANOUT_GRAPH = {
    steps: [
      {
        id: "ask#1",
        kind: "ask",
        label: "review",
        line: 3,
        column: 21,
        lane: "actor#1",
        phase: "phase#a",
      },
    ],
    lanes: [{ id: "actor#1", namePattern: { head: "reviewer-" }, line: 2, column: 11 }],
    participants: [
      { id: "phase#a:actor#1", phase: "phase#a", lane: "actor#1", steps: ["ask#1"], many: true },
    ],
    handoffs: [],
    phases: [{ id: "phase#a", name: "review", line: 1 }],
    phaseEdges: [],
    exits: ["phase#a"],
  } as const;
  function fanout(n: number): WorkflowRunCardSummary {
    const actors: WorkflowRunState["actors"] = [];
    const nodes: WorkflowRunState["nodes"] = [];
    for (let i = 1; i <= n; i += 1) {
      actors.push({
        siteId: "actor#1",
        ordinal: i,
        name: `reviewer-${i}`,
        sessionId: `s-${i}`,
        status: "running",
      });
      nodes.push({
        siteId: "ask#1",
        ordinal: i,
        phase: "executing",
        actorSiteId: "actor#1",
        actorOrdinal: i,
      } as WorkflowRunState["nodes"][number]);
    }
    return joined({ actors, nodes, usage: { spentTokens: 10, nodesUsed: n } });
  }
  const renderFanout = (props: Partial<WorkflowRunDigestProps>) =>
    renderDigest({
      graph: FANOUT_GRAPH as unknown as WorkflowRunDigestProps["graph"],
      summary: fanout(9),
      ...props,
    });

  it("有 onOpenRun 时那一行是按钮：点它开 run 详情、带站 id，不切换折叠；站头仍是开关的一部分", () => {
    const onOpenRun = vi.fn();
    const view = renderFanout({ onOpenRun });
    const root = view.container.querySelector("[data-workflow-run-digest]")!;
    expect(root.getAttribute("data-expanded")).toBe("true");
    const row = view.getByTestId("workflow-roster-more-row");
    expect(row.tagName).toBe("BUTTON");
    fireEvent.click(row);
    expect(onOpenRun).toHaveBeenCalledWith({ phaseId: "phase#a" });
    expect(root.getAttribute("data-expanded")).toBe("true");
    // The station head has no callback: a span, clicking it toggles the collapse (follow-up
    // "click grammar revision").
    const head = view.getByTestId("workflow-timeline-station-head");
    expect(head.tagName).toBe("SPAN");
    fireEvent.click(head);
    expect(root.getAttribute("data-expanded")).toBe("false");
    expect(onOpenRun).toHaveBeenCalledTimes(1);
    // ⤢ opens the whole run, with no landing point.
    fireEvent.click(view.getByTestId("workflow-card-open-details"));
    expect(onOpenRun).toHaveBeenLastCalledWith();
  });

  it("没有 onOpenRun 时那一行是静态的 span，点它与点空白一样切换折叠", () => {
    const view = renderFanout({});
    const root = view.container.querySelector("[data-workflow-run-digest]")!;
    const row = view.getByTestId("workflow-roster-more-row");
    expect(row.tagName).toBe("SPAN");
    fireEvent.click(row);
    expect(root.getAttribute("data-expanded")).toBe("false");
  });
});

// ── Subagent model (docs/dynamic-workflow/presentation.md "The run card") ──
// The detail string already says "how many subagents"; the model name follows it as the last
// segment, in the same muted text — no chip, no prefix. Strength and the spec string live in the
// tooltip. A run that never specified a model has no such segment.
describe("WorkflowRunDigest 子代理模型", () => {
  // The team plan's provider id is a hex string — exactly what this change guards against.
  const TEAM_PLAN_MODEL = "4fc7f541-2382-4c32-be11-f021b8d7ed1d/GLM-5.3-Flash$high";

  it("模型名是细节串的最后一段；provider id 不上屏，规范串与强度进 tooltip", () => {
    const view = renderDigest({ summary: joined({ subagentModel: TEAM_PLAN_MODEL }) });

    const detail = view.getByTestId("workflow-card-detail");
    expect(detail.textContent).toBe("2 phases · 1 agent working · GLM-5.3-Flash");
    expect(document.body.textContent).not.toContain("4fc7f541");
    expect(detail.getAttribute("title")).toContain(TEAM_PLAN_MODEL);
    expect(detail.getAttribute("title")).toContain("thinking High");
  });

  it("宿主给得出 provider 名时才拼「名字/模型」", () => {
    const view = renderDigest({
      subagentModelProviderName: (providerId) => (providerId === "myproxy" ? "MyProxy" : undefined),
      summary: joined({ subagentModel: "myproxy/glm-4.7$medium" }),
    });

    expect(view.getByTestId("workflow-card-detail").textContent).toBe(
      "2 phases · 1 agent working · MyProxy/glm-4.7",
    );
  });

  it("没指定过模型的 run：细节串一个字不变，也没有 tooltip", () => {
    const view = renderDigest({ summary: joined() });

    const detail = view.getByTestId("workflow-card-detail");
    expect(detail.textContent).toBe("2 phases · 1 agent working");
    expect(detail.getAttribute("title")).toBeNull();
  });
});

// ── When the header runs out of room (docs/dynamic-workflow/presentation.md "When the header runs out of room") ──
// The detail string used to be the only text in the header that refused to yield: once it grew
// (a subagent model name can push it well past "2 phases · 1 agent working"), Configure and Stop
// were squeezed outside the card's right border. jsdom does no layout, so this pins the class
// contract that produces that layout — the detail string can shrink, the controls cannot, and the
// right cluster carries min-w-0 (without it the whole cluster refuses to shrink by a single pixel;
// see the third case below).
describe("WorkflowRunDigest 表头溢出", () => {
  const LONG_MODEL = "4fc7f541-2382-4c32-be11-f021b8d7ed1d/GLM-5.3-Flash$high";

  function runningCard() {
    return renderDigest({
      onCancel: vi.fn(),
      onOpenRun: vi.fn(),
      settingsHost: { workspacePath: "/w", apply: vi.fn() },
      summary: joined({ subagentModel: LONG_MODEL }),
    });
  }

  it("让位的是细节串：min-w-0 + truncate，一行截断", () => {
    const detail = runningCard().getByTestId("workflow-card-detail");

    expect(detail.className).toContain("min-w-0");
    expect(detail.className).toContain("truncate");
  });

  it("控件不缩：Configure、Stop、⤢ 都带 shrink-0", () => {
    const view = runningCard();

    for (const id of [
      "workflow-digest-configure",
      "workflow-digest-cancel",
      "workflow-card-open-details",
    ]) {
      expect(view.getByTestId(id).className).toContain("shrink-0");
    }
  });

  it("右簇可压缩：不带 shrink-0，且必须带 min-w-0（否则地板是整串细节，一个像素都不缩）", () => {
    const view = runningCard();
    const cluster = view.getByTestId("workflow-card-detail").parentElement!;

    // shrink-0 would fix the whole cluster at its content width — exactly the old shape where the
    // buttons got pushed out of the card.
    expect(cluster.className).not.toContain("shrink-0");
    // The cluster's min-w-0 is the load-bearing part of this fix: a flex item's automatic minimum
    // size is min-content, and truncate's nowrap makes the detail string's min-content equal the
    // full text width (neither overflow:hidden nor the detail string's own min-w-0 computes it
    // smaller). Without it, the cluster's floor is "the whole detail string + buttons".
    expect(cluster.className).toContain("min-w-0");
    // The three controls share the cluster with the detail string: negative space can only land on
    // the detail string.
    for (const id of [
      "workflow-digest-configure",
      "workflow-digest-cancel",
      "workflow-card-open-details",
    ]) {
      expect(cluster.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
  });
});

describe("WorkflowRunDigest 收起态（默认）", () => {
  it("表头 + 阶段线：种类词、名字、灯 + 状态词、不含 tokens 的摘要；站与弧在场，药丸不在", () => {
    const view = renderDigest({ summary: joined() });
    const root = view.getByTestId("workflow-run-digest-t");
    expect(root.getAttribute("data-expanded")).toBe("true");
    expect(root.getAttribute("data-workflow-run-status")).toBe("running");
    expect(view.getByTestId("workflow-card-kind").textContent).toBe("Workflow running");
    expect(view.getByTestId("workflow-card-name").textContent).toBe("implement-verify");
    expect(view.queryByTestId("workflow-digest-status")).toBeNull();
    const detail = view.getByTestId("workflow-card-detail").textContent!;
    expect(detail).toBe("2 phases · 1 agent working");
    expect(view.getByTestId("workflow-card-detail").className).toContain("text-ui-base");
    expect(view.getByTestId("workflow-card-detail").className).not.toContain("font-mono");
    expect(detail).not.toContain("tokens");
    // The running kind word's shimmer: wf-swap wraps outside the gradient (the lesson of round 7).
    expect(root.querySelector(".wf-swap .animated-gradient-text")).toBeTruthy();

    expect(view.getAllByTestId("workflow-timeline-station")).toHaveLength(2);
    expect(view.getByTestId("workflow-timeline-arc")).toBeTruthy();
    expect(view.queryAllByTestId("workflow-agent-pill")).toHaveLength(2);
    expect(view.queryByTestId("workflow-card-footer")).toBeNull();
    // No callback means no ⤢ and no Resume (the callback's existence is the gate).
    expect(view.queryByTestId("workflow-card-open-details")).toBeNull();
    expect(view.queryByTestId("workflow-digest-resume")).toBeNull();
  });

  it("无箭头仍可点击及键盘折叠，子控件不切换", () => {
    const onOpenRun = vi.fn();
    const view = renderDigest({ summary: joined(), onOpenRun });
    const root = view.getByTestId("workflow-run-digest-t");
    expect(view.queryByTestId("workflow-card-toggle")).toBeNull();
    expect(root.getAttribute("role")).toBe("button");
    fireEvent.click(root);
    expect(view.queryAllByTestId("workflow-agent-pill")).toHaveLength(0);
    fireEvent.keyDown(root, { key: "Enter" });
    expect(view.getAllByTestId("workflow-agent-pill")).toHaveLength(2);
    fireEvent.click(view.getByTestId("workflow-card-open-details"));
    expect(onOpenRun).toHaveBeenCalledOnce();
  });

  it("还没启动的子代理药丸与活药丸同一套点击语法：按钮、↗，点它交出槽位而不切换整块", () => {
    // docs/dynamic-workflow/presentation.md "The pill": it used to be a span, and clicking it
    // bubbled up to the whole-block toggle, folding the card.
    const onOpenPill = vi.fn();
    const view = renderDigest({
      summary: joined({
        actors: [
          { siteId: "actor#1", ordinal: 1, name: "Ada", sessionId: "s-1", status: "completed" },
        ],
      }),
      onOpenPill,
    });
    const root = view.getByTestId("workflow-run-digest-t");
    const pills = view.getAllByTestId("workflow-agent-pill");
    expect(pills.map((pill) => pill.tagName)).toEqual(["BUTTON", "BUTTON"]);
    expect(pills[1]!.className).toContain("wf-pill-open");
    expect(pills[1]!.querySelector('[data-testid="workflow-timeline-pill-open"]')).not.toBeNull();
    fireEvent.click(pills[1]!);
    expect(onOpenPill).toHaveBeenCalledTimes(1);
    const handed = onOpenPill.mock.calls[0]![0] as TimelinePill;
    expect(handed.slot).toEqual({ siteId: "actor#2", ordinal: 1 });
    expect(handed.instance).toBeUndefined();
    expect(root.getAttribute("data-expanded")).toBe("true");
  });

  it("⤢ 与待答问题芯片都开 run 详情；芯片按数量计数、无回调时不可点", () => {
    const onOpenRun = vi.fn();
    const view = renderDigest({ summary: joined(), onOpenRun, pendingQuestions: 1 });
    fireEvent.click(view.getByTestId("workflow-card-open-details"));
    expect(onOpenRun).toHaveBeenCalledTimes(1);
    const chip = view.getByTestId("workflow-digest-questions");
    expect(chip.tagName).toBe("BUTTON");
    expect(chip.textContent).toBe("1 question");
    fireEvent.click(chip);
    expect(onOpenRun).toHaveBeenCalledTimes(2);
    cleanup();

    const inert = renderDigest({ summary: joined(), pendingQuestions: 2 });
    const span = inert.getByTestId("workflow-digest-questions");
    expect(span.tagName).toBe("SPAN");
    expect(span.textContent).toBe("2 questions");
    cleanup();

    expect(
      renderDigest({ summary: joined() }).queryByTestId("workflow-digest-questions"),
    ).toBeNull();
  });

  it("失败且可恢复：Resume 进表头，与详情页同一条命令；不可恢复或无回调时没有", () => {
    const onResume = vi.fn();
    const view = renderDigest({
      summary: joined({ status: "stopped", stopReason: "interrupted" }, { resumable: true }),
      onResume,
    });
    expect(view.getByTestId("workflow-card-kind").textContent).toBe("Workflow stopped");
    expect(view.getByTestId("workflow-digest-resume").getAttribute("data-size")).toBe("default");
    fireEvent.click(view.getByTestId("workflow-digest-resume"));
    expect(onResume).toHaveBeenCalledTimes(1);
    cleanup();

    expect(
      renderDigest({ summary: joined({ status: "errored" }), onResume }).queryByTestId(
        "workflow-digest-resume",
      ),
    ).toBeNull();
  });
});

describe("WorkflowRunDigest 产物条", () => {
  const ARTIFACTS = [
    { id: "book", kind: "file", title: "Audit report", version: 2 },
    { id: "perf", kind: "chart", title: "Round timings", version: 1 },
  ] as unknown as WorkflowRunState["artifacts"];

  it("收起态与展开态都挂产物条；点药丸交出产物 id，不切换整块", () => {
    const onOpenArtifact = vi.fn();
    const view = renderDigest({
      summary: joined({ status: "completed", artifacts: ARTIFACTS }),
      onOpenArtifact,
    });
    const root = view.getByTestId("workflow-run-digest-t");
    const strip = view.getByTestId("workflow-digest-artifacts");
    const pills = view.getAllByTestId("workflow-digest-artifact");
    expect(pills).toHaveLength(2);
    expect(pills[0]?.tagName).toBe("BUTTON");
    expect(pills[0]?.getAttribute("data-pill-size")).toBe("md");
    // The v2 in the tail slot only on the pill that has version 2.
    expect(strip.querySelectorAll('[data-testid="workflow-run-artifact-version"]')).toHaveLength(1);

    expect(root.getAttribute("data-expanded")).toBe("true");
    fireEvent.click(pills[1]!);
    expect(onOpenArtifact).toHaveBeenCalledWith("perf");
    expect(root.getAttribute("data-expanded")).toBe("true");
    // Blank space on the strip **is** part of the whole-block toggle (follow-up "click grammar
    // revision"): clicking it toggles, and the artifact strip remains.
    fireEvent.click(strip);
    expect(root.getAttribute("data-expanded")).toBe("false");
    expect(view.getAllByTestId("workflow-digest-artifact")).toHaveLength(2);
    fireEvent.click(strip);
    expect(root.getAttribute("data-expanded")).toBe("true");
  });

  it("禁用的产物药丸（无回调）不透传：点它既不打开也不切换整块", () => {
    const view = renderDigest({ summary: joined({ status: "completed", artifacts: ARTIFACTS }) });
    const root = view.getByTestId("workflow-run-digest-t");
    const pill = view.getAllByTestId("workflow-digest-artifact")[0] as HTMLButtonElement;
    expect(pill.disabled).toBe(true);
    fireEvent.click(pill);
    expect(root.getAttribute("data-expanded")).toBe("true");
  });

  it("没有产物或没有活投影时条缺席；没有回调时药丸禁用", () => {
    expect(
      renderDigest({ summary: joined() }).queryByTestId("workflow-digest-artifacts"),
    ).toBeNull();
    cleanup();
    const cold = renderDigest({ summary: joined({ artifacts: ARTIFACTS }, { run: undefined }) });
    expect(cold.queryByTestId("workflow-digest-artifacts")).toBeNull();
    cleanup();
    const inert = renderDigest({ summary: joined({ artifacts: ARTIFACTS }) });
    const pill = inert.getAllByTestId("workflow-digest-artifact")[0] as HTMLButtonElement;
    expect(pill.disabled).toBe(true);
  });
});

// Instance table overflow (docs/dynamic-workflow/presentation.md "The run card"): the header's
// counts already include instances outside the table, but the timeline can only draw those inside
// it — the sentence under the timeline is exactly about that difference.
describe("WorkflowRunDigest 撞界提示", () => {
  const truncated = (overrides: Partial<WorkflowRunState> = {}) =>
    joined({
      usage: { spentTokens: 10, nodesUsed: 2, nodesUnlisted: 1_500, nodesUnlistedSettled: 900 },
      truncated: true,
      ...overrides,
    });

  it("收起态与展开态都在：「仅展示 2/1502 步的详情」", () => {
    const view = renderDigest({ summary: truncated() });
    const root = view.getByTestId("workflow-run-digest-t");
    expect(view.getByTestId("workflow-digest-truncated").textContent).toBe(
      "Details shown for 2 of 1502 steps",
    );
    fireEvent.click(root);
    expect(root.getAttribute("data-expanded")).toBe("false");
    expect(view.getByTestId("workflow-digest-truncated")).not.toBeNull();
  });

  it("没撞界、只有小表撞界、没有活投影、以及没有轨道的单行卡上都没有这一句", () => {
    expect(
      renderDigest({ summary: joined() }).queryByTestId("workflow-digest-truncated"),
    ).toBeNull();
    cleanup();
    // `truncated` is also set when reports / artifacts / phases overflow; then not a single step is
    // missing, so there is nothing to say.
    expect(
      renderDigest({ summary: joined({ truncated: true }) }).queryByTestId(
        "workflow-digest-truncated",
      ),
    ).toBeNull();
    cleanup();
    expect(
      renderDigest({ summary: truncated({}), graph: undefined }).queryByTestId(
        "workflow-digest-truncated",
      ),
    ).toBeNull();
    cleanup();
    expect(
      renderDigest({ summary: joined({ truncated: true }, { run: undefined }) }).queryByTestId(
        "workflow-digest-truncated",
      ),
    ).toBeNull();
  });

  it("zh-CN 念「仅展示 2/1502 步的详情」", () => {
    const view = renderDigest({ summary: truncated() }, "zh-CN");
    expect(view.getByTestId("workflow-digest-truncated").textContent).toBe(
      "仅展示 2/1502 步的详情",
    );
  });
});

describe("WorkflowRunDigest 冷态", () => {
  it("没有活投影：一行——种类词 + 名字 + 状态词，没有计数、没有阶段线、没有 chevron", () => {
    const summary: WorkflowRunCardSummary = {
      runId: "dwfrun-42",
      toolCallId: "tool-create-workflow",
      status: "completed",
      nodesSettled: 2,
      nodesTotal: 2,
    };
    const view = renderDigest({ summary, onOpenRun: vi.fn() });
    expect(view.getByTestId("workflow-card-kind").textContent).toBe("Workflow completed");
    expect(view.queryByTestId("workflow-digest-status")).toBeNull();
    expect(view.queryByTestId("workflow-card-detail")).toBeNull();
    expect(view.queryByTestId("workflow-digest-plot")).toBeNull();
    expect(view.queryByTestId("workflow-card-toggle")).toBeNull();
    const root = view.getByTestId("workflow-run-digest-t");
    expect(root.hasAttribute("data-expanded")).toBe(false);
    // No phase line means no toggle: the whole block is not a button.
    expect(root.hasAttribute("role")).toBe(false);
    expect(view.getByTestId("workflow-card-open-details")).toBeTruthy();
  });

  it("行窗口里没有图（resume 单独成轮）：即使有活投影也只剩一行", () => {
    const view = renderDigest({ summary: joined(), graph: undefined });
    expect(view.queryByTestId("workflow-card-detail")).toBeNull();
    expect(view.queryByTestId("workflow-digest-plot")).toBeNull();
    expect(view.queryByTestId("workflow-card-toggle")).toBeNull();
  });
});

describe("WorkflowRunDigest 文案", () => {
  it("zh-CN 双写：芯片与 chevron 的词条在两种语言里都在", () => {
    for (const id of [
      "chat.toolCall.workflow.digest.question",
      "chat.toolCall.workflow.digest.questions",
      "chat.toolCall.workflow.digest.showAgents",
      "chat.toolCall.workflow.digest.hideAgents",
    ]) {
      expect(enUS[id as keyof typeof enUS]).toBeTruthy();
      expect(zhCN[id as keyof typeof zhCN]).toBeTruthy();
    }
    const view = renderDigest({ summary: joined(), pendingQuestions: 1 }, "zh-CN");
    expect(view.getByTestId("workflow-card-kind").textContent).toBe(
      zhCN["chat.toolCall.workflow.card.running"],
    );
    expect(view.getByTestId("workflow-digest-questions").textContent).toBe("1 个待答问题");
    expect(view.queryByTestId("workflow-card-toggle")).toBeNull();
  });
});

it.each(["running", "completed", "stopped"] as const)(
  "运行卡名称使用普通 UI 字体：%s",
  (status) => {
    const view = renderDigest({ summary: joined({ status }) });
    expect(view.getByTestId("workflow-card-name").className).not.toContain("font-mono");
  },
);

// Stop run on a running card (docs/dynamic-workflow/presentation.md): while running, Resume's spot
// is replaced by Stop, going through the same command as the detail page; it disables on click
// until the status changes.
describe("WorkflowRunDigest Stop run", () => {
  it("running + onCancel：Stop 进表头、可点；点后禁用并换成 Stopping…", () => {
    const onCancel = vi.fn();
    const view = renderDigest({ summary: joined(), onCancel });
    const cancel = view.getByTestId("workflow-digest-cancel");
    // Same style as ⤢: a ghost icon button, text only in aria-label / tooltip.
    expect(cancel.getAttribute("aria-label")).toBe("Stop run");
    expect(cancel.textContent).toBe("");
    expect(cancel.getAttribute("data-size")).toBe("icon-md");
    expect(cancel.getAttribute("data-variant")).toBe("ghost");
    expect(view.queryByTestId("workflow-digest-resume")).toBeNull();
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect((cancel as HTMLButtonElement).disabled).toBe(true);
    expect(cancel.getAttribute("aria-label")).toBe("Stopping…");
    // Clicking Cancel does not trigger the card collapse (the button is excluded by hitsControl).
    expect(
      view.container.querySelector("[data-workflow-run-digest]")?.getAttribute("data-expanded"),
    ).toBe("true");
  });

  it("Stopping… 的复位不再是一轮 effect setState：状态变化只提交一次", () => {
    // Revision 2026-09-12: the reset used to be a setCancelling(false) inside an effect keyed on
    // status — every status change added one more update after the projection frame's synchronous
    // commit (same shape as the workflow card crash's throw site). Now the Cancel button is keyed
    // by status and remounts; the reset is the remount itself, and the frame carrying the status
    // change commits exactly once. Count commits with a Profiler.
    const onCancel = vi.fn();
    const onResume = vi.fn();
    let commits = 0;
    const tree = (summary: WorkflowRunCardSummary) =>
      createElement(
        Profiler,
        { id: "digest", onRender: () => (commits += 1) },
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(WorkflowRunDigest, {
            graph: LOOP_GRAPH as unknown as WorkflowRunDigestProps["graph"],
            name: "implement-verify",
            testIdKey: "t",
            summary,
            onCancel,
            onResume,
          }),
        ),
      );
    const view = render(tree(joined()));
    fireEvent.click(view.getByTestId("workflow-digest-cancel"));
    expect(view.getByTestId("workflow-digest-cancel").getAttribute("aria-label")).toBe("Stopping…");

    // A new frame in the same status: the button stays Stopping….
    view.rerender(tree(joined({ status: "running" }, { nodesSettled: 3 })));
    expect((view.getByTestId("workflow-digest-cancel") as HTMLButtonElement).disabled).toBe(true);

    commits = 0;
    view.rerender(tree(joined({ status: "stopped" }, { resumable: true })));
    expect(commits).toBe(1);
    expect(view.queryByTestId("workflow-digest-cancel")).toBeNull();
    expect(view.getByTestId("workflow-digest-resume")).toBeTruthy();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("状态一变按钮复位；stopped + resumable 时原位是 Resume；无回调或非 running 不渲染", () => {
    const onCancel = vi.fn();
    const onResume = vi.fn();
    const view = renderDigest({ summary: joined(), onCancel, onResume });
    fireEvent.click(view.getByTestId("workflow-digest-cancel"));
    view.rerender(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(WorkflowRunDigest, {
          graph: LOOP_GRAPH as unknown as WorkflowRunDigestProps["graph"],
          name: "implement-verify",
          testIdKey: "t",
          summary: joined({ status: "stopped" }, { resumable: true }),
          onCancel,
          onResume,
        }),
      ),
    );
    expect(view.queryByTestId("workflow-digest-cancel")).toBeNull();
    expect(view.getByTestId("workflow-digest-resume")).toBeTruthy();
    cleanup();

    expect(renderDigest({ summary: joined() }).queryByTestId("workflow-digest-cancel")).toBeNull();
    cleanup();
    expect(
      renderDigest({ summary: joined({ status: "completed" }), onCancel }).queryByTestId(
        "workflow-digest-cancel",
      ),
    ).toBeNull();
  });

  it("zh-CN：停止运行 / 正在停止…", () => {
    const view = renderDigest({ summary: joined(), onCancel: vi.fn() }, "zh-CN");
    const cancel = view.getByTestId("workflow-digest-cancel");
    expect(cancel.getAttribute("aria-label")).toBe(zhCN["chat.toolCall.workflow.run.cancel"]);
    fireEvent.click(cancel);
    expect(cancel.getAttribute("aria-label")).toBe(zhCN["chat.toolCall.workflow.run.cancelling"]);
    expect(enUS["chat.toolCall.workflow.run.cancelling"]).toBeTruthy();
    expect(zhCN["chat.toolCall.workflow.run.cancelling"]).toBeTruthy();
  });

  // The other half of the verb rename: say clearly before the click that "stop ≠ discard". That
  // sentence lives only in the tooltip's second line, so the assertion goes through the tooltip
  // props, not the DOM.
  it("提示第二行说明可恢复；正在停止时那句话撤走", () => {
    const view = renderDigest({ summary: joined(), onCancel: vi.fn() });
    const before = tooltips.calls.find((call) => call.title === "Stop run");
    expect(before?.description).toBe("You can resume later; finished steps are kept.");

    tooltips.calls.length = 0;
    fireEvent.click(view.getByTestId("workflow-digest-cancel"));
    const during = tooltips.calls.find((call) => call.title === "Stopping…");
    expect(during).toBeTruthy();
    expect(during?.description).toBeUndefined();
  });

  it("zh-CN 的提示第二行同样在场", () => {
    renderDigest({ summary: joined(), onCancel: vi.fn() }, "zh-CN");
    expect(
      tooltips.calls.find((call) => call.title === zhCN["chat.toolCall.workflow.run.cancel"])
        ?.description,
    ).toBe(zhCN["chat.toolCall.workflow.run.stopHint"]);
  });

  // The run-control vocabulary must be the same set in the same order on both sides: one side adds
  // a word and the other forgets, and the user sees an English fallback leak into the Chinese UI.
  it("run 词表的键集在两种语言下完全一致", () => {
    const prefix = "chat.toolCall.workflow.run.";
    const zhKeys = Object.keys(zhCN).filter((key) => key.startsWith(prefix));
    const enKeys = Object.keys(enUS).filter((key) => key.startsWith(prefix));
    expect(zhKeys.length).toBeGreaterThan(0);
    expect(enKeys).toEqual(zhKeys);
    for (const key of [`${prefix}stopHint`, `${prefix}resumable`]) {
      expect(zhCN[key]).toBeTruthy();
      expect(enUS[key]).toBeTruthy();
    }
  });
});

// ── lineage (docs/dynamic-workflow/presentation.md "The run card") ──
// On the card only the kind word changes; the "amended from / superseded by" sentences are not
// drawn (user ruling: too noisy); those two sentences live only on the detail page and in the
// confirmation window.
describe("WorkflowRunDigest lineage", () => {
  // The join table copies run.stopReason onto the summary (workflowRunCardJoin.ts); the fixture
  // copies it the same way.
  const superseded = joined(
    { status: "stopped", stopReason: "superseded", supersededBy: "dwfrun-next" },
    { stopReason: "superseded" },
  );

  it.each([
    ["en-US", "Workflow superseded"],
    ["zh-CN", "工作流已被替代"],
  ] as const)("被替代的 run：只换种类词，没有 Resume，也没有后继链接：%s", (locale, kind) => {
    const onResume = vi.fn();
    const view = renderDigest({ summary: superseded, onResume }, locale);
    expect(view.getByTestId("workflow-card-kind").textContent).toBe(kind);
    expect(view.container.textContent).not.toContain("dwfrun-next");
    // A superseded run is never resumable (the CLI does not provide resumable).
    expect(view.queryByTestId("workflow-digest-resume")).toBeNull();
    // The light is still stopped's neutral empty ring, not destructive.
    expect(view.container.innerHTML).not.toContain("bg-destructive");
  });

  it("修订出来的 run 卡上不提前驱", () => {
    const view = renderDigest({ summary: joined({ resumedFrom: "dwfrun-prev" }) });
    expect(view.container.textContent).not.toContain("dwfrun-prev");
  });

  it("普通 stopped 的 run 种类词照旧", () => {
    const view = renderDigest({
      summary: joined({ status: "stopped", stopReason: "user" }, { stopReason: "user" }),
    });
    expect(view.getByTestId("workflow-card-kind").textContent).toBe("Workflow stopped");
  });
});

// ── Wiring (docs/dynamic-workflow/authoring.md "How the user sees them") ──
// Above we pinned the pill handing the **artifact id** to the layer above; here we pin what kind of
// open request that layer turns the id into. The live projection's artifact summary carries the
// latest version's `contentType` (the host uses it to open html artifacts directly as a browser
// tab) and deliberately omits `sourcePath` (a high-frequency state key), so the request must not
// invent a provenance out of thin air either.
describe("ConversationWorkflowDigests 把药丸变成打开请求", () => {
  const ARTIFACTS = [
    { id: "book", kind: "file", title: "Audit report", version: 2, contentType: "text/html" },
    { id: "perf", kind: "chart", title: "Round timings", version: 1 },
  ] as unknown as WorkflowRunState["artifacts"];

  function renderDigests(onOpenWorkflowArtifact: (request: unknown) => void) {
    const summary = joined({ status: "completed", artifacts: ARTIFACTS });
    return render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(ConversationWorkflowDigests, {
          turnKey: "t",
          digests: [
            {
              key: "k",
              toolCallId: "tool-create-workflow",
              runId: "dwfrun-42",
              name: "implement-verify",
              graph: LOOP_GRAPH as unknown as WorkflowRunDigestProps["graph"],
              summary,
            },
          ],
          context: {
            sessionId: "parent-a",
            onOpenWorkflowArtifact,
          } as unknown as ConversationRowRenderContext,
        }),
      ),
    );
  }

  it("带上展示名与 contentType，不带出处（活投影那份摘要没有 sourcePath）", () => {
    const spy = vi.fn();
    const view = renderDigests(spy);

    fireEvent.click(view.getAllByTestId("workflow-digest-artifact")[0]!);
    expect(spy).toHaveBeenCalledWith({
      parentSessionId: "parent-a",
      runId: "dwfrun-42",
      artifactId: "book",
      title: "Audit report",
      contentType: "text/html",
    });
  });

  it("摘要上没有 contentType 的那一枚不编一个出来", () => {
    const spy = vi.fn();
    const view = renderDigests(spy);

    fireEvent.click(view.getAllByTestId("workflow-digest-artifact")[1]!);
    expect(spy).toHaveBeenCalledWith({
      parentSessionId: "parent-a",
      runId: "dwfrun-42",
      artifactId: "perf",
      title: "Round timings",
    });
  });
});

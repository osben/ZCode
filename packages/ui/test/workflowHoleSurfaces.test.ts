// How holes are drawn on each surface (docs/dynamic-workflow/presentation.md "Holes on the
// timeline"): the timeline's hole stations (dashed lamp, dashed rails, tail stub, the fill's head
// and frame), the run card's "{n} holes awaiting fill" chip, the confirmation dialog's hole rows
// and "2 phases · 2 holes", the sidebar mini-rail's dashed lamp and "{name} · waiting for fill",
// and the fill-row summary wired into the run. Static rendering (renderToStaticMarkup); interaction
// is out of scope here.
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/hooks/useWorkflowSubagentModelProviderName.js", () => ({
  useWorkflowSubagentModelProviderName: () => undefined,
}));
vi.mock("@/components/ai-elements/code-block.js", () => ({
  CodeBlock: ({ code }: { code: string }) => createElement("pre", null, code),
  CodeBlockHeader: () => null,
}));
vi.mock("@/lib/workflowRunAckStore.js", () => ({
  getWorkflowRunAckStore: () => ({ acknowledge: () => undefined }),
  useWorkflowRunAcknowledged: () => () => false,
}));
vi.mock("@/v4/workflowRunOpenContext.js", () => ({ useWorkflowRunOpen: () => null }));

// eslint-disable-next-line import/first -- The component under test must be imported after the mocks.
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";
// eslint-disable-next-line import/first -- Ditto.
import { WorkflowTimeline } from "@/components/workflow-timeline/WorkflowTimeline.js";
// eslint-disable-next-line import/first -- Ditto.
import { WorkflowRunDigest } from "@/components/workflow-timeline/WorkflowRunDigest.js";
// eslint-disable-next-line import/first -- Ditto.
import { WorkflowTimelineFills } from "@/components/workflow-timeline/WorkflowTimelineFills.js";
// eslint-disable-next-line import/first -- Ditto.
import { HoleWaitingBody } from "@/app-shell/WorkflowRunHoleParts.js";
// eslint-disable-next-line import/first -- Ditto.
import { workflowPhasesDetail } from "@/components/workflow-timeline/timeline-summary.js";
// eslint-disable-next-line import/first -- Ditto.
import { WorkflowPermissionHoles } from "@/WorkflowPermissionHoles.js";
// eslint-disable-next-line import/first -- Ditto.
import { TaskWorkflowRunLines } from "@/components/workflow-run-line/TaskWorkflowRunLines.js";
// eslint-disable-next-line import/first -- Ditto.
import { foldWorkflowRunRail } from "@/lib/workflowRunLine.js";
// eslint-disable-next-line import/first -- Ditto.
import { WorkflowToolSummary } from "@/v4/WorkflowToolSummary.js";
// eslint-disable-next-line import/first -- Ditto.
import { workflowFillCounts } from "@/ToolCallBlocks/renderers/createWorkflowHoleInput.js";

// Hole ids are name-keyed `hole#<8 hex digits>` (docs/analysis.md "Sites"); the renderer only checks shape.
const H1 = "hole#a0000001"; // grouping decision
const H2 = "hole#a0000002"; // verdict
const H11 = "hole#a0000011"; // pick (inside H1's body)

function html(node: ReactNode, locale: "zh-CN" | "en-US" = "zh-CN"): string {
  return renderToStaticMarkup(createElement(ZCodeIntlProvider, { initialLocale: locale }, node));
}

const OPEN: WorkflowCausalityGraphData = {
  steps: [{ id: "ask#1", kind: "ask", label: "scout", lane: "actor#1", phase: "phase#1" }],
  lanes: [{ id: "actor#1", name: "侦察员" }],
  participants: [{ id: "p1", phase: "phase#1", lane: "actor#1", steps: ["ask#1"] }],
  handoffs: [],
  phases: [
    { id: "phase#1", name: "探索" },
    { id: H1, name: "决定分组" },
    { id: H2, name: "评判" },
  ],
  phaseEdges: [
    { from: "phase#1", to: H1 },
    { from: H1, to: H2 },
  ],
  holes: [
    { siteId: H1, name: "决定分组", type: "Plan" },
    { siteId: H2, name: "评判", type: "Verdict", tail: true },
  ],
};

const FILLED: WorkflowCausalityGraphData = {
  steps: [
    { id: "ask#1", kind: "ask", label: "scout", lane: "actor#1", phase: "phase#1" },
    {
      id: `${H1}/ask#1`,
      kind: "ask",
      label: "smoke",
      lane: `${H1}/actor#1`,
      phase: `${H1}/phase#1`,
      fill: H1,
    },
  ],
  lanes: [
    { id: "actor#1", name: "侦察员" },
    { id: `${H1}/actor#1`, name: "冒烟员" },
  ],
  participants: [
    { id: "p1", phase: "phase#1", lane: "actor#1", steps: ["ask#1"] },
    { id: "p2", phase: `${H1}/phase#1`, lane: `${H1}/actor#1`, steps: [`${H1}/ask#1`] },
  ],
  handoffs: [],
  // The body starts with a marker: H1's own phase stays in the table (no members); the timeline hands it to the head and does not make it a station.
  phases: [
    { id: "phase#1", name: "探索" },
    { id: H1, name: "决定分组" },
    { id: `${H1}/phase#1`, name: "冒烟测试", fill: H1 },
  ],
  phaseEdges: [
    { from: "phase#1", to: H1 },
    { from: H1, to: `${H1}/phase#1` },
  ],
};

function run(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    runId: "run-1",
    toolCallId: "tc-1",
    status: "running",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [],
    nodes: [],
    lastEventSequence: 0,
    ...overrides,
  };
}

describe("时间线上的留白站", () => {
  it("开着的留白：虚线灯、只画名字不画类型、两侧虚线轨道段、尾巴留白的 40px 残段", () => {
    const out = html(
      createElement(WorkflowTimeline, { model: buildWorkflowTimeline(OPEN, undefined) }),
    );
    expect(out).toContain('data-station-hole="open"');
    expect(out).toContain('data-lamp="hole-open"');
    expect(out).toContain("border-dashed");
    // The type is a compile contract, never UI: the station head carries only the name (in the
    // live check on 2026-09-28 a monospace type badge squeezed the station name to zero width).
    expect(out).not.toContain("workflow-hole-type");
    expect(out).toContain("决定分组");
    expect(out).toContain("评判");
    expect(out).not.toContain("Plan");
    expect(out).not.toContain("Verdict");
    expect(out).toContain('data-rail-dashed="true"');
    expect(out).toContain('data-testid="workflow-timeline-tail-stub"');
    expect(out).not.toContain("workflow-timeline-fill-head");
  });

  it("等待中：警示色虚线灯（常亮光晕、不搏动）与「等待补全」", () => {
    const out = html(
      createElement(WorkflowTimeline, {
        model: buildWorkflowTimeline(
          OPEN,
          run({
            holes: [{ siteId: H1, ordinal: 1, name: "决定分组", type: "Plan", state: "waiting" }],
          }),
        ),
      }),
    );
    expect(out).toContain('data-lamp="hole-waiting"');
    expect(out).toContain("wf-lamp-hole-waiting");
    expect(out).toContain("等待补全");
    // The waiting lamp is not a running lamp: no heartbeat.
    expect(out).not.toContain("wf-lamp-running");
  });

  it("补全后：头（笔 · 名，不画类型）与框，体的站带 data-fill；tooltip 说由主代理补全；框静止时不亮", () => {
    const out = html(
      createElement(WorkflowTimeline, {
        model: buildWorkflowTimeline(
          FILLED,
          run({
            holes: [
              {
                siteId: H1,
                ordinal: 1,
                name: "决定分组",
                type: "Plan",
                state: "filled",
                filledAt: 1,
              },
            ],
          }),
        ),
      }),
    );
    expect(out).toContain('data-testid="workflow-timeline-fill-head"');
    expect(out).toContain("决定分组");
    expect(out).not.toContain("Plan");
    expect(out).toContain("由主代理补全");
    // The region became a frame (docs/dynamic-workflow/presentation.md "Filled with phases"): one path with pathLength 1.
    expect(out).not.toContain("workflow-timeline-fill-region");
    expect(out).toContain('data-testid="workflow-timeline-fill-frame"');
    expect(out).toContain(`data-fill-frame="${H1}"`);
    expect(out).toContain('pathLength="1"');
    expect(out).not.toContain('data-fill-on="true"');
    // The head is the only lit surface; the station still carries data-fill (for tests and growth) but is no longer the hover target.
    expect(out).toContain(`data-fill-head="${H1}"`);
    expect(out).toContain(`data-fill="${H1}"`);
  });
});

describe("侧板的等待体", () => {
  it("写「等待主代理补全 · 等了多久」与主代理收到的提示语；没有提示语时不留空段", () => {
    const now = 10 * 60_000;
    const out = html(
      createElement(HoleWaitingBody, {
        hole: {
          siteId: H1,
          state: "waiting",
          type: "Plan",
          since: now - 3 * 60_000,
          prompt: "侦察结果如下，请补全这一段。",
        },
        now,
      }),
    );
    expect(out).toContain("等待主代理补全");
    expect(out).toContain('data-testid="workflow-run-hole-prompt"');
    expect(out).toContain("侦察结果如下，请补全这一段。");
    const bare = html(
      createElement(HoleWaitingBody, { hole: { siteId: H1, state: "waiting" }, now }),
    );
    expect(bare).not.toContain("workflow-run-hole-prompt");
  });
});

describe("嵌套的补全框", () => {
  const frame = (holeId: string, x0: number, x1: number) => ({
    holeId,
    box: { x0, x1, y0: 12, y1: 60, start: x0 + 25 },
  });
  const fresh: ReadonlySet<string> = new Set();

  it("一次只亮一个框：指针在内层的头上只亮内层，在外层的头上只亮外层（框不叠）", () => {
    const fills = [
      { holeId: H1, name: "决定分组", from: 1, to: 3 },
      { holeId: H11, name: "挑选", from: 2, to: 2 },
    ];
    const frames = [frame(H1, 184, 752), frame(H11, 376, 552)];
    const props = { fills, frames, fresh, height: 80, inset: 0, width: 900 };
    const inner = html(createElement(WorkflowTimelineFills, { ...props, active: H11 }));
    expect(inner.match(/data-fill-on="true"/gu)).toHaveLength(2); // 框 + 它的头
    expect(inner).toMatch(new RegExp(`data-fill-frame="${H11}"[^>]*data-fill-on="true"`, "u"));
    expect(inner).not.toMatch(new RegExp(`data-fill-frame="${H1}"[^>]*data-fill-on="true"`, "u"));
    const outer = html(createElement(WorkflowTimelineFills, { ...props, active: H1 }));
    expect(outer).toMatch(new RegExp(`data-fill-frame="${H1}"[^>]*data-fill-on="true"`, "u"));
    expect(outer).not.toMatch(new RegExp(`data-fill-frame="${H11}"[^>]*data-fill-on="true"`, "u"));
    expect(outer.match(/data-testid="workflow-timeline-fill-head"/gu)).toHaveLength(2);
    // Different origins: the two heads each aim at their own first lamp (two rows).
    expect(outer.match(/data-testid="workflow-timeline-fill-heads"/gu)).toHaveLength(2);
    const rest = html(createElement(WorkflowTimelineFills, { ...props, active: undefined }));
    expect(rest).not.toContain('data-fill-on="true"');
  });

  it("内层与外层同起于一列：内层的头排在外层头的右缘再过 12px，同一行；顺序外层在前", () => {
    const fills = [
      { holeId: H1, name: "决定分组", from: 1, to: 3 },
      { holeId: H11, name: "挑选", from: 1, to: 1 },
    ];
    const out = html(
      createElement(WorkflowTimelineFills, {
        active: undefined,
        fills,
        frames: [],
        fresh,
        height: 40,
        inset: 0,
        width: 900,
      }),
    );
    const rows = out.match(
      /<span class="absolute flex items-center gap-3"[^>]*data-testid="workflow-timeline-fill-heads"[^>]*>/gu,
    );
    expect(rows).toHaveLength(1);
    expect(out.indexOf(`data-fill-head="${H1}"`)).toBeLessThan(
      out.indexOf(`data-fill-head="${H11}"`),
    );
    // Both heads live in the same container: the inner head no longer carries its own left.
    expect(out.match(/data-testid="workflow-timeline-fill-head"/gu)).toHaveLength(2);
    // Row left edge = station 1's x (192) + lamp center 17 - the pen's half-width setback 6.
    expect(out).toContain("left:203px");
    expect(out.match(/left:/gu)).toHaveLength(1);
  });

  it("新鲜的两秒：框带 wf-fill-frame-fresh 自己画出（没有指针也亮），头染警示色", () => {
    const fills = [{ holeId: H1, name: "决定分组", from: 1, to: 2, filledAt: Date.now() }];
    const out = html(
      createElement(WorkflowTimelineFills, {
        active: undefined,
        fills,
        frames: [frame(H1, 184, 560)],
        fresh: new Set([H1]),
        height: 80,
        inset: 0,
        width: 900,
      }),
    );
    expect(out).toContain("wf-fill-frame-fresh");
    expect(out).toMatch(/data-fill-fresh="true"[^>]*data-fill-on="true"/u);
    expect(out).toContain("text-warning");
  });
});

describe("run 卡与确认窗", () => {
  it("卡表头长出「{n} 处留白待补全」芯片（与问题芯片并存）", () => {
    const out = html(
      createElement(WorkflowRunDigest, {
        graph: OPEN,
        name: "flaky-hunt",
        pendingQuestions: 1,
        runId: "run-1",
        summary: {
          runId: "run-1",
          status: "running",
          nodesSettled: 0,
          nodesTotal: 1,
          agents: 1,
          run: run({ holes: [{ siteId: H1, ordinal: 1, name: "决定分组", state: "waiting" }] }),
        },
        testIdKey: "t",
      }),
    );
    expect(out).toContain('data-testid="workflow-digest-holes"');
    expect(out).toContain("1 处留白待补全");
    expect(out).toContain('data-testid="workflow-digest-questions"');
  });

  it("细节数「1 个阶段 · 2 处留白」：开着的留白不算阶段", () => {
    // The Fork's timeline-summary goes through formatPlural's plural family (card.phases / card.holes).
    const format = {
      formatMessage: (descriptor: { id: string }) => descriptor.id,
      formatPlural: (descriptor: { id: string }, count: number) =>
        descriptor.id.endsWith("card.holes") ? `${count} 处留白` : `${count} 个阶段`,
    };
    expect(workflowPhasesDetail(format, buildWorkflowTimeline(OPEN, undefined), OPEN)).toBe(
      "1 个阶段 · 2 处留白",
    );
  });

  it("确认窗的留白行：每处留白一枚芯片（笔、名；不画类型）加一句会暂停", () => {
    const out = html(createElement(WorkflowPermissionHoles, { holes: OPEN.holes }));
    expect(out).toContain('data-testid="workflow-permission-holes"');
    expect(out.match(/data-testid="workflow-permission-hole"/gu)).toHaveLength(2);
    expect(out).toContain("运行到留白处会暂停，等主代理补全后继续。");
    expect(out).not.toContain("Plan");
    expect(html(createElement(WorkflowPermissionHoles, { holes: [] }))).toBe("");
  });

  it("已接进 run 的补全行：「留白已补全 · {name} · {k} 个阶段 · {m} 个子代理」", () => {
    const counts = workflowFillCounts(FILLED, H1);
    expect(counts).toEqual({ agents: 1, phases: 1 });
    const out = html(
      createElement(WorkflowToolSummary, {
        toolCallId: "tc-fill",
        summary: { runId: "run-1", status: "running", nodesSettled: 0, nodesTotal: 0, agents: 3 },
        fill: { name: "决定分组", ...counts },
      }),
    );
    expect(out).toContain("留白已补全");
    expect(out).toContain("决定分组");
    expect(out).toContain("1 个阶段");
    expect(out).toContain("1 个子代理");
  });
});

describe("侧栏运行行", () => {
  it("迷你轨道把留白画成虚线灯（等待时警示色），行上写「{name} · 等待补全」", () => {
    const rail = foldWorkflowRunRail([
      { name: "探索", status: "done" },
      { name: "决定分组", status: "pending", hole: "waiting" },
      { name: "评判", status: "pending", hole: "open" },
    ]);
    expect(rail.stations.map((station) => station.hole)).toEqual([undefined, "waiting", "open"]);
    expect(rail.stations[1]!.reached).toBe(true);
    const out = html(
      createElement(TaskWorkflowRunLines, {
        activity: {
          runs: [
            {
              runId: "run-1",
              status: "running",
              phases: [
                { name: "探索", status: "done" },
                { name: "决定分组", status: "pending", hole: "waiting" },
              ],
              currentPhase: "探索",
              agentsWorking: 0,
              waitingHole: "决定分组",
            },
          ],
        },
        isActive: false,
        intl: {
          formatMessage: (desc: { id: string }, values?: Record<string, string>) =>
            desc.id === "taskList.workflowRun.holeWaiting" ? `${values?.name} · 等待补全` : desc.id,
        },
      }),
    );
    expect(out).toContain('data-rail-hole="waiting"');
    expect(out).toContain("border-warning");
    expect(out).toContain("决定分组 · 等待补全");
  });
});

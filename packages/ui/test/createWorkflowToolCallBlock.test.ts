// @vitest-environment jsdom

// Rendering regression for ToolLayout and the legacy host run card before launch; the v4 run summary is covered
// separately by the workflowToolSummary tests.
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowDraftPosition, WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

vi.mock("@/components/ai-elements/code-block.js", () => ({
  CodeBlockHeader: () => null,
  CodeBlock: ({
    code,
    contentClassName,
    showLineNumbers,
    markedLines,
  }: {
    code: string;
    children?: ReactNode;
    contentClassName?: string;
    showLineNumbers?: boolean;
    markedLines?: readonly number[];
  }) =>
    createElement(
      "pre",
      {
        "data-testid": "code-block",
        className: contentClassName,
        "data-show-line-numbers": showLineNumbers === true ? "true" : undefined,
        "data-marked-lines": markedLines === undefined ? undefined : markedLines.join(","),
      },
      code,
    ),
}));

// ControlHintTooltip depends on the app root's TooltipProvider; in tests it is replaced with a pass-through stub per existing convention.
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children?: ReactNode }) => children,
}));

// Wiring cases render the whole row; the row never touches workspace services, so an empty implementation spares us
// building a whole Provider.
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServices: () => ({}),
}));

// eslint-disable-next-line import/first -- The renderer under test must be imported after the code-block mock.
import {
  CreateWorkflowToolCallBlock,
  readWorkflowKindMessageId,
} from "../src/ToolCallBlocks/renderers/create-workflow.js";
// eslint-disable-next-line import/first -- Same as above; the feedback tooltip's pure function reads under the same rule as the renderer.
import { formatWorkflowFeedbackTooltip } from "../src/ToolCallBlocks/renderers/createWorkflowDisplay.js";
// eslint-disable-next-line import/first -- Same as above; the input-reading rule shared by the card and the confirmation dialog.
import {
  readWorkflowAmendScriptInherited,
  readWorkflowRetuneCall,
} from "../src/ToolCallBlocks/renderers/createWorkflowInput.js";
// eslint-disable-next-line import/first -- Same as above; the wiring layer (row → host request) is used only in that section.
import { ConversationRowView } from "@/v4/ConversationRowView.js";
// eslint-disable-next-line import/first -- Same as above.
import { PlatformProvider } from "@/hooks/usePlatform.js";
// eslint-disable-next-line import/first -- Same as above; the locale entries are used only for two-language existence assertions.
import enUS from "../src/i18n/locales/en-US.js";
// eslint-disable-next-line import/first -- Same as above.
import zhCN from "../src/i18n/locales/zh-CN.js";

type ToolCallOverrides = {
  /** Tool name (same value for kind / title); defaults to CreateWorkflow, amend rows pass AmendWorkflow. */
  kind?: string;
  input?: unknown;
  output?: unknown;
  raw?: unknown;
  status?: string;
  snapshotRefs?: readonly { field: string; previewBytes: number; fullBytes: number }[];
};

type ContextOverrides = {
  isRunning?: boolean;
  statusLabel?: string;
  errorText?: string;
  onOpenWorkflowRun?: (request: { workflowName?: string }) => void;
  onResumeWorkflowRun?: (request: { workflowName?: string }) => void;
  onOpenWorkflowActor?: (request: {
    runId: string;
    actorSessionId: string;
    siteId: string;
    ordinal: number;
    actorName?: string;
  }) => void;
  onLoadFullToolCallFields?: (toolId: string) => void;
  onOpenWorkflowArtifact?: (artifactId: string) => void;
  onOpenWorkflowWorkspace?: (request: { phaseId: string; workflowName?: string }) => void;
  workflowRun?: WorkflowRunCardSummary;
  workflowDraft?: WorkflowDraftPosition;
  forceOpen?: boolean;
  canToggle?: boolean;
};

function createBlock(
  toolCall: ToolCallOverrides,
  contextOverrides: ContextOverrides = {},
  locale: "en-US" | "zh-CN" = "en-US",
) {
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: locale },
    createElement(CreateWorkflowToolCallBlock, {
      toolCallNode: {
        toolCall: {
          toolId: "tool-create-workflow",
          kind: toolCall.kind ?? "CreateWorkflow",
          title: toolCall.kind ?? "CreateWorkflow",
          input: toolCall.input,
          output: toolCall.output,
          status: toolCall.status ?? "completed",
          raw: toolCall.raw,
          snapshotRefs: toolCall.snapshotRefs,
        },
        childToolCalls: [],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- The test context only fills the fields the renderer reads.
      } as any,
      workspacePath: "/workspace",
      displayModel: {
        inlinePreview: { type: "none" },
        planResult: null,
        viewerSource: null,
        viewerLabelId: "codeViewer.viewCode",
        showSummaryFileLink: false,
        showInput: false,
        showOutput: true,
        showKind: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Same as above.
      } as any,
      viewerSource: null,
      rawFileSummaries: [],
      isRunning: contextOverrides.isRunning ?? false,
      statusLabel: contextOverrides.statusLabel ?? "Completed",
      errorText: contextOverrides.errorText,
      childToolList: null,
      forceOpen: contextOverrides.forceOpen ?? true,
      canToggle: contextOverrides.canToggle ?? true,
      showIcon: true,
      onOpenWorkflowRun: contextOverrides.onOpenWorkflowRun,
      onResumeWorkflowRun: contextOverrides.onResumeWorkflowRun,
      onOpenWorkflowActor: contextOverrides.onOpenWorkflowActor,
      onOpenWorkflowArtifact: contextOverrides.onOpenWorkflowArtifact,
      onOpenWorkflowWorkspace: contextOverrides.onOpenWorkflowWorkspace,
      onLoadFullToolCallFields: contextOverrides.onLoadFullToolCallFields,
      workflowRun: contextOverrides.workflowRun,
      workflowDraft: contextOverrides.workflowDraft,
    }),
  );
}

function renderBlock(
  toolCall: ToolCallOverrides,
  contextOverrides: ContextOverrides = {},
  locale: "en-US" | "zh-CN" = "en-US",
): string {
  return renderToStaticMarkup(createBlock(toolCall, contextOverrides, locale));
}

function renderBlockDom(
  toolCall: ToolCallOverrides,
  contextOverrides: ContextOverrides = {},
  locale: "en-US" | "zh-CN" = "en-US",
) {
  return render(createBlock(toolCall, contextOverrides, locale));
}

// This repo's vitest does not enable globals, so @testing-library's automatic cleanup is never registered; without an
// explicit cleanup the previous case's DOM would leak into the next one.
afterEach(() => {
  cleanup();
});

const OK_DISPLAY = {
  kind: "create_workflow",
  ok: true,
  errorCount: 0,
  diagnostics: [],
};

// ── Graph fixture: plan → verify, verify back to plan ──
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
};

const FLAT_GRAPH = {
  steps: [{ id: "ask#1", kind: "ask", label: "a", line: 1, column: 21, lane: "actor#1" }],
  lanes: [{ id: "actor#1", name: "a", line: 1, column: 11 }],
  participants: [{ id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] }],
  handoffs: [],
  sink: ["ask#1"],
};

const LOOP_TOOL_CALL: ToolCallOverrides = {
  input: { name: "Research pipeline", script: 'phase("plan");\nconst p = agent("planner");' },
  raw: { display: { ...OK_DISPLAY, causalityGraph: LOOP_GRAPH } },
};

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
) {
  const run = runState(overrides);
  const settled = run.nodes.filter((node) => node.phase === "settled").length;
  return {
    runId: run.runId,
    status: run.status,
    ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
    nodesSettled: settled,
    nodesTotal: run.nodes.length,
    run,
    ...extra,
  } satisfies WorkflowRunCardSummary;
}

describe("CreateWorkflowToolCallBlock 表头种类词", () => {
  it("扫光中的种类词可见：换词的 wf-swap 包在 animated-gradient-text 外面，不在里面", () => {
    // background-clip:text only clips its own layer's text; children promoted to their own layer by transform/opacity
    // animations turn transparent, and the header's "Workflow running" becomes a stretch of blank (round 7 revision).
    const view = renderBlockDom(LOOP_TOOL_CALL, { workflowRun: joined() });
    const kind = view.getByTestId("workflow-card-kind");
    expect(kind.textContent).toBe("Workflow running");
    const gradient = kind.querySelector(".animated-gradient-text")!;
    expect(gradient).toBeTruthy();
    expect(gradient.querySelector(".wf-swap")).toBeNull();
    expect(gradient.closest(".wf-swap")).toBeTruthy();
    expect(gradient.textContent).toBe("Workflow running");
  });
});

describe("CreateWorkflowToolCallBlock 静态形态（编过、未联接 run）", () => {
  it("表头：种类词 + 名字，右侧空环灯「compiled」+ 等宽计数；卡体是时间线，脚本折叠", () => {
    const view = renderBlockDom(LOOP_TOOL_CALL);
    const card = view.getByTestId("workflow-card");

    expect(card.getAttribute("data-workflow-card-state")).toBe("static");
    expect(view.getByTestId("workflow-card-kind").textContent).toBe("Workflow");
    expect(view.getByTestId("workflow-card-name").textContent).toBe("Research pipeline");
    expect(view.getByTestId("workflow-card-static-status").textContent).toBe("compiled");
    expect(view.getByTestId("workflow-card-detail").textContent).toBe("2 phases · 2 agents");
    // Green is reserved for the awaiting-confirmation state: compiled is not a success-colored badge.
    expect(card.innerHTML).not.toContain("text-success");

    const stations = view.getAllByTestId("workflow-timeline-station");
    expect(stations.map((station) => station.textContent)).toEqual([
      expect.stringContaining("plan"),
      expect.stringContaining("verify"),
    ]);
    expect(view.getAllByTestId("workflow-agent-pill").map((pill) => pill.textContent)).toEqual([
      expect.stringContaining("planner"),
      expect.stringContaining("checker"),
    ]);
    // Adjacent edges are light-ink track segments; the back edge is an arc.
    expect(view.getByTestId("workflow-timeline-rail").getAttribute("data-rail-ink")).toBe("faint");
    const arc = view.getByTestId("workflow-timeline-arc");
    expect(arc.getAttribute("data-arc-from")).toBe("1");
    expect(arc.getAttribute("data-arc-to")).toBe("0");
    // Even the lowest lane's arc needs a decent drop: the vertical segment after the rounded corner points down and is
    // no shorter than the arrow (regression: a 16px lane height made the last segment climb one pixel upward, `marker-end`
    // followed suit, and the arrow disappeared).
    const d = arc.querySelector("path")!.getAttribute("d")!;
    const verticals = [...d.matchAll(/V(-?[\d.]+)/gu)].map((match) => Number(match[1]));
    const corner = Number(
      /Q[^ ]+ [^,]+,([\d.]+)$/u.exec(d.slice(0, d.lastIndexOf("V")).trimEnd())?.[1],
    );
    expect(verticals).toHaveLength(2);
    expect(verticals[1]! - corner).toBeGreaterThanOrEqual(8);
    // No sink, no "may terminate".
    expect(card.textContent).not.toContain("terminate");

    // The script source can only be read here: collapsed by default, entering the DOM only once expanded.
    expect(view.queryByTestId("code-block")).toBeNull();
    fireEvent.click(view.getByTestId("workflow-card-script-toggle"));
    expect(view.getByTestId("code-block").textContent).toContain('phase("plan")');
  });

  it("无标记脚本：一个隐式站「Workflow」，药丸是那条车道的作者原名", () => {
    const view = renderBlockDom({
      input: { script: "x" },
      raw: { display: { ...OK_DISPLAY, causalityGraph: FLAT_GRAPH } },
    });
    expect(view.getByTestId("workflow-timeline-station").textContent).toContain("Workflow");
    expect(view.getByTestId("workflow-agent-pill").textContent).toContain("a");
    expect(view.getByTestId("workflow-card-detail").textContent).toBe("1 phase · 1 agent");
  });

  it("没有图（或零 step 的图）时不画时间线，脚本折叠仍在", () => {
    const html = renderBlock({ input: { script: "const x = 1;" }, raw: { display: OK_DISPLAY } });
    expect(html).not.toContain("workflow-timeline");
    expect(html).toContain("workflow-card-script-toggle");
    expect(html).not.toContain("workflow-card-detail");

    const empty = renderBlock({
      input: { script: "x" },
      raw: {
        display: {
          ...OK_DISPLAY,
          causalityGraph: { steps: [], lanes: [], participants: [], handoffs: [] },
        },
      },
    });
    expect(empty).not.toContain("workflow-timeline");
  });

  it("联接不到 run 时没有页脚、没有 run 属性；回调在而 run 摘要不在时仍是静态卡", () => {
    const view = renderBlockDom(LOOP_TOOL_CALL, { onOpenWorkflowRun: () => {} });
    const card = view.getByTestId("workflow-card");
    expect(card.getAttribute("data-workflow-run-id")).toBeNull();
    expect(view.queryByTestId("workflow-card-footer")).toBeNull();
    expect(view.queryByTestId("workflow-card-status")).toBeNull();
    expect(html(view)).not.toContain("Workflow started");
  });

  it("站数超过一列时表头不再带秩带（看不见的站在时间线的边檐上）", () => {
    const phases = ["a", "b", "c", "d", "e", "f"].map((name, i) => ({
      id: `phase#${name}`,
      name,
      line: i + 1,
    }));
    const steps = phases.map((phase, i) => ({
      id: `ask#${i + 1}`,
      kind: "ask",
      label: phase.name,
      lane: "actor#1",
      phase: phase.id,
    }));
    const view = renderBlockDom({
      input: { script: "x" },
      raw: {
        display: {
          ...OK_DISPLAY,
          causalityGraph: {
            steps,
            lanes: [{ id: "actor#1", name: "worker" }],
            participants: steps.map((step) => ({
              id: `${step.phase}:actor#1`,
              phase: step.phase,
              lane: "actor#1",
              steps: [step.id],
            })),
            handoffs: [],
            phases,
            phaseEdges: phases.slice(1).map((phase, i) => ({ from: phases[i]!.id, to: phase.id })),
            exits: ["phase#f"],
          },
        },
      },
    });
    // The rank band is retired (addendum "edge ledge"): the invisible ones stand on the timeline's own ledge, and the header no longer repeats them.
    expect(view.queryByTestId("workflow-rank-strip")).toBeNull();
    expect(view.getAllByTestId("workflow-timeline-station")).toHaveLength(6);
  });

  it("shows the graph truncation note when steps were omitted", () => {
    const view = renderBlockDom({
      input: { script: "x" },
      raw: { display: { ...OK_DISPLAY, causalityGraph: { ...FLAT_GRAPH, truncated: true } } },
    });
    expect(view.container.textContent).toContain("some participants were omitted");
  });

  it("falls back to the plain output text when no display payload exists", () => {
    const markup = renderBlock({
      input: { script: "export const meta = {};" },
      output: { diagnostics: [], ok: true, response: "The workflow script compiled cleanly." },
      raw: {},
    });

    expect(markup).toContain("The workflow script compiled cleanly.");
    expect(markup).toContain("workflow-card-script-toggle");
    // Without display there should be no structured feedback card, no "compiled" word, and no pending-fix count.
    expect(markup).not.toContain("Compiler feedback");
    expect(markup).not.toContain("workflow-draft-lamp");
    expect(markup).not.toContain("workflow-card-static-status");
    expect(markup).not.toContain("&quot;ok&quot;");
  });

  it("does not crash and shows a hint when input.script is missing", () => {
    const markup = renderBlock({ input: { name: "No script here" }, raw: {} });
    expect(markup).toContain("No workflow script provided.");
    expect(markup).not.toContain("code-block");
  });

  it("saved 来源行在时间线之上", () => {
    const view = renderBlockDom({
      input: {
        name: "Fan-out review",
        script: "x",
        saved: {
          name: "fan-out-review",
          scope: "project",
          path: "/workspace/.zcode/workflows/fan-out-review.dwf.ts",
        },
      },
      raw: { display: { ...OK_DISPLAY, causalityGraph: FLAT_GRAPH } },
    });
    const savedLine = view.container.querySelector('[data-workflow-card-saved-source="true"]')!;
    expect(savedLine.textContent).toContain("fan-out-review");
    const body = view.getByTestId("workflow-card-body");
    const order = Array.from(body.children);
    expect(order.indexOf(savedLine as HTMLElement)).toBeLessThan(
      order.indexOf(view.getByTestId("workflow-timeline")),
    );
  });
});

function html(view: ReturnType<typeof render>): string {
  return view.container.innerHTML;
}

// ── Compile feedback (docs/dynamic-workflow/presentation.md, "Compiler feedback") ──
// Failing to compile is not a failure: nothing ran, and the feedback is handed back to the model. The row says this using
// only ToolLayout's existing slots, never destructive.
describe("CreateWorkflowToolCallBlock 编译反馈", () => {
  const FEEDBACK_DISPLAY = {
    kind: "create_workflow",
    ok: false,
    errorCount: 2,
    diagnostics: [
      { line: 3, column: 5, code: 2304, message: "Cannot find name 'agent'." },
      {
        line: 8,
        column: 1,
        code: 9003,
        message: "world.run's first argument must be a compile-time string literal.",
      },
    ],
  };
  const FEEDBACK_CALL: ToolCallOverrides = {
    input: { name: "Release notes digest", script: "const x: number = 'nope';" },
    output: { diagnostics: [], ok: false, response: "The workflow script has errors:" },
    raw: { display: FEEDBACK_DISPLAY },
  };
  const LATEST: WorkflowDraftPosition = { ordinal: 2, superseded: false };

  it("行：「Workflow draft」+ 名字 + 稿号 + 警示色空环灯 +「2 to fix · not run」；不是工作流卡", () => {
    const view = renderBlockDom(FEEDBACK_CALL, { workflowDraft: LATEST, forceOpen: false });
    const row = view.getByRole("button");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(row.querySelector(".tool-summary-kind-label")?.textContent).toBe("Workflow draft");
    expect(row.textContent).toContain("Release notes digest");
    expect(view.getByTestId("workflow-draft-ordinal").textContent).toBe("draft 2");
    expect(view.getByTestId("workflow-draft-status").textContent).toBe("2 to fix · not run");
    const lamp = view.getByTestId("workflow-draft-lamp");
    expect(lamp.getAttribute("data-draft-lamp")).toBe("open");
    expect(lamp.className).toContain("border-warning");
    expect(lamp.className).toContain("bg-transparent");
    // The lamp sits outside the underlined status word: the tooltip triggers on the word only.
    expect(view.getByTestId("workflow-draft-status").contains(lamp)).toBe(false);
    expect(row.innerHTML).not.toContain("destructive");
    expect(view.queryByTestId("workflow-card")).toBeNull();
    expect(view.queryByTestId("workflow-timeline")).toBeNull();
  });

  it("有更新的一稿：灯褪成中性，稿号与词不变", () => {
    const view = renderBlockDom(FEEDBACK_CALL, {
      workflowDraft: { ordinal: 1, superseded: true },
      forceOpen: false,
    });
    const lamp = view.getByTestId("workflow-draft-lamp");
    expect(lamp.getAttribute("data-draft-lamp")).toBe("settled");
    expect(lamp.className).toContain("border-foreground-subtlest");
    expect(lamp.className).not.toContain("border-warning");
    expect(view.getByTestId("workflow-draft-ordinal").textContent).toBe("draft 1");
    expect(view.getByTestId("workflow-draft-status").textContent).toBe("2 to fix · not run");
  });

  it("宿主没有稿号联接：不编号，灯保持警示色", () => {
    const view = renderBlockDom(FEEDBACK_CALL, { forceOpen: false });
    expect(view.queryByTestId("workflow-draft-ordinal")).toBeNull();
    expect(view.getByTestId("workflow-draft-lamp").getAttribute("data-draft-lamp")).toBe("open");
  });

  it("展开：脚本带行号、被点名的行号着色；反馈卡中性边框，标题 + 条数 + 一句话 + 逐条", () => {
    const view = renderBlockDom(FEEDBACK_CALL, { workflowDraft: LATEST, forceOpen: true });
    // After expanding, the draft number stays on the row (not hidden along with the expansion).
    expect(view.getByTestId("workflow-draft-ordinal").textContent).toBe("draft 2");
    const code = view.getByTestId("code-block");
    expect(code.getAttribute("data-show-line-numbers")).toBe("true");
    expect(code.getAttribute("data-marked-lines")).toBe("3,8");

    const card = view.getByTestId("workflow-compiler-feedback");
    expect(card.className).toContain("border-border");
    expect(card.outerHTML).not.toContain("destructive");
    expect(within(card).getByTestId("workflow-compiler-feedback-title").textContent).toBe(
      "Compiler feedback",
    );
    expect(within(card).getByTestId("workflow-compiler-feedback-count").textContent).toBe(
      "2 notes",
    );
    expect(within(card).getByTestId("workflow-compiler-feedback-lede").textContent).toBe(
      "Typecheck did not pass, so nothing ran. The feedback went back to the model to revise and resubmit.",
    );
    const lines = within(card).getAllByTestId("workflow-compiler-feedback-line");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.textContent).toContain("L3:C5");
    expect(lines[0]!.textContent).toContain("Cannot find name");
    expect(lines[0]!.textContent).toContain("TS2304");
    // The analyzer's own rules are not TypeScript codes.
    expect(lines[1]!.textContent).toContain("rule 9003");
    expect(lines[1]!.textContent).not.toContain("TS9003");
  });

  it("单条反馈用单数；条数读 errorCount 而不是截断后的行数", () => {
    const one = renderBlockDom(
      {
        ...FEEDBACK_CALL,
        raw: {
          display: {
            ...FEEDBACK_DISPLAY,
            errorCount: 1,
            diagnostics: [FEEDBACK_DISPLAY.diagnostics[0]],
          },
        },
      },
      { forceOpen: true },
    );
    expect(one.getByTestId("workflow-compiler-feedback-count").textContent).toBe("1 note");
    expect(one.getByTestId("workflow-draft-status").textContent).toBe("1 to fix · not run");
    cleanup();

    const many = renderBlockDom(
      {
        ...FEEDBACK_CALL,
        raw: { display: { ...FEEDBACK_DISPLAY, errorCount: 150, truncated: true } },
      },
      { forceOpen: true },
    );
    expect(many.getByTestId("workflow-compiler-feedback-count").textContent).toBe("150 notes");
    expect(many.container.textContent).toContain("Some diagnostics were omitted.");
  });

  it("保存的来源编不过：那句话点名文件，而不是这次调用", () => {
    const view = renderBlockDom(
      {
        ...FEEDBACK_CALL,
        input: {
          name: "Release notes digest",
          script: "const x: number = 'nope';",
          saved: {
            name: "release-notes",
            scope: "project",
            path: ".zcode/workflows/release-notes.ts",
          },
        },
      },
      { forceOpen: true },
    );
    expect(view.getByTestId("workflow-compiler-feedback-lede").textContent).toBe(
      "The saved workflow file did not pass typecheck, so nothing ran. The feedback went back to the model to fix the file or save a corrected version.",
    );
  });

  it("zh-CN：「工作流草稿 · 第 1 稿 · 2 处待修正 · 未运行」与「编译反馈 · 2 条 · 规则 9003」", () => {
    const view = renderBlockDom(
      FEEDBACK_CALL,
      { workflowDraft: { ordinal: 1, superseded: false }, forceOpen: true },
      "zh-CN",
    );
    expect(view.container.querySelector(".tool-summary-kind-label")?.textContent).toBe(
      "工作流草稿",
    );
    expect(view.getByTestId("workflow-draft-ordinal").textContent).toBe("第 1 稿");
    expect(view.getByTestId("workflow-draft-status").textContent).toBe("2 处待修正 · 未运行");
    expect(view.getByTestId("workflow-compiler-feedback-title").textContent).toBe("编译反馈");
    expect(view.getByTestId("workflow-compiler-feedback-count").textContent).toBe("2 条");
    expect(view.getByTestId("workflow-compiler-feedback-lede").textContent).toBe(
      "类型检查未通过，脚本未运行；反馈已交回模型，由它修改后重新提交。",
    );
    expect(view.container.textContent).toContain("规则 9003");
  });

  it("提示：先说那一句话，再逐条列出位置与消息", () => {
    expect(formatWorkflowFeedbackTooltip("Nothing ran.", FEEDBACK_DISPLAY.diagnostics)).toBe(
      "Nothing ran.\nL3:C5 Cannot find name 'agent'.\nL8:C1 world.run's first argument must be a compile-time string literal.",
    );
    expect(formatWorkflowFeedbackTooltip("Nothing ran.", [])).toBe("Nothing ran.");
  });

  it("失败但没有 display（被拒、工具报错）：仍是「Workflow」+ 工具状态词，没有灯与稿号", () => {
    const view = renderBlockDom(
      {
        input: { name: "Release notes digest", script: "x" },
        output: "run_not_found: no such run",
        status: "failed",
      },
      { statusLabel: "Failed", workflowDraft: LATEST, forceOpen: false },
    );
    expect(view.container.querySelector(".tool-summary-kind-label")?.textContent).toBe("Workflow");
    expect(view.container.textContent).toContain("Failed");
    expect(view.queryByTestId("workflow-draft-lamp")).toBeNull();
    expect(view.queryByTestId("workflow-draft-ordinal")).toBeNull();
  });

  it("编不过时即使宿主联接到了 run 也留在反馈行", () => {
    const markup = renderBlock(
      {
        input: { script: "x" },
        raw: {
          display: {
            kind: "create_workflow",
            ok: false,
            errorCount: 1,
            diagnostics: [{ line: 1, column: 1, code: 2304, message: "boom" }],
          },
        },
      },
      { workflowRun: joined() },
    );
    expect(markup).toContain("Compiler feedback");
    expect(markup).not.toContain('data-testid="workflow-card"');
    expect(markup).not.toContain("Workflow running");
  });
});

describe("CreateWorkflowToolCallBlock 启动前 ToolLayout", () => {
  const DRAFT =
    'phase("plan");\nconst planner = agent("planner");\nawait world.run("pnpm test");\nphase("ver';

  // The draft is typed out character by character by the pen (addendum "typewriter effect"): let the pen finish before
  // asserting the final form.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  // Each character the pen writes is a setState → effect that schedules the next timer; one advance moves one step, so
  // progress segment by segment using the step size.
  const settle = () => {
    for (let i = 0; i < 120; i += 1) {
      act(() => {
        vi.advanceTimersByTime(24);
      });
    }
  };

  it("编写中：行不可展开（forceOpen 也不展开），草稿阶段线常驻行下，站随笔写出、没有药丸", () => {
    const view = renderBlockDom(
      {
        input: { name: "Research pipeline", script: DRAFT },
        raw: { v4Status: "inputStreaming" },
        status: "running",
      },
      { isRunning: true, forceOpen: true },
    );
    expect(view.container.textContent).toContain("Writing workflow");
    expect(view.container.textContent).toContain("Research pipeline");
    expect(view.container.querySelector(".tool-summary-kind-label")).toBeTruthy();
    expect(view.container.querySelector("[aria-expanded]")).toBeNull();
    expect(view.queryByTestId("workflow-card")).toBeNull();
    expect(view.queryByTestId("code-block")).toBeNull();
    // The pen just landed: the first station is revealed but not one character written yet, the cursor holds steady
    // (writing); the second station is not on the track yet.
    expect(view.getByTestId("workflow-draft-timeline")).toBeTruthy();
    expect(view.getAllByTestId("workflow-timeline-station")).toHaveLength(1);
    expect(view.getByTestId("workflow-timeline-caret").getAttribute("data-pen")).toBe("writing");

    settle();
    const stations = view.getAllByTestId("workflow-timeline-station");
    expect(stations.map((station) => station.textContent)).toEqual(["plan", "ver"]);
    // The pen has caught up with the stream: the cursor blinks after the last station's name.
    const caret = view.getByTestId("workflow-timeline-caret");
    expect(stations[1]!.contains(caret)).toBe(true);
    expect(caret.getAttribute("data-pen")).toBe("idle");
    expect(caret.className).toContain("wf-caret");
    // The draft has only the phase line: no pills, no arcs; the phase line is not expandable content, and the row still
    // has no expansion affordance.
    expect(view.queryByTestId("workflow-agent-pill")).toBeNull();
    expect(view.queryByTestId("workflow-timeline-arc")).toBeNull();
    expect(view.container.querySelector("[aria-expanded]")).toBeNull();
  });

  it("display 一到，草稿站与光标离场：卡换成分析器的站与药丸（不变式 10）", () => {
    const view = renderBlockDom(
      {
        input: { name: "Research pipeline", script: DRAFT },
        raw: { v4Status: "inputStreaming" },
        status: "running",
      },
      { isRunning: true },
    );
    settle();
    expect(view.getAllByTestId("workflow-timeline-station")).toHaveLength(2);
    view.rerender(createBlock(LOOP_TOOL_CALL));
    expect(view.queryByTestId("workflow-draft-timeline")).toBeNull();
    expect(view.queryByTestId("workflow-timeline-caret")).toBeNull();
    const stations = view.getAllByTestId("workflow-timeline-station");
    expect(stations.map((station) => station.textContent)).toEqual([
      expect.stringContaining("plan"),
      expect.stringContaining("verify"),
    ]);
    expect(view.getAllByTestId("workflow-agent-pill")).toHaveLength(2);
    expect(view.getByTestId("workflow-timeline-arc")).toBeTruthy();
  });

  it("编写中脚本还没到一个字：只有行，没有阶段线块", () => {
    const view = renderBlockDom(
      {
        input: { name: "Research pipeline" },
        raw: { v4Status: "inputStreaming" },
        status: "running",
      },
      { isRunning: true },
    );
    expect(view.container.textContent).toContain("Writing workflow");
    expect(view.queryByTestId("workflow-draft-timeline")).toBeNull();
    expect(view.queryByTestId("workflow-timeline-station")).toBeNull();
  });

  it.each(["en-US", "zh-CN"] as const)("等待确认可展开脚本、再次收起：%s", (locale) => {
    const view = renderBlockDom(
      {
        ...LOOP_TOOL_CALL,
        raw: { ...(LOOP_TOOL_CALL.raw as object), v4Status: "pendingApproval" },
        status: "running",
      },
      { isRunning: true, forceOpen: false },
      locale,
    );
    expect(view.container.querySelector(".tool-summary-kind-label")).toBeTruthy();
    expect(
      view.container.querySelector(".tool-summary-kind-label.animated-gradient-text"),
    ).toBeTruthy();
    expect(view.container.querySelector(".truncate.font-mono")).toBeNull();
    expect(view.queryByTestId("workflow-card")).toBeNull();
    const trigger = view.getByRole("button");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(view.queryByTestId("code-block")).toBeNull();
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(view.getByTestId("code-block").textContent).toContain("agent");
    expect(view.getByTestId("code-block").className).toContain("max-h-80");
    expect(view.getByTestId("workflow-script-codeblock").className).not.toContain("overflow-auto");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});

// ── Joined to a run: the graph stays entirely in the chat area; lamp, pills, and ink follow the projection ──
describe("CreateWorkflowToolCallBlock 运行态", () => {
  it("表头：种类词「Workflow running」、灯 + 状态词、步数细节；没有紧凑卡", () => {
    const view = renderBlockDom(LOOP_TOOL_CALL, { workflowRun: joined() });
    const card = view.getByTestId("workflow-card");

    expect(card.getAttribute("data-workflow-card-state")).toBe("running");
    expect(card.getAttribute("data-workflow-run-id")).toBe("dwfrun-42");
    expect(view.getByTestId("workflow-card-kind").textContent).toBe("Workflow running");
    expect(view.getByTestId("workflow-card-status").textContent).toBe("Running");
    expect(view.getByTestId("workflow-card-detail").textContent).toBe("2 phases · 1 agent working");
    expect(view.queryByTestId("workflow-run-card")).toBeNull();
    expect(view.queryByTestId("workflow-card-static-status")).toBeNull();
  });

  it("站与药丸读投影：站灯、运行时名、状态标记；行进边是进入运行站的那一段", () => {
    const view = renderBlockDom(LOOP_TOOL_CALL, { workflowRun: joined() });

    const stations = view.getAllByTestId("workflow-timeline-station");
    expect(stations.map((station) => station.getAttribute("data-station-status"))).toEqual([
      "done",
      "running",
    ]);
    expect(stations[0]!.textContent).toContain("1/1");
    const pills = view.getAllByTestId("workflow-agent-pill");
    expect(pills.map((pill) => pill.textContent)).toEqual([
      expect.stringContaining("Ada"),
      expect.stringContaining("Bob"),
    ]);
    expect(pills.map((pill) => pill.getAttribute("data-agent-status"))).toEqual([
      "done",
      "running",
    ]);
    // Status is not color alone: the marker carries readable text.
    expect(
      pills[1]!.querySelector('[data-testid="workflow-pill-status"]')?.getAttribute("aria-label"),
    ).toBe("running");
    expect(view.getByTestId("workflow-timeline-rail").getAttribute("data-rail-ink")).toBe("march");
    expect(view.getByTestId("workflow-timeline-arc").getAttribute("data-arc-ink")).toBe("faint");
  });

  it("running 同时有动画点和状态词，绝不只靠颜色或动画表达状态", () => {
    const view = renderBlockDom(LOOP_TOOL_CALL, { workflowRun: joined() });
    const header = view.getByTestId("workflow-card-header");
    expect(header.querySelector(".animate-pulse")).toBeTruthy();
    expect(header.textContent).toContain("Running");
  });

  it("运行态没有页脚：卡上只说阶段与子代理，都在表头；步数、token、轮次不上卡（2026-09-09）", () => {
    const view = renderBlockDom(LOOP_TOOL_CALL, { workflowRun: joined() });
    expect(view.queryByTestId("workflow-card-footer")).toBeNull();
    const card = view.getByTestId("workflow-card").textContent ?? "";
    expect(view.getByTestId("workflow-card-detail").textContent).toBe("2 phases · 1 agent working");
    expect(card).not.toContain("steps");
    expect(card).not.toContain("tokens");
    expect(view.container.querySelector("progress")).toBeNull();
  });

  it("第二轮：回边浓墨并成为行进边，站头显示 ⟳ 2；表头不数轮次，仍只说阶段与子代理", () => {
    const view = renderBlockDom(LOOP_TOOL_CALL, {
      workflowRun: joined({
        actors: [
          { siteId: "actor#1", ordinal: 2, name: "Ada", sessionId: "s-1b", status: "running" },
          { siteId: "actor#2", ordinal: 1, name: "Bob", sessionId: "s-2", status: "completed" },
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
          {
            siteId: "ask#2",
            ordinal: 1,
            phase: "settled",
            outcome: "ok",
            actorSiteId: "actor#2",
            actorOrdinal: 1,
          },
          {
            siteId: "ask#1",
            ordinal: 2,
            phase: "executing",
            actorSiteId: "actor#1",
            actorOrdinal: 2,
          },
        ] as WorkflowRunState["nodes"],
      }),
    });
    expect(view.getByTestId("workflow-timeline-arc").getAttribute("data-arc-ink")).toBe("march");
    expect(view.getByTestId("workflow-timeline-rail").getAttribute("data-rail-ink")).toBe("strong");
    const rounds = view.getAllByTestId("workflow-timeline-rounds");
    expect(rounds[0]!.textContent).toContain("2");
    expect(view.getByTestId("workflow-card-detail").textContent).toBe("2 phases · 1 agent working");
    expect(view.queryByTestId("workflow-card-footer")).toBeNull();
  });

  it("已完成：墨迹 = 轨迹，表头换成终态计数（阶段数 · 子代理数）；没有页脚", () => {
    const onOpenWorkflowArtifact = vi.fn();
    const view = renderBlockDom(LOOP_TOOL_CALL, {
      onOpenWorkflowArtifact,
      workflowRun: joined({
        status: "completed",
        actors: [
          { siteId: "actor#1", ordinal: 1, name: "Ada", sessionId: "s-1", status: "completed" },
          { siteId: "actor#2", ordinal: 1, name: "Bob", sessionId: "s-2", status: "completed" },
        ],
        nodes: [
          { siteId: "ask#1", ordinal: 1, phase: "settled", outcome: "ok" },
          { siteId: "ask#2", ordinal: 1, phase: "settled", outcome: "ok" },
        ] as WorkflowRunState["nodes"],
        reports: [
          { id: "r1", kind: "text", title: "Summary", text: "done" },
        ] as WorkflowRunState["reports"],
        artifacts: [
          { id: "book", kind: "file", title: "Audit report", version: 2 },
        ] as WorkflowRunState["artifacts"],
      }),
    });
    expect(view.getByTestId("workflow-card-kind").textContent).toBe("Workflow completed");
    expect(view.getByTestId("workflow-card-status").textContent).toBe("Completed");
    expect(view.getByTestId("workflow-timeline-rail").getAttribute("data-rail-ink")).toBe("strong");
    expect(view.getByTestId("workflow-timeline-arc").getAttribute("data-arc-ink")).toBe("faint");
    expect(view.getByTestId("workflow-card-header").querySelector(".animate-pulse")).toBeNull();
    expect(view.queryByTestId("workflow-card-footer")).toBeNull();
    expect(view.getByTestId("workflow-card-detail").textContent).toBe("2 phases · 2 agents");
    const card = view.getByTestId("workflow-card").textContent ?? "";
    expect(card).not.toContain("steps");
    expect(card).not.toContain("tokens");
    // Artifacts appear only on the artifact strip (no more "1 artifact" count); "results" still has no place on screen.
    expect(card).not.toContain("artifact");
    expect(card).not.toContain("result");
    expect(card).not.toContain("working");
    // The artifact strip hangs below the timeline: one clickable pill, with v2 in the tail slot.
    const strip = view.getByTestId("workflow-card-artifacts");
    const pills = within(strip).getAllByTestId("workflow-card-artifact");
    expect(pills).toHaveLength(1);
    expect(pills[0]?.tagName).toBe("BUTTON");
    expect(pills[0]?.getAttribute("data-artifact-open")).toBe("true");
    expect(within(strip).getByTestId("workflow-run-artifact-version").textContent).toBe("v2");
    fireEvent.click(pills[0]!);
    expect(onOpenWorkflowArtifact).toHaveBeenCalledWith("book");
  });

  it("宿主没注入产物打开能力时药丸禁用，产物条仍在场", () => {
    const view = renderBlockDom(LOOP_TOOL_CALL, {
      workflowRun: joined({
        status: "completed",
        artifacts: [
          { id: "book", kind: "file", title: "Audit report", version: 1 },
        ] as WorkflowRunState["artifacts"],
      }),
    });
    const pill = view.getByTestId("workflow-card-artifact") as HTMLButtonElement;
    expect(pill.disabled).toBe(true);
    expect(pill.getAttribute("data-artifact-open")).toBeNull();
    expect(view.queryByTestId("workflow-run-artifact-version")).toBeNull();
  });

  it("⤢ 打开详情页：只在宿主给了回调时在场，请求带展示名；点站头走同一条路", () => {
    const onOpenWorkflowRun = vi.fn();
    const view = renderBlockDom(LOOP_TOOL_CALL, { onOpenWorkflowRun, workflowRun: joined() });
    fireEvent.click(view.getByTestId("workflow-card-open-details"));
    expect(onOpenWorkflowRun).toHaveBeenCalledWith({ workflowName: "Research pipeline" });

    fireEvent.click(view.getAllByTestId("workflow-timeline-station")[1]!.querySelector("button")!);
    expect(onOpenWorkflowRun).toHaveBeenCalledTimes(2);

    cleanup();
    // Without a callback the station header is not a control (a span, not a disabled button): a disabled button swallows
    // clicks, and the turn-tail summary's whole-block toggle would never receive them (addendum "click syntax revision").
    const gated = renderBlockDom(LOOP_TOOL_CALL, { workflowRun: joined() });
    expect(gated.queryByTestId("workflow-card-open-details")).toBeNull();
    const station = gated.getAllByTestId("workflow-timeline-station")[0]!;
    expect(station.querySelector("button")).toBeNull();
    expect(station.querySelector('[data-testid="workflow-timeline-station-head"]')).not.toBeNull();
  });

  it("展示名缺席时请求里不带 workflowName", () => {
    const onOpenWorkflowRun = vi.fn();
    const view = renderBlockDom(
      { ...LOOP_TOOL_CALL, input: { script: "x" } },
      { onOpenWorkflowRun, workflowRun: joined() },
    );
    expect(view.getByTestId("workflow-card-name").textContent).toBe("Workflow script");
    fireEvent.click(view.getByTestId("workflow-card-open-details"));
    expect(onOpenWorkflowRun).toHaveBeenCalledWith({});
  });

  it("运行中折叠：卡体与页脚都收起；表头的灯与细节仍然在场", () => {
    const view = renderBlockDom(LOOP_TOOL_CALL, {
      forceOpen: false,
      canToggle: true,
      workflowRun: joined(),
    });
    expect(view.getByTestId("workflow-card-body")).toBeTruthy();
    fireEvent.click(view.getByTestId("workflow-card-toggle"));
    expect(view.queryByTestId("workflow-card-body")).toBeNull();
    expect(view.queryByTestId("workflow-card-footer")).toBeNull();
    expect(view.getByTestId("workflow-card-status").textContent).toBe("Running");
    expect(view.getByTestId("workflow-card-detail").textContent).toBe("2 phases · 1 agent working");
    fireEvent.click(view.getByTestId("workflow-card-toggle"));
    expect(view.getByTestId("workflow-card-body")).toBeTruthy();
  });

  it("forceOpen / canToggle=false 时没有折叠按钮", () => {
    const view = renderBlockDom(LOOP_TOOL_CALL, { workflowRun: joined() });
    expect(view.queryByTestId("workflow-card-toggle")).toBeNull();
    cleanup();
    const locked = renderBlockDom(LOOP_TOOL_CALL, {
      forceOpen: false,
      canToggle: false,
      workflowRun: joined(),
    });
    expect(locked.queryByTestId("workflow-card-toggle")).toBeNull();
    expect(locked.getByTestId("workflow-card-body")).toBeTruthy();
  });

  it("联接到 run 后脚本折叠离开卡面：脚本原文去详情页的 Script 区读", () => {
    const view = renderBlockDom(LOOP_TOOL_CALL, { workflowRun: joined() });
    expect(view.queryByTestId("workflow-card-script-toggle")).toBeNull();
    expect(view.queryByTestId("code-block")).toBeNull();
  });

  it("卡后面仍然挂着快照字段提示", () => {
    const view = renderBlockDom(
      {
        ...LOOP_TOOL_CALL,
        snapshotRefs: [{ field: "input", previewBytes: 100, fullBytes: 5_000 }],
      },
      { onLoadFullToolCallFields: () => {}, workflowRun: joined() },
    );
    expect(view.getByTestId("workflow-card")).toBeTruthy();
    expect(view.container.textContent).toContain("Load full tool data");
  });

  it("zh-CN 下卡面全部本地化", () => {
    const view = renderBlockDom(LOOP_TOOL_CALL, { workflowRun: joined() }, "zh-CN");
    const card = view.getByTestId("workflow-card");
    expect(view.getByTestId("workflow-card-kind").textContent).toBe("工作流运行中");
    expect(view.getByTestId("workflow-card-status").textContent).toBe("运行中");
    expect(card.textContent).toContain("2 个阶段 · 1 个子代理工作中");
    expect(card.textContent).toContain("1 个子代理工作中");
    expect(card.textContent).not.toContain("Workflow running");
    expect(card.textContent).not.toContain("steps");
  });
});

// ── Pill → subagent transcript (docs/dynamic-workflow/presentation.md, "The pill") ──
describe("CreateWorkflowToolCallBlock 药丸点击", () => {
  it("带会话的药丸是按钮：点一下交出实例身份（run、会话、站点、序号、运行时名）", () => {
    const onOpenWorkflowActor = vi.fn();
    const view = renderBlockDom(LOOP_TOOL_CALL, { onOpenWorkflowActor, workflowRun: joined() });

    const pills = view.getAllByTestId("workflow-agent-pill");
    expect(pills.map((pill) => pill.tagName)).toEqual(["BUTTON", "BUTTON"]);
    expect(pills[1]!.getAttribute("aria-label")).toBe("Open the transcript of Bob");
    // The presence of ↗ is the visible evidence of "openable"; the hover affordance hangs on wf-pill-open.
    expect(view.getAllByTestId("workflow-timeline-pill-open")).toHaveLength(2);
    expect(pills[1]!.className).toContain("wf-pill-open");

    fireEvent.click(pills[1]!);
    expect(onOpenWorkflowActor).toHaveBeenCalledWith({
      runId: "dwfrun-42",
      actorSessionId: "s-2",
      siteId: "actor#2",
      ordinal: 1,
      actorName: "Bob",
    });
  });

  it("能力门控：没有回调、或没有 run 时药丸不是按钮；活的 run 里没有会话的药丸也是按钮", () => {
    const noCallback = renderBlockDom(LOOP_TOOL_CALL, { workflowRun: joined() });
    expect(
      noCallback.getAllByTestId("workflow-agent-pill").every((pill) => pill.tagName === "SPAN"),
    ).toBe(true);
    expect(noCallback.queryByTestId("workflow-timeline-pill-open")).toBeNull();
    cleanup();

    // A subagent that has not started yet (addendum "click syntax revision"): the same hover and click as a live pill,
    // handing over the slot — lane + future ordinal — without a session id; the host opens a placeholder tab.
    const onOpenWorkflowActor = vi.fn();
    const noSession = renderBlockDom(LOOP_TOOL_CALL, {
      onOpenWorkflowActor,
      workflowRun: joined({
        actors: [
          { siteId: "actor#1", ordinal: 1, name: "Ada", sessionId: "s-1", status: "completed" },
        ],
      }),
    });
    const pills = noSession.getAllByTestId("workflow-agent-pill");
    expect(pills.map((pill) => pill.tagName)).toEqual(["BUTTON", "BUTTON"]);
    expect(pills[1]!.className).toContain("wf-pill-open");
    expect(pills[1]!.getAttribute("aria-label")).toBe("Open the transcript of checker");
    fireEvent.click(pills[1]!);
    expect(onOpenWorkflowActor).toHaveBeenCalledWith({
      runId: "dwfrun-42",
      siteId: "actor#2",
      ordinal: 1,
      actorName: "checker",
    });
    cleanup();

    const static_ = renderBlockDom(LOOP_TOOL_CALL, { onOpenWorkflowActor });
    expect(
      static_.getAllByTestId("workflow-agent-pill").every((pill) => pill.tagName === "SPAN"),
    ).toBe(true);
    expect(static_.getAllByTestId("workflow-agent-pill")[0]!.getAttribute("title")).toBe("planner");
  });

  it("点药丸不触发站头（各自的路径互不串线）", () => {
    const onOpenWorkflowActor = vi.fn();
    const onOpenWorkflowRun = vi.fn();
    const view = renderBlockDom(LOOP_TOOL_CALL, {
      onOpenWorkflowActor,
      onOpenWorkflowRun,
      workflowRun: joined(),
    });
    fireEvent.click(view.getAllByTestId("workflow-agent-pill")[0]!);
    expect(onOpenWorkflowActor).toHaveBeenCalledTimes(1);
    expect(onOpenWorkflowRun).not.toHaveBeenCalled();
  });
});

// Script pill (docs/dynamic-workflow/transcript-and-notifications.md, "Opening the tab"): the same open syntax as the
// subagent pill, but it hands over the station's phase id rather than a slot — a script transcript exists once per run,
// so the target is keyed by station.
describe("CreateWorkflowToolCallBlock 脚本药丸", () => {
  const WORKSPACE_GRAPH = {
    ...LOOP_GRAPH,
    steps: [
      ...LOOP_GRAPH.steps,
      {
        id: "world-read#1",
        kind: "world-read",
        label: "run tests",
        line: 6,
        column: 3,
        lane: "workspace",
        phase: "phase#b",
      },
    ],
    lanes: [...LOOP_GRAPH.lanes, { id: "workspace" }],
    participants: [
      ...LOOP_GRAPH.participants,
      { id: "phase#b:workspace", phase: "phase#b", lane: "workspace", steps: ["world-read#1"] },
    ],
  };
  const WORKSPACE_TOOL_CALL: ToolCallOverrides = {
    ...LOOP_TOOL_CALL,
    raw: { display: { ...OK_DISPLAY, causalityGraph: WORKSPACE_GRAPH } },
  };
  const workspacePill = (view: ReturnType<typeof renderBlockDom>) =>
    view
      .getAllByTestId("workflow-agent-pill")
      .find((pill) => pill.textContent?.includes("Script"))!;

  it("活的 run 里脚本药丸是按钮：点一下交出这一站的阶段 id 与展示名", () => {
    const onOpenWorkflowWorkspace = vi.fn();
    const onOpenWorkflowActor = vi.fn();
    const view = renderBlockDom(WORKSPACE_TOOL_CALL, {
      onOpenWorkflowWorkspace,
      onOpenWorkflowActor,
      workflowRun: joined(),
    });
    const pill = workspacePill(view);
    expect(pill.tagName).toBe("BUTTON");
    expect(pill.className).toContain("wf-pill-open");
    expect(pill.getAttribute("aria-label")).toBe("Open the script's steps at verify");
    expect(view.getAllByTestId("workflow-timeline-workspace-open")).toHaveLength(1);
    fireEvent.click(pill);
    expect(onOpenWorkflowWorkspace).toHaveBeenCalledWith({
      phaseId: "phase#b",
      workflowName: "Research pipeline",
    });
    // Never crosses wires with the subagent path.
    expect(onOpenWorkflowActor).not.toHaveBeenCalled();
  });

  it("能力门控：没有回调、或没有 run 时脚本药丸是 span；子代理回调在场也不借用", () => {
    const noCallback = renderBlockDom(WORKSPACE_TOOL_CALL, {
      onOpenWorkflowActor: vi.fn(),
      workflowRun: joined(),
    });
    expect(workspacePill(noCallback).tagName).toBe("SPAN");
    expect(noCallback.queryByTestId("workflow-timeline-workspace-open")).toBeNull();
    cleanup();

    const noRun = renderBlockDom(WORKSPACE_TOOL_CALL, { onOpenWorkflowWorkspace: vi.fn() });
    expect(workspacePill(noRun).tagName).toBe("SPAN");
    expect(noRun.queryByTestId("workflow-timeline-workspace-open")).toBeNull();
  });
});

describe("CreateWorkflowToolCallBlock 失败态与 Resume", () => {
  const failed = () =>
    joined(
      {
        status: "errored",
        error: { code: "actor_failed", message: "boom" } as WorkflowRunState["error"],
        actors: [
          { siteId: "actor#1", ordinal: 1, name: "Ada", sessionId: "s-1", status: "completed" },
          { siteId: "actor#2", ordinal: 1, name: "Bob", sessionId: "s-2", status: "completed" },
        ],
        nodes: [
          { siteId: "ask#1", ordinal: 1, phase: "settled", outcome: "ok" },
          { siteId: "ask#2", ordinal: 1, phase: "settled", outcome: "failed" },
        ] as WorkflowRunState["nodes"],
      },
      { resumable: true },
    );

  it("出错：表头「Workflow errored」，失败的站与药丸带失败标记，页脚有 Resume", () => {
    const onResumeWorkflowRun = vi.fn();
    const view = renderBlockDom(LOOP_TOOL_CALL, { onResumeWorkflowRun, workflowRun: failed() });
    expect(view.getByTestId("workflow-card-kind").textContent).toBe("Workflow errored");
    expect(view.getByTestId("workflow-card-status").textContent).toBe("Errored");
    expect(
      view.getAllByTestId("workflow-timeline-station")[1]!.getAttribute("data-station-status"),
    ).toBe("failed");
    expect(view.getAllByTestId("workflow-agent-pill")[1]!.getAttribute("data-agent-status")).toBe(
      "failed",
    );

    const resume = view.getByTestId("workflow-card-resume");
    expect(view.getByTestId("workflow-card-footer").contains(resume)).toBe(true);
    fireEvent.click(resume);
    expect(onResumeWorkflowRun).toHaveBeenCalledWith({ workflowName: "Research pipeline" });
  });

  it("Resume 是能力门控：没有回调、或摘要不说可恢复，都没有按钮", () => {
    const noCallback = renderBlockDom(LOOP_TOOL_CALL, { workflowRun: failed() });
    expect(noCallback.queryByTestId("workflow-card-resume")).toBeNull();
    cleanup();
    const { resumable: _off, ...notResumable } = failed();
    const notOffered = renderBlockDom(LOOP_TOOL_CALL, {
      onResumeWorkflowRun: vi.fn(),
      workflowRun: notResumable,
    });
    expect(notOffered.queryByTestId("workflow-card-resume")).toBeNull();
    cleanup();
    const running = renderBlockDom(LOOP_TOOL_CALL, {
      onResumeWorkflowRun: vi.fn(),
      workflowRun: joined(),
    });
    expect(running.queryByTestId("workflow-card-resume")).toBeNull();
  });

  it("折叠的失败卡仍然留下页脚：Resume 必须够得着", () => {
    const view = renderBlockDom(LOOP_TOOL_CALL, {
      canToggle: true,
      forceOpen: false,
      onResumeWorkflowRun: vi.fn(),
      workflowRun: failed(),
    });
    fireEvent.click(view.getByTestId("workflow-card-toggle"));
    expect(view.queryByTestId("workflow-card-body")).toBeNull();
    expect(view.getByTestId("workflow-card-resume")).toBeTruthy();
  });

  it("停止：种类词「Workflow stopped」+ 原因词，联接摘要标 resumable 时同样有 Resume", () => {
    const view = renderBlockDom(LOOP_TOOL_CALL, {
      onResumeWorkflowRun: vi.fn(),
      workflowRun: joined({ status: "stopped", stopReason: "user" }, { resumable: true }),
    });
    expect(view.getByTestId("workflow-card-kind").textContent).toBe("Workflow stopped");
    expect(view.getByTestId("workflow-card-status-reason").textContent).toContain("by you");
    // The third word of the status line: a stopped run can still continue. After the verb changed from "cancel" to "stop",
    // the consequence is stated here.
    expect(view.getByTestId("workflow-card-status-resumable").textContent).toContain("resumable");
    expect(view.getByTestId("workflow-card-resume")).toBeTruthy();
  });

  it("摘要不带 resumable 时状态行没有第三个词（UI 绝不按 status 推导）", () => {
    const view = renderBlockDom(LOOP_TOOL_CALL, {
      workflowRun: joined({ status: "stopped", stopReason: "user" }),
    });
    expect(view.getByTestId("workflow-card-status-reason").textContent).toContain("by you");
    expect(view.queryByTestId("workflow-card-status-resumable")).toBeNull();
  });
});

// ── Phase-aware kind copy ──
// ToolLayout renders statusLabel only in the failed state, so in non-failed states kindLabel is the only text on the card
// saying "what is happening"; and "validating" is true only in the running phase (the script was already analyzed in
// prepareApproval before the dialog). The phase reader hangs off the v4 raw status attached to raw; both layers are
// pinned: the pure function and the sentence actually rendered.
describe("readWorkflowKindMessageId", () => {
  it("终态一律是「工作流」，不看 v4 状态", () => {
    expect(readWorkflowKindMessageId({ v4Status: "success" }, false)).toBe(
      "chat.toolCall.workflow.ran",
    );
    expect(readWorkflowKindMessageId({ v4Status: "inputStreaming" }, false)).toBe(
      "chat.toolCall.workflow.ran",
    );
    expect(readWorkflowKindMessageId(undefined, false)).toBe("chat.toolCall.workflow.ran");
  });

  it("inputStreaming 是「正在编写」——模型还在写脚本，没人在校验", () => {
    expect(readWorkflowKindMessageId({ v4Status: "inputStreaming" }, true)).toBe(
      "chat.toolCall.workflow.writing",
    );
  });

  it("pendingApproval 是「待确认」——球在用户手上", () => {
    expect(readWorkflowKindMessageId({ v4Status: "pendingApproval" }, true)).toBe(
      "chat.toolCall.workflow.awaitingConfirmation",
    );
  });

  it("running 相才是「正在校验」，语义收窄到这一相", () => {
    expect(readWorkflowKindMessageId({ v4Status: "running" }, true)).toBe(
      "chat.toolCall.workflow.running",
    );
  });

  it("v4Status 缺席（非 v4 宿主 / 老快照）时逐字保持今天的行为", () => {
    // The new phase applies only with an authoritative status; without one there is no guessing — fall back to isRunning → validating.
    expect(readWorkflowKindMessageId(undefined, true)).toBe("chat.toolCall.workflow.running");
    expect(readWorkflowKindMessageId({}, true)).toBe("chat.toolCall.workflow.running");
    expect(readWorkflowKindMessageId({ display: OK_DISPLAY }, true)).toBe(
      "chat.toolCall.workflow.running",
    );
    // A raw that is not a plain object (array / string / null) falls back the same way, without crashing.
    expect(readWorkflowKindMessageId([], true)).toBe("chat.toolCall.workflow.running");
    expect(readWorkflowKindMessageId("running", true)).toBe("chat.toolCall.workflow.running");
    expect(readWorkflowKindMessageId(null, true)).toBe("chat.toolCall.workflow.running");
    // An unrecognized status string takes the same fallback.
    expect(readWorkflowKindMessageId({ v4Status: "queued" }, true)).toBe(
      "chat.toolCall.workflow.running",
    );
  });
});

describe("CreateWorkflowToolCallBlock kind 文案分相", () => {
  const IN_FLIGHT_INPUT = { name: "Fan-out review", script: "const x = 1;" };

  it("inputStreaming：卡上写「正在编写工作流」，不写校验", () => {
    const html = renderBlock(
      { input: IN_FLIGHT_INPUT, raw: { v4Status: "inputStreaming" }, status: "running" },
      { isRunning: true },
    );

    expect(html).toContain("Writing workflow");
    expect(html).not.toContain("Validating workflow");
  });

  it("pendingApproval：卡上写「工作流待确认」", () => {
    const html = renderBlock(
      { input: IN_FLIGHT_INPUT, raw: { v4Status: "pendingApproval" }, status: "running" },
      { isRunning: true },
    );

    expect(html).toContain("Awaiting workflow confirmation");
    expect(html).not.toContain("Validating workflow");
  });

  it("running：仍然是「正在校验工作流」", () => {
    const html = renderBlock(
      { input: IN_FLIGHT_INPUT, raw: { v4Status: "running" }, status: "running" },
      { isRunning: true },
    );

    expect(html).toContain("Validating workflow");
    expect(html).not.toContain("Writing workflow");
  });

  it("v4Status 缺席时卡面逐字保持今天的行为", () => {
    const html = renderBlock(
      { input: IN_FLIGHT_INPUT, raw: {}, status: "running" },
      { isRunning: true },
    );

    expect(html).toContain("Validating workflow");
    expect(html).not.toContain("Writing workflow");
    expect(html).not.toContain("Awaiting workflow confirmation");
  });

  it("终态不带任何相位词：只写「工作流」", () => {
    const html = renderBlock({
      input: IN_FLIGHT_INPUT,
      raw: { display: OK_DISPLAY, v4Status: "success" },
    });

    expect(html).not.toContain("Writing workflow");
    expect(html).not.toContain("Awaiting workflow confirmation");
    expect(html).not.toContain("Validating workflow");
  });

  it("zh-CN 下相位文案同样本地化", () => {
    const writing = renderBlock(
      { input: IN_FLIGHT_INPUT, raw: { v4Status: "inputStreaming" }, status: "running" },
      { isRunning: true },
      "zh-CN",
    );
    expect(writing).toContain("正在编写工作流");
    expect(writing).not.toContain("正在校验工作流");

    const awaiting = renderBlock(
      { input: IN_FLIGHT_INPUT, raw: { v4Status: "pendingApproval" }, status: "running" },
      { isRunning: true },
      "zh-CN",
    );
    expect(awaiting).toContain("工作流待确认");

    const validating = renderBlock(
      { input: IN_FLIGHT_INPUT, raw: { v4Status: "running" }, status: "running" },
      { isRunning: true },
      "zh-CN",
    );
    expect(validating).toContain("正在校验工作流");
  });

  it("第 2 稿起编写中的种类词是「Revising workflow」、细节槽带稿号；第 1 稿照旧不编号", () => {
    const revising = renderBlockDom(
      { input: IN_FLIGHT_INPUT, raw: { v4Status: "inputStreaming" }, status: "running" },
      { isRunning: true, workflowDraft: { ordinal: 2, superseded: false } },
    );
    expect(revising.container.textContent).toContain("Revising workflow");
    expect(revising.container.textContent).not.toContain("Writing workflow");
    expect(revising.getByTestId("workflow-draft-ordinal").textContent).toBe("draft 2");
    expect(revising.queryByTestId("workflow-draft-lamp")).toBeNull();
    cleanup();

    const first = renderBlockDom(
      { input: IN_FLIGHT_INPUT, raw: { v4Status: "inputStreaming" }, status: "running" },
      { isRunning: true, workflowDraft: { ordinal: 1, superseded: false } },
    );
    expect(first.container.textContent).toContain("Writing workflow");
    expect(first.queryByTestId("workflow-draft-ordinal")).toBeNull();
  });

  it("待确认与校验中：第 2 稿起同样带稿号，种类词不变", () => {
    const awaiting = renderBlockDom(
      { input: IN_FLIGHT_INPUT, raw: { v4Status: "pendingApproval" }, status: "running" },
      { isRunning: true, workflowDraft: { ordinal: 2, superseded: false } },
    );
    expect(awaiting.container.textContent).toContain("Awaiting workflow confirmation");
    expect(awaiting.getByTestId("workflow-draft-ordinal").textContent).toBe("draft 2");
    cleanup();

    const validating = renderBlockDom(
      { input: IN_FLIGHT_INPUT, raw: { v4Status: "running" }, status: "running" },
      { isRunning: true, workflowDraft: { ordinal: 3, superseded: false } },
    );
    expect(validating.getByTestId("workflow-card-kind").textContent).toBe("Validating workflow");
    expect(validating.getByTestId("workflow-card-detail").textContent).toBe("draft 3");
    cleanup();

    // A compiled, not-yet-started static card is not an in-flight row: no draft number.
    const settled = renderBlockDom(LOOP_TOOL_CALL, {
      workflowDraft: { ordinal: 2, superseded: false },
    });
    expect(settled.getByTestId("workflow-card-detail").textContent).not.toContain("draft");
  });

  it("zh-CN：第 2 稿起写「正在修改工作流」与「第 2 稿」", () => {
    const view = renderBlockDom(
      { input: IN_FLIGHT_INPUT, raw: { v4Status: "inputStreaming" }, status: "running" },
      { isRunning: true, workflowDraft: { ordinal: 2, superseded: false } },
      "zh-CN",
    );
    expect(view.container.textContent).toContain("正在修改工作流");
    expect(view.getByTestId("workflow-draft-ordinal").textContent).toBe("第 2 稿");
  });

  it("编译反馈的新 key 在两种语言里都存在且已翻译；旧的错误计数与「诊断」键退场", () => {
    for (const key of [
      "chat.toolCall.workflow.draft",
      "chat.toolCall.workflow.amend.draft",
      "chat.toolCall.workflow.revising",
      "chat.toolCall.workflow.amend.revising",
      "chat.toolCall.workflow.draftOrdinal",
      "chat.toolCall.workflow.toFix",
      "chat.toolCall.workflow.notRun",
      "chat.toolCall.workflow.feedback",
      "chat.toolCall.workflow.feedback.lede",
      "chat.toolCall.workflow.feedback.lede.saved",
      // The fork plural family keys: count/countOne were merged into feedback.count.one/.other (createIntl formatPlural).
      "chat.toolCall.workflow.feedback.count.one",
      "chat.toolCall.workflow.feedback.count.other",
      "chat.toolCall.workflow.feedback.rule",
    ]) {
      expect((enUS as Record<string, string>)[key], key).toBeTruthy();
      expect((zhCN as Record<string, string>)[key], key).toBeTruthy();
      expect((zhCN as Record<string, string>)[key], key).not.toBe(
        (enUS as Record<string, string>)[key],
      );
    }
    for (const gone of [
      "chat.toolCall.workflow.error",
      "chat.toolCall.workflow.errors",
      "chat.toolCall.workflow.diagnostics",
    ]) {
      expect((enUS as Record<string, string>)[gone], gone).toBeUndefined();
      expect((zhCN as Record<string, string>)[gone], gone).toBeUndefined();
    }
  });

  it("两个新 key 在两种语言里都存在，且不是英文占位", () => {
    for (const key of [
      "chat.toolCall.workflow.writing",
      "chat.toolCall.workflow.awaitingConfirmation",
    ]) {
      expect(enUS[key]).toBeTruthy();
      expect(zhCN[key]).toBeTruthy();
      expect(zhCN[key]).not.toBe(enUS[key]);
    }
  });
});

// ── Five pills and one door (docs/dynamic-workflow/presentation.md, "Past six participants") ──
// Once a station passes six participants: five pinned pills + one "n more" row; clicking that row or the station header
// opens run details anchored at this station.
describe("CreateWorkflowToolCallBlock 名册站", () => {
  type FanStatus = "done" | "running" | "failed" | "pending";
  // A real fan-out is one lane spawning N instances (`agent(\`reviewer-${i}\`)` in a loop): on the static graph it is a
  // single `many` card, and once the run arrives it splits into N pills by instance (liveParticipantView). Display's lane
  // cap is 32, so the roster's large numbers can only come from here.
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
  };
  function fanoutToolCall(_n: number): ToolCallOverrides {
    return {
      input: { name: "bug-scan", script: 'phase("review");' },
      raw: { display: { ...OK_DISPLAY, causalityGraph: FANOUT_GRAPH } },
    };
  }
  function fanoutRun(
    n: number,
    statusOf: (index: number) => FanStatus,
    unlistedByPhase?: WorkflowRunState["unlistedByPhase"],
  ) {
    const actors: WorkflowRunState["actors"] = [];
    const nodes: WorkflowRunState["nodes"] = [];
    for (let i = 1; i <= n; i += 1) {
      const status = statusOf(i);
      actors.push({
        siteId: "actor#1",
        ordinal: i,
        name: `reviewer-${i}`,
        sessionId: `s-${i}`,
        status: status === "running" ? "running" : status === "pending" ? "waiting" : "completed",
      });
      if (status === "pending") continue;
      nodes.push({
        siteId: "ask#1",
        ordinal: i,
        actorSiteId: "actor#1",
        actorOrdinal: i,
        ...(status === "running"
          ? { phase: "executing" }
          : { phase: "settled", outcome: status === "failed" ? "failed" : "ok" }),
      } as WorkflowRunState["nodes"][number]);
    }
    return joined({
      actors,
      nodes,
      usage: { spentTokens: 10, nodesUsed: nodes.length },
      ...(unlistedByPhase === undefined ? {} : { truncated: true, unlistedByPhase }),
    });
  }
  const mid = (i: number): FanStatus =>
    i === 4 ? "failed" : i === 6 ? "running" : i === 7 ? "pending" : "done";

  it("七个参与者：钉住 running → failed → 补位五枚药丸，其余折成「还有 2 个」一行；没有计数行、量条、格子", () => {
    const view = renderBlockDom(fanoutToolCall(7), { workflowRun: fanoutRun(7, mid) });
    const column = view.getByTestId("workflow-timeline-pills");
    expect(column.getAttribute("data-station-roster")).toBe("true");
    const pills = within(column).getAllByTestId("workflow-agent-pill");
    expect(pills.map((pill) => pill.textContent)).toEqual([
      "reviewer-6",
      "reviewer-4",
      "reviewer-1",
      "reviewer-2",
      "reviewer-3",
    ]);
    expect(pills.map((pill) => pill.getAttribute("data-agent-status"))).toEqual([
      "running",
      "failed",
      "done",
      "done",
      "done",
    ]);
    const row = within(column).getByTestId("workflow-roster-more-row");
    expect(column.lastElementChild).toBe(row);
    expect(row.getAttribute("data-more-count")).toBe("2");
    expect(row.textContent).toBe("2 more");
    expect(row.getAttribute("title")).toBe("2 more subagents · list everyone in the run pane");
    // The stacked faces follow attention order: pending's 7 comes before done's 5.
    const faces = within(row)
      .getByTestId("workflow-more-deck")
      .querySelectorAll("[data-face-state]");
    expect([...faces].map((face) => face.getAttribute("data-face-state"))).toEqual([
      "waiting",
      "content",
    ]);
    expect(within(row).queryByTestId("workflow-more-failed")).toBeNull();
    expect(within(column).queryByTestId("workflow-roster-tally")).toBeNull();
    expect(within(column).queryByTestId("workflow-roster-meter")).toBeNull();
    expect(within(column).queryByTestId("workflow-agent-cell")).toBeNull();
    // The header stays as before.
    expect(view.getByTestId("workflow-card-detail").textContent).toContain("1 agent working");
  });

  // The off-table ones (docs/dynamic-workflow/presentation.md, "Past six participants"): subagents evicted by the
  // reduction have neither pill nor face, but the threshold, the headcount, and the red ✕ all count them.
  it("四枚药丸加三百个被淘汰的就是名册：药丸四枚、那一行说「还有 300 个」、红 ✕ 含表外失败的", () => {
    const view = renderBlockDom(fanoutToolCall(4), {
      workflowRun: fanoutRun(4, () => "running", [
        { phaseName: "review", actors: 300, actorsSettled: 100, actorsFailed: 2, settled: 300 },
      ]),
    });
    const column = view.getByTestId("workflow-timeline-pills");
    expect(column.getAttribute("data-station-roster")).toBe("true");
    expect(within(column).getAllByTestId("workflow-agent-pill")).toHaveLength(4);
    const row = within(column).getByTestId("workflow-roster-more-row");
    expect(row.getAttribute("data-more-count")).toBe("300");
    expect(row.textContent).toContain("300 more");
    expect(within(row).getByTestId("workflow-more-failed").textContent).toBe("2");
    // Off-table participants have no faces: there should not be a single one in the stack.
    expect(
      within(row).getByTestId("workflow-more-deck").querySelectorAll("[data-face-state]"),
    ).toHaveLength(0);
  });

  it("六个参与者仍是药丸列：没有名册", () => {
    const view = renderBlockDom(fanoutToolCall(6), { workflowRun: fanoutRun(6, mid) });
    const column = view.getByTestId("workflow-timeline-pills");
    expect(column.getAttribute("data-station-roster")).toBeNull();
    expect(within(column).getAllByTestId("workflow-agent-pill")).toHaveLength(6);
    expect(view.queryByTestId("workflow-roster-more-row")).toBeNull();
  });

  it("失败多于五个：五枚红药丸之后那一行说藏了几个 failed", () => {
    const view = renderBlockDom(fanoutToolCall(9), {
      workflowRun: fanoutRun(9, (i) => (i <= 6 ? "failed" : "done")),
    });
    const column = view.getByTestId("workflow-timeline-pills");
    const pills = within(column).getAllByTestId("workflow-agent-pill");
    expect(pills.every((pill) => pill.getAttribute("data-agent-status") === "failed")).toBe(true);
    const row = within(column).getByTestId("workflow-roster-more-row");
    expect(row.getAttribute("data-more-count")).toBe("4");
    expect(within(row).getByTestId("workflow-more-failed").textContent).toBe("1");
    const faces = within(row)
      .getByTestId("workflow-more-deck")
      .querySelectorAll("[data-face-state]");
    expect([...faces].map((face) => face.getAttribute("data-face-state"))).toEqual([
      "sad",
      "content",
      "content",
    ]);
  });

  it("那一行与站头交出站 id：开 run 详情、落到这一站；没有回调时那一行是静态的", () => {
    const onOpenWorkflowRun = vi.fn();
    const view = renderBlockDom(fanoutToolCall(60), {
      onOpenWorkflowRun,
      workflowRun: fanoutRun(60, () => "done"),
    });
    const row = view.getByTestId("workflow-roster-more-row");
    expect(row.tagName).toBe("BUTTON");
    expect(row.getAttribute("data-more-count")).toBe("55");
    fireEvent.click(row);
    expect(onOpenWorkflowRun).toHaveBeenCalledWith({
      workflowName: "bug-scan",
      phaseId: "phase#a",
    });
    // The station header (a button when a callback exists, title = station name) takes the same path.
    fireEvent.click(view.getByTitle("review"));
    expect(onOpenWorkflowRun).toHaveBeenCalledTimes(2);
    expect(onOpenWorkflowRun).toHaveBeenLastCalledWith({
      workflowName: "bug-scan",
      phaseId: "phase#a",
    });
    cleanup();
    const inert = renderBlockDom(fanoutToolCall(60), { workflowRun: fanoutRun(60, () => "done") });
    expect(inert.getByTestId("workflow-roster-more-row").tagName).toBe("SPAN");
  });

  it("静态卡（无 run）：`many` 卡还是一枚药丸；字面量基数的成员卡过了阈值是五枚 + 静态的「还有 3 个」", () => {
    expect(renderBlock(fanoutToolCall(8))).not.toContain("data-station-roster");
    const members = {
      ...FANOUT_GRAPH,
      participants: Array.from({ length: 8 }, (_, i) => ({
        id: `phase#a:actor#1[${i}]`,
        phase: "phase#a",
        lane: "actor#1",
        steps: ["ask#1"],
        member: { index: i, of: 8 },
      })),
    };
    const html = renderBlock({
      input: { name: "bug-scan", script: 'phase("review");' },
      raw: { display: { ...OK_DISPLAY, causalityGraph: members } },
    });
    expect(html).toContain('data-station-roster="true"');
    expect(html).toContain('data-more-count="3"');
    expect(html).toContain('<span aria-label="3 more subagents · list everyone in the run pane"');
    expect(html).not.toContain('data-testid="workflow-roster-tally"');
  });

  it("zh-CN：「还有 n 个」与整句 title", () => {
    const view = renderBlockDom(
      fanoutToolCall(60),
      { workflowRun: fanoutRun(60, () => "done") },
      "zh-CN",
    );
    const row = view.getByTestId("workflow-roster-more-row");
    expect(row.textContent).toBe("还有 55 个");
    expect(row.getAttribute("title")).toBe("还有 55 个子代理 · 在运行侧栏里列出全部");
  });
});

// ── AmendWorkflow row (docs/dynamic-workflow/presentation.md, "The tool row" second table) ──
// The same renderer swaps in amend vocabulary: drafting "adjusting the workflow", awaiting confirmation "waiting for amend
// confirmation", failed compile / static card "workflow amend"; the card body gains one line "amend run X". display stays
// create_workflow, and the graph and draft pen share one implementation.
describe("CreateWorkflowToolCallBlock as AmendWorkflow", () => {
  const DRAFT = 'phase("plan");\nconst planner = agent("planner");\nphase("ver';
  const AMEND_INPUT = { name: "Research pipeline", script: DRAFT, run_id: "dwfrun-prev" };

  it.each([
    ["en-US", "Amending workflow"],
    ["zh-CN", "正在调整工作流"],
  ] as const)("writing: %s", (locale, word) => {
    const view = renderBlockDom(
      {
        kind: "AmendWorkflow",
        input: AMEND_INPUT,
        raw: { v4Status: "inputStreaming" },
        status: "running",
      },
      { isRunning: true },
      locale,
    );
    expect(view.container.textContent).toContain(word);
    expect(view.container.textContent).not.toContain("Writing workflow");
    // The draft pen works as before: stations are scanned out of the partial script.
    expect(view.getByTestId("workflow-draft-timeline")).toBeTruthy();
  });

  it.each([
    ["en-US", "Awaiting amendment confirmation"],
    ["zh-CN", "等待调整确认"],
  ] as const)("awaiting confirmation: %s", (locale, word) => {
    const view = renderBlockDom(
      {
        kind: "AmendWorkflow",
        ...LOOP_TOOL_CALL,
        input: { ...(LOOP_TOOL_CALL.input as object), run_id: "dwfrun-prev" },
        raw: { ...(LOOP_TOOL_CALL.raw as object), v4Status: "pendingApproval" },
        status: "running",
      },
      { isRunning: true },
      locale,
    );
    expect(view.container.textContent).toContain(word);
  });

  it.each([
    ["en-US", "Workflow amendment", "Amends run"],
    ["zh-CN", "工作流调整", "调整 run"],
  ] as const)("static card: kind word and the lineage row: %s", (locale, word, amends) => {
    const view = renderBlockDom(
      {
        kind: "AmendWorkflow",
        ...LOOP_TOOL_CALL,
        input: { ...(LOOP_TOOL_CALL.input as object), run_id: "dwfrun-prev" },
      },
      {},
      locale,
    );
    expect(view.getByTestId("workflow-card-kind").textContent).toBe(word);
    const lineage = view.container.querySelector('[data-workflow-card-amends="true"]');
    expect(lineage?.textContent).toContain(amends);
    expect(lineage?.textContent).toContain("dwfrun-prev");
  });

  it("compile errors: the feedback row says「Amendment draft」, not the create word", () => {
    const view = renderBlockDom({
      kind: "AmendWorkflow",
      input: AMEND_INPUT,
      raw: {
        display: {
          kind: "create_workflow",
          ok: false,
          errorCount: 1,
          diagnostics: [{ line: 1, column: 1, code: 2322, message: "Type error" }],
        },
      },
      status: "failed",
    });
    expect(view.container.querySelector(".tool-summary-kind-label")?.textContent).toBe(
      "Amendment draft",
    );
    expect(view.container.textContent).not.toContain("Amending workflow");
    expect(view.container.textContent).not.toContain("Workflow draft");
  });

  it("from draft 2 on the streaming amend row says「Revising amendment」", () => {
    const view = renderBlockDom(
      {
        kind: "AmendWorkflow",
        input: AMEND_INPUT,
        raw: { v4Status: "inputStreaming" },
        status: "running",
      },
      { isRunning: true, workflowDraft: { ordinal: 2, superseded: false } },
    );
    expect(view.container.textContent).toContain("Revising amendment");
    expect(view.getByTestId("workflow-draft-ordinal").textContent).toBe("draft 2");
  });

  // Amend omitting script (docs/dynamic-workflow/presentation.md, "The tool row"): the input on the row is the one the
  // model emitted and the script is backfilled only afterwards, so the card has no script to collapse. The lineage row says
  // "script unchanged" and the "no script provided" hint must not appear — a missing script is the intent of this call, not a failure.
  const SETTINGS_ONLY_INPUT = { run_id: "dwfrun-prev", max_concurrency: 2 };

  it.each([
    ["en-US", "Amends run", "script unchanged"],
    ["zh-CN", "调整 run", "脚本不变"],
  ] as const)("static card of an amend that kept the script: %s", (locale, amends, unchanged) => {
    const view = renderBlockDom(
      { kind: "AmendWorkflow", input: SETTINGS_ONLY_INPUT, raw: LOOP_TOOL_CALL.raw },
      {},
      locale,
    );
    const lineage = view.container.querySelector('[data-workflow-card-amends="true"]');
    expect(lineage?.textContent).toContain(amends);
    expect(lineage?.textContent).toContain("dwfrun-prev");
    expect(lineage?.textContent).toContain(unchanged);
    expect(lineage?.getAttribute("data-workflow-card-amends-script-inherited")).toBe("true");
    // The graph renders as usual (display comes from the backfilled script), but there is no script collapse and no "no script provided".
    expect(view.getByTestId("workflow-timeline")).toBeTruthy();
    expect(view.queryByTestId("workflow-card-script-toggle")).toBeNull();
    expect(view.container.textContent).not.toContain("No workflow script provided.");
  });

  it("an amend that kept the script and has no display still shows no 'no script' notice", () => {
    const view = renderBlockDom({ kind: "AmendWorkflow", input: SETTINGS_ONLY_INPUT, raw: {} });
    expect(view.container.textContent).not.toContain("No workflow script provided.");
    const lineage = view.container.querySelector('[data-workflow-card-amends="true"]');
    expect(lineage?.textContent).toContain("script unchanged");
  });

  it("a static amend card that passed a script says nothing about the script", () => {
    const view = renderBlockDom({
      kind: "AmendWorkflow",
      ...LOOP_TOOL_CALL,
      input: { ...(LOOP_TOOL_CALL.input as object), run_id: "dwfrun-prev" },
    });
    const lineage = view.container.querySelector('[data-workflow-card-amends="true"]');
    expect(lineage?.textContent).not.toContain("script unchanged");
    expect(lineage?.getAttribute("data-workflow-card-amends-script-inherited")).toBeNull();
    expect(view.getByTestId("workflow-card-script-toggle")).toBeTruthy();
  });

  it("an input trimmed to a snapshot preview is not read as a kept script", () => {
    // When the first-screen snapshot trims a large input into a preview, what is missing is bytes, not the script: an amend
    // that did pass a script must not be described as "script unchanged".
    const view = renderBlockDom({
      kind: "AmendWorkflow",
      input: { run_id: "dwfrun-prev" },
      raw: LOOP_TOOL_CALL.raw,
      snapshotRefs: [{ field: "input", previewBytes: 64, fullBytes: 40_000 }],
    });
    const lineage = view.container.querySelector('[data-workflow-card-amends="true"]');
    expect(lineage?.textContent).toContain("dwfrun-prev");
    expect(lineage?.textContent).not.toContain("script unchanged");
  });

  it("while the input streams nothing is said: the script may still be on its way", () => {
    const view = renderBlockDom(
      {
        kind: "AmendWorkflow",
        input: { run_id: "dwfrun-prev" },
        raw: { v4Status: "inputStreaming" },
        status: "running",
      },
      { isRunning: true },
    );
    expect(view.container.textContent).toContain("Amending workflow");
    expect(view.container.textContent).not.toContain("script unchanged");
  });

  it("readWorkflowAmendScriptInherited: the resolved flag, or a finished input with neither script source", () => {
    // Confirmation dialog: the CLI-backfilled input carries the script, and the flag speaks.
    expect(
      readWorkflowAmendScriptInherited({
        run_id: "r",
        script: "x",
        predecessor: { status: "completed", script_inherited: true },
      }),
    ).toBe(true);
    // Chat card: the model-emitted input has no script.
    expect(readWorkflowAmendScriptInherited({ run_id: "r", max_concurrency: 2 })).toBe(true);
    // Script given but flag absent: not inherited.
    expect(
      readWorkflowAmendScriptInherited({
        run_id: "r",
        script: "x",
        predecessor: { status: "completed" },
      }),
    ).toBe(false);
    // A `path` amend (the norm of docs/dynamic-workflow/launch.md, "Script files") likewise carries no `script`, but what
    // it submits is a **modified** script: saying "script unchanged" would be lying to the user.
    expect(
      readWorkflowAmendScriptInherited({ run_id: "r", path: ".zcode/workflow-drafts/x.dwf.ts" }),
    ).toBe(false);
    // Script inherited and the predecessor's file is still resolvable: the backfilled input carries both `path` and the flag, and the flag decides.
    expect(
      readWorkflowAmendScriptInherited({
        run_id: "r",
        script: "x",
        path: "/abs/.zcode/workflow-drafts/x.dwf.ts",
        predecessor: { status: "completed", script_inherited: true },
      }),
    ).toBe(true);
    // Unrecorded input (snapshot trimmed, shape unknown): nothing is asserted.
    expect(readWorkflowAmendScriptInherited(undefined)).toBe(false);
    expect(readWorkflowAmendScriptInherited("{}")).toBe(false);
  });

  it("a CreateWorkflow row never grows a lineage row", () => {
    const view = renderBlockDom(LOOP_TOOL_CALL);
    expect(view.container.querySelector('[data-workflow-card-amends="true"]')).toBeNull();
  });

  it("readWorkflowKindMessageId switches to the amend vocabulary", () => {
    expect(readWorkflowKindMessageId({ v4Status: "inputStreaming" }, true, true)).toBe(
      "chat.toolCall.workflow.amend.writing",
    );
    expect(readWorkflowKindMessageId({ v4Status: "pendingApproval" }, true, true)).toBe(
      "chat.toolCall.workflow.amend.awaitingConfirmation",
    );
    // Validating reuses the same word as create.
    expect(readWorkflowKindMessageId({ v4Status: "running" }, true, true)).toBe(
      "chat.toolCall.workflow.running",
    );
    expect(readWorkflowKindMessageId(undefined, false, true)).toBe(
      "chat.toolCall.workflow.amend.ran",
    );
  });

  it("every amend key exists in both locales", () => {
    for (const key of [
      "chat.toolCall.workflow.amend.writing",
      "chat.toolCall.workflow.amend.awaitingConfirmation",
      "chat.toolCall.workflow.amend.ran",
      "chat.toolCall.workflow.amend.amended",
      "chat.toolCall.workflow.amend.amends",
      "chat.toolCall.workflow.card.superseded",
      "chat.toolCall.workflow.run.stopReason.superseded",
      "chat.toolCall.workflow.run.amends",
      "chat.toolCall.workflow.run.supersededBy",
      "chat.permission.workflow.amend.title",
      "chat.permission.workflow.amends",
      "chat.permission.workflow.amends.running",
      "chat.permission.workflow.amends.scriptUnchanged",
      "chat.toolCall.workflow.amend.scriptUnchanged",
    ]) {
      expect(enUS[key as keyof typeof enUS], key).toBeTruthy();
      expect(zhCN[key as keyof typeof zhCN], key).toBeTruthy();
    }
    // The old lineage keys retire along with resume_from; the card's two lineage lines (amended from / superseded by) are
    // not drawn per the user ruling, and the keys are not kept either.
    for (const gone of [
      "chat.toolCall.workflow.card.supersededBy",
      "chat.toolCall.workflow.card.amends",
    ]) {
      expect((enUS as Record<string, string>)[gone], gone).toBeUndefined();
      expect((zhCN as Record<string, string>)[gone], gone).toBeUndefined();
    }
    expect((enUS as Record<string, string>)["chat.permission.workflow.resumeFrom"]).toBeUndefined();
    expect((zhCN as Record<string, string>)["chat.permission.workflow.resumeFrom"]).toBeUndefined();
  });

  // ── In-place amend (docs/dynamic-workflow/concurrency.md) ──
  // When the call only changes the concurrency cap and the run is in flight, it compiles nothing and mints no new run, so
  // the result has no display either — the whole row degrades to a settings row, cut by the wiring layer
  // (ConversationRowView) based on the input shape; see the section at the end of this file. Here only the renderer side is
  // pinned: those in-flight words must not say "validating", because this kind of call compiles nothing.
  it("只改并发上限的调用在途时不说「正在校验」，从头到尾说「正在调整工作流」", () => {
    expect(readWorkflowKindMessageId({ v4Status: "running" }, true, true, true)).toBe(
      "chat.toolCall.workflow.amend.writing",
    );
    expect(readWorkflowKindMessageId({ v4Status: "inputStreaming" }, true, true, true)).toBe(
      "chat.toolCall.workflow.amend.writing",
    );
    // Amends carrying a script are unaffected: validation really happens.
    expect(readWorkflowKindMessageId({ v4Status: "running" }, true, true, false)).toBe(
      "chat.toolCall.workflow.running",
    );
  });

  it.each([
    [
      { run_id: "r", max_concurrency: 4 },
      { runId: "r", requested: 4 },
    ],
    [
      { run_id: "r", max_concurrency: null },
      { runId: "r", requested: null },
    ],
    // A script source is present: this amend needs compiling, not the in-place shape.
    [{ run_id: "r", max_concurrency: 4, script: "phase('a')" }, undefined],
    [{ run_id: "r", max_concurrency: 4, path: ".zcode/workflow-drafts/x.dwf.ts" }, undefined],
    // Model or name also changed: that calls for a different run, not an in-place amend.
    [{ run_id: "r", max_concurrency: 4, subagent_model: "zhipu/glm-5.3" }, undefined],
    [{ run_id: "r", max_concurrency: 4, name: "Research pipeline" }, undefined],
    // Only run_id (the script may still be on its way): no judgment.
    [{ run_id: "r" }, undefined],
    [{ max_concurrency: 4 }, undefined],
    ["{}", undefined],
  ])("readWorkflowRetuneCall %#", (input, expected) => {
    expect(readWorkflowRetuneCall(input)).toEqual(expected);
  });

  it("在途的只改并发上限调用：行上说「正在调整工作流」，不说校验", () => {
    const view = renderBlockDom(
      {
        kind: "AmendWorkflow",
        input: { run_id: "dwfrun-prev", max_concurrency: 4 },
        raw: { v4Status: "running" },
        status: "running",
      },
      { isRunning: true },
    );
    expect(view.container.textContent).toContain("Amending workflow");
    expect(view.container.textContent).not.toContain("Validating workflow");
  });
});

// ── Wiring (docs/dynamic-workflow/authoring.md, "How the user sees them") ──
// Above we pinned the pill handing the **artifact id** to the layer above; here we pin what kind of open request
// `ConversationRowView` turns the id into. What reaches this card is the path **not taken over by the turn-tail summary**
// (joined to a run but the tool call itself errored); a row joined to a run and successful draws only a
// `WorkflowToolSummary`, with the card in the turn tail.
describe("ConversationRowView 把工具卡的产物药丸变成打开请求", () => {
  const RUN = {
    runId: "run-7",
    toolCallId: "tool-5",
    status: "completed",
    usage: { spentTokens: 12, nodesUsed: 1 },
    actors: [{ siteId: "actor#1", ordinal: 1, name: "Ada", sessionId: "s-1", status: "completed" }],
    nodes: [{ siteId: "ask#1", ordinal: 1, phase: "settled", outcome: "ok" }],
    artifacts: [
      { id: "book", kind: "file", title: "Audit report", version: 2, contentType: "text/html" },
      { id: "perf", kind: "chart", title: "Round timings", version: 1 },
    ],
    lastEventSequence: 3,
  } as unknown as WorkflowRunState;

  function renderRow(onOpenWorkflowArtifact: (request: unknown) => void) {
    // The code-block stub swallows matchMedia readers, but the body renderer still asks once; jsdom has no matchMedia.
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    });
    return render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          PlatformProvider,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- This path never touches platform services.
          { platform: {} as any },
          createElement(ConversationRowView, {
            row: {
              rowId: 5,
              turnId: "turn-1",
              createdAt: 1_700_000_000_005,
              createdAtSeq: 5,
              kind: "toolCall",
              toolCallId: "tool-5",
              toolName: "CreateWorkflow",
              // A successful launch row is taken over by the turn-tail summary and cannot draw this card; only an errored
              // row falls back to the full tool card.
              status: "error",
              input: { name: "implement-verify", script: "phase('a')" },
              inputText: "{}",
              output: {
                text: "ok",
                display: {
                  kind: "create_workflow",
                  ok: true,
                  errorCount: 0,
                  diagnostics: [],
                  causalityGraph: {
                    steps: [
                      {
                        id: "ask#1",
                        kind: "ask",
                        label: "plan",
                        line: 2,
                        column: 21,
                        lane: "actor#1",
                      },
                    ],
                    lanes: [{ id: "actor#1", name: "planner", line: 1, column: 11 }],
                    participants: [
                      {
                        id: "unphased:actor#1",
                        phase: "unphased",
                        lane: "actor#1",
                        steps: ["ask#1"],
                      },
                    ],
                    handoffs: [],
                  },
                },
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Only fills the fields the renderer reads.
            } as any,
            context: {
              workspacePath: "/workspace",
              theme: "system",
              sessionId: "parent-a",
              onOpenWorkflowArtifact,
              workflowRunByToolCallId: new Map([
                [
                  "tool-5",
                  {
                    runId: "run-7",
                    toolCallId: "tool-5",
                    status: "completed",
                    nodesSettled: 1,
                    nodesTotal: 1,
                    run: RUN,
                  },
                ],
              ]),
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Same as above.
            } as any,
          }),
        ),
      ),
    );
  }

  it("带上展示名与 contentType（宿主据它把 html 产物直接开成浏览器 tab）", () => {
    const spy = vi.fn();
    const view = renderRow(spy);

    fireEvent.click(view.getAllByTestId("workflow-card-artifact")[0]!);
    expect(spy).toHaveBeenCalledWith({
      parentSessionId: "parent-a",
      runId: "run-7",
      artifactId: "book",
      title: "Audit report",
      contentType: "text/html",
    });
  });

  // In-place amend row (docs/dynamic-workflow/concurrency.md): the result has no display and mints no new run, so all the
  // criteria live in the input shape. The default concurrency is read from the amended run's projection
  // (run.concurrencyCeiling).
  function renderRetuneRow(
    input: unknown,
    options: {
      ceiling?: number;
      onOpenWorkflowRun?: (request: unknown) => void;
      /** The row that returns a real amend: it compiled, so it has display. */
      display?: unknown;
      /** Same idea: it minted a new run, joinable by **this row's** toolCallId. */
      joinedByToolCallId?: boolean;
      status?: string;
    } = {},
  ) {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    });
    return render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          PlatformProvider,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- This path never touches platform services.
          { platform: {} as any },
          createElement(ConversationRowView, {
            row: {
              rowId: 9,
              turnId: "turn-1",
              createdAt: 1_700_000_000_009,
              createdAtSeq: 9,
              kind: "toolCall",
              toolCallId: "tool-9",
              toolName: "AmendWorkflow",
              status: options.status ?? "success",
              input,
              inputText: "{}",
              // The in-place result is a single sentence: no display.
              output: {
                text: "Applied to the running run run-7; at most 4 subagents run at once.",
                ...(options.display === undefined ? {} : { display: options.display }),
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Only fills the fields the renderer reads.
            } as any,
            context: {
              workspacePath: "/workspace",
              theme: "system",
              sessionId: "parent-a",
              onOpenWorkflowRun: options.onOpenWorkflowRun,
              // No run can be found by this row's toolCallId (it minted no new run); that run exists only when joined by runId.
              workflowRunByToolCallId: options.joinedByToolCallId
                ? new Map([
                    [
                      "tool-9",
                      {
                        runId: "run-8",
                        toolCallId: "tool-9",
                        status: "running",
                        nodesSettled: 0,
                        nodesTotal: 1,
                      },
                    ],
                  ])
                : new Map(),
              workflowRunByRunId: new Map([
                [
                  "run-7",
                  {
                    runId: "run-7",
                    toolCallId: "tool-5",
                    status: "running",
                    nodesSettled: 0,
                    nodesTotal: 1,
                    ...(options.ceiling === undefined
                      ? {}
                      : { run: { runId: "run-7", concurrencyCeiling: options.ceiling } }),
                  },
                ],
              ]),
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Same as above.
            } as any,
          }),
        ),
      ),
    );
  }

  it("就地生效的修订行退成设置行：点它开那条 run，带发起行的 toolCallId", () => {
    const onOpenWorkflowRun = vi.fn();
    const view = renderRetuneRow(
      { run_id: "run-7", max_concurrency: 4 },
      { ceiling: 13, onOpenWorkflowRun },
    );
    // The card is gone, only the row remains; neither "passed validation" nor "script unchanged" appears anywhere.
    expect(view.queryByTestId("workflow-card")).toBeNull();
    const row = view.getByTestId("workflow-retune-row");
    expect(row.textContent).toContain("Settings changed");
    expect(row.textContent).toContain("at most 4 at once");
    for (const gone of ["compiled", "Amends run", "script unchanged"]) {
      expect(view.container.textContent).not.toContain(gone);
    }
    fireEvent.click(row);
    expect(onOpenWorkflowRun).toHaveBeenCalledWith({
      parentSessionId: "parent-a",
      toolCallId: "tool-5",
      runId: "run-7",
    });
  });

  // The default concurrency D (run.concurrencyCeiling) is a starting point, not a cap: a requested value exactly equal to
  // D and null both mean "lift this run's own bound"; numbers above or below D are rendered verbatim.
  it.each([
    ["请求高于默认", { run_id: "run-7", max_concurrency: 40 }, 13, "at most 40 at once"],
    ["请求正好是默认", { run_id: "run-7", max_concurrency: 13 }, 13, "limit back to the default"],
    [
      "解除上限（null）",
      { run_id: "run-7", max_concurrency: null },
      13,
      "limit back to the default",
    ],
    ["请求低于默认", { run_id: "run-7", max_concurrency: 4 }, 13, "at most 4 at once"],
    // Default unknown (that run has been evicted from the projection): the requested value is rendered verbatim.
    ["默认未知", { run_id: "run-7", max_concurrency: 4 }, undefined, "at most 4 at once"],
  ])("%s", (_case, input, ceiling, text) => {
    const view = renderRetuneRow(input, ceiling === undefined ? {} : { ceiling });
    expect(view.getByTestId("workflow-retune-row").textContent).toContain(text);
  });

  it("宿主没给打开回调（只读面）：还是那一行，只是点不动", () => {
    const view = renderRetuneRow({ run_id: "run-7", max_concurrency: 4 }, { ceiling: 13 });
    expect(view.getByTestId("workflow-retune-row").tagName).not.toBe("BUTTON");
  });

  // Once the run has settled, the same call returns a **real amend**: it compiled (has display) and minted a run joinable
  // by this row's toolCallId. Either criterion alone is enough to keep it out of the settings row — each is pinned here.
  it("退回真修订（有 display、有按 toolCallId 联接的 run）：照旧走运行摘要，不退成设置行", () => {
    const view = renderRetuneRow(
      { run_id: "run-7", max_concurrency: 4 },
      {
        ceiling: 13,
        joinedByToolCallId: true,
        display: { kind: "create_workflow", ok: true, errorCount: 0, diagnostics: [] },
      },
    );
    expect(view.queryByTestId("workflow-retune-row")).toBeNull();
  });

  it("只有 display（还没联接到 run）也不退成设置行：编译过就不是就地生效", () => {
    const view = renderRetuneRow(
      { run_id: "run-7", max_concurrency: 4 },
      {
        ceiling: 13,
        display: { kind: "create_workflow", ok: true, errorCount: 0, diagnostics: [] },
      },
    );
    expect(view.queryByTestId("workflow-retune-row")).toBeNull();
    expect(view.queryByTestId("workflow-card")).not.toBeNull();
  });

  it("工具报错（拒绝也是 tool error）：照旧走错误渲染", () => {
    const view = renderRetuneRow({ run_id: "run-7", max_concurrency: 4 }, { status: "error" });
    expect(view.queryByTestId("workflow-retune-row")).toBeNull();
  });

  it("活投影那份摘要上没有 contentType 的那一枚不编一个出来（它也从不带 sourcePath）", () => {
    const spy = vi.fn();
    const view = renderRow(spy);

    fireEvent.click(view.getAllByTestId("workflow-card-artifact")[1]!);
    expect(spy).toHaveBeenCalledWith({
      parentSessionId: "parent-a",
      runId: "run-7",
      artifactId: "perf",
      title: "Round timings",
    });
  });
});

// ── Wiring: the row context's draft-number join table → compile feedback row (docs/dynamic-workflow/presentation.md,
// "Compiler feedback") ──
// The draft number is built from the row window by the host in one pass (`workflowDraftJoin.ts`); here we pin that
// `ConversationRowView` hands this row's own position to the card by toolCallId, instead of letting the card page through
// the row window itself.
describe("ConversationRowView 把稿号交给编译反馈行", () => {
  function renderFeedbackRow(context: Record<string, unknown>) {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    });
    return render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          PlatformProvider,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- This path never touches platform services.
          { platform: {} as any },
          createElement(ConversationRowView, {
            row: {
              rowId: 9,
              turnId: "turn-1",
              createdAt: 1_700_000_000_009,
              createdAtSeq: 9,
              kind: "toolCall",
              toolCallId: "tool-9",
              toolName: "CreateWorkflow",
              status: "success",
              input: { name: "Release notes digest", script: "const x: number = 'nope';" },
              inputText: "{}",
              output: {
                text: "The workflow script has errors:",
                display: {
                  kind: "create_workflow",
                  ok: false,
                  errorCount: 1,
                  diagnostics: [{ line: 1, column: 7, code: 2322, message: "Type error" }],
                },
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Only fills the fields the renderer reads.
            } as any,
            context: {
              workspacePath: "/workspace",
              theme: "system",
              sessionId: "parent-a",
              ...context,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Same as above.
            } as any,
          }),
        ),
      ),
    );
  }

  it("联接表里有这一行：稿号与被替代的灯随行上下文到达卡片", () => {
    const view = renderFeedbackRow({
      workflowDraftByToolCallId: new Map([["tool-9", { ordinal: 3, superseded: true }]]),
    });
    expect(view.getByTestId("workflow-draft-ordinal").textContent).toBe("draft 3");
    expect(view.getByTestId("workflow-draft-lamp").getAttribute("data-draft-lamp")).toBe("settled");
  });

  it("联接表缺席（只读分享等宿主）：不编号，灯保持警示色", () => {
    const view = renderFeedbackRow({});
    expect(view.queryByTestId("workflow-draft-ordinal")).toBeNull();
    expect(view.getByTestId("workflow-draft-lamp").getAttribute("data-draft-lamp")).toBe("open");
  });
});

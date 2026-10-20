// @vitest-environment jsdom

// dwf run detail pane (docs/dynamic-workflow/presentation.md "The run pane"): status header /
// usage line / Cancel / result and failure panels / pending questions / artifacts / empty
// states, in both languages.
//
// User instruction of 2026-09-04: the Results (`report` entries), event log, and Script sections
// were removed from the pane (technical detail, not for users), and their test cases were
// deleted wholesale; the journal's read surface is unchanged — this pane just no longer shows
// them.
//
// Pure rules (Cancel availability, result adjudication, event summaries) are exhaustively
// covered in workflowRunPanel.test.ts;
// this file only pins "those results are actually wired to the DOM" plus interactions (which
// command a Cancel click sends).
import { createElement, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TID_WORKFLOW_ARTIFACTS_SECTION, TID_WORKFLOW_ARTIFACT_CARD } from "@zcode/shared";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowRunSidePaneTab } from "@/lib/workspaceSidePane.js";

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn() },
}));

// The tooltip only renders children (does not change the DOM shape) but records title /
// description: the Stop button's second line "stopped runs can be resumed" lives only in the
// tooltip.
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

const sendCommand = vi.fn(async () => ({ status: "accepted" }) as never);
const release = vi.fn();
// layer must be a **stable reference**: the component's lease effect depends on layer, and a new
// object on every render would loop forever through acquire → setLease → rerender → new layer
// (in production useV4Conversation returns a useMemo'd bundle, which is stable by construction).
const layer = { acquire: vi.fn(() => ({ release })) };
const workflowRunsQuery = vi.fn<() => Promise<{ runs: unknown[] }>>(async () => ({ runs: [] }));
// Artifacts (docs/dynamic-workflow/authoring.md): the catalog goes through the journal query,
// board entries through the data query.
// Both are stubbed here — on mount the pane asks for the catalog unconditionally (the live
// projection carries no spec or version history).
const workflowRunArtifactsQuery = vi.fn<() => Promise<{ artifacts: unknown[] }>>(async () => ({
  artifacts: [],
}));
const workflowRunArtifactDataQuery = vi.fn<() => Promise<{ items: unknown[]; hasMore: boolean }>>(
  async () => ({ items: [], hasMore: false }),
);
const conversation = {
  layer,
  sendCommand,
  workflowRuns: workflowRunsQuery,
  workflowRunArtifacts: workflowRunArtifactsQuery,
  workflowRunArtifactData: workflowRunArtifactDataQuery,
};

vi.mock("@/v4/V4ConversationContext.js", () => ({
  V4PaneConversationProvider: ({ children }: { children: ReactNode }) => children,
  useV4Conversation: () => conversation,
}));

let snapshot: unknown = null;
vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => ({ snapshot }),
}));

// The settings popover's model list (docs/dynamic-workflow/presentation.md "The settings
// popover"): the pane itself does not read it, it is subscribed only while the popover is open;
// an empty list suffices (the fields themselves are pinned in workflowRunSettingsPopover.test.ts).
vi.mock("@/hooks/useModelSelectionView.js", () => ({
  useModelSelectionView: () => ({
    state: { status: "ready", view: { revision: 1, providers: [] } },
    reload: vi.fn(),
  }),
}));

// eslint-disable-next-line import/first -- the component under test must be imported after all mocks.
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
// eslint-disable-next-line import/first
import { WorkflowRunSidePane } from "@/app-shell/WorkflowRunSidePane.js";
// eslint-disable-next-line import/first
import { useDynamicWorkflowAvailabilityStore } from "@/store/dynamicWorkflowAvailabilityStore.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { expectedCopy } from "./helpers/uiCopy.js";

/** Gray-release snapshot (docs/dynamic-workflow/launch.md "Gray release"): enabled by default, so the pane matches its pre-change behavior. */
function setDynamicWorkflowEnabled(enabled: boolean): void {
  useDynamicWorkflowAvailabilityStore.setState({
    status: "ready",
    enabled,
    config: { mode: enabled ? "alwaysOn" : "disabled", enabled, source: "remote" },
  });
}

const tab: WorkflowRunSidePaneTab = {
  id: "workflow-run:%2Fworkspace:parent-a:dwfrun-1",
  type: "workflow-run",
  workspaceKey: "/workspace",
  workspacePath: "/workspace",
  parentSessionId: "parent-a",
  toolCallId: "tool-wf-1",
  runId: "dwfrun-1",
  workflowName: "Fan-out review",
};

interface GraphStep {
  id: string;
  kind: "ask" | "world-read";
  label: string;
  lane: string;
  line?: number;
  phase?: string;
}

const STEPS: GraphStep[] = [
  {
    id: "ask#1",
    kind: "ask",
    label: "plan",
    lane: "actor#1",
    // The inspector's SOURCE section `L{n}` needs an anchor: when the lane has no line number,
    // fall back to its first step's line.
    line: 4,
  },
  // Extra cards for inspection: the workspace lane (synthetic, no session) and two anonymous lanes.
  {
    id: "world-read#1",
    kind: "world-read",
    label: "read files",
    lane: "workspace",
  },
  {
    id: "ask#2",
    kind: "ask",
    label: "review",
    lane: "actor#2",
  },
  {
    id: "ask#3",
    kind: "ask",
    label: "audit",
    lane: "actor#3",
  },
];

const LANES = [
  { id: "actor#1", name: "planner" },
  // Two anonymous lanes: the numbering must appear (Anonymous Subagent 1 / 2) and come from the
  // same source as the graph's.
  { id: "actor#2" },
  { id: "actor#3" },
  { id: "workspace" },
];

/** Participants = one card per phase per lane, id per the analyzer's `${phase}:${lane}`; unmarked scripts land in `unphased`. */
function participantsOf(steps: readonly GraphStep[]) {
  const byId = new Map<string, { id: string; phase: string; lane: string; steps: string[] }>();
  for (const step of steps) {
    const phase = step.phase ?? "unphased";
    const id = `${phase}:${step.lane}`;
    const existing = byId.get(id);
    if (existing) existing.steps.push(step.id);
    else byId.set(id, { id, lane: step.lane, phase, steps: [step.id] });
  }
  return [...byId.values()];
}

const graphRow = {
  kind: "toolCall" as const,
  rowId: "row-1",
  toolCallId: "tool-wf-1",
  toolName: "CreateWorkflow",
  status: "success" as const,
  inputText: "",
  display: {
    kind: "create_workflow" as const,
    ok: true,
    errorCount: 0,
    diagnostics: [],
    causalityGraph: {
      steps: STEPS,
      lanes: LANES,
      participants: participantsOf(STEPS),
      handoffs: [],
    },
  },
};

/**
 * Variant with the phase vocabulary present: the single-open accordion and phase selection need
 * two phases that can actually be opened.
 * The base graph deliberately has **no** phases — the vast majority of cases are
 * phase-independent, and gratuitously adding a phase layer to them only blurs what each case
 * is verifying.
 */
const PHASES = [
  { id: "phase#a", name: "plan", line: 3 },
  { id: "phase#b", name: "review", line: 9 },
];
const PHASE_OF: Record<string, string> = {
  "ask#1": "phase#a",
  "ask#2": "phase#b",
  "ask#3": "phase#b",
  "world-read#1": "phase#a",
};

function run(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    runId: "dwfrun-1",
    toolCallId: "tool-wf-1",
    status: "running",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [],
    nodes: [],
    lastEventSequence: 0,
    ...overrides,
  };
}

function setSnapshot(
  options: {
    run?: WorkflowRunState;
    withGraphRow?: boolean;
    /** Swap in a graph carrying the `phase()` vocabulary (phased board); the default is today's step/lane graph. */
    phased?: boolean;
  } = {},
) {
  const phasedSteps = STEPS.map((step) => ({ ...step, phase: PHASE_OF[step.id]! }));
  const causalityGraph =
    options.phased === true
      ? {
          ...graphRow.display.causalityGraph,
          participants: participantsOf(phasedSteps),
          phases: PHASES,
          // Edges between adjacent stations: the spine draws rail segments only between adjacent
          // stations joined by an edge (same rule as the cards).
          phaseEdges: [{ from: "phase#a", to: "phase#b" }],
          steps: phasedSteps,
        }
      : graphRow.display.causalityGraph;
  const row = { ...graphRow, display: { ...graphRow.display, causalityGraph } };
  snapshot = {
    rows: { window: options.withGraphRow === false ? [] : [row] },
    ...(options.run ? { workflowRuns: { revision: 1, runs: [options.run] } } : {}),
  };
}

const onOpenWorkflowActorSession = vi.fn();
const onOpenWorkflowArtifact = vi.fn();
const onOpenWorkflowWorkspace = vi.fn();
const onOpenWorkflowRun = vi.fn();

function renderPane(
  locale: "en-US" | "zh-CN" = "en-US",
  options: {
    withActorCallback?: boolean;
    withArtifactCallback?: boolean;
    withWorkspaceCallback?: boolean;
    /** The "superseded by run X" link needs the host's open-run callback; omitted by default (most cases are lineage-independent). */
    withOpenRunCallback?: boolean;
  } = {},
) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(WorkflowRunSidePane, {
        tab,
        ...(options.withActorCallback === false ? {} : { onOpenWorkflowActorSession }),
        ...(options.withArtifactCallback === false ? {} : { onOpenWorkflowArtifact }),
        ...(options.withWorkspaceCallback === false ? {} : { onOpenWorkflowWorkspace }),
        ...(options.withOpenRunCallback === true ? { onOpenWorkflowRun } : {}),
      }),
    ),
  );
}

// The pending-questions section is collapsed by default, so any **item-level** assertion has to
// expand it first. This helper keeps "expand first" to one line per case, leaving the reader's
// attention for what is actually being pinned.
type Pane = ReturnType<typeof renderPane>;
/**
 * Rerenders the same tree after the projection changed (the rows are live, not a snapshot from
 * open time). The pane is a memo component; in the real app the projection advances via a
 * context subscription, while here the projection is a mocked module variable, so we hand it a
 * new tab object to let memo through.
 */
function rerenderPane(view: Pane, locale: "en-US" | "zh-CN" = "en-US"): Pane {
  view.rerender(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(WorkflowRunSidePane, { tab: { ...tab }, onOpenWorkflowActorSession }),
    ),
  );
  return view;
}

beforeEach(() => {
  // This repo's vitest does not enable globals, so @testing-library's auto cleanup never
  // registers; without an explicit cleanup the previous case's DOM lingers and getByTestId
  // starts reporting "found multiple elements".
  cleanup();
  sendCommand.mockClear();
  workflowRunsQuery.mockClear();
  workflowRunsQuery.mockImplementation(async () => ({ runs: [] }));
  workflowRunArtifactsQuery.mockClear();
  workflowRunArtifactsQuery.mockImplementation(async () => ({ artifacts: [] }));
  workflowRunArtifactDataQuery.mockClear();
  workflowRunArtifactDataQuery.mockImplementation(async () => ({ items: [], hasMore: false }));
  onOpenWorkflowActorSession.mockClear();
  onOpenWorkflowArtifact.mockClear();
  onOpenWorkflowWorkspace.mockClear();
  setDynamicWorkflowEnabled(true);
  setSnapshot({ run: run() });
});

describe("WorkflowRunSidePane 状态头与阶段清单", () => {
  it("阶段清单按声明序一节一阶段，正在运行的阶段自己展开", () => {
    // docs/dynamic-workflow/presentation.md "The spine": the timeline reads as a vertical checklist.
    setSnapshot({
      run: run({ nodes: [{ siteId: "ask#2", ordinal: 1, phase: "executing" }] }),
      phased: true,
    });
    const view = renderPane();

    const phases = view.getAllByTestId("workflow-run-phase");
    expect(phases.map((phase) => phase.getAttribute("data-phase-id"))).toEqual([
      "phase#a",
      "phase#b",
    ]);
    expect(phases.map((phase) => phase.textContent)).toEqual([
      expect.stringContaining("plan"),
      expect.stringContaining("review"),
    ]);
    expect(phases[1]!.getAttribute("data-phase-status")).toBe("running");
    expect(phases[1]!.getAttribute("data-phase-open")).toBe("true");
    expect(phases[0]!.getAttribute("data-phase-status")).toBe("pending");
    expect(phases[0]!.getAttribute("data-phase-open")).toBe("false");
  });

  it("运行阶段变化时把新的那一节打开，已展开的不动", () => {
    setSnapshot({
      run: run({ nodes: [{ siteId: "ask#1", ordinal: 1, phase: "executing" }] }),
      phased: true,
    });
    const view = renderPane();
    expect(view.getAllByTestId("workflow-run-phase")[0]!.getAttribute("data-phase-open")).toBe(
      "true",
    );

    setSnapshot({
      run: run({
        nodes: [
          { siteId: "ask#1", ordinal: 1, phase: "settled", outcome: "ok" },
          { siteId: "world-read#1", ordinal: 1, phase: "settled", outcome: "ok" },
          { siteId: "ask#2", ordinal: 1, phase: "executing" },
        ],
      }),
      phased: true,
    });
    rerenderPane(view);
    const phases = view.getAllByTestId("workflow-run-phase");
    expect(phases.map((phase) => phase.getAttribute("data-phase-open"))).toEqual(["true", "true"]);
    expect(phases[0]!.getAttribute("data-phase-status")).toBe("done");
  });

  it("脊线：轨道段按模型的墨迹分两截画在相邻两站上，灯带状态，行进段在进入运行站的那一段", () => {
    // docs/dynamic-workflow/presentation.md "The spine". plan is settled, review is running:
    // the a→b rail segment is marching; plan's lamp is green, review's amber with a pulse.
    setSnapshot({
      run: run({
        nodes: [
          { siteId: "ask#1", ordinal: 1, phase: "settled", outcome: "ok" },
          { siteId: "world-read#1", ordinal: 1, phase: "settled", outcome: "ok" },
          { siteId: "ask#2", ordinal: 1, phase: "executing" },
        ],
      }),
      phased: true,
    });
    const view = renderPane();
    const rails = view.getAllByTestId("workflow-run-spine-rail");
    // Both halves must carry `data-rail-position`: the stylesheet picks the marching gradient by
    // it (lower half fades in, upper half ramps to full).
    expect(rails.map((rail) => rail.getAttribute("data-rail-position"))).toEqual([
      "below",
      "above",
    ]);
    expect(rails.map((rail) => rail.getAttribute("data-rail-ink"))).toEqual(["march", "march"]);
    expect(rails[0]!.className).toContain("wf-spine-march");
    expect(rails[0]!.className).toContain("w-[1.5px]");
    const lamps = view.getAllByTestId("workflow-run-phase-lamp");
    expect(lamps.map((lamp) => lamp.getAttribute("data-lamp"))).toEqual(["done", "running"]);
    expect(lamps[1]!.className).toContain("wf-lamp-running");
    // The lamp sits inside the section-header button: the existing `.wf-station-open:hover
    // .wf-lamp` halo rule keeps working when the header is hovered.
    expect(lamps[0]!.closest('[data-testid="workflow-run-phase-toggle"]')).toBeTruthy();
  });

  it("脊线：没有边的相邻两站之间不画轨道段；折起的阶段在节头带头像串，展开后头像串让位给药丸", () => {
    setSnapshot({
      run: run({ nodes: [{ siteId: "ask#2", ordinal: 1, phase: "executing" }] }),
      phased: true,
    });
    const view = renderPane();
    // plan collapsed: the avatar cluster is present (planner + workspace = 2 avatars, no +n);
    // review expanded: no avatar cluster.
    const [plan, review] = view.getAllByTestId("workflow-run-phase");
    const cluster = within(plan!).getByTestId("workflow-run-phase-cluster");
    expect(cluster.querySelectorAll("[title]")).toHaveLength(2);
    expect(cluster.className).toContain("gap-1");
    expect(cluster.querySelector(".rounded-full")).toBeNull();
    expect(cluster.querySelectorAll("img.size-4, svg.size-4")).toHaveLength(2);
    expect(cluster.textContent).not.toContain("+");
    expect(within(review!).queryByTestId("workflow-run-phase-cluster")).toBeNull();
    // After expanding plan, the avatar cluster disappears and pills appear.
    fireEvent.click(within(plan!).getByTestId("workflow-run-phase-toggle"));
    expect(within(plan!).queryByTestId("workflow-run-phase-cluster")).toBeNull();
    expect(within(plan!).getAllByTestId("workflow-agent-pill").length).toBeGreaterThan(0);
  });

  it("脊线：无边的图没有轨道段；轮次写成 ⟳ n 而不是灯串", () => {
    setSnapshot({
      run: run({ nodes: [{ siteId: "ask#2", ordinal: 1, phase: "executing" }] }),
      phased: true,
    });
    // Remove the edges: rail segments are absent entirely (adjacent stations without an edge
    // stay blank, same rule as the cards).
    snapshot = {
      ...(snapshot as { rows: { window: { display: { causalityGraph: object } }[] } }),
      rows: {
        window: (
          snapshot as { rows: { window: { display: { causalityGraph: object } }[] } }
        ).rows.window.map((row) => ({
          ...row,
          display: {
            ...row.display,
            causalityGraph: { ...row.display.causalityGraph, phaseEdges: [] },
          },
        })),
      },
    };
    const view = renderPane();
    expect(view.queryAllByTestId("workflow-run-spine-rail")).toHaveLength(0);
    expect(view.queryByTestId("workflow-run-phase-rounds")).toBeNull();
  });

  it("渲染 run 状态词（灯旁永远有词）", () => {
    setSnapshot({ run: run({ status: "completed" }) });
    const view = renderPane();
    expect(view.getByTestId("workflow-run-status").textContent).toBe("Completed");
  });

  it("直接启动（无工具行）时从启动轮元数据取图（docs/dynamic-workflow/launch.md）", () => {
    const launchRow = {
      kind: "userInput" as const,
      rowId: "row-launch",
      text: "Started the saved workflow",
      origin: "workflowLaunch" as const,
      workflowLaunch: {
        runId: "dwfrun-1",
        toolCallId: "tool-wf-1",
        name: "Fan-out review",
        scope: "project" as const,
        path: "/workspace/.zcode/workflows/fan-out-review.dwf.ts",
        display: graphRow.display,
        script: "export default async function main() {}",
      },
    };
    snapshot = {
      rows: { window: [launchRow] },
      workflowRuns: { revision: 1, runs: [run()] },
    };
    const view = renderPane();
    expect(view.getByTestId("workflow-run-phases")).toBeTruthy();
    expect(view.queryByTestId("workflow-run-graph-unavailable")).toBeNull();
  });

  // Provenance of a direct launch (docs/dynamic-workflow/launch.md "The launch turn"): scope,
  // description, args, and "Started by you from the workflows hub · time" are stated only here —
  // the run card in the chat area is identical to a tool-path launch.
  it("直接启动的 run：状态头下有来龙去脉节——脚注、作用域徽标、说明、实参表", () => {
    const workflowLaunch = {
      runId: "dwfrun-1",
      toolCallId: "tool-wf-1",
      name: "Fan-out review",
      scope: "global" as const,
      path: "/home/u/.zcode/workflows/fan-out-review.dwf.ts",
      description: "Review a change from several angles.",
      args: { topic: "adaptive concurrency", depth: 3 },
      display: graphRow.display,
    };
    snapshot = {
      rows: {
        window: [
          {
            kind: "turnHeader" as const,
            rowId: "row-header",
            origin: "workflowLaunch" as const,
            executionKind: "controlOnly" as const,
            state: "completedSuccess" as const,
            startedAt: Date.UTC(2026, 8, 14, 13, 34),
            workflowLaunch,
          },
          {
            kind: "userInput" as const,
            rowId: "row-launch",
            text: "Started the saved workflow",
            origin: "workflowLaunch" as const,
            workflowLaunch,
          },
        ],
      },
      workflowRuns: { revision: 1, runs: [run()] },
    };
    const view = renderPane();
    const provenance = view.getByTestId("workflow-run-provenance");
    expect(provenance.getAttribute("data-workflow-launch-scope")).toBe("global");
    expect(provenance.textContent).toContain("Started by you from the workflows hub");
    expect(provenance.textContent).toContain(" · ");
    expect(view.getByTestId("workflow-run-provenance-scope").textContent).toBe("Global");
    expect(provenance.textContent).toContain("Review a change from several angles.");
    const args = view.getByTestId("workflow-run-provenance-args").textContent ?? "";
    expect(args).toContain("topic");
    expect(args).toContain("adaptive concurrency");
    expect(args).toContain("depth");
    expect(args).toContain("3");
    // Provenance comes after the status header and before the result section / spine.
    const header = view.getByTestId("workflow-run-status").closest("div.border-b")!;
    expect(
      header.compareDocumentPosition(provenance) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(view.getByTestId("workflow-run-phases")).toBeTruthy();
  });

  it("工具路径发起的 run 没有来龙去脉节", () => {
    setSnapshot({ run: run() });
    const view = renderPane();
    expect(view.queryByTestId("workflow-run-provenance")).toBeNull();
  });

  it("行窗口里翻不到那条工具调用时给出「没有图」而不是空清单", () => {
    setSnapshot({ run: run(), withGraphRow: false });
    const view = renderPane();
    expect(view.queryByTestId("workflow-run-phases")).toBeNull();
    expect(view.getByTestId("workflow-run-graph-unavailable").textContent).toContain(
      "not in this conversation's visible history",
    );
  });
});

// ── Subagent model (docs/dynamic-workflow/presentation.md "The run pane") ──
// At launch the user pinned this run's subagents to a different model; the main agent stays on
// the session model, so only subagents are mentioned.
// The status header's first line **no longer** holds a model chip (it does not fit; what
// survives truncation is exactly the provider id): the model name became the first segment of
// the usage line — that line is already "this run's handful of numbers". The canonical string
// and the reasoning level retreat into the tooltip.
// For a run without a specified model the whole segment is absent — following the session model
// is the norm, nothing to say.
describe("WorkflowRunSidePane 子代理模型", () => {
  // The team plan's provider id is a string of hex: exactly what this change keeps off screen.
  const TEAM_PLAN_MODEL = "4fc7f541-2382-4c32-be11-f021b8d7ed1d/GLM-5.3-Flash$high";

  it("模型名是摘要行的第一段，不再是状态头上的芯片", () => {
    setSnapshot({ run: run({ subagentModel: "zhipu/glm-5.3-flash" }) });
    const view = renderPane();

    const segment = view.getByTestId("workflow-run-subagent-model");
    expect(segment.textContent).toBe("Subagents glm-5.3-flash");
    // It lives in the usage line, not the status header row (the row shared with the concurrency
    // chip and the Stop button).
    expect(segment.closest('[data-testid="workflow-run-usage"]')).not.toBeNull();
    const summary = view.getByTestId("workflow-run-usage").textContent ?? "";
    expect(summary.indexOf("Subagents glm-5.3-flash")).toBe(0);
  });

  it("屏幕上绝不出现 provider id，哪怕它是团队套餐的 UUID；规范串退进 tooltip", () => {
    setSnapshot({ run: run({ subagentModel: TEAM_PLAN_MODEL }) });
    const view = renderPane();

    const segment = view.getByTestId("workflow-run-subagent-model");
    expect(segment.textContent).toBe("Subagents GLM-5.3-Flash");
    expect(segment.textContent).not.toContain("4fc7f541");
    expect(document.body.textContent).not.toContain("4fc7f541");
    expect(segment.getAttribute("title")).toContain(TEAM_PLAN_MODEL);
    // The reasoning level stays off screen; it lives in the tooltip together with the canonical
    // string.
    expect(segment.getAttribute("title")).toContain("thinking High");
  });

  it("zh-CN 下同一段说中文，模型名原样不译", () => {
    setSnapshot({ run: run({ subagentModel: TEAM_PLAN_MODEL }) });
    const view = renderPane("zh-CN");

    expect(view.getByTestId("workflow-run-subagent-model").textContent).toBe(
      "子代理 GLM-5.3-Flash",
    );
  });

  it("图不可得（建不出时间线）退回用量行时，模型仍在行首：它与有没有图无关", () => {
    setSnapshot({
      run: run({ subagentModel: TEAM_PLAN_MODEL, usage: { spentTokens: 12_345, nodesUsed: 3 } }),
      withGraphRow: false,
    });
    const view = renderPane();

    const segment = view.getByTestId("workflow-run-subagent-model");
    expect(segment.textContent).toBe("Subagents GLM-5.3-Flash");
    expect(document.body.textContent).not.toContain("4fc7f541");
    expect(segment.getAttribute("title")).toContain(TEAM_PLAN_MODEL);
    // Within the same line the model comes first; the usage label and readings still follow.
    const usage = view.getByTestId("workflow-run-usage").textContent ?? "";
    expect(usage.indexOf("Subagents GLM-5.3-Flash")).toBe(0);
    expect(usage).toContain("Usage");
    expect(usage).toContain("12,345 tokens · 3 steps");
  });

  it("没指定过模型的 run 里整段缺席（子代理跟随会话模型）", () => {
    setSnapshot({ run: run() });
    const view = renderPane();

    expect(view.queryByTestId("workflow-run-subagent-model")).toBeNull();
    expect(document.body.textContent).not.toContain("Subagents ");
  });

  it("run 不在投影里（被淘汰 / 冷启动）时也没有这一段", () => {
    setSnapshot({});
    const view = renderPane();

    expect(view.queryByTestId("workflow-run-subagent-model")).toBeNull();
  });
});

describe("WorkflowRunSidePane 摘要行", () => {
  it("与聊天卡页脚同文案：工作中的子代理数、步数、token，没有上限、没有进度轨", () => {
    setSnapshot({
      run: run({
        usage: { spentTokens: 12_345, nodesUsed: 3 },
        actors: [{ siteId: "actor#1", ordinal: 1, status: "running" }],
        nodes: [{ siteId: "ask#1", ordinal: 1, phase: "executing" }],
      }),
    });
    const view = renderPane();
    const usage = view.getByTestId("workflow-run-usage").textContent ?? "";
    expect(usage).toContain("1 agent working");
    expect(usage).toContain("0/1 steps");
    expect(usage).toContain("12,345 tokens");
    expect(usage).not.toContain("%");
    expect(view.container.querySelector("progress")).toBeNull();
  });

  it("图不可得（建不出时间线）时退回用量行", () => {
    setSnapshot({
      run: run({ usage: { spentTokens: 12_345, nodesUsed: 3 } }),
      withGraphRow: false,
    });
    const view = renderPane();
    const usage = view.getByTestId("workflow-run-usage").textContent ?? "";
    expect(usage).toContain("Usage");
    expect(usage).toContain("12,345 tokens · 3 steps");
  });

  // Instance table overflow (docs/dynamic-workflow/presentation.md "The run pane"): the usage
  // line's step count already includes the unlisted instances, but the spine can only list those
  // in the table — this sentence states exactly that difference.
  it("撞界的 run 在摘要行下多一句「仅展示 n/m 步的详情」，计数仍是真实步数", () => {
    setSnapshot({
      run: run({
        usage: {
          spentTokens: 1,
          nodesUsed: 1_100,
          nodesUnlisted: 2_000,
          nodesUnlistedSettled: 1_500,
        },
        nodes: [{ siteId: "ask#1", ordinal: 1, phase: "settled", outcome: "ok" }],
        truncated: true,
      }),
    });
    const view = renderPane();
    expect(view.getByTestId("workflow-run-truncated").textContent).toBe(
      "Details shown for 1 of 2001 steps",
    );
    expect(view.getByTestId("workflow-run-usage").textContent ?? "").toContain("1501/2001 steps");
  });

  it("没撞界、以及只有小表撞界（步数一个不少）的 run 都没有这一句", () => {
    setSnapshot({ run: run({ nodes: [{ siteId: "ask#1", ordinal: 1, phase: "settled" }] }) });
    expect(renderPane().queryByTestId("workflow-run-truncated")).toBeNull();
    cleanup();
    // `truncated` can also be set by reports / artifacts / phases hitting their caps; in that
    // case saying "details shown for 1 of 1 steps" would be a tautology.
    setSnapshot({
      run: run({ nodes: [{ siteId: "ask#1", ordinal: 1, phase: "settled" }], truncated: true }),
    });
    expect(renderPane().queryByTestId("workflow-run-truncated")).toBeNull();
  });

  it("zh-CN 念「仅展示 1/2,001 步的详情」", () => {
    setSnapshot({
      run: run({
        usage: { spentTokens: 1, nodesUsed: 1, nodesUnlisted: 2_000 },
        nodes: [{ siteId: "ask#1", ordinal: 1, phase: "queued" }],
        truncated: true,
      }),
    });
    expect(renderPane("zh-CN").getByTestId("workflow-run-truncated").textContent).toBe(
      "仅展示 1/2001 步的详情",
    );
  });
});

describe("WorkflowRunSidePane Stop", () => {
  it("running 时可点，并且走既有的 cancelBackgroundWork {workId ≡ runId}", () => {
    setSnapshot({ run: run({ status: "running" }) });
    const view = renderPane();
    const button = view.getByTestId<HTMLButtonElement>("workflow-run-cancel");
    expect(button.disabled).toBe(false);

    fireEvent.click(button);

    expect(sendCommand).toHaveBeenCalledTimes(1);
    const envelope = sendCommand.mock.calls[0]![0] as unknown as {
      type: string;
      sessionId: string;
      payload: { workId: string };
    };
    expect(envelope.type).toBe("cancelBackgroundWork");
    expect(envelope.payload).toEqual({ workId: "dwfrun-1" });
    expect(envelope.sessionId).toBe("parent-a");
  });

  it.each(["pending", "completed", "errored", "stopped"] as const)("%s 时按钮禁用", (status) => {
    setSnapshot({ run: run({ status }) });
    const view = renderPane();
    expect(view.getByTestId<HTMLButtonElement>("workflow-run-cancel").disabled).toBe(true);
  });

  it("run 不在投影里时按钮禁用（对它的在飞状态一无所知）", () => {
    setSnapshot({});
    const view = renderPane();
    expect(view.getByTestId<HTMLButtonElement>("workflow-run-cancel").disabled).toBe(true);
  });

  it("按钮说 Stop run，图标与卡上那枚同款：实心方块", () => {
    setSnapshot({ run: run({ status: "running" }) });
    const view = renderPane();
    const button = view.getByTestId("workflow-run-cancel");
    expect(button.getAttribute("aria-label")).toBe("Stop run");
    expect(button.textContent).toContain("Stop run");
    // Same shape as WorkflowRunDigest's Stop button: a square filled with currentColor, not a
    // cross.
    const icon = button.querySelector("svg");
    expect(icon?.getAttribute("class")).toContain("fill-current");
    expect(icon?.querySelector("rect")).toBeTruthy();
  });

  it("可点时提示带第二行「停下的运行可以恢复」；禁用时只剩为什么不可用", () => {
    setSnapshot({ run: run({ status: "running" }) });
    renderPane();
    expect(tooltips.calls.find((call) => call.title === "Stop run")?.description).toBe(
      "You can resume later; finished steps are kept.",
    );

    cleanup();
    tooltips.calls.length = 0;
    setSnapshot({ run: run({ status: "completed" }) });
    renderPane();
    const disabled = tooltips.calls.find(
      (call) => call.title === "Only a running workflow can be stopped.",
    );
    expect(disabled).toBeTruthy();
    expect(disabled?.description).toBeUndefined();
  });
});

// Reason for the fix (2026-09-15, observed on desktop): when an old run was wrongly left in
// running, Cancel clicks did nothing; Resume hitting a script that no longer compiles likewise
// only left a warn in the console. Rejected ACKs now become a sentence under the status header,
// per the reason-code vocabulary.
describe("WorkflowRunSidePane 被拒提示", () => {
  it("cancel 被拒（not_found）→ 状态头下出现一句话；run 状态一变即收起", async () => {
    setSnapshot({ run: run({ status: "running" }) });
    sendCommand.mockResolvedValueOnce({
      status: "failed",
      reasonCode: "fault.command.backgroundWorkCancelRejected.not_found",
    } as never);
    const view = renderPane();

    fireEvent.click(view.getByTestId("workflow-run-cancel"));

    const hint = await view.findByTestId("workflow-run-rejection");
    expect(hint.textContent).toContain("not running in this agent");
    // The button is not locked out: the hint only explains, it does not change clickability.
    expect(view.getByTestId<HTMLButtonElement>("workflow-run-cancel").disabled).toBe(false);

    setSnapshot({ run: run({ status: "stopped", stopReason: "user" }) });
    rerenderPane(view);
    expect(view.queryByTestId("workflow-run-rejection")).toBeNull();
  });

  it("resume 被拒（compile_failed）→ 一句话指向调整工作流 + ACK 的诊断在等宽块里", async () => {
    setSnapshot({ run: run({ status: "stopped", resumable: true }) });
    sendCommand.mockResolvedValueOnce({
      status: "failed",
      reasonCode: "fault.command.workflowRunResumeRejected.compile_failed",
      message: "L3:C1 Property 'askWithOldFacade' does not exist",
    } as never);
    const view = renderPane();

    fireEvent.click(await view.findByTestId("workflow-run-resume"));

    const hint = await view.findByTestId("workflow-run-rejection");
    expect(hint.textContent).toContain("no longer compiles");
    expect(hint.textContent).toContain("amend the workflow");
    expect(hint.querySelector("pre")?.textContent).toContain("askWithOldFacade");
  });

  it("词表外的 reasonCode → 通用文案带 code；accepted 不出提示", async () => {
    setSnapshot({ run: run({ status: "running" }) });
    sendCommand.mockResolvedValueOnce({
      status: "failed",
      reasonCode: "fault.command.executionFailed",
    } as never);
    const view = renderPane();

    fireEvent.click(view.getByTestId("workflow-run-cancel"));
    const hint = await view.findByTestId("workflow-run-rejection");
    expect(hint.textContent).toContain("fault.command.executionFailed");

    setSnapshot({ run: run({ status: "stopped" }) });
    rerenderPane(view);
    setSnapshot({ run: run({ status: "running" }) });
    rerenderPane(view);
    fireEvent.click(view.getByTestId("workflow-run-cancel"));
    await Promise.resolve();
    await Promise.resolve();
    expect(view.queryByTestId("workflow-run-rejection")).toBeNull();
  });

  it("zh-CN 文案", async () => {
    setSnapshot({ run: run({ status: "running" }) });
    sendCommand.mockResolvedValueOnce({
      status: "failed",
      reasonCode: "fault.command.backgroundWorkCancelRejected.not_running",
    } as never);
    const view = renderPane("zh-CN");
    fireEvent.click(view.getByTestId("workflow-run-cancel"));
    expect((await view.findByTestId("workflow-run-rejection")).textContent).toContain("已经结束");
  });
});

describe("WorkflowRunSidePane 结果与失败面板", () => {
  it("completed 且无 resultPreview 时指向会话里的后台结果消息，不编造结果", () => {
    setSnapshot({ run: run({ status: "completed" }) });
    const view = renderPane();
    expect(view.getByTestId("workflow-run-result").textContent).toContain(
      "delivered to the conversation as a background result message",
    );
  });

  it("errored 时原样呈现投影给出的错误原文", () => {
    setSnapshot({ run: run({ status: "errored", error: "节点数超过上限 100" }) });
    const view = renderPane();
    const panel = view.getByTestId("workflow-run-error");
    expect(panel.textContent).toContain("Run errored");
    expect(panel.textContent).toContain("节点数超过上限 100");
  });

  it("错误原文按正文排版，不用等宽字体", () => {
    // What the projection writes into error is WorkflowErrorJson.message (product-projection.ts's
    // run-settled branch keeps only .message and drops the code), and those messages are short
    // human sentences — "run 已取消", "typed ask 结束时未提交结果", "节点数超过上限 100". DESIGN.md
    // reserves font-mono for paths/commands/code/identifiers/terminal data; a human sentence
    // belongs to none of those categories.
    setSnapshot({ run: run({ status: "errored", error: "typed ask 结束时未提交结果" }) });
    const view = renderPane();
    const message = view.getByTestId("workflow-run-error-message");
    expect(message.className).not.toContain("font-mono");
    // pre-wrap is still kept: if the message ever carries newlines they must not be collapsed.
    expect(message.className).toContain("whitespace-pre-wrap");
  });

  it("stopped 且没有错误详情时说明没有，而不是留一片空白", () => {
    setSnapshot({ run: run({ status: "stopped" }) });
    const view = renderPane();
    const panel = view.getByTestId("workflow-run-error");
    expect(panel.textContent).toContain("Run stopped");
    expect(panel.textContent).toContain("No error detail was recorded.");
  });

  it("stopped 带原因：标题与状态头都跟原因词（决策 15）", () => {
    setSnapshot({
      run: run({ status: "stopped", stopReason: "provider", error: "Sign-in expired." } as never),
    });
    const view = renderPane();
    expect(view.getByTestId("workflow-run-stop-reason").textContent).toContain("model error");
    expect(view.getByTestId("workflow-run-status-reason").textContent).toContain("model error");
    expect(view.getByTestId("workflow-run-error").textContent).toContain("Sign-in expired.");
  });

  // The verb "stopped" cannot express the consequence, so the consequence goes back to the
  // status line: resumable is a state bit carried by the projection, not inferred from status.
  it("状态行第三个词：run 带 resumable 时说「resumable」，不带就没有那个词", () => {
    setSnapshot({ run: run({ status: "stopped", stopReason: "user", resumable: true }) });
    const withBit = renderPane();
    expect(withBit.getByTestId("workflow-run-status-resumable").textContent).toContain(
      expectedCopy("chat.toolCall.workflow.run.resumable"),
    );
    expect(withBit.getByTestId("workflow-run-status-reason").textContent).toContain("by you");

    cleanup();
    setSnapshot({ run: run({ status: "stopped", stopReason: "user" }) });
    const without = renderPane();
    expect(without.queryByTestId("workflow-run-status-resumable")).toBeNull();

    cleanup();
    setSnapshot({ run: run({ status: "stopped", stopReason: "user", resumable: true }) });
    const zh = renderPane("zh-CN");
    expect(zh.getByTestId("workflow-run-status-resumable").textContent).toContain(
      zhCN["chat.toolCall.workflow.run.resumable"],
    );
  });

  it("running 时既没有结果面板也没有失败面板", () => {
    setSnapshot({ run: run({ status: "running" }) });
    const view = renderPane();
    expect(view.queryByTestId("workflow-run-result")).toBeNull();
    expect(view.queryByTestId("workflow-run-error")).toBeNull();
  });
});

describe("WorkflowRunSidePane 升级问题", () => {
  const NOW = 1_756_000_000_000;
  const MINUTE = 60_000;
  const questions = [
    {
      qid: "dwfq-dwfrun1-1",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorName: "poet",
      question: "评分上限是 95，但通过门槛是 96，这个门是不是坏了？",
      context: "已经试过 4 轮，最高分 95。",
      askedAt: NOW - 42 * MINUTE,
    },
    {
      qid: "dwfq-dwfrun1-2",
      actorSiteId: "actor#2",
      actorOrdinal: 3,
      question: "用哪版风格指南？",
      askedAt: NOW - 90 * MINUTE,
    },
  ];
  const askers = () =>
    run({
      actors: [
        { siteId: "actor#1", ordinal: 1, name: "poet", sessionId: "s-1", status: "waiting" },
        { siteId: "actor#2", ordinal: 3, sessionId: "s-2", status: "waiting" },
      ],
      nodes: [
        {
          siteId: "ask#1",
          ordinal: 1,
          phase: "executing",
          actorSiteId: "actor#1",
          actorOrdinal: 1,
        },
        { siteId: "ask#2", ordinal: 3, phase: "waiting", actorSiteId: "actor#2", actorOrdinal: 3 },
      ],
      pendingQuestions: questions,
    });

  it("挂在提问者那一行下面：问题紧跟匹配 site@ordinal 的子代理药丸", () => {
    setSnapshot({ run: askers() });
    const view = renderPane();

    const rows = view.getAllByTestId("workflow-run-question");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.getAttribute("data-qid")).toBe("dwfq-dwfrun1-1");
    const pill = rows[0]!.previousElementSibling as HTMLElement;
    expect(pill.getAttribute("data-testid")).toBe("workflow-agent-pill");
    expect(pill.textContent).toContain("poet");
    expect(rows[0]!.textContent).toContain("这个门是不是坏了？");
    expect(rows[0]!.textContent).toContain("已经试过 4 轮，最高分 95。");
    // The qid is the token the main agent needs to answer; the user cannot answer, but can point
    // at it and have the main agent answer.
    expect(rows[0]!.textContent).toContain("dwfq-dwfrun1-1");
    // A question attached under a row does not repeat the asker's name.
    expect(rows[0]!.textContent).not.toContain("poet");
    expect(view.queryByTestId("workflow-run-orphan-questions")).toBeNull();
  });

  it("每条带等待时长（读者的第一个问题恒是「这个已经等了多久」）", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      setSnapshot({ run: askers() });
      const view = renderPane();
      const waited = view.getAllByTestId("workflow-run-question-waited");
      expect(waited[0]!.textContent).toBe("42m ago");
      expect(waited[1]!.textContent).toBe("1h ago");
    } finally {
      vi.useRealTimers();
    }
  });

  it("等待时长自己走时钟：run 在等答案时不发事件，靠投影更新会一直显示「刚刚」", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      setSnapshot({ run: askers() });
      const view = renderPane();
      const before = view.getAllByTestId("workflow-run-question-waited")[0]!.textContent;
      act(() => {
        vi.advanceTimersByTime(20 * MINUTE);
      });
      const after = view.getAllByTestId("workflow-run-question-waited")[0]!.textContent;
      expect(after).not.toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("askedAt 缺席（老 journal 重放）时不渲染时长，绝不编一个「刚刚」", () => {
    const { askedAt: _dropped, ...withoutAskedAt } = questions[0]!;
    setSnapshot({ run: { ...askers(), pendingQuestions: [withoutAskedAt] } });
    const view = renderPane();
    expect(view.getAllByTestId("workflow-run-question")).toHaveLength(1);
    expect(view.queryByTestId("workflow-run-question-waited")).toBeNull();
  });

  it("匹配不上提问者的问题挂在清单末尾，并自报名字（站点实例标签 / 匿名兜底）", () => {
    setSnapshot({
      run: run({
        pendingQuestions: [
          { qid: "q-a", actorSiteId: "actor#9", actorOrdinal: 2, question: "谁来审？" },
          { qid: "q-b", question: "没有主语的问题" },
        ],
      }),
    });
    const view = renderPane();
    const block = view.getByTestId("workflow-run-orphan-questions");
    expect(block.textContent).toContain("Waiting on an answer");
    const rows = view.getAllByTestId("workflow-run-question");
    expect(rows[0]!.textContent).toContain("actor#9@2");
    expect(rows[1]!.textContent).toContain("Anonymous Subagent");
  });

  it("v1 只读：清单里没有任何输入控件或应答按钮", () => {
    setSnapshot({ run: askers() });
    const view = renderPane();
    const list = view.getByTestId("workflow-run-phases");
    expect(list.querySelectorAll("input, textarea").length).toBe(0);
    expect(list.textContent).not.toContain("Answer");
  });

  it("零条时没有问题行，也没有末尾的孤儿块（键缺席与空数组两种形态都一样）", () => {
    setSnapshot({ run: run({ pendingQuestions: [] }) });
    let view = renderPane();
    expect(view.queryAllByTestId("workflow-run-question")).toHaveLength(0);
    expect(view.queryByTestId("workflow-run-orphan-questions")).toBeNull();
    cleanup();
    setSnapshot({ run: run() });
    view = renderPane();
    expect(view.queryAllByTestId("workflow-run-question")).toHaveLength(0);
  });

  it("zh-CN 下等待时长与孤儿块标题都本地化，且没有英文兜底漏出来", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      setSnapshot({
        run: run({
          pendingQuestions: [
            { qid: "q-b", question: "没有主语的问题", askedAt: NOW - 42 * MINUTE },
          ],
        }),
      });
      const view = renderPane("zh-CN");
      const text = view.getByTestId("workflow-run-orphan-questions").textContent ?? "";
      expect(text).toContain(zhCN["chat.toolCall.workflow.run.questions.title"]);
      expect(text).toContain("42 分钟前");
      expect(text).toContain(zhCN["chat.toolCall.workflow.graph.lane.anonymous"]);
      expect(text).not.toContain("Waiting on an answer");
      expect(text).not.toContain("ago");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("WorkflowRunSidePane 淘汰 / 冷启动空态", () => {
  it("run 不在 workflowRuns 里时 tab 仍然打开，措辞只说实时状态没了", () => {
    setSnapshot({});
    const view = renderPane();
    const panel = view.getByTestId("workflow-run-untracked");
    expect(panel.textContent).toContain("No longer tracked live");
    // Key: this must not read as "this run no longer exists" — the journal record is still
    // complete, which is exactly why the tab is kept (artifacts can still be listed; see the
    // artifacts-section case).
    expect(panel.textContent).toContain("record is still complete");
  });
});

describe("WorkflowRunSidePane 国际化", () => {
  it("状态头、用量、Stop 与结果在 zh-CN 下全部本地化", () => {
    setSnapshot({
      run: run({
        status: "completed",
        usage: { spentTokens: 1_000, nodesUsed: 3 },
      }),
    });
    const view = renderPane("zh-CN");
    const text = view.container.textContent ?? "";

    expect(view.getByTestId("workflow-run-status").textContent).toBe("已完成");
    expect(text).toContain(zhCN["chat.toolCall.workflow.run.cancel"]);
    // The usage line shares copy with the chat card footer: three subagent lanes + steps + tokens.
    expect(view.getByTestId("workflow-run-usage").textContent).toContain("3 个子代理");
    expect(view.getByTestId("workflow-run-usage").textContent).toContain("1,000 tokens");
    expect(text).toContain("结果");
    // No English fallback leaks through.
    expect(text).not.toContain("Stop run");
    // The old verb is fully retired.
    expect(text).not.toContain("取消运行");
  });
});

// ── Subagent rows in the phase checklist (docs/dynamic-workflow/presentation.md "The spine") ──
// The same pill as on the cards, plus "what it is doing now" (the current step's label), a count,
// a status mark, and the arrow that opens the transcript.
describe("WorkflowRunSidePane 子代理行", () => {
  function actor(overrides: Record<string, unknown> = {}) {
    return {
      siteId: "actor#1",
      ordinal: 1,
      sessionId: "dwf-dwfrun-1-actor_1@1",
      status: "waiting" as const,
      ...overrides,
    };
  }
  const executing = (actorOrdinal = 1) => ({
    siteId: "ask#1",
    ordinal: actorOrdinal,
    phase: "executing" as const,
    actorSiteId: "actor#1",
    actorOrdinal,
  });

  it("行带运行时名、计数与可读的状态标记；不写当前步的 label（站点名对读者没有信息量）", () => {
    setSnapshot({ run: run({ actors: [actor({ name: "planner" })], nodes: [executing()] }) });
    const view = renderPane();

    const pill = view
      .getAllByTestId("workflow-agent-pill")
      .find((candidate) => candidate.textContent?.includes("planner"))!;
    expect(pill.getAttribute("data-agent-status")).toBe("running");
    expect(pill.querySelector('[data-testid="workflow-run-agent-activity"]')).toBeNull();
    expect(pill.textContent).toContain("1 tasks");
    // Status must not rely on color or shape alone: the mark carries readable text.
    const mark = pill.querySelector('[data-testid="workflow-pill-status"]');
    expect(mark?.getAttribute("aria-label")).toBe("running");
  });

  /** The row-end ↗: one per row (in a live run every subagent pill can be opened), looked up by the row's name. */
  const openOf = (view: ReturnType<typeof renderPane>, name: string) =>
    view
      .getAllByTestId("workflow-agent-pill")
      .find((candidate) => candidate.textContent?.includes(name))!
      .querySelector('[data-testid="workflow-run-agent-open"]')!;

  it("点行尾箭头开 transcript tab，并带上 tab 自己的 workspace scope", () => {
    setSnapshot({ run: run({ actors: [actor({ name: "planner" })], nodes: [executing()] }) });
    const view = renderPane();

    fireEvent.click(openOf(view, "planner"));
    expect(onOpenWorkflowActorSession).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      runId: "dwfrun-1",
      actorSessionId: "dwf-dwfrun-1-actor_1@1",
      siteId: "actor#1",
      ordinal: 1,
      actorName: "planner",
    });
  });

  it("整行就是按钮：点药丸本身即打开，↗ 只是可打开的可见证据", () => {
    setSnapshot({ run: run({ actors: [actor({ name: "planner" })], nodes: [executing()] }) });
    const view = renderPane();
    const pill = view
      .getAllByTestId("workflow-agent-pill")
      .find((candidate) => candidate.textContent?.includes("planner"))!;
    expect(pill.tagName).toBe("BUTTON");
    expect(pill.getAttribute("aria-label")).toBe("Open the transcript of planner");
    expect(pill.querySelector('[data-testid="workflow-run-agent-open"]')).toBeTruthy();
    // A <button> inside a block-level parent only wraps its content; the row's container is a
    // vertical flex so the pill fills the section's width and every row stays the same width.
    expect(pill.parentElement?.className).toContain("flex-col");
    fireEvent.click(pill);
    expect(onOpenWorkflowActorSession).toHaveBeenCalledTimes(1);
    expect(onOpenWorkflowActorSession).toHaveBeenCalledWith(
      expect.objectContaining({ actorSessionId: "dwf-dwfrun-1-actor_1@1", actorName: "planner" }),
    );
  });

  it("会话未落库的实例仍然成行，也可开：请求带槽位、不带会话 id（tab 里是占位，自愈）", () => {
    // docs/dynamic-workflow/presentation.md "The pill".
    const { sessionId: _absent, ...pending } = actor({ name: "planner" });
    setSnapshot({ run: run({ actors: [pending], nodes: [executing()] }) });
    const view = renderPane();

    const pill = view
      .getAllByTestId("workflow-agent-pill")
      .find((candidate) => candidate.textContent?.includes("planner"))!;
    expect(pill.tagName).toBe("BUTTON");
    expect(pill.className).toContain("wf-pill-open");
    fireEvent.click(pill);
    expect(onOpenWorkflowActorSession).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "dwfrun-1",
        siteId: "actor#1",
        ordinal: 1,
        actorName: "planner",
      }),
    );
    expect(onOpenWorkflowActorSession.mock.calls[0]![0]).not.toHaveProperty("actorSessionId");
  });

  it("还没出现的子代理（静态车道）在活的 run 里同样可开：期望序号 1", () => {
    // The script has not reached its agent() yet: the projection has no such actor, so the pill
    // hands over the lane + the future ordinal.
    setSnapshot({ run: run({ actors: [actor({ name: "planner" })], nodes: [executing()] }) });
    const view = renderPane();
    const opens = view.getAllByTestId("workflow-run-agent-open");
    const absent = opens.find((open) => open.getAttribute("data-agent-session-id") === "")!;
    fireEvent.click(absent);
    const request = onOpenWorkflowActorSession.mock.calls[0]![0] as Record<string, unknown>;
    expect(request).toMatchObject({ runId: "dwfrun-1", ordinal: 1 });
    expect(request.siteId).not.toBe("actor#1");
    expect(request).not.toHaveProperty("actorSessionId");
  });

  it("宿主没有下钻回调时没有任何箭头（回调的存在本身就是门控）", () => {
    setSnapshot({ run: run({ actors: [actor({ name: "planner" })], nodes: [executing()] }) });
    const view = renderPane("en-US", { withActorCallback: false });
    expect(view.queryByTestId("workflow-run-agent-open")).toBeNull();
  });

  it("同一车道两个实例时拆成两行，各开各的 transcript", () => {
    setSnapshot({
      run: run({
        actors: [
          actor({ ordinal: 1, name: "worker-1", sessionId: "s-1" }),
          actor({ ordinal: 2, name: "worker-2", sessionId: "s-2" }),
        ],
        nodes: [executing(1), executing(2)],
      }),
    });
    const view = renderPane();

    const opens = view.getAllByTestId("workflow-run-agent-open");
    const withSession = opens.filter((open) => open.getAttribute("data-agent-session-id") !== "");
    expect(withSession.map((button) => button.getAttribute("data-agent-session-id"))).toEqual([
      "s-1",
      "s-2",
    ]);
    fireEvent.click(withSession[1]!);
    expect(onOpenWorkflowActorSession).toHaveBeenCalledWith(
      expect.objectContaining({ actorSessionId: "s-2", ordinal: 2, actorName: "worker-2" }),
    );
  });

  it("脚本行走自己的那条路（docs/dynamic-workflow/transcript-and-notifications.md）：不开 actor transcript，开整个 run 的脚本 transcript，落到这一站", () => {
    setSnapshot({
      run: run({ nodes: [{ siteId: "world-read#1", ordinal: 1, phase: "executing" }] }),
    });
    const view = renderPane();
    const pill = view
      .getAllByTestId("workflow-agent-pill")
      .find((candidate) => candidate.textContent?.includes("Script"))!;
    expect(pill.querySelector('[data-testid="workflow-run-agent-open"]')).toBeNull();
    expect(pill.textContent).toContain("1 reads");
    expect(pill.tagName).toBe("BUTTON");
    expect(pill.className).toContain("wf-pill-open");
    const open = pill.querySelector('[data-testid="workflow-run-workspace-open"]')!;
    // Unmarked script: the implicit station's id is "workflow", and that is where the landing
    // goes.
    expect(open.getAttribute("data-phase-id")).toBe("workflow");
    fireEvent.click(pill);
    expect(onOpenWorkflowActorSession).not.toHaveBeenCalled();
    expect(onOpenWorkflowWorkspace).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      toolCallId: "tool-wf-1",
      runId: "dwfrun-1",
      workflowName: "Fan-out review",
      phaseId: "workflow",
    });
  });

  it("带阶段的图：脚本行交出所在站的阶段 id；宿主没给回调时它是 span", () => {
    setSnapshot({
      phased: true,
      run: run({ nodes: [{ siteId: "world-read#1", ordinal: 1, phase: "executing" }] }),
    });
    const view = renderPane();
    const pill = view
      .getAllByTestId("workflow-agent-pill")
      .find((candidate) => candidate.textContent?.includes("Script"))!;
    expect(pill.getAttribute("aria-label")).toBe("Open the script's steps at plan");
    fireEvent.click(pill);
    expect(onOpenWorkflowWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ phaseId: "phase#a" }),
    );
    cleanup();

    const bare = renderPane("en-US", { withWorkspaceCallback: false });
    const span = bare
      .getAllByTestId("workflow-agent-pill")
      .find((candidate) => candidate.textContent?.includes("Script"))!;
    expect(span.tagName).toBe("SPAN");
    expect(bare.queryByTestId("workflow-run-workspace-open")).toBeNull();
  });

  it("新实例出现即入列：行是活的，不是打开那一刻的快照", () => {
    const withSession = (view: ReturnType<typeof renderPane>) =>
      view
        .getAllByTestId("workflow-run-agent-open")
        .filter((open) => open.getAttribute("data-agent-session-id") !== "");
    setSnapshot({ run: run({ actors: [actor({ name: "worker-1" })], nodes: [executing()] }) });
    const view = renderPane();
    expect(withSession(view)).toHaveLength(1);

    setSnapshot({
      run: run({
        actors: [
          actor({ name: "worker-1" }),
          actor({ ordinal: 2, name: "worker-2", sessionId: "s-2" }),
        ],
        nodes: [executing(1), executing(2)],
      }),
    });
    rerenderPane(view);
    expect(withSession(view)).toHaveLength(2);
  });

  it("点节头折叠再展开", () => {
    setSnapshot({ run: run({ actors: [actor({ name: "planner" })], nodes: [executing()] }) });
    const view = renderPane();
    const phase = view.getByTestId("workflow-run-phase");
    expect(phase.getAttribute("data-phase-open")).toBe("true");

    fireEvent.click(view.getByTestId("workflow-run-phase-toggle"));
    expect(phase.getAttribute("data-phase-open")).toBe("false");
    expect(view.queryByTestId("workflow-run-agent-open")).toBeNull();

    fireEvent.click(view.getByTestId("workflow-run-phase-toggle"));
    expect(phase.getAttribute("data-phase-open")).toBe("true");
  });

  it("zh-CN 下隐式阶段名、计数与状态标记都本地化", () => {
    setSnapshot({ run: run({ actors: [actor({ name: "planner" })], nodes: [executing()] }) });
    const view = renderPane("zh-CN");
    const list = view.getByTestId("workflow-run-phases");
    expect(list.textContent).toContain("工作流");
    expect(list.textContent).toContain("1 个任务");
    expect(
      list.querySelector('[data-testid="workflow-pill-status"]')?.getAttribute("aria-label"),
    ).toBe("运行中");
    expect(list.textContent).not.toContain("asks");
  });
});

describe("WorkflowRunSidePane Resume", () => {
  it("stopped 且带 resumable 状态位 → 渲染 Resume，点击发 resumeWorkflowRun {workId ≡ runId, name}", async () => {
    setSnapshot({ run: run({ status: "stopped", resumable: true }) });
    const view = renderPane();
    const button = await view.findByTestId<HTMLButtonElement>("workflow-run-resume");

    fireEvent.click(button);

    const resumeCall = sendCommand.mock.calls.find(
      (call) => (call[0] as { type: string }).type === "resumeWorkflowRun",
    );
    expect(resumeCall).toBeDefined();
    const envelope = resumeCall![0] as unknown as {
      type: string;
      sessionId: string;
      payload: { workId: string; name?: string };
    };
    // name feeds the subject of the completion notification after the resume (after a restart
    // the original tool input is unavailable; the tab's display name is the only surviving
    // source).
    expect(envelope.payload).toEqual({ workId: "dwfrun-1", name: "Fan-out review" });
    expect(envelope.sessionId).toBe("parent-a");
  });

  it.each(["pending", "running", "completed"] as const)("%s 不渲染 Resume", async (status) => {
    setSnapshot({ run: run({ status }) });
    const view = renderPane();
    await Promise.resolve();
    expect(view.queryByTestId("workflow-run-resume")).toBeNull();
  });

  it("stopped(interrupted) 且投影带 resumable 状态位（冷回放折叠了行的谓词）→ 渲染 Resume", async () => {
    setSnapshot({
      run: run({
        status: "stopped",
        stopReason: "interrupted",
        error: "owning process exited",
        resumable: true,
      } as never),
    });
    const view = renderPane();
    expect(await view.findByTestId("workflow-run-resume")).toBeDefined();
  });

  it("errored（脚本真失败）→ 不渲染", async () => {
    setSnapshot({ run: run({ status: "errored" }) });
    const view = renderPane();
    await Promise.resolve();
    expect(view.queryByTestId("workflow-run-resume")).toBeNull();
  });

  it("stopped 但无状态位（旧 CLI）→ 不渲染死按钮；不再另查 journal 摘要", async () => {
    setSnapshot({ run: run({ status: "stopped" }) });
    const view = renderPane();
    await Promise.resolve();
    await Promise.resolve();
    expect(view.queryByTestId("workflow-run-resume")).toBeNull();
    expect(workflowRunsQuery).not.toHaveBeenCalled();
  });

  // Gray release (docs/dynamic-workflow/launch.md "Gray release" DWG-07): Resume really starts an
  // engine, so it is the only action withdrawn on this pane; the rest of the pane renders as
  // before.
  it("灰度关 → resumable 的 run 也不渲染 Resume，但状态头与阶段清单照旧", async () => {
    setDynamicWorkflowEnabled(false);
    setSnapshot({ run: run({ status: "stopped", resumable: true }) });
    const view = renderPane();
    await Promise.resolve();

    expect(view.queryByTestId("workflow-run-resume")).toBeNull();
    // "Only Resume is withdrawn": the Stop button and the phase checklist remain, and the run
    // itself is not hidden.
    expect(view.queryByTestId("workflow-run-cancel")).not.toBeNull();
    expect(view.queryByTestId("workflow-run-phases")).not.toBeNull();
  });

  it("灰度快照未就绪（loading）→ 先不给 Resume；就绪且命中后再长出来", async () => {
    useDynamicWorkflowAvailabilityStore.setState({
      status: "loading",
      enabled: false,
      config: null,
    });
    setSnapshot({ run: run({ status: "stopped", resumable: true }) });
    const view = renderPane();
    await Promise.resolve();
    expect(view.queryByTestId("workflow-run-resume")).toBeNull();

    act(() => {
      setDynamicWorkflowEnabled(true);
    });
    expect(await view.findByTestId("workflow-run-resume")).toBeDefined();
  });
});

// ── Artifacts section (docs/dynamic-workflow/authoring.md "How the user sees them") ──
// The section's own shape (expanded by default, card fields, click callback) is exhaustively
// covered in workflowRunArtifactsSection.test.ts;
// here we only pin "its position on this pane and its presence conditions" — two things that only
// hold in the full pane.
//
// ⚠ Terminology: artifacts = what the script delivers to the user via `artifact.*`, distinct
// from "results" (the top-level return value); the spec's invariant requires the two to be
// distinguishable on screen. (The `report` entries section was removed on 2026-09-04 per user
// instruction.)
describe("WorkflowRunSidePane 产物区", () => {
  const summary = (overrides: Record<string, unknown> = {}) => ({
    id: "book",
    kind: "file",
    title: "审计报告",
    version: 1,
    contentType: "application/pdf",
    bytes: 4096,
    ...overrides,
  });

  it("排在阶段清单之后，是面板的最后一节（Results / 事件日志 / Script 三节已撤走）", async () => {
    setSnapshot({
      run: run({
        artifacts: [summary()],
        pendingQuestions: [
          { qid: "q-1", siteId: "ask#1", ordinal: 1, question: "哪个 registry？" },
        ],
      } as never),
    });
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId(TID_WORKFLOW_ARTIFACTS_SECTION)).toBeTruthy());

    const artifacts = view.getByTestId(TID_WORKFLOW_ARTIFACTS_SECTION);
    const phases = view.getByTestId("workflow-run-phases");
    // Node.DOCUMENT_POSITION_FOLLOWING === 4: a comes before b. Escalation questions hang under
    // their asker inside the checklist (no longer a standalone section), so the artifacts section
    // directly follows the phase checklist.
    expect(phases.compareDocumentPosition(artifacts) & 4).toBeTruthy();
    // The pane ends here: no sibling node after the artifacts section.
    expect(artifacts.nextElementSibling).toBeNull();
  });

  it("零件时整区缺席（不给不发布产物的 run 留一节空壳）", async () => {
    setSnapshot({ run: run() });
    const view = renderPane();
    await act(async () => {});
    expect(view.queryByTestId(TID_WORKFLOW_ARTIFACTS_SECTION)).toBeNull();
  });

  it.each(["errored", "stopped"] as const)("%s 的 run 一样渲染产物区", async (status) => {
    // A run that died at step 12 may still have published a pdf; reporting just "failed" would
    // throw it away.
    setSnapshot({ run: run({ status, artifacts: [summary()] } as never) });
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId(TID_WORKFLOW_ARTIFACTS_SECTION)).toBeTruthy());
    expect(view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD)).toBeTruthy();
  });

  it("点卡片 → 打开产物 tab 的请求带上这块面板的 workspace scope 与产物 id，且不带版本号", async () => {
    setSnapshot({ run: run({ artifacts: [summary()] } as never) });
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD)).toBeTruthy());

    fireEvent.click(view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD));
    expect(onOpenWorkflowArtifact).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      runId: "dwfrun-1",
      artifactId: "book",
      title: "审计报告",
      // The host routes by contentType (html opens a browser tab directly), so the merged view
      // this pane holds is handed over whenever it is available.
      contentType: "application/pdf",
    });
  });

  it("合并视图里有 sourcePath 时一并交出去——宿主不必再为「在工作区显示」查一次 journal", async () => {
    // The source path lives only in the journal (the live projection's summary deliberately
    // omits it), so here we make the journal answer for the same id.
    workflowRunArtifactsQuery.mockImplementation(async () => ({
      artifacts: [
        {
          id: "book",
          kind: "file",
          title: "审计报告",
          version: 1,
          contentType: "text/html",
          sourcePath: "reports/audit.html",
          versions: [{ version: 1, publishedAt: 1, bytes: 4096 }],
          itemCount: 0,
        },
      ],
    }));
    setSnapshot({ run: run({ artifacts: [summary({ contentType: "text/html" })] } as never) });
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD)).toBeTruthy());

    fireEvent.click(view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD));
    expect(onOpenWorkflowArtifact).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      runId: "dwfrun-1",
      artifactId: "book",
      title: "审计报告",
      contentType: "text/html",
      sourcePath: "reports/audit.html",
    });
  });

  it("宿主没注入打开能力时卡片不可点（回调的存在本身就是门控）", async () => {
    setSnapshot({ run: run({ artifacts: [summary()] } as never) });
    const view = renderPane("en-US", { withArtifactCallback: false });
    await waitFor(() => expect(view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD)).toBeTruthy());
    fireEvent.click(view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD));
    expect(onOpenWorkflowArtifact).not.toHaveBeenCalled();
  });

  it("run 已被活投影淘汰时，产物仍从 journal 列得出来", async () => {
    const markdownArtifactTitle = "综述";
    workflowRunArtifactsQuery.mockImplementation(async () => ({
      artifacts: [
        {
          id: "notes",
          kind: "markdown",
          title: markdownArtifactTitle,
          version: 1,
          versions: [{ version: 1, publishedAt: 1, bytes: 12 }],
          itemCount: 0,
        },
      ],
    }));
    setSnapshot({});
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId(TID_WORKFLOW_ARTIFACTS_SECTION)).toBeTruthy());
    expect(view.getByText(markdownArtifactTitle)).toBeTruthy();
  });

  it("zh-CN 下区名念「产物」——与顶部「结果」措辞不重叠", async () => {
    setSnapshot({ run: run({ artifacts: [summary()] } as never) });
    const view = renderPane("zh-CN");
    await waitFor(() => expect(view.getByTestId(TID_WORKFLOW_ARTIFACTS_SECTION)).toBeTruthy());
    expect(view.getByTestId(TID_WORKFLOW_ARTIFACTS_SECTION).textContent).toContain("产物");
  });
});

// ── Phase roster (docs/dynamic-workflow/presentation.md "Past six participants") ──
// Stations past six participants: pin 5 (asking → running → failed → backfill), questions hang
// under the pinned asker, everyone else gets one cell, "list them all" expands into a dense
// two-column roll (cells collapse while expanded; see the follow-up "five pills and a door"); on
// the collapsed section header the avatar cluster is replaced by a mini meter.
describe("WorkflowRunSidePane 阶段名册", () => {
  type FanStatus = "done" | "running" | "failed" | "pending";
  function fanoutSnapshot(
    n: number,
    statusOf: (index: number) => FanStatus,
    pendingQuestions: WorkflowRunState["pendingQuestions"] = [],
    unlistedByPhase?: WorkflowRunState["unlistedByPhase"],
  ) {
    // One lane spawning N instances: the static graph is a single `many` card, and the run splits
    // it into N pills per instance.
    const steps: GraphStep[] = [
      { id: "ask#1", kind: "ask", label: "review", lane: "actor#1", phase: "phase#a" },
    ];
    const lanes = [{ id: "actor#1" }];
    const actors: WorkflowRunState["actors"] = [];
    const nodes: WorkflowRunState["nodes"] = [];
    for (let i = 1; i <= n; i += 1) {
      const status = statusOf(i);
      actors.push({
        siteId: "actor#1",
        ordinal: i,
        name: `reviewer-${i}`,
        sessionId: `dwf-dwfrun-1-actor_1@${i}`,
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
    snapshot = {
      rows: {
        window: [
          {
            ...graphRow,
            display: {
              ...graphRow.display,
              causalityGraph: {
                steps,
                lanes,
                participants: participantsOf(steps).map((participant) => ({
                  ...participant,
                  many: true,
                })),
                handoffs: [],
                phases: [{ id: "phase#a", name: "review", line: 1 }],
                phaseEdges: [],
              },
            },
          },
        ],
      },
      workflowRuns: {
        revision: 1,
        runs: [
          run({
            actors,
            nodes,
            pendingQuestions,
            ...(unlistedByPhase === undefined ? {} : { truncated: true, unlistedByPhase }),
          }),
        ],
      },
    };
  }
  const mid = (i: number): FanStatus =>
    i === 4 ? "failed" : i === 2 || i === 6 || i === 8 ? "running" : "done";
  const question = {
    qid: "q-6",
    actorSiteId: "actor#1",
    actorOrdinal: 6,
    question: "Treat the failing assertion as a bug or as drift?",
  };

  it("钉 5 枚：asking → running → failed → 补位；问题挂在钉住的提问者下面；第六枚是门，门关着", () => {
    fanoutSnapshot(9, mid, [question]);
    const view = renderPane();
    const section = view.getByTestId("workflow-run-phase");
    expect(section.getAttribute("data-phase-open")).toBe("true");
    const pins = within(section).getByTestId("workflow-roster-pins");
    const pills = within(pins).getAllByTestId("workflow-agent-pill");
    // Asking's 6 leads, then running's 2 and 8, then failed's 4, finally backfill's 1.
    expect(pills.map((pill) => pill.textContent)).toEqual([
      "reviewer-61 tasks",
      "reviewer-21 tasks",
      "reviewer-81 tasks",
      "reviewer-41 tasks",
      "reviewer-11 tasks",
    ]);
    // The question follows reviewer-6's row directly (same vertical flex container).
    const row = within(pins).getByTestId("workflow-run-question");
    expect(row.getAttribute("data-qid")).toBe("q-6");
    expect(row.parentElement).toBe(pills[0]!.parentElement);
    // The door: the remaining four (3 5 7 9, all done) — two faces, "4 more", the tally counts
    // only the rest, and a down chevron.
    const door = within(section).getByTestId("workflow-roster-more-row");
    expect(door.tagName).toBe("BUTTON");
    expect(door.getAttribute("data-door")).toBe("closed");
    expect(door.getAttribute("data-more-count")).toBe("4");
    expect(door.getAttribute("title")).toBe("4 more subagents · list them here");
    const tally = within(door).getByTestId("workflow-roster-tally");
    expect(
      [...tally.querySelectorAll("[data-roster-count]")].map(
        (item) => `${item.getAttribute("data-roster-count")}:${item.textContent}`,
      ),
    ).toEqual(["done:4"]);
    expect(within(door).getByTestId("workflow-more-chevron")).toBeTruthy();
    expect(within(door).queryByTestId("workflow-more-open")).toBeNull();
    // Door closed: no roll; no cells, meter, or avatar cluster in the body either.
    expect(within(section).queryByTestId("workflow-roster-roll")).toBeNull();
    expect(within(section).queryByTestId("workflow-agent-cell")).toBeNull();
    expect(within(section).queryByTestId("workflow-roster-meter")).toBeNull();
    expect(within(section).queryByTestId("workflow-roster-meter-mini")).toBeNull();
    expect(within(section).queryByTestId("workflow-run-phase-cluster")).toBeNull();
  });

  it("门后是名单：只有其余的人、按状态分组、组头是计数；再点门收起；名单里的行开 transcript 带 workspace scope", () => {
    // 60 people: 1 and 7 running, 6 failed, the rest done.
    fanoutSnapshot(60, (i) => (i === 1 || i === 7 ? "running" : i === 6 ? "failed" : "done"));
    const view = renderPane();
    const section = view.getByTestId("workflow-run-phase");
    const door = within(section).getByTestId("workflow-roster-more-row");
    // running pins first: pins = 1, 7, 6, 2, 3; the remaining 55 = 4 5 8…60.
    expect(door.getAttribute("data-more-count")).toBe("55");
    expect(door.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(door);
    expect(door.getAttribute("aria-expanded")).toBe("true");
    expect(door.getAttribute("data-door")).toBe("open");
    expect(within(door).queryByTestId("workflow-roster-tally")).toBeNull();
    const roll = within(section).getByTestId("workflow-roster-roll");
    const headings = within(roll).getAllByTestId("workflow-roll-heading");
    expect(headings.map((heading) => heading.textContent)).toEqual(["55done"]);
    const rows = within(roll).getAllByTestId("workflow-agent-pill");
    expect(rows).toHaveLength(55);
    expect(rows.every((entry) => entry.getAttribute("data-pill-size") === "row")).toBe(true);
    // The pinned five are not in the roll.
    const names = rows.map((entry) => entry.getAttribute("title"));
    for (const pinned of ["reviewer-6", "reviewer-1", "reviewer-7", "reviewer-2", "reviewer-3"]) {
      expect(names).not.toContain(pinned);
    }
    expect(names.slice(0, 3)).toEqual(["reviewer-4", "reviewer-5", "reviewer-8"]);
    // Rows in the roll are buttons; opening a transcript carries the tab's own workspace scope.
    const target = rows.find((entry) => entry.getAttribute("title") === "reviewer-5")!;
    expect(target.tagName).toBe("BUTTON");
    fireEvent.click(target);
    expect(onOpenWorkflowActorSession).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      runId: "dwfrun-1",
      actorSessionId: "dwf-dwfrun-1-actor_1@5",
      siteId: "actor#1",
      ordinal: 5,
      actorName: "reviewer-5",
    });
    // Clicking the door again: the roll collapses, the tally row returns.
    fireEvent.click(door);
    expect(within(section).queryByTestId("workflow-roster-roll")).toBeNull();
    expect(within(door).getByTestId("workflow-roster-tally")).toBeTruthy();
  });

  it("名单按注意力序分组：running、pending 在 done 前面；第六个提问者落在名单里带 ?", () => {
    // Nine people: 1 2 3 4 5 6 are all asking (five pinned, the sixth lands in the roll);
    // 7 running, 8 pending, 9 done.
    const asks = [1, 2, 3, 4, 5, 6].map((i) => ({
      qid: `q-${i}`,
      actorSiteId: "actor#1",
      actorOrdinal: i,
      question: `q ${i}`,
    }));
    fanoutSnapshot(9, (i) => (i === 7 ? "running" : i === 8 ? "pending" : "done"), asks);
    const view = renderPane();
    const section = view.getByTestId("workflow-run-phase");
    fireEvent.click(within(section).getByTestId("workflow-roster-more-row"));
    const roll = within(section).getByTestId("workflow-roster-roll");
    expect(
      within(roll)
        .getAllByTestId("workflow-roll-heading")
        .map((heading) => heading.getAttribute("data-roll-group")),
    ).toEqual(["running", "pending", "done"]);
    const rows = within(roll).getAllByTestId("workflow-agent-pill");
    expect(rows.map((entry) => entry.getAttribute("title"))).toEqual([
      "reviewer-7",
      "reviewer-8",
      "reviewer-6",
      "reviewer-9",
    ]);
    // The sixth asker reviewer-6: a ? on its row; the question itself is not duplicated in the
    // roll (the orphan block does not take it either — it has an asker).
    expect(within(rows[2]!).getByTestId("workflow-roll-asking")).toBeTruthy();
    expect(within(roll).queryByTestId("workflow-run-question")).toBeNull();
  });

  it("折起的名册站在节头带迷你量条而不是头像串", () => {
    fanoutSnapshot(9, mid);
    const view = renderPane();
    const section = view.getByTestId("workflow-run-phase");
    fireEvent.click(within(section).getByTestId("workflow-run-phase-toggle"));
    expect(section.getAttribute("data-phase-open")).toBe("false");
    expect(within(section).getByTestId("workflow-roster-meter-mini")).toBeTruthy();
    expect(within(section).queryByTestId("workflow-run-phase-cluster")).toBeNull();
    // Six or fewer still get the avatar cluster.
    fanoutSnapshot(6, mid);
    const few = rerenderPane(view);
    const small = few.getByTestId("workflow-run-phase");
    fireEvent.click(within(small).getByTestId("workflow-run-phase-toggle"));
    expect(within(small).queryByTestId("workflow-roster-meter-mini")).toBeNull();
  });

  // The unlisted ones (docs/dynamic-workflow/presentation.md "Past six participants", "The
  // spine"): subagents evicted by reduction have no pill and no row, but the door, tally row,
  // meter, and settled/observed counts must all include them.
  it("被淘汰的子代理进门的人数、计数行、迷你量条与 settled/observed，名单末尾一行淡字交代差额", () => {
    fanoutSnapshot(
      8,
      (i) => (i === 1 ? "running" : "done"),
      [],
      [{ phaseName: "review", actors: 300, actorsSettled: 300, actorsFailed: 2, settled: 300 }],
    );
    const view = renderPane();
    const section = view.getByTestId("workflow-run-phase");
    // Door: the three remaining in-table plus the three hundred unlisted.
    const door = within(section).getByTestId("workflow-roster-more-row");
    expect(door.getAttribute("data-more-count")).toBe("303");
    expect(door.getAttribute("title")).toBe("303 more subagents · list them here");
    expect(
      [
        ...within(door)
          .getByTestId("workflow-roster-tally")
          .querySelectorAll("[data-roster-count]"),
      ].map((item) => `${item.getAttribute("data-roster-count")}:${item.textContent}`),
    ).toEqual(["done:301", "failed:2"]);
    // Steps: 7 of the 8 in-table have settled, and the 300 unlisted raise numerator and
    // denominator together.
    expect(within(section).getByTestId("workflow-run-phase-fraction").textContent).toBe("307/308");
    // The roll can only list the three in-table; a trailing line accounts for the remaining
    // three hundred.
    fireEvent.click(door);
    const roll = within(section).getByTestId("workflow-roster-roll");
    expect(within(roll).getAllByTestId("workflow-agent-pill")).toHaveLength(3);
    expect(
      within(roll)
        .getAllByTestId("workflow-roll-heading")
        .map((h) => h.textContent),
    ).toEqual(["3done"]);
    expect(within(roll).getByTestId("workflow-roll-unlisted").textContent).toBe(
      "300 more agents not listed",
    );
    // Collapsed: the section header shows the mini meter (the roster's adjudication counts the
    // unlisted too).
    fireEvent.click(within(section).getByTestId("workflow-run-phase-toggle"));
    expect(within(section).getByTestId("workflow-roster-meter-mini")).toBeTruthy();
  });

  it("四枚药丸加三百个还没跑的被拒子代理也是名册：门在，量条在，头像串不在，计数行全是 pending", () => {
    fanoutSnapshot(4, () => "running", [], [{ phaseName: "review", actors: 300, settled: 0 }]);
    const view = renderPane();
    const section = view.getByTestId("workflow-run-phase");
    expect(within(section).getAllByTestId("workflow-agent-pill")).toHaveLength(4);
    const door = within(section).getByTestId("workflow-roster-more-row");
    expect(door.getAttribute("data-more-count")).toBe("300");
    // `actorsSettled` absent: not one of the three hundred has finished, so the tally must not
    // call them done.
    expect(
      [
        ...within(door)
          .getByTestId("workflow-roster-tally")
          .querySelectorAll("[data-roster-count]"),
      ].map((item) => `${item.getAttribute("data-roster-count")}:${item.textContent}`),
    ).toEqual(["pending:300"]);
    fireEvent.click(within(section).getByTestId("workflow-run-phase-toggle"));
    expect(within(section).getByTestId("workflow-roster-meter-mini")).toBeTruthy();
    expect(within(section).queryByTestId("workflow-run-phase-cluster")).toBeNull();
  });

  it("zh-CN：门的两种文案与组头", () => {
    fanoutSnapshot(9, mid);
    const view = renderPane("zh-CN");
    const door = view.getByTestId("workflow-roster-more-row");
    expect(door.textContent).toContain("还有 4 个");
    expect(door.getAttribute("title")).toBe("还有 4 个子代理 · 在这里列出");
    fireEvent.click(door);
    expect(door.getAttribute("title")).toBe("还有 4 个子代理 · 收起");
    expect(view.getByTestId("workflow-roll-heading").textContent).toBe("4个已完成");
  });

  // ── Landing (follow-up "five pills and a door"): the card's "n more" row / station header
  // hands the station id to the host, and the tab arrives here with focusPhaseId — expand, open
  // the door, scroll the header to the top, and flash once; the same station lands again when
  // openedAt changes.
  const landedTree = (overrides: Partial<WorkflowRunSidePaneTab>) =>
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(WorkflowRunSidePane, {
        tab: { ...tab, ...overrides },
        onOpenWorkflowActorSession,
      }),
    );

  it("tab 带 focusPhaseId：那一站展开、门开着、节头滚到顶并亮一下；换 openedAt 再落；不带就不落", () => {
    const scrollIntoView = vi.fn();
    // jsdom has no scrollIntoView.
    Element.prototype.scrollIntoView = scrollIntoView;
    // No station is running: everything is collapsed by default, so expansion can only come from
    // the landing.
    fanoutSnapshot(9, () => "done");
    const view = render(landedTree({ focusPhaseId: "phase#a", openedAt: 1 }));
    const section = view.getByTestId("workflow-run-phase");
    expect(section.getAttribute("data-phase-open")).toBe("true");
    expect(section.getAttribute("data-phase-landed")).toBe("true");
    const head = within(section).getByTestId("workflow-run-phase-toggle");
    expect(head.className).toContain("wf-landed");
    expect(
      within(section).getByTestId("workflow-roster-more-row").getAttribute("aria-expanded"),
    ).toBe("true");
    expect(within(section).getByTestId("workflow-roster-roll")).toBeTruthy();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: "start" }));
    expect(scrollIntoView.mock.instances[0]).toBe(head);
    // Clicking the same station again (openedAt refreshed): lands again.
    view.rerender(landedTree({ focusPhaseId: "phase#a", openedAt: 2 }));
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    // Reopening without a landing (the header's ⤢): no scroll, no collapse.
    view.rerender(landedTree({ openedAt: 3 }));
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(view.getByTestId("workflow-run-phase").getAttribute("data-phase-open")).toBe("true");
  });

  it("亮一下是一次性的：1.2 s 后落点标记退场，展开与名单留着", () => {
    vi.useFakeTimers();
    try {
      fanoutSnapshot(9, () => "done");
      const view = render(landedTree({ focusPhaseId: "phase#a", openedAt: 1 }));
      expect(view.getByTestId("workflow-run-phase").getAttribute("data-phase-landed")).toBe("true");
      act(() => {
        vi.advanceTimersByTime(1200);
      });
      const section = view.getByTestId("workflow-run-phase");
      expect(section.getAttribute("data-phase-landed")).toBeNull();
      expect(section.getAttribute("data-phase-open")).toBe("true");
      expect(within(section).getByTestId("workflow-roster-roll")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── The lineage line under the status header (docs/dynamic-workflow/presentation.md "The run pane") ──
describe("WorkflowRunSidePane lineage", () => {
  it.each([
    ["en-US", "Amends run"],
    ["zh-CN", "调整自 run"],
  ] as const)("修订出来的 run：状态头下一行「调整自 run X」：%s", (locale, label) => {
    setSnapshot({ run: run({ resumedFrom: "dwfrun-prev" }) });
    const view = renderPane(locale);
    const line = view.getByTestId("workflow-run-amends");
    expect(line.textContent).toContain(label);
    expect(line.textContent).toContain("dwfrun-prev");
    expect(view.queryByTestId("workflow-run-superseded-by")).toBeNull();
  });

  it("被替代的 run：状态词带原因，链接开后继的详情、带后继自己的发起行 id", () => {
    const successor = run({
      runId: "dwfrun-next",
      toolCallId: "tool-wf-2",
      resumedFrom: "dwfrun-1",
    });
    const predecessor = run({
      status: "stopped",
      stopReason: "superseded",
      supersededBy: "dwfrun-next",
    } as never);
    snapshot = {
      rows: { window: [graphRow] },
      workflowRuns: { revision: 1, runs: [predecessor, successor] },
    };
    const view = renderPane("en-US", { withOpenRunCallback: true });
    expect(view.getByTestId("workflow-run-status").textContent).toBe("Stopped");
    expect(view.getByTestId("workflow-run-status-reason").textContent).toContain("superseded");
    // A superseded run has no resumable bit: no Resume.
    expect(view.queryByTestId("workflow-run-resume")).toBeNull();
    const link = view.getByTestId("workflow-run-superseded-by");
    expect(link.tagName).toBe("BUTTON");
    expect(link.textContent).toContain("Superseded by run");
    expect(link.textContent).toContain("dwfrun-next");
    fireEvent.click(link);
    expect(onOpenWorkflowRun).toHaveBeenCalledTimes(1);
    expect(onOpenWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: "parent-a",
        runId: "dwfrun-next",
        toolCallId: "tool-wf-2",
        workspacePath: "/workspace",
      }),
    );
  });

  it("后继不在投影里（或宿主没给回调）时那一行是静态文字", () => {
    setSnapshot({
      run: run({
        status: "stopped",
        stopReason: "superseded",
        supersededBy: "dwfrun-gone",
      } as never),
    });
    const view = renderPane("zh-CN", { withOpenRunCallback: true });
    const line = view.getByTestId("workflow-run-superseded-by");
    expect(line.tagName).toBe("DIV");
    expect(line.textContent).toContain(zhCN["chat.toolCall.workflow.run.supersededBy"]);
    expect(line.textContent).toContain("dwfrun-gone");
  });

  it("普通 run 没有 lineage 行", () => {
    setSnapshot({ run: run() });
    const view = renderPane();
    expect(view.queryByTestId("workflow-run-amends")).toBeNull();
    expect(view.queryByTestId("workflow-run-superseded-by")).toBeNull();
  });
});

// ── Configure (docs/dynamic-workflow/presentation.md "The run pane", "The settings popover") ──
// The status header has two rows: name + Configure / Resume / Stop, with lamp and status word +
// concurrency chip below. Configure and Resume share the same gray-release gate; on a
// configurable run, the model segment in the usage line is another entry point. Once Apply is
// accepted, the pane swaps in place to the new run's tab.
describe("WorkflowRunSidePane 配置", () => {
  beforeEach(() => {
    setDynamicWorkflowEnabled(true);
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    onOpenWorkflowRun.mockClear();
  });

  it("状态头两行：第一行名字与 Configure → Resume → Stop，第二行灯与状态词和并发芯片", () => {
    setSnapshot({
      run: run({
        status: "stopped",
        stopReason: "user",
        resumable: true,
        concurrencyCeiling: 13,
        concurrency: { cap: 13, ceiling: 13, limit: 4 },
      }),
    });
    const view = renderPane();
    const configure = view.getByTestId("workflow-run-configure");
    const resume = view.getByTestId("workflow-run-resume");
    const cancel = view.getByTestId("workflow-run-cancel");
    expect(configure.textContent).toBe("Configure");
    expect(
      configure.compareDocumentPosition(resume) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(resume.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const statusRow = view.getByTestId("workflow-run-status-row");
    expect(statusRow.contains(view.getByTestId("workflow-run-status"))).toBe(true);
    expect(statusRow.contains(view.getByTestId("workflow-run-concurrency"))).toBe(true);
    expect(view.getByTestId("workflow-run-concurrency").textContent).toBe("Max concurrency 4");
    expect(statusRow.contains(configure)).toBe(false);
  });

  // The chip comes and goes with Configure (docs/dynamic-workflow/concurrency.md "What the user
  // sees"): on a completed or superseded run nothing is running under it anymore and no control
  // can change it, so the remaining number would only be read as a live reading.
  it.each([
    ["completed", run({ status: "completed" })],
    ["superseded", run({ status: "stopped", stopReason: "superseded", supersededBy: "run-next" })],
  ])("%s 的 run 不画并发芯片，即便界仍在天花板之下", (_case, state) => {
    setSnapshot({
      run: { ...state, concurrencyCeiling: 13, concurrency: { cap: 13, ceiling: 13, limit: 4 } },
    });
    const view = renderPane();
    expect(view.queryByTestId("workflow-run-concurrency")).toBeNull();
    expect(view.queryByTestId("workflow-run-configure")).toBeNull();
  });

  it.each([
    ["completed", run({ status: "completed" })],
    ["superseded", run({ status: "stopped", stopReason: "superseded", supersededBy: "run-next" })],
  ])("%s 的 run 没有 Configure，模型段只是字", (_case, state) => {
    setSnapshot({ run: { ...state, subagentModel: "zhipu/glm-5.3" } });
    const view = renderPane();
    expect(view.queryByTestId("workflow-run-configure")).toBeNull();
    expect(view.getByTestId("workflow-run-subagent-model").tagName).toBe("SPAN");
  });

  it("灰度关：没有 Configure", () => {
    setDynamicWorkflowEnabled(false);
    setSnapshot({ run: run() });
    expect(renderPane().queryByTestId("workflow-run-configure")).toBeNull();
  });

  it("zh-CN 念「配置」；能配置时模型段是按钮，点它与点 Configure 开的是同一个弹层", () => {
    setSnapshot({ run: run({ subagentModel: "zhipu/glm-5.3" }) });
    const view = renderPane("zh-CN");
    expect(view.getByTestId("workflow-run-configure").textContent).toBe("配置");
    const segment = view.getByTestId("workflow-run-subagent-model");
    expect(segment.tagName).toBe("BUTTON");
    fireEvent.click(segment);
    expect(segment.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[data-testid="workflow-run-settings-popover"]')).not.toBeNull();
  });

  it("Apply 发 amendWorkflowRunSettings {workId ≡ runId, 改过的设置}；新 run 进投影后 tab 原地换成它", async () => {
    sendCommand.mockImplementationOnce(
      async () =>
        ({
          status: "accepted",
          result: {
            type: "amendWorkflowRunSettings",
            runId: "dwfrun-2",
            toolCallId: "settings-1",
            supersededRunId: "dwfrun-1",
          },
        }) as never,
    );
    const current = run({
      concurrencyCeiling: 13,
      concurrency: { cap: 13, ceiling: 13, limit: 4 },
    });
    setSnapshot({ run: current });
    const view = renderPane("en-US", { withOpenRunCallback: true });
    fireEvent.click(view.getByTestId("workflow-run-configure"));
    fireEvent.click(
      document.querySelector('[data-testid="workflow-run-settings-bound-decrease"]')!,
    );
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="workflow-run-settings-apply"]')!);
    });
    expect(sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "amendWorkflowRunSettings",
        payload: { workId: "dwfrun-1", maxConcurrency: 3 },
        sessionId: "parent-a",
      }),
    );
    // At the moment of acceptance the new run is not in the projection yet: hold still.
    expect(onOpenWorkflowRun).not.toHaveBeenCalled();
    snapshot = {
      ...(snapshot as object),
      workflowRuns: {
        revision: 2,
        runs: [
          { ...current, status: "stopped", stopReason: "superseded", supersededBy: "dwfrun-2" },
          run({ runId: "dwfrun-2", toolCallId: "settings-1", resumedFrom: "dwfrun-1" }),
        ],
      },
    };
    view.rerender(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(WorkflowRunSidePane, { tab: { ...tab }, onOpenWorkflowRun }),
      ),
    );
    await waitFor(() => expect(onOpenWorkflowRun).toHaveBeenCalledTimes(1));
    expect(onOpenWorkflowRun).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      toolCallId: "settings-1",
      runId: "dwfrun-2",
      workflowName: "Fan-out review",
      replaceRunId: "dwfrun-1",
    });
  });

  // Changing only the concurrency cap while the run is in flight: takes effect in place, and the
  // result's runId is this run itself with no supersededRunId
  // (docs/dynamic-workflow/concurrency.md). There is no successor to follow — this tab already
  // is it.
  it("就地生效的结果（runId 是自己、无 supersededRunId）：不请求换 tab", async () => {
    sendCommand.mockImplementationOnce(
      async () =>
        ({
          status: "accepted",
          result: {
            type: "amendWorkflowRunSettings",
            runId: "dwfrun-1",
            toolCallId: "settings-1",
          },
        }) as never,
    );
    const current = run({
      concurrencyCeiling: 13,
      concurrency: { cap: 13, ceiling: 13, limit: 4 },
    });
    setSnapshot({ run: current });
    const view = renderPane("en-US", { withOpenRunCallback: true });
    fireEvent.click(view.getByTestId("workflow-run-configure"));
    // The in-place consequence sentence: no longer says "will stop the current run".
    fireEvent.click(
      document.querySelector('[data-testid="workflow-run-settings-bound-decrease"]')!,
    );
    expect(
      document.querySelector('[data-testid="workflow-run-settings-consequence"]')?.textContent,
    ).toBe("Applies to this run right away; no new run is started.");
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="workflow-run-settings-apply"]')!);
    });
    expect(sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { workId: "dwfrun-1", maxConcurrency: 3 } }),
    );
    // This run has been in the projection the whole time: if the follow logic did not recognize
    // "the successor is itself", this is where it would immediately request a tab swap.
    await act(async () => {});
    expect(onOpenWorkflowRun).not.toHaveBeenCalled();
  });

  it("「配置」出来的 run 在设置轮落地之前借前驱的图；设置轮落地后来龙去脉说「由你调整设置」", () => {
    const settingsTab = { ...tab, toolCallId: "settings-1", runId: "dwfrun-2" };
    const predecessor = run({
      status: "stopped",
      stopReason: "superseded",
      supersededBy: "dwfrun-2",
    });
    const successor = run({ runId: "dwfrun-2", toolCallId: "settings-1", resumedFrom: "dwfrun-1" });
    snapshot = {
      rows: { window: [graphRow] },
      workflowRuns: { revision: 1, runs: [predecessor, successor] },
    };
    const borrowed = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(WorkflowRunSidePane, { tab: settingsTab }),
      ),
    );
    expect(borrowed.getByTestId("workflow-run-phases")).toBeTruthy();
    expect(borrowed.queryByTestId("workflow-run-provenance")).toBeNull();
    cleanup();

    const workflowLaunch = {
      runId: "dwfrun-2",
      toolCallId: "settings-1",
      name: "Fan-out review",
      display: graphRow.display,
      amend: {
        predecessorRunId: "dwfrun-1",
        subagentModel: { to: "zhipu/glm-5.3-flash" },
        maxConcurrency: { from: 13, to: 4 },
        ceiling: 13,
      },
    };
    snapshot = {
      rows: {
        window: [
          graphRow,
          {
            kind: "turnHeader" as const,
            rowId: "row-header",
            origin: "workflowLaunch" as const,
            executionKind: "controlOnly" as const,
            state: "completedSuccess" as const,
            startedAt: Date.UTC(2026, 8, 18, 4, 51),
            workflowLaunch,
          },
        ],
      },
      workflowRuns: { revision: 2, runs: [predecessor, successor] },
    };
    const landed = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(WorkflowRunSidePane, { tab: settingsTab }),
      ),
    );
    const provenance = landed.getByTestId("workflow-run-provenance");
    expect(provenance.getAttribute("data-workflow-launch-kind")).toBe("settings");
    expect(provenance.textContent).toContain(
      expectedCopy("chat.workflowLaunch.settingsChangedByYou"),
    );
    expect(landed.queryByTestId("workflow-run-provenance-scope")).toBeNull();
    const rows = landed.getByTestId("workflow-run-provenance-settings").textContent ?? "";
    expect(rows).toContain(expectedCopy("chat.workflowLaunch.settings.model"));
    expect(rows).toContain(
      `${expectedCopy("chat.workflowLaunch.settings.sessionModel")} → glm-5.3-flash`,
    );
    expect(rows).toContain(expectedCopy("chat.workflowLaunch.settings.limit"));
    expect(rows).toContain(
      `${expectedCopy("chat.workflowLaunch.settings.defaultLimitValue", { n: 13 })} → 4`,
    );
  });

  // In-place settings turn (docs/dynamic-workflow/concurrency.md): the `amend` carries no
  // predecessorRunId.
  // The provenance block identifies turns by toolCallId, so it is read only when the user has
  // opened exactly that turn's tab —
  // this block never reads predecessorRunId, and without it still reads out what changed instead
  // of blowing up.
  it("就地生效的设置轮落在来龙去脉块上：没有前驱也照常念「由你调整设置」与上限那一行", () => {
    const retuned = run({ runId: "dwfrun-1", toolCallId: "tool-1" });
    const retuneTab = { ...tab, toolCallId: "settings-9", runId: "dwfrun-1" };
    snapshot = {
      rows: {
        window: [
          graphRow,
          {
            kind: "turnHeader" as const,
            rowId: "row-retune",
            origin: "workflowLaunch" as const,
            executionKind: "controlOnly" as const,
            state: "completedSuccess" as const,
            startedAt: Date.UTC(2026, 8, 18, 4, 51),
            workflowLaunch: {
              runId: "dwfrun-1",
              toolCallId: "settings-9",
              name: "Fan-out review",
              amend: { maxConcurrency: { from: 13, to: 4 }, ceiling: 13 },
            },
          },
        ],
      },
      workflowRuns: { revision: 1, runs: [retuned] },
    };
    const view = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(WorkflowRunSidePane, { tab: retuneTab }),
      ),
    );
    const provenance = view.getByTestId("workflow-run-provenance");
    expect(provenance.getAttribute("data-workflow-launch-kind")).toBe("settings");
    expect(provenance.textContent).toContain(
      expectedCopy("chat.workflowLaunch.settingsChangedByYou"),
    );
    const rows = view.getByTestId("workflow-run-provenance-settings").textContent ?? "";
    expect(rows).toContain(expectedCopy("chat.workflowLaunch.settings.limit"));
    expect(rows).toContain(
      `${expectedCopy("chat.workflowLaunch.settings.defaultLimitValue", { n: 13 })} → 4`,
    );
    expect(rows).not.toContain(expectedCopy("chat.workflowLaunch.settings.model"));
  });
});

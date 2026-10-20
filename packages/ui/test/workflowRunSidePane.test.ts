// @vitest-environment jsdom

// dwf run detail pane (docs/dynamic-workflow/presentation.md "The run pane"): status header / usage
// row / Cancel / result and failure panels / pending questions / artifacts / empty states, both locales.
//
// 2026-09-04 user instruction: Results (`report` entries), the event log and the Script section were
// removed from the pane (technical detail, not for users); the corresponding cases were deleted wholesale.
// The journal read surface is unchanged — the pane simply no longer shows them.
//
// Pure rules (Cancel availability, result classification, event summaries) are exhaustively covered in
// workflowRunPanel.test.ts; here we only pin "those results actually reach the DOM" plus interactions
// (which command a Cancel click emits).
import { createElement, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TID_WORKFLOW_ARTIFACTS_SECTION, TID_WORKFLOW_ARTIFACT_CARD } from "@zcode/shared";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowRunSidePaneTab } from "@/lib/workspaceSidePane.js";

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn() },
}));

// The tooltip stub renders only children (no DOM shape change) but records title / description:
// the Stop button's second line, "You can resume later", lives only inside the tooltip.
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
    tooltips.calls.push({
      title,
      ...(description === undefined ? {} : { description }),
    });
    return children;
  },
}));

const sendCommand = vi.fn(async () => ({ status: "accepted" }) as never);
const release = vi.fn();
// layer must be a **stable reference**: the component's lease effect depends on layer, and a fresh
// object every render would loop acquire → setLease → re-render → new layer forever (in production
// useV4Conversation returns a memoized bundle, which is already stable).
const layer = { acquire: vi.fn(() => ({ release })) };
const workflowRunsQuery = vi.fn<() => Promise<{ runs: unknown[] }>>(async () => ({ runs: [] }));
// Artifacts (docs/dynamic-workflow/authoring.md): the manifest goes through the journal query, board
// entries through the data query. Both are stubbed here — the pane unconditionally asks for the manifest
// on mount (the live projection carries no spec or version history).
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

// The "Configure" popover's model list (docs/dynamic-workflow/presentation.md "The settings popover"):
// the pane itself does not read it; only the popover subscribes when open. An empty list is enough
// (the fields themselves are pinned in workflowRunSettingsPopover.test.ts).
vi.mock("@/hooks/useModelSelectionView.js", () => ({
  useModelSelectionView: () => ({
    state: { status: "ready", view: { revision: 1, providers: [] } },
    reload: vi.fn(),
  }),
}));

// eslint-disable-next-line import/first -- the components under test must be imported after all mocks.
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
// eslint-disable-next-line import/first
import { WorkflowRunSidePane } from "@/app-shell/WorkflowRunSidePane.js";
// eslint-disable-next-line import/first
import { useDynamicWorkflowAvailabilityStore } from "@/store/dynamicWorkflowAvailabilityStore.js";

/** Gray-release snapshot (docs/dynamic-workflow/launch.md "Gray release"): hit by default, pane unchanged. */
function setDynamicWorkflowEnabled(enabled: boolean): void {
  useDynamicWorkflowAvailabilityStore.setState({
    status: "ready",
    enabled,
    config: {
      mode: enabled ? "alwaysOn" : "disabled",
      enabled,
      source: "remote",
    },
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
    // The inspector's SOURCE pane needs an `L{n}` anchor: a lane without a line falls back to its first step's line.
    line: 4,
  },
  // Other cards used for inspection: the workspace lane (synthetic, no session) and two anonymous lanes.
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
  // Two anonymous lanes: their ordinals must appear (Anonymous Subagent 1 / 2), sourced from the same data as the graph.
  { id: "actor#2" },
  { id: "actor#3" },
  { id: "workspace" },
];

/** Participants = one card per lane per phase, id follows the analyzer's `${phase}:${lane}`; unannotated scripts go to `unphased`. */
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
 * Variant with the phase vocabulary present: the accordion and phase selection need two real phases.
 * The base graph deliberately has **no** phases — most cases are phase-agnostic, and adding a layer
 * would blur what each case actually verifies.
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
    /** Swap in the graph with a `phase()` vocabulary (module panels); default is today's step/lane graph. */
    phased?: boolean;
  } = {},
) {
  const phasedSteps = STEPS.map((step) => ({
    ...step,
    phase: PHASE_OF[step.id]!,
  }));
  const causalityGraph =
    options.phased === true
      ? {
          ...graphRow.display.causalityGraph,
          participants: participantsOf(phasedSteps),
          phases: PHASES,
          // Edges between adjacent stations: the spine draws rail segments only between adjacent stations joined by an edge (same rule as the card).
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
    /** The "superseded by run X" link needs the host's open-run callback; omitted by default (most cases have nothing to do with lineage). */
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

// The pending-questions list is collapsed by default, so any **item-level** assertion must expand it
// first. This helper keeps "expand first" to one line so attention stays on what is actually pinned.
type Pane = ReturnType<typeof renderPane>;
/**
 * Re-render the same tree after a projection change (rows are live, not a snapshot of open time).
 * The pane is a memo component and the projection advances via context subscription in the real app;
 * here the projection is a mocked module variable, so pass a fresh tab object to let the memo through.
 */
function rerenderPane(view: Pane, locale: "en-US" | "zh-CN" = "en-US"): Pane {
  view.rerender(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(WorkflowRunSidePane, {
        tab: { ...tab },
        onOpenWorkflowActorSession,
      }),
    ),
  );
  return view;
}

beforeEach(() => {
  // This repo's vitest does not enable globals, so @testing-library's auto cleanup never registers;
  // without an explicit cleanup the previous case's DOM lingers and getByTestId then reports "multiple found".
  cleanup();
  sendCommand.mockClear();
  workflowRunsQuery.mockClear();
  workflowRunsQuery.mockImplementation(async () => ({ runs: [] }));
  workflowRunArtifactsQuery.mockClear();
  workflowRunArtifactsQuery.mockImplementation(async () => ({ artifacts: [] }));
  workflowRunArtifactDataQuery.mockClear();
  workflowRunArtifactDataQuery.mockImplementation(async () => ({
    items: [],
    hasMore: false,
  }));
  onOpenWorkflowActorSession.mockClear();
  onOpenWorkflowArtifact.mockClear();
  onOpenWorkflowWorkspace.mockClear();
  setDynamicWorkflowEnabled(true);
  setSnapshot({ run: run() });
});

describe("WorkflowRunSidePane status header and phase list", () => {
  it("the phase list shows one section per phase in declaration order and the running phase expands itself", () => {
    // docs/dynamic-workflow/presentation.md "The spine": the timeline reads as a vertical list.
    setSnapshot({
      run: run({
        nodes: [{ siteId: "ask#2", ordinal: 1, phase: "executing" }],
      }),
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

  it("when the running phase changes the new section opens and already-open ones stay open", () => {
    setSnapshot({
      run: run({
        nodes: [{ siteId: "ask#1", ordinal: 1, phase: "executing" }],
      }),
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
          {
            siteId: "world-read#1",
            ordinal: 1,
            phase: "settled",
            outcome: "ok",
          },
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

  it("spine: rail segments are painted as two halves on adjacent stations per the model's ink, lamps carry status, the marching segment is the one entering the running station", () => {
    // docs/dynamic-workflow/presentation.md "The spine". plan settled, review running:
    // the a→b rail marches; plan's lamp is green, review's lamp amber and pulsing.
    setSnapshot({
      run: run({
        nodes: [
          { siteId: "ask#1", ordinal: 1, phase: "settled", outcome: "ok" },
          {
            siteId: "world-read#1",
            ordinal: 1,
            phase: "settled",
            outcome: "ok",
          },
          { siteId: "ask#2", ordinal: 1, phase: "executing" },
        ],
      }),
      phased: true,
    });
    const view = renderPane();
    const rails = view.getAllByTestId("workflow-run-spine-rail");
    // Both halves carry `data-rail-position`: the stylesheet picks the marching gradient by it (lower half fades in, upper half fills to full).
    expect(rails.map((rail) => rail.getAttribute("data-rail-position"))).toEqual([
      "below",
      "above",
    ]);
    expect(rails.map((rail) => rail.getAttribute("data-rail-ink"))).toEqual(["march", "march"]);
    expect(rails[0]!.className).toContain("wf-spine-march");
    const lamps = view.getAllByTestId("workflow-run-phase-lamp");
    expect(lamps.map((lamp) => lamp.getAttribute("data-lamp"))).toEqual(["done", "running"]);
    expect(lamps[1]!.className).toContain("wf-lamp-running");
    // Lamps sit in the section header button: hovering the header reaches the existing `.wf-station-open:hover .wf-lamp` halo rule.
    expect(lamps[0]!.closest('[data-testid="workflow-run-phase-toggle"]')).toBeTruthy();
  });

  it("spine: a collapsed phase shows an avatar cluster in the header, expanding yields it to pills", () => {
    setSnapshot({
      run: run({
        nodes: [{ siteId: "ask#2", ordinal: 1, phase: "executing" }],
      }),
      phased: true,
    });
    const view = renderPane();
    // plan collapsed: the avatar cluster is present (planner + workspace = 2, no +n); review expanded: no cluster.
    const [plan, review] = view.getAllByTestId("workflow-run-phase");
    const cluster = within(plan!).getByTestId("workflow-run-phase-cluster");
    expect(cluster.querySelectorAll("[title]")).toHaveLength(2);
    expect(cluster.textContent).not.toContain("+");
    expect(within(review!).queryByTestId("workflow-run-phase-cluster")).toBeNull();
    // After expanding plan the cluster disappears and pills appear.
    fireEvent.click(within(plan!).getByTestId("workflow-run-phase-toggle"));
    expect(within(plan!).queryByTestId("workflow-run-phase-cluster")).toBeNull();
    expect(within(plan!).getAllByTestId("workflow-agent-pill").length).toBeGreaterThan(0);
  });

  it("spine: an edge-less graph has no rail segments; rounds read ⟳ n instead of a lamp string", () => {
    setSnapshot({
      run: run({
        nodes: [{ siteId: "ask#2", ordinal: 1, phase: "executing" }],
      }),
      phased: true,
    });
    // Drop the edges: rail segments are entirely absent (no edge between neighbours leaves a gap, same rule as the card).
    snapshot = {
      ...(snapshot as {
        rows: { window: { display: { causalityGraph: object } }[] };
      }),
      rows: {
        window: (
          snapshot as {
            rows: { window: { display: { causalityGraph: object } }[] };
          }
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

  it("renders the run status word (there is always a word beside the lamp)", () => {
    setSnapshot({ run: run({ status: "completed" }) });
    const view = renderPane();
    expect(view.getByTestId("workflow-run-status").textContent).toBe("Completed");
  });

  it("a direct launch (no tool row) takes the graph from the launch-turn metadata (docs/dynamic-workflow/launch.md)", () => {
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

  // Provenance of a direct launch (docs/dynamic-workflow/launch.md "The launch turn"): scope, description,
  // args and "Started by you from the workflows hub · time" are said only here — the chat run card looks
  // exactly like one launched through the tool path.
  it("a directly launched run: a provenance section under the status header — footnote, scope badge, description, args table", () => {
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
    // Provenance sits after the status header and before the result area / spine.
    const header = view.getByTestId("workflow-run-status").closest("div.border-b")!;
    expect(
      header.compareDocumentPosition(provenance) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(view.getByTestId("workflow-run-phases")).toBeTruthy();
  });

  it("a run launched through the tool path has no provenance section", () => {
    setSnapshot({ run: run() });
    const view = renderPane();
    expect(view.queryByTestId("workflow-run-provenance")).toBeNull();
  });

  it("when the tool call is not found in the row window, show no-graph instead of an empty list", () => {
    setSnapshot({ run: run(), withGraphRow: false });
    const view = renderPane();
    expect(view.queryByTestId("workflow-run-phases")).toBeNull();
    expect(view.getByTestId("workflow-run-graph-unavailable").textContent).toContain(
      "not in this conversation's visible history",
    );
  });
});

// ── Subagent model (docs/dynamic-workflow/presentation.md "The run pane") ──
// The user pinned this run's subagents to another model at launch; the main agent still uses the
// conversation model, so only subagents are mentioned. The status header's first row **no longer**
// carries a model chip (it does not fit — what survives truncation is exactly the provider id):
// the model name became the first segment of the summary row — a row that is "this run's numbers"
// anyway. The canonical string and effort retreat into the tooltip. Runs that never picked a model
// omit the segment entirely — following the conversation model is the norm and says nothing.
describe("WorkflowRunSidePane subagent model", () => {
  // A team-plan provider id is a hex string: this change is what must keep it out.
  const TEAM_PLAN_MODEL = "4fc7f541-2382-4c32-be11-f021b8d7ed1d/GLM-5.3-Flash$high";

  it("the model name is the first segment of the summary row, no longer a chip in the status header", () => {
    setSnapshot({ run: run({ subagentModel: "zhipu/glm-5.3-flash" }) });
    const view = renderPane();

    const segment = view.getByTestId("workflow-run-subagent-model");
    expect(segment.textContent).toBe("Subagents glm-5.3-flash");
    // It lives in the summary row, not the status header row (the one with the concurrency chip and the Stop button).
    expect(segment.closest('[data-testid="workflow-run-usage"]')).not.toBeNull();
    const summary = view.getByTestId("workflow-run-usage").textContent ?? "";
    expect(summary.indexOf("Subagents glm-5.3-flash")).toBe(0);
  });

  it("the provider id never reaches the screen, even as a team-plan UUID; the canonical string retreats into the tooltip", () => {
    setSnapshot({ run: run({ subagentModel: TEAM_PLAN_MODEL }) });
    const view = renderPane();

    const segment = view.getByTestId("workflow-run-subagent-model");
    expect(segment.textContent).toBe("Subagents GLM-5.3-Flash");
    expect(document.body.textContent).not.toContain("4fc7f541");
    expect(segment.getAttribute("title")).toContain(TEAM_PLAN_MODEL);
    // Effort stays off-screen; it lives in the tooltip together with the canonical string.
    expect(segment.getAttribute("title")).toContain("thinking High");
  });

  it("in zh-CN the same segment speaks Chinese, the model name stays untranslated", () => {
    setSnapshot({ run: run({ subagentModel: TEAM_PLAN_MODEL }) });
    const view = renderPane("zh-CN");

    expect(view.getByTestId("workflow-run-subagent-model").textContent).toBe(
      "子代理 GLM-5.3-Flash",
    );
  });

  it("when no graph is available (no timeline can be built) and it falls back to the usage row, the model still leads the row: it has nothing to do with graph availability", () => {
    setSnapshot({
      run: run({
        subagentModel: TEAM_PLAN_MODEL,
        usage: { spentTokens: 12_345, nodesUsed: 3 },
      }),
      withGraphRow: false,
    });
    const view = renderPane();

    const segment = view.getByTestId("workflow-run-subagent-model");
    expect(segment.textContent).toBe("Subagents GLM-5.3-Flash");
    expect(document.body.textContent).not.toContain("4fc7f541");
    expect(segment.getAttribute("title")).toContain(TEAM_PLAN_MODEL);
    // Within the row, the model comes first; usage labels and readings follow as before.
    const usage = view.getByTestId("workflow-run-usage").textContent ?? "";
    expect(usage.indexOf("Subagents GLM-5.3-Flash")).toBe(0);
    expect(usage).toContain("Usage");
    expect(usage).toContain("12,345 tokens · 3 steps");
  });

  it("runs that never picked a model omit the segment (subagents follow the conversation model)", () => {
    setSnapshot({ run: run() });
    const view = renderPane();

    expect(view.queryByTestId("workflow-run-subagent-model")).toBeNull();
    expect(document.body.textContent).not.toContain("Subagents ");
  });

  it("no segment either when the run is not in the projection (evicted / cold start)", () => {
    setSnapshot({});
    const view = renderPane();

    expect(view.queryByTestId("workflow-run-subagent-model")).toBeNull();
  });
});

describe("WorkflowRunSidePane summary row", () => {
  it("same copy as the chat-card footer: working subagents count, steps, tokens; no ceiling, no progress track", () => {
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

  it("falls back to the usage row when no graph is available (no timeline can be built)", () => {
    setSnapshot({
      run: run({ usage: { spentTokens: 12_345, nodesUsed: 3 } }),
      withGraphRow: false,
    });
    const view = renderPane();
    const usage = view.getByTestId("workflow-run-usage").textContent ?? "";
    expect(usage).toContain("Usage");
    expect(usage).toContain("12,345 tokens · 3 steps");
  });

  // Instance-table overflow (docs/dynamic-workflow/presentation.md "The run pane"): the summary row's
  // step count already includes off-table instances while the spine can only list the on-table ones —
  // this sentence states exactly that gap.
  it("an overflowing run adds one sentence under the summary row, Details-shown-for-n-of-m-steps, while the counts stay real", () => {
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

  it("runs that do not overflow, and runs where only the small table overflows (every step still listed), have no such sentence", () => {
    setSnapshot({
      run: run({ nodes: [{ siteId: "ask#1", ordinal: 1, phase: "settled" }] }),
    });
    expect(renderPane().queryByTestId("workflow-run-truncated")).toBeNull();
    cleanup();
    // `truncated` is also set when reports / artifacts / phases hit their cap; saying "details shown for 1 of 1 steps" then would be noise.
    setSnapshot({
      run: run({
        nodes: [{ siteId: "ask#1", ordinal: 1, phase: "settled" }],
        truncated: true,
      }),
    });
    expect(renderPane().queryByTestId("workflow-run-truncated")).toBeNull();
  });

  it("zh-CN reads the truncated-details sentence in Chinese", () => {
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
  it("clickable while running, and it goes through the existing cancelBackgroundWork {workId ≡ runId}", () => {
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

  it.each(["pending", "completed", "errored", "stopped"] as const)(
    "button disabled when %s",
    (status) => {
      setSnapshot({ run: run({ status }) });
      const view = renderPane();
      expect(view.getByTestId<HTMLButtonElement>("workflow-run-cancel").disabled).toBe(true);
    },
  );

  it("the button is disabled when the run is not in the projection (nothing is known about its in-flight state)", () => {
    setSnapshot({});
    const view = renderPane();
    expect(view.getByTestId<HTMLButtonElement>("workflow-run-cancel").disabled).toBe(true);
  });

  it("the stop button provides the Stop run accessible name and visible copy", () => {
    setSnapshot({ run: run({ status: "running" }) });
    const view = renderPane();
    const button = view.getByTestId("workflow-run-cancel");
    expect(button.getAttribute("aria-label")).toBe("Stop run");
    expect(button.textContent).toContain("Stop run");
  });

  it("when clickable the tooltip carries the second line 'You can resume later'; when disabled only the reason remains", () => {
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

// Fix rationale (2026-09-15, verified on desktop): when a stale run was wrongly left running, Cancel
// did nothing; Resume hitting a script that no longer compiled likewise only left a console warn.
// Rejected ACKs now become a sentence under the status header via the vocabulary.
describe("WorkflowRunSidePane rejection notices", () => {
  it("cancel rejected (not_found) → one sentence appears under the status header; it retracts as soon as run state changes", async () => {
    setSnapshot({ run: run({ status: "running" }) });
    sendCommand.mockResolvedValueOnce({
      status: "failed",
      reasonCode: "fault.command.backgroundWorkCancelRejected.not_found",
    } as never);
    const view = renderPane();

    fireEvent.click(view.getByTestId("workflow-run-cancel"));

    const hint = await view.findByTestId("workflow-run-rejection");
    expect(hint.textContent).toContain("not running in this agent");
    // The button is not locked: the notice only explains and never changes clickability.
    expect(view.getByTestId<HTMLButtonElement>("workflow-run-cancel").disabled).toBe(false);

    setSnapshot({ run: run({ status: "stopped", stopReason: "user" }) });
    rerenderPane(view);
    expect(view.queryByTestId("workflow-run-rejection")).toBeNull();
  });

  it("resume rejected (compile_failed) → one sentence points at amending the workflow, with the ACK diagnostics in a monospace block", async () => {
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

  it("a reasonCode outside the vocabulary → generic copy carries the code; accepted produces no notice", async () => {
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

  it("zh-CN copy", async () => {
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

describe("WorkflowRunSidePane result and failure panels", () => {
  it("completed without resultPreview points at the background result message in the conversation instead of inventing a result", () => {
    setSnapshot({ run: run({ status: "completed" }) });
    const view = renderPane();
    expect(view.getByTestId("workflow-run-result").textContent).toContain(
      "delivered to the conversation as a background result message",
    );
  });

  it("errored renders the error text from the projection verbatim", () => {
    setSnapshot({
      run: run({
        status: "errored",
        error: "Node count exceeds the cap of 100",
      }),
    });
    const view = renderPane();
    const panel = view.getByTestId("workflow-run-error");
    expect(panel.textContent).toContain("Run errored");
    expect(panel.textContent).toContain("Node count exceeds the cap of 100");
  });

  it("stopped with no error detail says so instead of leaving a blank", () => {
    setSnapshot({ run: run({ status: "stopped" }) });
    const view = renderPane();
    const panel = view.getByTestId("workflow-run-error");
    expect(panel.textContent).toContain("Run stopped");
    expect(panel.textContent).toContain("No error detail was recorded.");
  });

  it("stopped with a reason: the title and status header both follow the reason word (decision 15)", () => {
    setSnapshot({
      run: run({
        status: "stopped",
        stopReason: "provider",
        error: "Sign-in expired.",
      } as never),
    });
    const view = renderPane();
    expect(view.getByTestId("workflow-run-stop-reason").textContent).toContain("model error");
    expect(view.getByTestId("workflow-run-status-reason").textContent).toContain("model error");
    expect(view.getByTestId("workflow-run-error").textContent).toContain("Sign-in expired.");
  });

  // The verb "stop" cannot state consequences, so they return to the status line: resumable is a projection-provided bit, never derived from status.
  it("third word of the status line: says resumable when the run carries the bit, no word otherwise", () => {
    setSnapshot({
      run: run({ status: "stopped", stopReason: "user", resumable: true }),
    });
    const withBit = renderPane();
    expect(withBit.getByTestId("workflow-run-status-resumable").textContent).toContain("resumable");
    expect(withBit.getByTestId("workflow-run-status-reason").textContent).toContain("by you");

    cleanup();
    setSnapshot({ run: run({ status: "stopped", stopReason: "user" }) });
    const without = renderPane();
    expect(without.queryByTestId("workflow-run-status-resumable")).toBeNull();

    cleanup();
    setSnapshot({
      run: run({ status: "stopped", stopReason: "user", resumable: true }),
    });
    const zh = renderPane("zh-CN");
    expect(zh.getByTestId("workflow-run-status-resumable").textContent).toContain("可恢复");
  });

  it("running has neither a result panel nor a failure panel", () => {
    setSnapshot({ run: run({ status: "running" }) });
    const view = renderPane();
    expect(view.queryByTestId("workflow-run-result")).toBeNull();
    expect(view.queryByTestId("workflow-run-error")).toBeNull();
  });
});

describe("WorkflowRunSidePane escalated questions", () => {
  const NOW = 1_756_000_000_000;
  const MINUTE = 60_000;
  const questions = [
    {
      qid: "dwfq-dwfrun1-1",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorName: "poet",
      question: "The score cap is 95 but the pass threshold is 96 — is the gate broken?",
      context: "Tried 4 rounds already; best score 95.",
      askedAt: NOW - 42 * MINUTE,
    },
    {
      qid: "dwfq-dwfrun1-2",
      actorSiteId: "actor#2",
      actorOrdinal: 3,
      question: "Which style guide version?",
      askedAt: NOW - 90 * MINUTE,
    },
  ];
  const askers = () =>
    run({
      actors: [
        {
          siteId: "actor#1",
          ordinal: 1,
          name: "poet",
          sessionId: "s-1",
          status: "waiting",
        },
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
        {
          siteId: "ask#2",
          ordinal: 3,
          phase: "waiting",
          actorSiteId: "actor#2",
          actorOrdinal: 3,
        },
      ],
      pendingQuestions: questions,
    });

  it("hangs under the asker's row: the question follows the subagent pill matching site@ordinal", () => {
    setSnapshot({ run: askers() });
    const view = renderPane();

    const rows = view.getAllByTestId("workflow-run-question");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.getAttribute("data-qid")).toBe("dwfq-dwfrun1-1");
    const pill = rows[0]!.previousElementSibling as HTMLElement;
    expect(pill.getAttribute("data-testid")).toBe("workflow-agent-pill");
    expect(pill.textContent).toContain("poet");
    expect(rows[0]!.textContent).toContain("is the gate broken?");
    expect(rows[0]!.textContent).toContain("Tried 4 rounds already; best score 95.");
    // qid is the token the main agent needs to answer; the user cannot answer but can point at it for the main agent.
    expect(rows[0]!.textContent).toContain("dwfq-dwfrun1-1");
    // A question hung under a row does not repeat the asker's name.
    expect(rows[0]!.textContent).not.toContain("poet");
    expect(view.queryByTestId("workflow-run-orphan-questions")).toBeNull();
  });

  it("each carries a wait duration (the reader's first question is always how long has this been waiting)", () => {
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

  it("the wait duration runs its own clock: a run waiting for an answer emits no events, so projection-only updates would forever read just-now", () => {
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

  it("no duration renders when askedAt is absent (old journal replay), never inventing a just-now", () => {
    const { askedAt: _dropped, ...withoutAskedAt } = questions[0]!;
    setSnapshot({ run: { ...askers(), pendingQuestions: [withoutAskedAt] } });
    const view = renderPane();
    expect(view.getAllByTestId("workflow-run-question")).toHaveLength(1);
    expect(view.queryByTestId("workflow-run-question-waited")).toBeNull();
  });

  it("questions with no matching asker go to the end of the list and name themselves (site-instance label / anonymous fallback)", () => {
    setSnapshot({
      run: run({
        pendingQuestions: [
          {
            qid: "q-a",
            actorSiteId: "actor#9",
            actorOrdinal: 2,
            question: "Who reviews?",
          },
          { qid: "q-b", question: "A question with no subject" },
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

  it("v1 is read-only: no input controls or answer buttons anywhere in the list", () => {
    setSnapshot({ run: askers() });
    const view = renderPane();
    const list = view.getByTestId("workflow-run-phases");
    expect(list.querySelectorAll("input, textarea").length).toBe(0);
    expect(list.textContent).not.toContain("Answer");
  });

  it("zero questions means no question rows and no trailing orphan block (key absent and empty array behave the same)", () => {
    setSnapshot({ run: run({ pendingQuestions: [] }) });
    let view = renderPane();
    expect(view.queryAllByTestId("workflow-run-question")).toHaveLength(0);
    expect(view.queryByTestId("workflow-run-orphan-questions")).toBeNull();
    cleanup();
    setSnapshot({ run: run() });
    view = renderPane();
    expect(view.queryAllByTestId("workflow-run-question")).toHaveLength(0);
  });

  it("in zh-CN the wait durations and the orphan-block title localize, with no English fallback leaking", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      setSnapshot({
        run: run({
          pendingQuestions: [
            {
              qid: "q-b",
              question: "A question with no subject",
              askedAt: NOW - 42 * MINUTE,
            },
          ],
        }),
      });
      const view = renderPane("zh-CN");
      const text = view.getByTestId("workflow-run-orphan-questions").textContent ?? "";
      expect(text).toContain("待答问题");
      expect(text).toContain("42 分钟前");
      expect(text).toContain("未命名子代理");
      expect(text).not.toContain("Waiting on an answer");
      expect(text).not.toContain("ago");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("WorkflowRunSidePane evicted / cold-start empty state", () => {
  it("the tab stays open when the run is missing from workflowRuns; the wording only says live tracking is gone", () => {
    setSnapshot({});
    const view = renderPane();
    const panel = view.getByTestId("workflow-run-untracked");
    expect(panel.textContent).toContain("No longer tracked live");
    // Crucial: it must not read as "this run no longer exists" — the journal record is still
    // complete, which is exactly why the tab stays (artifacts can still be listed; see the artifacts case).
    expect(panel.textContent).toContain("record is still complete");
  });
});

describe("WorkflowRunSidePane internationalization", () => {
  it("status header, usage, Stop and result fully localize under zh-CN", () => {
    setSnapshot({
      run: run({
        status: "completed",
        usage: { spentTokens: 1_000, nodesUsed: 3 },
      }),
    });
    const view = renderPane("zh-CN");
    const text = view.container.textContent ?? "";

    expect(view.getByTestId("workflow-run-status").textContent).toBe("已完成");
    expect(text).toContain("停止运行");
    // The summary row shares copy with the chat-card footer: three subagent lanes + steps + tokens.
    expect(view.getByTestId("workflow-run-usage").textContent).toContain("3 个子代理");
    expect(view.getByTestId("workflow-run-usage").textContent).toContain("1,000 tokens");
    expect(text).toContain("结果");
    // No English fallback leaks.
    expect(text).not.toContain("Stop run");
    // The old verb is fully retired.
    expect(text).not.toContain("取消运行");
  });
});

// ── Subagent rows in the phase list (docs/dynamic-workflow/presentation.md "The spine") ──
// The same pill as on the card, plus "what it is doing" (the current step's label), a count, a status
// mark and the arrow that opens the transcript.
describe("WorkflowRunSidePane subagent rows", () => {
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

  it("rows carry the runtime name, a count and a readable status mark; the current step's label is not written (site names carry no information for the reader)", () => {
    setSnapshot({
      run: run({ actors: [actor({ name: "planner" })], nodes: [executing()] }),
    });
    const view = renderPane();

    const pill = view
      .getAllByTestId("workflow-agent-pill")
      .find((candidate) => candidate.textContent?.includes("planner"))!;
    expect(pill.getAttribute("data-agent-status")).toBe("running");
    expect(pill.querySelector('[data-testid="workflow-run-agent-activity"]')).toBeNull();
    expect(pill.textContent).toContain("1 tasks");
    // Status is not colour- or shape-only: the mark carries readable text.
    const mark = pill.querySelector('[data-testid="workflow-pill-status"]');
    expect(mark?.getAttribute("aria-label")).toBe("running");
  });

  /** The trailing ↗: one per row (every subagent pill in a live run is openable), looked up by the row's name. */
  const openOf = (view: ReturnType<typeof renderPane>, name: string) =>
    view
      .getAllByTestId("workflow-agent-pill")
      .find((candidate) => candidate.textContent?.includes(name))!
      .querySelector('[data-testid="workflow-run-agent-open"]')!;

  it("clicking the trailing arrow opens the transcript tab with the tab's own workspace scope", () => {
    setSnapshot({
      run: run({ actors: [actor({ name: "planner" })], nodes: [executing()] }),
    });
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

  it("the whole row is the button: clicking the pill itself opens it; ↗ is only visible evidence of openability", () => {
    setSnapshot({
      run: run({ actors: [actor({ name: "planner" })], nodes: [executing()] }),
    });
    const view = renderPane();
    const pill = view
      .getAllByTestId("workflow-agent-pill")
      .find((candidate) => candidate.textContent?.includes("planner"))!;
    expect(pill.tagName).toBe("BUTTON");
    expect(pill.getAttribute("aria-label")).toBe("Open the transcript of planner");
    expect(pill.querySelector('[data-testid="workflow-run-agent-open"]')).toBeTruthy();
    fireEvent.click(pill);
    expect(onOpenWorkflowActorSession).toHaveBeenCalledTimes(1);
    expect(onOpenWorkflowActorSession).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSessionId: "dwf-dwfrun-1-actor_1@1",
        actorName: "planner",
      }),
    );
  });

  it("instances whose session is not yet persisted still form a row and open: the request carries the slot and no session id (the tab holds a placeholder and self-heals)", () => {
    // docs/dynamic-workflow/presentation.md「The pill」。
    const { sessionId: _absent, ...pending } = actor({ name: "planner" });
    setSnapshot({ run: run({ actors: [pending], nodes: [executing()] }) });
    const view = renderPane();

    const pill = view
      .getAllByTestId("workflow-agent-pill")
      .find((candidate) => candidate.textContent?.includes("planner"))!;
    expect(pill.tagName).toBe("BUTTON");
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

  it("subagents that have not appeared yet (static lanes) are also openable in a live run: expected ordinal 1", () => {
    // The script has not reached its agent() yet: the projection has no such actor, and the pill hands out the lane + a future ordinal.
    setSnapshot({
      run: run({ actors: [actor({ name: "planner" })], nodes: [executing()] }),
    });
    const view = renderPane();
    const opens = view.getAllByTestId("workflow-run-agent-open");
    const absent = opens.find((open) => open.getAttribute("data-agent-session-id") === "")!;
    fireEvent.click(absent);
    const request = onOpenWorkflowActorSession.mock.calls[0]![0] as Record<string, unknown>;
    expect(request).toMatchObject({ runId: "dwfrun-1", ordinal: 1 });
    expect(request.siteId).not.toBe("actor#1");
    expect(request).not.toHaveProperty("actorSessionId");
  });

  it("no arrows at all when the host provides no drill-down callback (the callback's presence is itself the gate)", () => {
    setSnapshot({
      run: run({ actors: [actor({ name: "planner" })], nodes: [executing()] }),
    });
    const view = renderPane("en-US", { withActorCallback: false });
    expect(view.queryByTestId("workflow-run-agent-open")).toBeNull();
  });

  it("two instances of the same lane split into two rows, each opening its own transcript", () => {
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
      expect.objectContaining({
        actorSessionId: "s-2",
        ordinal: 2,
        actorName: "worker-2",
      }),
    );
  });

  it("the script lane takes its own path (docs/dynamic-workflow/transcript-and-notifications.md): no actor transcript, it opens the whole run's script transcript and lands on this station", () => {
    setSnapshot({
      run: run({
        nodes: [{ siteId: "world-read#1", ordinal: 1, phase: "executing" }],
      }),
    });
    const view = renderPane();
    const pill = view
      .getAllByTestId("workflow-agent-pill")
      .find((candidate) => candidate.textContent?.includes("Script"))!;
    expect(pill.querySelector('[data-testid="workflow-run-agent-open"]')).toBeNull();
    expect(pill.textContent).toContain("1 reads");
    expect(pill.tagName).toBe("BUTTON");
    const open = pill.querySelector('[data-testid="workflow-run-workspace-open"]')!;
    // Unannotated script: the implicit station id is "workflow", and the landing goes to it.
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

  it("phased graph: the script row hands out its station's phase id; it is a span when the host gives no callback", () => {
    setSnapshot({
      phased: true,
      run: run({
        nodes: [{ siteId: "world-read#1", ordinal: 1, phase: "executing" }],
      }),
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

  it("new instances join the list as they appear: rows are live, not a snapshot of open time", () => {
    const withSession = (view: ReturnType<typeof renderPane>) =>
      view
        .getAllByTestId("workflow-run-agent-open")
        .filter((open) => open.getAttribute("data-agent-session-id") !== "");
    setSnapshot({
      run: run({ actors: [actor({ name: "worker-1" })], nodes: [executing()] }),
    });
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

  it("clicking the section header collapses then expands", () => {
    setSnapshot({
      run: run({ actors: [actor({ name: "planner" })], nodes: [executing()] }),
    });
    const view = renderPane();
    const phase = view.getByTestId("workflow-run-phase");
    expect(phase.getAttribute("data-phase-open")).toBe("true");

    fireEvent.click(view.getByTestId("workflow-run-phase-toggle"));
    expect(phase.getAttribute("data-phase-open")).toBe("false");
    expect(view.queryByTestId("workflow-run-agent-open")).toBeNull();

    fireEvent.click(view.getByTestId("workflow-run-phase-toggle"));
    expect(phase.getAttribute("data-phase-open")).toBe("true");
  });

  it("in zh-CN the implicit phase name, counts and status marks all localize", () => {
    setSnapshot({
      run: run({ actors: [actor({ name: "planner" })], nodes: [executing()] }),
    });
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
  it("stopped with the resumable bit → Resume renders, clicking emits resumeWorkflowRun {workId ≡ runId, name}", async () => {
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
    // name feeds the completion notification's subject after a resume (the original tool input is unavailable after restart; the tab's display name is the only remaining source).
    expect(envelope.payload).toEqual({
      workId: "dwfrun-1",
      name: "Fan-out review",
    });
    expect(envelope.sessionId).toBe("parent-a");
  });

  it.each(["pending", "running", "completed"] as const)(
    "%s does not render Resume",
    async (status) => {
      setSnapshot({ run: run({ status }) });
      const view = renderPane();
      await Promise.resolve();
      expect(view.queryByTestId("workflow-run-resume")).toBeNull();
    },
  );

  it("stopped(interrupted) with the projection carrying the resumable bit (cold replay folded the row predicates) → Resume renders", async () => {
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

  it("errored (the script genuinely failed) → not rendered", async () => {
    setSnapshot({ run: run({ status: "errored" }) });
    const view = renderPane();
    await Promise.resolve();
    expect(view.queryByTestId("workflow-run-resume")).toBeNull();
  });

  it("stopped without the bit (old CLI) → no dead button; no extra journal summary lookup", async () => {
    setSnapshot({ run: run({ status: "stopped" }) });
    const view = renderPane();
    await Promise.resolve();
    await Promise.resolve();
    expect(view.queryByTestId("workflow-run-resume")).toBeNull();
    expect(workflowRunsQuery).not.toHaveBeenCalled();
  });

  // Gray release (docs/dynamic-workflow/launch.md "Gray release" DWG-07): Resume really starts an
  // engine and is the only action taken away on this pane; the rest of the pane still renders.
  it("gray off → even a resumable run renders no Resume, but the status header and phase list stay", async () => {
    setDynamicWorkflowEnabled(false);
    setSnapshot({ run: run({ status: "stopped", resumable: true }) });
    const view = renderPane();
    await Promise.resolve();

    expect(view.queryByTestId("workflow-run-resume")).toBeNull();
    // "Only Resume is taken away": the Stop button and the phase list remain; the run itself is not hidden.
    expect(view.queryByTestId("workflow-run-cancel")).not.toBeNull();
    expect(view.queryByTestId("workflow-run-phases")).not.toBeNull();
  });

  it("gray snapshot not ready (loading) → no Resume yet; it grows once ready and hit", async () => {
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
// The section's own shape (expanded by default, card fields, click callbacks) is exhaustively covered
// in workflowRunArtifactsSection.test.ts; here we only pin "its position and presence conditions on
// this pane" — both hold only in the full pane.
//
// ⚠ Terminology: artifacts = outputs the script delivers to the user via `artifact.*`, distinct from
// the "result" (the top-level return value); the spec invariant requires both to be distinguishable
// on screen. (The `report`-entries section was removed on 2026-09-04 by user instruction.)
describe("WorkflowRunSidePane artifacts section", () => {
  const summary = (overrides: Record<string, unknown> = {}) => ({
    id: "book",
    kind: "file",
    title: "Audit report",
    version: 1,
    contentType: "application/pdf",
    bytes: 4096,
    ...overrides,
  });

  it("sits after the phase list and is the pane's last section (Results / event log / Script sections were removed)", async () => {
    setSnapshot({
      run: run({
        artifacts: [summary()],
        pendingQuestions: [
          {
            qid: "q-1",
            siteId: "ask#1",
            ordinal: 1,
            question: "Which registry?",
          },
        ],
      } as never),
    });
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId(TID_WORKFLOW_ARTIFACTS_SECTION)).toBeTruthy());

    const artifacts = view.getByTestId(TID_WORKFLOW_ARTIFACTS_SECTION);
    const phases = view.getByTestId("workflow-run-phases");
    // Node.DOCUMENT_POSITION_FOLLOWING === 4: a precedes b. Escalated questions hang under their
    // askers inside the list (no longer a standalone section), so the artifacts section directly follows the phase list.
    expect(phases.compareDocumentPosition(artifacts) & 4).toBeTruthy();
    // The pane ends here: no siblings after the artifacts section.
    expect(artifacts.nextElementSibling).toBeNull();
  });

  it("the section is entirely absent with no artifacts (no empty shell left for runs that publish none)", async () => {
    setSnapshot({ run: run() });
    const view = renderPane();
    await act(async () => {});
    expect(view.queryByTestId(TID_WORKFLOW_ARTIFACTS_SECTION)).toBeNull();
  });

  it.each(["errored", "stopped"] as const)(
    "a %s run still renders the artifacts section",
    async (status) => {
      // A run that died at step 12 may still have published a pdf; reporting only "failed" would throw it away.
      setSnapshot({ run: run({ status, artifacts: [summary()] } as never) });
      const view = renderPane();
      await waitFor(() => expect(view.getByTestId(TID_WORKFLOW_ARTIFACTS_SECTION)).toBeTruthy());
      expect(view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD)).toBeTruthy();
    },
  );

  it("clicking a card → the open-artifact-tab request carries this pane's workspace scope and the artifact id, with no version", async () => {
    setSnapshot({ run: run({ artifacts: [summary()] } as never) });
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD)).toBeTruthy());

    fireEvent.click(view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD));
    expect(onOpenWorkflowArtifact).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      runId: "dwfrun-1",
      artifactId: "book",
      title: "Audit report",
      // The host dispatches by contentType (html opens a browser tab directly), so the merged view
      // this pane holds is handed out whenever available.
      contentType: "application/pdf",
    });
  });

  it("a sourcePath in the merged view is handed out too — the host need not query the journal again for show-in-workspace", async () => {
    // The provenance lives only in the journal (the live projection's summary deliberately omits it), so the journal answers the same id here.
    workflowRunArtifactsQuery.mockImplementation(async () => ({
      artifacts: [
        {
          id: "book",
          kind: "file",
          title: "Audit report",
          version: 1,
          contentType: "text/html",
          sourcePath: "reports/audit.html",
          versions: [{ version: 1, publishedAt: 1, bytes: 4096 }],
          itemCount: 0,
        },
      ],
    }));
    setSnapshot({
      run: run({ artifacts: [summary({ contentType: "text/html" })] } as never),
    });
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD)).toBeTruthy());

    fireEvent.click(view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD));
    expect(onOpenWorkflowArtifact).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      runId: "dwfrun-1",
      artifactId: "book",
      title: "Audit report",
      contentType: "text/html",
      sourcePath: "reports/audit.html",
    });
  });

  it("cards are not clickable when the host injects no open capability (the callback's presence is itself the gate)", async () => {
    setSnapshot({ run: run({ artifacts: [summary()] } as never) });
    const view = renderPane("en-US", { withArtifactCallback: false });
    await waitFor(() => expect(view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD)).toBeTruthy());
    fireEvent.click(view.getByTestId(TID_WORKFLOW_ARTIFACT_CARD));
    expect(onOpenWorkflowArtifact).not.toHaveBeenCalled();
  });

  it("when the run has been evicted from the live projection, artifacts still list from the journal", async () => {
    workflowRunArtifactsQuery.mockImplementation(async () => ({
      artifacts: [
        {
          id: "notes",
          kind: "markdown",
          title: "Overview",
          version: 1,
          versions: [{ version: 1, publishedAt: 1, bytes: 12 }],
          itemCount: 0,
        },
      ],
    }));
    setSnapshot({});
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId(TID_WORKFLOW_ARTIFACTS_SECTION)).toBeTruthy());
    expect(view.getByText("Overview")).toBeTruthy();
  });

  it("in zh-CN the section title reads artifacts, not overlapping the top result wording", async () => {
    setSnapshot({ run: run({ artifacts: [summary()] } as never) });
    const view = renderPane("zh-CN");
    await waitFor(() => expect(view.getByTestId(TID_WORKFLOW_ARTIFACTS_SECTION)).toBeTruthy());
    expect(view.getByTestId(TID_WORKFLOW_ARTIFACTS_SECTION).textContent).toContain("产物");
  });
});

// ── Phase roster (docs/dynamic-workflow/presentation.md "Past six participants") ──
// Stations past six participants: pin 5 pills (asking → running → failed → backfill), questions hang
// under the pinned asker, everyone else gets a cell, "list them all" expands a dense two-column roll
// (cells collapse while expanded — see "five pills and a door"); on a collapsed header the avatar
// cluster becomes a mini meter.
describe("WorkflowRunSidePane phase roster", () => {
  type FanStatus = "done" | "running" | "failed" | "pending";
  function fanoutSnapshot(
    n: number,
    statusOf: (index: number) => FanStatus,
    pendingQuestions: WorkflowRunState["pendingQuestions"] = [],
    unlistedByPhase?: WorkflowRunState["unlistedByPhase"],
  ) {
    // One lane spawning N instances: the static graph is a single `many` card; once the run arrives it splits into N pills.
    const steps: GraphStep[] = [
      {
        id: "ask#1",
        kind: "ask",
        label: "review",
        lane: "actor#1",
        phase: "phase#a",
      },
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
          : {
              phase: "settled",
              outcome: status === "failed" ? "failed" : "ok",
            }),
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

  it("pins 5: asking → running → failed → backfill; the question hangs under the pinned asker; the sixth is the door, closed", () => {
    fanoutSnapshot(9, mid, [question]);
    const view = renderPane();
    const section = view.getByTestId("workflow-run-phase");
    expect(section.getAttribute("data-phase-open")).toBe("true");
    const pins = within(section).getByTestId("workflow-roster-pins");
    const pills = within(pins).getAllByTestId("workflow-agent-pill");
    // asking 6 leads, then running 2 and 8, then failed 4, finally the backfill 1.
    expect(pills.map((pill) => pill.textContent)).toEqual([
      "reviewer-61 tasks",
      "reviewer-21 tasks",
      "reviewer-81 tasks",
      "reviewer-41 tasks",
      "reviewer-11 tasks",
    ]);
    // The question directly follows reviewer-6's row (same vertical flex container).
    const row = within(pins).getByTestId("workflow-run-question");
    expect(row.getAttribute("data-qid")).toBe("q-6");
    expect(row.parentElement).toBe(pills[0]!.parentElement);
    // The door: the other four (3 5 7 9, all done) — two faces, "4 more", the tally counts only the rest, a down chevron.
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
    // Door closed: no roll; no cells, meters or avatar clusters in the body either.
    expect(within(section).queryByTestId("workflow-roster-roll")).toBeNull();
    expect(within(section).queryByTestId("workflow-agent-cell")).toBeNull();
    expect(within(section).queryByTestId("workflow-roster-meter")).toBeNull();
    expect(within(section).queryByTestId("workflow-roster-meter-mini")).toBeNull();
    expect(within(section).queryByTestId("workflow-run-phase-cluster")).toBeNull();
  });

  it("behind the door is the roll: only the rest, grouped by status, tallies as headings; clicking again collapses; rows in the roll open transcripts with the workspace scope", () => {
    // 60 people: 1 and 7 running, 6 failed, the rest done.
    fanoutSnapshot(60, (i) => (i === 1 || i === 7 ? "running" : i === 6 ? "failed" : "done"));
    const view = renderPane();
    const section = view.getByTestId("workflow-run-phase");
    const door = within(section).getByTestId("workflow-roster-more-row");
    // running pins first: pin slots = 1, 7, 6, 2, 3; the other 55 = 4 5 8…60.
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
    // Rows in the roll are buttons opening transcripts with the tab's own workspace scope.
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
    // Click the door again: the roll collapses and the tally row returns.
    fireEvent.click(door);
    expect(within(section).queryByTestId("workflow-roster-roll")).toBeNull();
    expect(within(door).getByTestId("workflow-roster-tally")).toBeTruthy();
  });

  it("the roll groups by attention order: running and pending before done; the sixth asker lands in the roll with a ?", () => {
    // Nine people: 1-6 all asking (five pinned, the sixth falls into the roll); 7 running, 8 pending, 9 done.
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
    // The sixth asker reviewer-6: a ? on the row; the question itself is not repeated in the roll (the orphan block does not take it either — it has an asker).
    expect(within(rows[2]!).getByTestId("workflow-roll-asking")).toBeTruthy();
    expect(within(roll).queryByTestId("workflow-run-question")).toBeNull();
  });

  it("a collapsed roster station carries a mini meter on the header instead of an avatar cluster", () => {
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

  // The off-table ones (docs/dynamic-workflow/presentation.md "Past six participants", "The spine"):
  // subagents dropped by reduction have no pill and no row, but the door, tally row, meters and
  // settled/observed counts must all include them.
  it("evicted subagents enter the door count, tally row, mini meter and settled/observed, with one dim line at the roll's end stating the gap", () => {
    fanoutSnapshot(
      8,
      (i) => (i === 1 ? "running" : "done"),
      [],
      [
        {
          phaseName: "review",
          actors: 300,
          actorsSettled: 300,
          actorsFailed: 2,
          settled: 300,
        },
      ],
    );
    const view = renderPane();
    const section = view.getByTestId("workflow-run-phase");
    // Door: the other three on-table + three hundred off-table.
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
    // Steps: 7 of 8 on-table settled; the off-table 300 raise both numerator and denominator.
    expect(within(section).getByTestId("workflow-run-phase-fraction").textContent).toBe("307/308");
    // The roll can only list the three on-table; a trailing line accounts for the remaining three hundred.
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
    // Collapsed: the header is a mini meter (the roster decision also counts the off-table ones).
    fireEvent.click(within(section).getByTestId("workflow-run-phase-toggle"));
    expect(within(section).getByTestId("workflow-roster-meter-mini")).toBeTruthy();
  });

  it("four pills plus three hundred not-yet-run rejected subagents are still a roster: door yes, meter yes, avatar cluster no, tally row all pending", () => {
    fanoutSnapshot(4, () => "running", [], [{ phaseName: "review", actors: 300, settled: 0 }]);
    const view = renderPane();
    const section = view.getByTestId("workflow-run-phase");
    expect(within(section).getAllByTestId("workflow-agent-pill")).toHaveLength(4);
    const door = within(section).getByTestId("workflow-roster-more-row");
    expect(door.getAttribute("data-more-count")).toBe("300");
    // `actorsSettled` absent: not one of the three hundred has finished, so the tally must not call them done.
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

  it("zh-CN: both door titles and the group heading", () => {
    fanoutSnapshot(9, mid);
    const view = renderPane("zh-CN");
    const door = view.getByTestId("workflow-roster-more-row");
    expect(door.textContent).toContain("还有 4 个");
    expect(door.getAttribute("title")).toBe("还有 4 个子代理 · 在这里列出");
    fireEvent.click(door);
    expect(door.getAttribute("title")).toBe("还有 4 个子代理 · 收起");
    expect(view.getByTestId("workflow-roll-heading").textContent).toBe("4个已完成");
  });

  // ── Landing (follow-up to "five pills and a door"): the card's "n more" row / the station header hand
  // the station id to the host, and the tab arrives here with focusPhaseId — expand, open the door,
  // scroll the header to top, flash once; a fresh openedAt on the same station lands again.
  const landedTree = (overrides: Partial<WorkflowRunSidePaneTab>) =>
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(WorkflowRunSidePane, {
        tab: { ...tab, ...overrides },
        onOpenWorkflowActorSession,
      }),
    );

  it("tab with focusPhaseId: that station expands, the door opens, the header scrolls to top and flashes; a fresh openedAt lands again; without it, no landing", () => {
    const scrollIntoView = vi.fn();
    // jsdom has no scrollIntoView.
    Element.prototype.scrollIntoView = scrollIntoView;
    // No station running: all collapsed by default, so expansion can only come from the landing.
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
    // Reopened without a landing (the header's ⤢): no scroll, no collapse.
    view.rerender(landedTree({ openedAt: 3 }));
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(view.getByTestId("workflow-run-phase").getAttribute("data-phase-open")).toBe("true");
  });

  it("the flash is one-shot: the landed marker leaves after 1.2 s while expansion and roll stay", () => {
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

// ── The lineage row under the status header (docs/dynamic-workflow/presentation.md "The run pane") ──
describe("WorkflowRunSidePane lineage", () => {
  it.each([
    ["en-US", "Amends run"],
    ["zh-CN", "调整自 run"],
  ] as const)(
    "a revised run: one line under the status header reading Amends run X — %s",
    (locale, label) => {
      setSnapshot({ run: run({ resumedFrom: "dwfrun-prev" }) });
      const view = renderPane(locale);
      const line = view.getByTestId("workflow-run-amends");
      expect(line.textContent).toContain(label);
      expect(line.textContent).toContain("dwfrun-prev");
      expect(view.queryByTestId("workflow-run-superseded-by")).toBeNull();
    },
  );

  it("a superseded run: the status word carries the reason, the link opens the successor's detail with the successor's own launch-row id", () => {
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

  it("the row is static text when the successor is not in the projection", () => {
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
    expect(line.textContent).toContain("已被替代，后继 run");
    expect(line.textContent).toContain("dwfrun-gone");
  });

  it("an ordinary run has no lineage row", () => {
    setSnapshot({ run: run() });
    const view = renderPane();
    expect(view.queryByTestId("workflow-run-amends")).toBeNull();
    expect(view.queryByTestId("workflow-run-superseded-by")).toBeNull();
  });
});

// ── "Configure" (docs/dynamic-workflow/presentation.md "The run pane", "The settings popover") ──
// Status header has two rows: name + Configure / Resume / Stop, then lamp + status word + concurrency
// chip. Configure and Resume share one gray-release gate; on a configurable run the summary row's
// model segment is also an entry point. Once Apply is accepted the pane swaps in the new run's tab.
describe("WorkflowRunSidePane configure", () => {
  // Locale flows in through this helper's parameter instead of a literal initialLocale setup,
  // per the test-copy convention for locale-specific expectations.
  const renderSettingsTurn = (paneTab: WorkflowRunSidePaneTab, locale: "en-US" | "zh-CN") =>
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: locale },
        createElement(WorkflowRunSidePane, { tab: paneTab }),
      ),
    );

  beforeEach(() => {
    setDynamicWorkflowEnabled(true);
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    onOpenWorkflowRun.mockClear();
  });

  it("status header two rows: first name + Configure → Resume → Stop, second lamp + status word + concurrency chip", () => {
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

  // The chip comes and goes with Configure (docs/dynamic-workflow/concurrency.md "What the user sees"):
  // on a completed or superseded run nothing runs under it anymore and no control can change it, so a
  // leftover number would only be read as a live reading.
  it.each([
    ["completed", run({ status: "completed" })],
    [
      "superseded",
      run({
        status: "stopped",
        stopReason: "superseded",
        supersededBy: "run-next",
      }),
    ],
  ])(
    "a %s run draws no concurrency chip even while the fleet is under the ceiling",
    (_case, state) => {
      setSnapshot({
        run: {
          ...state,
          concurrencyCeiling: 13,
          concurrency: { cap: 13, ceiling: 13, limit: 4 },
        },
      });
      const view = renderPane();
      expect(view.queryByTestId("workflow-run-concurrency")).toBeNull();
      expect(view.queryByTestId("workflow-run-configure")).toBeNull();
    },
  );

  it.each([
    ["completed", run({ status: "completed" })],
    [
      "superseded",
      run({
        status: "stopped",
        stopReason: "superseded",
        supersededBy: "run-next",
      }),
    ],
  ])("a %s run has no Configure and the model segment is plain text", (_case, state) => {
    setSnapshot({ run: { ...state, subagentModel: "zhipu/glm-5.3" } });
    const view = renderPane();
    expect(view.queryByTestId("workflow-run-configure")).toBeNull();
    expect(view.getByTestId("workflow-run-subagent-model").tagName).toBe("SPAN");
  });

  it("gray off: no Configure", () => {
    setDynamicWorkflowEnabled(false);
    setSnapshot({ run: run() });
    expect(renderPane().queryByTestId("workflow-run-configure")).toBeNull();
  });

  it("zh-CN reads Configure; on a configurable run the model segment is a button opening the same popover as Configure", () => {
    setSnapshot({ run: run({ subagentModel: "zhipu/glm-5.3" }) });
    const view = renderPane("zh-CN");
    expect(view.getByTestId("workflow-run-configure").textContent).toBe("配置");
    const segment = view.getByTestId("workflow-run-subagent-model");
    expect(segment.tagName).toBe("BUTTON");
    fireEvent.click(segment);
    expect(segment.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[data-testid="workflow-run-settings-popover"]')).not.toBeNull();
  });

  it("Apply emits amendWorkflowRunSettings {workId ≡ runId, changed settings}; once the new run enters the projection the tab swaps to it in place", async () => {
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
    // At the moment of acceptance the new run is not yet in the projection: hold off.
    expect(onOpenWorkflowRun).not.toHaveBeenCalled();
    snapshot = {
      ...(snapshot as object),
      workflowRuns: {
        revision: 2,
        runs: [
          {
            ...current,
            status: "stopped",
            stopReason: "superseded",
            supersededBy: "dwfrun-2",
          },
          run({
            runId: "dwfrun-2",
            toolCallId: "settings-1",
            resumedFrom: "dwfrun-1",
          }),
        ],
      },
    };
    view.rerender(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(WorkflowRunSidePane, {
          tab: { ...tab },
          onOpenWorkflowRun,
        }),
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

  // Only the concurrency cap changed and the run is in flight: it applies in place; the result's
  // runId is the run itself with no supersededRunId (docs/dynamic-workflow/concurrency.md). There is
  // no successor to follow — this tab already is it.
  it("an in-place result (runId is itself, no supersededRunId): no tab-swap request", async () => {
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
    // The in-place consequence sentence: no longer says the current run will be stopped.
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
      expect.objectContaining({
        payload: { workId: "dwfrun-1", maxConcurrency: 3 },
      }),
    );
    // This run stays in the projection the whole time: if the follow logic did not recognize "the successor is itself", it would immediately request a tab swap here.
    await act(async () => {});
    expect(onOpenWorkflowRun).not.toHaveBeenCalled();
  });

  it("a run born of Configure borrows the predecessor's graph until the settings turn lands; once it lands, provenance says you adjusted the settings", () => {
    const settingsTab = { ...tab, toolCallId: "settings-1", runId: "dwfrun-2" };
    const predecessor = run({
      status: "stopped",
      stopReason: "superseded",
      supersededBy: "dwfrun-2",
    });
    const successor = run({
      runId: "dwfrun-2",
      toolCallId: "settings-1",
      resumedFrom: "dwfrun-1",
    });
    snapshot = {
      rows: { window: [graphRow] },
      workflowRuns: { revision: 1, runs: [predecessor, successor] },
    };
    const borrowed = renderSettingsTurn(settingsTab, "zh-CN");
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
    const landed = renderSettingsTurn(settingsTab, "zh-CN");
    const provenance = landed.getByTestId("workflow-run-provenance");
    expect(provenance.getAttribute("data-workflow-launch-kind")).toBe("settings");
    expect(provenance.textContent).toContain("由你调整设置");
    expect(landed.queryByTestId("workflow-run-provenance-scope")).toBeNull();
    const rows = landed.getByTestId("workflow-run-provenance-settings").textContent ?? "";
    expect(rows).toContain("子代理模型");
    expect(rows).toContain("会话模型 → glm-5.3-flash");
    expect(rows).toContain("最大并发数");
    expect(rows).toContain("默认 13 → 4");
  });

  // An in-place settings turn (docs/dynamic-workflow/concurrency.md): `amend` carries no predecessorRunId.
  // The provenance block identifies turns by toolCallId, so it is read only when the user has exactly
  // that turn's tab open — this block never reads predecessorRunId, and with it absent it still
  // recites what changed without blowing up.
  it("an in-place settings turn lands on the provenance block: with no predecessor it still recites the settings-changed wording and the ceiling row", () => {
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
    const view = renderSettingsTurn(retuneTab, "zh-CN");
    const provenance = view.getByTestId("workflow-run-provenance");
    expect(provenance.getAttribute("data-workflow-launch-kind")).toBe("settings");
    expect(provenance.textContent).toContain("由你调整设置");
    const rows = view.getByTestId("workflow-run-provenance-settings").textContent ?? "";
    expect(rows).toContain("最大并发数");
    expect(rows).toContain("默认 13 → 4");
    expect(rows).not.toContain("子代理模型");
  });
});

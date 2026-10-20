// @vitest-environment jsdom

// Parallel phases on the spine (docs/dynamic-workflow/presentation.md "The spine"): a band lying across the
// card, read vertically on the run
// detail page, like a commit graph — rails on the left, text on the right, and the two don't share a column.
// Forks and merges each take a 16px joint row between two sections, present only when a predecessor / join
// station exists; without them a strand starts and ends on its own lamp. The layout in
// `workflowRunSpine.ts` is a pure function; this pins both it and the fact that it really reaches the DOM.
import { createElement } from "react";
import { cleanup, render, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";
import { spineLayout } from "@/app-shell/workflowRunSpine.js";
import { WorkflowRunPhaseList } from "@/app-shell/WorkflowRunPhaseList.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

/** Skeleton graph with one ask member per station: `near[i]` is station i's `alongside`, edges given by index. */
function bandGraph(
  near: (number[] | undefined)[],
  edges: [number, number][],
): WorkflowCausalityGraphData {
  const steps: WorkflowCausalityGraphData["steps"] = near.map((_, i) => ({
    id: `ask#${i}`,
    kind: "ask",
    label: `step ${i}`,
    lane: `actor#${i}`,
    phase: `phase#${i}`,
  }));
  return {
    steps,
    lanes: near.map((_, i) => ({ id: `actor#${i}`, name: `agent ${i}` })),
    participants: near.map((_, i) => ({
      id: `phase#${i}:actor#${i}`,
      lane: `actor#${i}`,
      phase: `phase#${i}`,
      steps: [`ask#${i}`],
    })),
    handoffs: [],
    phases: near.map((alongside, i) => ({
      id: `phase#${i}`,
      name: `P${i}`,
      ...(alongside === undefined ? {} : { alongside: alongside.map((j) => `phase#${j}`) }),
    })),
    phaseEdges: edges.map(([from, to]) => ({ from: `phase#${from}`, to: `phase#${to}` })),
    exits: [`phase#${near.length - 1}`],
  };
}

type Node = WorkflowRunState["nodes"][number];
function run(nodes: Node[]): WorkflowRunState {
  return {
    runId: "dwfrun-1",
    toolCallId: "tool-wf-1",
    status: "running",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [],
    nodes,
    lastEventSequence: 0,
  };
}
const settled = (siteId: string): Node =>
  ({ siteId, ordinal: 1, phase: "settled", outcome: "ok" }) as Node;
const executing = (siteId: string): Node => ({ siteId, ordinal: 1, phase: "executing" }) as Node;

// A ∥ B → C: the bounded layer reports the reduced edges A → B, B → C.
const TESTFIELD = bandGraph(
  [undefined, [0], undefined],
  [
    [0, 1],
    [1, 2],
  ],
);
// The same band with one more station P in front: P → A gives the band a predecessor, B → C gives it a join station.
const WITH_PRED = bandGraph(
  [undefined, undefined, [1], undefined],
  [
    [0, 1],
    [1, 2],
    [2, 3],
  ],
);

function renderSpine(graph: WorkflowCausalityGraphData, state?: WorkflowRunState) {
  const model = buildWorkflowTimeline(graph, state);
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(WorkflowRunPhaseList, { graph, model, pendingQuestions: [], run: state }),
    ),
  );
}

// plan → {A ∥ B}, with no station after the band: has a predecessor, no join station (LOOP_B's shape).
const OPEN_END = bandGraph(
  [undefined, undefined, [1]],
  [
    [0, 1],
    [0, 2],
    [2, 0],
  ],
);

/** Direct children sequence of the container: sections are `phase:<index>`, joints are `fork` / `merge`. */
const sequenceOf = (view: ReturnType<typeof render>) =>
  [...view.getByTestId("workflow-run-phases").children].map((child) =>
    child.getAttribute("data-testid") === "workflow-run-spine-joint"
      ? child.getAttribute("data-joint-kind")
      : `phase:${child.getAttribute("data-phase-id")?.replace("phase#", "")}`,
  );

const railsOf = (element: HTMLElement) =>
  within(element)
    .queryAllByTestId("workflow-run-spine-rail")
    .map((rail) => ({
      ink: rail.getAttribute("data-rail-ink"),
      position: rail.getAttribute("data-rail-position"),
      track: rail.getAttribute("data-rail-track"),
    }));

beforeEach(() => {
  cleanup();
});

describe("spineLayout", () => {
  it("没有带时与从前一样：轨距 12、没有让位、每一节只有主轨的上下两截、没有接头", () => {
    const line = bandGraph(
      [undefined, undefined, undefined],
      [
        [0, 1],
        [1, 2],
      ],
    );
    const layout = spineLayout(buildWorkflowTimeline(line, undefined));
    expect(layout).toMatchObject({ gutter: 0, pitch: 12 });
    expect(layout.sections.map((section) => section.rails)).toEqual([
      [{ ink: "faint", position: "below", track: 0 }],
      [
        { ink: "faint", position: "above", track: 0 },
        { ink: "faint", position: "below", track: 0 },
      ],
      [{ ink: "faint", position: "above", track: 0 }],
    ]);
    expect(layout.sections.some((section) => section.fork ?? section.merge)).toBe(false);
  });

  it("带有前驱也有汇合站：分叉行在带首节之前、汇合行在带末节之后，主轨与分支各就各位", () => {
    const layout = spineLayout(buildWorkflowTimeline(WITH_PRED, undefined));
    expect(layout).toMatchObject({ gutter: 12, pitch: 12 });
    const [p, a, b, c] = layout.sections;
    expect(a!.fork).toEqual({ branches: [{ ink: "faint", track: 1 }], main: "faint" });
    expect(b!.merge).toEqual({ branches: [{ ink: "faint", track: 1 }], main: "faint" });
    expect([p, c].some((section) => section!.fork ?? section!.merge)).toBe(false);
    expect(p!.rails).toEqual([{ ink: "faint", position: "below", track: 0 }]);
    // A: the main rail comes down from the fork row to the lamp, then continues down to the merge row; the
    // branch rail passes straight through looking for B's lamp.
    expect(a!.rails).toEqual([
      { ink: "faint", position: "above", track: 0 },
      { ink: "faint", position: "below", track: 0 },
      { ink: "faint", position: "full", track: 1 },
    ]);
    // B: its own branch rail in above/below halves; the main rail passes through the whole section.
    expect(b!.rails).toEqual([
      { ink: "faint", position: "full", track: 0 },
      { ink: "faint", position: "above", track: 1 },
      { ink: "faint", position: "below", track: 1 },
    ]);
    expect(c!.rails).toEqual([{ ink: "faint", position: "above", track: 0 }]);
  });

  it("带从第一站起：分叉行是开口的根，两条 strand 从它下来", () => {
    const layout = spineLayout(buildWorkflowTimeline(TESTFIELD, undefined));
    const [a, b, c] = layout.sections;
    expect(a!.fork).toEqual({ branches: [{ ink: "faint", track: 1 }], main: "faint", open: true });
    expect(b!.merge).toEqual({ branches: [{ ink: "faint", track: 1 }], main: "faint" });
    // A on the main line: the main rail comes down from the root to the lamp, then continues down through B to
    // the merge row; the branch rail passes from the root straight through A looking for B.
    expect(a!.rails).toEqual([
      { ink: "faint", position: "above", track: 0 },
      { ink: "faint", position: "below", track: 0 },
      { ink: "faint", position: "full", track: 1 },
    ]);
    expect(b!.rails).toEqual([
      { ink: "faint", position: "full", track: 0 },
      { ink: "faint", position: "above", track: 1 },
      { ink: "faint", position: "below", track: 1 },
    ]);
    expect(c!.rails).toEqual([{ ink: "faint", position: "above", track: 0 }]);
  });

  it("带到最后一站：汇合行是开口的汇点，分支与主线在最后一节之下相遇", () => {
    const layout = spineLayout(buildWorkflowTimeline(OPEN_END, undefined));
    const [, a, b] = layout.sections;
    expect(a!.fork).toEqual({ branches: [{ ink: "faint", track: 1 }], main: "faint" });
    expect(b!.merge).toEqual({ branches: [{ ink: "faint", track: 1 }], main: "faint", open: true });
    expect(a!.rails).toEqual([
      { ink: "faint", position: "above", track: 0 },
      { ink: "faint", position: "below", track: 0 },
      { ink: "faint", position: "full", track: 1 },
    ]);
    // B: its own branch rail in above/below halves; the main line has no member after A and still passes
    // through the whole section to reach the merge row.
    expect(b!.rails).toEqual([
      { ink: "faint", position: "full", track: 0 },
      { ink: "faint", position: "above", track: 1 },
      { ink: "faint", position: "below", track: 1 },
    ]);
  });

  it("整个工作流就是一条带、每条 strand 只有一站：仍然画出根、每站一条线、汇点", () => {
    // Regression (on real hardware, 2026-09-24): four phases pairwise parallel with no station before or
    // after — under the old "start and end on the lamp" rule every strand had length zero and the spine
    // showed only four dangling lamps.
    const whole = bandGraph(
      [undefined, [0], [0, 1], [0, 1, 2]],
      [
        [0, 1],
        [1, 2],
        [2, 3],
      ],
    );
    const model = buildWorkflowTimeline(whole, undefined);
    expect(model.bands).toHaveLength(1);
    expect(model.bands[0]).toMatchObject({ from: 0, to: 3 });
    expect(model.bands[0]!.pred).toBeUndefined();
    expect(model.bands[0]!.join).toBeUndefined();
    const { sections } = spineLayout(model);
    expect(sections[0]!.fork).toMatchObject({ open: true });
    expect(sections[3]!.merge).toMatchObject({ open: true });
    expect(sections[0]!.fork!.branches.map((branch) => branch.track)).toEqual([1, 2, 3]);
    // All four tracks present in every section: one's own is in above/below halves, the others' pass through
    // whole.
    for (const [i, section] of sections.entries()) {
      expect(section.rails.map((rail) => [rail.track, rail.position])).toEqual(
        [0, 1, 2, 3].flatMap((t) =>
          t === i
            ? [
                [t, "above"],
                [t, "below"],
              ]
            : [[t, "full"]],
        ),
      );
    }
  });

  it("分支轨道穿过别人的节：只在 strand 活着的那几节整节穿过", () => {
    // Band {1,4}: track 0 has 1, 3, 4; track 1 has only 2; predecessor 0, join station 5.
    const wide = bandGraph(
      [undefined, undefined, [1], undefined, [2], undefined],
      [
        [0, 1],
        [1, 2],
        [2, 5],
        [3, 4],
        [4, 5],
      ],
    );
    const model = buildWorkflowTimeline(wide, undefined);
    expect(model.bands[0]).toMatchObject({ from: 1, join: 5, pred: 0, to: 4 });
    expect(model.bands[0]!.tracks.map((track) => track.stations)).toEqual([[1, 3, 4], [2]]);
    const { sections } = spineLayout(model);
    expect(sections[1]!.fork).toBeDefined();
    expect(sections[4]!.merge).toBeDefined();
    const track1 = (i: number) => sections[i]!.rails.filter((rail) => rail.track === 1);
    // Below the fork row, before the first lamp: passes through whole. After the last lamp, before the merge
    // row: also passes through whole.
    expect(track1(1)).toEqual([{ ink: "faint", position: "full", track: 1 }]);
    expect(track1(3)).toEqual([{ ink: "faint", position: "full", track: 1 }]);
    expect(track1(4)).toEqual([{ ink: "faint", position: "full", track: 1 }]);
    // The main rail passes through the branch station 2 (main-line members on both sides).
    expect(sections[2]!.rails.filter((rail) => rail.track === 0)).toEqual([
      { ink: "faint", position: "full", track: 0 },
    ]);
    // The join station's section has only the main rail's upper half: the merge lives in the row above it, not
    // in its section head.
    expect(sections[5]!.rails).toEqual([{ ink: "faint", position: "above", track: 0 }]);
  });

  it("轨距：最多四条分支轨时 12，多于四条收到 8；文字列让开整个轨道区", () => {
    const fan = (branches: number) => {
      const n = branches + 1;
      const near = [
        undefined,
        ...Array.from({ length: n }, (_, k) =>
          k === 0 ? undefined : Array.from({ length: k }, (_, j) => j + 1),
        ),
        undefined,
      ];
      const edges: [number, number][] = near.slice(1).map((_, k) => [k, k + 1]);
      return spineLayout(buildWorkflowTimeline(bandGraph(near, edges), undefined));
    };
    expect(fan(4)).toMatchObject({ gutter: 48, pitch: 12 });
    expect(fan(5)).toMatchObject({ gutter: 40, pitch: 8 });
  });

  it("并排的两条带：前一条的开口汇合行紧接后一条的开口分叉行", () => {
    // P → [A, B ∥ A, C ∥ B] → [D, E ∥ D] → J
    const adjacent = bandGraph(
      [undefined, undefined, [1], [2], undefined, [4], undefined],
      [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 4],
        [4, 5],
        [5, 6],
      ],
    );
    const model = buildWorkflowTimeline(adjacent, undefined);
    expect(model.bands.map((band) => [band.from, band.to, band.pred, band.join])).toEqual([
      [1, 3, 0, undefined],
      [4, 5, undefined, 6],
    ]);
    const { sections } = spineLayout(model);
    expect(
      sections.flatMap((section, i) =>
        [
          section.fork ? `fork:${i}${section.fork.open ? ":open" : ""}` : [],
          section.merge ? `merge:${i}${section.merge.open ? ":open" : ""}` : [],
        ].flat(),
      ),
    ).toEqual(["fork:1", "merge:3:open", "fork:4:open", "merge:5"]);
    // C's main rail continues down to the open merge row; D's main rail comes down from the open fork row.
    expect(sections[3]!.rails.find((rail) => rail.position === "below")).toEqual({
      ink: "faint",
      position: "below",
      track: 0,
    });
    expect(sections[4]!.rails.find((rail) => rail.position === "above")).toEqual({
      ink: "faint",
      position: "above",
      track: 0,
    });
  });
});

describe("WorkflowRunPhaseList · 带", () => {
  it("文字列让开整个轨道区：每一节的节头都从同一列起，灯留在自己的轨道上", () => {
    const view = renderSpine(TESTFIELD);
    const phases = view.getAllByTestId("workflow-run-phase");
    expect(phases.map((section) => section.getAttribute("data-phase-track"))).toEqual([
      "0",
      "1",
      "0",
    ]);
    for (const phase of phases) {
      expect(within(phase).getByTestId("workflow-run-phase-toggle").style.paddingLeft).toBe("51px");
    }
    const lamps = phases.map((phase) => within(phase).getByTestId("workflow-run-phase-lamp"));
    expect(lamps.map((lamp) => lamp.style.left)).toEqual(["", "28px", ""]);
  });

  it("接头行插在两节之间：每条带都有分叉行与汇合行，没有前驱 / 汇合站时是开口的", () => {
    expect(sequenceOf(renderSpine(WITH_PRED))).toEqual([
      "phase:0",
      "fork",
      "phase:1",
      "phase:2",
      "merge",
      "phase:3",
    ]);
    cleanup();
    expect(sequenceOf(renderSpine(TESTFIELD))).toEqual([
      "fork",
      "phase:0",
      "phase:1",
      "merge",
      "phase:2",
    ]);
    cleanup();
    expect(sequenceOf(renderSpine(OPEN_END))).toEqual([
      "phase:0",
      "fork",
      "phase:1",
      "phase:2",
      "merge",
    ]);
  });

  it("接头行：主轨直穿，每条分支一条曲线，带轨道号与墨", () => {
    const view = renderSpine(WITH_PRED);
    const fork = view
      .getAllByTestId("workflow-run-spine-joint")
      .find((joint) => joint.getAttribute("data-joint-kind") === "fork")!;
    expect(railsOf(fork)).toEqual([{ ink: "faint", position: "full", track: "0" }]);
    expect(fork.getAttribute("data-joint-open")).toBeNull();
    expect(within(fork).getByTestId("workflow-run-spine-rail").style.top).toBe("");
    const curves = within(fork).getAllByTestId("workflow-run-spine-fork");
    expect(
      curves.map((curve) => [
        curve.getAttribute("data-curve-track"),
        curve.getAttribute("data-curve-ink"),
      ]),
    ).toEqual([["1", "faint"]]);
    expect(fork.getAttribute("aria-hidden")).toBe("true");
  });

  it("开口的接头：主轨在行外 4px 起（根）/ 止（汇点），不从上一节或下一节借位", () => {
    const view = renderSpine(OPEN_END);
    const joints = view.getAllByTestId("workflow-run-spine-joint");
    const fork = joints.find((joint) => joint.getAttribute("data-joint-kind") === "fork")!;
    const merge = joints.find((joint) => joint.getAttribute("data-joint-kind") === "merge")!;
    expect(fork.getAttribute("data-joint-open")).toBeNull();
    expect(merge.getAttribute("data-joint-open")).toBe("true");
    const stub = within(merge).getByTestId("workflow-run-spine-rail");
    expect(stub.style.top).toBe("0px");
    expect(stub.style.bottom).toBe("-4px");
    cleanup();
    const root = renderSpine(TESTFIELD).getAllByTestId("workflow-run-spine-joint")[0]!;
    expect(root.getAttribute("data-joint-open")).toBe("true");
    expect(within(root).getByTestId("workflow-run-spine-rail").style.top).toBe("-4px");
  });

  it("汇合站在跑、两条轨道都到过：汇合行的主轨与分支曲线一起行进", () => {
    const view = renderSpine(
      TESTFIELD,
      run([settled("ask#0"), settled("ask#1"), executing("ask#2")]),
    );
    const [a, b, c] = view.getAllByTestId("workflow-run-phase");
    const merge = view
      .getAllByTestId("workflow-run-spine-joint")
      .find((joint) => joint.getAttribute("data-joint-kind") === "merge")!;
    expect(railsOf(merge)).toEqual([{ ink: "march", position: "full", track: "0" }]);
    const curve = within(merge).getByTestId("workflow-run-spine-merge");
    expect(curve.getAttribute("data-curve-ink")).toBe("march");
    // A lit light overlays the confluence curve: a gradient stroke (`url(#…)`), and the gradient itself lives
    // in this SVG; the light is drawn above all base ink,
    // so it is the curve's sibling rather than its child.
    expect(curve.querySelector("path.wf-lit")).toBeNull();
    const light = within(merge)
      .getByTestId("workflow-run-spine-merge-lit")
      .querySelector("path.wf-lit");
    expect(light?.getAttribute("data-testid")).toBe("workflow-march-light");
    expect(light?.getAttribute("stroke")).toMatch(/^url\(#.+\)$/);
    expect(merge.querySelector("linearGradient")).toBeTruthy();
    // The main-line segments (A's lower half, the main rail passing through B, C's upper half) march; B's
    // branch rail's lower half continues into the confluence curve.
    // The segments from the root are the entry ink of stations that have been reached: strong.
    expect(railsOf(a!)).toEqual([
      { ink: "strong", position: "above", track: "0" },
      { ink: "march", position: "below", track: "0" },
      { ink: "strong", position: "full", track: "1" },
    ]);
    expect(railsOf(b!)).toEqual([
      { ink: "march", position: "full", track: "0" },
      { ink: "strong", position: "above", track: "1" },
      { ink: "march", position: "below", track: "1" },
    ]);
    expect(railsOf(c!)).toEqual([{ ink: "march", position: "above", track: "0" }]);
  });

  it("带里两条轨道同时在跑：两节都自己展开，不只最右那个", () => {
    const view = renderSpine(TESTFIELD, run([executing("ask#0"), executing("ask#1")]));
    const phases = view.getAllByTestId("workflow-run-phase");
    expect(phases.map((phase) => phase.getAttribute("data-phase-status"))).toEqual([
      "running",
      "running",
      "pending",
    ]);
    expect(phases.map((phase) => phase.getAttribute("data-phase-open"))).toEqual([
      "true",
      "true",
      "false",
    ]);
    // The expanded pill column also sits on the text column.
    for (const phase of phases.slice(0, 2)) {
      expect(within(phase).getByTestId("workflow-run-phase-body").style.paddingLeft).toBe("51px");
    }
  });

  it("没有 alongside 的图：没有接头、没有让位，DOM 与从前一样", () => {
    const line = bandGraph(
      [undefined, undefined, undefined],
      [
        [0, 1],
        [1, 2],
      ],
    );
    const view = renderSpine(line, run([settled("ask#0"), executing("ask#1")]));
    expect(view.queryAllByTestId("workflow-run-spine-joint")).toHaveLength(0);
    const phases = view.getAllByTestId("workflow-run-phase");
    expect(phases.map((phase) => phase.getAttribute("data-phase-track"))).toEqual(["0", "0", "0"]);
    for (const phase of phases) {
      expect(within(phase).getByTestId("workflow-run-phase-toggle").style.paddingLeft).toBe("");
      for (const rail of within(phase).queryAllByTestId("workflow-run-spine-rail")) {
        expect(rail.getAttribute("data-rail-track")).toBe("0");
        expect(rail.style.left).toBe("");
      }
    }
    // The marching segment still lands on the segment entering the running station.
    expect(railsOf(phases[0]!)).toEqual([{ ink: "march", position: "below", track: "0" }]);
    expect(railsOf(phases[1]!)).toEqual([
      { ink: "march", position: "above", track: "0" },
      { ink: "faint", position: "below", track: "0" },
    ]);
  });
});

// The subagent's own model (presentation.md "The spine"): for a subagent whose persona names a model, the row's
// trailing count is followed by the model name,
// and the tooltip gains a line with the canonical string; a subagent running on the run's model says nothing.
describe("WorkflowRunPhaseList · 子代理的模型", () => {
  it("点名了模型的那一行带模型名（不带 providerId），tooltip 带规范串；其余行不带", () => {
    const state: WorkflowRunState = {
      ...run([
        { ...executing("ask#0"), actorSiteId: "actor#0", actorOrdinal: 1, kind: "ask" } as Node,
        { ...executing("ask#1"), actorSiteId: "actor#1", actorOrdinal: 1, kind: "ask" } as Node,
      ]),
      actors: [
        {
          siteId: "actor#0",
          ordinal: 1,
          name: "judge",
          status: "running",
          model: "4fc7f541-2382-4c32-be11-f021b8d7ed1d/GLM-5.3-Flash$high",
        },
        { siteId: "actor#1", ordinal: 1, name: "writer", status: "running" },
      ],
    };
    const view = renderSpine(TESTFIELD, state);
    const models = view.getAllByTestId("workflow-run-agent-model");
    expect(models).toHaveLength(1);
    expect(models[0]?.textContent).toMatch(/GLM-5\.3-Flash$/);
    expect(models[0]?.textContent).not.toContain("4fc7f541");
    const row = models[0]!.closest<HTMLElement>('[data-testid="workflow-agent-pill"]');
    expect(row?.getAttribute("title")).toBe(
      "judge\n4fc7f541-2382-4c32-be11-f021b8d7ed1d/GLM-5.3-Flash$high",
    );
    const pills = view.getAllByTestId("workflow-agent-pill");
    const writer = pills.find((pill) => pill.textContent?.includes("writer"));
    expect(writer?.getAttribute("title")).toBe("writer");
  });
});

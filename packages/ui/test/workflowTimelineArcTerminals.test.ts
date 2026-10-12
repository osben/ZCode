// @vitest-environment jsdom

// Arc terminal slots (docs/dynamic-workflow/presentation.md "Rails and arcs"): a station's takeoff and landing each
// occupy a slot, arcs from the left stay left and arcs to the right stay right, and on each side the lowest lane is
// outermost; a station with only one arc terminal keeps the lamp's centre; a band's fork and merge points take no
// slot. Regression: when a station had arcs both coming in and going out, the outgoing vertical crossed the incoming
// arrow (testfield "工作流压力测试" / workflow stress test).
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";
import { arcTerminalOffsets, lampX } from "@/components/workflow-timeline/timeline-geometry.js";
import { WorkflowTimeline } from "@/components/workflow-timeline/WorkflowTimeline.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

interface GraphSpec {
  names: readonly string[];
  /** Station index → the indexes of stations running alongside it. */
  alongside?: Record<number, readonly number[]>;
  edges: readonly (readonly [number, number])[];
}

function graphOf({ alongside = {}, edges, names }: GraphSpec): WorkflowCausalityGraphData {
  return {
    steps: names.map((name, i) => ({
      id: `ask#${i + 1}`,
      kind: "ask",
      label: name,
      line: i + 1,
      column: 1,
      lane: "actor#1",
      phase: `phase#${i + 1}`,
    })),
    lanes: [{ id: "actor#1", name: "worker", line: 1, column: 1 }],
    participants: names.map((_, i) => ({
      id: `phase#${i + 1}:actor#1`,
      phase: `phase#${i + 1}`,
      lane: "actor#1",
      steps: [`ask#${i + 1}`],
    })),
    handoffs: [],
    phases: names.map((name, i) => ({
      id: `phase#${i + 1}`,
      name,
      line: i + 1,
      column: 1,
      ...(alongside[i] === undefined
        ? {}
        : { alongside: alongside[i]!.map((j) => `phase#${j + 1}`) }),
    })),
    phaseEdges: edges.map(([from, to]) => ({ from: `phase#${from + 1}`, to: `phase#${to + 1}` })),
    exits: [`phase#${names.length}`],
  } as WorkflowCausalityGraphData;
}

const modelOf = (spec: GraphSpec) => buildWorkflowTimeline(graphOf(spec));

/** Takeoff and landing offsets for each arc (`from>to`). */
function offsetsOf(spec: GraphSpec): Record<string, { takeoff: number; landing: number }> {
  const model = modelOf(spec);
  const { landing, takeoff } = arcTerminalOffsets(model.arcs, model.bands, model.stations);
  return Object.fromEntries(
    model.arcs.map((arc, j) => [
      `${arc.from}>${arc.to}`,
      { landing: landing[j]! + 0, takeoff: takeoff[j]! + 0 },
    ]),
  );
}

const chain = (n: number): [number, number][] =>
  Array.from({ length: n - 1 }, (_, i) => [i, i + 1] as [number, number]);

/** Two hops: plan → draft → publish, one station apart between each. */
const HOPS: GraphSpec = {
  edges: [...chain(5), [0, 2], [2, 4]],
  names: ["plan", "gather", "draft", "review", "publish"],
};

/** Two independent choices reusing the same pair of phase names: edges exist in both directions, left ⇄ right. */
const TWO_CHOICES: GraphSpec = {
  edges: [
    [0, 1],
    [0, 2],
    [1, 2],
    [1, 3],
    [2, 1],
    [2, 3],
  ],
  names: ["choose", "left", "right", "next"],
};

/** The phase graph reduced from testfield "工作流压力测试" (workflow stress test, dwfrun-c6d25e4f…): eleven stations, fourteen edges, one band. */
const STRESS: GraphSpec = {
  alongside: { 9: [8] },
  edges: [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
    [3, 5],
    [4, 5],
    [4, 6],
    [5, 4],
    [5, 6],
    [6, 7],
    [7, 8],
    [7, 9],
    [8, 10],
    [9, 10],
  ],
  names: [
    "串行链：两步依赖",
    "并行扇出：四方同算",
    "回环门禁：修复到达标为止",
    "条件分支：按阈值选边",
    "支路甲：高门限汇总",
    "支路乙：低门限汇总",
    "混合扇出：逐项产出即复核",
    "并发相位：双翼交叠探针",
    "并发左翼：先行占位",
    "并发右翼：后行占位",
    "汇合收尾：成文与发布",
  ],
};

afterEach(cleanup);

describe("arcTerminalOffsets", () => {
  it("a station with one terminal keeps the lamp's centre", () => {
    expect(offsetsOf({ edges: [...chain(4), [3, 0]], names: ["a", "b", "c", "d"] })).toEqual({
      "3>0": { landing: 0, takeoff: 0 },
    });
    // Two independent arcs, each at an end: every station has a single arc terminal.
    expect(offsetsOf({ edges: [...chain(6), [0, 2], [5, 3]], names: "abcdef".split("") })).toEqual({
      "0>2": { landing: 0, takeoff: 0 },
      "5>3": { landing: 0, takeoff: 0 },
    });
  });

  it("an arc in from the left and an arc out to the right take the left and right slots", () => {
    const model = modelOf(HOPS);
    expect(model.arcs.map((arc) => [arc.from, arc.to, arc.lane])).toEqual([
      [0, 2, 0],
      [2, 4, 1],
    ]);
    expect(offsetsOf(HOPS)).toEqual({
      "0>2": { landing: -5, takeoff: 0 },
      "2>4": { landing: 0, takeoff: 5 },
    });
  });

  it("on one side the arc in the lowest lane stands outermost, landing or takeoff alike", () => {
    const model = modelOf(TWO_CHOICES);
    expect(model.arcs.map((arc) => [arc.from, arc.to, arc.lane])).toEqual([
      [2, 1, 0],
      [0, 2, 1],
      [1, 3, 2],
    ]);
    expect(offsetsOf(TWO_CHOICES)).toEqual({
      // left: both arc terminals face right — the landing (lane 0) is rightmost, the takeoff (lane 2) inside it.
      // right: both arc terminals face left — the takeoff (lane 0) is leftmost, the landing (lane 1) inside it.
      "0>2": { landing: 5, takeoff: 0 },
      "1>3": { landing: 0, takeoff: -5 },
      "2>1": { landing: 5, takeoff: -5 },
    });
  });

  it("a fan-out nests: three takeoffs to the right, lane 0 outermost", () => {
    const spec: GraphSpec = {
      edges: [...chain(5), [0, 2], [0, 3], [0, 4]],
      names: ["triage", "small", "medium", "large", "close"],
    };
    expect(offsetsOf(spec)).toEqual({
      "0>2": { landing: 0, takeoff: 10 },
      "0>3": { landing: 0, takeoff: 0 },
      "0>4": { landing: 0, takeoff: -10 },
    });
  });

  it("both sides at once: leftward terminals first, then rightward ones", () => {
    // c has four arc terminals: a → c and c → a face left, d → c and c → e face right.
    const spec: GraphSpec = {
      edges: [...chain(5), [0, 2], [2, 4], [3, 2], [2, 0]],
      names: ["a", "b", "c", "d", "e"],
    };
    const lanes = Object.fromEntries(
      modelOf(spec).arcs.map((arc) => [`${arc.from}>${arc.to}`, arc.lane]),
    );
    expect(lanes).toEqual({ "0>2": 1, "2>0": 3, "2>4": 2, "3>2": 0 });
    expect(offsetsOf(spec)).toEqual({
      // a: both arc terminals face right — the back-edge landing (lane 3) is inside, the takeoff (lane 1) outside.
      "0>2": { landing: -15, takeoff: 5 },
      "2>0": { landing: -5, takeoff: -5 },
      // c: left side a → c (lane 1) −15, c → a (lane 3) −5; right side c → e (lane 2) +5, d → c (lane 0) +15.
      "2>4": { landing: 0, takeoff: 5 },
      "3>2": { landing: 15, takeoff: 0 },
    });
  });

  it("a band's fork and merge points take no slot and do not count at the lamp", () => {
    // Band [[B, D], [C]] with predecessor P and merge J. D → B is the back edge on the main line, lamps at both ends.
    // S → B and T → C are re-anchored to the fork point (the index is still B), and D → X to the merge point (the
    // index is still D) — if they also took B's and D's slots, the back edges on those two lamps would be pushed out
    // of the lamp centre.
    const spec: GraphSpec = {
      alongside: { 4: [3], 5: [4] },
      edges: [
        [0, 1],
        [1, 2],
        [2, 3],
        [2, 4],
        [3, 5],
        [4, 6],
        [5, 6],
        [6, 7],
        [5, 3],
        [0, 3],
        [1, 4],
        [5, 7],
      ],
      names: ["S", "T", "P", "B", "C", "D", "J", "X"],
    };
    const model = modelOf(spec);
    expect(
      model.bands.map((band) => [
        band.from,
        band.to,
        band.pred,
        band.join,
        band.tracks.map((track) => track.stations),
      ]),
    ).toEqual([[3, 5, 2, 6, [[3, 5], [4]]]]);
    expect(model.arcs.map((arc) => [arc.from, arc.to, arc.air])).toEqual(
      expect.arrayContaining([
        [5, 3, 0],
        [0, 3, 1],
        [1, 3, 1],
        [5, 7, 1],
      ]),
    );
    expect(offsetsOf(spec)).toEqual({
      "0>3": { landing: 0, takeoff: 0 },
      "1>3": { landing: 0, takeoff: 0 },
      "5>3": { landing: 0, takeoff: 0 },
      "5>7": { landing: 0, takeoff: 0 },
    });
  });
});

describe("WorkflowTimeline arc terminals", () => {
  function terminalsOf(spec: GraphSpec) {
    const model = modelOf(spec);
    const view = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(WorkflowTimeline, { model }),
      ),
    );
    const byStation = new Map<number, number[]>();
    const add = (station: number, x: number) =>
      byStation.set(
        station,
        [...(byStation.get(station) ?? []), x].sort((l, r) => l - r),
      );
    for (const arc of view.getAllByTestId("workflow-timeline-arc")) {
      const d = arc.querySelector("path")!.getAttribute("d")!;
      // M xa,ya V … Q xa,ly … H … Q xb,ly xb,ly+8 V yb
      const xa = Number(/^M(-?[\d.]+),/u.exec(d)![1]);
      const xb = Number([...d.matchAll(/Q(-?[\d.]+),/gu)].at(-1)![1]);
      add(Number(arc.getAttribute("data-arc-from")), xa);
      add(Number(arc.getAttribute("data-arc-to")), xb);
    }
    return { byStation, model };
  }

  it("工作流压力测试: 支路甲 and 支路乙 each get two slots, no shared vertical", () => {
    const { byStation, model } = terminalsOf(STRESS);
    expect(model.arcs.map((arc) => [arc.from, arc.to, arc.lane])).toEqual([
      [5, 4, 0],
      [3, 5, 1],
      [4, 6, 2],
    ]);
    const lamp = (i: number) => lampX(i, 0);
    expect(Object.fromEntries(byStation)).toEqual({
      3: [lamp(3)],
      // Branch A: the takeoff to the mixed fan-out (lane 2) sits at −5, Branch B's back edge (lane 0) lands at +5.
      4: [lamp(4) - 5, lamp(4) + 5],
      // Branch B: the back-edge takeoff (lane 0) sits at −5, the conditional-branch arc (lane 1) lands at +5.
      5: [lamp(5) - 5, lamp(5) + 5],
      6: [lamp(6)],
    });
  });

  it("the two choices reusing phase names draw four distinct verticals", () => {
    const { byStation } = terminalsOf(TWO_CHOICES);
    for (const xs of byStation.values()) expect(new Set(xs).size).toBe(xs.length);
    expect(byStation.get(1)).toEqual([lampX(1) - 5, lampX(1) + 5]);
    expect(byStation.get(2)).toEqual([lampX(2) - 5, lampX(2) + 5]);
  });
});

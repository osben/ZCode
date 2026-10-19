import { describe, expect, it } from "vitest";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import {
  collapseStatuses,
  handoffsAround,
  handoffsWithin,
  instanceCardId,
  liveParticipantView,
  participantAlsoIn,
  participantById,
  participantCounts,
  participantRepeats,
  participantStatus,
} from "../src/components/workflow-graph/participant-model.js";
import {
  phasesOf,
  runHasPhaseVocabulary,
} from "../src/components/workflow-graph/instance-phases.js";
import type {
  StepRunStatus,
  WorkflowCausalityGraphData,
  WorkflowParticipantData,
  WorkflowStepData,
} from "../src/components/workflow-graph/types.js";
import { expectedCopy } from "./helpers/uiCopy.js";

/**
 * Pure selectors of the participant layer (docs/dynamic-workflow/presentation.md). The payload's
 * `participants` are already in handoff order and `handoffs` are already reduced; this file only
 * buckets, counts, and folds statuses, plus the live view (`many` cards split by instance, member
 * cards narrowed by ordinal; addendum 2026-09-04: a single card binds its unique instance and
 * splits the same way with multiple instances).
 * Implicit phase synthesis lives in the workflowPhaseModel suite.
 */

function step(
  overrides: Partial<WorkflowStepData> & { id: string; lane: string; phase: string },
): WorkflowStepData {
  return { kind: "ask", label: overrides.id, ...overrides };
}

// The fixer appears in both the attempt and gate phases; the workspace only in attempt; the referee
// only in gate.
// Inside attempt, fixer -> workspace -> fixer forms one cycle (the back edge `back`).
const GRAPH: WorkflowCausalityGraphData = {
  exits: ["phase#2"],
  handoffs: [
    { from: "phase#1:actor#1", to: "phase#1:workspace", types: ["Patch"] },
    { back: true, from: "phase#1:workspace", to: "phase#1:actor#1" },
    { from: "phase#2:actor#1", to: "phase#2:actor#2", types: ["Report", "Bench"] },
  ],
  lanes: [
    { id: "actor#1", line: 3, name: "fixer" },
    { id: "actor#2", line: 4, name: "referee" },
    { id: "workspace" },
  ],
  participants: [
    { id: "phase#1:actor#1", lane: "actor#1", phase: "phase#1", steps: ["ask#1", "ask#2"] },
    {
      id: "phase#1:workspace",
      lane: "workspace",
      phase: "phase#1",
      steps: ["world-read#1", "world-read#2", "world-read#3"],
    },
    { id: "phase#2:actor#1", lane: "actor#1", phase: "phase#2", steps: ["ask#3"] },
    { id: "phase#2:actor#2", lane: "actor#2", phase: "phase#2", steps: ["ask#4"] },
  ],
  phaseEdges: [{ from: "phase#1", to: "phase#2" }],
  phases: [
    { id: "phase#1", line: 2, name: "attempt" },
    { id: "phase#2", line: 9, name: "gate" },
  ],
  sink: ["ask#4"],
  steps: [
    step({ id: "ask#1", lane: "actor#1", phase: "phase#1" }),
    step({ id: "ask#2", lane: "actor#1", phase: "phase#1", repeat: "serial" }),
    step({ id: "world-read#1", kind: "world-read", lane: "workspace", phase: "phase#1" }),
    step({ id: "world-read#2", kind: "world-read", lane: "workspace", phase: "phase#1" }),
    step({ id: "world-read#3", kind: "world-read", lane: "workspace", phase: "phase#1" }),
    step({ id: "ask#3", lane: "actor#1", phase: "phase#2" }),
    step({ id: "ask#4", lane: "actor#2", phase: "phase#2" }),
  ],
};

const by = (id: string): WorkflowParticipantData => participantById(GRAPH, id)!;

describe("participantCounts", () => {
  it("counts asks for a subagent card and reads for the workspace card — never both", () => {
    expect(participantCounts(GRAPH, by("phase#1:actor#1"))).toEqual({ asks: 2, reads: 0 });
    expect(participantCounts(GRAPH, by("phase#1:workspace"))).toEqual({ asks: 0, reads: 3 });
    expect(participantCounts(GRAPH, by("phase#2:actor#2"))).toEqual({ asks: 1, reads: 0 });
  });

  it("counts an unknown step id as an ask rather than dropping it", () => {
    // The payload never produces this; if it did, matching the card's number against the steps length beats not matching.
    const orphan: WorkflowParticipantData = {
      id: "phase#2:actor#9",
      lane: "actor#9",
      phase: "phase#2",
      steps: ["ask#404"],
    };
    expect(participantCounts(GRAPH, orphan)).toEqual({ asks: 1, reads: 0 });
  });
});

describe("participantRepeats", () => {
  it("flags the card when any of its steps carries `repeat` — the self-loop's only trace", () => {
    expect(participantRepeats(GRAPH, by("phase#1:actor#1"))).toBe(true);
    expect(participantRepeats(GRAPH, by("phase#1:workspace"))).toBe(false);
    expect(participantRepeats(GRAPH, by("phase#2:actor#1"))).toBe(false);
  });
});

describe("handoffsAround / handoffsWithin", () => {
  it("splits a card's hand-offs into incoming and outgoing, verbatim edges", () => {
    const around = handoffsAround(GRAPH, "phase#1:actor#1");
    expect(around.outgoing).toEqual([
      { from: "phase#1:actor#1", to: "phase#1:workspace", types: ["Patch"] },
    ]);
    expect(around.incoming).toEqual([
      { back: true, from: "phase#1:workspace", to: "phase#1:actor#1" },
    ]);
    // Only handoffs are collected, never phase edges: nobody hands off to the gate's fixer.
    expect(handoffsAround(GRAPH, "phase#2:actor#1")).toEqual({
      incoming: [],
      outgoing: [{ from: "phase#2:actor#1", to: "phase#2:actor#2", types: ["Report", "Bench"] }],
    });
    expect(handoffsAround(GRAPH, "nobody")).toEqual({ incoming: [], outgoing: [] });
  });

  it("keeps only the edges with both ends inside the given set", () => {
    const attempt = new Set(["phase#1:actor#1", "phase#1:workspace"]);
    expect(handoffsWithin(GRAPH, attempt)).toHaveLength(2);
    // One end outside the set => does not count: handoffs are strictly phase-internal, so this edge never appears in any module.
    const mixed = new Set(["phase#1:actor#1", "phase#2:actor#2"]);
    expect(handoffsWithin(GRAPH, mixed)).toEqual([]);
    expect(handoffsWithin(GRAPH, new Set())).toEqual([]);
  });
});

describe("participantAlsoIn", () => {
  it("lists the OTHER phases the same lane appears in, in phase-table order", () => {
    expect(participantAlsoIn(GRAPH, by("phase#1:actor#1")).map((phase) => phase.id)).toEqual([
      "phase#2",
    ]);
    expect(participantAlsoIn(GRAPH, by("phase#2:actor#1")).map((phase) => phase.id)).toEqual([
      "phase#1",
    ]);
    expect(participantAlsoIn(GRAPH, by("phase#1:workspace"))).toEqual([]);
    expect(participantAlsoIn(GRAPH, by("phase#2:actor#2"))).toEqual([]);
  });

  it("dedupes when a lane has several cards in one other phase (member cards)", () => {
    const graph: WorkflowCausalityGraphData = {
      ...GRAPH,
      participants: [
        ...GRAPH.participants,
        {
          id: "phase#2:actor#2[0]",
          lane: "actor#2",
          member: { index: 0, of: 2 },
          phase: "phase#2",
          steps: ["ask#4"],
        },
        {
          id: "phase#2:actor#2[1]",
          lane: "actor#2",
          member: { index: 1, of: 2 },
          phase: "phase#2",
          steps: ["ask#4"],
        },
        { id: "phase#1:actor#2", lane: "actor#2", phase: "phase#1", steps: ["ask#1"] },
      ],
    };
    expect(
      participantAlsoIn(graph, participantById(graph, "phase#1:actor#2")!).map((p) => p.id),
    ).toEqual(["phase#2"]);
  });
});

describe("collapseStatuses", () => {
  const collapse = (...values: StepRunStatus[]) => {
    const statuses: Record<string, StepRunStatus> = {};
    values.forEach((value, index) => {
      statuses[`s${index}`] = value;
    });
    return collapseStatuses(Object.keys(statuses), statuses);
  };

  it("reports running first — the reader's first question is whether it still moves", () => {
    expect(collapse("failed", "running")).toBe("running");
    expect(collapse("done", "running", "pending")).toBe("running");
  });

  it("reports failed once everything settled and something failed", () => {
    expect(collapse("done", "failed")).toBe("failed");
  });

  it("reports done only when every member settled cleanly", () => {
    expect(collapse("done", "done")).toBe("done");
  });

  it("reads a set with both settled and queued members as running: started, not finished", () => {
    // Addendum "absence is not a state": the old rule read half-done as "not started yet" — the same confusion as reading absence as pending.
    expect(collapse("done", "pending")).toBe("running");
    expect(collapse("pending", "failed")).toBe("running");
  });

  it("is pending only when every member is queued", () => {
    expect(collapse("pending")).toBe("pending");
    expect(collapse("pending", "pending")).toBe("pending");
  });

  it("is undefined in the static view and when none of the ids were observed", () => {
    expect(collapseStatuses(["a", "b"], undefined)).toBeUndefined();
    expect(collapseStatuses(["a", "b"], {})).toBeUndefined();
    expect(collapseStatuses([], { a: "running" })).toBeUndefined();
    // Only ids owned by this card count: someone else's running does not light up this card.
    expect(collapseStatuses(["a"], { a: "done", b: "running" })).toBe("done");
    // Ids without an entry do not participate: branch sites the control flow never took must not drag settled siblings into pending.
    expect(collapseStatuses(["a", "b"], { a: "done" })).toBe("done");
    expect(collapseStatuses(["a", "b"], { b: "failed" })).toBe("failed");
  });
});

describe("participantStatus", () => {
  it("prefers the live view's per-instance override, else folds the card's steps", () => {
    const statuses: Record<string, StepRunStatus> = { "ask#1": "done", "ask#2": "running" };
    expect(participantStatus(by("phase#1:actor#1"), statuses)).toBe("running");
    expect(
      participantStatus(by("phase#1:actor#1"), statuses, { "phase#1:actor#1": "failed" }),
    ).toBe("failed");
    // This card is not in the override table -> fall back to the step fold.
    expect(participantStatus(by("phase#1:actor#1"), statuses, { other: "failed" })).toBe("running");
    // No observations at all -> static.
    expect(participantStatus(by("phase#2:actor#2"), statuses)).toBeUndefined();
    expect(participantStatus(by("phase#2:actor#2"), undefined)).toBeUndefined();
  });
});

describe("instanceCardId", () => {
  it("suffixes the participant id with `@ordinal`", () => {
    expect(instanceCardId("phase#2:actor#3", 4)).toBe("phase#2:actor#3@4");
  });
});

describe("liveParticipantView", () => {
  // The gate gains a `many` card (judge, lane actor#3) and two referee member cards; the judge receives the fixer's handoff.
  const LIVE_GRAPH: WorkflowCausalityGraphData = {
    ...GRAPH,
    handoffs: [
      ...GRAPH.handoffs,
      { from: "phase#2:actor#1", to: "phase#2:actor#3", types: ["Draft"] },
      { from: "phase#2:actor#3", to: "phase#2:actor#2[0]" },
    ],
    lanes: [...GRAPH.lanes, { id: "actor#3", line: 5 }],
    participants: [
      ...GRAPH.participants.slice(0, 3),
      {
        id: "phase#2:actor#2[0]",
        lane: "actor#2",
        member: { index: 0, of: 2 },
        phase: "phase#2",
        steps: ["ask#4"],
      },
      {
        id: "phase#2:actor#2[1]",
        lane: "actor#2",
        member: { index: 1, of: 2 },
        phase: "phase#2",
        steps: ["ask#4"],
      },
      {
        id: "phase#2:actor#3",
        lane: "actor#3",
        many: true,
        phase: "phase#2",
        steps: ["ask#5~actor#3"],
      },
    ],
    steps: [
      ...GRAPH.steps,
      // A copy expanded from the may-set: the node reports the site id `ask#5`, and the join key goes through `source`.
      step({
        id: "ask#5~actor#3",
        lane: "actor#3",
        lanes: ["actor#3", "actor#1"],
        phase: "phase#2",
        source: "ask#5",
      }),
    ],
  };

  function runWith(
    actors: WorkflowRunState["actors"],
    nodes: WorkflowRunState["nodes"],
  ): WorkflowRunState {
    return {
      actors,
      usage: { spentTokens: 0, nodesUsed: nodes.length },
      lastEventSequence: nodes.length,
      nodes,
      runId: "dwfrun-1",
      status: "running",
    };
  }

  it("is the identity without a run — same graph reference, nothing overridden", () => {
    const view = liveParticipantView(LIVE_GRAPH, undefined);
    expect(view.graph).toBe(LIVE_GRAPH);
    expect(view.instances).toEqual({});
    expect(view.participantStatuses).toEqual({});
  });

  it("splits a `many` card into one `${id}@${ordinal}` card per actor instance, copying its hand-offs", () => {
    const run = runWith(
      // Given out of order: instance cards are sorted by ordinal.
      [
        { ordinal: 2, siteId: "actor#3", status: "running" },
        { name: "judge-1", ordinal: 1, siteId: "actor#3", status: "waiting" },
      ],
      [
        {
          actorOrdinal: 1,
          actorSiteId: "actor#3",
          ordinal: 1,
          phase: "settled",
          outcome: "ok",
          siteId: "ask#5",
        },
        {
          actorOrdinal: 2,
          actorSiteId: "actor#3",
          ordinal: 2,
          phase: "executing",
          siteId: "ask#5",
        },
        // Instances of the same site on other lanes have nothing to do with this card.
        {
          actorOrdinal: 1,
          actorSiteId: "actor#1",
          ordinal: 3,
          phase: "settled",
          outcome: "failed",
          siteId: "ask#5",
        },
      ],
    );
    const view = liveParticipantView(LIVE_GRAPH, run);

    expect(view.graph).not.toBe(LIVE_GRAPH);
    expect(view.graph.participants.map((participant) => participant.id)).toEqual([
      "phase#1:actor#1",
      "phase#1:workspace",
      "phase#2:actor#1",
      "phase#2:actor#2[0]",
      "phase#2:actor#2[1]",
      "phase#2:actor#3@1",
      "phase#2:actor#3@2",
    ]);
    const split = view.graph.participants.filter((participant) => participant.id.includes("@"));
    // The instance card is no longer `many`: it is one concrete instance.
    expect(split.every((participant) => participant.many === undefined)).toBe(true);
    expect(split[0]).toMatchObject({ lane: "actor#3", phase: "phase#2", steps: ["ask#5~actor#3"] });

    expect(view.participantStatuses["phase#2:actor#3@1"]).toBe("done");
    expect(view.participantStatuses["phase#2:actor#3@2"]).toBe("running");
    expect(view.instances).toEqual({
      "phase#2:actor#3@1": { name: "judge-1", ordinal: 1, participant: "phase#2:actor#3" },
      "phase#2:actor#3@2": { ordinal: 2, participant: "phase#2:actor#3" },
    });

    // Handoffs in and out of this card are each copied onto every instance card; other edges verbatim.
    expect(view.graph.handoffs).toEqual([
      ...GRAPH.handoffs,
      { from: "phase#2:actor#1", to: "phase#2:actor#3@1", types: ["Draft"] },
      { from: "phase#2:actor#1", to: "phase#2:actor#3@2", types: ["Draft"] },
      { from: "phase#2:actor#3@1", to: "phase#2:actor#2[0]" },
      { from: "phase#2:actor#3@2", to: "phase#2:actor#2[0]" },
    ]);
    // The rest of the graph is untouched.
    expect(view.graph.steps).toBe(LIVE_GRAPH.steps);
    expect(view.graph.phases).toBe(LIVE_GRAPH.phases);
  });

  it("keeps the `many` card whole while no instance has appeared yet", () => {
    const run = runWith(
      [{ ordinal: 1, siteId: "actor#1", status: "running" }],
      [
        {
          actorOrdinal: 1,
          actorSiteId: "actor#1",
          ordinal: 1,
          phase: "executing",
          siteId: "ask#1",
        },
      ],
    );
    const view = liveParticipantView(LIVE_GRAPH, run);
    // No split -> the graph reference is unchanged (memo-friendly); the `many` card's status is left to the step fold and binds no instance.
    expect(view.graph).toBe(LIVE_GRAPH);
    expect("phase#2:actor#3" in view.instances).toBe(false);
    expect("phase#2:actor#3" in view.participantStatuses).toBe(false);
  });

  it("narrows a member card to the index-th actor of its lane by ordinal; a missing actor reads pending", () => {
    const run = runWith(
      // ordinal 7 arrives first, then 3: member 0 is ordinal 3 and member 1 is 7.
      [
        { name: "referee-b", ordinal: 7, siteId: "actor#2", status: "waiting" },
        { ordinal: 3, siteId: "actor#2", status: "running" },
      ],
      [
        {
          actorOrdinal: 3,
          actorSiteId: "actor#2",
          ordinal: 1,
          phase: "settled",
          outcome: "failed",
          siteId: "ask#4",
        },
        {
          actorOrdinal: 3,
          actorSiteId: "actor#2",
          ordinal: 2,
          phase: "executing",
          siteId: "ask#4",
        },
        {
          actorOrdinal: 7,
          actorSiteId: "actor#2",
          ordinal: 4,
          phase: "settled",
          outcome: "ok",
          siteId: "ask#4",
        },
      ],
    );
    const view = liveParticipantView(LIVE_GRAPH, run);

    // Member 0 = ordinal 3: failed + running -> running (running wins); member 1 = ordinal 7: done.
    expect(view.participantStatuses["phase#2:actor#2[0]"]).toBe("running");
    expect(view.participantStatuses["phase#2:actor#2[1]"]).toBe("done");
    // Member cards do not split: the graph reference is unchanged and non-member cards get no overrides.
    expect(view.graph).toBe(LIVE_GRAPH);
    expect("phase#2:actor#1" in view.participantStatuses).toBe(false);
    // Member cards bind their own instances (addendum 2026-09-04): the name comes from the instance, the id is unchanged, and `bound` marks it as not a split card.
    expect(view.instances).toEqual({
      "phase#2:actor#2[0]": { bound: true, ordinal: 3, participant: "phase#2:actor#2[0]" },
      "phase#2:actor#2[1]": {
        bound: true,
        name: "referee-b",
        ordinal: 7,
        participant: "phase#2:actor#2[1]",
      },
    });

    // Only one instance: member 1's actor has not appeared yet -> pending, not absent.
    const oneActor = liveParticipantView(
      LIVE_GRAPH,
      runWith(
        [{ ordinal: 3, siteId: "actor#2", status: "waiting" }],
        [
          {
            actorOrdinal: 3,
            actorSiteId: "actor#2",
            ordinal: 1,
            phase: "settled",
            outcome: "ok",
            siteId: "ask#4",
          },
        ],
      ),
    );
    expect(oneActor.participantStatuses["phase#2:actor#2[0]"]).toBe("done");
    expect(oneActor.participantStatuses["phase#2:actor#2[1]"]).toBe("pending");
    expect("phase#2:actor#2[1]" in oneActor.instances).toBe(false);
    // More instances than `of`: surplus instances get no cards — the static cardinality is the literal the author wrote down; this is the difference between member cards and single cards.
    const surplus = liveParticipantView(
      LIVE_GRAPH,
      runWith(
        [3, 7, 9].map((ordinal) => ({ ordinal, siteId: "actor#2", status: "waiting" as const })),
        [],
      ),
    );
    expect(surplus.graph).toBe(LIVE_GRAPH);
    expect(Object.keys(surplus.instances)).toEqual(["phase#2:actor#2[0]", "phase#2:actor#2[1]"]);
    // Instances present but zero nodes -> an aggregated empty set = pending.
    const idle = liveParticipantView(
      LIVE_GRAPH,
      runWith([{ ordinal: 3, siteId: "actor#2", status: "waiting" }], []),
    );
    expect(idle.participantStatuses["phase#2:actor#2[0]"]).toBe("pending");
  });

  it("binds a single card to its one actor: runtime name carried, id and graph untouched", () => {
    const run = runWith(
      [{ name: "修复员", ordinal: 4, siteId: "actor#1", status: "running" }],
      [
        {
          actorOrdinal: 4,
          actorSiteId: "actor#1",
          ordinal: 1,
          phase: "executing",
          siteId: "ask#1",
        },
      ],
    );
    const view = liveParticipantView(LIVE_GRAPH, run);

    // No split -> the graph reference is unchanged.
    expect(view.graph).toBe(LIVE_GRAPH);
    // The fixer has one single card in each phase: the same instance binds to each (two appearances of the same subagent).
    expect(view.instances["phase#1:actor#1"]).toEqual({
      bound: true,
      name: "修复员",
      ordinal: 4,
      participant: "phase#1:actor#1",
    });
    expect(view.instances["phase#2:actor#1"]).toEqual({
      bound: true,
      name: "修复员",
      ordinal: 4,
      participant: "phase#2:actor#1",
    });
    // Binding does not change the status source: single cards still fold from steps, with no override values.
    expect("phase#1:actor#1" in view.participantStatuses).toBe(false);
    expect("phase#2:actor#1" in view.participantStatuses).toBe(false);
  });

  it("splits a single card like `many` once two actors have appeared on its lane", () => {
    const run = runWith(
      // Given out of order: instance cards are sorted by ordinal.
      [
        { name: "fixer-b", ordinal: 6, siteId: "actor#1", status: "waiting" },
        { name: "fixer-a", ordinal: 2, siteId: "actor#1", status: "running" },
      ],
      [
        {
          actorOrdinal: 2,
          actorSiteId: "actor#1",
          ordinal: 1,
          phase: "executing",
          siteId: "ask#1",
        },
        {
          actorOrdinal: 6,
          actorSiteId: "actor#1",
          ordinal: 2,
          phase: "settled",
          outcome: "ok",
          siteId: "ask#1",
        },
        {
          actorOrdinal: 6,
          actorSiteId: "actor#1",
          ordinal: 3,
          phase: "settled",
          outcome: "failed",
          siteId: "ask#3",
        },
      ],
    );
    const view = liveParticipantView(LIVE_GRAPH, run);

    expect(view.graph).not.toBe(LIVE_GRAPH);
    expect(view.graph.participants.map((participant) => participant.id)).toEqual([
      "phase#1:actor#1@2",
      "phase#1:actor#1@6",
      "phase#1:workspace",
      "phase#2:actor#1@2",
      "phase#2:actor#1@6",
      "phase#2:actor#2[0]",
      "phase#2:actor#2[1]",
      "phase#2:actor#3",
    ]);
    // Split cards carry no `bound`: they are that instance, and the label reads `#ordinal`.
    expect(view.instances["phase#1:actor#1@2"]).toEqual({
      name: "fixer-a",
      ordinal: 2,
      participant: "phase#1:actor#1",
    });
    expect(view.instances["phase#2:actor#1@6"]).toEqual({
      name: "fixer-b",
      ordinal: 6,
      participant: "phase#2:actor#1",
    });
    // Status narrows per instance (the same rule as the `many` split).
    expect(view.participantStatuses).toMatchObject({
      "phase#1:actor#1@2": "running",
      "phase#1:actor#1@6": "done",
      "phase#2:actor#1@2": "pending",
      "phase#2:actor#1@6": "failed",
    });
    // Handoffs in and out of the original card are each copied onto every instance card (both ends of the attempt cycle and the two edges the fixer emits in gate); other edges verbatim.
    expect(view.graph.handoffs).toEqual([
      { from: "phase#1:actor#1@2", to: "phase#1:workspace", types: ["Patch"] },
      { from: "phase#1:actor#1@6", to: "phase#1:workspace", types: ["Patch"] },
      { back: true, from: "phase#1:workspace", to: "phase#1:actor#1@2" },
      { back: true, from: "phase#1:workspace", to: "phase#1:actor#1@6" },
      { from: "phase#2:actor#1@2", to: "phase#2:actor#2", types: ["Report", "Bench"] },
      { from: "phase#2:actor#1@6", to: "phase#2:actor#2", types: ["Report", "Bench"] },
      { from: "phase#2:actor#1@2", to: "phase#2:actor#3", types: ["Draft"] },
      { from: "phase#2:actor#1@6", to: "phase#2:actor#3", types: ["Draft"] },
      { from: "phase#2:actor#3", to: "phase#2:actor#2[0]" },
    ]);
  });
  // ——— Addendum 2026-09-09 "runtime instances carry phase coordinates": binding changes from "by lane" to "by (site, phase)" ———

  /**
   * Shape of the bug: one `runBatch(p)` called once from each of 5 phases, dispatching 20 subagents
   * in parallel each time. The static view is correct — one lane `actor#1` and one ask site `ask#1`
   * claimed by 5 phases, hence 5 copies and 5 `many` cards.
   */
  const FAN_OUT_PHASES = ["调研", "起草", "校对", "复核", "收尾"];
  const FAN_OUT: WorkflowCausalityGraphData = {
    exits: ["phase#5"],
    handoffs: [],
    lanes: [{ id: "actor#1", name: "worker" }],
    participants: FAN_OUT_PHASES.map((_, i) => ({
      id: `phase#${i + 1}:actor#1`,
      lane: "actor#1",
      many: true,
      phase: `phase#${i + 1}`,
      steps: [`ask#1~phase#${i + 1}`],
    })),
    phaseEdges: FAN_OUT_PHASES.slice(1).map((_, i) => ({
      from: `phase#${i + 1}`,
      to: `phase#${i + 2}`,
    })),
    phases: FAN_OUT_PHASES.map((name, i) => ({ id: `phase#${i + 1}`, name })),
    steps: FAN_OUT_PHASES.map((_, i) =>
      step({
        id: `ask#1~phase#${i + 1}`,
        lane: "actor#1",
        phase: `phase#${i + 1}`,
        source: "ask#1",
      }),
    ),
  };

  /** 100 instances and 100 nodes, all on the same lane and the same site, differing only in birth phase. */
  function fanOutRun(stamped: boolean): WorkflowRunState {
    const stamp = (name: string) => (stamped ? { phaseName: name } : {});
    return runWith(
      FAN_OUT_PHASES.flatMap((name, i) =>
        Array.from({ length: 20 }, (_, k) => ({
          ordinal: i * 20 + k + 1,
          siteId: "actor#1",
          status: "waiting" as const,
          ...stamp(name),
        })),
      ),
      FAN_OUT_PHASES.flatMap((name, i) =>
        Array.from({ length: 20 }, (_, k) => ({
          actorOrdinal: i * 20 + k + 1,
          actorSiteId: "actor#1",
          ordinal: i * 20 + k + 1,
          outcome: "ok" as const,
          phase: "settled" as const,
          siteId: "ask#1",
          ...stamp(name),
        })),
      ),
    );
  }

  it("splits a re-entered site by the instance's birth phase: each card lists its own 20, not all 100", () => {
    const view = liveParticipantView(FAN_OUT, fanOutRun(true));

    expect(view.graph.participants).toHaveLength(100);
    FAN_OUT_PHASES.forEach((_, i) => {
      const cards = view.graph.participants.filter(
        (participant) => participant.phase === `phase#${i + 1}`,
      );
      expect(cards.map((participant) => participant.id)).toEqual(
        Array.from({ length: 20 }, (_, k) => `phase#${i + 1}:actor#1@${i * 20 + k + 1}`),
      );
    });
    // Status likewise narrows per instance: each card folds only its own one node.
    expect(view.participantStatuses["phase#3:actor#1@41"]).toBe("done");
    expect(view.instances["phase#3:actor#1@41"]).toEqual({
      ordinal: 41,
      participant: "phase#3:actor#1",
    });
  });

  it("keeps the lane-wide binding when no instance carries a stamp — the legacy contract", () => {
    // Old CLI / old run / unstamped script: this is exactly the bug's picture (100 cards per station), unchanged.
    const view = liveParticipantView(FAN_OUT, fanOutRun(false));
    expect(view.graph.participants).toHaveLength(500);
  });

  it("keeps a reused actor on both cards: it has a node stamped in each phase", () => {
    const run = runWith(
      [{ name: "修复员", ordinal: 4, phaseName: "attempt", siteId: "actor#1", status: "running" }],
      [
        {
          actorOrdinal: 4,
          actorSiteId: "actor#1",
          ordinal: 1,
          outcome: "ok",
          phase: "settled",
          phaseName: "attempt",
          siteId: "ask#1",
        },
        {
          actorOrdinal: 4,
          actorSiteId: "actor#1",
          ordinal: 2,
          phase: "executing",
          phaseName: "gate",
          siteId: "ask#3",
        },
      ],
    );
    const view = liveParticipantView(LIVE_GRAPH, run);

    // This is where "one instance spans two phases" and "two batches of instances born in different phases" get poked: here both cards still list it.
    expect(view.graph).toBe(LIVE_GRAPH);
    expect(view.instances["phase#1:actor#1"]).toEqual({
      bound: true,
      name: "修复员",
      ordinal: 4,
      participant: "phase#1:actor#1",
    });
    expect(view.instances["phase#2:actor#1"]).toEqual({
      bound: true,
      name: "修复员",
      ordinal: 4,
      participant: "phase#2:actor#1",
    });
  });

  it("splits by phase rather than by lane: gate lists only the instance that worked there", () => {
    // Same shape as "splits a single card like `many`", but stamped: both instances were born in
    // attempt, and only @6 reached gate. Without stamps both cards split into @2 / @6 (the existing
    // test); with stamps gate keeps only @6.
    const run = runWith(
      [
        { name: "fixer-b", ordinal: 6, phaseName: "attempt", siteId: "actor#1", status: "waiting" },
        { name: "fixer-a", ordinal: 2, phaseName: "attempt", siteId: "actor#1", status: "running" },
      ],
      [
        {
          actorOrdinal: 2,
          actorSiteId: "actor#1",
          ordinal: 1,
          phase: "executing",
          phaseName: "attempt",
          siteId: "ask#1",
        },
        {
          actorOrdinal: 6,
          actorSiteId: "actor#1",
          ordinal: 2,
          outcome: "ok",
          phase: "settled",
          phaseName: "attempt",
          siteId: "ask#1",
        },
        {
          actorOrdinal: 6,
          actorSiteId: "actor#1",
          ordinal: 3,
          outcome: "failed",
          phase: "settled",
          phaseName: "gate",
          siteId: "ask#3",
        },
      ],
    );
    const view = liveParticipantView(LIVE_GRAPH, run);

    expect(view.graph.participants.map((participant) => participant.id)).toEqual([
      "phase#1:actor#1@2",
      "phase#1:actor#1@6",
      "phase#1:workspace",
      "phase#2:actor#1",
      "phase#2:actor#2[0]",
      "phase#2:actor#2[1]",
      "phase#2:actor#3",
    ]);
    expect(view.instances["phase#2:actor#1"]).toEqual({
      bound: true,
      name: "fixer-b",
      ordinal: 6,
      participant: "phase#2:actor#1",
    });
    expect(view.participantStatuses["phase#1:actor#1@2"]).toBe("running");
    expect(view.participantStatuses["phase#1:actor#1@6"]).toBe("done");
  });

  it("lands an instance born before the first marker on the unnamed card only", () => {
    // Steps emitted before the first marker are placed by the analyzer in the unnamed `unphased`; an unstamped instance is the other side of the same fact.
    const graph: WorkflowCausalityGraphData = {
      handoffs: [],
      lanes: [{ id: "actor#1", name: "fixer" }],
      participants: [
        { id: "unphased:actor#1", lane: "actor#1", phase: "unphased", steps: ["ask#0"] },
        { id: "phase#1:actor#1", lane: "actor#1", phase: "phase#1", steps: ["ask#1"] },
      ],
      phases: [{ id: "unphased" }, { id: "phase#1", name: "attempt" }],
      steps: [
        step({ id: "ask#0", lane: "actor#1", phase: "unphased" }),
        step({ id: "ask#1", lane: "actor#1", phase: "phase#1" }),
      ],
    };
    const run = runWith(
      [
        { ordinal: 1, siteId: "actor#1", status: "waiting" },
        { ordinal: 2, phaseName: "attempt", siteId: "actor#1", status: "running" },
      ],
      [
        {
          actorOrdinal: 1,
          actorSiteId: "actor#1",
          ordinal: 1,
          outcome: "ok",
          phase: "settled",
          siteId: "ask#0",
        },
        {
          actorOrdinal: 2,
          actorSiteId: "actor#1",
          ordinal: 2,
          phase: "executing",
          phaseName: "attempt",
          siteId: "ask#1",
        },
      ],
    );
    const view = liveParticipantView(graph, run);

    expect(view.graph).toBe(graph);
    expect(view.instances["unphased:actor#1"]?.ordinal).toBe(1);
    expect(view.instances["phase#1:actor#1"]?.ordinal).toBe(2);
  });

  it("shows an instance whose stamp matches no card everywhere on its lane, never nowhere", () => {
    const run = runWith(
      [{ ordinal: 4, phaseName: "留白", siteId: "actor#1", status: "running" }],
      [
        {
          actorOrdinal: 4,
          actorSiteId: "actor#1",
          ordinal: 1,
          phase: "executing",
          phaseName: "留白",
          siteId: "ask#1",
        },
        {
          actorOrdinal: 4,
          actorSiteId: "actor#1",
          ordinal: 2,
          outcome: "ok",
          phase: "settled",
          phaseName: "留白",
          siteId: "ask#3",
        },
      ],
    );
    const view = liveParticipantView(LIVE_GRAPH, run);

    expect(view.instances["phase#1:actor#1"]?.ordinal).toBe(4);
    expect(view.instances["phase#2:actor#1"]?.ordinal).toBe(4);
  });

  it("still binds on a graph with no phase table at all — nothing to divide by", () => {
    // The original graph of an unstamped script (before the UI synthesizes implicit phases): the ownership set has nowhere to land, so binding must still go by lane.
    const graph: WorkflowCausalityGraphData = {
      handoffs: [],
      lanes: [{ id: "actor#1", name: "fixer" }],
      participants: [
        { id: "unphased:actor#1", lane: "actor#1", phase: "unphased", steps: ["ask#1"] },
      ],
      steps: [step({ id: "ask#1", lane: "actor#1", phase: "unphased" })],
    };
    const view = liveParticipantView(
      graph,
      runWith([{ ordinal: 1, phaseName: "attempt", siteId: "actor#1", status: "running" }], []),
    );
    expect(view.instances["unphased:actor#1"]?.ordinal).toBe(1);
  });

  it("binds through the prefix rule when the display phase name was truncated at 128", () => {
    const long = "x".repeat(128);
    const graph: WorkflowCausalityGraphData = {
      ...LIVE_GRAPH,
      phases: [
        { id: "phase#1", name: long },
        { id: "phase#2", name: "gate" },
      ],
    };
    const run = runWith(
      [{ ordinal: 4, phaseName: `${long}yyy`, siteId: "actor#1", status: "running" }],
      [
        {
          actorOrdinal: 4,
          actorSiteId: "actor#1",
          ordinal: 1,
          phase: "executing",
          phaseName: `${long}yyy`,
          siteId: "ask#1",
        },
      ],
    );
    const view = liveParticipantView(graph, run);

    expect(view.instances["phase#1:actor#1"]?.ordinal).toBe(4);
    // On gate it has no nodes and its stamp does not match: this card binds no instance.
    expect("phase#2:actor#1" in view.instances).toBe(false);
  });
});

/**
 * Which display phases a stamp (an instance's birth phase) lands on (addendum 2026-09-09
 * "a node's owning phase set").
 * Card binding and station observation share this one rule.
 */
describe("phasesOf", () => {
  const graph: WorkflowCausalityGraphData = {
    handoffs: [],
    lanes: [],
    participants: [],
    phases: [
      { id: "unphased" },
      { id: "phase#1", name: "attempt" },
      { id: "phase#2", name: "gate" },
    ],
    steps: [],
  };

  it("sends a stamped instance to the display phases whose name it matches", () => {
    expect([...phasesOf("gate", graph, true)]).toEqual(["phase#2"]);
  });

  it("sends an unstamped instance to the unnamed phase once the run has vocabulary", () => {
    expect([...phasesOf(undefined, graph, true)]).toEqual(["unphased"]);
  });

  it("sends an unstamped instance everywhere while the run has no vocabulary — today's behaviour", () => {
    expect([...phasesOf(undefined, graph, false)]).toEqual(["unphased", "phase#1", "phase#2"]);
  });

  it("falls back to every phase when a branch comes out empty: never hide a running subagent", () => {
    expect([
      ...phasesOf(expectedCopy("chat.permission.workflow.holes.label"), graph, true),
    ]).toEqual(["unphased", "phase#1", "phase#2"]);
    // Vocabulary exists but the graph has no unnamed phase (every step sits after the first marker): an unstamped instance would rather show everywhere.
    const named: WorkflowCausalityGraphData = { ...graph, phases: graph.phases!.slice(1) };
    expect([...phasesOf(undefined, named, true)]).toEqual(["phase#1", "phase#2"]);
    // A graph without a phase vocabulary (before the UI synthesizes implicit phases): empty set, nowhere to belong.
    expect([...phasesOf("gate", { ...graph, phases: undefined }, true)]).toEqual([]);
  });

  it("uses the same prefix rule as the timeline when the display name was truncated", () => {
    const long = "x".repeat(128);
    const truncated: WorkflowCausalityGraphData = {
      ...graph,
      phases: [{ id: "phase#1", name: long }],
    };
    expect([...phasesOf(`${long}yyy`, truncated, true)]).toEqual(["phase#1"]);
  });
});

describe("runHasPhaseVocabulary", () => {
  const run = (overrides: Partial<WorkflowRunState>): WorkflowRunState => ({
    actors: [],
    lastEventSequence: 0,
    nodes: [],
    runId: "dwfrun-1",
    status: "running",
    usage: { nodesUsed: 0, spentTokens: 0 },
    ...overrides,
  });

  it("is true as soon as any actor or node carries a stamp", () => {
    expect(runHasPhaseVocabulary(undefined)).toBe(false);
    expect(runHasPhaseVocabulary(run({}))).toBe(false);
    expect(
      runHasPhaseVocabulary(
        run({ actors: [{ ordinal: 1, siteId: "actor#1", status: "waiting" }] }),
      ),
    ).toBe(false);
    expect(
      runHasPhaseVocabulary(
        run({
          actors: [{ ordinal: 1, phaseName: "attempt", siteId: "actor#1", status: "waiting" }],
        }),
      ),
    ).toBe(true);
    expect(
      runHasPhaseVocabulary(
        run({
          nodes: [{ ordinal: 1, phase: "queued", phaseName: "attempt", siteId: "ask#1" }],
        }),
      ),
    ).toBe(true);
  });
});

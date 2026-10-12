import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  CreateWorkflowCausalityGraph,
  CreateWorkflowEdge,
  CreateWorkflowOutput,
} from "@zcode/contracts";
import type { ControlFlowGraph, HandoffGraph } from "@zcode/dynamic-workflow";
import { createWorkflowToolEntry } from "../src/tool/handlers/create-workflow.js";
import { boundCausalityGraph } from "../src/tool/handlers/create-workflow-graph-bounds.js";
import {
  normalizeWorkflowMaxConcurrency,
  resolveCreateWorkflowInput,
} from "../src/tool/handlers/create-workflow-source.js";
import { saveSavedWorkflow } from "../src/tool/handlers/saved-workflows/index.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { analyzeScript } from "../src/tool/handlers/workflow-script-analysis.js";
import type { ModelCatalogEntry, ModelCatalogPort } from "@zcode/contracts";
import type { ToolExecutionContext, ToolHandlerFailure } from "../src/tool/types.js";
import { createToolRegistry } from "../src/tool/registry.js";

// Handler ignores context (pure typecheck, no I/O), so a bare stub is enough.
const stubContext = {} as ToolExecutionContext;

async function run(input: unknown): Promise<CreateWorkflowOutput> {
  return (await createWorkflowToolEntry.handler(input, stubContext)) as CreateWorkflowOutput;
}

/**
 * A script from the analyzer corpus (docs/dynamic-workflow/presentation.md and
 * docs/dynamic-workflow/presentation.md acceptance samples).
 */
function fixture(name: string): string {
  return readFileSync(
    new URL(`../../dynamic-workflow/tests/graphs/${name}`, import.meta.url),
    "utf8",
  );
}

/** Analyzer full graph → bounding layer; same signature as the handler's two call sites. */
function bound(script: string): CreateWorkflowCausalityGraph {
  const { causality, flow, handoff } = analyzeScript(script);
  expect(causality).toBeDefined();
  return boundCausalityGraph(causality!, flow, handoff);
}

type Edge = CreateWorkflowEdge;

/** Transitive closure of forward (non-back) edges, `from -> Set<to>`. */
function closure(edges: readonly Edge[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const next = new Map<string, string[]>();
  const nodes = new Set<string>();
  for (const edge of edges) {
    if (edge.back === true) continue;
    nodes.add(edge.from);
    nodes.add(edge.to);
    next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
  }
  for (const start of nodes) {
    const reached = new Set<string>();
    const stack = [...(next.get(start) ?? [])];
    while (stack.length > 0) {
      const node = stack.pop() as string;
      if (reached.has(node)) continue;
      reached.add(node);
      stack.push(...(next.get(node) ?? []));
    }
    out.set(start, reached);
  }
  return out;
}

function closureEquals(a: Map<string, Set<string>>, b: Map<string, Set<string>>): boolean {
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const key of keys) {
    const x = a.get(key) ?? new Set();
    const y = b.get(key) ?? new Set();
    if (x.size !== y.size || [...x].some((id) => !y.has(id))) return false;
  }
  return true;
}

/** The forward edge set is irreducible: removing any single edge changes the closure. */
function isIrredundant(edges: readonly Edge[]): boolean {
  const forward = edges.filter((edge) => edge.back !== true);
  const full = closure(forward);
  return forward.every(
    (edge) => !closureEquals(full, closure(forward.filter((other) => other !== edge))),
  );
}

/**
 * Referential integrity of the payload (spec "Contract"): every bridge between the three layers lands in the listed sets.
 * - a step's lane ∈ lanes; a step's phase ∈ phases (when the vocabulary is present, every step carries one).
 * - a participant's phase ∈ phases, or all `unphased` when the vocabulary is absent; lane ∈ lanes;
 *   steps ⊆ steps; each step belongs to at most one card.
 * - handoff ends ∈ participants with no self-loop; phaseEdges ends ∈ phases; likewise for exits / sink.
 * - a phase's alongside ∈ phases and excludes itself (a phase is not alongside itself).
 * - phaseStreams ends ∈ phases, no self-loops, and the two ends are alongside each other
 *   (docs/dynamic-workflow/presentation.md, "Streams").
 */
function expectReferentialIntegrity(graph: CreateWorkflowCausalityGraph): void {
  const laneIds = new Set(graph.lanes.map((lane) => lane.id));
  const stepIds = new Set(graph.steps.map((step) => step.id));
  const phaseIds = new Set((graph.phases ?? []).map((phase) => phase.id));
  const participantIds = new Set(graph.participants.map((participant) => participant.id));
  expect(participantIds.size).toBe(graph.participants.length);
  for (const step of graph.steps) {
    expect(laneIds.has(step.lane)).toBe(true);
    for (const lane of step.lanes ?? []) expect(laneIds.has(lane)).toBe(true);
    if (graph.phases === undefined) expect(Object.hasOwn(step, "phase")).toBe(false);
    else expect(phaseIds.has(step.phase!)).toBe(true);
  }
  const owner = new Map<string, string>();
  for (const participant of graph.participants) {
    if (graph.phases === undefined) expect(participant.phase).toBe("unphased");
    else expect(phaseIds.has(participant.phase)).toBe(true);
    expect(laneIds.has(participant.lane)).toBe(true);
    expect(participant.steps.length).toBeGreaterThan(0);
    for (const id of participant.steps) {
      expect(stepIds.has(id)).toBe(true);
      // Family member cards share the same site step: sharing between members is legal; cross-lane / cross-phase is not.
      const seen = owner.get(id);
      if (seen !== undefined) {
        const other = graph.participants.find((candidate) => candidate.id === seen)!;
        expect([other.phase, other.lane]).toEqual([participant.phase, participant.lane]);
        expect(participant.member).toBeDefined();
      } else owner.set(id, participant.id);
    }
  }
  for (const edge of graph.handoffs) {
    expect(participantIds.has(edge.from)).toBe(true);
    expect(participantIds.has(edge.to)).toBe(true);
    expect(edge.from).not.toBe(edge.to);
  }
  for (const edge of graph.phaseEdges ?? []) {
    expect(phaseIds.has(edge.from)).toBe(true);
    expect(phaseIds.has(edge.to)).toBe(true);
    expect(edge.from).not.toBe(edge.to);
  }
  for (const phase of graph.phases ?? []) {
    for (const id of phase.alongside ?? []) {
      expect(phaseIds.has(id)).toBe(true);
      expect(id).not.toBe(phase.id);
    }
  }
  const alongsideOf = new Map(
    (graph.phases ?? []).map((phase) => [phase.id, phase.alongside ?? []]),
  );
  for (const stream of graph.phaseStreams ?? []) {
    expect(phaseIds.has(stream.from)).toBe(true);
    expect(phaseIds.has(stream.to)).toBe(true);
    expect(stream.from).not.toBe(stream.to);
    expect(
      alongsideOf.get(stream.from)!.includes(stream.to) ||
        alongsideOf.get(stream.to)!.includes(stream.from),
    ).toBe(true);
  }
  if (graph.phases === undefined) expect(Object.hasOwn(graph, "phaseStreams")).toBe(false);
  for (const id of graph.exits ?? []) expect(phaseIds.has(id)).toBe(true);
  for (const id of graph.sink ?? []) expect(stepIds.has(id)).toBe(true);
  // The four phase fields stand and fall together.
  expect(Object.hasOwn(graph, "phaseEdges")).toBe(Object.hasOwn(graph, "phases"));
  expect(Object.hasOwn(graph, "exits")).toBe(Object.hasOwn(graph, "phases"));
  // Step-level edges and lane multiplicity have left the payload (handoff-stack).
  expect(Object.hasOwn(graph, "edges")).toBe(false);
  for (const lane of graph.lanes) expect(Object.hasOwn(lane, "nesting")).toBe(false);
}

describe("CreateWorkflow tool", () => {
  it("is registered by default via registerBuiltInTools", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry);
    expect(registry.has("CreateWorkflow")).toBe(true);
  });

  it("typechecks a valid script cleanly", async () => {
    const output = await run({
      script:
        'interface R { done: boolean }\nconst r = await agent("a").ask<R>("do");\nreturn r.done;',
    });
    expect(output.ok).toBe(true);
    expect(output.diagnostics).toEqual([]);
    expect(output.response).toContain("NOT executed");
  });

  it("emits the bounded display graph for a clean script", async () => {
    const output = await run({
      script:
        'interface R { done: boolean }\nconst r = await agent("a").ask<R>("do");\nreturn r.done;',
    });
    expect(output.ok).toBe(true);
    expect(output.causalityGraph).toBeDefined();
    const graph = output.causalityGraph!;
    // One step, standing in the actor's lane, at its author-script (prelude-stripped,
    // 1-based) location; the returned artifact is fed by that step.
    expect(graph.steps).toHaveLength(1);
    expect(graph.steps[0]).toMatchObject({ kind: "ask", label: "a", lane: "actor#1", line: 2 });
    expect(graph.lanes.map((lane) => lane.id)).toEqual(["actor#1"]);
    expect(graph.lanes[0]?.name).toBe("a");
    expect(graph.sink).toEqual(["ask#1"]);
    expect(graph.truncated).toBeUndefined();
    // Layer two: one subagent card holds this single step, with no handoff.
    expect(graph.participants).toEqual([
      { id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] },
    ]);
    expect(graph.handoffs).toEqual([]);
    // The analyzer's internal vocabulary (region / certainty / edge kinds) stays out of the payload
    // (single-arrow-contract); step-level edges and `nesting` are no longer forwarded (handoff-stack).
    expect(Object.hasOwn(graph, "regions")).toBe(false);
    expect(Object.hasOwn(graph, "edges")).toBe(false);
    for (const step of graph.steps) {
      expect(Object.hasOwn(step, "region")).toBe(false);
      expect(Object.hasOwn(step, "certainty")).toBe(false);
    }
    expectReferentialIntegrity(graph);
  });

  it("keeps every reference resolvable inside the bounded payload", async () => {
    const output = await run({
      script: [
        'const a = await agent("a").ask<string>("x");',
        'phase("work");',
        "for (let i = 0; i < 2; i++) {",
        '  const b = await agent("b").ask<string>(`y ${a}`);',
        "  if (b.length > 0) {",
        '    phase("save");',
        '    await agent("c").ask<string>(`z ${b}`);',
        "  }",
        "}",
        "return a;",
      ].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.phases).toHaveLength(3);
    expect(graph.participants.length).toBeGreaterThan(0);
    expectReferentialIntegrity(graph);
  });

  it("bounds the display graph at the output contract and flags truncation", async () => {
    // 70 asks exceed the 64-step bound; the head of the script survives, cards and
    // hand-offs pointing at dropped steps go with them, truncated is flagged.
    const asks = Array.from(
      { length: 70 },
      (_, index) => `const r${index} = await agent("a${index}").ask<string>("m");`,
    );
    const output = await run({
      script: [...asks, `return r0;`].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.truncated).toBe(true);
    expect(graph.steps.length).toBeLessThanOrEqual(64);
    expect(graph.lanes.length).toBeLessThanOrEqual(32);
    expect(graph.participants.length).toBeLessThanOrEqual(64);
    expect(graph.handoffs.length).toBeLessThanOrEqual(256);
    // Lanes cap at 32 while steps cap at 64, so steps whose lane was dropped must go
    // too — otherwise the renderer gets a card with no row to sit in. Each surviving
    // actor is one card in the single implicit phase.
    expect(graph.lanes).toHaveLength(32);
    expect(graph.steps).toHaveLength(32);
    expect(graph.participants).toHaveLength(32);
    expect(graph.handoffs).toHaveLength(31);
    expectReferentialIntegrity(graph);
  });

  it("carries one hand-off shape: from, to, a back bit for loop back-edges, and types for the inspector", async () => {
    // Type labels, kinds, and certainty stay out of the display channel: the analyzer still computes them (for the
    // text graph / mermaid / refined fork), edges only mean runs after; `back` is the only edge-level marker and only
    // marks loop back-edges; `types` is inspector material and never reaches the arrows.
    const output = await run({
      script: [
        'interface Flaky { findings: string[] }',
        'const f = await agent("a").ask<Flaky>("f");',
        "for (let i = 0; i < 2; i++) {",
        '  const u = await agent("b").ask<string>(`use ${f.findings[0]}`);',
        '  await agent("c").ask<string>(`check ${u}`);',
        "}",
        "return f;",
      ].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.handoffs).toEqual([
      { from: "unphased:actor#1", to: "unphased:actor#2", types: ["Flaky"] },
      { from: "unphased:actor#2", to: "unphased:actor#3", types: ["string"] },
      { from: "unphased:actor#3", to: "unphased:actor#2", back: true },
    ]);
    for (const edge of graph.handoffs) {
      for (const key of Object.keys(edge)) expect(["back", "from", "to", "types"]).toContain(key);
      expect(Object.hasOwn(edge, "kind")).toBe(false);
      expect(Object.hasOwn(edge, "certainty")).toBe(false);
    }
    for (const edge of graph.phaseEdges ?? []) {
      expect(Object.keys(edge).sort()).toEqual(
        edge.back === true ? ["back", "from", "to"] : ["from", "to"],
      );
    }
  });

  it("carries an interpolated actor name's static shape through the bounded payload", async () => {
    // The contract boundary is exactly where optional fields disappear: namePattern / labelPattern leaking past the
    // length-capped mapping is not caught by strict schema; it just quietly sinks the lane header back to "unnamed agent".
    const output = await run({
      script: [
        "const topics = [1, 2, 3];",
        "const drafts = await Promise.all(",
        "  topics.map((i) => agent(`研究员${i}`).ask<string>(`draft ${i}`)),",
        ");",
        'const editor = agent("主编");',
        "const final = await editor.ask<string>(`merge ${drafts.join()}`);",
        "return final;",
      ].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    const byId = new Map(graph.lanes.map((lane) => [lane.id, lane]));
    expect(byId.get("actor#1")?.namePattern).toEqual({ head: "研究员" });
    // The shape is **not written into name**: `name`'s contract is the word the author wrote verbatim.
    expect(Object.hasOwn(byId.get("actor#1")!, "name")).toBe(false);
    // A literal-named lane is unchanged byte for byte — the field is absent, not an undefined value.
    expect(byId.get("actor#2")?.name).toBe("主编");
    expect(Object.hasOwn(byId.get("actor#2")!, "namePattern")).toBe(false);
    // Multiplicity no longer hangs on the lane (it used to be families → nesting): the family's member count is
    // expressed by the participant card.
    expect(Object.hasOwn(byId.get("actor#1")!, "nesting")).toBe(false);
    expect(Object.hasOwn(byId.get("actor#1")!, "families")).toBe(false);
    expect(graph.participants.filter((p) => p.lane === "actor#1").map((p) => p.member)).toEqual([
      { index: 0, of: 3 },
      { index: 1, of: 3 },
      { index: 2, of: 3 },
    ]);
    // The inline receiver's card also gets the shape; an identifier receiver's card has no shape to speak of.
    const steps = new Map(graph.steps.map((step) => [step.id, step]));
    expect(steps.get("ask#1")).toMatchObject({ label: "ask", labelPattern: { head: "研究员" } });
    expect(Object.hasOwn(steps.get("ask#2")!, "labelPattern")).toBe(false);
  });

  it("carries the may-set copies' source through the bounded payload", async () => {
    // The may-set lane expansion's copy must survive all the way to the tool output: `source` is an optional field,
    // so dropping it from the length-capped mapping is not caught by strict schema — the live overlay would just
    // quietly fail to associate with any instance.
    const output = await run({
      script: [
        'const fast = agent("fast");',
        'const careful = agent("careful");',
        'const brief = await agent("triage").ask<string>("classify this request");',
        "const answer = await (brief.length > 8 ? careful : fast).ask<string>(`handle ${brief}`);",
        "return answer;",
      ].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.steps.map((step) => [step.id, step.lane, step.source])).toEqual([
      ["ask#1", "actor#3", undefined],
      ["ask#2~actor#1", "actor#1", "ask#2"],
      ["ask#2~actor#2", "actor#2", "ask#2"],
    ]);
    // The un-expanded step is unchanged byte for byte: the field is absent, not an undefined value.
    expect(Object.hasOwn(graph.steps[0]!, "source")).toBe(false);
    // The copy keeps all candidate lanes (hover clue); the id stays within the 64-character cap.
    expect(graph.steps[1]).toMatchObject({ lanes: ["actor#1", "actor#2"] });
    for (const step of graph.steps) expect(step.id.length).toBeLessThanOrEqual(64);
    // `source` points at the site the copy replaced, which is no longer in the graph — sink and cards reference only the copy.
    const stepIds = new Set(graph.steps.map((step) => step.id));
    expect(stepIds.has("ask#2")).toBe(false);
    expect(graph.sink).toEqual(["ask#2~actor#1", "ask#2~actor#2"]);
    // The two copies belong to two different cards (each on its own lane), with the opener triage first.
    expect(graph.participants.map((p) => [p.id, p.steps])).toEqual([
      ["unphased:actor#3", ["ask#1"]],
      ["unphased:actor#1", ["ask#2~actor#1"]],
      ["unphased:actor#2", ["ask#2~actor#2"]],
    ]);
    expect(graph.handoffs).toEqual([
      { from: "unphased:actor#3", to: "unphased:actor#1", types: ["string"] },
      { from: "unphased:actor#3", to: "unphased:actor#2", types: ["string"] },
    ]);
  });

  // —— Layer two: participant cards and handoffs (docs/dynamic-workflow/presentation.md, "The display contract") ——

  it("expands a literal fan-out into one member card each, all handing to the reviewer", async () => {
    const output = await run({ script: fixture("handoff-literal-members.ts") });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.participants).toEqual([
      { id: "phase#1:actor#1[0]", phase: "phase#1", lane: "actor#1", steps: ["ask#1"], member: { index: 0, of: 3 } },
      { id: "phase#1:actor#1[1]", phase: "phase#1", lane: "actor#1", steps: ["ask#1"], member: { index: 1, of: 3 } },
      { id: "phase#1:actor#1[2]", phase: "phase#1", lane: "actor#1", steps: ["ask#1"], member: { index: 2, of: 3 } },
      { id: "phase#1:actor#2", phase: "phase#1", lane: "actor#2", steps: ["ask#2"] },
    ]);
    expect(graph.handoffs).toEqual([
      { from: "phase#1:actor#1[0]", to: "phase#1:actor#2", types: ["Draft"] },
      { from: "phase#1:actor#1[1]", to: "phase#1:actor#2", types: ["Draft"] },
      { from: "phase#1:actor#1[2]", to: "phase#1:actor#2", types: ["Draft"] },
    ]);
    // A single card's `member` / `many` is absent, not an undefined value.
    expect(Object.hasOwn(graph.participants[3]!, "member")).toBe(false);
    expect(Object.hasOwn(graph.participants[3]!, "many")).toBe(false);
    expectReferentialIntegrity(graph);
  });

  it("collapses a family of unknown cardinality into one `many` card", async () => {
    // A pushed-onto array is not a literal length; iterating ask results is equally unknowable — both are one `many` card.
    const output = await run({ script: fixture("handoff-pushed-array-many.ts") });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.participants).toEqual([
      { id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"], many: true },
      { id: "unphased:actor#2", phase: "unphased", lane: "actor#2", steps: ["ask#2"] },
      { id: "unphased:actor#3", phase: "unphased", lane: "actor#3", steps: ["ask#3"], many: true },
    ]);
    expect(graph.handoffs).toEqual([
      { from: "unphased:actor#1", to: "unphased:actor#2", types: ["Draft"] },
      { from: "unphased:actor#2", to: "unphased:actor#3", types: ["string[]"] },
    ]);
    for (const participant of graph.participants) expect(Object.hasOwn(participant, "member")).toBe(false);
    expectReferentialIntegrity(graph);
  });

  it("puts every card in `unphased` when the script has no phase vocabulary", async () => {
    // No phase vocabulary: `phases` is absent and the card's phase is always `unphased` (the UI synthesizes a module
    // with the same id).
    // A handoff carrying no data (the editor's ask does not mention draft) is still a handoff; the same-lane self-loop disappears.
    const output = await run({ script: fixture("handoff-unphased-baton.ts") });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(Object.hasOwn(graph, "phases")).toBe(false);
    expect(graph.participants).toEqual([
      { id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1", "ask#2"] },
      { id: "unphased:actor#2", phase: "unphased", lane: "actor#2", steps: ["ask#3"] },
    ]);
    expect(graph.handoffs).toEqual([{ from: "unphased:actor#1", to: "unphased:actor#2" }]);
    expect(Object.hasOwn(graph.handoffs[0]!, "types")).toBe(false);
    expectReferentialIntegrity(graph);
  });

  it("matches the earth-v5 hand-off acceptance sample after bounding", () => {
    // The spec "Tests and acceptance" earth-v5 acceptance: five phases of participants and handoffs, byte for byte;
    // P2 has zero handoffs.
    const graph = bound(fixture("handoff-earth-v5.ts"));
    expect(graph.truncated).toBeUndefined();
    expect(graph.phases?.map((phase) => phase.id)).toEqual([
      "phase#1",
      "phase#2",
      "phase#3",
      "phase#4",
      "phase#5",
    ]);
    const byPhase = (phase: string): string[] =>
      graph.participants.filter((p) => p.phase === phase).map((p) => p.id);
    expect(byPhase("phase#1")).toEqual(["phase#1:actor#1"]);
    expect(byPhase("phase#2")).toEqual([
      "phase#2:actor#2",
      "phase#2:actor#3[0]",
      "phase#2:actor#3[1]",
      "phase#2:actor#3[2]",
      "phase#2:actor#3[3]",
      "phase#2:actor#3[4]",
    ]);
    expect(byPhase("phase#3")).toEqual(["phase#3:workspace", "phase#3:actor#4"]);
    expect(byPhase("phase#4")).toEqual([
      "phase#4:workspace",
      "phase#4:actor#4",
      "phase#4:actor#5",
      "phase#4:actor#6",
      "phase#4:actor#7",
      "phase#4:actor#8",
    ]);
    expect(byPhase("phase#5")).toEqual(["phase#5:workspace"]);
    // Participant array order = handoff order within phase order (fold-out top to bottom).
    expect(graph.participants.map((p) => p.id)).toEqual([
      ...byPhase("phase#1"),
      ...byPhase("phase#2"),
      ...byPhase("phase#3"),
      ...byPhase("phase#4"),
      ...byPhase("phase#5"),
    ]);
    const lanes = new Map(graph.lanes.map((lane) => [lane.id, lane.name]));
    expect(["actor#1", "actor#2", "actor#4", "actor#5", "actor#6", "actor#7", "actor#8"].map((id) => lanes.get(id))).toEqual([
      "architect",
      "harness",
      "fixer",
      "jury-a",
      "jury-b",
      "jury-c",
      "polisher",
    ]);
    const members = graph.participants.filter((p) => p.lane === "actor#3");
    expect(members.map((p) => p.member)).toEqual(
      Array.from({ length: 5 }, (_, index) => ({ index, of: 5 })),
    );
    expect(graph.handoffs).toEqual([
      { from: "phase#3:workspace", to: "phase#3:actor#4", types: ["WorldRunResult"] },
      { from: "phase#3:actor#4", to: "phase#3:workspace", back: true },
      { from: "phase#4:workspace", to: "phase#4:actor#4", types: ["WorldRunResult"] },
      { from: "phase#4:workspace", to: "phase#4:actor#5" },
      { from: "phase#4:workspace", to: "phase#4:actor#6" },
      { from: "phase#4:workspace", to: "phase#4:actor#7" },
      { from: "phase#4:actor#4", to: "phase#4:workspace" },
      { from: "phase#4:actor#4", to: "phase#4:actor#7", back: true },
      { from: "phase#4:actor#5", to: "phase#4:actor#8", types: ["JuryVerdict"] },
      { from: "phase#4:actor#6", to: "phase#4:actor#8", types: ["JuryVerdict"] },
      { from: "phase#4:actor#7", to: "phase#4:actor#8", types: ["JuryVerdict"] },
      { from: "phase#4:actor#8", to: "phase#4:workspace" },
    ]);
    expect(graph.handoffs.filter((edge) => edge.from.startsWith("phase#2:"))).toEqual([]);
    expectReferentialIntegrity(graph);
  });

  // —— Phase vocabulary bounding (docs/dynamic-workflow/presentation.md, "The display contract") ——
  // The phase layer comes from the control-flow graph's phase quotient (where one can go between phases); the step
  // layer is the site table.

  it("carries the phase vocabulary through the bounded payload", async () => {
    const output = await run({
      script: [
        'phase("preflight");',
        'const found = await files.glob("*.ts");',
        'const plan = await agent("planner").ask<string>(`plan ${found.length}`);',
        'phase("work");',
        "for (let i = 0; i < 3; i++) {",
        '  const r = await agent("worker").ask<string>(`do ${plan}`);',
        "  if (r.length > 0) {",
        '    phase("checkpoint");',
        '    await agent("saver").ask<string>(`save ${r}`);',
        "  }",
        "}",
        "return plan;",
      ].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.truncated).toBeUndefined();
    // Phases are numbered by the marker order of first appearance, with the author's original word and the marker's position.
    expect(graph.phases).toEqual([
      { id: "phase#1", name: "preflight", line: 1, column: 1 },
      { id: "phase#2", name: "work", line: 4, column: 1 },
      { id: "phase#3", name: "checkpoint", line: 8, column: 5 },
    ]);
    // The partition is complete: with the vocabulary present, every step has exactly one phase.
    expect(graph.steps.map((step) => step.phase)).toEqual([
      "phase#1",
      "phase#1",
      "phase#2",
      "phase#3",
    ]);
    // Phase edges are the control-flow graph's phase quotient, shaped like handoff edges: loop back-edges carry
    // `back`, everything else carries nothing.
    // Same-phase self-loops (loops inside work) are not emitted.
    expect(graph.phaseEdges).toEqual([
      { from: "phase#1", to: "phase#2" },
      { from: "phase#2", to: "phase#3" },
      { from: "phase#3", to: "phase#2", back: true },
    ]);
    // After the loop exits the script completes normally: both phases that could be the last round lead to the deliverable.
    expect(graph.exits).toEqual(["phase#2", "phase#3"]);
    // Layer two groups cards by phase: a cross-phase causal edge (plan → worker) is not a handoff; handoffs live only within a phase.
    expect(graph.participants.map((p) => p.id)).toEqual([
      "phase#1:workspace",
      "phase#1:actor#1",
      "phase#2:actor#2",
      "phase#3:actor#3",
    ]);
    expect(graph.handoffs).toEqual([
      { from: "phase#1:workspace", to: "phase#1:actor#1", types: ["string[]"] },
    ]);
    expectReferentialIntegrity(graph);
  });

  it("keeps a zero-marker graph free of every phase field", async () => {
    // The UI's view-switch condition is exactly "vocabulary present or not", so a zero-marker script must not carry a
    // single phase field — absent, not an undefined value, and not an empty array.
    const output = await run({
      script:
        'interface R { done: boolean }\nconst r = await agent("a").ask<R>("do");\nreturn r.done;',
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(Object.hasOwn(graph, "phases")).toBe(false);
    expect(Object.hasOwn(graph, "phaseEdges")).toBe(false);
    expect(Object.hasOwn(graph, "exits")).toBe(false);
    for (const step of graph.steps) expect(Object.hasOwn(step, "phase")).toBe(false);
    for (const participant of graph.participants) expect(participant.phase).toBe("unphased");
  });

  it("carries the unphased fallback for steps before the first marker", async () => {
    const output = await run({
      script: [
        'const a = await agent("x").ask<string>("q");',
        'phase("later");',
        'const b = await agent("y").ask<string>(`use ${a}`);',
        "return b;",
      ].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    // The fallback phase sorts first (it holds the steps before the first marker) and has **no name**: the display
    // name is localized by the UI, the same pattern as the workspace / unknown lanes.
    expect(graph.phases?.[0]).toEqual({ id: "unphased" });
    expect(Object.hasOwn(graph.phases![0]!, "name")).toBe(false);
    expect(graph.phases?.[1]).toMatchObject({ id: "phase#1", name: "later" });
    expect(graph.steps.map((step) => step.phase)).toEqual(["unphased", "phase#1"]);
    // With the vocabulary present, the fallback phase is a member of the table and cards land in it as usual.
    expect(graph.participants.map((p) => [p.id, p.phase])).toEqual([
      ["unphased:actor#1", "unphased"],
      ["phase#1:actor#2", "phase#1"],
    ]);
    expectReferentialIntegrity(graph);
  });

  it("lists a marker-only phase: control passes through it even with no step", async () => {
    // The causal quotient graph only sees members, not prepare; the control-flow quotient does see it — it is a
    // position between the two steps.
    // Layer two has no card for it: cards are "lanes that have steps within the phase".
    const output = await run({ script: fixture("phase-empty-phase.ts") });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.phases?.map((phase) => phase.name)).toEqual(["scan", "prepare", "act"]);
    expect(graph.steps.map((step) => step.phase)).toEqual(["phase#1", "phase#3"]);
    expect(graph.phaseEdges).toEqual([
      { from: "phase#1", to: "phase#2" },
      { from: "phase#2", to: "phase#3" },
    ]);
    expect(graph.exits).toEqual(["phase#3"]);
    expect(graph.participants.some((p) => p.phase === "phase#2")).toBe(false);
    expectReferentialIntegrity(graph);
  });

  it("keeps a phase whose only member was truncated: it is still a control-flow position", async () => {
    // 71 asks truncated at 64 → the only member of the later phase is truncated away. The phase layer does not
    // converge by membership (a phase is a control-flow position, not a set of members), so it and the edges leading
    // to it stay; the step layer as usual keeps only early's members, and late's card disappears with its step.
    const asks = Array.from(
      { length: 70 },
      (_, index) => `const r${index} = await a.ask<string>("m${index}");`,
    );
    const output = await run({
      script: [
        'const a = agent("a");',
        'phase("early");',
        ...asks,
        'phase("late");',
        'const last = await a.ask<string>("last");',
        "return last;",
      ].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.truncated).toBe(true);
    expect(graph.steps).toHaveLength(64);
    expect(graph.phases).toEqual([
      { id: "phase#1", name: "early", line: 2, column: 1 },
      { id: "phase#2", name: "late", line: 73, column: 1 },
    ]);
    expect(graph.phaseEdges).toEqual([{ from: "phase#1", to: "phase#2" }]);
    expect(graph.exits).toEqual(["phase#2"]);
    for (const step of graph.steps) expect(step.phase).toBe("phase#1");
    expect(graph.participants.map((p) => [p.id, p.steps.length])).toEqual([["phase#1:actor#1", 64]]);
    expectReferentialIntegrity(graph);
  });

  it("degrades the whole vocabulary past 32 phases", async () => {
    // Over the bound, degrade as a whole: a half-truncated phase graph lies (the truncated phases' members lose their
    // home), so rather say nothing — all four fields absent + truncated, and the UI naturally falls back to the
    // phase-less view.
    const marked = Array.from(
      { length: 33 },
      (_, index) => `phase("p${index}");\nconst r${index} = await a.ask<string>("m${index}");`,
    );
    const output = await run({
      script: ['const a = agent("a");', ...marked, "return r0;"].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.truncated).toBe(true);
    expect(Object.hasOwn(graph, "phases")).toBe(false);
    expect(Object.hasOwn(graph, "phaseEdges")).toBe(false);
    expect(Object.hasOwn(graph, "exits")).toBe(false);
    // The step's `phase` must disappear along with it: a card carrying a phase id that is not in phases is a dangling reference.
    expect(graph.steps).toHaveLength(33);
    for (const step of graph.steps) expect(Object.hasOwn(step, "phase")).toBe(false);
  });

  it("keeps participants inside the vocabulary when the vocabulary degrades", async () => {
    // Referential integrity from the spec "Contract": `participant.phase` ∈ `phases[].id`, or all `unphased` with
    // `phases` absent. After the vocabulary degrades as a whole, cards must not still claim `phase#N` — the UI would go
    // looking for a phase that does not exist.
    const marked = Array.from(
      { length: 33 },
      (_, index) => `phase("p${index}");\nconst r${index} = await a.ask<string>("m${index}");`,
    );
    const output = await run({
      script: ['const a = agent("a");', ...marked, "return r0;"].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(Object.hasOwn(graph, "phases")).toBe(false);
    expectReferentialIntegrity(graph);
  });

  it("never lets a step, a card, an edge or an exit name a phase the payload does not list", async () => {
    // Referential integrity outranks retained count — the same rule as lanes/edges — and holds for every phase outcome.
    const scripts = [
      // Vocabulary present, with a fallback phase and a cross-phase back-edge.
      [
        'const seed = await agent("seed").ask<string>("go");',
        'phase("loop");',
        "for (let i = 0; i < 2; i++) {",
        '  const r = await agent("worker").ask<string>(`step ${seed}`);',
        "  if (r.length > 0) {",
        '    phase("accept");',
        '    await agent("saver").ask<string>(`save ${r}`);',
        "  }",
        "}",
        "return seed;",
      ].join("\n"),
      // Zero markers: all four fields absent.
      'const a = await agent("a").ask<string>("q");\nreturn a;',
      // Intra-phase loop + fan-out family + workspace card.
      fixture("handoff-earth-v5.ts"),
    ];
    for (const script of scripts) {
      const output = await run({ script });
      expect(output.ok).toBe(true);
      expectReferentialIntegrity(output.causalityGraph!);
    }
  });

  it("emits an empty exits list when the script has no normal completion", async () => {
    // The group may be empty: an unconditionally-throwing script has no phase leading to the deliverable, `exits` is
    // present but empty, the `abort` terminal has no node so that edge does not appear, and `truncated` must not lie
    // because of it.
    const output = await run({
      script: 'phase("a");\nconst x = await agent("a").ask<string>("q");\nthrow new Error(x);',
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.phases).toHaveLength(1);
    expect(graph.phaseEdges).toEqual([]);
    expect(graph.exits).toEqual([]);
    expect(Object.hasOwn(graph, "truncated")).toBe(false);
  });

  it("ships an exception edge as an ordinary arrow and drops the abort terminal", async () => {
    // A may-throw step in the try body enters the catch phase: that is a real "may run next" successor, and without it
    // the recovery phase entered only via exceptions would dangle. A throw inside catch points at abort and has no node
    // to land on, so it is dropped.
    const output = await run({
      script: [
        'phase("attempt");',
        'const plan = await agent("planner").ask<string>("plan");',
        'let result = "";',
        "try {",
        '  result = await agent("worker").ask<string>(`do: ${plan}`);',
        "} catch {",
        '  phase("recover");',
        '  const salvage = await agent("salvage").ask<string>(`salvage: ${plan}`);',
        '  if (salvage === "") throw new Error("unrecoverable");',
        "  result = salvage;",
        "}",
        "return result;",
      ].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.phaseEdges).toEqual([{ from: "phase#1", to: "phase#2" }]);
    expect(graph.exits).toEqual(["phase#1", "phase#2"]);
    for (const edge of graph.phaseEdges ?? []) {
      for (const id of [edge.from, edge.to]) expect(["entry", "sink", "abort"]).not.toContain(id);
    }
  });

  // —— Transitive reduction of phase edges (spec Round 2: one arrow promises only the runs-after reachability) ——

  it("drops a phase skip edge the arm path already implies", async () => {
    // `if` without else: the head → successor skip edge vanishes, implied by head → arm → successor.
    const output = await run({
      script: [
        'phase("a");',
        'const s1 = await agent("a").ask<string>("1");',
        "if (s1.length > 0) {",
        '  phase("b");',
        '  await agent("b").ask<string>(`2 ${s1}`);',
        "}",
        'phase("c");',
        'return agent("c").ask<string>(`3 ${s1}`);',
      ].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.phaseEdges).toEqual([
      { from: "phase#1", to: "phase#2" },
      { from: "phase#2", to: "phase#3" },
    ]);
  });

  it("keeps both directions of interleaved phases (a; b; a): neither is a loop", async () => {
    const output = await run({
      script: [
        'phase("a");',
        'const s1 = await agent("a").ask<string>("1");',
        'phase("b");',
        'const s2 = await agent("b").ask<string>(`2 ${s1}`);',
        'phase("a");',
        'return agent("a2").ask<string>(`3 ${s2}`);',
      ].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.phaseEdges).toEqual([
      { from: "phase#1", to: "phase#2" },
      { from: "phase#2", to: "phase#1" },
    ]);
    expect(graph.exits).toEqual(["phase#1"]);
  });

  it("keeps one back edge for a loop body spanning three phases with a continue", async () => {
    // The `continue` in B back to A vanishes, witnessed by "B → C (forward) → A (one-hop back-edge)"; two mutually
    // witnessing back-edges do not vanish together, so C → A remains and the loop stays closed.
    const output = await run({
      script: [
        "for (let i = 0; i < 3; i++) {",
        '  phase("A");',
        '  const a = await agent("a").ask<string>("a");',
        '  phase("B");',
        '  const b = await agent("b").ask<string>(`b ${a}`);',
        "  if (b.length > 0) continue;",
        '  phase("C");',
        '  await agent("c").ask<string>(`c ${b}`);',
        "}",
        "return 1;",
      ].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.phaseEdges).toEqual([
      { from: "phase#1", to: "phase#2" },
      { from: "phase#2", to: "phase#3" },
      { from: "phase#3", to: "phase#1", back: true },
    ]);
    expect(graph.exits).toEqual(["phase#3"]);
  });

  it("keeps every edge of two independent choices that reuse the same two phase names", async () => {
    // Bug (same passage in the spec's "Untyped reduction"): two unrelated if/else groups reuse the same pair of phase
    // names, so in the quotient graph left ↔ right becomes an ordinary pair of branch edges. The old implementation
    // looked for witnesses on the **original graph**, so `choose → left` was judged redundant via `choose → right → left`
    // and deleted, and `left → next` deleted via `left → right → next` — the picture became "conditional branches always
    // take right; left is right's fork", a false statement. A path walking back around the loop asserts nothing about
    // "whether control can actually get there", so the reduction runs on strongly-connected components: not a single
    // edge within a component may be lost.
    const output = await run({
      script: [
        'phase("choose");',
        'const s = await agent("a").ask<string>("1");',
        "if (s.length > 0) {",
        '  phase("left");',
        '  await agent("l").ask<string>(`l ${s}`);',
        "} else {",
        '  phase("right");',
        '  await agent("r").ask<string>(`r ${s}`);',
        "}",
        "if (s.length > 1) {",
        '  phase("left");',
        '  await agent("l2").ask<string>(`l2 ${s}`);',
        "} else {",
        '  phase("right");',
        '  await agent("r2").ask<string>(`r2 ${s}`);',
        "}",
        'phase("next");',
        'return agent("n").ask<string>(`n ${s}`);',
      ].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.phases?.map((phase) => phase.name)).toEqual(["choose", "left", "right", "next"]);
    // left and right reach each other — one component: both cross edges are present, and both are **not** back-edges
    // (this is not a loop; two groups of choices each taking their own edges). The four edges in and out of the
    // component are likewise all present.
    expect(graph.phaseEdges).toEqual([
      { from: "phase#1", to: "phase#2" },
      { from: "phase#1", to: "phase#3" },
      { from: "phase#2", to: "phase#3" },
      { from: "phase#2", to: "phase#4" },
      { from: "phase#3", to: "phase#2" },
      { from: "phase#3", to: "phase#4" },
    ]);
    for (const edge of graph.phaseEdges ?? []) expect(Object.hasOwn(edge, "back")).toBe(false);
    expect(graph.exits).toEqual(["phase#4"]);
    expectReferentialIntegrity(graph);
  });

  it("still drops a spawner's pass-through edge over a fork/join: nothing there is on a cycle", async () => {
    // The other half of SCC reduction: edge deletion in acyclic regions must not be loosened at all. Two concurrent
    // callbacks each open a phase, and the main line enters the wrap-up after the join — `spawn → join` is implied by
    // the two strand paths and vanishes as before. The three phases each form their own component, so witnesses here
    // still count.
    const output = await run({
      script: [
        'phase("spawn");',
        'const seed = await agent("s").ask<string>("seed");',
        "const left = (async () => {",
        '  phase("left");',
        '  return agent("l").ask<string>(`l ${seed}`);',
        "})();",
        "const right = (async () => {",
        '  phase("right");',
        '  return agent("r").ask<string>(`r ${seed}`);',
        "})();",
        "const both = await Promise.all([left, right]);",
        'phase("join");',
        'return agent("j").ask<string>(`j ${both.join(",")}`);',
      ].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.phases?.map((phase) => phase.name)).toEqual(["spawn", "left", "right", "join"]);
    expect(graph.phaseEdges).toEqual([
      { from: "phase#1", to: "phase#2" },
      { from: "phase#1", to: "phase#3" },
      { from: "phase#2", to: "phase#4" },
      { from: "phase#3", to: "phase#4" },
    ]);
    expectReferentialIntegrity(graph);
  });

  it("leaves a loop's back edge out of the components: the skip edge it spans still drops", async () => {
    // Components consider forward edges only. A back-edge says "next round"; counting it into components would shrink
    // the whole loop body into one dot, and genuinely redundant edges inside the loop body could never be deleted
    // again — here `A → C` would survive along with `B → C`.
    const output = await run({
      script: [
        "for (let i = 0; i < 3; i++) {",
        '  phase("A");',
        '  const a = await agent("a").ask<string>("a");',
        "  if (a.length > 0) {",
        '    phase("B");',
        '    await agent("b").ask<string>(`b ${a}`);',
        "  }",
        "}",
        'phase("C");',
        'return agent("c").ask<string>("c");',
      ].join("\n"),
    });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.phaseEdges).toEqual([
      { from: "phase#1", to: "phase#2" },
      { from: "phase#2", to: "phase#1", back: true },
      { from: "phase#2", to: "phase#3" },
    ]);
    expect(graph.exits).toEqual(["phase#3"]);
    expectReferentialIntegrity(graph);
  });

  it("carries `alongside` for a phase entered while another phase's strands still ran", async () => {
    // Corpus strand-fanout-two-phases-join.ts, golden `phase phase#2 "B" alongside=phase#1`:
    // A's fan-out is not awaited, so B's marker arrives while A's subagent is still running. This is **node fact** —
    // attached only to B, and it must not conjure an edge between the two (control did not transfer from A to B or anywhere else).
    const output = await run({ script: fixture("strand-fanout-two-phases-join.ts") });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.phases?.map((phase) => phase.name)).toEqual(["A", "B", "C"]);
    expect(graph.phases?.[1]).toMatchObject({ id: "phase#2", name: "B", alongside: ["phase#1"] });
    expect(Object.hasOwn(graph.phases![0]!, "alongside")).toBe(false);
    expect(Object.hasOwn(graph.phases![2]!, "alongside")).toBe(false);
    expectReferentialIntegrity(graph);
  });

  it("streams the channel between two stage futures, but not the writer after the join", async () => {
    // Corpus stream-pipeline.ts (docs/dynamic-workflow/presentation.md, "Streams"): the causal graph's phase quotient
    // has phase#1 →data→ phase#2 (facts channel), phase#1 →data→ phase#3, phase#2 →seq→ phase#3.
    // Only the first one connects two mutually-alongside phases — the writer sits after the join, which is a matter of
    // control arrows.
    const output = await run({ script: fixture("stream-pipeline.ts") });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.phaseStreams).toEqual([{ from: "phase#1", to: "phase#2" }]);
    expectReferentialIntegrity(graph);
  });

  it("streams every hand-off of a five-stage pipeline, in order", () => {
    // The shape that triggered this design (abridged from testfield's "2077 future jobs pipeline"): five stage futures
    // chained by four channels; in the control-flow view the five phases are pairwise alongside with phaseEdges empty —
    // the streams are the only relationship between them.
    const graph = bound(`
      const FIELDS = ["pets", "sleep", "food"];
      const s1 = channel<string>("s1");
      const s2 = channel<string>("s2");
      const s3 = channel<string>("s3");
      const s4 = channel<string>("s4");
      const a = future(async () => {
        phase("Invent");
        try {
          await Promise.all(FIELDS.map(async (field) => s1.send(await agent(\`inventor-\${field}\`).ask<string>(field))));
        } finally { s1.close(); }
      });
      const b = future(async () => {
        phase("Post");
        try { for await (const job of s1) s2.send(await agent(\`poster-\${job}\`).ask<string>(job)); }
        finally { s2.close(); }
      });
      const c = future(async () => {
        phase("Tell");
        try { for await (const job of s2) s3.send(await agent(\`teller-\${job}\`).ask<string>(job)); }
        finally { s3.close(); }
      });
      const d = future(async () => {
        phase("Roast");
        try { for await (const job of s3) s4.send(await agent(\`roaster-\${job}\`).ask<string>(job)); }
        finally { s4.close(); }
      });
      const done: string[] = [];
      const e = future(async () => {
        phase("Bind");
        for await (const job of s4) done.push(await agent(\`binder-\${job}\`).ask<string>(job));
      });
      await Promise.all([a, b, c, d, e]);
      return done;
    `);
    expect(graph.phases?.map((phase) => phase.name)).toEqual([
      "Invent",
      "Post",
      "Tell",
      "Roast",
      "Bind",
    ]);
    expect(graph.phaseStreams).toEqual([
      { from: "phase#1", to: "phase#2" },
      { from: "phase#2", to: "phase#3" },
      { from: "phase#3", to: "phase#4" },
      { from: "phase#4", to: "phase#5" },
    ]);
    expectReferentialIntegrity(graph);
  });

  it("leaves two futures with no channel between them without streams", () => {
    // Two unrelated futures are still alongside (one band), but with no data edges there is no stream: the field is absent entirely.
    const graph = bound(`
      const web = future(async () => {
        phase("Read the web");
        return agent("web-reader").ask<string>("web");
      });
      const papers = future(async () => {
        phase("Read the papers");
        return agent("paper-reader").ask<string>("papers");
      });
      const [w, p] = await Promise.all([web, papers]);
      phase("Write");
      return agent("writer").ask<string>(\`\${w} \${p}\`);
    `);
    expect(graph.phases?.[1]?.alongside).toEqual(["phase#1"]);
    expect(Object.hasOwn(graph, "phaseStreams")).toBe(false);
    expectReferentialIntegrity(graph);
  });

  it("leaves the sequential control free of `alongside`", async () => {
    // Control group strand-fanout-awaited-per-phase.ts: the same three fan-outs, but each phase awaits its own work
    // first, so nothing sits across a marker. Absence must be **field absence** — the UI draws a straight line from it.
    const output = await run({ script: fixture("strand-fanout-awaited-per-phase.ts") });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    expect(graph.phases?.map((phase) => phase.name)).toEqual(["A", "B", "C"]);
    for (const phase of graph.phases!) expect(Object.hasOwn(phase, "alongside")).toBe(false);
    expectReferentialIntegrity(graph);
  });

  it("matches the control-flow phase quotient of phase-jsonl-db up to reduction", async () => {
    // End-to-end acceptance (spec "Tests and acceptance"): the forward closure of the payload's phase edges = the
    // closure of `.phase-flow.mmd` minus terminals, self-loops, and pure loop edges; the payload edge set is
    // irreducible; back edges are a subset of the mmd loop edges, and every loop closed by a loop edge stays closed
    // (both ends mutually reachable).
    const output = await run({ script: fixture("phase-jsonl-db.ts") });
    expect(output.ok).toBe(true);
    const graph = output.causalityGraph!;
    const mmd = fixture("expected/phase-jsonl-db.phase-flow.mmd");
    const terminals = new Set(["entry", "sink", "abort"]);
    const forward: Edge[] = [];
    const loops: Edge[] = [];
    const exits = new Set<string>();
    for (const line of mmd.split("\n")) {
      const match = /^\s*(\S+) -->(?:\|"([^"]*)"\|)? (\S+)$/.exec(line);
      if (match === null) continue;
      const [, rawFrom, labels, rawTo] = match;
      const from = (rawFrom as string).replace("phase_", "phase#");
      const to = (rawTo as string).replace("phase_", "phase#");
      if (to === "sink") {
        exits.add(from);
        continue;
      }
      if (terminals.has(from) || terminals.has(to) || from === to) continue;
      const kinds = (labels ?? "next").split(", ").map((label) => label.replace(/ \(.*\)$/, ""));
      if (kinds.every((kind) => kind === "loop")) loops.push({ back: true, from, to });
      else forward.push({ from, to });
    }
    expect(closureEquals(closure(graph.phaseEdges ?? []), closure(forward))).toBe(true);
    expect(isIrredundant(graph.phaseEdges ?? [])).toBe(true);
    const backs = (graph.phaseEdges ?? []).filter((edge) => edge.back === true);
    expect(backs.length).toBeGreaterThan(0);
    for (const edge of backs) {
      expect(loops.some((loop) => loop.from === edge.from && loop.to === edge.to)).toBe(true);
    }
    // Every loop closed by an mmd back-edge is still a loop in the payload (forward ∪ back): both ends mutually reachable.
    const all = (graph.phaseEdges ?? []).map((edge) => ({ from: edge.from, to: edge.to }));
    const reach = closure(all);
    for (const loop of loops) {
      expect(reach.get(loop.from)?.has(loop.to)).toBe(true);
      expect(reach.get(loop.to)?.has(loop.from)).toBe(true);
    }
    expect(graph.exits).toEqual([...exits]);
    // All six phases present, and the membership partition is complete.
    expect(graph.phases?.map((phase) => phase.name)).toEqual([
      "preflight",
      "attempt",
      "gate",
      "checkpoint",
      "recover",
      "wrap-up",
    ]);
    expectReferentialIntegrity(graph);
  });

  it("withholds the display graph when the script has type errors", async () => {
    const output = await run({ script: 'const x: number = "s";' });
    expect(output.ok).toBe(false);
    expect(output.causalityGraph).toBeUndefined();
  });

  it("surfaces facade-misuse diagnostics with ok=false and no graph", async () => {
    const output = await run({ script: "const spawn = agent;\nreturn 1;" });
    expect(output.ok).toBe(false);
    expect(output.causalityGraph).toBeUndefined();
    expect(
      output.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("may only be called directly"),
      ),
    ).toBe(true);
    expect(output.response).toContain("NOT executed");
  });

  it("reports diagnostics for a type error with script-relative line", async () => {
    const output = await run({ script: 'const x: number = "s";' });
    expect(output.ok).toBe(false);
    expect(output.diagnostics.some((diagnostic) => diagnostic.line === 1)).toBe(true);
    expect(output.response).toContain("L1:");
    expect(output.response).toContain("NOT executed");
  });

  /**
   * Placeholder copy made real: the diagnostic path's NOTE used to say "the execution model is still under development"
   * and "only typechecks the script (placeholder for testing)" — after the engine was wired up both sentences were lies
   * (a clean script really does start a background run). The only truths on this path are "not executed" + "fix and
   * resubmit", so the model runs its own fix-and-retry loop instead of believing the whole tool is still a toy.
   */
  it("诊断路径的 NOTE 只说没执行与改完重交，不再自述占位", async () => {
    const output = await run({ script: 'const x: number = "s";' });
    expect(output.ok).toBe(false);
    expect(output.response).toContain("NOT executed");
    expect(output.response).toContain("fix the errors above and resubmit");
    expect(output.response).not.toContain("under development");
    expect(output.response).not.toContain("placeholder");
    expect(output.response).not.toContain("only typechecks");
  });

  it("rejects Node globals to enforce script purity", async () => {
    const output = await run({ script: "process.exit(1);" });
    expect(output.ok).toBe(false);
    expect(output.diagnostics.some((diagnostic) => diagnostic.message.includes("Cannot find name"))).toBe(
      true,
    );
  });

  it("rejects input missing the script field", async () => {
    await expect(run({ name: "no-script" })).rejects.toThrow();
  });

  it("keeps the facade out of its description and points at the skill instead", () => {
    // 2026-09-21: the facade and authoring rules moved into the dynamic-workflows skill
    // (docs/dynamic-workflow/authoring.md, "The authoring surface"), leaving the description only a few hundred tokens.
    // Two things are pinned here: the d.ts is no longer re-sent with every request, and the description names the skill
    // and the Skill tool. The routing signals remain in workflow-routing-hints.test.ts.
    const description = createWorkflowToolEntry.metadata.description ?? "";
    expect(description).not.toContain("declare ");
    expect(description).not.toContain("ask<T");
    expect(description).toContain("`dynamic-workflows` skill");
    expect(description).toContain("Skill tool");
    // The description used to claim the tool "does NOT run anything" — stale since
    // the engine got wired, and it pushed the model to Agent for explicit workflow
    // requests.
    expect(description).not.toContain("does NOT run anything");
  });
});

// Normalization of the concurrency upper bound (docs/dynamic-workflow/concurrency.md, "Two bounds on a run") lives in
// resolveInput rather than the handler: the confirmation dialog must show the number that will take effect, and the
// dialog comes before the handler.
// The default concurrency is a starting point, not a cap, so here it is only floored to at least 1; values above the
// default pass through as-is.
describe("CreateWorkflow resolveInput — max_concurrency", () => {
  /** The inline path never touches the disk, so cwd does not matter; saved cases create their own real directory. */
  const UNREAD_CWD = "/workspace/never-read";

  async function resolved(input: unknown, cwd = UNREAD_CWD): Promise<Record<string, unknown>> {
    const resolution = await resolveCreateWorkflowInput(input, cwd);
    expect(resolution).toMatchObject({ result: true });
    return (resolution as { input: unknown }).input as Record<string, unknown>;
  }

  it("leaves a request above the default byte-identical: there is no upper limit", async () => {
    const input = { script: "return 1;", max_concurrency: 200 };
    expect(await resolved(input)).toBe(input);
  });

  it("leaves a small request byte-identical: the inline path stays the identity", async () => {
    const input = { script: "return 1;", max_concurrency: 3 };
    expect(await resolved(input)).toBe(input);
  });

  it("never invents the key for a call that did not set one", async () => {
    expect(Object.hasOwn(await resolved({ script: "return 1;" }), "max_concurrency")).toBe(false);
  });

  it("carries the limit through the saved source, which rebuilds the input", async () => {
    // The saved branch assembles a fresh input from scratch, so "a field quietly dropped" is a failure shape unique to this path.
    const cwd = mkdtempSync(join(tmpdir(), "dwf-maxconc-"));
    try {
      saveSavedWorkflow({ cwd, name: "nightly", meta: { description: "d" }, script: "return 1;" });
      const input = await resolved({ saved: { name: "nightly" }, max_concurrency: 32 }, cwd);
      expect(input.max_concurrency).toBe(32);
      expect(input.script).toBe("return 1;");
      // A saved call with no upper bound likewise does not conjure an empty shell key.
      expect(
        Object.hasOwn(await resolved({ saved: { name: "nightly" } }, cwd), "max_concurrency"),
      ).toBe(false);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("floors to a whole number of at least one, and nothing more", () => {
    // The helper is the shared entry for both tools: values outside the schema (0, negatives, fractions) must not get
    // through; large numbers pass as-is.
    expect(normalizeWorkflowMaxConcurrency(0)).toBe(1);
    expect(normalizeWorkflowMaxConcurrency(-3)).toBe(1);
    expect(normalizeWorkflowMaxConcurrency(3.7)).toBe(3);
    expect(normalizeWorkflowMaxConcurrency(500)).toBe(500);
  });
});

// The subagent model (docs/dynamic-workflow/launch.md, "From call to run") lives in resolveInput alongside the
// concurrency upper bound, for the same reason: the confirmation dialog must show the model that will take effect, and
// a call whose model cannot be resolved should never open a dialog at all.
describe("CreateWorkflow resolveInput — subagent_model", () => {
  const UNREAD_CWD = "/workspace/never-read";

  function catalogOf(...entries: ModelCatalogEntry[]): ModelCatalogPort {
    return { listModels: () => entries };
  }

  function entry(
    providerId: string,
    modelId: string,
    extra: Partial<ModelCatalogEntry> = {},
  ): ModelCatalogEntry {
    return { providerId, modelId, reasoningLevels: [], current: false, ...extra };
  }

  const CATALOG = catalogOf(
    entry("bigmodel", "GLM-4.6", {
      reasoningLevels: ["low", "high"],
      defaultReasoningLevel: "high",
      current: true,
    }),
    entry("openai", "gpt-5"),
  );

  async function resolved(
    input: unknown,
    catalog?: ModelCatalogPort,
    cwd = UNREAD_CWD,
  ): Promise<Record<string, unknown>> {
    const resolution = await resolveCreateWorkflowInput(input, cwd, catalog);
    expect(resolution).toMatchObject({ result: true });
    return (resolution as { input: unknown }).input as Record<string, unknown>;
  }

  async function failed(input: unknown, catalog?: ModelCatalogPort): Promise<ToolHandlerFailure> {
    const resolution = await resolveCreateWorkflowInput(input, UNREAD_CWD, catalog);
    expect(resolution.result).toBe(false);
    return resolution as ToolHandlerFailure;
  }

  it("rewrites the model the user named into the canonical picker form", async () => {
    // The user wrote a bare name with different casing; both the dialog and the handler must see the registry's one.
    expect(
      (await resolved({ script: "return 1;", subagent_model: "glm-4.6" }, CATALOG)).subagent_model,
    ).toBe("bigmodel/GLM-4.6$high");
  });

  it("leaves an already-canonical inline call byte-identical", async () => {
    const input = { script: "return 1;", subagent_model: "openai/gpt-5" };
    expect(await resolved(input, CATALOG)).toBe(input);
  });

  it("normalises a padded id rather than letting the window show the whitespace", async () => {
    // The schema carries `.trim()`, so "equals the canonical form after parsing" does not mean the raw input was canonical.
    const input = { script: "return 1;", subagent_model: "  openai/gpt-5  " };
    const resolvedInput = await resolved(input, CATALOG);
    expect(resolvedInput).not.toBe(input);
    expect(resolvedInput.subagent_model).toBe("openai/gpt-5");
  });

  it("never invents the key for a call that did not choose a model", async () => {
    const input = { script: "return 1;" };
    expect(await resolved(input, CATALOG)).toBe(input);
    expect(Object.hasOwn(await resolved(input, CATALOG), "subagent_model")).toBe(false);
  });

  it("fails before the confirmation window and lists the ids the model could have used", async () => {
    const failure = await failed({ script: "return 1;", subagent_model: "gemini-3" }, CATALOG);
    expect(failure.message).toContain("No configured model matches `gemini-3`");
    expect(failure.message).toContain("bigmodel/GLM-4.6 [current]");
    expect(failure.message).toContain("openai/gpt-5");
    expect(failure.message).toContain("call ListModels");
  });

  it("refuses the field outright on a host with no model catalog", async () => {
    // Letting it through silently would let a string the host cannot resolve travel all the way to the subagent's
    // first utterance before blowing up.
    const failure = await failed({ script: "return 1;", subagent_model: "gpt-5" }, undefined);
    expect(failure.message).toBe("This host cannot choose a subagent model; omit subagent_model.");
    // Calls that omit the field pass as usual on the same host.
    expect(
      Object.hasOwn(await resolved({ script: "return 1;" }, undefined), "subagent_model"),
    ).toBe(false);
  });

  it("carries the canonical model through the saved source, which rebuilds the input", async () => {
    // The saved branch assembles a fresh input from scratch, so "a field quietly dropped" is a failure shape unique to this path.
    const cwd = mkdtempSync(join(tmpdir(), "dwf-subagent-model-"));
    try {
      saveSavedWorkflow({ cwd, name: "nightly", meta: { description: "d" }, script: "return 1;" });
      const input = await resolved(
        { saved: { name: "nightly" }, subagent_model: "GPT-5" },
        CATALOG,
        cwd,
      );
      expect(input.subagent_model).toBe("openai/gpt-5");
      expect(input.script).toBe("return 1;");
      expect(
        Object.hasOwn(
          await resolved({ saved: { name: "nightly" } }, CATALOG, cwd),
          "subagent_model",
        ),
      ).toBe(false);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("fails a saved call without touching the disk: nothing runs and no window opens", async () => {
    // Resolution happens before reading the disk, so a call that cannot even resolve a model name never scans the disk first.
    const failure = await failed(
      { saved: { name: "nightly" }, subagent_model: "gemini-3" },
      CATALOG,
    );
    expect(failure.message).toContain("No configured model matches");
    expect(failure.message).not.toContain("saved workflow");
  });

  it("clamps the limit and canonicalises the model in the same rewrite", async () => {
    const input = await resolved(
      { script: "return 1;", max_concurrency: 3, subagent_model: "glm-4.6" },
      CATALOG,
    );
    expect(input.max_concurrency).toBe(3);
    expect(input.subagent_model).toBe("bigmodel/GLM-4.6$high");
  });
});

// The bounding layer is **self-defensive**, not trusting the producer: these graphs are fed straight into
// boundCausalityGraph because the analyzer cannot produce them by construction. "Claimed phases are all declared" is an
// upstream corpus property, not this layer's input contract — phase ids are free-form strings, and .strict() cannot
// catch dangling references; they can only be blocked here.
describe("boundCausalityGraph — 对损坏输入的引用完整性", () => {
  const step = (id: string, phase: string) => ({
    id,
    kind: "ask" as const,
    label: id,
    loc: { line: 1, column: 1 },
    lane: "actor#1",
    region: "seq#1",
    certainty: "always" as const,
    phase,
  });
  const base = {
    lanes: [{ id: "actor#1", name: "a" }],
    regions: [{ id: "seq#1", kind: "seq" as const }],
    edges: [],
  };
  const flowWith = (phaseEdges: ControlFlowGraph["phaseEdges"]): ControlFlowGraph => ({
    edges: [],
    nodes: [],
    phaseEdges,
    phases: [{ id: "phase#1", name: "declared" }],
  });

  it("strips a phase the vocabulary does not list, keeping the listed ones", () => {
    const bounded = boundCausalityGraph(
      { ...base, steps: [step("ask#1", "phase#1"), step("ask#2", "phase#99")] },
      flowWith([]),
    );
    // Declared phases are listed as usual and keep their members; the step claiming an undeclared phase only loses its
    // `phase` field, and the card itself stays on the graph (its lanes are all fine).
    expect(bounded.phases).toEqual([{ id: "phase#1", name: "declared" }]);
    expect(bounded.steps.map((s) => s.id)).toEqual(["ask#1", "ask#2"]);
    expect(bounded.steps[0]?.phase).toBe("phase#1");
    expect(Object.hasOwn(bounded.steps[1]!, "phase")).toBe(false);
  });

  it("keeps only listed ids in `alongside`, never itself and never twice", () => {
    const bounded = boundCausalityGraph(
      { ...base, steps: [step("ask#1", "phase#1"), step("ask#2", "phase#2")] },
      {
        edges: [],
        nodes: [],
        phaseEdges: [],
        phases: [
          { id: "phase#1", name: "A" },
          { id: "phase#2", name: "B", alongside: ["phase#2", "phase#99", "phase#1", "phase#1"] },
        ],
      },
    );
    // The same referential-integrity rule as edges: self-references, unlisted phases, and duplicates are dropped; if
    // nothing remains the field is absent entirely.
    expect(bounded.phases).toEqual([
      { id: "phase#1", name: "A" },
      { id: "phase#2", name: "B", alongside: ["phase#1"] },
    ]);
    expect(Object.hasOwn(bounded.phases![0]!, "alongside")).toBe(false);
    // And it is not an edge: not a single phaseEdge should grow because of it.
    expect(bounded.phaseEdges).toEqual([]);
  });

  it("streams only data edges between listed phases that run alongside each other", () => {
    const bounded = boundCausalityGraph(
      {
        ...base,
        steps: [step("ask#1", "phase#1"), step("ask#2", "phase#2"), step("ask#3", "phase#3")],
        phases: [
          { id: "phase#1", name: "A" },
          { id: "phase#2", name: "B" },
          { id: "phase#3", name: "C" },
        ],
        phaseEdges: [
          { certainty: "maybe", from: "phase#1", kind: "data", to: "phase#2" },
          // Duplicates, self-loops, non-data, unlisted phases, a non-alongside pair: none of these is a stream.
          { certainty: "always", from: "phase#1", kind: "data", to: "phase#2" },
          { certainty: "maybe", from: "phase#2", kind: "data", to: "phase#2" },
          { certainty: "maybe", from: "phase#1", kind: "seq", to: "phase#2" },
          { certainty: "maybe", from: "phase#2", kind: "data", to: "phase#99" },
          { certainty: "maybe", from: "phase#2", kind: "data", to: "phase#3" },
        ],
      },
      {
        edges: [],
        nodes: [],
        phaseEdges: [],
        phases: [
          { id: "phase#1", name: "A" },
          { id: "phase#2", name: "B", alongside: ["phase#1"] },
          { id: "phase#3", name: "C" },
        ],
      },
    );
    expect(bounded.phaseStreams).toEqual([{ from: "phase#1", to: "phase#2" }]);
    // Streams are not edges: phaseEdges come only from the control-flow view.
    expect(bounded.phaseEdges).toEqual([]);
  });

  it("drops the whole vocabulary when the streams exceed their bound", () => {
    const ids = Array.from({ length: 17 }, (_, i) => `phase#${i + 1}`);
    const bounded = boundCausalityGraph(
      {
        ...base,
        steps: [step("ask#1", "phase#1")],
        phases: ids.map((id) => ({ id, name: id })),
        // 17 × 16 = 272 mutually-alongside ordered pairs, all data edges: over 128.
        phaseEdges: ids.flatMap((from) =>
          ids
            .filter((to) => to !== from)
            .map((to) => ({ certainty: "maybe" as const, from, kind: "data" as const, to })),
        ),
      },
      {
        edges: [],
        nodes: [],
        phaseEdges: [],
        phases: ids.map((id) => ({ id, name: id, alongside: ids.filter((other) => other !== id) })),
      },
    );
    expect(Object.hasOwn(bounded, "phases")).toBe(false);
    expect(Object.hasOwn(bounded, "phaseStreams")).toBe(false);
    expect(bounded.truncated).toBe(true);
  });

  it("drops edges that touch an unlisted phase or a terminal, and folds sink edges into exits", () => {
    const bounded = boundCausalityGraph(
      { ...base, steps: [step("ask#1", "phase#1")] },
      flowWith([
        { from: "entry", kind: "next", to: "phase#1" },
        { from: "phase#1", kind: "next", to: "phase#99" },
        { from: "phase#99", kind: "next", to: "phase#1" },
        { from: "phase#1", kind: "loop", to: "phase#1" },
        { from: "phase#1", kind: "throw", to: "abort" },
        { from: "phase#1", kind: "jump", to: "sink", via: "return" },
      ]),
    );
    // Endpoint filtering uses **listed** phases; entry / abort have no nodes; self-loops are not emitted; sink edges
    // become exits.
    expect(bounded.phaseEdges).toEqual([]);
    expect(bounded.exits).toEqual(["phase#1"]);
  });

  it("emits no vocabulary at all without a control-flow projection", () => {
    // The phase layer's only source is the control-flow graph; the causal graph's own phases no longer enter the
    // payload. All or nothing.
    const bounded = boundCausalityGraph({
      ...base,
      steps: [step("ask#1", "phase#1")],
      phases: [{ id: "phase#1", name: "declared" }],
      phaseEdges: [],
    });
    expect(Object.hasOwn(bounded, "phases")).toBe(false);
    expect(Object.hasOwn(bounded, "phaseEdges")).toBe(false);
    expect(Object.hasOwn(bounded, "exits")).toBe(false);
    for (const s of bounded.steps) expect(Object.hasOwn(s, "phase")).toBe(false);
    expect(Object.hasOwn(bounded, "truncated")).toBe(false);
  });

  it("folds same-pair phase edges into one and marks back only when every fact was a back edge", () => {
    const bounded = boundCausalityGraph(
      { ...base, steps: [step("ask#1", "phase#1"), step("ask#2", "phase#2")] },
      {
        edges: [],
        nodes: [],
        phases: [
          { id: "phase#1", name: "a" },
          { id: "phase#2", name: "b" },
        ],
        phaseEdges: [
          { from: "phase#1", kind: "loop", to: "phase#2" },
          { from: "phase#1", kind: "next", to: "phase#2" },
          { from: "phase#2", kind: "loop", to: "phase#1" },
        ],
      },
    );
    // phase#1 → phase#2 has both forward fact and back-edge fact: treated as forward (ranking prefers one more
    // constraint); phase#2 → phase#1 has only the back-edge fact: back.
    expect(bounded.phaseEdges).toEqual([
      { from: "phase#1", to: "phase#2" },
      { from: "phase#2", to: "phase#1", back: true },
    ]);
  });

  it("emits no cards and no hand-offs without a hand-off projection", () => {
    // Layer two's only source is the analyzer's handoff graph; when absent, the two required arrays are empty rather
    // than undefined.
    const bounded = boundCausalityGraph({ ...base, steps: [step("ask#1", "phase#1")] });
    expect(bounded.participants).toEqual([]);
    expect(bounded.handoffs).toEqual([]);
    expect(Object.hasOwn(bounded, "truncated")).toBe(false);
  });

  it("truncates participants in order to 64, dropping hand-offs that touch a cut card and types past 8", () => {
    // 70 member cards share a single site step (the analyzer's FANOUT_EXPAND_CAP cannot produce this many, so it is
    // hand-built). The opener survives and the tail is truncated; handoffs touching truncated cards disappear with
    // them; `types` is capped at 8 per edge.
    const handoff: HandoffGraph = {
      participants: Array.from({ length: 70 }, (_, index) => ({
        id: `unphased:actor#1[${index}]`,
        phase: "unphased",
        lane: "actor#1",
        steps: ["ask#1"],
        member: { index, of: 70 },
      })),
      handoffs: [
        { from: "unphased:actor#1[0]", to: "unphased:actor#1[69]", types: ["Dropped"] },
        {
          from: "unphased:actor#1[0]",
          to: "unphased:actor#1[1]",
          types: Array.from({ length: 10 }, (_, index) => `T${index}`),
        },
        { from: "unphased:actor#1[65]", to: "unphased:actor#1[2]", back: true },
      ],
    };
    const bounded = boundCausalityGraph(
      { ...base, steps: [step("ask#1", "phase#1")] },
      undefined,
      handoff,
    );
    expect(bounded.truncated).toBe(true);
    expect(bounded.participants).toHaveLength(64);
    expect(bounded.participants.map((p) => p.id)).toEqual(
      Array.from({ length: 64 }, (_, index) => `unphased:actor#1[${index}]`),
    );
    expect(bounded.participants[63]).toEqual({
      id: "unphased:actor#1[63]",
      phase: "unphased",
      lane: "actor#1",
      steps: ["ask#1"],
      member: { index: 63, of: 70 },
    });
    expect(bounded.handoffs).toEqual([
      {
        from: "unphased:actor#1[0]",
        to: "unphased:actor#1[1]",
        types: ["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7"],
      },
    ]);
  });

  it("drops a card whose lane or every step was cut, and its hand-offs with it", () => {
    // Cards converge onto surviving steps; a card with no steps left disappears; cards whose lane is gone disappear;
    // truncated cards' steps stay in `steps` (run state still associates normally). Any discard sets truncated.
    const handoff: HandoffGraph = {
      participants: [
        { id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1", "ask#ghost"] },
        { id: "unphased:actor#9", phase: "unphased", lane: "actor#9", steps: ["ask#1"] },
        { id: "unphased:workspace", phase: "unphased", lane: "workspace", steps: ["ask#ghost"] },
      ],
      handoffs: [
        { from: "unphased:actor#1", to: "unphased:actor#9" },
        { from: "unphased:workspace", to: "unphased:actor#1", types: ["X"] },
      ],
    };
    const bounded = boundCausalityGraph(
      { ...base, lanes: [...base.lanes, { id: "workspace" }], steps: [step("ask#1", "phase#1")] },
      undefined,
      handoff,
    );
    expect(bounded.participants).toEqual([
      { id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] },
    ]);
    expect(bounded.handoffs).toEqual([]);
    expect(bounded.truncated).toBe(true);
  });
});

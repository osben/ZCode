import { describe, expect, it } from "vitest";
import {
  CREATE_WORKFLOW_GRAPH_MAX_HANDOFF_TYPES,
  CREATE_WORKFLOW_GRAPH_MAX_HANDOFFS,
  CREATE_WORKFLOW_GRAPH_MAX_PARTICIPANTS,
  CREATE_WORKFLOW_GRAPH_MAX_PHASE_EDGES,
  CREATE_WORKFLOW_GRAPH_MAX_PHASES,
  CREATE_WORKFLOW_GRAPH_MAX_STEPS,
  CreateWorkflowCausalityGraphSchema,
  CreateWorkflowHandoffSchema,
  CreateWorkflowParticipantSchema,
  CreateWorkflowInputJsonSchema,
  CreateWorkflowInputSchema,
  CreateWorkflowOutputJsonSchema,
  CreateWorkflowOutputSchema,
  createWorkflowPhaseAlongside,
  createWorkflowPhaseNames,
  type CreateWorkflowOutput,
} from "../src/tools/create-workflow.js";
import type { BackgroundResultOriginMeta } from "../src/events/session.events.js";
import type {
  DynamicWorkflowRunPort,
  DynamicWorkflowRunSubmitRequest,
  DynamicWorkflowRunEvent,
} from "../src/interfaces/dynamic-workflow-run.port.js";
import type { WorkflowTaskSnapshot } from "../src/interfaces/workflow.port.js";
import { createTraceId } from "../src/interfaces/shared.js";

const DIAGNOSTICS_ONLY: CreateWorkflowOutput = {
  diagnostics: [{ code: 2322, column: 7, line: 1, message: "Type error" }],
  ok: false,
  response: "The script does not typecheck.",
};

describe("CreateWorkflowOutputSchema — backgrounded run", () => {
  it("keeps accepting the diagnostics-only result unchanged", () => {
    // The broken-script path is completely unchanged: the handler returns diagnostics directly, starts nothing, builds no run, hence both new fields absent.
    const parsed = CreateWorkflowOutputSchema.parse(DIAGNOSTICS_ONLY);
    expect(parsed).toEqual(DIAGNOSTICS_ONLY);
    expect("status" in parsed).toBe(false);
    expect("backgroundTaskId" in parsed).toBe(false);
  });

  it("accepts status + backgroundTaskId when a run was started", () => {
    const output = {
      diagnostics: [],
      ok: true,
      response: "Workflow started.",
      status: "backgrounded" as const,
      backgroundTaskId: "dwf_run_01H",
    };
    expect(CreateWorkflowOutputSchema.parse(output)).toEqual(output);
  });

  it("admits only the backgrounded literal as a status", () => {
    // status is the only signal of "this call started a background run", not a generic status
    // field: values like running/completed must be rejected, otherwise the executor side's
    // dispatch would have to guess.
    for (const status of ["running", "completed", "failed", ""]) {
      expect(CreateWorkflowOutputSchema.safeParse({ ...DIAGNOSTICS_ONLY, status }).success).toBe(
        false,
      );
    }
  });

  it("requires backgroundTaskId to be a non-empty string", () => {
    for (const backgroundTaskId of ["", 42, null]) {
      expect(
        CreateWorkflowOutputSchema.safeParse({ ...DIAGNOSTICS_ONLY, backgroundTaskId }).success,
      ).toBe(false);
    }
  });

  it("stays strict about unknown keys", () => {
    // The point of .strict() is that a shape change must be an explicit schema commit, not smuggled through raw.
    expect(
      CreateWorkflowOutputSchema.safeParse({ ...DIAGNOSTICS_ONLY, runId: "smuggled" }).success,
    ).toBe(false);
  });

  it("carries both new fields into the model-facing JSON schema", () => {
    const properties = (CreateWorkflowOutputJsonSchema as { properties?: Record<string, unknown> })
      .properties;
    expect(Object.keys(properties ?? {})).toEqual(
      expect.arrayContaining(["diagnostics", "ok", "response", "status", "backgroundTaskId"]),
    );
    // Both fields are optional: required keeps today's three.
    const required = (CreateWorkflowOutputJsonSchema as { required?: string[] }).required ?? [];
    expect(required).not.toContain("status");
    expect(required).not.toContain("backgroundTaskId");
  });
});

// docs/dynamic-workflow/launch.md "The `CreateWorkflow` tool": revision is AmendWorkflow's job;
// CreateWorkflow has no predecessor field — `.strict()` makes the old spelling `resume_from` a
// visible schema error rather than silently ignored and turned into a full-price rerun.
describe("CreateWorkflowInputSchema — no predecessor field", () => {
  const SCRIPT = 'return await agent("a").ask<string>("go");';

  it("rejects resume_from in every spelling", () => {
    for (const key of ["resume_from", "resumeFrom", "run_id"]) {
      expect(CreateWorkflowInputSchema.safeParse({ script: SCRIPT, [key]: "dwfrun-prev" }).success).toBe(
        false,
      );
    }
  });

  it("does not project a predecessor field into the model-facing JSON schema", () => {
    const properties = (CreateWorkflowInputJsonSchema as { properties?: Record<string, unknown> })
      .properties;
    expect(Object.keys(properties ?? {})).toEqual(
      expect.arrayContaining(["name", "script", "saved", "max_concurrency", "subagent_model"]),
    );
    expect(properties).not.toHaveProperty("resume_from");
  });

  // Subagent selection (docs/dynamic-workflow/launch.md): the model face takes a lenient
  // string, normalization is left to resolveInput. A blank string is an error — it would make
  // "set but unclear" look identical to "unset" in the confirmation window.
  it("takes subagent_model as an optional trimmed non-empty string", () => {
    expect(CreateWorkflowInputSchema.parse({ script: SCRIPT })).toEqual({ script: SCRIPT });
    expect(
      CreateWorkflowInputSchema.parse({ script: SCRIPT, subagent_model: "  glm-5.3-flash  " }),
    ).toEqual({ script: SCRIPT, subagent_model: "glm-5.3-flash" });
    expect(
      CreateWorkflowInputSchema.safeParse({ script: SCRIPT, subagent_model: "   " }).success,
    ).toBe(false);
    expect(
      CreateWorkflowInputSchema.safeParse({ script: SCRIPT, subagent_model: null }).success,
    ).toBe(false);
  });
});

// docs/dynamic-workflow/launch.md "Script files": the third source `path` with the top-level
// `args` that only follows it, plus two backfill facts. Both the XOR and "args only follows
// path" live in validateInput — after normalization, `script` and `path` / `saved` coexisting is
// a legal execution state, and the schema must accommodate it.
describe("CreateWorkflowInputSchema — the file sources", () => {
  const SCRIPT = 'return await agent("a").ask<string>("go");';

  it("lists `path` and `args` for the model and hides the resolved facts", () => {
    const properties = (CreateWorkflowInputJsonSchema as { properties?: Record<string, unknown> })
      .properties;
    expect(Object.keys(properties ?? {}).sort()).toEqual([
      "args",
      "max_concurrency",
      "name",
      "path",
      "saved",
      "script",
      "subagent_model",
    ]);
    // Backfilled items share `AmendWorkflow.predecessor`'s posture: the runtime accepts them, the model face does not list them.
    expect(properties).not.toHaveProperty("script_line_offset");
    const saved = (properties?.saved as { properties?: Record<string, unknown> } | undefined)
      ?.properties;
    expect(saved).not.toHaveProperty("draft");
  });

  it("accepts the normalized shape a `path` call resolves to", () => {
    const resolved = {
      script: SCRIPT,
      path: "/repo/.zcode/workflow-drafts/x.dwf.ts",
      args: { depth: 3 },
      script_line_offset: 5,
    };
    expect(CreateWorkflowInputSchema.parse(resolved)).toEqual(resolved);
    expect(CreateWorkflowInputSchema.safeParse({ path: "" }).success).toBe(false);
    expect(CreateWorkflowInputSchema.safeParse({ path: "a", script_line_offset: -1 }).success).toBe(
      false,
    );
  });

  it("accepts the normalized shape a `saved` call resolves to, draft included", () => {
    const resolved = {
      name: "nightly",
      script: SCRIPT,
      saved: {
        name: "nightly",
        args: { depth: 3 },
        path: "/repo/.zcode/workflows/nightly.dwf.ts",
        scope: "project" as const,
        draft: "/repo/.zcode/workflow-drafts/nightly.dwf.ts",
      },
      script_line_offset: 3,
    };
    expect(CreateWorkflowInputSchema.parse(resolved)).toEqual(resolved);
  });
});

describe("BackgroundResultOriginMeta", () => {
  it("admits workflow as a background source", () => {
    // Completion notifications reuse the whole background pipeline, so a workflow run's terminal state must be able to label its source.
    const meta: BackgroundResultOriginMeta = {
      backgroundSource: "workflow",
      workId: "dwf_run_01H",
      title: "Review the codebase",
    };
    expect(meta.backgroundSource).toBe("workflow");
  });
});

describe("DynamicWorkflowRunPort", () => {
  it("is implementable over JSON-able shapes alone", () => {
    // The port carries only JSON shapes: the engine's vocabulary (RunEvent / StoredEvent /
    // RunStatus) stays in the domain package; contracts never imports dynamic-workflow. This
    // fake is that rule's executable proof.
    const events: DynamicWorkflowRunEvent[] = [
      { sequence: 0, type: "run-started", payload: { runId: "run_1" } },
      { sequence: 1, type: "node-settled", payload: { instance: { siteId: "ask#1", ordinal: 1 } } },
    ];
    const snapshot: WorkflowTaskSnapshot = {
      runId: "run_1",
      startedAt: new Date(0),
      status: "running",
      taskId: "run_1",
    };
    let cancelled = false;

    const port: DynamicWorkflowRunPort = {
      submit: (request: DynamicWorkflowRunSubmitRequest) =>
        Promise.resolve({ ok: true, runId: `run_${request.scriptText.length}` }),
      getTask: () => Promise.resolve(snapshot),
      waitForTask: () =>
        Promise.resolve({ ...snapshot, status: "completed", output: { artifact: 1 } }),
      cancel: () => {
        cancelled = true;
        return Promise.resolve(true);
      },
      listEvents: (_runId, opts) =>
        Promise.resolve({
          events: events.filter(
            (e) => opts.afterSequence === undefined || e.sequence > opts.afterSequence,
          ),
          hasMore: false,
        }),
    };

    return Promise.all([
      port.submit({
        scriptText: "return 1;",
        cwd: "/tmp",
        parentSessionId: "sess_p",
        trace: { traceId: createTraceId() },
      }),
      port.listEvents("run_1", { afterSequence: 0, limit: 10 }),
      port.cancel("run_1"),
    ]).then(([submitted, page]) => {
      expect(submitted.ok === true && submitted.runId).toBe("run_9");
      expect(page.events.map((e) => e.sequence)).toEqual([1]);
      expect(cancelled).toBe(true);
    });
  });
});

describe("CreateWorkflowCausalityGraphSchema — withdrawn refined display names", () => {
  // docs/dynamic-workflow/presentation.md: the model-refined names are withdrawn wholesale;
  // `refinedLabel` / `refinedName` are deleted from the four schema layers. Old persisted
  // payloads carrying them are stripped by tool-result-metadata before strict parsing; the
  // schema itself knows nothing of them and .strict() rejects them outright.
  const graph = {
    steps: [
      {
        id: "ask#1",
        kind: "ask" as const,
        label: "ask",
        labelPattern: { head: "研究员" },
        lane: "actor#1",
      },
    ],
    lanes: [{ id: "actor#1", name: "planner" }],
    participants: [
      { id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] },
    ],
    handoffs: [],
  };

  it("keeps accepting plain graphs byte-for-byte", () => {
    expect(CreateWorkflowCausalityGraphSchema.parse(graph)).toEqual(graph);
  });

  it("rejects refinedLabel on steps and refinedName on lanes", () => {
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        ...graph,
        steps: [{ ...graph.steps[0], refinedLabel: "调研市场行情" }],
      }).success,
    ).toBe(false);
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        ...graph,
        lanes: [{ ...graph.lanes[0], refinedName: "规划者" }],
      }).success,
    ).toBe(false);
  });
});

describe("CreateWorkflowCausalityGraphSchema — phase vocabulary", () => {
  // docs/dynamic-workflow/presentation.md: phases / phaseEdges / exits / Step.phase are one
  // **all-or-nothing** vocabulary, entirely additive and optional — a zero-marker script's
  // payload passes .strict() as usual.
  const unphasedGraph = {
    steps: [
      {
        id: "world-read#1",
        kind: "world-read" as const,
        label: "glob *.ts",
        lane: "workspace",
        phase: "unphased",
      },
      {
        id: "ask#1",
        kind: "ask" as const,
        label: "planner",
        lane: "actor#1",
        phase: "phase#1",
      },
    ],
    lanes: [{ id: "workspace" }, { id: "actor#1", name: "planner" }],
    // Second layer: one participant card per phase, handoff edges between cards (docs/dynamic-workflow/presentation.md).
    participants: [
      { id: "unphased:workspace", phase: "unphased", lane: "workspace", steps: ["world-read#1"] },
      { id: "phase#1:actor#1", phase: "phase#1", lane: "actor#1", steps: ["ask#1"] },
    ],
    handoffs: [{ from: "unphased:workspace", to: "phase#1:actor#1" }],
    // `unphased` sorts first and has **no name** (UI localizes); authored phases carry the name and the first marker's position.
    phases: [{ id: "unphased" }, { id: "phase#1", name: "preflight", line: 3, column: 1 }],
    phaseEdges: [{ from: "unphased", to: "phase#1" }],
    // Phases after which control flow can complete normally (the "phase → returns" arrow of the phase view).
    exits: ["phase#1"],
  };

  it("round-trips the four fields together", () => {
    expect(CreateWorkflowCausalityGraphSchema.parse(unphasedGraph)).toEqual(unphasedGraph);
  });

  it("keeps accepting a payload with no phase field at all", () => {
    // Zero-marker script = a payload with the vocabulary entirely absent; passes byte for byte.
    const legacy = {
      steps: [{ ...unphasedGraph.steps[1]!, phase: undefined }],
      lanes: unphasedGraph.lanes,
      // Without phase vocabulary a participant's phase is always `unphased` (with `phases` absent).
      participants: [
        { id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] },
      ],
      handoffs: [],
    };
    delete (legacy.steps[0] as { phase?: string }).phase;
    const parsed = CreateWorkflowCausalityGraphSchema.parse(legacy);
    expect(parsed).toEqual(legacy);
    expect("phases" in parsed).toBe(false);
    expect("phaseEdges" in parsed).toBe(false);
    expect("exits" in parsed).toBe(false);
    expect("phase" in parsed.steps[0]!).toBe(false);
  });

  it("represents an empty-but-present vocabulary", () => {
    // A script with markers but zero steps produces three arrays that are present but empty.
    // The UI's view toggle is "present **and non-empty**", so an empty vocabulary must be
    // **representable** — the arrays carry only a .max() bound and must never gain .min(1),
    // otherwise the handler's honest pass-through path would bounce off the contract boundary.
    // `exits` may also be an empty array within the group (the script has no normal-completion
    // path, e.g. an unconditional throw).
    const empty = {
      steps: [],
      lanes: [],
      participants: [],
      handoffs: [],
      phases: [],
      phaseEdges: [],
      exits: [],
    };
    const parsed = CreateWorkflowCausalityGraphSchema.parse(empty);
    expect(parsed).toEqual(empty);
    expect(parsed.phases).toEqual([]);
    expect(parsed.phaseEdges).toEqual([]);
    expect(parsed.exits).toEqual([]);
  });

  it("round-trips exits and bounds them at 32 phase ids", () => {
    // exits shares the phase table's bound: it is a subset of phase ids, at most as long as the phase table.
    const exits = Array.from(
      { length: CREATE_WORKFLOW_GRAPH_MAX_PHASES },
      (_, i) => `phase#${i + 1}`,
    );
    const parsed = CreateWorkflowCausalityGraphSchema.parse({ ...unphasedGraph, exits });
    expect(parsed.exits).toEqual(exits);
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        ...unphasedGraph,
        exits: [...exits, "phase#33"],
      }).success,
    ).toBe(false);
    // Elements share the same set of id bounds.
    for (const bad of [[""], ["p".repeat(65)], [42]]) {
      expect(
        CreateWorkflowCausalityGraphSchema.safeParse({ ...unphasedGraph, exits: bad }).success,
      ).toBe(false);
    }
  });

  it("rejects the withdrawn refinedName on phases", () => {
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        ...unphasedGraph,
        phases: [
          unphasedGraph.phases[0]!,
          { ...unphasedGraph.phases[1]!, refinedName: "起飞前检查" },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects every field of the pre-single-arrow shape", () => {
    // docs/dynamic-workflow/presentation.md "The display contract": hard cut, no optional
    // transition. The analyzer's edge kind / certainty / exact witness bits, the step's region /
    // certainty, the lanes' families, and the top-level regions table are no longer part of the
    // payload — .strict() blocks each one, preventing production from quietly adding them back
    // (old payloads take the existing UI-side fallback of safeParse failing: the whole display
    // is treated as absent).
    // docs/dynamic-workflow/presentation.md cuts again: step-level `edges` and `Lane.nesting`
    // have no readers left; also hard cut.
    const [step0, step1] = unphasedGraph.steps;
    const [lane0, lane1] = unphasedGraph.lanes;
    const edge = { from: "world-read#1", to: "ask#1" };
    const handoff = unphasedGraph.handoffs[0]!;
    const phaseEdge = { from: "unphased", to: "phase#1" };
    const rejected: unknown[] = [
      // Step-level edges is gone as a whole field — an empty array is also an extra key.
      { ...unphasedGraph, edges: [] },
      { ...unphasedGraph, edges: [edge] },
      { ...unphasedGraph, edges: [{ ...edge, kind: "data" }] },
      // Legacy fields on handoff edges.
      { ...unphasedGraph, handoffs: [{ ...handoff, kind: "data" }] },
      { ...unphasedGraph, handoffs: [{ ...handoff, kind: "carry" }] },
      { ...unphasedGraph, handoffs: [{ ...handoff, certainty: "always" }] },
      { ...unphasedGraph, handoffs: [{ ...handoff, exact: true }] },
      { ...unphasedGraph, handoffs: [{ ...handoff, count: 2 }] },
      // Legacy fields on phase edges.
      { ...unphasedGraph, phaseEdges: [{ ...phaseEdge, kind: "seq" }] },
      { ...unphasedGraph, phaseEdges: [{ ...phaseEdge, certainty: "maybe" }] },
      { ...unphasedGraph, phaseEdges: [{ ...phaseEdge, exact: true }] },
      // Legacy fields on steps.
      { ...unphasedGraph, steps: [{ ...step0, region: "seq#1" }, step1] },
      { ...unphasedGraph, steps: [{ ...step0, certainty: "always" }, step1] },
      // Legacy fields on lanes: families (before the single arrow) and nesting (before the handoff stack).
      { ...unphasedGraph, lanes: [lane0, { ...lane1, families: ["loop#1"] }] },
      { ...unphasedGraph, lanes: [lane0, { ...lane1, nesting: 1 }] },
      { ...unphasedGraph, lanes: [lane0, { ...lane1, nesting: 0 }] },
      // Top-level regions table — an empty table is equally an extra key.
      { ...unphasedGraph, regions: [] },
      { ...unphasedGraph, regions: [{ id: "seq#1", kind: "seq" }] },
    ];
    for (const graph of rejected) {
      expect(CreateWorkflowCausalityGraphSchema.safeParse(graph).success).toBe(false);
    }
  });

  it("accepts only the literal true for `back` on either edge layer", () => {
    // `back` is a back-edge marker, not a boolean state: neither false nor "yes" is another
    // spelling of "no back edge marked".
    // Absence means a forward edge; both edge layers share one shape, so both must be pinned.
    const edge = { from: "phase#1:actor#1", to: "unphased:workspace" };
    const phaseEdge = { from: "phase#1", to: "unphased" };
    expect(
      CreateWorkflowCausalityGraphSchema.parse({
        ...unphasedGraph,
        handoffs: [{ ...edge, back: true }],
      }).handoffs,
    ).toEqual([{ ...edge, back: true }]);
    expect(
      CreateWorkflowCausalityGraphSchema.parse({
        ...unphasedGraph,
        phaseEdges: [{ ...phaseEdge, back: true }],
      }).phaseEdges,
    ).toEqual([{ ...phaseEdge, back: true }]);
    for (const back of [false, "yes", 1, null]) {
      expect(
        CreateWorkflowCausalityGraphSchema.safeParse({
          ...unphasedGraph,
          handoffs: [{ ...edge, back }],
        }).success,
      ).toBe(false);
      expect(
        CreateWorkflowCausalityGraphSchema.safeParse({
          ...unphasedGraph,
          phaseEdges: [{ ...phaseEdge, back }],
        }).success,
      ).toBe(false);
    }
  });

  it("bounds the vocabulary at 32 phases and 128 phase edges", () => {
    const phase = { id: "phase#1", name: "p" };
    const edge = { from: "phase#1", to: "phase#2", back: true as const };
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        ...unphasedGraph,
        phases: Array.from({ length: CREATE_WORKFLOW_GRAPH_MAX_PHASES }, (_, i) => ({
          ...phase,
          id: `phase#${i + 1}`,
        })),
      }).success,
    ).toBe(true);
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        ...unphasedGraph,
        phases: Array.from({ length: CREATE_WORKFLOW_GRAPH_MAX_PHASES + 1 }, (_, i) => ({
          ...phase,
          id: `phase#${i + 1}`,
        })),
      }).success,
    ).toBe(false);
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        ...unphasedGraph,
        phaseEdges: Array.from({ length: CREATE_WORKFLOW_GRAPH_MAX_PHASE_EDGES + 1 }, () => edge),
      }).success,
    ).toBe(false);
  });

  it("round-trips phase streams and keeps them to {from, to}, at most 128", () => {
    // docs/dynamic-workflow/presentation.md "Streams": two future phases chained by a channel
    // form one phase stream — not runs after, hence no `back` and none of the analyzer's edge
    // kinds.
    const streams = [
      { from: "phase#1", to: "phase#2" },
      { from: "phase#2", to: "phase#3" },
    ];
    const parsed = CreateWorkflowCausalityGraphSchema.parse({
      ...unphasedGraph,
      phaseStreams: streams,
    });
    expect(parsed.phaseStreams).toEqual(streams);
    for (const phaseStreams of [
      [{ from: "phase#1", to: "phase#2", back: true }],
      [{ from: "phase#1", to: "phase#2", kind: "data" }],
      [{ from: "", to: "phase#2" }],
      [{ from: "phase#1", to: "p".repeat(65) }],
      Array.from({ length: CREATE_WORKFLOW_GRAPH_MAX_PHASE_EDGES + 1 }, () => streams[0]),
    ]) {
      expect(
        CreateWorkflowCausalityGraphSchema.safeParse({ ...unphasedGraph, phaseStreams }).success,
      ).toBe(false);
    }
  });

  it("bounds phase ids and names like every other graph string", () => {
    for (const phases of [
      [{ id: "" }],
      [{ id: "p".repeat(65) }],
      [{ id: "phase#1", name: "" }],
      [{ id: "phase#1", name: "长".repeat(129) }],
      [{ id: "phase#1", line: 0 }],
      [{ id: "phase#1", label: "smuggled" }],
    ]) {
      expect(
        CreateWorkflowCausalityGraphSchema.safeParse({ ...unphasedGraph, phases }).success,
      ).toBe(false);
    }
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        ...unphasedGraph,
        steps: [{ ...unphasedGraph.steps[0]!, phase: "p".repeat(65) }],
      }).success,
    ).toBe(false);
  });
});

describe("CreateWorkflowCausalityGraphSchema — participants and handoffs", () => {
  // docs/dynamic-workflow/presentation.md "The display contract": the second layer is
  // subagent-oriented — one participant card per phase (`${phase}:${lane}`, family members add
  // `[index]`) plus handoff edges between cards. Both fields are **required**: a graph with zero
  // participants is an empty array, not absence — that is exactly how step-level `edges` quietly
  // exited; new fields get no passable path via absence.
  const step = (id: string, lane: string, phase: string) => ({
    id,
    kind: "ask" as const,
    label: lane,
    lane,
    phase,
  });
  const graph = {
    steps: [step("ask#1", "actor#1", "phase#1"), step("ask#2", "actor#2", "phase#1")],
    lanes: [
      { id: "actor#1", name: "planner" },
      { id: "actor#2", name: "worker" },
    ],
    participants: [
      { id: "phase#1:actor#1", phase: "phase#1", lane: "actor#1", steps: ["ask#1"] },
      { id: "phase#1:actor#2", phase: "phase#1", lane: "actor#2", steps: ["ask#2"] },
    ],
    handoffs: [{ from: "phase#1:actor#1", to: "phase#1:actor#2" }],
    phases: [{ id: "phase#1", name: "plan" }],
    phaseEdges: [],
    exits: ["phase#1"],
  };
  const [p0, p1] = graph.participants;
  const [h0] = graph.handoffs;

  it("exposes the bounds as constants the handler truncates against", () => {
    expect(CREATE_WORKFLOW_GRAPH_MAX_PARTICIPANTS).toBe(64);
    expect(CREATE_WORKFLOW_GRAPH_MAX_HANDOFFS).toBe(256);
    expect(CREATE_WORKFLOW_GRAPH_MAX_HANDOFF_TYPES).toBe(8);
  });

  it("round-trips participants and handoffs and requires both fields", () => {
    expect(CreateWorkflowCausalityGraphSchema.parse(graph)).toEqual(graph);
    const noParticipants: Record<string, unknown> = { ...graph };
    delete noParticipants.participants;
    const noHandoffs: Record<string, unknown> = { ...graph };
    delete noHandoffs.handoffs;
    expect(CreateWorkflowCausalityGraphSchema.safeParse(noParticipants).success).toBe(false);
    expect(CreateWorkflowCausalityGraphSchema.safeParse(noHandoffs).success).toBe(false);
    // Empty graph: both arrays present and empty.
    expect(
      CreateWorkflowCausalityGraphSchema.parse({
        steps: [],
        lanes: [],
        participants: [],
        handoffs: [],
      }),
    ).toEqual({ steps: [], lanes: [], participants: [], handoffs: [] });
  });

  it("requires at least one step per participant and bounds the list at 64", () => {
    // A card with no steps represents no subagent — there is no run state to aggregate and no ask for the inspector to list.
    expect(CreateWorkflowParticipantSchema.safeParse({ ...p0, steps: [] }).success).toBe(false);
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        ...graph,
        participants: [{ ...p0, steps: [] }, p1],
      }).success,
    ).toBe(false);
    const manySteps = Array.from({ length: CREATE_WORKFLOW_GRAPH_MAX_STEPS }, (_, i) => `ask#${i}`);
    expect(CreateWorkflowParticipantSchema.safeParse({ ...p0, steps: manySteps }).success).toBe(
      true,
    );
    expect(
      CreateWorkflowParticipantSchema.safeParse({ ...p0, steps: [...manySteps, "ask#64"] }).success,
    ).toBe(false);
    // Step ids share the same set of id bounds.
    for (const bad of [[""], ["s".repeat(65)], [42]]) {
      expect(CreateWorkflowParticipantSchema.safeParse({ ...p0, steps: bad }).success).toBe(false);
    }
  });

  it("requires id, phase and lane on every participant and rejects extra keys", () => {
    for (const key of ["id", "phase", "lane", "steps"]) {
      const partial: Record<string, unknown> = { ...p0 };
      delete partial[key];
      expect(CreateWorkflowParticipantSchema.safeParse(partial).success).toBe(false);
    }
    // A card's display name is looked up in the lane table, not carried on the participant; leftover keys of step-level edges are the same.
    for (const extra of [{ name: "planner" }, { edges: [] }, { nesting: 1 }, { region: "seq#1" }]) {
      expect(CreateWorkflowParticipantSchema.safeParse({ ...p0, ...extra }).success).toBe(false);
    }
    // Script without phase vocabulary: phase is always `unphased`, holding simultaneously with `phases` absent.
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        steps: [step("ask#1", "actor#1", "unphased")],
        lanes: [graph.lanes[0]],
        participants: [
          { id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] },
        ],
        handoffs: [],
      }).success,
    ).toBe(true);
  });

  it("shapes fan-out members as `member: {index ≥ 0, of ≥ 1}` and `many: true`", () => {
    // A family with a literal cardinality gets one card per member (id carries `[index]`); an unknown cardinality gets one `many` card for all.
    const member = { ...p1, id: "phase#1:actor#2[0]", member: { index: 0, of: 3 } };
    expect(CreateWorkflowParticipantSchema.parse(member)).toEqual(member);
    const many = { ...p1, many: true as const };
    expect(CreateWorkflowParticipantSchema.parse(many)).toEqual(many);
    for (const bad of [
      { index: -1, of: 3 },
      { index: 0.5, of: 3 },
      { index: 0, of: 0 },
      { index: 0, of: -1 },
      { index: 0 },
      { of: 3 },
      { index: "0", of: 3 },
      { index: 0, of: 3, label: "smuggled" },
    ]) {
      expect(CreateWorkflowParticipantSchema.safeParse({ ...p1, member: bad }).success).toBe(false);
    }
    // `many` is a marker, not a boolean state: false is not another spelling of "not many".
    for (const many of [false, "yes", 1, null]) {
      expect(CreateWorkflowParticipantSchema.safeParse({ ...p1, many }).success).toBe(false);
    }
  });

  it("bounds the participant list at 64 and the handoff list at 256", () => {
    const participants = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        ...p0,
        id: `phase#1:actor#1[${i}]`,
        member: { index: i, of: n },
      }));
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        ...graph,
        participants: participants(CREATE_WORKFLOW_GRAPH_MAX_PARTICIPANTS),
      }).success,
    ).toBe(true);
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        ...graph,
        participants: participants(CREATE_WORKFLOW_GRAPH_MAX_PARTICIPANTS + 1),
      }).success,
    ).toBe(false);
    const handoffs = (n: number) => Array.from({ length: n }, () => h0);
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        ...graph,
        handoffs: handoffs(CREATE_WORKFLOW_GRAPH_MAX_HANDOFFS),
      }).success,
    ).toBe(true);
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        ...graph,
        handoffs: handoffs(CREATE_WORKFLOW_GRAPH_MAX_HANDOFFS + 1),
      }).success,
    ).toBe(false);
  });

  it("carries 1..8 artifact type names on a handoff, each within the name bound", () => {
    // `types` goes to the inspector only, not onto the arrow; when present, at least one and at most 8, each under the name bound.
    const withTypes = { ...h0, types: ["Plan", "Report"] };
    expect(CreateWorkflowHandoffSchema.parse(withTypes)).toEqual(withTypes);
    expect(CreateWorkflowHandoffSchema.parse({ ...h0, back: true })).toEqual({ ...h0, back: true });
    const max = Array.from({ length: CREATE_WORKFLOW_GRAPH_MAX_HANDOFF_TYPES }, (_, i) => `T${i}`);
    expect(CreateWorkflowHandoffSchema.safeParse({ ...h0, types: max }).success).toBe(true);
    for (const bad of [[], [...max, "T8"], [""], ["长".repeat(129)], [42], "Plan"]) {
      expect(CreateWorkflowHandoffSchema.safeParse({ ...h0, types: bad }).success).toBe(false);
      expect(
        CreateWorkflowCausalityGraphSchema.safeParse({
          ...graph,
          handoffs: [{ ...h0, types: bad }],
        }).success,
      ).toBe(false);
    }
    // Phase edges have no types — they broker control flow and carry no artifacts.
    expect(
      CreateWorkflowCausalityGraphSchema.safeParse({
        ...graph,
        phaseEdges: [{ from: "phase#1", to: "phase#1", types: ["Plan"] }],
      }).success,
    ).toBe(false);
  });
});

describe("createWorkflowPhaseNames — the declared phase table for run-launched", () => {
  it("returns the named phases in declared order and skips the synthetic unnamed one", () => {
    expect(
      createWorkflowPhaseNames({
        steps: [],
        lanes: [],
        participants: [],
        handoffs: [],
        phases: [
          { id: "p1", name: "Research" },
          { id: "unphased" },
          { id: "p2", name: "Write" },
        ],
      }),
    ).toEqual(["Research", "Write"]);
  });

  it("returns undefined when the graph is absent or declares no phase vocabulary", () => {
    expect(createWorkflowPhaseNames(undefined)).toBeUndefined();
    expect(
      createWorkflowPhaseNames({ steps: [], lanes: [], participants: [], handoffs: [] }),
    ).toBeUndefined();
    expect(
      createWorkflowPhaseNames({
        steps: [],
        lanes: [],
        participants: [],
        handoffs: [],
        phases: [{ id: "unphased" }],
      }),
    ).toBeUndefined();
  });

  it("keeps at most CREATE_WORKFLOW_GRAPH_MAX_PHASES names", () => {
    const phases = Array.from({ length: CREATE_WORKFLOW_GRAPH_MAX_PHASES + 3 }, (_, index) => ({
      id: `p${index}`,
      name: `Phase ${index}`,
    }));
    expect(
      createWorkflowPhaseNames({ steps: [], lanes: [], participants: [], handoffs: [], phases }),
    ).toHaveLength(CREATE_WORKFLOW_GRAPH_MAX_PHASES);
  });
});

describe("createWorkflowPhaseAlongside — the phases a phase was entered beside", () => {
  const empty = { steps: [], lanes: [], participants: [], handoffs: [] };

  it("indexes into the named-phase table, dropping references to unnamed phases", () => {
    // The index space is that of **named** phases: the synthetic `unphased` heads the table
    // without taking a slot, so Research is 0 and Write is 1, while a reference pointing at
    // `unphased` has nowhere to land and is dropped.
    const graph = {
      ...empty,
      phases: [
        { id: "unphased", alongside: ["p1"] },
        { id: "p1", name: "Research", alongside: ["unphased", "p2"] },
        { id: "p2", name: "Write", alongside: ["p1"] },
      ],
    };
    expect(createWorkflowPhaseNames(graph)).toEqual(["Research", "Write"]);
    expect(createWorkflowPhaseAlongside(graph)).toEqual([[1], [0]]);
  });

  it("drops references to unlisted phases and to itself, and dedupes", () => {
    expect(
      createWorkflowPhaseAlongside({
        ...empty,
        phases: [
          { id: "p1", name: "Research", alongside: ["p1", "p9", "p2", "p2"] },
          { id: "p2", name: "Write" },
        ],
      }),
    ).toEqual([[1], []]);
  });

  it("returns undefined when no phase was entered beside another", () => {
    // Absence means "this track is a straight line", so even a series of empty arrays must
    // collapse to undefined — including the case where every reference was dropped.
    expect(createWorkflowPhaseAlongside(undefined)).toBeUndefined();
    expect(createWorkflowPhaseAlongside(empty)).toBeUndefined();
    expect(
      createWorkflowPhaseAlongside({ ...empty, phases: [{ id: "unphased", alongside: ["p1"] }] }),
    ).toBeUndefined();
    expect(
      createWorkflowPhaseAlongside({
        ...empty,
        phases: [
          { id: "p1", name: "Research" },
          { id: "p2", name: "Write" },
        ],
      }),
    ).toBeUndefined();
    expect(
      createWorkflowPhaseAlongside({
        ...empty,
        phases: [{ id: "p1", name: "Research", alongside: ["unphased"] }, { id: "unphased" }],
      }),
    ).toBeUndefined();
  });

  it("stops at CREATE_WORKFLOW_GRAPH_MAX_PHASES, with it the references past the cut", () => {
    const phases = Array.from({ length: CREATE_WORKFLOW_GRAPH_MAX_PHASES + 3 }, (_, index) => ({
      id: `p${index}`,
      name: `Phase ${index}`,
      alongside: [`p${index + 1}`],
    }));
    const alongside = createWorkflowPhaseAlongside({ ...empty, phases });
    expect(alongside).toHaveLength(CREATE_WORKFLOW_GRAPH_MAX_PHASES);
    expect(createWorkflowPhaseNames({ ...empty, phases })).toHaveLength(alongside!.length);
    expect(alongside![0]).toEqual([1]);
    // The last station points at the phase that was truncated: an out-of-bounds index would
    // wire the sidebar to a nonexistent station, so it goes too.
    expect(alongside![CREATE_WORKFLOW_GRAPH_MAX_PHASES - 1]).toEqual([]);
  });
});

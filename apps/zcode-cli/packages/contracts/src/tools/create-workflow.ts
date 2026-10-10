// ============================================================
// CreateWorkflow Tool - typecheck a dynamic-workflow script and start a background run
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import { SAVED_WORKFLOW_MAX_NAME_CHARS, SavedWorkflowScopeSchema } from "./saved-workflow.js";

export const CREATE_WORKFLOW_TOOL_NAME = "CreateWorkflow";

/**
 * Name of the bundled skill that teaches the model to write workflows
 * (apps/zcode-cli/packages/bundled-skills/skills/<name>/SKILL.md).
 * The resolveInput step of all four authoring tools (Create/Amend/Save/EvalWorkflowSnippet) uses it as
 * a gate: reject script submission if the session has not loaded this skill.
 * It lives in contracts because both core's gate and bootstrap's skill bundle read it, and neither can
 * import the other.
 */
export const DYNAMIC_WORKFLOW_SKILL_NAME = "dynamic-workflows";

/** Validation message for "provide exactly one execution-body source." Kept as a constant because the model is its only reader and all three paths need identical wording. */
export const CREATE_WORKFLOW_SOURCE_ERROR =
  "Provide exactly one workflow source: `script` for a one-off script written inline, `saved` to run a workflow saved in this project, or `path` for a script file on disk (the file a previous result named). Passing more than one, or none, is ambiguous.";

/** Validation message that `args` belongs only to the `path` source (`saved` has its own `saved.args`, while inline scripts have no declarations). */
export const CREATE_WORKFLOW_ARGS_WITHOUT_PATH_ERROR =
  "`args` belongs to the `path` source: it carries values for the arguments a script file declares in its `/* zcode-workflow` block. For a saved workflow pass `saved.args`; an inline `script` declares no arguments, so it takes none.";

/**
 * `saved` source. The model supplies `name` and optionally `args` and `scope` (to disambiguate);
 * `path` is a fact **populated** by `resolveInput` after resolution, and normalized `scope` becomes
 * the matched scope, so both are optional.
 *
 * A normalized input may therefore validly contain both `script` and `saved`—the reason XOR cannot
 * be expressed in Zod (see {@link CreateWorkflowInputSchema}).
 */
export const CreateWorkflowSavedSourceSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(SAVED_WORKFLOW_MAX_NAME_CHARS)
      .describe("Name of a saved workflow (see ListSavedWorkflows)."),
    args: z
      .record(z.unknown())
      .optional()
      .describe("Values for the arguments the saved workflow declares."),
    /** Populated during resolution: location of the saved file. Not supplied by the model. */
    path: z.string().min(1).optional(),
    /**
     * Disambiguates which scope to load the workflow from. Defaults to the existing lookup order
     * (a project-scope workflow shadows a same-named global one). After normalization, `scope` is the
     * **matched** scope; see create-workflow-source.ts.
     */
    scope: SavedWorkflowScopeSchema.optional().describe(
      "Which archive to take it from; omit for the normal lookup order.",
    ),
  })
  .strict();

export type CreateWorkflowSavedSource = z.infer<typeof CreateWorkflowSavedSourceSchema>;

/**
 * Runtime `saved` block: model-facing fields plus `draft`.
 *
 * `draft` is the **location** populated by `resolveInput` after writing a working copy: a run never
 * modifies the saved definition; the model edits this copy. It follows the same pattern as
 * `AmendWorkflow.predecessor`: the tool computes the fact, and it is not listed in the model's JSON
 * schema, so the model will not assume it should supply a path. Omitted entirely if writing fails
 * (draft creation is best-effort).
 */
export const CreateWorkflowResolvedSavedSourceSchema = CreateWorkflowSavedSourceSchema.extend({
  draft: z.string().min(1).optional(),
}).strict();

export type CreateWorkflowResolvedSavedSource = z.infer<
  typeof CreateWorkflowResolvedSavedSourceSchema
>;

/**
 * There are three possible execution-body sources, and exactly one must be supplied—but this XOR is
 * **intentionally not expressed in the schema**.
 *
 * The reason is normalization: after `resolveInput` loads the saved script (or `path` file), the input
 * contains both `script` (the bytes to run) and `saved` / `path` (its provenance). A superRefine would
 * reject this valid shape in two places—the handler's own `parse`, and call-runner's second validation
 * after hook rewriting—and would fail **only on non-inline paths**, a bug that could ship if untested.
 * So `entry.validateInput` enforces XOR on the **model input**, the only point where it is true. JSON
 * schema cannot express refinements anyway; field descriptions guide the model.
 */
const CreateWorkflowModelInputSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Short run label in the user's language. Always pass it for an inline script; defaults to the saved workflow's name.",
      ),
    script: z
      .string()
      .optional()
      .describe("The whole workflow script, inline. Exactly one of `script`, `saved` and `path`."),
    saved: CreateWorkflowSavedSourceSchema.optional().describe(
      "A saved workflow to run, by name. Exactly one of `script`, `saved` and `path`.",
    ),
    /**
     * Third source: a script file on disk. This is the **round trip** for inline submission—the tool
     * writes a draft, names that file in its result, and the model edits one line before submitting
     * the same path again. Files with a `/* zcode-workflow` block are parsed as saved definitions
     * (strip the block, use the body as the script, and validate `args` against the block's declarations).
     */
    path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "A script file on disk (relative or absolute), usually the file a previous result named. Exactly one of `script`, `saved` and `path`.",
      ),
    /**
     * Arguments declared by the `path` file. `saved` has its own `saved.args` (same validation rules),
     * and inline scripts have no declarations, so this field is present exactly when `path` is;
     * `validateInput` enforces this on model input.
     */
    args: z
      .record(z.unknown())
      .optional()
      .describe("Values for the arguments a `path` file declares. Only with `path`."),
    /**
     * This run's concurrency ceiling. It can only be lowered, not raised:
     * `resolveInput` clamps it to `[1, ceiling]`, so the confirmation window and handler see the value
     * that will take effect. Omission means the ceiling. Set it only when requested by the user—the
     * runtime adapts to provider rate limits, and the model should not use this as a safety margin.
     */
    max_concurrency: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Upper bound on subagents working at once. Only when the user asks to limit parallelism; never as a reaction to provider errors.",
      ),
    /**
     * Model used by this run's subagents. Like `max_concurrency`, the model-facing surface accepts a
     * permissive string, and `resolveInput` resolves it through the model-catalog port into canonical
     * `providerId/modelId[$reasoningLevel]` form. The confirmation window and handler see the value
     * that will take effect; resolution failures return as business errors **before** opening the
     * confirmation window. The main agent always stays on the session model; omission means subagents
     * do too.
     */
    subagent_model: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Model for the subagents (`providerId/modelId` or a model id). Only when the user asks; you stay on the session model.",
      ),
    // Resuming an amendment does not belong here; that is handled by `AmendWorkflow` (amend-workflow.ts).
    // `.strict()` makes the legacy `resume_from` spelling a visible schema error rather than silently
    // ignoring it and performing a full-cost rerun.
  })
  .strict();

/**
 * Runtime input: model-facing fields plus facts populated by `resolveInput`.
 *
 * Populated fields follow the same pattern as `AmendWorkflow.predecessor`: they are not listed in the
 * model's JSON schema because they are resolution results, not user-supplied parameters. If the model
 * supplies them anyway, normalization always overwrites them.
 */
export const CreateWorkflowInputSchema = CreateWorkflowModelInputSchema.extend({
  saved: CreateWorkflowResolvedSavedSourceSchema.optional(),
  /**
   * Offset from body lines to file lines (non-zero only when a `path` / `saved` file has a metadata
   * block). Added when reporting diagnostics by file line so the line number can be pasted directly
   * into an `Edit` on that file.
   */
  script_line_offset: z.number().int().nonnegative().optional(),
}).strict();

export type CreateWorkflowInput = z.infer<typeof CreateWorkflowInputSchema>;

/** JSON schema shown to the model: excludes `script_line_offset` and `draft` from `saved`. */
export const CreateWorkflowInputJsonSchema = toToolJsonSchema(CreateWorkflowModelInputSchema);

export const CreateWorkflowDiagnosticSchema = z
  .object({
    code: z.number(),
    column: z.number(),
    line: z.number(),
    message: z.string(),
  })
  .strict();

export type CreateWorkflowDiagnostic = z.infer<typeof CreateWorkflowDiagnosticSchema>;

// CreateWorkflow display is a bounded projection independent of model text: diagnostics can be
// numerous, so bound them at the protocol boundary to prevent type-check results from expanding
// continuous / replayable messages into unbounded payloads.
// The diagnostic display-item shape is shared by create_workflow and eval_workflow_snippet display
// payloads (same TS diagnostic shape and same bounds), so it is defined here rather than in
// tool-result-metadata.ts, which would need to reference this file's schema and create a cycle.
export const CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS = 100;
export const CREATE_WORKFLOW_DISPLAY_MAX_MESSAGE_CHARS = 2_048;

export const createWorkflowToolResultDisplayDiagnosticSchema = z
  .object({
    line: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
    code: z.number().int().nonnegative(),
    message: z.string().min(1).max(CREATE_WORKFLOW_DISPLAY_MAX_MESSAGE_CHARS),
  })
  .strict();

// Causality graph is a bounded projection for the display channel, but it is bounded at the tool
// output boundary: persisted tool output and live display payloads share one contract, preventing
// their truncation semantics from diverging.
// The payload contains only fields the GUI reads: edges have the single shape `{from, to, back?}`;
// region / certainty / edge kind stay in the analyzer. The second layer is subagent-oriented: a card
// for each participant in each phase plus handoff edges. Step-level edges are therefore omitted from
// the payload (there are no readers); steps / lanes remain keys for runtime state and inspectors.
export const CREATE_WORKFLOW_GRAPH_MAX_STEPS = 64;
export const CREATE_WORKFLOW_GRAPH_MAX_LANES = 32;
export const CREATE_WORKFLOW_GRAPH_MAX_PARTICIPANTS = 64;
export const CREATE_WORKFLOW_GRAPH_MAX_HANDOFFS = 256;
export const CREATE_WORKFLOW_GRAPH_MAX_HANDOFF_TYPES = 8;
export const CREATE_WORKFLOW_GRAPH_MAX_PHASES = 32;
export const CREATE_WORKFLOW_GRAPH_MAX_PHASE_EDGES = 128;
export const CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS = 64;
export const CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS = 128;

export const CREATE_WORKFLOW_STEP_KINDS = ["ask", "world-read"] as const;

// The statically known parts of a name that takes shape only at runtime (`` agent(`Researcher${i + 1}`) ``):
// the literal before the first interpolation (head) and after the last interpolation (tail). At least
// one is present; if the analyzer cannot obtain either, omit the whole field rather than emitting an
// empty pattern. **Data only**: rendering this as "Researcher…" is a presentation-layer decision.
export const CreateWorkflowNamePatternSchema = z
  .object({
    head: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS).optional(),
    tail: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS).optional(),
  })
  .strict();

export type CreateWorkflowNamePattern = z.infer<typeof CreateWorkflowNamePatternSchema>;

// A step is one facade operation to await (ask / files.*). A lane is the actor that performs it (or
// workspace / unknown). `lanes` appears only when the receiver is may-set; in that case, the step is
// expanded into one copy per candidate lane (each with a source). `repeat` distinguishes two clues
// about multiplicity: stack (instances coexist; render stacked cards) and serial (instances occur in
// sequence, already represented by a cycle arrow).
// certainty / region are omitted from the payload because the GUI does not render them.
export const CreateWorkflowStepSchema = z
  .object({
    id: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    kind: z.enum(CREATE_WORKFLOW_STEP_KINDS),
    label: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS),
    /** Static shape of the name when `label` contains only the fallback string (inline `agent()` receiver). */
    labelPattern: CreateWorkflowNamePatternSchema.optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    lane: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    lanes: z
      .array(z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS))
      .max(CREATE_WORKFLOW_GRAPH_MAX_LANES)
      .optional(),
    /**
     * Site id this copy was expanded from; present only on copies expanded across may-set lanes (copy
     * ids look like `ask#2~actor#1`). It is a join key for live overlays: runtime instances report site
     * ids, so cards with a source receive state by `(node.siteId === source, node.actorSiteId === lane)`.
     * Intentionally excluded from reference-integrity normalization—it points to the site replaced by
     * these copies, which is not a node in the graph.
     */
    source: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS).optional(),
    /**
     * Phase assigned by the author's `phase("…")` marker (`phase#2`, or the reserved `unphased`).
     * Appears together with the graph's `phases` / `phaseEdges` / `exits`: all four are either present
     * (and **every** step has a phase, so the partition is complete) or all omitted (no markers in the script).
     */
    phase: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS).optional(),
    repeat: z.enum(["stack", "serial"]).optional(),
  })
  .strict();

export type CreateWorkflowStep = z.infer<typeof CreateWorkflowStepSchema>;

// Lane = one actor (plus a workspace lane). Multiplicity no longer belongs to the lane (it previously
// used families → nesting): lanes are no longer rendered, and participant `member` / `many` expresses
// family size.
export const CreateWorkflowLaneSchema = z
  .object({
    id: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    name: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS).optional(),
    /** Static shape when `name` is absent and the first `agent()` argument is a template string with interpolations; mutually exclusive with `name`. */
    namePattern: CreateWorkflowNamePatternSchema.optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
  })
  .strict();

export type CreateWorkflowLane = z.infer<typeof CreateWorkflowLaneSchema>;

// An edge expresses one thing: runs after. Phase and handoff edges share the same shape. `back` marks
// a cycle edge—it is rendered like any other edge, without a label; only layout ordering (cycle edges
// do not affect columns) and the frame-header cycle count read it. Analyzer kind / certainty / exact
// are omitted from the payload; both edge layers have undergone the same transitive reduction.
export const CreateWorkflowEdgeSchema = z
  .object({
    from: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    to: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    back: z.literal(true).optional(),
  })
  .strict();

export type CreateWorkflowEdge = z.infer<typeof CreateWorkflowEdgeSchema>;

// A participant is one card in the board's second layer: a subagent (or workspace / unresolved
// receiver) with a step in a phase and lane. A fan-out family with literal cardinality expands to one
// card per member (`member`); when cardinality is unknown, one `many` card represents all members.
// `steps` are its steps in this phase—runtime state is aggregated from them, and the inspector lists
// asks from them. Array order is the analyzer-defined handoff order: top-to-bottom when collapsed,
// left-to-right when expanded; the first card starts the sequence.
export const CreateWorkflowParticipantSchema = z
  .object({
    /** `${phase}:${lane}`; family member `${phase}:${lane}[${index}]`. */
    id: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    /** Phase id; always `unphased` when the script has no phase vocabulary (in which case `phases` is omitted). */
    phase: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    lane: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    steps: z
      .array(z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS))
      .min(1)
      .max(CREATE_WORKFLOW_GRAPH_MAX_STEPS),
    member: z
      .object({
        index: z.number().int().nonnegative(),
        of: z.number().int().positive(),
      })
      .strict()
      .optional(),
    many: z.literal(true).optional(),
  })
  .strict();

export type CreateWorkflowParticipant = z.infer<typeof CreateWorkflowParticipantSchema>;

// Handoff = runs-after relationship between participants (after reduction, take the quotient of
// happens-before by card). `types` are artifact types carried across this edge (site-graph data edges);
// shown only in the inspector, not on the arrow.
export const CreateWorkflowHandoffSchema = CreateWorkflowEdgeSchema.extend({
  types: z
    .array(z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS))
    .min(1)
    .max(CREATE_WORKFLOW_GRAPH_MAX_HANDOFF_TYPES)
    .optional(),
}).strict();

export type CreateWorkflowHandoff = z.infer<typeof CreateWorkflowHandoffSchema>;

// Phase = a group of steps marked by the author with `phase("…")`. The name is the key (two markers
// with the same name denote one phase), so `name` preserves the author's original wording. The
// synthesized fallback phase `unphased` has **no name**; the UI localizes its display name (same
// pattern as workspace / unknown lanes). loc is the first marker's position.
export const CreateWorkflowPhaseSchema = z
  .object({
    id: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    name: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS).optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    /**
     * Other phases **still running** when this phase was entered: their fan-out strands had not yet
     * joined. Phase-list order; contains phase ids other than this one. Omit the whole field when empty
     * (it appears and disappears with the phase vocabulary).
     *
     * This is a **node fact**, not an edge—control did not transfer from those phases; both were
     * active simultaneously. So it is neither included in `phaseEdges` nor used in edge reduction
     * (reduction would treat it as runs-after and remove real edges). The reader is the timeline: fold
     * adjacent phases connected by this relation into a branching "band," with a side track above the
     * main line; the sidebar mini-track uses it to draw a double segment.
     */
    alongside: z
      .array(z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS))
      .min(1)
      .max(CREATE_WORKFLOW_GRAPH_MAX_PHASES)
      .optional(),
  })
  .strict();

export type CreateWorkflowPhase = z.infer<typeof CreateWorkflowPhaseSchema>;

// Retains its historical name (it once held only the causality graph). Three layers: the step layer
// contains sites (keys for runtime state, no longer rendered); the participant layer contains cards
// and handoffs per phase (causal facts quotiented by card); the phase layer contains control-flow
// facts (the phase quotient of the control-flow graph). Bridges between layers are
// `Participant.phase` / `Participant.steps`, `Step.phase`, and `exits`.
export const CreateWorkflowCausalityGraphSchema = z
  .object({
    steps: z.array(CreateWorkflowStepSchema).max(CREATE_WORKFLOW_GRAPH_MAX_STEPS),
    lanes: z.array(CreateWorkflowLaneSchema).max(CREATE_WORKFLOW_GRAPH_MAX_LANES),
    participants: z
      .array(CreateWorkflowParticipantSchema)
      .max(CREATE_WORKFLOW_GRAPH_MAX_PARTICIPANTS),
    handoffs: z.array(CreateWorkflowHandoffSchema).max(CREATE_WORKFLOW_GRAPH_MAX_HANDOFFS),
    /**
     * Phase vocabulary, **all-or-none** with `phaseEdges`, `exits`, and `Step.phase`: all four are
     * omitted for scripts with no markers, and the UI uses presence of the vocabulary to choose its
     * view. If over the limit, omit the whole graph (+ `truncated`)—a partially truncated phase graph
     * would be misleading. Phases with no members (marker only, no steps) are included because control
     * flow still passes through them.
     */
    phases: z.array(CreateWorkflowPhaseSchema).max(CREATE_WORKFLOW_GRAPH_MAX_PHASES).optional(),
    phaseEdges: z
      .array(CreateWorkflowEdgeSchema)
      .max(CREATE_WORKFLOW_GRAPH_MAX_PHASE_EDGES)
      .optional(),
    /**
     * Phases after which control flow can complete normally (sources of edges to the sink terminal in
     * the control-flow graph's phase quotient), in phase-list order. The phase view uses this for
     * "phase → return value" arrows, so every arrow in that view represents control flow. May be empty
     * inside the group (the script has no normal completion path); must not appear outside the group.
     */
    exits: z
      .array(z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS))
      .max(CREATE_WORKFLOW_GRAPH_MAX_PHASES)
      .optional(),
    /** Steps that supply the return value (data fact, for drill-down); omitted when the script has no return value. */
    sink: z
      .array(z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS))
      .max(CREATE_WORKFLOW_GRAPH_MAX_STEPS)
      .optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

export type CreateWorkflowCausalityGraph = z.infer<typeof CreateWorkflowCausalityGraphSchema>;

/**
 * Declared phase list for a run: **named** phases from the causality graph, in declaration order.
 * Runtime state knows only which phases have been entered; to draw "which stations are still ahead" on
 * the sidebar mini-track, pass this list to the engine at submission so it can persist it in
 * `run-launched`. Both submission paths (the `CreateWorkflow` tool and direct central launch) share
 * this function, so the same script draws the same track in either path. No graph / no phase vocabulary
 * / only synthesized `unphased` → `undefined` (omit the field rather than return an empty array; the
 * UI draws an implicit station when it is absent).
 */
export function createWorkflowPhaseNames(
  graph: Pick<CreateWorkflowCausalityGraph, "phases"> | undefined,
): string[] | undefined {
  return namedPhases(graph)?.map((phase) => phase.name);
}

/**
 * "Running alongside" list **position-aligned** with {@link createWorkflowPhaseNames}: `out[i]` is
 * the indexes (in the same named phase list) of other phases whose strands were still running when
 * the ith named phase was entered.
 *
 * Indexes refer to **named phases**, not the original phase table in the causality graph: unnamed
 * phases (the synthesized `unphased`) are skipped, as are references to them, unlisted phases, or the
 * phase itself—a single out-of-range index would connect "running alongside" to the wrong station in
 * the sidebar. It is persisted in `run-launched` through
 * `DynamicWorkflowRunSubmitRequest.phaseAlongside`; the sidebar mini-track uses it to draw a double
 * segment between adjacent stations in the same band.
 *
 * No graph / no phase vocabulary / no phase with any alongside entries → `undefined` (omit the field
 * rather than return an array of empty arrays; omission means "this track is a straight line").
 */
export function createWorkflowPhaseAlongside(
  graph: Pick<CreateWorkflowCausalityGraph, "phases"> | undefined,
): number[][] | undefined {
  const named = namedPhases(graph);
  if (named === undefined) return undefined;
  const indexOf = new Map(named.map((phase, index) => [phase.id, index]));
  let any = false;
  const out = named.map((phase, self) => {
    const indexes: number[] = [];
    for (const id of phase.alongside ?? []) {
      const index = indexOf.get(id);
      if (index === undefined || index === self || indexes.includes(index)) continue;
      indexes.push(index);
    }
    any = any || indexes.length > 0;
    return indexes;
  });
  return any ? out : undefined;
}

/** Named phases (declaration order, capped at the limit), with `name` narrowed. */
type CreateWorkflowNamedPhase = CreateWorkflowPhase & { name: string };

/**
 * Shared table for the two functions above: **named** phases from the causality graph, in declaration
 * order, capped at `CREATE_WORKFLOW_GRAPH_MAX_PHASES`. Extracted into one function so both apply the
 * same filtering and use the same index space—`phaseAlongside[i]` must refer to station `phaseNames[i]`.
 */
function namedPhases(
  graph: Pick<CreateWorkflowCausalityGraph, "phases"> | undefined,
): CreateWorkflowNamedPhase[] | undefined {
  if (graph?.phases === undefined) return undefined;
  const named: CreateWorkflowNamedPhase[] = [];
  for (const phase of graph.phases) {
    const name = phase.name;
    if (name === undefined) continue;
    named.push({ ...phase, name });
    if (named.length >= CREATE_WORKFLOW_GRAPH_MAX_PHASES) break;
  }
  return named.length === 0 ? undefined : named;
}

// The two new fields appear only when a run actually starts after confirmation; diagnostic-only
// results retain their original shape.
// Use an explicit schema rather than passing them through raw; `.strict()` exists to make shape
// changes explicit.
export const CreateWorkflowOutputSchema = z
  .object({
    diagnostics: z.array(CreateWorkflowDiagnosticSchema),
    ok: z.boolean(),
    response: z.string(),
    causalityGraph: CreateWorkflowCausalityGraphSchema.optional(),
    /** Present only when a background run starts; not a generic status field, so accept only this literal. */
    status: z.literal("backgrounded").optional(),
    /** Background task id ≡ taskId ≡ runId (used as the key for cancellation and status queries). */
    backgroundTaskId: z.string().min(1).optional(),
    /**
     * Present only when AmendWorkflow changes concurrency in place: there is **no** new run, so there
     * is no `status: "backgrounded"` or `backgroundTaskId`; it is still the same run as the call.
     *
     * This is an explicit block rather than something consumers infer from shape: "ok with no status"
     * has another meaning in this tool ("typecheck only" when the run port is absent). Values are
     * absolute; `maxConcurrency === ceiling` means "this run has no custom limit."
     *
     * ⚠ This fact **does not cross v4**: the protocol's `toolOutputSchema` carries only `text` /
     * `display` / `truncated`, so this serves CLI/TUI and in-process consumers; the desktop UI cannot read it.
     */
    retuned: z
      .object({
        runId: z.string().min(1),
        maxConcurrency: z.number().int().positive(),
        previous: z.number().int().positive(),
        ceiling: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CreateWorkflowOutput = z.infer<typeof CreateWorkflowOutputSchema>;

export const CreateWorkflowOutputJsonSchema = toToolJsonSchema(CreateWorkflowOutputSchema);

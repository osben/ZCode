import type { ToolCallCreateWorkflowCausalityGraph } from "@zcode/shared/zcode-protocol-v4";

/**
 * The graph the renderer consumes is exactly the bounded display payload from the
 * CreateWorkflow tool — one vocabulary from analyzer to pixels. A future live runtime
 * view reuses the same component by feeding `statuses` (and flipping `animatedEdges`);
 * absence of both renders the static analysis picture.
 *
 * The whole visual vocabulary, deliberately small
 *
 *   a module = a phase · a card = a participant (a subagent, or the workspace, in that
 *   phase) · a collapsed module = a deck of its participants' cards · an arrow = "runs
 *   after" · a terminal dot = the returned artifact
 * Hand-off arrows inside a module are causality facts quotiented by participant; arrows
 * between modules are control flow (the CFG's phase quotient); both are the same arrow.
 * `back` marks a loop's back edge for ranking only — same ink. Steps and lanes stay in the
 * payload as the run-status join key and the inspector's material; neither is drawn.
 */
export type WorkflowCausalityGraphData = ToolCallCreateWorkflowCausalityGraph;
export type WorkflowStepData = WorkflowCausalityGraphData["steps"][number];
export type WorkflowLaneData = WorkflowCausalityGraphData["lanes"][number];
export type WorkflowParticipantData = WorkflowCausalityGraphData["participants"][number];
export type WorkflowHandoffData = WorkflowCausalityGraphData["handoffs"][number];
/**
 * Grouping structure assigned by the author with `phase("…")`; it forms the board's first level.
 * For scripts without markers, the UI synthesizes an implicit phase (participant-model.ts). `phases` and
 * `phaseEdges` are optional, so these aliases remove undefined and consumers always receive the array element type.
 */
export type WorkflowPhaseData = NonNullable<WorkflowCausalityGraphData["phases"]>[number];
export type WorkflowPhaseEdgeData = NonNullable<WorkflowCausalityGraphData["phaseEdges"]>[number];

/** Per-step run state for the live-execution view; keyed by step id. */
export type StepRunStatus = "pending" | "running" | "done" | "failed";

/**
 * Status table indexed by step ID. It is **sparse**: steps with no observed instances have no entry.
 * Absence and `pending` differ: the former means "nothing happened here"; the latter means "a real instance is queued".
 * Treating them as the same would make a branch station with no control flow appear pending as a whole.
 */
export type StepStatusTable = Partial<Record<string, StepRunStatus>>;

/**
 * Three selectable items on the board: a participant card, a phase module, and a terminal return value.
 * `line` is a convenience field for the host to locate the script line (permission block).
 */
export type WorkflowGraphSelectionKind = "participant" | "phase" | "sink";
export interface WorkflowCausalityGraphSelection {
  id: string;
  kind: WorkflowGraphSelectionKind;
  line?: number;
}

/** The single lane every `files.*` read runs in. */
export const WORKSPACE_LANE_ID = "workspace";
/** Lane of an ask whose receiver the analysis could not resolve to an actor site. */
export const UNKNOWN_LANE_ID = "unknown";
/**
 * Main-agent lane: the analyzer records each open hole as a step on this lane (analysis.md, “Sites”). It is not a subagent,
 * and is never drawn as a pill—an open hole is itself a site (presentation.md, “Pills”).
 */
export const MAIN_LANE_ID = "main";
/** The terminal marker node: the artifact the workflow returns. */
export const SINK_NODE_ID = "sink";
/**
 * Fallback phase: home for steps emitted before the first `phase()` marker, and the implicit sole phase for scripts with no markers
 * (the analyzer's participants always use `phase: "unphased"`). Keep the ID and provide **no name**; the UI localizes the display name,
 * following the same pattern as `workspace`/`unknown` lanes (see phase-name.ts).
 */
export const UNPHASED_PHASE_ID = "unphased";
/**
 * ID of the implicit sole module for scripts without markers (synthesized by the UI; see `withImplicitPhase` in participant-model.ts).
 * Kept separate from `unphased`: in scripts with markers, that label means "before the first marker" (Ungrouped), while the implicit
 * module represents the whole workflow (Workflow).
 */
export const IMPLICIT_PHASE_ID = "workflow";

/**
 * What a lane IS, which is the only thing colour encodes in this view. `workspace` is
 * not an actor (no mailbox, hence no `fifo`) and `unresolved` is an ask whose receiver
 * the analysis could not site — both are real distinctions. Per-actor identity is
 * carried by the name on the card, not by a tint.
 *
 * It lives here, next to the ids it is derived from, because both the projection and the
 * naming policy (lane-name.ts) key on it.
 */
export type LaneClass = "agent" | "workspace" | "unresolved";

export function laneClassOf(laneId: string): LaneClass {
  if (laneId === WORKSPACE_LANE_ID) return "workspace";
  if (laneId === UNKNOWN_LANE_ID) return "unresolved";
  return "agent";
}

export function isSyntheticLaneId(id: string): boolean {
  return id === WORKSPACE_LANE_ID || id === UNKNOWN_LANE_ID || id === MAIN_LANE_ID;
}

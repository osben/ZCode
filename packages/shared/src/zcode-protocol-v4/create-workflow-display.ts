// ============================================================
// CreateWorkflow tool-card display payload (a member of toolCallDisplaySchema in rows.ts).
// ============================================================
// Split out of rows.ts: the workflow display and causality graph schemas pushed rows.ts over the max-lines limit,
// and together they form a self-contained vocabulary (following workspace-hook-review.ts, where feature-level schemas live in a separate module).

import { z } from "zod";

// CreateWorkflow display is a bounded projection independent of model text; both the number of diagnostics and each message's length must be
// limited at the protocol boundary so type-check results cannot expand continuous/replayable messages into unbounded payloads.
// The same applies to causalityGraph: the tool-output boundary limits the number of steps/lanes/edges and label length; mirror
// the same bounds here. The graph vocabulary is intentionally small: participant cards, one arrow (runs after; `back` only marks a back edge),
// phase modules, and return markers; analyzer kind/certainty/exact/region do not enter the payload. Handoff edges quotient causal facts by subagent, while the phase layer
// quotients the control-flow graph by phase; steps/lanes are keys for runtime state and the inspector, not nodes drawn in the graph.
//
// The statically available shape when a name is formed only at runtime (`` agent(`Researcher${i + 1}`) ``): the literal before the first hole
// (head) and the literal after the last hole (tail). At least one must be present, and both are trimmed and contain meaningful characters.
// Carries **data only**: name-pattern.ts adds the ellipsis when rendering "Researcher…"; copy is not stored in the projection
// (for the same reason as the anonymous fallback; see the header of lane-name.ts).
const namePatternSchema = z
  .object({
    head: z.string().min(1).max(128).optional(),
    tail: z.string().min(1).max(128).optional(),
  })
  .strict();

// Each edge means runs after; handoff and phase edges share the same shape. `back` marks only a cycle back edge (used for layout ranking and cycle counts),
// and is drawn like the other edges.
const workflowEdgeSchema = z
  .object({
    from: z.string().min(1).max(64),
    to: z.string().min(1).max(64),
    back: z.literal(true).optional(),
  })
  .strict();

const toolCallCreateWorkflowCausalityGraphSchema = z
  .object({
    steps: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            kind: z.enum(["ask", "world-read"]),
            label: z.string().min(1).max(128),
            // Static name shape when an inline `agent()` receiver makes the label fall back to a string.
            labelPattern: namePatternSchema.optional(),
            line: z.number().int().positive().optional(),
            column: z.number().int().positive().optional(),
            lane: z.string().min(1).max(64),
            lanes: z.array(z.string().min(1).max(64)).max(32).optional(),
            // Site id that this was expanded from; appears only on expanded copies of may-set lanes (the correlation key for live overlays);
            // This additive field keeps old payloads that omit it valid under .strict().
            source: z.string().min(1).max(64).optional(),
            // Phases explicitly marked by the author using `phase("…")`.
            // Present or absent together with the graph's phases / phaseEdges / exits.
            phase: z.string().min(1).max(64).optional(),
            repeat: z.enum(["stack", "serial"]).optional(),
          })
          .strict(),
      )
      .max(64),
    lanes: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            name: z.string().min(1).max(128).optional(),
            // Static shape when `name` is absent and the first agent() argument is a template string with holes; mutually exclusive with name.
            namePattern: namePatternSchema.optional(),
            line: z.number().int().positive().optional(),
            column: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .max(32),
    // Participants: one subagent card per phase (workspace/unresolved share a shape); array order is the handoff order, and the first card starts the run.
    // Fan-out families expand into members when the literal cardinality is known; otherwise, use one many card.
    participants: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            phase: z.string().min(1).max(64),
            lane: z.string().min(1).max(64),
            steps: z.array(z.string().min(1).max(64)).min(1).max(64),
            member: z
              .object({ index: z.number().int().nonnegative(), of: z.number().int().positive() })
              .strict()
              .optional(),
            many: z.literal(true).optional(),
          })
          .strict(),
      )
      .max(64),
    // Handoffs are runs-after relations between participants; types are the artifact types passed across them (inspector data, not shown on the arrow).
    handoffs: z
      .array(
        workflowEdgeSchema
          .extend({ types: z.array(z.string().min(1).max(128)).min(1).max(8).optional() })
          .strict(),
      )
      .max(256),
    // Phase vocabulary: author-defined grouping structure used as nodes in the main view. Together with phaseEdges / exits / Step.phase,
    // it is all-or-nothing: scripts with no phase markers omit all of it, letting the UI fall back to the step/lane view. Phases with no members remain in the table.
    // `unphased` has no name; the UI localizes its display name.
    phases: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            name: z.string().min(1).max(128).optional(),
            line: z.number().int().positive().optional(),
            column: z.number().int().positive().optional(),
            // Other phases still running when this phase begins (their strands have not joined yet), in phase-table order, excluding itself,
            // and omitted when empty. This is a node fact, not an edge: control did not transfer from those phases, so they are not included in phaseEdges.
            // The timeline uses this to fold adjacent phases into a forked band; the sidebar mini track draws them as double segments.
            alongside: z.array(z.string().min(1).max(64)).min(1).max(32).optional(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    phaseEdges: z.array(workflowEdgeSchema).max(128).optional(),
    // Phases after which control flow can complete normally (the phase-view "phase → return" arrow); may be an empty array within a group.
    exits: z.array(z.string().min(1).max(64)).max(32).optional(),
    sink: z.array(z.string().min(1).max(64)).max(64).optional(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallCreateWorkflowCausalityGraph = z.infer<
  typeof toolCallCreateWorkflowCausalityGraphSchema
>;

export const toolCallCreateWorkflowDisplaySchema = z
  .object({
    kind: z.literal("create_workflow"),
    ok: z.boolean(),
    errorCount: z.number().int().nonnegative(),
    diagnostics: z
      .array(
        z
          .object({
            line: z.number().int().nonnegative(),
            column: z.number().int().nonnegative(),
            code: z.number().int().nonnegative(),
            message: z.string().min(1).max(2_048),
          })
          .strict(),
      )
      .max(100),
    causalityGraph: toolCallCreateWorkflowCausalityGraphSchema.optional(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallCreateWorkflowDisplay = z.infer<typeof toolCallCreateWorkflowDisplaySchema>;

import { z } from "zod";

/**
 * Stateless workflow methods of the Rust ↔ helper link (specs/fork-rust-workflow-engine.md, section 4.1, as built in W4).
 * Neither reads or writes storage, a session or the run journal.
 */
export const FORK_RUST_HELPER_WORKFLOW = {
  compile: "helper/workflow/compile",
  format: "helper/workflow/format",
  evalSnippet: "helper/workflow/evalSnippet",
  fillPrepare: "helper/workflow/fillPrepare",
} as const;

/**
 * `helper/workflow/fillPrepare` (W7-12, 9.45): the fill of one hole, prepared without touching the run. `modelBindings` is
 * the run's name-to-canonical table, empty when the run named none.
 */
export const workflowFillPrepareParamsSchema = z
  .object({
    scriptText: z.string(),
    runId: z.string().trim().min(1),
    holeId: z.string().trim().min(1),
    body: z.string(),
    modelBindings: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/**
 * `helper/workflow/evalSnippet` (W7-8c, specs/fork-rust-workflow-engine.md, 9.28): the snippet compile of EvalWorkflowSnippet.
 * It compiles under the snippet facade (no agent()), refuses non-literal world.run commands, and renders the child entry for
 * `runId`. It runs nothing and reads no storage.
 */
export const workflowEvalSnippetParamsSchema = z
  .object({
    scriptText: z.string(),
    runId: z.string().trim().min(1),
  })
  .strict();

/** `helper/workflow/compile`: the script, the identity of the run it will start, and the run's frozen args. */
export const workflowCompileParamsSchema = z
  .object({
    scriptText: z.string(),
    runId: z.string().trim().min(1),
    args: z.record(z.string(), z.unknown()).optional(),
    resumedFrom: z.string().trim().min(1).optional(),
  })
  .strict();

/**
 * `helper/workflow/format` (specs/fork-rust-workflow-engine.md, 4.1 and 9.17). Each kind runs Node's own tool entry
 * from `builtInTools`, so the text and the display are Node's, not a second implementation:
 * - `analysis` (W4): the JSON of `analyzeWorkflowScript`.
 * - `display` (W7-2): the CreateWorkflow confirmation window of the script, or `null` when Node opens no window.
 * - `runList` (W7-2): the ListWorkflowRuns text. `listed` is the run port's list result for `input`'s query.
 * - `runDetail` (W7-2): the GetWorkflowRun text. `detail` is the run port's detail; the summary is built by Node's handler.
 * Any other kind is refused with -32602.
 */
/**
 * The run port's list result, as Node's ListWorkflowRuns handler reads it: `runs` is mapped unconditionally, so it must be
 * an array. Other members pass through to Node unchanged (loose), so Node sees the same data Rust sent.
 */
const listedSchema = z.looseObject({
  runs: z.array(z.record(z.string(), z.unknown())),
  truncated: z.boolean().optional(),
});

/**
 * The run port's detail, as Node's GetWorkflowRun handler reads it. Each member listed here is dereferenced without a guard
 * (`usage.*`, `.map` over `actors` and `logTail`, `subagents`, `health`), so drift is refused as -32602 rather than
 * surfacing as a TypeError. Other members pass through unchanged (loose).
 */
const detailSchema = z.looseObject({
  runId: z.string(),
  label: z.string(),
  labelSource: z.string(),
  status: z.string(),
  ownedByThisSession: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  usage: z.record(z.string(), z.unknown()),
  actors: z.array(z.record(z.string(), z.unknown())),
  logTail: z.array(z.record(z.string(), z.unknown())),
  subagents: z.array(z.record(z.string(), z.unknown())),
  health: z.record(z.string(), z.unknown()),
});

export const workflowFormatParamsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("analysis"), scriptText: z.string() }).strict(),
  z
    .object({
      kind: z.literal("runList"),
      input: z.record(z.string(), z.unknown()),
      listed: listedSchema,
      workingDirectory: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("runDetail"),
      runId: z.string().trim().min(1),
      // `null` is an unknown run: Node's not-found failure is then the answer.
      detail: detailSchema.nullable(),
      workingDirectory: z.string().min(1),
    })
    .strict(),
]);

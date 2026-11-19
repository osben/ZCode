import { z } from "zod";

/**
 * Stateless workflow methods of the Rust ↔ helper link (specs/fork-rust-workflow-engine.md, section 4.1, as built in W4).
 * Neither reads or writes storage, a session or the run journal.
 */
export const FORK_RUST_HELPER_WORKFLOW = {
  compile: "helper/workflow/compile",
  format: "helper/workflow/format",
} as const;

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
export const workflowFormatParamsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("analysis"), scriptText: z.string() }).strict(),
  z.object({ kind: z.literal("display"), scriptText: z.string() }).strict(),
  z
    .object({
      kind: z.literal("runList"),
      input: z.record(z.string(), z.unknown()),
      listed: z.record(z.string(), z.unknown()),
      workingDirectory: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("runDetail"),
      runId: z.string().trim().min(1),
      detail: z.record(z.string(), z.unknown()),
      workingDirectory: z.string().min(1),
    })
    .strict(),
]);

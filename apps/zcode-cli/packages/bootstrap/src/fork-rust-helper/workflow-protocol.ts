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

/** `helper/workflow/format`: only the analysis is served in W4. Other kinds are refused with -32602. */
export const workflowFormatParamsSchema = z
  .object({
    kind: z.literal("analysis"),
    scriptText: z.string(),
  })
  .strict();

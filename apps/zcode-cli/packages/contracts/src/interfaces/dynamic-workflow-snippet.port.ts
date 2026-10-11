// ============================================================
// Dynamic Workflow Snippet Port - synchronous compile-and-execute boundary for snippets
// ============================================================
// Sits alongside {@link import("./dynamic-workflow-run.port.js").DynamicWorkflowRunPort}, rather
// than being merged into it: the run port requires a durable journal (without persistence,
// there is no run), while snippets are fully transient and depend only on two execution ports.
// Putting snippets on the run port would make the experimental path inherit its durability requirement.

import type { TraceContext } from "../tracing/tracer.js";

/** JSON shape of one compile diagnostic (same as CreateWorkflow's diagnostic; the port does not import the zod schema). */
export interface DynamicWorkflowSnippetDiagnostic {
  code: number;
  column: number;
  line: number;
  message: string;
}

export interface DynamicWorkflowSnippetEvalRequest {
  /** Snippet source (scratch facade vocabulary: files.*, git.*, log, plain TypeScript). */
  code: string;
  /** Execution working directory (sandbox subprocess cwd and world-read root). */
  cwd: string;
  /** Wall-clock limit for the entire snippet (ms). The tool layer clamps it; the port executes the supplied value. */
  timeoutMs: number;
  trace: TraceContext;
}

export interface DynamicWorkflowSnippetEvalOptions {
  signal?: AbortSignal;
}

/**
 * Structured result of eval. The three shapes are mutually exclusive:
 *   - Compilation failed: `diagnostics` is non-empty; nothing was executed.
 *   - Execution completed: `artifact` is the script's top-level return value (omitted when
 *     the result is `undefined`).
 *   - Execution failed: `error` contains a stable error code (timeout / script exception / cap
 *     rejection all use this shape).
 * `logs` is present in the latter two shapes; output leading up to a failure is useful too.
 */
export type DynamicWorkflowSnippetEvalResult =
  | { kind: "diagnostics"; diagnostics: DynamicWorkflowSnippetDiagnostic[] }
  | { kind: "completed"; artifact?: unknown; logs: string[]; logsTruncated: boolean }
  | {
      kind: "failed";
      error: { code: string; message: string };
      logs: string[];
      logsTruncated: boolean;
    };

export interface DynamicWorkflowSnippetPort {
  /** Compile once and execute synchronously to settlement (fully transient: no dwf_* rows or background task). */
  evalSnippet(
    request: DynamicWorkflowSnippetEvalRequest,
    options?: DynamicWorkflowSnippetEvalOptions,
  ): Promise<DynamicWorkflowSnippetEvalResult>;
}

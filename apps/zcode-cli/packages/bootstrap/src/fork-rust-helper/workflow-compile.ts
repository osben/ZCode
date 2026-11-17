import { analyzeWorkflowScript } from "@zcode/dynamic-workflow";
import { renderChildEntry } from "@zcode/dynamic-workflow-runtime";
import { compileOnce } from "../app/dynamic-workflow-run-compile.js";
import { parseParams } from "../zcode-protocol/server-types.js";
import { workflowCompileParamsSchema, workflowFormatParamsSchema } from "./workflow-protocol.js";

/**
 * `helper/workflow/compile`: the same gates as the Node CreateWorkflow handler (analysis, then compile once). A script
 * that fails either gate is answered with its diagnostics and no entry, so no run can start from it.
 *
 * The entry source is the sandbox child's ESM file (`renderChildEntry`). The Rust agent writes it and spawns the child;
 * this handler never starts a process.
 */
export function compileWorkflowForRust(raw: unknown) {
  const params = parseParams(workflowCompileParamsSchema, raw);
  const analysis = analyzeWorkflowScript(params.scriptText);
  if (!analysis.ok) return { ok: false as const, diagnostics: analysis.diagnostics };
  let compiled;
  try {
    compiled = compileOnce(params.scriptText);
  } catch (error) {
    return {
      ok: false as const,
      diagnostics: [],
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const { lowered, ...rest } = compiled;
  const entrySource = renderChildEntry(
    {
      lowered,
      args: params.args ?? {},
      run: { id: params.runId, ...(params.resumedFrom ? { resumedFrom: params.resumedFrom } : {}) },
    },
    { runId: params.runId },
  );
  return { ok: true as const, scriptHash: rest.scriptHash, compiled: rest, entrySource };
}

/** `helper/workflow/format {kind: "analysis"}`: the analysis of `analyzeWorkflowScript`, for the window graph. */
export function formatWorkflowForRust(raw: unknown) {
  const params = parseParams(workflowFormatParamsSchema, raw);
  return { analysis: analyzeWorkflowScript(params.scriptText) };
}

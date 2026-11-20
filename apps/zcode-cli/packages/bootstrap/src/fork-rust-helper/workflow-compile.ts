import {
  CREATE_WORKFLOW_TOOL_NAME,
  GET_WORKFLOW_RUN_TOOL_NAME,
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  ListWorkflowRunsInputSchema,
} from "@zcode/contracts";
import { builtInTools } from "@zcode/core";
import {
  analyzeWorkflowScript,
  collectDiagnostics,
  collectSites,
  collectWorldRunCommands,
  createWorkflowProgram,
  lowerWorkflow,
  SNIPPET_FACADE_DTS,
} from "@zcode/dynamic-workflow";
import { renderChildEntry } from "@zcode/dynamic-workflow-runtime";
import { compileOnce } from "../app/dynamic-workflow-run-compile.js";
import { parseParams } from "../zcode-protocol/server-types.js";
import {
  workflowCompileParamsSchema,
  workflowEvalSnippetParamsSchema,
  workflowFormatParamsSchema,
} from "./workflow-protocol.js";

/**
 * `helper/workflow/evalSnippet` (W7-8c): the snippet compile of Node's `dynamic-workflow-snippet-service.ts`, in the same
 * order. Diagnostics of the snippet facade come first, then the world.run literals; a clean snippet is lowered and its child
 * entry rendered for the run id the Rust side gives. `worldRun` says whether the snippet carries a world.run command, which
 * decides the confirmation. Nothing is started and nothing is read from disk.
 */
export function evalSnippetForRust(raw: unknown) {
  const params = parseParams(workflowEvalSnippetParamsSchema, raw);
  const workflow = createWorkflowProgram(params.scriptText, { facadeDts: SNIPPET_FACADE_DTS });
  const diagnostics = collectDiagnostics(workflow.program);
  if (diagnostics.length > 0) return { ok: false as const, diagnostics };
  const table = collectSites(workflow);
  const worldRun = collectWorldRunCommands(workflow, table);
  if (worldRun.diagnostics.length > 0) {
    return { ok: false as const, diagnostics: worldRun.diagnostics };
  }
  const lowered = lowerWorkflow(workflow, table);
  const entrySource = renderChildEntry(
    { lowered: lowered.code, args: {}, run: { id: params.runId } },
    { runId: params.runId },
  );
  return {
    ok: true as const,
    worldRun: worldRun.commands.length > 0,
    entrySource,
  };
}

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
  // The reply is JSON: a Map or Set would serialize as {} or []. The copy below is for the reply only; Node's own
  // compile result keeps its Maps (9.37, divergence 333).
  return {
    ok: true as const,
    scriptHash: rest.scriptHash,
    compiled: jsonShape(rest) as Record<string, unknown>,
    entrySource,
  };
}

/**
 * A JSON-safe copy of a value: Maps become objects keyed by their keys (as text), Sets become arrays, and both are
 * converted at every depth. Plain objects and arrays are copied, every other value is kept.
 */
export function jsonShape(value: unknown): unknown {
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([key, entry]) => [String(key), jsonShape(entry)]),
    );
  }
  if (value instanceof Set) return [...value].map((entry) => jsonShape(entry));
  if (Array.isArray(value)) return value.map((entry) => jsonShape(entry));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, jsonShape(entry)]),
    );
  }
  return value;
}

/**
 * A tool entry of Node's `builtInTools` as far as the format methods use it. The formatters and the window display are
 * Node's own, reached through the entry, so nothing here re-implements them (specs/fork-rust-workflow-engine.md, 9.17).
 */
interface NodeToolEntry {
  metadata: { name: string };
  handler: (input: unknown, context: unknown) => Promise<unknown>;
  formatModelContent?: (output: unknown) => unknown;
  prepareApproval?: (input: unknown) => { gate: string; display?: unknown };
}

function nodeTool(name: string): NodeToolEntry {
  const entry = (builtInTools as unknown as NodeToolEntry[]).find(
    (tool) => tool.metadata.name === name,
  );
  if (entry === undefined) throw new Error(`Node has no tool ${name}`);
  return entry;
}

/** A handler's failure (`result: false` with an error code and message), as opposed to its output. */
function isFailure(output: unknown): output is { message: string } {
  return (
    typeof output === "object" &&
    output !== null &&
    (output as { result?: unknown }).result === false &&
    typeof (output as { message?: unknown }).message === "string" &&
    "errorCode" in output
  );
}

/** The text Node's formatter gives for a handler output. */
function formatted(entry: NodeToolEntry, output: unknown): string {
  const text = entry.formatModelContent?.(output);
  if (typeof text !== "string") throw new Error(`${entry.metadata.name} has no text formatter`);
  return text;
}

/**
 * `helper/workflow/format`: `analysis` is the analysis of `analyzeWorkflowScript`, for the window graph; `display` is the
 * CreateWorkflow confirmation window (Node's `prepareApproval`, so the same `displayOfAnalysis` path as the dialog);
 * `runList` and `runDetail` run Node's handler on the port data Rust sends and format the output with Node's formatter.
 */
export async function formatWorkflowForRust(raw: unknown) {
  const params = parseParams(workflowFormatParamsSchema, raw);
  switch (params.kind) {
    case "analysis":
      return { analysis: analyzeWorkflowScript(params.scriptText) };
    case "display": {
      // Node's prepareApproval reads the input resolveInput produces, where `model_bindings` sits.
      const decision = nodeTool(CREATE_WORKFLOW_TOOL_NAME).prepareApproval?.({
        script: params.scriptText,
        ...(params.modelBindings === undefined ? {} : { model_bindings: params.modelBindings }),
      });
      return {
        display:
          decision?.gate === "ask" && decision.display !== undefined ? decision.display : null,
      };
    }
    case "runList": {
      // Node's own input schema, parsed here so a bad query is -32602 instead of a ZodError from inside the handler.
      const input = parseParams(ListWorkflowRunsInputSchema, params.input);
      const entry = nodeTool(LIST_WORKFLOW_RUNS_TOOL_NAME);
      const port = { listRuns: async () => params.listed };
      const output = await entry.handler(input, {
        workingDirectory: params.workingDirectory,
        dynamicWorkflowRunPort: port,
      });
      return { text: formatted(entry, output) };
    }
    case "runDetail": {
      const entry = nodeTool(GET_WORKFLOW_RUN_TOOL_NAME);
      const detail = params.detail ?? undefined;
      const port = { getRunDetail: async () => detail };
      const output = await entry.handler(
        { run_id: params.runId },
        { workingDirectory: params.workingDirectory, dynamicWorkflowRunPort: port },
      );
      // An unknown run is Node's failure (not an output): its message is the model's text.
      if (isFailure(output)) return { text: output.message };
      return { text: formatted(entry, output) };
    }
  }
}

// ============================================================
// SaveWorkflow Tool Handler
// ============================================================
// Save a DWF script and metadata as a reusable project definition.
//
// Intentionally mirror CreateWorkflow's shape because, to the model, these are two verbs for related actions:
//   1. Compile the script with the **same** checker. If it fails, return diagnostics directly without a dialog or file write. Asking the
//      user to approve code that cannot compile only interrupts the agent's own repair/retry loop with a decision that has no effect
//      (same reasoning as in create-workflow.ts).
//   2. If clean, show confirmation. Writing a file to the user's repository is an irreversible external action and always requires asking.
//   3. On Allow, write it to disk.
//
// The key difference from CreateWorkflow is **what the confirmation dialog asks**: that tool asks “should I spend these resources to
// run this code?”, while this one asks “should I keep this code in the repository so it may be run again later?” `resolveInput`
// computes the facts needed to answer—destination, metadata, and **whether this is create or overwrite**—in normalized input. This
// tool intentionally has **no display**: input passes through without a schema on every client version, while older clients cannot read
// new display fields and may reject the whole payload (see the field-set comment in tool-result-metadata.ts). New desktops render a
// rich confirmation block from input based on toolName and use `overwrite` to distinguish the cases; old desktops and legacy v3 get a
// generic permission prompt plus the full input JSON, degraded but complete.

import {
  SAVE_WORKFLOW_SENTINEL_IN_SCRIPT_ERROR,
  SAVE_WORKFLOW_SOURCE_ERROR,
  SAVE_WORKFLOW_TOOL_NAME,
  SAVED_WORKFLOW_MAX_NAME_CHARS,
  SaveWorkflowInputJsonSchema,
  SaveWorkflowInputSchema,
  SaveWorkflowOutputJsonSchema,
  SaveWorkflowOutputSchema,
  isValidSavedWorkflowName,
  type ModelMessageContent,
  type SaveWorkflowInput,
  type SaveWorkflowOutput,
  type SavedWorkflowMeta,
} from "@zcode/contracts";
import type {
  ToolApprovalGate,
  ToolEntry,
  ToolHandler,
  ToolInputResolutionResult,
  ToolInputValidationResult,
} from "../types.js";
import { SAVE_WORKFLOW_TOOL_DESCRIPTION } from "./save-workflow-description.js";
import {
  SAVED_WORKFLOW_SENTINEL,
  findSavedWorkflowShadowing,
  savedWorkflowExists,
  savedWorkflowPath,
  savedWorkflowRoot,
  saveSavedWorkflow,
} from "./saved-workflows/index.js";
import { readWorkflowScriptFile } from "./workflow-path-source.js";
import { analyzeScript } from "./workflow-script-analysis.js";
import { requireDynamicWorkflowSkill } from "./workflow-skill-gate.js";

const SAVE_WORKFLOW_TIMEOUT_MS = 15_000;
const SAVE_WORKFLOW_MODEL_BYTES = 24_000;
const SAVE_WORKFLOW_FAILURE_CODE = 400;

const DIAGNOSTICS_NOT_SAVED_NOTE =
  "NOTE: Nothing was saved — fix the errors above and call the tool again.";

/** Metadata view: combine the three input fields into the object written as frontmatter. */
function toMeta(parsed: SaveWorkflowInput): SavedWorkflowMeta {
  return {
    description: parsed.description,
    ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
    ...(parsed.args === undefined ? {} : { args: parsed.args }),
  };
}

/**
 * Validate the semantics of model input before the hook runs.
 *
 * Reject scripts that already contain frontmatter as a business failure; do **not** “helpfully replace” it when detected. After a
 * merge, the model cannot tell whether its `description` input or the file's value took effect, and encode idempotence (exactly one
 * frontmatter block in the file) would no longer be enforced.
 */
function validateSaveWorkflowInput(input: unknown): ToolInputValidationResult {
  const parsed = SaveWorkflowInputSchema.safeParse(input);
  if (!parsed.success) return { result: true };

  if (!isValidSavedWorkflowName(parsed.data.name)) {
    return {
      result: false,
      errorCode: SAVE_WORKFLOW_FAILURE_CODE,
      message: `'${parsed.data.name}' is not a usable workflow name: names may only contain letters, digits, '.', '-' and '_', and must be 1-${SAVED_WORKFLOW_MAX_NAME_CHARS} characters.`,
    };
  }

  const hasScript = parsed.data.script !== undefined;
  const hasScriptPath = parsed.data.script_path !== undefined;
  if (hasScript === hasScriptPath) {
    return {
      result: false,
      errorCode: SAVE_WORKFLOW_FAILURE_CODE,
      message: SAVE_WORKFLOW_SOURCE_ERROR,
    };
  }

  // Check for existing frontmatter only in **inline** bodies: `script_path` often points to a draft copied from a saved definition,
  // which already has a block that resolveInput strips. Rejecting that would disable the main use of this path.
  if (parsed.data.script?.trimStart().startsWith(SAVED_WORKFLOW_SENTINEL) === true) {
    return {
      result: false,
      errorCode: SAVE_WORKFLOW_FAILURE_CODE,
      message: SAVE_WORKFLOW_SENTINEL_IN_SCRIPT_ERROR,
    };
  }

  return { result: true };
}

/**
 * Normalize input by resolving the destination, overwrite state, and shadowing facts.
 *
 * These are key facts for the confirmation decision (approving an overwrite means accepting replacement of the disk copy; a
 * shadowing notice tells the user whether a same-name definition in the other scope will take precedence in this project). Put them
 * in **input**, not display, because input passes through without a schema on every client version; old desktops and legacy v3 still
 * receive the full content, while new display fields would be unreadable or could invalidate the entire payload.
 *
 * Do not fill in scope: it is required model input. Use it only to choose the root for `path` / `overwrite` / `shadowing`.
 */
async function resolveSaveWorkflowInput(
  input: unknown,
  cwd: string,
): Promise<ToolInputResolutionResult> {
  const parsed = SaveWorkflowInputSchema.safeParse(input);
  if (!parsed.success) return { result: true, input };

  // Read `script_path` into the body first: the confirmation dialog, which runs before the handler, must show the exact bytes that
  // will be written. Strip its metadata block (keep only the body); the current call's fields define the metadata the user approves.
  let script = parsed.data.script;
  if (parsed.data.script_path !== undefined) {
    const read = await readWorkflowScriptFile({ cwd, inputPath: parsed.data.script_path });
    if (!read.ok) {
      return { result: false, errorCode: SAVE_WORKFLOW_FAILURE_CODE, message: read.message };
    }
    script = read.file.script;
  }

  const { scope, name } = parsed.data;
  const shadowing = findSavedWorkflowShadowing({ cwd, name, scope });
  return {
    result: true,
    input: {
      ...parsed.data,
      ...(script === undefined ? {} : { script }),
      path: savedWorkflowPath(savedWorkflowRoot(cwd, scope), name),
      overwrite: savedWorkflowExists({ cwd, name, scope }),
      // Omit the key when there is no matching name; an undefined value would add a noisy field to every save.
      ...(shadowing === undefined ? {} : { shadowing }),
    } satisfies SaveWorkflowInput,
  };
}

const saveWorkflowHandler: ToolHandler = async (input, context) => {
  const parsed = SaveWorkflowInputSchema.parse(input) as SaveWorkflowInput;
  const cwd = context.workingDirectory ?? ".";
  const scope = parsed.scope;
  // Normalization provides the destination; if absent, a caller bypassed the executor lifecycle, so compute it here rather than crashing.
  const path = parsed.path ?? savedWorkflowPath(savedWorkflowRoot(cwd, scope), parsed.name);
  const script = parsed.script;
  if (script === undefined) {
    // Unreachable: validateInput rejects the case where neither is provided, and resolveInput reads `script_path` into `script`.
    // If it happens, a caller bypassed the executor lifecycle; report it rather than silently saving an empty file.
    throw new Error("SaveWorkflow handler received input without a resolved script");
  }

  const { diagnostics, ok } = analyzeScript(script);
  if (!ok) {
    return {
      name: parsed.name,
      scope,
      path,
      diagnostics,
      ok,
      response: [
        "The workflow script has errors:",
        ...diagnostics.map(
          (diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`,
        ),
        "",
        DIAGNOSTICS_NOT_SAVED_NOTE,
      ].join("\n"),
    } satisfies SaveWorkflowOutput;
  }

  // Propagate write failures (read-only mount, permissions) as tool-call failures. Never swallow them and return a success output with
  // a path, which would make the model tell the user the file was saved.
  //
  // Recompute `overwritten` **at write time** instead of trusting input `overwrite`: that input fact is for the confirmation dialog
  // and hook, and a hook can mutate it. Letting it change the post-write report would turn a display field into a behavior switch.
  const written = saveSavedWorkflow({
    cwd,
    name: parsed.name,
    meta: toMeta(parsed),
    script,
    scope,
  });

  const isGlobal = written.scope === "global";
  return {
    name: parsed.name,
    scope: written.scope,
    path: written.path,
    diagnostics,
    ok,
    overwritten: written.overwritten,
    response: [
      written.overwritten
        ? isGlobal
          ? `Replaced the saved global workflow '${parsed.name}' at ${written.path}.`
          : `Replaced the saved workflow '${parsed.name}' at ${written.path}.`
        : isGlobal
          ? `Saved global workflow '${parsed.name}' to ${written.path}.`
          : `Saved the workflow '${parsed.name}' to ${written.path}.`,
      `Run it with CreateWorkflow using \`saved: { name: "${parsed.name}" }\`.`,
    ].join(" "),
  } satisfies SaveWorkflowOutput;
};

/**
 * Decide whether “write this script to the repository” warrants interrupting the user.
 *
 * **No display**: everything for the dialog—the script, metadata, destination, and overwrite status—is already in normalized input.
 * New desktops render a rich confirmation block from input when `toolName === "SaveWorkflow"`; old desktops and legacy v3 receive a
 * generic permission prompt with complete input, degraded but complete across **all** version combinations. Adding a display kind
 * would make it readable only by new clients (see the comment in tool-result-metadata.ts).
 *
 * Let uncompileable scripts proceed to the handler, which returns diagnostics without writing to disk; nothing is being decided, so no dialog is needed.
 */
function prepareSaveWorkflowApproval(input: unknown): ToolApprovalGate {
  const parsed = SaveWorkflowInputSchema.safeParse(input);
  // After normalization, `script` must be present; if absent, a caller bypassed the lifecycle, so let the handler report the failure.
  if (!parsed.success || parsed.data.script === undefined) return { gate: "proceed" };
  return analyzeScript(parsed.data.script).ok ? { gate: "ask" } : { gate: "proceed" };
}

function formatSaveWorkflowModelContent(output: unknown): ModelMessageContent {
  const parsed = SaveWorkflowOutputSchema.safeParse(output);
  if (!parsed.success) return "SaveWorkflow returned an invalid result.";
  return parsed.data.response;
}

export const saveWorkflowToolEntry: ToolEntry = {
  capability:
    "Typecheck a dynamic-workflow script and, once confirmed, save it into the project as a reusable definition",
  metadata: {
    name: SAVE_WORKFLOW_TOOL_NAME,
    description: SAVE_WORKFLOW_TOOL_DESCRIPTION,
    readOnly: false,
    // Overwriting an existing definition replaces the copy on disk, but the confirmation dialog explains that first; same policy as Write.
    destructive: false,
    concurrentSafe: false,
    timeoutMs: SAVE_WORKFLOW_TIMEOUT_MS,
    maxOutputBytes: SAVE_WORKFLOW_MODEL_BYTES,
    // This writes a project file, so it uses the same scope as Write/Edit.
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: saveWorkflowHandler,
  validateInput: (input) => validateSaveWorkflowInput(input),
  // Put destination and overwrite state in input so the confirmation dialog and hook read the same facts, visible to all client versions.
  resolveInput: (input, context) =>
    // The skill gate precedes destination resolution (handlers/workflow-skill-gate.ts); this tool also saves a script.
    requireDynamicWorkflowSkill(context, SAVE_WORKFLOW_TOOL_NAME) ??
    resolveSaveWorkflowInput(input, context.workingDirectory ?? "."),
  prepareApproval: prepareSaveWorkflowApproval,
  inputSchema: SaveWorkflowInputJsonSchema,
  outputSchema: SaveWorkflowOutputJsonSchema,
  runtimeInputSchema: SaveWorkflowInputSchema,
  runtimeOutputSchema: SaveWorkflowOutputSchema,
  formatModelContent: formatSaveWorkflowModelContent,
  permission: {
    permission: "saveWorkflow",
    // For diagnostics only, not user-facing; the confirmation dialog renders a localized title itself.
    reason: "saveWorkflow.confirmation: user must confirm writing the workflow into the project",
    riskLevel: "medium",
    sideEffectScope: "workspace",
    needsApproval: true,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
    // Same policy as CreateWorkflow: repository content can be committed, seen by others, and run again later, so ask in every
    // permission mode, including yolo / plan.
    alwaysAsk: true,
    // Each call writes a different file and different content; persistent project rules cannot remember “this one decision” and would
    // only disable this confirmation permanently.
    askOptions: { allowAlways: false },
  },
  resultBudget: {
    maxInlineBytes: SAVE_WORKFLOW_MODEL_BYTES,
    maxModelBytes: SAVE_WORKFLOW_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: SAVE_WORKFLOW_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: SAVE_WORKFLOW_TIMEOUT_MS,
    maxMs: SAVE_WORKFLOW_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage: "SaveWorkflow typechecks and writes synchronously and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

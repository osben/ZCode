// ============================================================
// Skill gate for workflow authoring tools (docs/dynamic-workflow/authoring.md, “The authoring surface”).
// ============================================================
// On 2026-09-21, descriptions for the four authoring tools (CreateWorkflow / AmendWorkflow / SaveWorkflow / EvalWorkflowSnippet)
// were shortened to a few hundred tokens, moving the facade and writing rules into the `dynamic-workflows` skill. This saves
// about 19,000 tokens resent with every model request, but means the model might write a script without reading the skill. This gate
// makes reading the skill a prerequisite for submitting a script: if the session history has no successful
// `Skill(dynamic-workflows)` call, reject in resolveInput—before hooks and the confirmation dialog, so the model gets a business failure
// and the user never sees a confirmation dialog that cannot succeed.
//
// “Read” means **the history still visible to the model now** (runtime messageHistory), not a session-level flag:
// after compaction removes the skill text from context, its call is gone from history too, so the gate closes again and the model must reread it—
// the same semantics as Edit requiring Read (readFileState is also cleared after compaction). If the probe is absent (a session without a Skill
// tool, or a context constructed directly by a unit test), the gate does not apply; do not impose a prerequisite that cannot be satisfied.

import { DYNAMIC_WORKFLOW_SKILL_NAME } from "@zcode/contracts";
import type { ToolHandlerFailure, ToolInputResolutionContext } from "../types.js";

/**
 * Stable error code for “skill not loaded.” Keep it separate from the four tools' input-level 400 so callers can distinguish “bad
 * parameters” from “read the skill first” without inspecting text: the former requires changing parameters, the latter another Skill call.
 */
export const WORKFLOW_SKILL_NOT_LOADED_CODE = 428;

/** The gate's predicate; exported for reuse by the probe implementation and tests. */
export function isDynamicWorkflowSkillLoaded(context: ToolInputResolutionContext): boolean {
  return context.hasLoadedSkill?.(DYNAMIC_WORKFLOW_SKILL_NAME) ?? true;
}

/**
 * Reject if the skill has not been read. Return `undefined` to allow the call: the skill is loaded, or this session has no probe (see header).
 *
 * @param toolName Name the rejected tool in the message so the model knows which one to retry.
 */
export function requireDynamicWorkflowSkill(
  context: ToolInputResolutionContext,
  toolName: string,
): ToolHandlerFailure | undefined {
  if (isDynamicWorkflowSkillLoaded(context)) return undefined;
  return {
    result: false,
    errorCode: WORKFLOW_SKILL_NOT_LOADED_CODE,
    message: `${toolName} needs the \`${DYNAMIC_WORKFLOW_SKILL_NAME}\` skill loaded in this session before it accepts a script. Call the Skill tool with skill "${DYNAMIC_WORKFLOW_SKILL_NAME}" first — it carries the facade declarations the script is checked against, the authoring rules and this tool's full contract — then call ${toolName} again. Nothing was started.`,
  };
}

/** CreateWorkflow exception: running a saved workflow by name is not script authoring, so it does not require the skill. */
export function createWorkflowNeedsSkill(input: unknown): boolean {
  const fields = asRecord(input);
  if (fields === undefined) return true;
  const runsSavedOnly =
    fields.saved !== undefined && fields.script === undefined && fields.path === undefined;
  return !runsSavedOnly;
}

/** AmendWorkflow exception: a settings-only change (without `path` or `script`) reuses the predecessor's script and is not script authoring. */
export function amendWorkflowNeedsSkill(input: unknown): boolean {
  const fields = asRecord(input);
  if (fields === undefined) return true;
  return fields.script !== undefined || fields.path !== undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

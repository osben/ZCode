// Skill-loading check for workflow authoring tools.
// Keep the descriptions for CreateWorkflow, AmendWorkflow, SaveWorkflow, and EvalWorkflowSnippet short; the `dynamic-workflows` skill
// provides the facade and writing rules. Load the skill before submitting a script: when the session history has no successful
// `Skill(dynamic-workflows)` call, resolveInput rejects immediately before hooks or a pointless confirmation dialog.
//
// Determine this from messageHistory currently visible to the model. If compaction removes the skill text and its call, reload it;
// resume/rewind restore the condition with history, so no duplicate session state is needed.
// If the probe is absent, the current assembly does not provide skill-loading checks; do not impose an unmet precondition.

import { DYNAMIC_WORKFLOW_SKILL_NAME } from "@zcode/contracts";
import type { ToolHandlerFailure, ToolInputResolutionContext } from "../types.js";

/**
 * Stable error code for “skill not loaded.” Keep it separate from the four tools' input-level 400 so callers can distinguish “bad
 * parameters” from “read the skill first” without inspecting text: the former requires changing parameters, the latter another Skill call.
 */
export const WORKFLOW_SKILL_NOT_LOADED_CODE = 428;

/** Predicate used when the gate is present; exported separately for reuse by the probe. */
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

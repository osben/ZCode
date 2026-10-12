// ============================================================
// The two adjustable run settings in the confirmation window: pure rules
// ============================================================
// docs/dynamic-workflow/launch.md "Adjusting the settings in the window"; for appearance see
// docs/dynamic-workflow/presentation.md "The confirmation window".
//
// Same draft and same "what changed" judgment as the "configure" popover (workflowRunSettings.ts);
// only the entry point and exit differ: the entry reads **this invocation's input** (values normalized
// by the CLI's resolveInput), the exit is the Allow response's `content`, using the tool's own field
// names and tri-state — so the agent side needs only one parser (contracts'
// WorkflowSettingsAdjustmentSchema).

import {
  readWorkflowMaxConcurrency,
  readWorkflowSubagentModel,
} from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import {
  workflowRunSettingsChange,
  workflowRunSettingsModelOf,
  type WorkflowRunSettingsDraft,
} from "./workflowRunSettings.js";

/** The Allow response's `content`: only changed fields; `null` = back to default (session model / default concurrency). */
export interface WorkflowAskSettingsContent {
  subagent_model?: string | null;
  max_concurrency?: number | null;
}

/**
 * Entry point: the values from the input. No model means the session model; no upper bound means the
 * default concurrency ("no bound of its own" is that number on the stepper); when even the default is
 * unknown, null (the stepper stays empty; typing a number is what sets a bound).
 */
export function initialWorkflowAskSettingsDraft(
  input: unknown,
  defaultConcurrency: number | undefined,
): WorkflowRunSettingsDraft {
  return {
    model: workflowRunSettingsModelOf(readWorkflowSubagentModel(input)),
    bound: readWorkflowMaxConcurrency(input) ?? defaultConcurrency ?? null,
  };
}

/**
 * Exit: changed fields → response content; nothing changed means undefined (Allow keeps carrying only
 * the optionId). The rules are all the popover's: changing only the thinking level counts as changing
 * the model, an upper bound equal to the default concurrency sends `null` (above default is a real
 * number).
 */
export function workflowAskSettingsContent(
  initial: WorkflowRunSettingsDraft,
  draft: WorkflowRunSettingsDraft,
  defaultConcurrency: number | undefined,
): WorkflowAskSettingsContent | undefined {
  const change = workflowRunSettingsChange(initial, draft, defaultConcurrency);
  if (change === undefined) return undefined;
  return {
    ...(change.subagentModel === undefined ? {} : { subagent_model: change.subagentModel }),
    ...(change.maxConcurrency === undefined ? {} : { max_concurrency: change.maxConcurrency }),
  };
}

/** Which row changed (the changed row is bolded and carries "was …"). */
export function workflowAskSettingsChangedLines(
  initial: WorkflowRunSettingsDraft,
  draft: WorkflowRunSettingsDraft,
  defaultConcurrency: number | undefined,
): { model: boolean; bound: boolean } {
  const content = workflowAskSettingsContent(initial, draft, defaultConcurrency);
  return {
    model: content?.subagent_model !== undefined,
    bound: content?.max_concurrency !== undefined,
  };
}

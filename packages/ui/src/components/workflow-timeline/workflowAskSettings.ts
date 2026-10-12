// ============================================================
// The two adjustable run settings in the confirmation window: pure rules
// ============================================================
// docs/dynamic-workflow/launch.md "Adjusting the settings in the window"; see
// docs/dynamic-workflow/presentation.md "The confirmation window" for the appearance.
//
// Same draft and the same "what changed" judgment as the "configure" popover (workflowRunSettings.ts);
// the difference is only the starting point and the exit: the start reads **this call's input** (values
// normalized by the CLI's resolveInput), the exit is the Allow reply's `content`, using the tool's own
// field names and three states — so the agent side has exactly one parser (contracts'
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

/** The Allow reply's `content`: only changed fields; `null` = back to the default (session model / default concurrency). */
export interface WorkflowAskSettingsContent {
  subagent_model?: string | null;
  max_concurrency?: number | null;
}

/**
 * Starting point: the values in the input. Missing model means the session model; missing upper bound
 * means the default concurrency ("no bound of its own" is exactly that number on the stepper). If the
 * default is also unknown, null (the stepper stays empty; only typing a number sets a bound).
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
 * Exit: changed fields → reply content; nothing changed means undefined (Allow keeps carrying only
 * optionId). All the rules belong to the popover: changing only the thinking tier still counts as
 * changing the model; an upper bound equal to the default concurrency sends `null` (above the default
 * is a real number).
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

/** Which line changed (the changed line is bolded with a "was …" note). */
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

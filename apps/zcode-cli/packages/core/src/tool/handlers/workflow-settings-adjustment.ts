// ============================================================
// The two run settings adjustable in the confirmation dialog (shared by CreateWorkflow / AmendWorkflow).
// ============================================================
// docs/dynamic-workflow/launch.md「Adjusting the settings in the window」。
//
// One implementation for three tasks:
//   1. The `adjustable_settings` block populated by `resolveInput` (tells the dialog this agent will apply changes made there);
//   2. Apply changes from the response to input after approval (the executor calls this through `ToolEntry.applyInputAdjustments`);
//   3. The sentence in result copy saying the user adjusted settings in the dialog before approval.
//
// After applying the changes, input has exactly the shape produced by `resolveInput`—“a canonical form or none” and “a number or none”—so
// the handler, run port, and journal do not need to know that an adjustment happened; only the model-facing sentence does.

import {
  parseWorkflowSettingsAdjustment,
  type WorkflowAdjustableSettings,
  type WorkflowSettingsAdjustment,
} from "@zcode/contracts";
import type {
  ToolHandlerFailure,
  ToolInputAdjustmentResult,
  ToolInputResolutionContext,
  ToolInputResolutionResult,
} from "../types.js";
import { normalizeWorkflowMaxConcurrency } from "./create-workflow-source.js";
import { resolveModelReference } from "./model-reference.js";

/** Runtime schema parsed with safeParse (the strict input schema for both tools). */
interface WorkflowInputSchemaLike {
  safeParse(value: unknown): { success: boolean };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Populate the block only when the port is present—without a run port, there is no run for dialog changes to affect. The model field depends on the catalog port:
 * if the host cannot resolve model names, allow only the concurrency limit to change (failing after approval with “models cannot be selected here” would blame the user for a wiring gap).
 */
export function workflowAdjustableSettings(
  context: ToolInputResolutionContext,
): WorkflowAdjustableSettings | undefined {
  const port = context.dynamicWorkflowRunPort;
  if (port === undefined) return undefined;
  // The persisted key `concurrency_ceiling` predates the “default concurrency” concept and remains for compatibility with older clients; it now stores default
  // concurrency D—the stepper hint and the “equal to default means no per-run limit” predicate, not a ceiling.
  const defaultConcurrency = port.defaultConcurrency?.();
  return {
    subagent_model: context.modelCatalogPort !== undefined,
    ...(defaultConcurrency === undefined ? {} : { concurrency_ceiling: defaultConcurrency }),
  };
}

/**
 * Add the adjustment block to a successfully normalized result (always overwrite model-supplied values; fabricating them has no effect). `includeWhen` lets callers
 * exclude shapes that do not open a dialog—normalized in-place concurrency changes in AmendWorkflow have no script and therefore no confirmation dialog.
 */
export function withWorkflowAdjustableSettings(
  resolution: ToolInputResolutionResult,
  context: ToolInputResolutionContext,
  includeWhen: (input: Record<string, unknown>) => boolean = () => true,
): ToolInputResolutionResult {
  if (!resolution.result || !isPlainRecord(resolution.input)) return resolution;
  const { adjustable_settings: _forged, ...rest } = resolution.input;
  void _forged;
  const block = includeWhen(rest) ? workflowAdjustableSettings(context) : undefined;
  return {
    result: true,
    input: block === undefined ? rest : { ...rest, adjustable_settings: block },
  };
}

/** A model selected in the dialog cannot currently be resolved (deleted, disabled, or no catalog on the host): fail the whole call and start nothing. */
function adjustedModelFailure(errorCode: number, detail: string): ToolHandlerFailure {
  return {
    result: false,
    errorCode,
    message: `workflow_subagent_model_unresolved: the subagent model the user chose in the confirmation window cannot be used now. ${detail} Nothing was started; ask the user which model to use.`,
  };
}

/** A model was selected in the dialog despite there being no catalog: the block already says `subagent_model: false` on this host; this only guards clients that bypass it. */
const ADJUSTED_MODEL_WITHOUT_CATALOG = "This host cannot choose a subagent model.";

/**
 * Apply dialog changes to normalized input. The three states match the model-facing `AmendWorkflow` contract: string → resolve through the catalog to
 * canonical form (the dialog already sends canonical values, so this hits the first tier); `null` → remove the key (session model / default concurrency); number → round down
 * to at least 1, with no upper bound. A change identical to the original input is not applied (omitted from `applied`), so result copy does not report a no-op.
 */
export function applyWorkflowSettingsAdjustments(
  input: unknown,
  adjustments: Readonly<Record<string, unknown>>,
  context: ToolInputResolutionContext,
  options: { errorCode: number; schema: WorkflowInputSchemaLike },
): ToolInputAdjustmentResult {
  const adjustment = parseWorkflowSettingsAdjustment(adjustments);
  if (adjustment === undefined || !isPlainRecord(input)) return { result: true, input };
  const next: Record<string, unknown> = { ...input };
  const applied: WorkflowSettingsAdjustment = {};

  if (adjustment.subagent_model === null) {
    if (next.subagent_model !== undefined) applied.subagent_model = null;
    delete next.subagent_model;
  } else if (adjustment.subagent_model !== undefined) {
    const catalog = context.modelCatalogPort;
    if (catalog === undefined) {
      return adjustedModelFailure(options.errorCode, ADJUSTED_MODEL_WITHOUT_CATALOG);
    }
    const resolution = resolveModelReference(adjustment.subagent_model, catalog.listModels());
    if (!resolution.ok) return adjustedModelFailure(options.errorCode, resolution.message);
    if (next.subagent_model !== resolution.canonical) applied.subagent_model = resolution.canonical;
    next.subagent_model = resolution.canonical;
  }

  if (adjustment.max_concurrency === null) {
    if (next.max_concurrency !== undefined) applied.max_concurrency = null;
    delete next.max_concurrency;
  } else if (adjustment.max_concurrency !== undefined) {
    const bound = normalizeWorkflowMaxConcurrency(adjustment.max_concurrency);
    if (next.max_concurrency !== bound) applied.max_concurrency = bound;
    next.max_concurrency = bound;
  }

  // Final input must still pass the tool's runtime schema: handlers accept only that shape, with no separate path for adjustments.
  if (!options.schema.safeParse(next).success) {
    return {
      result: false,
      errorCode: options.errorCode,
      message:
        "workflow_settings_adjustment_invalid: the settings adjusted in the confirmation window did not produce a valid call. Nothing was started.",
    };
  }
  return Object.keys(applied).length === 0
    ? { result: true, input: next }
    : { result: true, input: next, applied };
}

/** Read `context.inputAdjustments` in the handler: the executor passes the `applied` value above; validate its shape once more here. */
export function readAppliedWorkflowSettings(
  inputAdjustments: Readonly<Record<string, unknown>> | undefined,
): WorkflowSettingsAdjustment {
  return parseWorkflowSettingsAdjustment(inputAdjustments) ?? {};
}

/**
 * Sentence in result copy (docs/dynamic-workflow/launch.md, “Adjusting the settings in the window”). The model's
 * `tool_use` block retains the parameters it supplied; without this, it may think those values took effect and even “correct” a run that is already using the user's choices.
 * Mention only the side that changed; there is a separate sentence for each `null`. Prefix with a space to append directly to the preceding sentence.
 */
export function describeWorkflowSettingsAdjustment(
  applied: WorkflowSettingsAdjustment,
  defaultConcurrency: number | undefined,
): string {
  const halves: string[] = [];
  if (applied.subagent_model === null) {
    halves.push("subagents are back on the session model");
  } else if (applied.subagent_model !== undefined) {
    halves.push(
      `subagents run on ${applied.subagent_model} (the main agent stays on the session model)`,
    );
  }
  if (applied.max_concurrency === null) {
    halves.push("the limit on subagents at once is back to the default");
  } else if (applied.max_concurrency !== undefined) {
    const subject =
      applied.max_concurrency === 1
        ? "1 subagent runs"
        : `${applied.max_concurrency} subagents run`;
    halves.push(
      `at most ${subject} at once${defaultConcurrency === undefined ? "" : ` (the default is ${defaultConcurrency})`}`,
    );
  }
  if (halves.length === 0) return "";
  return ` Before approving, the user adjusted the settings in the confirmation window: ${halves.join("; ")}.`;
}

/**
 * The three settings sentences in result copy: the adjustment sentence comes first, then use the usual sentence for any setting not adjusted (do not repeat
 * a setting already described by the adjustment sentence). Shared by both tools so the same event uses the same wording in both results.
 */
export function describeWorkflowRunSettings(options: {
  applied: WorkflowSettingsAdjustment;
  defaultConcurrency: number | undefined;
  describeLimit: () => string;
  describeModel: () => string;
  /**
   * Sentence for models named by the script (lists all bindings): the dialog cannot change them, so always include this sentence to let the model
   * paste each canonical ID unchanged into the next call.
   */
  describeScriptModels?: () => string;
}): string {
  const { applied, defaultConcurrency } = options;
  return [
    describeWorkflowSettingsAdjustment(applied, defaultConcurrency),
    applied.max_concurrency === undefined ? options.describeLimit() : "",
    applied.subagent_model === undefined ? options.describeModel() : "",
    options.describeScriptModels?.() ?? "",
  ].join("");
}

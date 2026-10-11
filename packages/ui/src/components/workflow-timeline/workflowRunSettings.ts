// ============================================================
// Pure rules for the “Settings” popover.
// ============================================================
// The popover component only renders and wires callbacks; all its decisions live here: which runs can be configured, where the form starts, what Apply sends,
// and what message a rejected ACK shows. Pure functions, no store access, each case can be enumerated.

import {
  WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX,
  workflowRunSettingsRejectionReasonSchema,
  type AmendWorkflowRunSettingsPayload,
  type CommandAck,
  type WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import { formatModelPickerValue, parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";

/** The session’s current model (source for the “Session model” option): prefer the session’s persisted sparse selection, falling back to the UI effective provider/model projection; absent if neither can be read. */
export function workflowSessionModelOf(
  config:
    | { modelSelection?: { providerId: string; modelId: string }; provider: string; model: string }
    | null
    | undefined,
): { providerId: string; modelId: string } | undefined {
  if (config === null || config === undefined) return undefined;
  const selection = config.modelSelection;
  if (selection !== undefined)
    return { providerId: selection.providerId, modelId: selection.modelId };
  const providerId = config.provider.trim();
  const modelId = config.model.trim();
  return providerId && modelId ? { providerId, modelId } : undefined;
}

/** Subagent model in the form: the session model or a specific model (optionally with a thinking level). */
export type WorkflowRunSettingsModel =
  | { kind: "session" }
  | { kind: "model"; providerId: string; modelId: string; level?: string };

/** The form's two settings. `bound: null` means this run has no custom ceiling and uses default concurrency. */
export interface WorkflowRunSettingsDraft {
  model: WorkflowRunSettingsModel;
  bound: number | null;
}

/** The portion of the Apply payload sent by the UI (the host supplies workId). */
export type WorkflowRunSettingsChange = Omit<AmendWorkflowRunSettingsPayload, "workId">;

/**
 * Which runs can be configured:
 * pending / running can (the primary concurrency/model-change cases); stopped can, unless replaced by a revision (its successor is the active one);
 * errored can (retrying with another model is the most common repair); completed cannot (each ask replays from cache, so nothing runs with new settings);
 * runs absent from the projection have no settings to display. The caller adds host callbacks and rollout gates separately.
 */
export function isWorkflowRunConfigurable(run: WorkflowRunState | undefined): boolean {
  if (run === undefined) return false;
  switch (run.status) {
    case "pending":
    case "running":
    case "errored":
      return true;
    case "stopped":
      return run.supersededBy === undefined && run.stopReason !== "superseded";
    case "completed":
      return false;
  }
}

/**
 * Default concurrency D (docs/dynamic-workflow/concurrency.md, “Protocol state”): read only
 * `run.concurrencyCeiling` (always included with `run-started`; the key predates the default-
 * concurrency concept). It is a starting point, not a ceiling: the stepper uses it to display
 * “Default N” and determine that matching the default means no custom ceiling. There is no upper bound.
 *
 * Root cause (user reported “local ceiling is 2”): when older CLIs did not send this value, the UI
 * fell back to `concurrency.ceiling` from the usage chip. That value is the highest cap observed;
 * if the shared bucket was throttled before this run started, it was a learned cap presented as
 * the local ceiling. Prefer showing that the default is unknown over misrepresenting a learned value.
 */
export function workflowRunDefaultConcurrency(run: WorkflowRunState): number | undefined {
  return run.concurrencyCeiling;
}

/** Canonical string → form model; leaving an invalid string unchanged does not make it a session model, so preserve it as an unresolved specific model. */
export function workflowRunSettingsModelOf(
  canonical: string | undefined,
): WorkflowRunSettingsModel {
  const text = canonical?.trim();
  if (!text) return { kind: "session" };
  try {
    const parsed = parseModelPickerValue(text);
    const level = parsed.options?.reasoningLevel;
    return {
      kind: "model",
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      ...(level === undefined ? {} : { level }),
    };
  } catch {
    return { kind: "model", providerId: "", modelId: text };
  }
}

/** Form model → canonical string `providerId/modelId[$level]`; the session model has no string (undefined). */
export function workflowRunSettingsModelCanonical(
  model: WorkflowRunSettingsModel,
): string | undefined {
  if (model.kind === "session") return undefined;
  if (model.providerId === "") return model.modelId;
  return formatModelPickerValue({
    providerId: model.providerId,
    modelId: model.modelId,
    ...(model.level === undefined ? {} : { options: { reasoningLevel: model.level } }),
  });
}

/** Initial values when opening the popover: both settings come from the run’s current values. If there is no run limit, use the ceiling (or null if it is also unknown). */
export function initialWorkflowRunSettingsDraft(run: WorkflowRunState): WorkflowRunSettingsDraft {
  const limit = run.concurrency?.limit;
  return {
    model: workflowRunSettingsModelOf(run.subagentModel),
    bound: limit ?? workflowRunDefaultConcurrency(run) ?? null,
  };
}

/** Normalize the ceiling: **equal to** the default means no custom ceiling; higher is a real value (the default is not a limit). */
function normalizedBound(
  bound: number | null,
  defaultConcurrency: number | undefined,
): number | null {
  if (bound === null) return null;
  return bound === defaultConcurrency ? null : bound;
}

/**
 * What Apply sends: include only the **changed** settings (same three-state convention as the tool: omitted = keep current value). Compare models by canonical string—
 * changing only the thinking level still counts as a model change; selecting the session model sends `null`. A limit equal to the ceiling sends `null` (remove the run’s own limit).
 * If neither changed, return undefined (Apply is disabled).
 */
export function workflowRunSettingsChange(
  initial: WorkflowRunSettingsDraft,
  draft: WorkflowRunSettingsDraft,
  defaultConcurrency: number | undefined,
): WorkflowRunSettingsChange | undefined {
  const change: WorkflowRunSettingsChange = {};
  const fromModel = workflowRunSettingsModelCanonical(initial.model);
  const toModel = workflowRunSettingsModelCanonical(draft.model);
  if (fromModel !== toModel) change.subagentModel = toModel ?? null;
  const fromBound = normalizedBound(initial.bound, defaultConcurrency);
  const toBound = normalizedBound(draft.bound, defaultConcurrency);
  if (fromBound !== toBound) change.maxConcurrency = toBound;
  return Object.keys(change).length === 0 ? undefined : change;
}

/** Clamp the stepper: floor to a minimum of 1, with no upper bound (default concurrency is a starting point, not a ceiling). */
export function clampWorkflowRunSettingsBound(value: number): number {
  return Math.max(1, Math.floor(value));
}

/**
 * Whether only the concurrency limit changed (`null` also counts as removing the run’s own limit). The payload must contain **only** this key—
 * matching the agent-side routing rule, which also recognizes only this payload shape; any extra field follows the existing revision path.
 */
function isConcurrencyOnlyChange(change: WorkflowRunSettingsChange | undefined): boolean {
  if (change === undefined) return false;
  return Object.keys(change).length === 1 && change.maxConcurrency !== undefined;
}

/**
 * Copy key for the consequence sentence; the last sentence varies by run state (completed does not reach this code).
 *
 * If nothing changed, return undefined (do not announce a consequence): Apply is disabled, so there
 * is no consequence to describe. Previously this used the run state to choose a fallback message;
 * for a running run it said “This will stop the current run,” even though changing only concurrency
 * does not stop it. Predicting consequences before a change risks getting one wrong.
 *
 * One exception: changing only the concurrency ceiling on a **running** run takes effect in place;
 * it neither stops nor restarts the run (docs/dynamic-workflow/concurrency.md). This is the one
 * case where “This will stop the current run” was wrong, so change the wording only here. `pending`
 * does not qualify: its engine may not exist yet, and if the change cannot be applied in place it
 * falls back to a real retune, where the original wording remains accurate.
 */
export function workflowRunSettingsConsequenceId(
  status: WorkflowRunState["status"],
  change: WorkflowRunSettingsChange | undefined,
): string | undefined {
  if (change === undefined) return undefined;
  if (status === "running" && isConcurrencyOnlyChange(change))
    return "chat.toolCall.workflow.run.settings.consequence.concurrencyLive";
  switch (status) {
    case "pending":
      return "chat.toolCall.workflow.run.settings.consequence.pending";
    case "stopped":
      return "chat.toolCall.workflow.run.settings.consequence.stopped";
    case "errored":
      return "chat.toolCall.workflow.run.settings.consequence.errored";
    default:
      return "chat.toolCall.workflow.run.settings.consequence.running";
  }
}

/** Same missing-capability fault used by Stop / Resume (gateway reasonCode for V4CapabilityUnsupportedError). */
const CAPABILITY_UNSUPPORTED_FAULT = "fault.command.capabilityUnsupported";
const KNOWN_REASONS: ReadonlySet<string> = new Set(
  workflowRunSettingsRejectionReasonSchema.options,
);

export interface WorkflowRunSettingsRejection {
  /** A reason in the vocabulary, or `unsupported` (capability missing) / `generic` (outside the vocabulary; copy includes the code). */
  reason: string;
  /** Original reasonCode (or ack.status when absent). */
  code: string;
  /** Human-readable detail from the ACK (bounded diagnostics for compile_failed; reason for start_failed). */
  message?: string;
}

/** accepted / noop are not rejections → undefined; otherwise, resolve the vocabulary from the fault prefix. */
export function describeWorkflowRunSettingsRejection(
  ack: Pick<CommandAck, "status" | "reasonCode" | "message">,
): WorkflowRunSettingsRejection | undefined {
  if (ack.status === "accepted" || ack.status === "noop") return undefined;
  const code = ack.reasonCode ?? ack.status;
  let reason = "generic";
  if (ack.reasonCode === CAPABILITY_UNSUPPORTED_FAULT) reason = "unsupported";
  else if (ack.reasonCode?.startsWith(WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX)) {
    const suffix = ack.reasonCode.slice(WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX.length);
    if (KNOWN_REASONS.has(suffix)) reason = suffix;
  }
  return { reason, code, ...(ack.message ? { message: ack.message } : {}) };
}

/** Copy key: `chat.toolCall.workflow.run.settings.rejection.<reason>`. */
export function workflowRunSettingsRejectionMessageId(
  rejection: WorkflowRunSettingsRejection,
): string {
  return `chat.toolCall.workflow.run.settings.rejection.${rejection.reason}`;
}

/**
 * Whether to show a details block: start_failed already embeds its reason in the sentence (`{message}`), so do not repeat it;
 * other rejections with a message (compile_failed diagnostics) go in a bounded monospaced block.
 */
export function workflowRunSettingsRejectionDetail(
  rejection: WorkflowRunSettingsRejection,
): string | undefined {
  return rejection.reason === "start_failed" ? undefined : rejection.message;
}

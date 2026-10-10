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

/** The two settings in the form. A null `bound` means “this run has no limit of its own” (it uses the local machine ceiling). */
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
 * Local concurrency ceiling: prefer `run.concurrencyCeiling` (included in `run-started`, always present); for older CLIs that omit it, fall back to
 * the ceiling shown by the concurrency chip, `concurrency.ceiling`. If neither exists, the ceiling is unknown—the stepper has no upper bound and shows no hint.
 */
export function workflowRunSettingsCeiling(run: WorkflowRunState): number | undefined {
  return run.concurrencyCeiling ?? run.concurrency?.ceiling;
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
    bound: limit ?? workflowRunSettingsCeiling(run) ?? null,
  };
}

/** Normalize the limit: a value at or above the ceiling means “no limit of its own.” */
function normalizedBound(bound: number | null, ceiling: number | undefined): number | null {
  if (bound === null) return null;
  return ceiling !== undefined && bound >= ceiling ? null : bound;
}

/**
 * What Apply sends: include only the **changed** settings (same three-state convention as the tool: omitted = keep current value). Compare models by canonical string—
 * changing only the thinking level still counts as a model change; selecting the session model sends `null`. A limit equal to the ceiling sends `null` (remove the run’s own limit).
 * If neither changed, return undefined (Apply is disabled).
 */
export function workflowRunSettingsChange(
  initial: WorkflowRunSettingsDraft,
  draft: WorkflowRunSettingsDraft,
  ceiling: number | undefined,
): WorkflowRunSettingsChange | undefined {
  const change: WorkflowRunSettingsChange = {};
  const fromModel = workflowRunSettingsModelCanonical(initial.model);
  const toModel = workflowRunSettingsModelCanonical(draft.model);
  if (fromModel !== toModel) change.subagentModel = toModel ?? null;
  const fromBound = normalizedBound(initial.bound, ceiling);
  const toBound = normalizedBound(draft.bound, ceiling);
  if (fromBound !== toBound) change.maxConcurrency = toBound;
  return Object.keys(change).length === 0 ? undefined : change;
}

/** Clamp the stepper limit: minimum 1, maximum the ceiling (no maximum when unknown). */
export function clampWorkflowRunSettingsBound(value: number, ceiling: number | undefined): number {
  const floor = Math.max(1, Math.floor(value));
  return ceiling === undefined ? floor : Math.min(floor, ceiling);
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
 * For a **running** run, changing only the concurrency limit takes effect in place without stopping or starting another run,
 * so show the consequence of adjusting concurrency here. `pending` is excluded: its engine may not exist yet, and if the in-place change cannot be applied it falls back to a real revision, for which the original sentence is still accurate.
 */
export function workflowRunSettingsConsequenceId(
  status: WorkflowRunState["status"],
  change?: WorkflowRunSettingsChange,
): string {
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

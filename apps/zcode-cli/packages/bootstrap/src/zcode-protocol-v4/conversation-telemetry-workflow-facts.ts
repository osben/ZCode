// ============================================================
// Attribution facts for dynamic-workflow subagents (subagent token telemetry).
// ============================================================
// Derive `workflow.lifecycle` telemetry facts from the parent session's DynamicWorkflowRunProgress
// event, and only for two engine events: actor-created (link subagent, child session, and launch turn)
// and run-settled (terminal state for every subagent in the run). Do not emit for runs without
// `launchInputId` (launched before the upgrade): without an anchor, there is nowhere to attach the step.

import type { DynamicWorkflowRunProgressPayload } from "@zcode/contracts";
import {
  conversationTelemetryFactSchema,
  type ConversationTelemetryFact,
} from "@zcode/shared/zcode-protocol-v4";

const ACTOR_CREATED_EVENT_TYPE = "actor-created";
const RUN_SETTLED_EVENT_TYPE = "run-settled";
const RUN_STOPPED_ERROR_MESSAGE = "Workflow run stopped";

/** Run's three terminal states and stop reasons, from the same set as engine RunStatus / RunStopReason. */
type WorkflowRunSettledStatus = "completed" | "errored" | "stopped";
type WorkflowRunStopReason = "user" | "model" | "provider" | "interrupted" | "superseded";

/** Derived fields on the progress event envelope (attached by toProgressPayload; contract: DynamicWorkflowRunProgressPayload). */
interface WorkflowProgressDerivedFields {
  actorSessionId?: unknown;
  launchInputId?: unknown;
}

export function workflowLifecycleFactFromProgress(
  base: Record<string, unknown>,
  progress: DynamicWorkflowRunProgressPayload,
): ConversationTelemetryFact | null {
  const derived = progress as DynamicWorkflowRunProgressPayload & WorkflowProgressDerivedFields;
  const launchInputId = optionalString(derived.launchInputId);
  if (launchInputId === undefined) return null;
  const toolCallId = optionalString(progress.toolCallId);

  if (progress.eventType === ACTOR_CREATED_EVENT_TYPE) {
    const childSessionId = optionalString(derived.actorSessionId);
    const agentId = actorRefString(progress.payload.actor);
    if (childSessionId === undefined || agentId === undefined) return null;
    return conversationTelemetryFactSchema.parse({
      ...base,
      kind: "workflow.lifecycle",
      phase: "actor-spawned",
      // The anchor is sourceCommandId: attach the subagent step under the message for the turn that launched the run.
      sourceCommandId: launchInputId,
      runId: progress.runId,
      ...(toolCallId === undefined ? {} : { toolCallId }),
      agentId,
      childSessionId,
    });
  }

  if (progress.eventType === RUN_SETTLED_EVENT_TYPE) {
    const status = settledStatus(progress.payload.status);
    if (status === undefined) return null;
    const stopReason =
      status === "stopped" ? settledStopReason(progress.payload.stopReason) : undefined;
    // Preserve the engine event's original error: errored always includes error; stopped includes error
    // only for provider/interrupted reasons. User/model stops have no source text, so use fixed copy and
    // the reason to let the dashboard distinguish who stopped the run.
    const engineMessage = optionalString(errorRecord(progress.payload.error)?.message);
    const errorMessage =
      status === "completed"
        ? undefined
        : (engineMessage ?? (status === "stopped" ? stoppedMessage(stopReason) : undefined));
    return conversationTelemetryFactSchema.parse({
      ...base,
      kind: "workflow.lifecycle",
      phase: "run-settled",
      sourceCommandId: launchInputId,
      runId: progress.runId,
      ...(toolCallId === undefined ? {} : { toolCallId }),
      status,
      ...(stopReason === undefined ? {} : { stopReason }),
      ...(errorMessage === undefined ? {} : { errorMessage }),
    });
  }

  return null;
}

/** `siteId@ordinal`: same string as the DWF engine refToString (also used for the subagent label in the run sidebar). */
function actorRefString(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const ref = value as { siteId?: unknown; ordinal?: unknown };
  const siteId = optionalString(ref.siteId);
  if (siteId === undefined || typeof ref.ordinal !== "number" || !Number.isFinite(ref.ordinal)) {
    return undefined;
  }
  return `${siteId}@${ref.ordinal}`;
}

function settledStatus(value: unknown): WorkflowRunSettledStatus | undefined {
  return value === "completed" || value === "errored" || value === "stopped" ? value : undefined;
}

function settledStopReason(value: unknown): WorkflowRunStopReason | undefined {
  return value === "user" ||
    value === "model" ||
    value === "provider" ||
    value === "interrupted" ||
    value === "superseded"
    ? value
    : undefined;
}

function stoppedMessage(reason: WorkflowRunStopReason | undefined): string {
  return reason === undefined
    ? RUN_STOPPED_ERROR_MESSAGE
    : `${RUN_STOPPED_ERROR_MESSAGE} (${reason})`;
}

function errorRecord(value: unknown): { message?: unknown } | undefined {
  return typeof value === "object" && value !== null ? (value as { message?: unknown }) : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

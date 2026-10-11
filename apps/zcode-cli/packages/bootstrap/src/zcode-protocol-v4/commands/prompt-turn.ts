// Native prompt turn runner.
//
// Core admission only accepts input and creates a session-scoped reservation. This file no longer owns
// activeAbortController or waits for the projection commit. Any Core starting/active state after
// TurnStarted continues to block a second start for the same session.
import { type TurnBackgroundAttribution, type TurnInputIntentMetadata } from "@zcode/contracts";
import type { TurnAttachment } from "@zcode/core";
import type { ZCodeAutomationBotDeliveryTarget } from "@zcode/shared";
import type { SendInputOptions, SendInputResult } from "../../app/types.js";
import { runWithSessionResidencyFinalization } from "../../zcode-protocol/session-residency.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "./types.js";

export interface StartPromptTurnParamsBase {
  content: string;
/** v4 anchor: inputId=queryId=commandId (reconciled against authoritative sourceCommandId). */
  inputId: string;
  inputPresentation?: SendInputOptions["inputPresentation"];
/** Attachment command surface: AttachmentRef has been mapped to core TurnAttachment in the handler layer. */
  attachments?: TurnAttachment[];
  browserAmbientContext?: SendInputOptions["browserAmbientContext"];
  intent?: TurnInputIntentMetadata;
/** Single-execution constraint for standard Selection; does not rewrite Session Selection. */
  modelExecution?: SendInputOptions["modelExecution"];
  sharedContextRefs?: SendInputOptions["sharedContextRefs"];
  toolDisallowlist?: readonly string[];
  /** The current input must be preserved for a future independent turn; do not start it directly just because admission momentarily goes idle. */
  requireQueue?: boolean;
/** sendQueuedNow already holds the Core promotion lease, so this admission must occupy only an idle slot. */
  requireIdle?: boolean;
/** Stable callback address for an inbound Bot turn; exposed to CronCreate only during this turn. */
  botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
}

export type StartPromptTurnParams = StartPromptTurnParamsBase & TurnBackgroundAttribution;

export interface PromptTurnStartResult {
/** Core admission is complete; do not wait for TurnStarted or the projection commit. */
  turnStarted: Promise<void>;
/** The actual Core completion promise, used only for lifecycle cleanup; it is not part of the ACK boundary. */
  completion?: Promise<unknown>;
  admission: SendInputResult;
/** Compatibility for old callers; the initial ACK no longer depends on messageId. */
  messageId?: string;
}

export class V4PromptRejectedError extends Error {
  readonly turnStartUncertain = false;

  constructor(
    readonly reasonCode: "restoreWarning" | "activePrompt",
    message: string,
  ) {
    super(message);
    this.name = "V4PromptRejectedError";
  }
}

/** Legacy queue-promotion compatibility predicate: the new Core admission no longer produces an indeterminate projection-authority state. */
export function isPromptTurnStartUncertainFailure(_error: unknown): boolean {
  return false;
}

/**
 * The entry point performs only model/persistence preflight checks, then calls app -> Core admission.
 * When Core returns started, the background lifecycle waits for completion to clear turn attribution
 * and broadcast state; the RPC itself immediately returns the admission receipt.
 */
export async function startPromptTurn(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: StartPromptTurnParams,
): Promise<PromptTurnStartResult> {
  const usesExecutionSelection = params.modelExecution?.selectionScope === "execution";
  if (!usesExecutionSelection && record.restoreWarning) {
    // After an app restart, cold recovery may run before the provider registry is pushed. The record
    // then gets a one-time "model unresolved" warning; when the registry arrives, the runtime is
    // already usable, but nothing clears that flag, permanently rejecting sends until the user changes
    // models. Before the gate, re-evaluate through host capabilities: clear stale warnings if a usable
    // target exists, then let ensureModelReady validate the current selection. Do not switch models as
    // a fallback or clear the persisted selection here. If no model is usable or the host lacks support,
    // keep the rejection.
    if (host.hasUsableRuntimeModelTarget?.(record) === true) {
      host.logger?.info?.("v4 restoreWarning cleared by model catalog recovery", {
        sessionId: record.app.sessionId,
        warningType: record.restoreWarning.type,
      });
      record.restoreWarning = undefined;
    }
  }
  if (!usesExecutionSelection && record.restoreWarning) {
    throw new V4PromptRejectedError("restoreWarning", record.restoreWarning.message);
  }
  if (!usesExecutionSelection) {
    await host.ensureModelReady?.(record);
  }
  if (record.persistence === "deferred") record.persistence = "immediate";

  const previousAutomationId = record.activeAutomationId;
  const previousOffPeakTaskId = record.activeOffPeakTaskId;
  const previousBotDeliveryTarget = record.activeBotDeliveryTarget;
  const activeAutomationId = resolveTurnAutomationId(params);
  const activeOffPeakTaskId = resolveTurnOffPeakTaskId(params);
  const turnToolDisallowlist = buildTurnToolDisallowlist(
    params,
    activeAutomationId,
    activeOffPeakTaskId,
  );
  if (activeAutomationId) record.activeAutomationId = activeAutomationId;
  if (activeOffPeakTaskId) {
    // Same marker for an off-peak dispatch turn, so offpeak-port can reject recursive OffPeakCreate before tool execution.
    record.activeOffPeakTaskId = activeOffPeakTaskId;
  }
  record.activeBotDeliveryTarget = params.botDeliveryTarget;

  let admission: SendInputResult;
  try {
    admission = await record.app.sendInput(
      {
        text: params.content,
        ...(params.attachments ? { attachments: params.attachments } : {}),
      },
      {
        // The Bootstrap controller used to represent Core busy state and was cleared by the projection
        // watchdog. Core admission now owns the reservation, and Stop calls Core execution directly.
        delivery: "start_turn",
        ...(params.intent?.requestedDelivery === "guide"
          ? { queueDelivery: "guide" as const }
          : {}),
        ...(params.browserAmbientContext
          ? { browserAmbientContext: params.browserAmbientContext }
          : {}),
        inputId: params.inputId,
        ...(params.inputPresentation ? { inputPresentation: params.inputPresentation } : {}),
        ...turnBackgroundAttributionOf({
          automationId: activeAutomationId,
          // Attribute using the resolved id: even when the resume path falls back to the inputId prefix, it must enter core loop state.
          offPeakTaskId: activeOffPeakTaskId,
          offPeakRunType: params.offPeakRunType,
        }),
        intent: params.intent,
        ...(params.modelExecution ? { modelExecution: params.modelExecution } : {}),
        ...(params.sharedContextRefs ? { sharedContextRefs: params.sharedContextRefs } : {}),
        ...(turnToolDisallowlist ? { toolDisallowlist: turnToolDisallowlist } : {}),
        ...(params.requireQueue ? { requireQueue: true } : {}),
        ...(params.requireIdle ? { requireIdle: true } : {}),
        queryId: params.inputId as SendInputOptions["queryId"],
      },
    );
  } catch (error) {
    clearPromptRecordState(
      record,
      previousAutomationId,
      previousOffPeakTaskId,
      previousBotDeliveryTarget,
    );
    await host.afterLegacyStateMutation?.(record, "prompt_failed");
    throw error;
  }

  if (admission.kind === "rejected") {
    clearPromptRecordState(
      record,
      previousAutomationId,
      previousOffPeakTaskId,
      previousBotDeliveryTarget,
    );
    throw new V4PromptRejectedError(
      "activePrompt",
      `Core prompt admission rejected: ${admission.reason}`,
    );
  }

  if (admission.kind === "queued") {
    clearPromptRecordState(
      record,
      previousAutomationId,
      previousOffPeakTaskId,
      previousBotDeliveryTarget,
    );
    return { admission, turnStarted: Promise.resolve() };
  }

  const completion = runWithSessionResidencyFinalization(record, async () => {
    let mutationReason = "prompt_completed";
    try {
      await admission.completion;
    } catch (error) {
      mutationReason = "prompt_failed";
      host.logger?.warn?.("v4 background turn failed", {
        error: error instanceof Error ? error.message : String(error),
        inputId: params.inputId,
        sessionId: record.app.sessionId,
      });
    } finally {
      clearPromptRecordState(
        record,
        previousAutomationId,
        previousOffPeakTaskId,
        previousBotDeliveryTarget,
      );
      await host.afterLegacyStateMutation?.(record, mutationReason);
    }
  });
  void completion.catch(() => undefined);
  host.logger?.info?.("v4 prompt admitted", {
    attachmentCount: params.attachments?.length ?? 0,
    inputId: params.inputId,
    sessionId: record.app.sessionId,
    textLength: params.content.length,
  });
  return { admission, completion, turnStarted: Promise.resolve() };
}

function clearPromptRecordState(
  record: V4SessionRecordView,
  previousAutomationId: string | undefined,
  previousOffPeakTaskId: string | undefined,
  previousBotDeliveryTarget: V4SessionRecordView["activeBotDeliveryTarget"],
): void {
  record.activeAutomationId = previousAutomationId;
  // Restore Off-Peak turn identity with the same rules as automation so stale state from another
  // turn does not incorrectly reject OffPeakCreate.
  record.activeOffPeakTaskId = previousOffPeakTaskId;
  record.activeBotDeliveryTarget = previousBotDeliveryTarget;
}

export function buildTurnToolDisallowlist(
  params: Pick<StartPromptTurnParams, "automationId" | "offPeakTaskId" | "toolDisallowlist">,
  activeAutomationId = params.automationId,
  activeOffPeakTaskId = params.offPeakTaskId,
): readonly string[] | undefined {
  const tools = new Set(params.toolDisallowlist ?? []);
  if (activeAutomationId) {
    // If automation dispatch omits its identity, a later model step will expose Cron write tools
    // again.
    for (const toolName of AUTOMATION_MUTATION_TOOL_NAMES) tools.add(toolName);
  }
  if (activeOffPeakTaskId) {
    // Hide OffPeakCreate during an Off-Peak dispatch turn to prevent recursive self-generation;
    // keep the read-only OffPeakList available.
    // Do not hide it during an automation turn: Cron turns allow OffPeakCreate to schedule an
    // Off-Peak task.
    for (const toolName of OFF_PEAK_MUTATION_TOOL_NAMES) tools.add(toolName);
  }
  return tools.size > 0 ? [...tools] : undefined;
}

export function resolveTurnAutomationId(
  params: Pick<StartPromptTurnParams, "automationId" | "inputId">,
): string | undefined {
  const explicit = params.automationId?.trim();
  if (explicit) return explicit;
  const inputId = params.inputId.trim();
  if (!inputId.startsWith(AUTOMATION_INPUT_ID_PREFIX)) return undefined;
  const separatorIndex = inputId.indexOf(":");
  const automationId = separatorIndex >= 0 ? inputId.slice(0, separatorIndex) : inputId;
  return automationId.length > AUTOMATION_INPUT_ID_PREFIX.length ? automationId : undefined;
}

export function resolveTurnOffPeakTaskId(
  params: Pick<StartPromptTurnParams, "offPeakTaskId" | "inputId">,
): string | undefined {
  const explicit = params.offPeakTaskId?.trim();
  if (explicit) return explicit;
  // Fallback: a resumed dispatch uses an inputId like `offpeak-<uuid>:resume:<uuid>`, while the
  // first dispatch has no fixed prefix. The primary signal must be an explicit offPeakTaskId
  // (Host dispatch always passes it explicitly).
  const inputId = params.inputId.trim();
  if (!inputId.startsWith(OFF_PEAK_INPUT_ID_PREFIX)) return undefined;
  const separatorIndex = inputId.indexOf(":");
  const offPeakTaskId = separatorIndex >= 0 ? inputId.slice(0, separatorIndex) : inputId;
  return offPeakTaskId.length > OFF_PEAK_INPUT_ID_PREFIX.length ? offPeakTaskId : undefined;
}

export function turnBackgroundAttributionOf(params: {
  automationId?: string;
  offPeakTaskId?: string;
  offPeakRunType?: "init" | "resume";
}): TurnBackgroundAttribution {
  if (params.automationId) return { automationId: params.automationId };
  if (params.offPeakTaskId) {
    return {
      offPeakTaskId: params.offPeakTaskId,
      ...(params.offPeakRunType ? { offPeakRunType: params.offPeakRunType } : {}),
    };
  }
  return {};
}

const AUTOMATION_INPUT_ID_PREFIX = "automation-";
const AUTOMATION_MUTATION_TOOL_NAMES = ["CronCreate", "CronUpdate", "CronDelete"] as const;
// Keep this separate; never merge it into AUTOMATION_MUTATION_TOOL_NAMES (Cron turns allow
// OffPeakCreate).
// Use the same value as core turn-loop-state: Off-Peak turns also hide SendMessage / Workflow,
// since both can restart a subagent outside this turn's modelExecution.
const OFF_PEAK_INPUT_ID_PREFIX = "offpeak-";
const OFF_PEAK_MUTATION_TOOL_NAMES = ["OffPeakCreate", "SendMessage", "Workflow"] as const;

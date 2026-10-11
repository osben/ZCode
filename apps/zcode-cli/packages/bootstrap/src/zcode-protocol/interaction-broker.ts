import { randomUUID } from "node:crypto";
import { raceClientRequestWithV4Interaction } from "./interaction-response-race.js";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  CoreErrorType,
  createCoreError,
  AskUserQuestionInputSchema,
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION,
  SessionEventType,
  createEventId,
  type AskUserQuestion,
  type McpElicitationRequest,
  type McpElicitationResult,
  type PermissionBrokerPort,
  type PermissionBrokerRequest,
  type PermissionBrokerRequestOptions,
  type PermissionBrokerResult,
  type SessionEvent,
} from "@zcode/contracts";
import {
  MCP_ELICITATION_INTERACTION,
  MCP_ELICITATION_TOOL_NAME,
  mcpElicitationContentFromAnswers,
  mcpElicitationQuestions,
} from "../zcode-protocol-v4/mcp-elicitation.js";
import {
  WORKFLOW_REFINE_PERMISSION_OPTION_ID,
  zcodePermissionResponseSchema,
  zcodeProtocolMethods,
  zcodeUserInputResponseSchema,
  type ZCodePermissionOption,
  type ZCodePermissionResponse,
  type ZCodeUserInputQuestion,
  type ZCodeUserInputResponse,
} from "@zcode/shared";
import type {
  V4InteractionAnswer,
  V4InteractionRegistrationOptions,
} from "../zcode-protocol-v4/interaction-registry.js";
import {
  PROTOCOL_CLIENT_REQUEST_ERROR_CODES,
  ProtocolRequestError,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";
import {
  buildProtocolPermissionOptions,
  buildSessionPermissionUpdates,
  SESSION_ALLOW_PERMISSION_OPTION_KIND,
  toLegacyPermissionOptionsPolicy,
  buildPermissionDeniedContent,
  PERMISSION_DENIED_BY_USER_CONTENT,
} from "./permission-options.js";
import { withWorkflowSettingsAdjustment } from "./workflow-settings-answer.js";

const EXIT_PLAN_MODE_APPROVAL_QUESTION = "Review this implementation plan.";
const EXIT_PLAN_MODE_APPROVAL_APPROVE = "approve";
const INTERACTION_REQUEST_REANNOUNCE_INTERVAL_MS = 1_000;

interface RegisteredRequestOptions extends PermissionBrokerRequestOptions {
  onRegistered?: () => void;
}

export function createProtocolInteractionBroker(
  context: ZCodeProtocolAgentServerContext,
): PermissionBrokerPort {
  return {
    requestPermission(request, options) {
      const ready = Promise.withResolvers<void>();
      const registeredOptions = { ...options, onRegistered: () => ready.resolve() };
      const requestResult =
        request.toolName === ASK_USER_QUESTION_TOOL_NAME
          ? requestUserInput(context, request, registeredOptions)
          : request.toolName === EXIT_PLAN_MODE_TOOL_NAME
            ? requestExitPlanModeApproval(context, request, registeredOptions)
            : requestPermission(context, request, registeredOptions);
      const result = requestResult.catch((error: unknown) => {
        // Protocol errors are translated only in the adapter layer; core does not understand
        // transport error codes and must not treat infrastructure failures as user denials.
        if (request.mode === "guarded" && error instanceof ProtocolRequestError) {
          const type =
            error.code === PROTOCOL_CLIENT_REQUEST_ERROR_CODES.cancelled
              ? CoreErrorType.ToolCancelled
              : error.code === PROTOCOL_CLIENT_REQUEST_ERROR_CODES.timedOut
                ? CoreErrorType.PermissionTimeout
                : error.code === PROTOCOL_CLIENT_REQUEST_ERROR_CODES.noClientAttached
                  ? CoreErrorType.ConfigurationError
                  : CoreErrorType.ToolExecutionFailed;
          throw createCoreError(type, error.message, { cause: error, recoverable: true });
        }
        throw error;
      });
      void result.then(
        () => ready.resolve(),
        (error: unknown) => ready.reject(error),
      );
      // Legacy callers consume only result; they must not produce unhandled rejections when they
      // ignore the registration signal.
      void ready.promise.catch(() => {});
      return Object.assign(result, { registered: ready.promise });
    },
  };
}

async function requestPermission(
  context: ZCodeProtocolAgentServerContext,
  request: PermissionBrokerRequest,
  options?: RegisteredRequestOptions,
): Promise<PermissionBrokerResult> {
  const permissionOptions = buildProtocolPermissionOptions(request);
  // Options for v3 reverse RPCs: session-level approval is offered only in v4 (older desktop clients
  // return the raw response and do not understand session semantics).
  const legacyPermissionOptions = buildProtocolPermissionOptions({
    ...request,
    optionsPolicy: toLegacyPermissionOptionsPolicy(request.optionsPolicy),
  });
  const response = await raceClientRequestWithV4Interaction(
    context,
    request.requestId,
    options?.signal,
    (signal) =>
      context.requestClient(
        zcodeProtocolMethods.interactionRequestPermission,
        {
          input: request.input,
          reason: request.reason,
          requestId: request.requestId,
          riskLevel: request.riskLevel,
          sessionId: request.sessionId,
          ...(request.origin ? { origin: request.origin } : {}),
          options: legacyPermissionOptions,
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          turnId: request.turnId,
        },
        zcodePermissionResponseSchema,
        withInteractionRequestRecovery(options, signal),
      ),
    // v4 answer → ZCodePermissionResponse: optionId semantics come from the v4 reducer's synthesized
    // allowOnce/allowAlways/deny values (see product-projection onPermissionRequested).
    (answer) => {
      // Settings adjusted in the workflow confirmation window travel with the approval answer
      // (docs/dynamic-workflow/launch.md "Adjusting the settings in the window").
      const base = v4AnswerToPermissionResponse(answer, permissionOptions, request.toolName);
      const response = withWorkflowSettingsAdjustment(base, answer, request.toolName);
      return response.decision === "deny" && answer.freeText?.trim()
        ? { ...response, preserveReasonFormatting: true }
        : response;
    },
    {
      ...createInteractionRegistrationOptions(request, "other"),
      ...(request.approvalMode !== "user-once" && !request.origin &&
      !request.optionsPolicy &&
      options?.claimResponse &&
      context.deps?.sessionStore?.commitPermissionFullAccess
        ? {
            fullAccess: async () => {
              if (!options.claimResponse!()) throw new Error("Permission response already settled");
              options.signal?.throwIfAborted();
              const record = context.sessions.get(String(request.sessionId));
              if (!record) throw new Error("Permission session unavailable");
              const eventId = await record.app.runtime.grantPermissionFullAccess(
                request.requestId,
                options.signal,
              );
              await context.v4Gateway?.waitForPermissionGrantCommit(
                String(request.sessionId),
                eventId,
              );
            },
          }
        : {}),
    },
    options?.onRegistered,
  );
  return {
    ...response,
    // Compatibility: legacy clients may omit reason. An ordinary user denial must still tell the
    // model explicitly that the tool did not run; otherwise core falls back to the generic
    // `Permission denied for <tool>` and cannot prevent repeated bypass attempts.
    ...(response.decision === "deny" && !response.reason?.trim()
      ? { reason: PERMISSION_DENIED_BY_USER_CONTENT }
      : {}),
    resolvedAt: new Date(),
  };
}

/**
 * Map a v4 permission response: first match optionId exactly against options synthesized by
 * buildProtocolPermissionOptions (allow_project carries persistent permissionUpdates and must not
 * be lost). The projection's synthesized allowAlways is equivalent to allow_project. Fall back to
 * deny for unknown optionIds; for permissions, rejecting is safer than allowing an unknown response.
 *
 * workflow Refine: this option is synthesized only in the v4 projection and does not appear in the
 * legacy options list, so handle it before exact matching. Empty freeText or a forged optionId from
 * a tool other than CreateWorkflow falls back to the existing deny behavior without reasonSource;
 * the channel that promotes feedback to a user message must be available only for real user input.
 */
function v4AnswerToPermissionResponse(
  answer: V4InteractionAnswer,
  permissionOptions: ZCodePermissionOption[],
  toolName: string,
): ZCodePermissionResponse & {
  reasonSource?: PermissionBrokerResult["reasonSource"];
  sessionPermissionUpdates?: PermissionBrokerResult["sessionPermissionUpdates"];
} {
  const refineFeedback = answer.freeText?.trim();
  if (
    (toolName === CREATE_WORKFLOW_TOOL_NAME || toolName === AMEND_WORKFLOW_TOOL_NAME) &&
    answer.optionId === WORKFLOW_REFINE_PERMISSION_OPTION_ID &&
    refineFeedback
  ) {
    return {
      decision: "deny",
      reason: refineFeedback,
      reasonSource: "workflow_refine_feedback",
    };
  }
  const exact = permissionOptions.find((option) => option.optionId === answer.optionId);
  if (exact) {
    if (exact.kind === "deny") {
      return { decision: "deny", reason: buildPermissionDeniedContent(answer.freeText) };
    }
    // Session-level approval semantics are synthesized here, not added to option.response; the wire
    // zcodePermissionUpdateSchema is strict, and an extra field would make older desktop clients drop the event.
    if (exact.kind === SESSION_ALLOW_PERMISSION_OPTION_KIND) {
      return {
        ...exact.response,
        sessionPermissionUpdates: buildSessionPermissionUpdates(toolName),
      };
    }
    return exact.response;
  }
  if (answer.optionId === "allowAlways") {
    const allowAlways = permissionOptions.find((option) => option.kind === "allow_always");
    if (allowAlways) {
      return allowAlways.response;
    }
  }
  if (answer.optionId === "allowOnce") {
    return { decision: "allow", reason: "Approved once" };
  }
  // deny/rejectOnce/rejectAlways, unknown optionIds, and missing optionIds all fall back to deny.
  return { decision: "deny", reason: buildPermissionDeniedContent(answer.freeText) };
}

/**
 * MCP elicitation: the server asks the user a question during tool execution.
 * Reuses AskUserQuestion's two channels — the legacy RPC interaction/requestUserInput and the v4
 * pending interaction — the latter advancing the projection through synthesized (non-persisted)
 * PermissionRequested / PermissionResolved events.
 */
export async function requestMcpElicitation(
  context: ZCodeProtocolAgentServerContext,
  request: McpElicitationRequest,
  options?: { signal?: AbortSignal },
): Promise<McpElicitationResult> {
  const sessionId = request.trace?.sessionId;
  const record = sessionId ? context.sessions?.get(sessionId) : undefined;
  if (!sessionId || !record) {
    // No running tool call to attribute the question to (e.g. the server asks while idle): decline
    // instead of guessing a session.
    return { action: "decline" };
  }
  const interactionId = `mcp-elicit-${randomUUID()}`;
  const toolCallId = request.trace?.toolCallId ?? interactionId;
  const questions = mcpElicitationQuestions(request.message, request.requestedSchema);
  const input = {
    serverName: request.serverName,
    message: request.message,
    requestedSchema: request.requestedSchema,
  };
  const traceId = request.trace?.traceId ?? String(record.traceContext.traceId);
  const ingestSynthetic = async (
    type: typeof SessionEventType.PermissionRequested | typeof SessionEventType.PermissionResolved,
    payload: Record<string, unknown>,
  ) => {
    const gateway = context.v4Gateway;
    if (!gateway) return;
    const event: SessionEvent = {
      id: createEventId(),
      sessionId: sessionId as never,
      ...(request.trace?.turnId ? { turnId: request.trace.turnId as never } : {}),
      type,
      timestamp: new Date(),
      traceId: traceId as never,
      // Live projection only, not persisted: raw seq is 0 so the v4 gateway assigns the transport
      // sequence number. Reusing persisted high-water +1 would make the second synthesized event
      // be dropped as a replay (seq not above the cursor), and the pending entry would never clear.
      sequenceNumber: 0,
      payload: payload as never,
    };
    gateway.ingest(sessionId, event);
  };
  await ingestSynthetic(SessionEventType.PermissionRequested, {
    requestId: interactionId,
    toolCallId,
    toolName: MCP_ELICITATION_TOOL_NAME,
    riskLevel: "low",
    reason: request.message,
    input,
  });
  let response: ZCodeUserInputResponse;
  try {
    response = await raceClientRequestWithV4Interaction(
      context,
      interactionId,
      options?.signal,
      (signal) =>
        context.requestClient(
          zcodeProtocolMethods.interactionRequestUserInput,
          {
            input,
            prompt: request.message,
            questions,
            requestId: interactionId,
            schema: {
              interaction: MCP_ELICITATION_INTERACTION,
              serverName: request.serverName,
              requestedSchema: request.requestedSchema,
            },
            sessionId,
            toolCallId,
            toolName: MCP_ELICITATION_TOOL_NAME,
            ...(request.trace?.turnId ? { turnId: request.trace.turnId } : {}),
          },
          zcodeUserInputResponseSchema,
          withInteractionRequestRecovery(options, signal),
        ),
      (answer) => v4AnswerToUserInputResponse(answer),
      { sessionId, kind: "other" },
    );
  } finally {
    await ingestSynthetic(SessionEventType.PermissionResolved, {
      requestId: interactionId,
      toolCallId,
      decision: "allow",
    }).catch(() => undefined);
  }
  if (response.action !== "accept") return { action: response.action };
  return {
    action: "accept",
    content: mcpElicitationContentFromAnswers(request.requestedSchema, questions, response.content),
  };
}

async function requestUserInput(
  context: ZCodeProtocolAgentServerContext,
  request: PermissionBrokerRequest,
  options?: RegisteredRequestOptions,
): Promise<PermissionBrokerResult> {
  const parsed = AskUserQuestionInputSchema.safeParse(request.input);
  if (!parsed.success) {
    return {
      decision: "deny",
      reason: `Invalid AskUserQuestion input: ${
        parsed.error.issues[0]?.message ?? "schema validation failed"
      }`,
      resolvedAt: new Date(),
    };
  }

  const initialAutoResolution = await readPersistedAutoResolution(context, request);

  const response = await raceClientRequestWithV4Interaction(
    context,
    request.requestId,
    options?.signal,
    (signal) =>
      context.requestClient(
        zcodeProtocolMethods.interactionRequestUserInput,
        {
          input: request.input,
          prompt: request.reason,
          questions: parsed.data.questions.map(mapAskUserQuestion),
          requestId: request.requestId,
          schema: { toolName: request.toolName },
          sessionId: request.sessionId,
          ...(request.origin ? { origin: request.origin } : {}),
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          turnId: request.turnId,
        },
        zcodeUserInputResponseSchema,
        withInteractionRequestRecovery(options, signal),
      ),
    // v4 answer for AskUserQuestion: freeText/optionId goes into the single-question answer slot
    // (the content.answer compatibility path in normalizeAskUserQuestionResponseContent); deny maps
    // to decline. Map multi-question cases precisely after the v4 projection models the userInput kind.
    (answer) => v4AnswerToUserInputResponse(answer),
    createInteractionRegistrationOptions(
      request,
      "askUserQuestion",
      context,
      initialAutoResolution,
    ),
    options?.onRegistered,
  );

  return userInputResponseToBrokerResult(request, response);
}

function v4AnswerToUserInputResponse(answer: V4InteractionAnswer): ZCodeUserInputResponse {
  // When answer.action is present (the host adapter's respondElicitation convergence path), pass it
  // through with the legacy respondUserInput semantics: content carries multi-question
  // answers/annotations, and normalizeAskUserQuestionResponseContent continues to enforce the schema.
  if (answer.action) {
    return answer.action === "accept"
      ? { action: "accept", content: answer.content ?? {} }
      : { action: answer.action };
  }
  const text = answer.freeText?.trim();
  if (text) {
    return { action: "accept", content: { answer: text } };
  }
  if (answer.optionId === "allowOnce" || answer.optionId === "allowAlways") {
    return { action: "accept", content: {} };
  }
  return { action: "decline" };
}

async function requestExitPlanModeApproval(
  context: ZCodeProtocolAgentServerContext,
  request: PermissionBrokerRequest,
  options?: RegisteredRequestOptions,
): Promise<PermissionBrokerResult> {
  const response = await raceClientRequestWithV4Interaction(
    context,
    request.requestId,
    options?.signal,
    (signal) =>
      context.requestClient(
        zcodeProtocolMethods.interactionRequestUserInput,
        {
          input: request.input,
          prompt: request.reason,
          questions: [createExitPlanModeApprovalQuestion()],
          requestId: request.requestId,
          schema: { interaction: "plan_approval", toolName: request.toolName },
          sessionId: request.sessionId,
          ...(request.origin ? { origin: request.origin } : {}),
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          turnId: request.turnId,
        },
        zcodeUserInputResponseSchema,
        withInteractionRequestRecovery(options, signal),
      ),
    // v4 answer for plan approval: allow-type optionId means approval; freeText is plan feedback
    // (planApprovalResponseToBrokerResult returns plan_approval_feedback deny); otherwise decline.
    (answer) => v4AnswerToPlanApprovalResponse(answer),
    createInteractionRegistrationOptions(request, "other"),
    options?.onRegistered,
  );

  return planApprovalResponseToBrokerResult(response);
}

function v4AnswerToPlanApprovalResponse(answer: V4InteractionAnswer): ZCodeUserInputResponse {
  // As in v4AnswerToUserInputResponse, pass action/content through the host adapter convergence path;
  // planApprovalResponseToBrokerResult continues to normalize approve/feedback.
  if (answer.action) {
    return answer.action === "accept"
      ? { action: "accept", content: answer.content ?? {} }
      : { action: answer.action };
  }
  if (answer.optionId === "allowOnce" || answer.optionId === "allowAlways") {
    return {
      action: "accept",
      content: { answer: EXIT_PLAN_MODE_APPROVAL_APPROVE },
    };
  }
  const feedback = answer.freeText?.trim();
  if (feedback) {
    return { action: "accept", content: { answer: feedback } };
  }
  return { action: "decline" };
}

function createExitPlanModeApprovalQuestion(): ZCodeUserInputQuestion {
  return {
    header: "Plan",
    options: [
      {
        description: "Exit plan mode and start implementation.",
        label: "Approve",
        value: EXIT_PLAN_MODE_APPROVAL_APPROVE,
      },
    ],
    question: EXIT_PLAN_MODE_APPROVAL_QUESTION,
  };
}

function withInteractionRequestRecovery(
  options: PermissionBrokerRequestOptions | undefined,
  signal: AbortSignal,
): PermissionBrokerRequestOptions & { reannounceIntervalMs: number } {
  return {
    ...options,
    // v4 race: the internal signal is already linked to outer options.signal (see
    // raceClientRequestWithV4Interaction); a winning v4 response uses it to cancel the pending reverse RPC.
    signal,
    // In desktop/recovery flows, the UI may restore a pending interaction only from the snapshot,
    // while the Host has lost its in-memory registration for the original protocol id. During the
    // wait for the user response, rediscover the protocol request by the same business requestId so
    // the Host can register a response-capable protocolRequestId again.
    reannounceIntervalMs: INTERACTION_REQUEST_REANNOUNCE_INTERVAL_MS,
  };
}

function mapAskUserQuestion(question: AskUserQuestion): ZCodeUserInputQuestion {
  return {
    header: question.header,
    multiSelect: question.multiSelect,
    options: question.options.map((option) => ({
      description: option.description,
      label: option.label,
      preview: option.preview,
      value: option.label,
    })),
    question: question.question,
  };
}

function userInputResponseToBrokerResult(
  request: PermissionBrokerRequest,
  response: ZCodeUserInputResponse,
): PermissionBrokerResult {
  if (response.action !== "accept") {
    return {
      decision: "deny",
      reason:
        response.reason ??
        (response.action === "cancel"
          ? "AskUserQuestion was cancelled"
          : "AskUserQuestion was declined"),
      resolvedAt: new Date(),
    };
  }

  const input = isRecord(request.input) ? request.input : {};
  const content = normalizeAskUserQuestionResponseContent(input, response.content);
  return {
    decision: "modify",
    modifiedInput: {
      ...input,
      ...content,
    },
    reason: response.reason,
    resolvedAt: new Date(),
  };
}

function planApprovalResponseToBrokerResult(
  response: ZCodeUserInputResponse,
): PermissionBrokerResult {
  if (response.action !== "accept") {
    return {
      decision: "deny",
      reason: response.reason,
      resolvedAt: new Date(),
    };
  }

  const answer = normalizePlanApprovalAnswer(response.content);
  if (answer === EXIT_PLAN_MODE_APPROVAL_APPROVE) {
    return {
      decision: "allow",
      reason: response.reason,
      resolvedAt: new Date(),
    };
  }

  if (!answer) {
    return {
      decision: "deny",
      reason: response.reason,
      resolvedAt: new Date(),
    };
  }

  return {
    decision: "deny",
    reason: answer,
    reasonSource: "plan_approval_feedback",
    resolvedAt: new Date(),
  };
}

function normalizePlanApprovalAnswer(
  content: Record<string, unknown> | undefined,
): string | undefined {
  if (!content) {
    return undefined;
  }
  const answers = isRecord(content.answers) ? content.answers : {};
  const answer = normalizeAnswerValue(
    answers[EXIT_PLAN_MODE_APPROVAL_QUESTION] ?? content.answer_0 ?? content.answer,
  )?.trim();
  return answer && answer.length > 0 ? answer : undefined;
}

function normalizeAskUserQuestionResponseContent(
  input: Record<string, unknown>,
  content: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!content) {
    return {};
  }

  const normalized: Record<string, unknown> = {};
  const answers = normalizeAskUserQuestionAnswers(input, content);
  if (answers) {
    normalized.answers = answers;
  }

  const annotations = normalizeAskUserQuestionAnnotations(content.annotations);
  if (annotations) {
    normalized.annotations = annotations;
  }

  // For compatibility with the old single-question path, the UI submits both answer_0 / answer.
  // AskUserQuestionInputSchema is strict; merging those legacy fields into tool input would trigger
  // "Tool input failed inputSchema validation", so keep only fields explicitly allowed by the schema.
  return normalized;
}

function normalizeAskUserQuestionAnswers(
  input: Record<string, unknown>,
  content: Record<string, unknown>,
): Record<string, string> | undefined {
  const questionTexts = readAskUserQuestionTexts(input);
  if (questionTexts.length === 0) {
    return undefined;
  }

  const rawAnswers = isRecord(content.answers) ? content.answers : {};
  const answers: Record<string, string> = {};
  questionTexts.forEach((questionText, index) => {
    const rawAnswer =
      rawAnswers[questionText] ??
      content[`answer_${index}`] ??
      (questionTexts.length === 1 ? content.answer : undefined);
    const answer = normalizeAnswerValue(rawAnswer);
    if (answer !== undefined) {
      answers[questionText] = answer;
    }
  });

  // action=accept + content.answers={} explicitly means the runtime should continue automatically.
  // Preserve the empty object to distinguish it from missing content (legacy client approved without providing an answer).
  if (isRecord(content.answers) && Object.keys(content.answers).length === 0) {
    return {};
  }
  return Object.keys(answers).length > 0 ? answers : undefined;
}

function createInteractionRegistrationOptions(
  request: PermissionBrokerRequest,
  kind: V4InteractionRegistrationOptions["kind"],
  context?: ZCodeProtocolAgentServerContext,
  initialAutoResolution?: V4InteractionRegistrationOptions["initialAutoResolution"],
): V4InteractionRegistrationOptions {
  return {
    sessionId: String(request.sessionId),
    kind,
    ...(initialAutoResolution ? { initialAutoResolution } : {}),
    ...(kind === "askUserQuestion" && context
      ? {
          onAutoResolutionUpdated: async (autoResolution) => {
            const record = context.sessions?.get(String(request.sessionId));
            if (!record) return;
            try {
              await record.app.runtime.recordUserInputAutoResolutionUpdate({
                interactionId: request.requestId,
                toolCallId: request.toolCallId,
                autoResolution,
                traceContext: {
                  ...record.traceContext,
                  traceId: request.traceId,
                  turnId: request.turnId,
                },
              });
            } catch (error) {
              context.logger?.error(
                "Failed to persist user input auto-resolution state",
                error instanceof Error ? error : new Error(String(error)),
                {
                  interactionId: request.requestId,
                  sessionId: request.sessionId,
                },
              );
            }
          },
        }
      : {}),
  };
}

async function readPersistedAutoResolution(
  context: ZCodeProtocolAgentServerContext,
  request: PermissionBrokerRequest,
): Promise<V4InteractionRegistrationOptions["initialAutoResolution"]> {
  const sessionStore = context.deps?.sessionStore;
  if (!sessionStore?.sessionEntries) return undefined;
  try {
    const entries = await sessionStore.sessionEntries({
      sessionID: request.sessionId,
      type: SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION,
    });
    const matching = entries
      .filter((entry) => {
        const data = isRecord(entry.data) ? entry.data : {};
        return (
          data.interactionId === request.requestId &&
          String(data.toolCallId ?? "") === String(request.toolCallId)
        );
      })
      .sort((left, right) => right.time.updated - left.time.updated)[0];
    if (!matching || !isRecord(matching.data)) return undefined;
    return parsePersistedAutoResolution(matching.data.autoResolution);
  } catch (error) {
    context.logger?.warn("Failed to restore user input auto-resolution state", {
      error: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.user_input_auto_resolution_restore_failed",
      interactionId: request.requestId,
      module: "bootstrap.zcode_protocol",
      sessionId: request.sessionId,
    });
    return undefined;
  }
}

function parsePersistedAutoResolution(
  value: unknown,
): V4InteractionRegistrationOptions["initialAutoResolution"] {
  if (!isRecord(value) || typeof value.startedAt !== "number") return undefined;
  if (
    (value.state === "hiddenGrace" || value.state === "visibleCountdown") &&
    typeof value.visibleAt === "number" &&
    typeof value.deadlineAt === "number"
  ) {
    return {
      state: value.state,
      startedAt: value.startedAt,
      visibleAt: value.visibleAt,
      deadlineAt: value.deadlineAt,
    };
  }
  if (value.state === "snoozed" && typeof value.snoozedAt === "number") {
    return {
      state: "snoozed",
      startedAt: value.startedAt,
      snoozedAt: value.snoozedAt,
    };
  }
  return undefined;
}

function readAskUserQuestionTexts(input: Record<string, unknown>): string[] {
  const questions = input.questions;
  if (!Array.isArray(questions)) {
    return [];
  }
  return questions
    .map((question) =>
      isRecord(question) && typeof question.question === "string" ? question.question : undefined,
    )
    .filter((question): question is string => question !== undefined);
}

function normalizeAnswerValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    // Older clients used an empty string to mean skip. Drop blank values consistently so core does
    // not treat them as user preferences when they enter answers. Trim surrounding whitespace from
    // non-empty answers at the protocol boundary too.
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0)
      .join(", ");
  }
  return undefined;
}

function normalizeAskUserQuestionAnnotations(
  value: unknown,
): Record<string, { preview?: string; notes?: string }> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value)
    .map(([question, annotation]) => {
      if (!isRecord(annotation)) {
        return undefined;
      }
      const normalizedAnnotation = {
        ...(typeof annotation.preview === "string" ? { preview: annotation.preview } : {}),
        ...(typeof annotation.notes === "string" ? { notes: annotation.notes } : {}),
      };
      return Object.keys(normalizedAnnotation).length > 0
        ? ([question, normalizedAnnotation] as const)
        : undefined;
    })
    .filter(
      (entry): entry is readonly [string, { preview?: string; notes?: string }] =>
        entry !== undefined,
    );

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

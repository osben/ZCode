/**
 * Build result-card displays for workflow tools: the five observation tools
 * (GetWorkflowRun / ListWorkflowRuns / EvalWorkflowSnippet / ListSavedWorkflows /
 * ListModels) plus the ResumeWorkflowRun recovery card.
 *
 * Keep these builders in a separate file instead of adding them to result-display.ts
 * (already 500 lines). They share one structure—safe-parse the output schema, apply a
 * separate display-side limit, and set truncated when over the limit. They are related
 * to createCreateWorkflowDisplay but form a distinct group.
 */

import {
  CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS,
  CREATE_WORKFLOW_DISPLAY_MAX_MESSAGE_CHARS,
  EVAL_WORKFLOW_SNIPPET_TOOL_NAME,
  EvalWorkflowSnippetOutputSchema,
  GET_WORKFLOW_RUN_TOOL_NAME,
  GetWorkflowRunOutputSchema,
  LIST_MODELS_TOOL_NAME,
  ListModelsOutputSchema,
  LIST_SAVED_WORKFLOWS_TOOL_NAME,
  ListSavedWorkflowsOutputSchema,
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  ListWorkflowRunsOutputSchema,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  ResumeWorkflowRunOutputSchema,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_ACTORS,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_MODELS,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_PHASES,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_RESULT_CHARS,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_SUBAGENTS,
  type GetWorkflowRunOutput,
  type GetWorkflowRunToolResultDisplayPayload,
  type ToolResultDisplayPayload,
} from "@zcode/contracts";

import { boundDisplayText } from "./display-text.js";

export function createWorkflowObservationDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  return (
    createGetWorkflowRunDisplay(toolName, output) ??
    createListWorkflowRunsDisplay(toolName, output) ??
    createEvalWorkflowSnippetDisplay(toolName, output) ??
    createSavedWorkflowListDisplay(toolName, output) ??
    createListModelsDisplay(toolName, output) ??
    createResumeWorkflowRunDisplay(toolName, output)
  );
}

function createGetWorkflowRunDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  if (toolName !== GET_WORKFLOW_RUN_TOOL_NAME) return undefined;
  const parsed = GetWorkflowRunOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;

  const data = parsed.data;
  let truncated = false;

  const actors = data.actors.slice(0, WORKFLOW_OBSERVATION_DISPLAY_MAX_ACTORS);
  if (actors.length < data.actors.length) truncated = true;

  // Keep the tail: logTail is valuable for the latest progress, so truncate the head.
  const droppedLogEntries = Math.max(0, data.logTail.length - WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES);
  const logTail = data.logTail
    .slice(-WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES)
    .map((entry) => {
      const bounded = boundDisplayText(entry.message, WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS);
      if (bounded.truncated) truncated = true;
      // Preserve `at` on the card when present: log age uses the same timestamp as the model-side `<log_tail>`.
      return {
        sequence: entry.sequence,
        message: bounded.value,
        ...(entry.at === undefined ? {} : { at: entry.at }),
      };
    });
  if (droppedLogEntries > 0) truncated = true;

  let result: string | undefined;
  if (data.result !== undefined) {
    const bounded = boundDisplayText(data.result, WORKFLOW_OBSERVATION_DISPLAY_MAX_RESULT_CHARS);
    if (bounded.truncated) truncated = true;
    result = bounded.value;
  }

  // Card errors contain only code / message. The output-side `providerStop` is a
  // model-channel diagnostic detail and stays in tool text/output. The renderer strictly
  // validates every frame against the mirror schema in packages/shared, so an extra
  // display key rejects the entire row. Passing data.error through unchanged once left
  // a desktop session stuck at fault.subscription.recoveryFailed. Since display also
  // persists in tool-part metadata, one bad payload would recur on every cold start.
  const error =
    data.error === undefined ? undefined : { code: data.error.code, message: data.error.message };

  // Situation snapshot: the phase list and roster each have a card-side limit because
  // display does not use the result budget. If either is cut, include it in the shared
  // truncated flag; the card should contain only rows actually displayed. These fields
  // are optional in the schema so persisted payloads from before situation snapshots
  // remain valid, but the builder **always populates them**. Optionality is for reading
  // old data, not for leaving gaps in new calls.
  const phases = data.phases?.slice(0, WORKFLOW_OBSERVATION_DISPLAY_MAX_PHASES);
  if (phases !== undefined && phases.length < data.phases!.length) truncated = true;
  const subagents = data.subagents.slice(0, WORKFLOW_OBSERVATION_DISPLAY_MAX_SUBAGENTS);
  if (subagents.length < data.subagents.length || data.subagentsTruncated === true) truncated = true;

  return {
    kind: "get_workflow_run",
    runId: data.runId,
    label: data.label,
    status: data.status,
    ...(data.stopReason === undefined ? {} : { stopReason: data.stopReason }),
    ...(data.possiblyInterrupted === true ? { possiblyInterrupted: true } : {}),
    summary: data.summary,
    generatedAt: data.generatedAt,
    usage: data.usage,
    ...(phases === undefined || phases.length === 0 ? {} : { phases }),
    subagents: subagents.map(toDisplaySubagent),
    health: data.health,
    actors,
    logTail,
    ...(result !== undefined ? { result } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * Flatten nested subagents from the tool-side representation into card rows. The
 * details in `currentAsk` form the latter part of each row. Free-form wait reasons are
 * omitted (the card only needs “waiting for a slot / backing off” and how much longer).
 * Other fields remain **absent when absent**: `0 tool calls` and “unknown” are different.
 */
function toDisplaySubagent(
  subagent: GetWorkflowRunOutput["subagents"][number],
): NonNullable<GetWorkflowRunToolResultDisplayPayload["subagents"]>[number] {
  const ask = subagent.currentAsk;
  return {
    siteId: subagent.siteId,
    ordinal: subagent.ordinal,
    ...(subagent.name === undefined ? {} : { name: subagent.name }),
    state: subagent.state,
    ...(subagent.phaseName === undefined ? {} : { phaseName: subagent.phaseName }),
    ...(ask?.instructionsHead === undefined ? {} : { instructionsHead: ask.instructionsHead }),
    ...(ask?.startedAt === undefined ? {} : { startedAt: ask.startedAt }),
    ...(ask?.turn === undefined ? {} : { turn: ask.turn }),
    ...(ask?.toolCalls === undefined ? {} : { toolCalls: ask.toolCalls }),
    ...(ask?.lastTool === undefined ? {} : { lastTool: ask.lastTool }),
    ...(subagent.wait === undefined
      ? {}
      : {
          waitCause: subagent.wait.cause,
          ...(subagent.wait.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: subagent.wait.retryAfterMs }),
          ...(subagent.wait.since === undefined ? {} : { waitSince: subagent.wait.since }),
        }),
    ...(subagent.parkedOn === undefined ? {} : { parkedOn: subagent.parkedOn }),
    stepsSettled: subagent.stepsSettled,
    stepsFailed: subagent.stepsFailed,
    tokens: subagent.tokens,
    ...(subagent.lastProgressAt === undefined ? {} : { lastProgressAt: subagent.lastProgressAt }),
  };
}

function createListWorkflowRunsDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  if (toolName !== LIST_WORKFLOW_RUNS_TOOL_NAME) return undefined;
  const parsed = ListWorkflowRunsOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;

  // All run-row fields are small numbers or already-bounded short text (label ≤ 80,
  // name ≤ 64), and limit is capped at 50. Pass them through; the output's own
  // truncated field expresses truncation.
  return {
    kind: "list_workflow_runs",
    runs: parsed.data.runs,
    ...(parsed.data.truncated === true ? { truncated: true } : {}),
  };
}

function createEvalWorkflowSnippetDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  if (toolName !== EVAL_WORKFLOW_SNIPPET_TOOL_NAME) return undefined;
  const parsed = EvalWorkflowSnippetOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;

  const data = parsed.data;
  let truncated = false;

  // Bound diagnostics like createCreateWorkflowDisplay: slice the count and truncate each message by character count.
  const diagnostics = data.diagnostics
    .slice(0, CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS)
    .map((diagnostic) => ({
      line: diagnostic.line,
      column: diagnostic.column,
      code: diagnostic.code,
      message: diagnostic.message.slice(0, CREATE_WORKFLOW_DISPLAY_MAX_MESSAGE_CHARS),
    }));
  if (diagnostics.length < data.diagnostics.length) truncated = true;

  // Keep the log tail: snippet logs are ordered by arrival, with the latest entries at the end.
  const droppedLogs = Math.max(0, data.logs.length - WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES);
  const logs = data.logs.slice(-WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES).map((entry) => {
    const bounded = boundDisplayText(entry, WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS);
    if (bounded.truncated) truncated = true;
    return bounded.value;
  });
  if (droppedLogs > 0) truncated = true;

  const boundedResponse = boundDisplayText(data.response, WORKFLOW_OBSERVATION_DISPLAY_MAX_RESULT_CHARS);
  if (boundedResponse.truncated) truncated = true;

  return {
    kind: "eval_workflow_snippet",
    ok: data.ok,
    diagnostics,
    logs,
    response: boundedResponse.value,
    durationMs: data.durationMs,
    ...(truncated ? { truncated: true } : {}),
  };
}

function createSavedWorkflowListDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  if (toolName !== LIST_SAVED_WORKFLOWS_TOOL_NAME) return undefined;
  const parsed = ListSavedWorkflowsOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;

  const data = parsed.data;
  let truncated = false;

  const boundMeta = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const bounded = boundDisplayText(value, WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS);
    if (bounded.truncated) truncated = true;
    return bounded.value;
  };

  const workflows = data.workflows.map((entry) => ({
    name: entry.name,
    description: boundMeta(entry.description),
    whenToUse: boundMeta(entry.whenToUse),
    scope: entry.scope,
    path: entry.path,
    // Keep only argument names: declaration details (type/description/default) belong in the save-approval dialog and are not repeated on the list card.
    argNames: entry.args === undefined ? [] : Object.keys(entry.args),
  }));

  const invalid = data.invalid?.map((entry) => ({
    path: entry.path,
    reason: boundMeta(entry.reason),
  }));

  return {
    kind: "saved_workflow_list",
    workflows,
    ...(invalid !== undefined && invalid.length > 0 ? { invalid } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * Result card for ListModels.
 *
 * Catalog rows contain only short ids and small numbers, so pass them through. The
 * registry's free-form providerLabel / disabledReason go through boundDisplayText. Cap
 * rows at 100: the tool's model channel has a 24k budget, but display has none, and a
 * machine with an aggregated provider could list thousands of rows. When rows are cut,
 * say “not all shown” without reporting a count; numbers on the catalog card should only
 * describe what it actually displays.
 */
function createListModelsDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  if (toolName !== LIST_MODELS_TOOL_NAME) return undefined;
  const parsed = ListModelsOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;

  const data = parsed.data;
  let truncated = false;

  const boundMeta = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const bounded = boundDisplayText(value, WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS);
    if (bounded.truncated) truncated = true;
    return bounded.value;
  };

  const models = data.models.slice(0, WORKFLOW_OBSERVATION_DISPLAY_MAX_MODELS).map((model) => {
    const providerLabel = boundMeta(model.providerLabel);
    const disabledReason = boundMeta(model.disabledReason);
    return {
      id: model.id,
      providerId: model.providerId,
      modelId: model.modelId,
      ...(providerLabel === undefined ? {} : { providerLabel }),
      reasoningLevels: [...model.reasoningLevels],
      ...(model.defaultReasoningLevel === undefined
        ? {}
        : { defaultReasoningLevel: model.defaultReasoningLevel }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(disabledReason === undefined ? {} : { disabledReason }),
    };
  });
  if (models.length < data.models.length) truncated = true;

  return {
    kind: "list_models",
    // Omit current when no catalog row is marked current (as in tool output, the session selection may point to a deleted provider).
    ...(data.current === undefined ? {} : { current: data.current }),
    models,
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * Result card for ResumeWorkflowRun. Keep the payload minimal ({runId}): the recovery
 * card only needs to convey which run continues in the background. Response guidance
 * belongs to the model channel, and the UI has its own localized vocabulary; there is no
 * unbounded text field and therefore no truncated state.
 */
function createResumeWorkflowRunDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  if (toolName !== RESUME_WORKFLOW_RUN_TOOL_NAME) return undefined;
  const parsed = ResumeWorkflowRunOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;
  return { kind: "resume_workflow_run", runId: parsed.data.runId };
}

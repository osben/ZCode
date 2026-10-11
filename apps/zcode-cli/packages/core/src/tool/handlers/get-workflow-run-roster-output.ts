// ============================================================
// Port situational snapshot → GetWorkflowRun output situational snapshot
// ============================================================
//
// The fields on both sides share names and meanings, but **still copy them field by field** instead of passing the object through:
// the output schema is strict, and a future extra port field would make the entire tool call fail runtimeOutputSchema validation.
// Field-by-field copying fixes “what the model can see” in one place, so port evolution cannot silently change it.
//
// For optional fields, always use `...(x === undefined ? {} : { x })`: explicit `undefined` and absence differ in `toEqual` and JSON
// serialization, while the model-facing contract is “if unknown, omit the key.”

import type {
  DynamicWorkflowRunHealth,
  DynamicWorkflowRunPhaseView,
  DynamicWorkflowRunSubagentAsk,
  DynamicWorkflowRunSubagentView,
  DynamicWorkflowRunSubagentWait,
  GetWorkflowRunHealth,
  GetWorkflowRunPhase,
  GetWorkflowRunSubagent,
  GetWorkflowRunSubagentAsk,
} from "@zcode/contracts";
import { GET_WORKFLOW_RUN_ROSTER_LIMITS } from "@zcode/contracts";

export function toGetWorkflowRunPhases(
  phases: readonly DynamicWorkflowRunPhaseView[] | undefined,
): GetWorkflowRunPhase[] | undefined {
  // If the script declared no phases and none were entered, omit the field entirely (an empty array reads as “the phase table is empty”).
  if (phases === undefined || phases.length === 0) return undefined;
  return phases.slice(0, GET_WORKFLOW_RUN_ROSTER_LIMITS.maxPhases).map((phase) => ({
    name: phase.name,
    state: phase.state,
    rounds: phase.rounds,
    nodesSettled: phase.nodesSettled,
    nodesRunning: phase.nodesRunning,
    ...(phase.enteredAt === undefined ? {} : { enteredAt: phase.enteredAt }),
    ...(phase.exitedAt === undefined ? {} : { exitedAt: phase.exitedAt }),
  }));
}

/**
 * Truncate the roster at {@link GET_WORKFLOW_RUN_ROSTER_LIMITS.maxSubagents} and state that it was truncated: silently dropping
 * several rows would read as “this run has only 64 subagents,” which is false.
 */
export function toGetWorkflowRunSubagents(subagents: readonly DynamicWorkflowRunSubagentView[]): {
  subagents: GetWorkflowRunSubagent[];
  truncated: boolean;
} {
  const kept = subagents.slice(0, GET_WORKFLOW_RUN_ROSTER_LIMITS.maxSubagents);
  return {
    subagents: kept.map((subagent) => ({
      siteId: subagent.siteId,
      ordinal: subagent.ordinal,
      ...(subagent.name === undefined ? {} : { name: subagent.name }),
      state: subagent.state,
      ...(subagent.phaseName === undefined ? {} : { phaseName: subagent.phaseName }),
      ...(subagent.currentAsk === undefined
        ? {}
        : { currentAsk: toCurrentAsk(subagent.currentAsk) }),
      ...(subagent.wait === undefined ? {} : { wait: toWait(subagent.wait) }),
      ...(subagent.parkedOn === undefined ? {} : { parkedOn: subagent.parkedOn }),
      stepsSettled: subagent.stepsSettled,
      stepsFailed: subagent.stepsFailed,
      tokens: subagent.tokens,
      ...(subagent.lastProgressAt === undefined ? {} : { lastProgressAt: subagent.lastProgressAt }),
    })),
    truncated: kept.length < subagents.length,
  };
}

function toCurrentAsk(ask: DynamicWorkflowRunSubagentAsk): GetWorkflowRunSubagentAsk {
  return {
    siteId: ask.siteId,
    ordinal: ask.ordinal,
    ...(ask.actorSeq === undefined ? {} : { actorSeq: ask.actorSeq }),
    ...(ask.instructionsHead === undefined ? {} : { instructionsHead: ask.instructionsHead }),
    ...(ask.startedAt === undefined ? {} : { startedAt: ask.startedAt }),
    // Missing turn / toolCalls means “unknown”; `0` means “no tools were called.” Older journals lack node-progress, so these must
    // remain distinguishable; never use `?? 0` here.
    ...(ask.turn === undefined ? {} : { turn: ask.turn }),
    ...(ask.toolCalls === undefined ? {} : { toolCalls: ask.toolCalls }),
    ...(ask.lastTool === undefined
      ? {}
      : {
          lastTool: {
            name: ask.lastTool.name,
            ...(ask.lastTool.target === undefined ? {} : { target: ask.lastTool.target }),
            ...(ask.lastTool.at === undefined ? {} : { at: ask.lastTool.at }),
          },
        }),
  };
}

function toWait(wait: DynamicWorkflowRunSubagentWait): NonNullable<GetWorkflowRunSubagent["wait"]> {
  return {
    cause: wait.cause,
    ...(wait.reason === undefined ? {} : { reason: wait.reason }),
    ...(wait.retryAfterMs === undefined ? {} : { retryAfterMs: wait.retryAfterMs }),
    ...(wait.since === undefined ? {} : { since: wait.since }),
  };
}

export function toGetWorkflowRunHealth(health: DynamicWorkflowRunHealth): GetWorkflowRunHealth {
  return {
    ...(health.lastProgressAt === undefined ? {} : { lastProgressAt: health.lastProgressAt }),
    ...(health.stalledSince === undefined ? {} : { stalledSince: health.stalledSince }),
    ...(health.concurrency === undefined
      ? {}
      : {
          concurrency: {
            effective: health.concurrency.effective,
            cap: health.concurrency.cap,
            ...(health.concurrency.reason === undefined
              ? {}
              : { reason: health.concurrency.reason }),
            ...(health.concurrency.since === undefined ? {} : { since: health.concurrency.since }),
          },
        }),
    consecutiveFailures: health.consecutiveFailures,
    cachedSteps: health.cachedSteps,
    // Omit when zero: terminal runs normally have no leftover rows, and `leftover_running=0` reads like something happened.
    ...(health.leftoverRunning === undefined || health.leftoverRunning === 0
      ? {}
      : { leftoverRunning: health.leftoverRunning }),
    pendingQuestionsKnown: health.pendingQuestionsKnown,
  };
}

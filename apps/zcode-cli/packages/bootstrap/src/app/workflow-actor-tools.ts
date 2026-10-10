// ============================================================
// Tool surface for workflow actors (AgentRuntime tool configuration).
// ============================================================
//
// The child runtime's tool registry must enforce the subagent tool surface; otherwise the judge actor in a real transcript also receives the full set of interactive tools. There are two risks:
//   1. Hanging: AskUserQuestion / EnterPlanMode have nobody to ask in a headless child, so the turn never ends.
//   2. Privilege escalation and recursion: CreateWorkflow lets an actor submit another workflow, and ReadSessionContext can read the parent session.
// This module provides the missing mapping, expanded by the driver-side runtime factory when creating AgentRuntime.
//
// Personas have no tool tiers: every actor gets the full work-tool set minus the exclusion list below.
// "The judge must not edit files" is stated in the ask text, as for ordinary subagents (Explore retains Bash and relies on the prompt for read-only behavior).

import {
  ASK_USER_QUESTION_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  READ_SESSION_CONTEXT_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
} from "@zcode/contracts";

/** Tool-surface slice of AgentRuntimeConfig. */
interface WorkflowActorToolPolicy {
  toolDisallowlist: readonly string[];
}

/**
 * Tools excluded from the full set: the first three block waiting for a human who does not exist (no one can answer in a headless child, so the turn never ends);
 * CreateWorkflow lets an actor recursively submit workflows; ReadSessionContext reads outside the parent session.
 * All others (Bash / Edit / Write / search / web) remain enabled—the actor is meant to do work.
 */
const ACTOR_DISALLOWED_TOOLS: readonly string[] = [
  ASK_USER_QUESTION_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  "CreateWorkflow",
  // The amend entry point has the same nested-orchestration root cause as CreateWorkflow.
  "AmendWorkflow",
  READ_SESSION_CONTEXT_TOOL_NAME,
  // Subagents must not answer escalation questions for the main agent.
  // The root cause differs from the exclusions above: this is about **identity**, not hanging or unauthorized reads. Escalation exists to give the decision
  // to the party that created the workflow; letting another actor answer would quietly reduce it to persuasion between actors. Actors ask through `escalate` (always registered); only the main session answers.
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
];

/**
 * AgentRuntime tool configuration for workflow actors. Pure function expanded into
 * AgentRuntimeConfig by the driver-side runtime factory: it does not narrow the set, only removes interactive/meta tools that could hang or exceed authority.
 *
 * Covers built-in tools only; MCP / plugin filtering is handled in production wiring (at the same factory seam).
 */
export function workflowActorToolPolicy(): WorkflowActorToolPolicy {
  return { toolDisallowlist: ACTOR_DISALLOWED_TOOLS };
}

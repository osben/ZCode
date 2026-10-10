import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  RESPOND_TO_COORDINATOR_TOOL_NAME,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  SAVE_WORKFLOW_TOOL_NAME,
} from "@zcode/contracts";
import { EXPLORE_AGENT_ALLOWED_TOOLS } from "../../subagent/explore-tools.js";
import type { AgentRuntimeConfig } from "../types.js";
import { normalizeToolNameAlias } from "../../tool/tool-visibility.js";

const EXPLORE_AGENT_ALLOWED_TOOL_SET = new Set<string>(EXPLORE_AGENT_ALLOWED_TOOLS);

/**
 * Tools additionally omitted from workflow child runtimes.
 *
 * Root cause: workflow children (`/workflow`, `/expert`, and script-workflow agent calls) are forced into yolo mode, and their
 * interaction events are mirrored to the parent session only through the subagent path (`runtime/methods/subagent.ts` is the only
 * `mirrorSubagentToolEvent` entry point). CreateWorkflow declares alwaysAsk, so a compilable script would request confirmation that
 * the parent UI cannot see and remain suspended until the permission timeout. Do not register this tool; the child then gets a clear
 * “tool unavailable” error instead of hanging invisibly.
 *
 * The long-term solution is to mirror workflow-child interaction events to the parent session along with the execution engine.
 */
const WORKFLOW_CHILD_DISALLOWED_TOOLS = [
  CREATE_WORKFLOW_TOOL_NAME,
  // AmendWorkflow shares CreateWorkflow's alwaysAsk gate and nested orchestration, so it is excluded for the same reason.
  AMEND_WORKFLOW_TOOL_NAME,
  // SaveWorkflow is excluded for the **same** reason: it also declares alwaysAsk, so a child would make an invisible confirmation
  // request and hang until timeout. ListSavedWorkflows is not excluded; the no-dialog rationale does not apply to read-only queries,
  // just as it does not apply to the two run introspection tools.
  SAVE_WORKFLOW_TOOL_NAME,
  // **Structurally disabled**: children must not orchestrate another workflow. Resume re-executes the full script (replay settled
  // nodes, redispatch unfinished ones), which is the same capability level as starting with CreateWorkflow. Even if removing the
  // confirmation dialog solved the “no dialog available” issue, nested orchestration (a child starting or reviving a run) remains closed.
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  // ResolveWorkflowQuestion and ResumeWorkflowRun are also **structurally disabled**, but protect a different invariant: escalation
  // means “the actor asks, and the party that created the workflow answers.” Letting a child answer would quietly turn “return the
  // decision to the party that can change the gate” into persuasion between actors; an actor blocked by the same gate is the least
  // qualified to decide.
  //
  // **Intentionally duplicated** with bootstrap's `ACTOR_DISALLOWED_TOOLS` (CreateWorkflow already follows this precedent): that
  // list removes tools from the driver-side persona toolset; this one applies to all workflow children by taskType, without relying on
  // the driver to remember to include it.
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
] as const;

/**
 * Final runtime tool denylist: turn-level `toolDisallowlist` plus structural exclusions derived from taskType.
 * Keep it here rather than at each child-runtime construction site; there are two construction sites (`workflow-facade.ts` and
 * `script-workflow-child-runtime.ts`), and their lists would inevitably drift.
 */
export function resolveRuntimeDisallowedTools(
  config: AgentRuntimeConfig,
): readonly string[] | undefined {
  if (config.taskType !== "workflow_child") return config.toolDisallowlist;

  const disallowed = new Set(config.toolDisallowlist ?? []);
  for (const toolName of WORKFLOW_CHILD_DISALLOWED_TOOLS) disallowed.add(toolName);
  return [...disallowed];
}

/**
 * Value of the dynamic-workflow switch passed to registerBuiltInTools.
 * **Absent means enabled**: TUI keeps the default toolset; headless explicitly sets true/false from --enable-workflow; protocol
 * sessions are controlled by the trusted Host; workflow_child inherits the parent configuration. Fail-closed defaults belong in the
 * headless entry point and protocol server's appRuntimePreferences, not here.
 *
 * Keep this alongside resolveRuntimeDisallowedTools rather than at call sites because there are **two** tool-registration entry
 * points (initial setup in helpers/runtime-tools.ts and branch refresh in methods/embedded-search-branch.ts). Both must use the same
 * rule, or a tool-list refresh could re-register disabled workflow tools.
 */
export function resolveRuntimeDynamicWorkflowToolsIncluded(config: AgentRuntimeConfig): boolean {
  return config.dynamicWorkflowEnabled !== false;
}

export function resolveBuiltInToolAllowlist(
  config: AgentRuntimeConfig,
): readonly string[] | undefined {
  const normalizedAllowlist = normalizeBuiltInToolAllowlist(config.toolAllowlist);

  if (config.toolset !== "explore") {
    return appendChildControlTool(config, normalizedAllowlist);
  }

  if (!normalizedAllowlist) {
    return appendChildControlTool(config, EXPLORE_AGENT_ALLOWED_TOOLS);
  }

  return appendChildControlTool(
    config,
    normalizedAllowlist.filter((toolName) => EXPLORE_AGENT_ALLOWED_TOOL_SET.has(toolName)),
  );
}

function appendChildControlTool(
  config: AgentRuntimeConfig,
  allowlist: readonly string[] | undefined,
): readonly string[] | undefined {
  if (!allowlist) {
    return allowlist;
  }

  if (config.taskType === "subagent_child") {
    if (allowlist.includes(RESPOND_TO_COORDINATOR_TOOL_NAME)) {
      return allowlist;
    }
    // Explore recomputes the tool intersection before runtime registration; restore child control tools in the final result.
    return [...allowlist, RESPOND_TO_COORDINATOR_TOOL_NAME];
  }

  // Workflow children do not narrow by allowlist (personas have no tool tiers; their toolset only shrinks, see bootstrap's
  // workflow-actor-tools.ts). submit_result / escalate are registered by includeSubmitResult / includeEscalate and need no restoration here.
  return allowlist;
}

function normalizeBuiltInToolAllowlist(
  allowlist: readonly string[] | undefined,
): readonly string[] | undefined {
  return allowlist?.map((toolName) => normalizeToolNameAlias(toolName));
}

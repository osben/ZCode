import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  FILL_WORKFLOW_HOLE_TOOL_NAME,
  GET_WORKFLOW_RUN_TOOL_NAME,
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  RESPOND_TO_COORDINATOR_TOOL_NAME,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  SAVE_WORKFLOW_TOOL_NAME,
  type SessionTaskType,
} from "@zcode/contracts";
import { incognitoExcludes } from "@zcode/shared";
import { EXPLORE_AGENT_ALLOWED_TOOLS } from "../../subagent/explore-tools.js";
import type { AgentRuntimeConfig } from "../types.js";
import type { DynamicWorkflowToolSurfaceDeferral } from "../../tool/types.js";
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
  // (the two run-introspection tools are excluded for a different root cause, see RUN_INTROSPECTION_TOOLS below).
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
  // FillWorkflowHole shares the same root cause as AmendWorkflow (alwaysAsk has no dialog to show in a child) and the same invariant
  // (a hole asks the **main agent** for code; a subagent must not fill it on its behalf), so include it in the list too.
  FILL_WORKFLOW_HOLE_TOOL_NAME,
] as const;

/**
 * Run-introspection tools not registered in child runtimes.
 *
 * The root cause differs from the list above: they are read-only and ungated, but they read through the dwf run
 * port, which exists only in the app's top-level runtime — child runtimes must not hold it by invariant
 * (`bootstrap/src/app/dynamic-workflow-run-progress-sink.ts`: if a child held it, runs started by child sessions
 * would sink events into the parent session's transcript). So in a child runtime they would only ever report
 * `workflow_introspection_unavailable` (production 2026-10-20: 155 workflow-child calls, all failed).
 * Not registering them keeps the model from calling a tool that can only fail.
 */
const RUN_INTROSPECTION_TOOLS = [LIST_WORKFLOW_RUNS_TOOL_NAME, GET_WORKFLOW_RUN_TOOL_NAME] as const;

/**
 * Child-runtime taskTypes that hold no dwf run port (docs/dynamic-workflow/launch.md, "workflow child sessions"),
 * and also have no `/workflow` command entry (see resolveRuntimeDynamicWorkflowToolSurfaceDeferral below).
 */
const CHILD_TASK_TYPES_WITHOUT_RUN_PORT: ReadonlySet<SessionTaskType> = new Set<SessionTaskType>([
  "subagent_child",
  "workflow_child",
  "nested_workflow_child",
]);

/**
  * Final runtime tool denylist: turn-level `toolDisallowlist` plus structural exclusions derived from taskType.
  * Keep it here rather than at each child-runtime construction site; there are two construction sites (`workflow-facade.ts` and
  * `script-workflow-child-runtime.ts`), and their lists would inevitably drift.
 */
export function resolveRuntimeDisallowedTools(
  config: AgentRuntimeConfig,
): readonly string[] | undefined {
  const structural = [
    ...(config.taskType === "workflow_child" ? WORKFLOW_CHILD_DISALLOWED_TOOLS : []),
    ...(config.taskType !== undefined && CHILD_TASK_TYPES_WITHOUT_RUN_PORT.has(config.taskType)
      ? RUN_INTROSPECTION_TOOLS
      : []),
  ];
  if (structural.length === 0) return config.toolDisallowlist;

  const disallowed = new Set(config.toolDisallowlist ?? []);
  for (const toolName of structural) disallowed.add(toolName);
  return [...disallowed];
}

/**
 * Value of the dynamic-workflow gradual rollout gate in registerBuiltInTools (docs/dynamic-workflow/launch.md, “Gray release”).
 * **Absent means enabled**: standalone CLI TUI and headless modes explicitly write true/false from --workflow-mode;
 * protocol sessions are controlled by the trusted Host, and workflow_child inherits its parent's configuration. The fail-closed default belongs in
 * appRuntimePreferences at the standalone CLI entry point and protocol server, not at this layer.
 *
 * Keep this alongside resolveRuntimeDisallowedTools rather than at call sites because there are **two** tool-registration entry
 * points (initial setup in helpers/runtime-tools.ts and branch refresh in methods/embedded-search-branch.ts). Both must use the same
 * rule, or a tool-list refresh could re-register disabled workflow tools.
 */
export function resolveRuntimeDynamicWorkflowToolsIncluded(runtime: {
  config: AgentRuntimeConfig;
  dynamicWorkflowToolsActivated: boolean;
}): boolean {
  // enabled ∧ (¬onDemand ∨ activated): activation state belongs to the runtime (launch.md, “On demand: activation”);
  // sessions that are not on-demand start activated, so alwaysOn / TUI / headless still depend only on enabled here.
  // The incognito automationTools toggle (specs/incognito-session.md) is part of the same gate, so both registration
  // entry points and the Agent/Task workflow guidance (which follows this value) stay consistent.
  return (
    runtime.config.dynamicWorkflowEnabled !== false &&
    runtime.dynamicWorkflowToolsActivated &&
    resolveRuntimeAutomationToolsIncluded(runtime.config)
  );
}

/**
 * `automationTools` toggle (specs/incognito-session.md): gates the Cron and OffPeak tools here and, through
 * resolveRuntimeDynamicWorkflowToolsIncluded, the dynamic-workflow tools. Absent profile means included.
 */
export function resolveRuntimeAutomationToolsIncluded(config: AgentRuntimeConfig): boolean {
  return !incognitoExcludes(config.incognito, "automationTools");
}

/**
 * Gate for the LSP tool (spec §7), shared by both registration entry points (initial setup and branch refresh).
 * Registered only when an LspService is wired and availability resolved true; it never follows the tool allowlist alone.
 */
export function resolveRuntimeLspToolIncluded(runtime: {
  lspService?: unknown;
  lspToolAvailable: boolean;
}): boolean {
  return runtime.lspService !== undefined && runtime.lspToolAvailable;
}

/**
 * 工作流工具面「开着、但本会话还没激活」时，本会话处在哪一种未激活形态（launch.md「On demand:
 * activation」）。只有 onDemand 会话在激活之前不是 "none"；disabled（技能本就不可发现）、alwaysOn、
 * 已激活都是 "none"。与上面的注册门读同一个 runtime 状态，不另存副本。
 *
 * 修复原因（评审 CR-01，两轮）：子 runtime 没有 `/workflow` 入口——命令只在顶层会话的输入门面展开，
 * 子 runtime 由父侧直接 `executeTurn` 驱动，父会话之后激活也不会改它的工具面。所以子 runtime 单独一档
 * "subagent"：给它的提示不能承诺「用户发 /workflow 之后工具会出现在本会话」。
 * 判据是「是不是子 runtime」，不是「是不是 Agent 子代理」：第一版只认 `subagent_child`，漏了 `/expert`
 * 的 `workflow_child`（bootstrap/src/app/workflow-facade.ts 整份展开父配置，onDemand 标记跟着过去，
 * 出生未激活），它被归成 "session"。这里复用上面那份子 runtime 名单，不另列一份。
 */
export function resolveRuntimeDynamicWorkflowToolSurfaceDeferral(runtime: {
  config: AgentRuntimeConfig;
  dynamicWorkflowToolsActivated: boolean;
}): DynamicWorkflowToolSurfaceDeferral {
  if (runtime.config.dynamicWorkflowEnabled === false || runtime.dynamicWorkflowToolsActivated) {
    return "none";
  }
  const taskType = runtime.config.taskType;
  return taskType !== undefined && CHILD_TASK_TYPES_WITHOUT_RUN_PORT.has(taskType)
    ? "subagent"
    : "session";
}

/**
 * Agent 是否总在后台运行（07-subagent.md「ZCode 当前实现」）。缺席即开启，只有显式 false 回到旧形态。
 * 与上面的灰度门同理收在这里：两个注册入口必须用同一规则，否则分支刷新会把 Agent 换成另一种形态。
 */
export function resolveRuntimeAgentAlwaysBackground(config: AgentRuntimeConfig): boolean {
  // 修复原因：workflow 子会话（/expert 节点）展开父配置，继承了缺省开启；它只读一次回合的回复，
  // 后台子代理之后的完成通知没有读取方，结果会丢。与结构性禁用同理按 taskType 定，不看开关。
  if (config.taskType === "workflow_child") return false;
  return config.subagents?.alwaysBackground !== false;
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

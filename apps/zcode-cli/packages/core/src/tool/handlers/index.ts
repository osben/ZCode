import { replyToChannelToolEntry } from "./reply-to-channel.js";
// ============================================================
// Built-in Tool Handlers
// ============================================================

import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  EVAL_WORKFLOW_SNIPPET_TOOL_NAME,
  FILL_WORKFLOW_HOLE_TOOL_NAME,
  GET_WORKFLOW_RUN_TOOL_NAME,
  LIST_MODELS_TOOL_NAME,
  LIST_SAVED_WORKFLOWS_TOOL_NAME,
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  SAVE_WORKFLOW_TOOL_NAME,
  SUBMIT_RESULT_TOOL_NAME,
  type JsonSchema,
} from "@zcode/contracts";
import type { ToolEntry } from "../types.js";
import { readToolEntry } from "./read.js";
import { writeToolEntry } from "./write.js";
import { editToolEntry } from "./edit.js";
import { bashToolEntry, createBashToolEntry } from "./bash.js";
import type { BashTimeoutPolicy } from "../bash-timeout-policy.js";
import { createJsToolEntry, jsToolEntry } from "./node-repl.js";
import { globToolEntry } from "./glob.js";
import { grepToolEntry } from "./grep.js";
import { lspToolEntry } from "./lsp.js";
import { webFetchToolEntry } from "./webfetch.js";
import { webSearchToolEntry } from "./websearch.js";
import {
  agentToolEntry,
  createAgentToolEntry,
  createTaskToolEntry,
  taskToolEntry,
} from "./agent.js";
import { isSubagentDispatchToolName } from "../compat.js";
import { skillToolEntry } from "./skill.js";
import { todoReadToolEntry, todoWriteToolEntry } from "./todo.js";
import {
  cronCreateToolEntry,
  cronDeleteToolEntry,
  cronListToolEntry,
  cronUpdateToolEntry,
} from "./cron.js";
import { offPeakCreateToolEntry, offPeakListToolEntry } from "./off-peak.js";
import {
  createEnterPlanModeToolEntry,
  enterPlanModeToolEntry,
  exitPlanModeToolEntry,
} from "./plan-mode.js";
import { askUserQuestionToolEntry } from "./ask-user-question.js";
import { sendMessageToolEntry } from "./send-message.js";
import { respondToCoordinatorToolEntry } from "./respond-to-coordinator.js";
import { createSubmitResultToolEntry, submitResultToolEntry } from "./submit-result.js";
import { escalateToolEntry } from "./escalate.js";
import { resolveWorkflowQuestionToolEntry } from "./resolve-workflow-question.js";
import { fillWorkflowHoleToolEntry } from "./fill-workflow-hole.js";
import { taskOutputToolEntry } from "./task-output.js";
import { taskStopToolEntry } from "./task-stop.js";
import { readSessionContextToolEntry } from "./read-session-context.js";
import { amendWorkflowToolEntry } from "./amend-workflow.js";
import { createWorkflowToolEntry } from "./create-workflow.js";
import { saveWorkflowToolEntry } from "./save-workflow.js";
import { listSavedWorkflowsToolEntry } from "./list-saved-workflows.js";
import { listModelsToolEntry } from "./list-models.js";
import { evalWorkflowSnippetToolEntry } from "./eval-workflow-snippet.js";
import { listWorkflowRunsToolEntry } from "./list-workflow-runs.js";
import { getWorkflowRunToolEntry } from "./get-workflow-run.js";
import { resumeWorkflowRunToolEntry } from "./resume-workflow-run.js";
// import { workflowToolEntry } from "./workflow.js";
import { createToolRuleNameSet } from "../tool-visibility.js";

// The direct branch keeps the Glob/Grep tool implementations; the embedded-search branch hides Glob/Grep through registerBuiltInTools
// and delegates search to Bash find/grep.

export const builtInTools: ToolEntry[] = [
  readToolEntry,
  writeToolEntry,
  editToolEntry,
  // applyPatchToolEntry,
  bashToolEntry,
  globToolEntry,
  grepToolEntry,
  // Registered only when the runtime has a usable language server (includeLsp); see registerBuiltInTools.
  lspToolEntry,
  webFetchToolEntry,
  webSearchToolEntry,
  todoReadToolEntry,
  todoWriteToolEntry,
  cronCreateToolEntry,
  cronListToolEntry,
  cronUpdateToolEntry,
  cronDeleteToolEntry,
  offPeakCreateToolEntry,
  offPeakListToolEntry,
  enterPlanModeToolEntry,
  exitPlanModeToolEntry,
  askUserQuestionToolEntry,
  sendMessageToolEntry,
  respondToCoordinatorToolEntry,
  submitResultToolEntry,
  // Actor escalation channel. Same registration shape as submit_result: register when the port is present (includeEscalate), and the
  // workflow_child allowlist restores it under `tools:"none"`. Do not add it to the default actor denylist; the actor most likely to hit
  // an unforeseen blocker is precisely the one the author did not mark.
  escalateToolEntry,
  taskOutputToolEntry,
  taskStopToolEntry,
  readSessionContextToolEntry,
  replyToChannelToolEntry,
  agentToolEntry,
  taskToolEntry,
  skillToolEntry,
  jsToolEntry,
  createWorkflowToolEntry,
  amendWorkflowToolEntry,
  // Saved definitions: write-side gate matches CreateWorkflow (alwaysAsk); reads have no gate.
  saveWorkflowToolEntry,
  // Experimental workflow authoring channel: synchronous, read-only (v1), fully transient.
  evalWorkflowSnippetToolEntry,
  // Two read-only run introspection tools: always on, no gate. They are not in WORKFLOW_CHILD_DISALLOWED_TOOLS because that denylist
  // prevents CreateWorkflow's alwaysAsk from opening a dialog in child runtimes, which does not apply to read-only queries.
  listWorkflowRunsToolEntry,
  getWorkflowRunToolEntry,
  // Run recovery entry point: related to the two read-only introspection tools above (run_id key and same port-probe failures), but
  // it executes work. alwaysAsk is required outside yolo (cancelled is the user's explicit stop decision; revival must ask), so it must
  // be in WORKFLOW_CHILD_DISALLOWED_TOOLS because child yolo has no dialog. Place it after GetWorkflowRun to keep list/get/resume together.
  resumeWorkflowRunToolEntry,
  // Primary-agent side of escalation Q&A: related to the three run tools above, using the same DWF run port and typeof-probing
  // failures. The downstream difference is that it is denied in actor sessions (bootstrap's workflowActorToolPolicy); subagents may
  // not answer on behalf of the primary agent.
  resolveWorkflowQuestionToolEntry,
  // Main-agent side of hole completion (docs/dynamic-workflow/launch.md, “The `FillWorkflowHole` tool”): same family as
  // ResolveWorkflowQuestion (run port, same typeof detection for missing methods), but it writes a script—use the same alwaysAsk gate and owner approval exemption as AmendWorkflow, and include it in the workflow-child denylist too.
  fillWorkflowHoleToolEntry,
  // Definition catalog (different from the two run tools above: those are history, this is what can be run). Also read-only, no gate.
  listSavedWorkflowsToolEntry,
  // Model catalog: another read-only, ungated discovery surface for `subagent_model` in CreateWorkflow / AmendWorkflow. It is not in
  // WORKFLOW_CHILD_DISALLOWED_TOOLS because that denylist prevents alwaysAsk from opening a dialog in child runtimes, which does not
  // apply to read-only queries.
  listModelsToolEntry,
  // workflowToolEntry,
];

/**
 * Eleven tools not registered when the dynamic-workflow gradual rollout gate is closed
 * (including FillWorkflowHole since 2026-09-28: no run can reach a hole when the gate is closed).
 * A closed gate means “there is no way to start a workflow,” so remove creation, amendment, saving, snippet evaluation, and all four
 * run-facing tools together. Read-only run introspection is also included because in the closed state it would point only to history the user can no longer act on.
 * `ListModels` is included too: its only purpose is selecting `subagent_model` for a run, and without CreateWorkflow it would direct the model to a nonexistent tool.
 * The legacy `Workflow` tool (`/expert` script path) is a separate feature and is **not** on this list.
 */
const DYNAMIC_WORKFLOW_TOOL_NAMES: ReadonlySet<string> = new Set([
  CREATE_WORKFLOW_TOOL_NAME,
  AMEND_WORKFLOW_TOOL_NAME,
  SAVE_WORKFLOW_TOOL_NAME,
  LIST_SAVED_WORKFLOWS_TOOL_NAME,
  LIST_MODELS_TOOL_NAME,
  EVAL_WORKFLOW_SNIPPET_TOOL_NAME,
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  GET_WORKFLOW_RUN_TOOL_NAME,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  FILL_WORKFLOW_HOLE_TOOL_NAME,
]);

/** Is this one of the ten workflow tools controlled by the gradual rollout gate? Used by cold restore to infer activation from history (launch.md, “On demand: activation”). */
export function isDynamicWorkflowToolName(toolName: string): boolean {
  return DYNAMIC_WORKFLOW_TOOL_NAMES.has(toolName);
}

interface RegisterBuiltInToolsOptions {
  bashTimeoutPolicy?: BashTimeoutPolicy;
  includeSkill?: boolean;
  includeAgent?: boolean;
  includeSendMessage?: boolean;
  includeRespondToCoordinator?: boolean;
  includeSubmitResult?: boolean;
  /**
   * When present, register submit_result with a typed declaration (`{ result: <schema> }`, eligible for strict mode) for DWF mono
   * subagents; when absent, use the generic declaration. Meaningful only when includeSubmitResult is true.
   */
  submitResultSchema?: JsonSchema;
  /** Actor escalation channel; same gate as includeSubmitResult (register only when WorkflowEscalatePort is injected). */
  includeEscalate?: boolean;
  includeWorkflow?: boolean;
  includeAutomation?: boolean;
  /** In-session Off-Peak creation tools, controlled by the host's offPeakToolEnabled flag (rollout/remote gate). */
  includeOffPeak?: boolean;
  /**
   * Language-server tool (spec §7). Registered only when the runtime has an LspService and availability resolved true.
   * Absence means not registered; both registration entry points pass it from the same helper (tool-allowlist.ts).
   */
  includeLsp?: boolean;
  /**
   * Dynamic-workflow rollout gate. **Only explicit false removes** DYNAMIC_WORKFLOW_TOOL_NAMES. Absence means the caller does not
   * participate in rollout (TUI, headless, workflow_child), so all tools remain available. The fail-closed default is in the protocol
   * service's appRuntimePreferences, not at this layer.
   */
  includeDynamicWorkflow?: boolean;
  /** node_repl (js) is disabled by default and enabled by the official browser-use plugin. */
  includeNodeRepl?: boolean;
  /** browser-use guidance and agent.browsers injection are enabled jointly by the official browser-use plugin and host browser bridge. */
  includeBrowserUse?: boolean;
  embeddedSearchEnabled?: boolean;
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  silentDuplicateWarnings?: boolean;
}

export function registerBuiltInTools(
  registry: {
    register(entry: ToolEntry, options?: { silentDuplicateWarning?: boolean }): void;
  },
  options: RegisterBuiltInToolsOptions = {},
): void {
  const allowedTools = options.allowedTools ? new Set(options.allowedTools) : undefined;
  const disallowedTools = createToolRuleNameSet(options.disallowedTools);

  for (const entry of builtInTools) {
    if (
      options.embeddedSearchEnabled === true &&
      (entry.metadata.name === "Glob" || entry.metadata.name === "Grep")
    ) {
      continue;
    }
    if (allowedTools && !allowedTools.has(entry.metadata.name)) {
      continue;
    }
    if (disallowedTools?.has(entry.metadata.name)) {
      continue;
    }
    if (isSubagentDispatchToolName(entry.metadata.name) && options.includeAgent !== true) {
      continue;
    }
    if (entry.metadata.name === "Skill" && options.includeSkill === false) {
      continue;
    }
    if (entry.metadata.name === "SendMessage" && options.includeSendMessage !== true) {
      continue;
    }
    if (
      entry.metadata.name === "RespondToCoordinator" &&
      options.includeRespondToCoordinator !== true
    ) {
      continue;
    }
    if (entry.metadata.name === "submit_result" && options.includeSubmitResult !== true) {
      continue;
    }
    if (entry.metadata.name === "escalate" && options.includeEscalate !== true) {
      continue;
    }
    if (entry.metadata.name === "Workflow" && options.includeWorkflow !== true) {
      continue;
    }
    if (
      (entry.metadata.name === "CronCreate" ||
        entry.metadata.name === "CronList" ||
        entry.metadata.name === "CronUpdate" ||
        entry.metadata.name === "CronDelete") &&
      options.includeAutomation !== true
    ) {
      continue;
    }
    if (
      (entry.metadata.name === "OffPeakCreate" || entry.metadata.name === "OffPeakList") &&
      options.includeOffPeak !== true
    ) {
      continue;
    }
    if (
      options.includeDynamicWorkflow === false &&
      DYNAMIC_WORKFLOW_TOOL_NAMES.has(entry.metadata.name)
    ) {
      continue;
    }
    if (entry.metadata.name === "js" && options.includeNodeRepl !== true) {
      continue;
    }
    if (entry.metadata.name === "LSP" && options.includeLsp !== true) {
      continue;
    }
    registry.register(resolveBuiltInToolEntryForBranch(entry, options), {
      silentDuplicateWarning: options.silentDuplicateWarnings,
    });
  }
}

function resolveBuiltInToolEntryForBranch(
  entry: ToolEntry,
  options: RegisterBuiltInToolsOptions,
): ToolEntry {
  if (entry.metadata.name === "Bash") {
    return createBashToolEntry({
      bashTimeoutPolicy: options.bashTimeoutPolicy,
      embeddedSearchEnabled: options.embeddedSearchEnabled,
    });
  }
  if (entry.metadata.name === SUBMIT_RESULT_TOOL_NAME && options.submitResultSchema !== undefined) {
    return createSubmitResultToolEntry(options.submitResultSchema);
  }
  // The rollout gate controls both tool registration and **descriptions**: Agent / Task descriptions require workflow requests to use
  // CreateWorkflow. When disabled, that tool does not exist, so keeping the instruction would point the model to a missing tool. Use
  // the same options.includeDynamicWorkflow as registration filtering so initial setup and branch refresh produce matching descriptions.
  if (entry.metadata.name === "Agent") {
    return createAgentToolEntry({
      dynamicWorkflowEnabled: options.includeDynamicWorkflow !== false,
    });
  }
  if (entry.metadata.name === "Task") {
    return createTaskToolEntry({
      dynamicWorkflowEnabled: options.includeDynamicWorkflow !== false,
    });
  }
  if (entry.metadata.name === "EnterPlanMode") {
    return createEnterPlanModeToolEntry({
      embeddedSearchEnabled: options.embeddedSearchEnabled,
    });
  }
  if (entry.metadata.name === "js") {
    return createJsToolEntry({
      browserUseEnabled: options.includeBrowserUse === true,
    });
  }
  return entry;
}

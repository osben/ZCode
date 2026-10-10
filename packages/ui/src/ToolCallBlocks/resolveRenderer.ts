// ============================================================
// Tool-card renderer registry: tool identity → concrete renderer component.
// ============================================================
// Extracted from ToolCallBlocks.tsx: this table grows linearly with the number of tools, and combining it with renderContext assembly made
// ToolCallBlocks.tsx exceed oxlint max-lines (400); rows.ts → toolDisplay.ts is the same precedent.
// This file only routes tools; it contains no JSX and does not assemble context. ToolCallBlocks.tsx depends on it one way.

import { EditToolCallBlock } from "@/ToolCallBlocks/renderers/edit.js";
import { AgentToolCallBlock } from "@/ToolCallBlocks/renderers/agent.js";
import { ChangesGroupToolCallBlock } from "@/ToolCallBlocks/renderers/changes-group.js";
import { CreateWorkflowToolCallBlock } from "@/ToolCallBlocks/renderers/create-workflow.js";
import { EscalateToolCallBlock } from "@/ToolCallBlocks/renderers/escalate.js";
import { EvalWorkflowSnippetToolCallBlock } from "@/ToolCallBlocks/renderers/eval-workflow-snippet.js";
import { ExploreToolCallBlock } from "@/ToolCallBlocks/renderers/explore.js";
import { ExecuteToolCallBlock } from "@/ToolCallBlocks/renderers/execute.js";
import { ExecuteGroupToolCallBlock } from "@/ToolCallBlocks/renderers/execute-group.js";
import { FallbackToolCallBlock } from "@/ToolCallBlocks/renderers/fallback.js";
import { GetWorkflowRunToolCallBlock } from "@/ToolCallBlocks/renderers/get-workflow-run.js";
import { ListModelsToolCallBlock } from "@/ToolCallBlocks/renderers/list-models.js";
import { ListSavedWorkflowsToolCallBlock } from "@/ToolCallBlocks/renderers/list-saved-workflows.js";
import { ListWorkflowRunsToolCallBlock } from "@/ToolCallBlocks/renderers/list-workflow-runs.js";
import { ResumeWorkflowRunToolCallBlock } from "@/ToolCallBlocks/renderers/resume-workflow-run.js";
import { ResolveWorkflowQuestionToolCallBlock } from "@/ToolCallBlocks/renderers/resolve-workflow-question.js";
import { SaveWorkflowToolCallBlock } from "@/ToolCallBlocks/renderers/save-workflow.js";
import {
  isEscalateToolCall,
  isEvalWorkflowSnippetToolCall,
  isGetWorkflowRunToolCall,
  isListModelsToolCall,
  isListSavedWorkflowsToolCall,
  isListWorkflowRunsToolCall,
  isResolveWorkflowQuestionToolCall,
  isResumeWorkflowRunToolCall,
  isSaveWorkflowToolCall,
} from "@/lib/workflowToolNames.js";
import { CuaToolCallBlock, isCuaToolCall } from "@/ToolCallBlocks/renderers/cua.js";
import { CuaGroupToolCallBlock } from "@/ToolCallBlocks/renderers/cua-group.js";
import { GoalToolCallBlock } from "@/ToolCallBlocks/renderers/goal.js";
import { NodeReplToolCallBlock } from "@/ToolCallBlocks/renderers/node-repl.js";
import { McpToolCallBlock, readMcpToolPresentation } from "@/ToolCallBlocks/renderers/mcp.js";
import { PlanGuidanceToolCallBlock } from "@/ToolCallBlocks/renderers/plan-guidance.js";
import { ReadToolCallBlock } from "@/ToolCallBlocks/renderers/read.js";
import { ReadSessionContextToolCallBlock } from "@/ToolCallBlocks/renderers/read-session-context.js";
import { RespondToCoordinatorToolCallBlock } from "@/ToolCallBlocks/renderers/respond-to-coordinator.js";
import { SearchToolCallBlock } from "@/ToolCallBlocks/renderers/search.js";
import { SendMessageToolCallBlock } from "@/ToolCallBlocks/renderers/send-message.js";
import { SkillToolCallBlock } from "@/ToolCallBlocks/renderers/skill.js";
import { SubmitResultToolCallBlock } from "@/ToolCallBlocks/renderers/submit-result.js";
import { SwitchModeToolCallBlock } from "@/ToolCallBlocks/renderers/switch-mode.js";
import { TaskOutputToolCallBlock } from "@/ToolCallBlocks/renderers/task-output.js";
import { TaskStopToolCallBlock } from "@/ToolCallBlocks/renderers/task-stop.js";
import { TodoToolCallBlock } from "@/ToolCallBlocks/renderers/todo.js";
import { AskQuestionToolCallBlock } from "@/ToolCallBlocks/renderers/ask-question.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

export function resolveToolCallRenderer(context: ToolCallBlockRenderContext) {
  if (context.toolCallNode.toolCall.kind === "changesGroup") {
    return ChangesGroupToolCallBlock;
  }
  if (context.toolCallNode.toolCall.kind === "executeGroup") {
    return ExecuteGroupToolCallBlock;
  }
  if (context.toolCallNode.toolCall.kind === "cuaGroup") {
    return CuaGroupToolCallBlock;
  }
  if (isCuaToolCall(context.toolCallNode.toolCall)) {
    return CuaToolCallBlock;
  }

  const identity = resolveToolCallIdentity(context.toolCallNode.toolCall);

  // Route the two reusable-workflow tools by **tool name** first, deliberately before family dispatch, for two reasons:
  // They are not currently in shared's known-tool table (identity returns unknown, so they fall into the raw JSON fallback card);
  // if they are later registered in the `workflow` family, the fallback in the branch below would render them as CreateWorkflow cards.
  // Name-first dispatch supports both cases.
  if (isSaveWorkflowToolCall(context.toolCallNode.toolCall)) {
    return SaveWorkflowToolCallBlock;
  }
  if (isListSavedWorkflowsToolCall(context.toolCallNode.toolCall)) {
    return ListSavedWorkflowsToolCallBlock;
  }

  // Route the three workflow-observation tools by name as well, also before family dispatch: they are not in the known-tool table (identity
  // returns unknown → raw JSON fallback card), and the workflow-family fallback is a CreateWorkflow card—
  // name-first dispatch supports both before and after registration (the same rationale as workflowToolNames).
  if (isGetWorkflowRunToolCall(context.toolCallNode.toolCall)) {
    return GetWorkflowRunToolCallBlock;
  }
  if (isListWorkflowRunsToolCall(context.toolCallNode.toolCall)) {
    return ListWorkflowRunsToolCallBlock;
  }
  if (isEvalWorkflowSnippetToolCall(context.toolCallNode.toolCall)) {
    return EvalWorkflowSnippetToolCallBlock;
  }
  // Route the ResumeWorkflowRun recovery entry by name for the same reason: it is not in the known-tool table, and the workflow-family
  // fallback is a CreateWorkflow card, so the recovery card must claim its name before family dispatch.
  if (isResumeWorkflowRunToolCall(context.toolCallNode.toolCall)) {
    return ResumeWorkflowRunToolCallBlock;
  }
  // Route the model catalog by name too; without name-based handling,
  // the fallback card would dump the model-facing `<models>` text, beginning with providerId, directly into the chat.
  if (isListModelsToolCall(context.toolCallNode.toolCall)) {
    return ListModelsToolCallBlock;
  }

  // Route both upgrade Q&A tools by name and before family dispatch too: they are not in the known-tool table (identity returns
  // unknown → raw JSON fallback card), and the workflow-family fallback is a CreateWorkflow card. Name-first dispatch supports
  // both before and after registration. `escalate` (subagent asks) and `ResolveWorkflowQuestion`
  // (main agent answers) have completely different card designs, so each claims its own name.
  if (isEscalateToolCall(context.toolCallNode.toolCall)) {
    return EscalateToolCallBlock;
  }
  if (isResolveWorkflowQuestionToolCall(context.toolCallNode.toolCall)) {
    return ResolveWorkflowQuestionToolCallBlock;
  }

  // The host Node REPL is also registered through MCP, so it has mcp_tool presentation too.
  // If generic MCP routing runs first, it swallows specialized interactions such as code, error stacks, and artifacts.
  // Preserve the Node REPL renderer by trusted tool identity first, then use generic presentation for the remaining MCP tools.
  if (identity.family === "node-repl") {
    return NodeReplToolCallBlock;
  }
  if (readMcpToolPresentation(context)) {
    return McpToolCallBlock;
  }

  // The current tool names form a fixed set. Continuing to scan kind/title with regular expressions
  // would mistake Write in TodoWrite for a file write. Resolve fixed tool identities first, then route by family;
  // tool shapes in historical ZCode projections are handled centrally by the identity resolver.
  switch (identity.family) {
    case "plan-guidance":
      return PlanGuidanceToolCallBlock;
    case "agent":
      return AgentToolCallBlock;
    case "todo":
      return TodoToolCallBlock;
    case "ask-user-question":
      return AskQuestionToolCallBlock;
    case "message":
      return identity.toolName === "RespondToCoordinator"
        ? RespondToCoordinatorToolCallBlock
        : SendMessageToolCallBlock;
    case "task-control":
      return identity.toolName === "TaskOutput" ? TaskOutputToolCallBlock : TaskStopToolCallBlock;
    case "skill":
      return SkillToolCallBlock;
    case "workflow":
      // Dispatch by tool name within the family (following the RespondToCoordinator precedent in the `message` family):
      // The two workflow tools have completely different cards: one shows a script/graph, the other the result submitted by an actor.
      return identity.toolName === "submit_result"
        ? SubmitResultToolCallBlock
        : CreateWorkflowToolCallBlock;
    case "session-context":
      return ReadSessionContextToolCallBlock;
    case "file-read":
      return ReadToolCallBlock;
    case "file-write":
      return EditToolCallBlock;
    case "explore":
      return ExploreToolCallBlock;
    case "switch-mode":
      return SwitchModeToolCallBlock;
    case "search":
      return SearchToolCallBlock;
    case "shell":
      return ExecuteToolCallBlock;
    case "goal":
      return GoalToolCallBlock;
    default:
      return FallbackToolCallBlock;
  }
}

import { type CollaborationMode, type PermissionRuleset } from "@zcode/contracts";

import type { PermissionDecisionResult, PermissionContext } from "../../permission/service.js";
import type {
  ExecutableToolCall,
  ToolEntry,
  ToolRuntimePermissionCapabilityContext,
} from "../types.js";
import { applyMemoryFilePermission, targetsMemoryFile } from "./memory-file-permission.js";
import { resolveRuntimePermissionCapability } from "./permission-capability.js";
import type { ToolExecutorDeps } from "./types.js";

export interface PermissionHookInputRecheckResult {
  permissionDecision?: PermissionDecisionResult;
}

export function recheckPermissionHookModifiedInput(input: {
  deps: ToolExecutorDeps;
  entry: ToolEntry;
  mode: CollaborationMode;
  modifiedInput: unknown;
  projectRules: PermissionRuleset | null;
  toolCall: ExecutableToolCall;
  /** Same context as the initial permission check (mode, bashShellSelection, cwd snapshot), constructed and passed through by the executor. */
  context: ToolRuntimePermissionCapabilityContext & {
    workingDirectory: string;
    workspaceRoot: string;
  };
}): PermissionHookInputRecheckResult {
  // Root cause (2026-09-17 review): this previously reconstructed a reduced context containing only runtimeScope/cwd, dropping mode and
  // bashShellSelection; when Guarded reused the recheck path, the matcher silently stopped working. Context must have a single construction point.
  const { context: runtimePermissionContext } = input;
  const { workingDirectory, workspaceRoot } = runtimePermissionContext;
  const permissionContext: PermissionContext = {
    input: input.modifiedInput,
    mode: input.mode,
    prePlanMode: input.deps.sessionModePort?.getPrePlanMode(),
    planEnabled: input.deps.sessionModePort?.isPlanEnabled?.(),
    riskLevel: input.entry.metadata.riskLevel,
    toolName: input.toolCall.name,
    // Use the same source as the initial decision: after a hook changes the input,
    // recheck draft auto-approval against the same working directory.
    workingDirectory,
  };
  const rulePolicy = input.entry.resolvePermissionRulePolicy?.(
    input.modifiedInput,
    runtimePermissionContext,
  );
  let decision = input.deps.permissionService.checkPermission(
    permissionContext,
    resolveRuntimePermissionCapability(input.entry, input.modifiedInput, runtimePermissionContext),
    input.projectRules,
    rulePolicy,
  );
  decision = applyMemoryFilePermission({
    decision,
    executionInput: input.modifiedInput,
    memoryRoot: input.deps.getMemoryRoot?.(),
    toolName: input.toolCall.name,
    workingDirectory,
    workspaceRoot,
  });

  if (decision.decision === "deny") {
    return {
      permissionDecision: decision,
    };
  }
  if (
    decision.decision !== "ask" ||
    (decision.ruleId !== "rule.project.ask" &&
      !targetsMemoryFile({
        executionInput: input.modifiedInput,
        memoryRoot: input.deps.getMemoryRoot?.(),
        toolName: input.toolCall.name,
        workingDirectory,
        workspaceRoot,
      }))
  ) {
    return {};
  }

  // Return only policy facts needed to preserve legacy behavior; the executor centrally handles request registration, publication, and terminal state.
  return { permissionDecision: decision };
}

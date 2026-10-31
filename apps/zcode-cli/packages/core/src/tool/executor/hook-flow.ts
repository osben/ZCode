import {
  CoreErrorType,
  HookEventName,
  dropTrailingHighSurrogate,
  isCoreError,
  type CollaborationMode,
  type PermissionBrokerResult,
  type TraceContext,
} from "@zcode/contracts";
import type { HookRunResult } from "../../hooks/index.js";
import type { PermissionDecisionResult } from "../../permission/service.js";
import { hookMatcherToolNamesForTool } from "../compat.js";
import { formatCompactPersistedOutputContent } from "../result-persistence-format.js";
import type { ExecutableToolCall, ToolEntry } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";
import { previewHookValue } from "./utils.js";

export async function runPreToolUseHooks(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  input: unknown,
  entry: ToolEntry,
  mode: CollaborationMode,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!deps.hookRunner) return { additionalContexts: [] };
  return deps.hookRunner.run(
    {
      cwd: deps.getWorkingDirectory(),
      hookEventName: HookEventName.PreToolUse,
      mode,
      riskLevel: entry.metadata.riskLevel,
      sessionId: deps.sessionId,
      sideEffectScope: entry.metadata.sideEffectScope,
      timestamp: new Date().toISOString(),
      toolCallId: toolCall.id,
      toolInput: input,
      toolName: toolCall.name,
      traceId: traceContext.traceId,
      turnId: traceContext.turnId ?? deps.turnId,
    },
    {
      matchValue: toolCall.name,
      matchValues: hookMatcherToolNamesForTool(toolCall.name),
      signal,
    },
  );
}

export async function runPermissionRequestHooks(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  input: unknown,
  requestId: string,
  permissionDecision: PermissionDecisionResult,
  mode: CollaborationMode,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<PermissionBrokerResult | undefined> {
  if (!deps.hookRunner) return undefined;
  const hookResult = await deps.hookRunner.run(
    {
      cwd: deps.getWorkingDirectory(),
      hookEventName: HookEventName.PermissionRequest,
      mode,
      reason: permissionDecision.reason ?? `Tool ${toolCall.name} requires approval`,
      requestId,
      riskLevel: permissionDecision.riskLevel,
      sessionId: deps.sessionId,
      sideEffectScope: permissionDecision.sideEffectScope,
      timestamp: new Date().toISOString(),
      toolCallId: toolCall.id,
      toolInput: input,
      toolName: toolCall.name,
      traceId: traceContext.traceId,
      turnId: traceContext.turnId ?? deps.turnId,
    },
    {
      matchValue: toolCall.name,
      matchValues: hookMatcherToolNamesForTool(toolCall.name),
      signal,
    },
  );
  const decision = hookResult.permissionRequestResult;
  if (hookResult.preventContinuation) {
    return {
      decision: "deny",
      reason: hookResult.stopReason ?? "Denied by PermissionRequest hook",
    };
  }
  if (!decision) {
    if (hookResult.permissionBehavior === "deny") {
      return {
        decision: "deny",
        reason: hookResult.stopReason ?? "Denied by PermissionRequest hook",
      };
    }
    return hookResult.permissionBehavior === "allow"
      ? {
          decision: "allow",
          reason: "Allowed by PermissionRequest hook",
        }
      : undefined;
  }
  if (decision.behavior === "deny") {
    return {
      decision: "deny",
      reason: decision.message ?? "Denied by PermissionRequest hook",
    };
  }
  const permissionUpdates = decision.permissionUpdates ?? decision.updatedPermissions;
  return decision.updatedInput === undefined
    ? {
        decision: "allow",
        permissionUpdates,
        reason: "Allowed by PermissionRequest hook",
      }
    : {
        decision: "modify",
        modifiedInput: decision.updatedInput,
        permissionUpdates,
        reason: "Allowed with modified input by PermissionRequest hook",
      };
}

export async function runPostToolUseHooks(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  input: unknown,
  output: unknown,
  artifactPath: string | undefined,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!deps.hookRunner) return { additionalContexts: [] };
  return deps.hookRunner.run(
    {
      artifactRefs: artifactPath ? [artifactPath] : undefined,
      cwd: deps.getWorkingDirectory(),
      hookEventName: HookEventName.PostToolUse,
      mode: deps.getMode(),
      sessionId: deps.sessionId,
      timestamp: new Date().toISOString(),
      toolCallId: toolCall.id,
      toolInput: input,
      toolName: toolCall.name,
      toolResponse: output,
      toolResultPreview: previewHookValue(output),
      traceId: traceContext.traceId,
      turnId: traceContext.turnId ?? deps.turnId,
    },
    {
      matchValue: toolCall.name,
      matchValues: hookMatcherToolNamesForTool(toolCall.name),
      signal,
    },
  );
}

export async function runPostToolUseFailureHooks(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  input: unknown,
  error: unknown,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!deps.hookRunner) return { additionalContexts: [] };
  const normalized = error instanceof Error ? error : new Error(String(error));
  return deps.hookRunner.run(
    {
      cwd: deps.getWorkingDirectory(),
      error: {
        message: normalized.message,
        type: isCoreError(normalized) ? normalized.type : normalized.name,
      },
      hookEventName: HookEventName.PostToolUseFailure,
      isInterrupt: isCoreError(normalized) && normalized.type === CoreErrorType.ToolCancelled,
      mode: deps.getMode(),
      sessionId: deps.sessionId,
      timestamp: new Date().toISOString(),
      toolCallId: toolCall.id,
      toolInput: input,
      toolName: toolCall.name,
      traceId: traceContext.traceId,
      turnId: traceContext.turnId ?? deps.turnId,
    },
    {
      matchValue: toolCall.name,
      matchValues: hookMatcherToolNamesForTool(toolCall.name),
      signal,
    },
  );
}

export function applyPreToolPermissionDecision(
  permissionDecision: PermissionDecisionResult,
  hookResult: HookRunResult,
  mode: CollaborationMode,
): PermissionDecisionResult {
  if (permissionDecision.decision === "deny") return permissionDecision;
  // A confirmation declared by alwaysAsk (such as workflow run approval) cannot be
  // silently removed by a blanket allow from a PreToolUse hook; that would create a
  // silent bypass of "ask in every mode". Automation still has a supported path:
  // PermissionRequest hooks can answer this dialog (see runPermissionRequestHooks).
  if (
    hookResult.permissionBehavior === "allow" &&
    permissionDecision.decision === "ask" &&
    !permissionDecision.alwaysAsk
  ) {
    return {
      ...permissionDecision,
      allowed: true,
      decision: "allow",
      escalated: false,
      mode,
      reason: hookResult.hookPermissionDecisionReason ?? "Tool was allowed by PreToolUse hook",
      ruleId: "hook.PreToolUse.allow",
    };
  }
  if (hookResult.permissionBehavior === "ask" && permissionDecision.decision === "allow") {
    return {
      ...permissionDecision,
      allowed: false,
      decision: "ask",
      escalated: true,
      mode,
      reason:
        hookResult.hookPermissionDecisionReason ?? "Tool requires approval by PreToolUse hook",
      ruleId: "hook.PreToolUse.ask",
    };
  }
  return permissionDecision;
}

type ToolHookEventName =
  | typeof HookEventName.PreToolUse
  | typeof HookEventName.PostToolUse
  | typeof HookEventName.PostToolUseFailure;

const TOOL_HOOK_CONTEXT_MAX_CHARS = 10_000;
const TOOL_HOOK_CONTEXT_CONTENT_TYPE = "text/plain";
const MISSING_ARTIFACT_STORE_REASON = "no artifact store";

/**
 * Each context becomes its own file; multiple hooks are not merged and multi-line text is kept as-is.
 * Fix reason: once hook text moved out of the tool result it was no longer bound by the tool result
 * budget, so one overlong context entered every request in full. Now a single context over 10000
 * characters is persisted first and the model sees only a shell and preview (hooks.md "aggregation rules").
 * The caller applies official CUA credential filtering before calling this; filtered contexts are not written to file.
 */
export async function formatToolHookAdditionalContexts(
  deps: ToolExecutorDeps,
  hookEventName: ToolHookEventName,
  toolCall: ExecutableToolCall,
  additionalContexts: readonly string[],
  traceContext: TraceContext,
): Promise<string[]> {
  return Promise.all(
    additionalContexts.map(
      async (context) =>
        `${hookEventName}:${toolCall.name} hook additional context: ${await boundToolHookContext(
          deps,
          toolCall,
          context,
          traceContext,
        )}`,
    ),
  );
}

async function boundToolHookContext(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  context: string,
  traceContext: TraceContext,
): Promise<string> {
  if (context.length <= TOOL_HOOK_CONTEXT_MAX_CHARS) return context;
  let failureReason = MISSING_ARTIFACT_STORE_REASON;
  if (deps.artifactStore) {
    try {
      const artifact = await deps.artifactStore.writeToolResultArtifact({
        content: context,
        contentType: TOOL_HOOK_CONTEXT_CONTENT_TYPE,
        retention: "session",
        sessionId: deps.sessionId,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        trace: traceContext,
        turnId: traceContext.turnId ?? deps.turnId,
      });
      return formatCompactPersistedOutputContent({
        content: context,
        originalBytes: context.length,
        persistedPath: artifact.path ?? artifact.uri,
      });
    } catch (error) {
      // A write failure must not fail the tool call: fall back to truncation and tell the model why.
      failureReason = error instanceof Error ? error.message : String(error);
    }
  }
  const head = dropTrailingHighSurrogate(context.slice(0, TOOL_HOOK_CONTEXT_MAX_CHARS));
  return `${head}\n\n[Hook additionalContext truncated at ${TOOL_HOOK_CONTEXT_MAX_CHARS} chars — persist-to-disk failed: ${failureReason}]`;
}

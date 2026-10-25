import {
  traceContextToLogContext,
  type PermissionOptionsPolicy,
  type ToolResultDisplayPayload,
  type TraceContext,
} from "@zcode/contracts";
import type { ExecutableToolCall, ToolEntry } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";

interface ResolvedToolApproval {
  gate: "ask" | "proceed";
  display?: ToolResultDisplayPayload;
  optionsPolicy?: PermissionOptionsPolicy;
}

/**
 * After the permission service decides to ask, call the tool's `prepareApproval` and
 * combine its response with the tool's declared options policy to determine what this
 * approval request should carry.
 *
 * The decision only narrows: the hook may let an ask proceed or add a preview, but it
 * can never turn an allow into an ask. Tools without a declared hook keep the existing
 * approval dialog behavior.
 */
function resolveOptionsPolicy(
  allowAlways: false | "session" | undefined,
): PermissionOptionsPolicy | undefined {
  switch (allowAlways) {
    case false:
      return "no-always-allow";
    case "session":
      return "session-always-allow";
    default:
      return undefined;
  }
}

export function resolveToolApproval(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  entry: ToolEntry,
  executionInput: unknown,
  traceContext: TraceContext,
): ResolvedToolApproval {
  // `permission` is required by the type, but the executor also receives entries with
  // only some fields declared (test doubles and dynamically registered tools). Nearby
  // code tolerates this by spreading rather than reading fields; the gate does the same.
  const optionsPolicy = resolveOptionsPolicy(entry.permission?.askOptions?.allowAlways);

  if (!entry.prepareApproval) {
    return { gate: "ask", ...(optionsPolicy ? { optionsPolicy } : {}) };
  }

  try {
    // The working directory comes from the same source as the handler (impl.ts folds a
    // static workingDirectory into deps.getWorkingDirectory); otherwise the preview
    // could inspect one directory while execution writes to another.
    const gate = entry.prepareApproval(executionInput);
    if (gate.gate === "proceed") return { gate: "proceed" };
    return {
      gate: "ask",
      ...(gate.display ? { display: gate.display } : {}),
      ...(optionsPolicy ? { optionsPolicy } : {}),
    };
  } catch (error) {
    // The preview hook must never decide whether to ask the user. Failing open on the
    // execution side would silently run an unapproved tool, so keep the ask and only
    // omit the preview.
    deps.logger?.warn("Tool approval preview failed; asking without a preview", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "tool.permission.approval_preview_failed",
      module: "core.tool.executor",
      status: "failed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
    return { gate: "ask", ...(optionsPolicy ? { optionsPolicy } : {}) };
  }
}

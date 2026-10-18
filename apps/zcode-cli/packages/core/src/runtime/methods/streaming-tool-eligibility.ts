import type { ModelToolCall } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  resolveRuntimePermissionCapability,
  resolveToolSchedulingFlags,
} from "../../tool/executor/permission-capability.js";
import { DEFAULT_TOOL_MAX_CONCURRENCY } from "../../tool/executor/impl.js";
import { resolveRuntimeToolCapabilityContext } from "../helpers/runtime-tools.js";

const STREAMING_TOOL_EXECUTION_MODE = "readOnly";

/**
 * Whether a closed tool call may start before the model stream finishes. Uses the same
 * input-aware capability as `scheduleTools` and the permission check, so read-only Bash
 * qualifies while mutating, directory-changing, or Guarded-dangerous Bash does not.
 * This is a timing gate only: the executor still runs hooks and the permission decision.
 */
export function isToolCallEligibleDuringStream(
  runtime: AgentRuntimeInternal,
  toolCall: ModelToolCall,
): boolean {
  if (toolCall.providerExecuted) return false;
  if (toolCall.name.trim().length === 0) return false;
  if (runtime.config.modelStreaming !== "on") return false;
  if ((runtime.config.streamingToolExecution ?? STREAMING_TOOL_EXECUTION_MODE) === "off") {
    return false;
  }
  const entry = runtime.registry.get(toolCall.name);
  if (!entry) return false;
  // A detached job outlives the stream attempt, so stream-failure abort cannot settle it.
  if (isRecord(toolCall.input) && toolCall.input.run_in_background === true) return false;

  const context = resolveRuntimeToolCapabilityContext(runtime);
  const capability = resolveRuntimePermissionCapability(entry, toolCall.input, context);
  const flags = resolveToolSchedulingFlags(entry, toolCall.input, context);
  const needsApproval = capability.permission?.needsApproval ?? capability.needsApproval;
  const alwaysAsk = capability.permission?.alwaysAsk ?? capability.alwaysAsk;
  const requiresUserInteraction =
    entry.requiresUserInteraction ?? capability.requiresUserInteraction;
  return (
    flags.readOnly === true &&
    flags.concurrentSafe === true &&
    flags.destructive !== true &&
    flags.sideEffectScope === "none" &&
    !needsApproval &&
    !alwaysAsk &&
    !requiresUserInteraction &&
    capability.userApprovalRule === undefined
  );
}

/**
 * Each early call runs as its own executor batch, so the per-batch `maxConcurrency` cap does
 * not bound them together. Limit early calls per stream attempt to the same cap; the rest run
 * in the end-of-stream schedule, which the executor caps as usual.
 */
export function resolveStreamingToolExecutionLimit(runtime: AgentRuntimeInternal): number {
  return runtime.config.toolConcurrency?.maxConcurrency ?? DEFAULT_TOOL_MAX_CONCURRENCY;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

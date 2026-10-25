import type { ModelToolSideEffectScope } from "@zcode/contracts";
import type { PermissionToolCapability } from "../../permission/service.js";
import type { ToolEntry, ToolRuntimePermissionCapabilityContext } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";

export function resolveRuntimePermissionCapability(
  entry: ToolEntry,
  input: unknown,
  context: ToolRuntimePermissionCapabilityContext,
): PermissionToolCapability {
  const runtimeCapability = entry.resolvePermissionCapability?.(input, context);
  return {
    ...entry.metadata,
    ...runtimeCapability,
    // capability group is provenance, not a runtime/model-controlled override.
    permissionCapabilityGroup: entry.permissionCapabilityGroup,
    permission: {
      ...entry.permission,
      ...runtimeCapability?.permission,
    },
  };
}

export interface ToolSchedulingFlags {
  readOnly?: boolean;
  destructive?: boolean;
  concurrentSafe?: boolean;
  sideEffectScope?: ModelToolSideEffectScope;
}

/**
 * Scheduling flags for a model-emitted call, resolved through the same runtime capability as
 * permission checks so input-aware conclusions (for example a read-only Bash command) can run
 * in a parallel group. Precedence: runtime capability > `entry.permission` > `entry.metadata`.
 */
export function resolveToolSchedulingFlags(
  entry: ToolEntry,
  input: unknown,
  context: ToolRuntimePermissionCapabilityContext,
): ToolSchedulingFlags {
  const runtimeCapability = entry.resolvePermissionCapability?.(input, context);
  const metadata = entry.metadata;
  const sideEffectScope =
    runtimeCapability?.sideEffectScope ??
    entry.permission?.sideEffectScope ??
    metadata.sideEffectScope;
  const readOnly = runtimeCapability?.readOnly ?? metadata.readOnly;
  return {
    readOnly: readOnly === undefined ? undefined : readOnly && sideEffectScope === "none",
    destructive: runtimeCapability?.destructive ?? metadata.destructive,
    concurrentSafe: runtimeCapability?.concurrentSafe ?? metadata.concurrentSafe,
    sideEffectScope,
  };
}

/**
 * Side-effect flags for a call **after input resolution**, attached to `ToolCallStarted`.
 * They use the same resolution as permission checks, so runtime conclusions such as
 * whether a Bash command is read-only are reflected too. Subscribers (the
 * dynamic-workflow driver) use them to determine before the handler runs whether this
 * call will modify the workspace.
 */
export function resolveToolCallCapabilityFlags(
  deps: ToolExecutorDeps,
  entry: ToolEntry,
  input: unknown,
): { readOnly?: boolean; sideEffectScope?: ModelToolSideEffectScope } {
  const capability = resolveRuntimePermissionCapability(
    entry,
    input,
    resolveRuntimePermissionContext(deps),
  );
  return { readOnly: capability.readOnly, sideEffectScope: capability.sideEffectScope };
}

export function resolveRuntimePermissionContext(
  deps: ToolExecutorDeps,
): ToolRuntimePermissionCapabilityContext {
  return {
    runtimeScope: deps.runtimeScope,
    workingDirectory: deps.getWorkingDirectory(),
    workspaceRoot: deps.getWorkspaceRoot(),
  };
}

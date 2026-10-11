// Permission-rule reads, persistence, and post-approval finalization (split from permission-flow.ts).
// Reason for the split: permission-flow.ts exceeded the 400-line file limit after adding the responder race; these helpers concern only
// rule storage (project-level writes to sessionStore, session-level writes to the in-memory ruleset), not ask timing. When confirmation-dialog settings adjustments
// brought permission-flow.ts close to the limit again, the rule-update part of the approval response moved here too (behavior unchanged).
import {
  CoreErrorType,
  createCoreError,
  traceContextToLogContext,
  type PermissionRuleset,
  type PermissionUpdate,
  type ProjectId,
  type TraceContext,
} from "@zcode/contracts";
import type { ExecutableToolCall, ToolExecutionResult } from "../types.js";
import { createErrorResult } from "./errors.js";
import { applyPermissionUpdates } from "./permission-rules.js";
import type { ToolExecutorDeps } from "./types.js";

export async function loadProjectPermissionRuleset(
  deps: ToolExecutorDeps,
): Promise<PermissionRuleset | null> {
  if (!deps.sessionStore) return null;
  const session = await deps.sessionStore.getSession(deps.sessionId);
  if (session?.permission?.scope === "session") return session.permission;
  if (!session?.projectID) return null;
  return deps.sessionStore.getProjectPermission(session.projectID);
}

export async function persistProjectPermissionUpdates(
  deps: ToolExecutorDeps,
  updates: PermissionUpdate[],
  traceContext: TraceContext,
): Promise<void> {
  if (updates.length === 0) return;

  if (!deps.sessionStore) {
    deps.logger?.warn("Project permission update skipped without session store", {
      ...traceContextToLogContext(traceContext),
      event: "tool.permission.project_update.skipped",
      module: "core.tool.executor",
      status: "completed",
    });
    return;
  }

  const session = await deps.sessionStore.getSession(deps.sessionId);
  if (session?.permission?.scope === "session") {
    await deps.sessionStore.updateSession({
      id: deps.sessionId,
      permission: applyPermissionUpdates(session.permission, updates),
    });
    return;
  }
  const projectID = await resolveProjectId(deps);
  if (!projectID) {
    deps.logger?.warn("Project permission update skipped without persisted session", {
      ...traceContextToLogContext(traceContext),
      event: "tool.permission.project_update.skipped",
      module: "core.tool.executor",
      status: "completed",
    });
    return;
  }

  const current = (await deps.sessionStore.getProjectPermission(projectID)) ?? { version: 1 };
  const next = applyPermissionUpdates(current, updates);
  await deps.sessionStore.saveProjectPermission({ projectID, permission: next });

  deps.logger?.info("Project permission updated", {
    ...traceContextToLogContext(traceContext),
    event: "tool.permission.project_update.saved",
    module: "core.tool.executor",
    status: "completed",
    updateCount: updates.length,
  });
}

/**
 * Update rules from an approval response: persist project-level rules first, then add session-level rules to the in-memory ruleset. If persistence fails, return a tool failure
 * result (the user's “always allow” choice was not saved and cannot be treated as if nothing happened); do not update session-level rules either.
 */
export async function applyGrantedPermissionUpdates(options: {
  deps: ToolExecutorDeps;
  permissionUpdates: PermissionUpdate[] | undefined;
  requestId: string;
  sessionPermissionUpdates: PermissionUpdate[] | undefined;
  toolCall: ExecutableToolCall;
  traceContext: TraceContext;
}): Promise<ToolExecutionResult | undefined> {
  const { deps, permissionUpdates, requestId, sessionPermissionUpdates, toolCall, traceContext } =
    options;
  if (permissionUpdates?.length) {
    try {
      await persistProjectPermissionUpdates(deps, permissionUpdates, traceContext);
    } catch (error) {
      return createErrorResult(
        toolCall,
        createCoreError(CoreErrorType.StorageError, "Failed to persist project permission update", {
          cause: error instanceof Error ? error : undefined,
          context: {
            requestId,
            sessionId: deps.sessionId,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          },
          recoverable: true,
        }),
      );
    }
  }

  if (sessionPermissionUpdates?.length) {
    // Session-level approval exemption (docs/dynamic-workflow/launch.md, “Always allow in this session”): add it only to the in-memory session ruleset,
    // separate from the project-level persisted rule above.
    deps.permissionService.grantSessionPermission(sessionPermissionUpdates);
    deps.logger?.info("Session permission granted", {
      ...traceContextToLogContext(traceContext),
      event: "tool.permission.session_grant.applied",
      module: "core.tool.executor",
      requestId,
      status: "completed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      updateCount: sessionPermissionUpdates.length,
    });
  }
  return undefined;
}

async function resolveProjectId(deps: ToolExecutorDeps): Promise<ProjectId | undefined> {
  const session = await deps.sessionStore?.getSession(deps.sessionId);
  return session?.projectID;
}

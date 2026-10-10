import type { IZCodeSessionService } from "@zcode/services";
import { logger } from "@/logger.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

interface DeferredDraftRuntimeChangeParams {
  logScope: string;
  reason: string;
  workspacePath?: string | null;
  workspaceIdentity?: string | null;
  zcodeSessionService: Pick<IZCodeSessionService, "closeSession">;
}

export async function invalidateDeferredDraftSessionForRuntimeChange(
  params: DeferredDraftRuntimeChangeParams,
): Promise<void> {
  if (!params.workspacePath) {
    return;
  }

  const workspaceIdentity = params.workspaceIdentity?.trim() || undefined;
  const store = useZCodeSessionStore.getState();
  const draftSessionId = store.getWorkspaceState(
    params.workspacePath,
    workspaceIdentity,
  ).draftSessionId;
  // protocol-v4 draft sessions are prewarmed locally by the pane, so draftSessionId remains null.
  // Publish the workspace-scoped runtime invalidation generation first, whether or not a legacy session exists.
  store.invalidateDraftRuntime(params.workspacePath, workspaceIdentity);
  if (!draftSessionId) {
    return;
  }

  try {
    await params.zcodeSessionService.closeSession({
      workspacePath: params.workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      sessionId: draftSessionId,
    });
    logger.info(`[${params.logScope}] invalidated deferred draft session after runtime change`, {
      draftSessionId,
      reason: params.reason,
      workspaceIdentity: workspaceIdentity ?? null,
      workspacePath: params.workspacePath,
    });
  } catch (error) {
    logger.warn(`[${params.logScope}] close deferred draft session after runtime change failed`, {
      draftSessionId,
      reason: params.reason,
      workspaceIdentity: workspaceIdentity ?? null,
      workspacePath: params.workspacePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function invalidateDeferredDraftSessionForSkillChange(
  params: Omit<DeferredDraftRuntimeChangeParams, "logScope">,
): Promise<void> {
  await invalidateDeferredDraftSessionForRuntimeChange({ ...params, logScope: "skills" });
}

import type { IZCodeTaskService } from "@zcode/services";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { logger } from "@/logger.js";

export function releaseWorkspaceRuntimeAfterProjectRemoval({
  tab,
  zcodeTaskService,
}: {
  tab: Pick<WorkspaceTabState, "workspacePath" | "workspaceIdentity">;
  zcodeTaskService: Pick<IZCodeTaskService, "releaseWorkspacePreparation">;
}): void {
  const workspaceIdentity = tab.workspaceIdentity?.trim() || undefined;
  void zcodeTaskService
    .releaseWorkspacePreparation({
      workspacePath: tab.workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    })
    .catch((error: unknown) => {
      // Windows treats the Agent/terminal subprocess cwd as a directory lock; project removal must explicitly release the runtime.
      // A release failure must not roll back UI removal; record the workspace key to help locate the leftover process.
      logger.error("[WorkspaceSidebarItem] 移除 workspace 后释放 runtime 失败", {
        workspaceKey: workspaceIdentity ?? tab.workspacePath,
        error,
      });
    });
}

import type { ZCodeTaskTreeCounts } from "#src/session/zcodeTaskService.js";
import type { TaskIndexRepo, TaskIndexWorktreeOwnerFact } from "#src/session/taskIndexRepo.js";
import type { IGitService } from "#src/git/git.js";
import type { IZCodeAgentService } from "./zcodeAgent.js";
import type { ZCodeTaskIndexSyncer } from "./zcodeTaskIndexSyncer.js";

export type WorktreeCleanupOptions = {
  agent: IZCodeAgentService;
  taskIndexRepo: TaskIndexRepo;
  gitService?: Pick<
    IGitService,
    "getRepositorySummary" | "resolveWorktreePathIdentities" | "removeWorktree"
  >;
  taskIndexSyncer?: Pick<ZCodeTaskIndexSyncer, "listWorktreePreparations">;
  getOpenWorkspacePaths?: () => Promise<string[]>;
  listLocalTaskMetas(): Promise<TaskIndexWorktreeOwnerFact[]>;
  countTaskTrees(
    scope: { workspacePath: string },
    taskIds: string[],
    runtimePolicy: "existing-only" | "start-if-needed",
  ): Promise<ZCodeTaskTreeCounts | null>;
};

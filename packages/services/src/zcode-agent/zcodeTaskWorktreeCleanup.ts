import type { WorktreeCleanupOptions } from "./zcodeTaskWorktreeCleanupTypes.js";
import {
  finalizeWorktreeCleanup,
  recordWorktreeRemoved,
} from "./zcodeTaskWorktreeCleanupResult.js";
import { stat } from "node:fs/promises";
import type { ZCodeTaskEraseResult } from "#src/session/zcodeTaskService.js";
import type { TaskIndexWorktreeOwnerFact } from "#src/session/taskIndexRepo.js";
import type { ZCodeTaskIndexSyncer } from "./zcodeTaskIndexSyncer.js";

export function createTaskWorktreeCleanup(options: WorktreeCleanupOptions) {
  const { agent, taskIndexRepo } = options;
  async function cleanupWorktrees(
    allTaskMetas: TaskIndexWorktreeOwnerFact[],
    candidateTaskIds: ReadonlySet<string>,
    result: ZCodeTaskEraseResult,
  ): Promise<void> {
    const candidates = allTaskMetas.filter(
      (task) =>
        task.deleted &&
        candidateTaskIds.has(task.taskId) &&
        task.executionWorktree?.path &&
        !task.workspaceIdentity?.trim(),
    );
    if (candidates.length === 0) return;
    const cleanup = result.worktreeCleanup;
    const retain = (targetPath: string, reason: string) =>
      cleanup.retained.push({ targetPath, reason });
    const fail = (targetPath: string, reason: string) =>
      cleanup.failed.push({ targetPath, reason });
    const finalize = () => finalizeWorktreeCleanup(cleanup);
    if (!options.gitService || !options.getOpenWorkspacePaths || !options.taskIndexSyncer) {
      for (const task of candidates)
        retain(task.executionWorktree!.path, "authoritative guard unavailable");
      finalize();
      return;
    }

    let openPaths: string[];
    let preparations: ReturnType<ZCodeTaskIndexSyncer["listWorktreePreparations"]>;
    try {
      [openPaths, preparations] = await Promise.all([
        options.getOpenWorkspacePaths(),
        Promise.resolve(options.taskIndexSyncer.listWorktreePreparations()),
      ]);
    } catch {
      for (const task of candidates)
        retain(task.executionWorktree!.path, "authoritative inventory unavailable");
      finalize();
      return;
    }

    let canonicalPaths: string[];
    try {
      canonicalPaths = await options.gitService.resolveWorktreePathIdentities({
        paths: [
          ...candidates.map((task) => task.executionWorktree!.path),
          ...allTaskMetas.flatMap((task) =>
            task.executionWorktree?.path ? [task.executionWorktree.path] : [],
          ),
          ...openPaths,
          ...preparations.map((entry) => entry.targetPath),
        ],
      });
      if (
        canonicalPaths.length !==
        candidates.length +
          allTaskMetas.filter((task) => task.executionWorktree?.path).length +
          openPaths.length +
          preparations.length
      ) {
        throw new Error("incomplete canonical path inventory");
      }
    } catch {
      for (const task of candidates)
        retain(task.executionWorktree!.path, "canonical path inventory unavailable");
      finalize();
      return;
    }

    let offset = 0;
    const candidateIdentities = candidates.map(() => canonicalPaths[offset++]!);
    const factIdentityByTask = new Map<string, string>();
    for (const task of allTaskMetas) {
      if (!task.executionWorktree?.path) continue;
      factIdentityByTask.set(
        `${task.workspaceIdentity?.trim() || task.workspacePath}\0${task.taskId}`,
        canonicalPaths[offset++]!,
      );
    }
    const openIdentities = new Set(openPaths.map(() => canonicalPaths[offset++]!));
    const preparationIdentities = new Set(preparations.map(() => canonicalPaths[offset++]!));
    const candidateKeys = new Set<string>();
    const groups = new Map<
      string,
      {
        targetPath: string;
        repoPath: string;
        identity: string;
        tasks: TaskIndexWorktreeOwnerFact[];
      }
    >();
    for (let index = 0; index < candidates.length; index += 1) {
      const task = candidates[index]!;
      const targetPath = task.executionWorktree!.path;
      const identity = candidateIdentities[index]!;
      const key = `${task.workspacePath}\0${identity}`;
      if (candidateKeys.has(key)) continue;
      candidateKeys.add(key);
      let summary;
      try {
        summary = await options.gitService.getRepositorySummary({
          workspacePath: task.workspacePath,
        });
        if (!summary.isRepository)
          summary = await options.gitService.getRepositorySummary({ workspacePath: targetPath });
      } catch {
        retain(targetPath, "repository inventory unavailable");
        continue;
      }
      if (!summary.isRepository) {
        retain(targetPath, "repository unavailable");
        continue;
      }
      const groupKey = `${summary.repoRoot}\0${identity}`;
      const group = groups.get(groupKey) ?? {
        targetPath,
        repoPath: summary.repoRoot,
        identity,
        tasks: [],
      };
      group.tasks.push(task);
      groups.set(groupKey, group);
    }

    for (const group of groups.values()) {
      const branchName = group.tasks[0]?.executionWorktree?.branchName;
      if (branchName) {
        let branchProtected = false;
        for (const owner of allTaskMetas.filter(
          (task) => task.executionWorktree?.branchName === branchName,
        )) {
          if (owner.deleted) continue;
          try {
            let summary = await options.gitService.getRepositorySummary({
              workspacePath: owner.workspacePath,
            });
            if (!summary.isRepository && owner.executionWorktree?.path) {
              summary = await options.gitService.getRepositorySummary({
                workspacePath: owner.executionWorktree.path,
              });
            }
            if (summary.isRepository && summary.repoRoot === group.repoPath) {
              retain(group.targetPath, "branch is owned by a surviving task in this repository");
              branchProtected = true;
              break;
            }
          } catch {
            retain(group.targetPath, "branch ownership inventory unavailable");
            branchProtected = true;
            break;
          }
        }
        if (branchProtected) continue;
      }
      const ownerTasks = allTaskMetas.filter(
        (task) =>
          task.executionWorktree?.path &&
          factIdentityByTask.get(
            `${task.workspaceIdentity?.trim() || task.workspacePath}\0${task.taskId}`,
          ) === group.identity,
      );
      if (ownerTasks.some((task) => !task.deleted)) {
        retain(group.targetPath, "owned by a surviving task");
        continue;
      }
      if (openIdentities.has(group.identity)) {
        retain(group.targetPath, "open in a workspace window");
        continue;
      }
      if (preparationIdentities.has(group.identity)) {
        retain(group.targetPath, "worktree preparation is active");
        continue;
      }
      let sameBranchPreparation: string | null = null;
      for (const preparation of preparations) {
        const branchName = group.tasks[0]?.executionWorktree?.branchName;
        if (!branchName || preparation.branchName !== branchName) continue;
        try {
          const summary = await options.gitService.getRepositorySummary({
            workspacePath: preparation.workspacePath,
          });
          if (summary.isRepository && summary.repoRoot === group.repoPath)
            sameBranchPreparation ??= "worktree preparation uses the same repository branch";
        } catch {
          sameBranchPreparation = "preparation repository inventory unavailable";
          break;
        }
      }
      if (sameBranchPreparation) {
        retain(group.targetPath, sameBranchPreparation);
        continue;
      }
      const remainingOwners = ownerTasks.filter((task) => task.deleted);
      let contentRemains = false;
      let allCountsAvailable = remainingOwners.length > 0 && Boolean(agent.countSessionTrees);
      for (const owner of remainingOwners) {
        if (!agent.countSessionTrees) {
          allCountsAvailable = false;
          break;
        }
        let ownerCounted = false;
        const countScopes = [
          ...new Set([
            owner.workspacePath,
            group.repoPath,
            ...allTaskMetas.map((task) => task.workspacePath),
          ]),
        ];
        for (const runtimePolicy of ["existing-only", "start-if-needed"] as const) {
          for (const workspacePath of countScopes) {
            try {
              const counts = await options.countTaskTrees(
                { workspacePath },
                [owner.taskId],
                runtimePolicy,
              );
              if (!counts) continue;
              ownerCounted = true;
              if (counts.total > 0) contentRemains = true;
              break;
            } catch {
              // Try another persisted repository scope if the owning workspace is gone.
            }
          }
          if (ownerCounted) break;
        }
        if (!ownerCounted) allCountsAvailable = false;
      }
      if (!allCountsAvailable || contentRemains) {
        retain(
          group.targetPath,
          contentRemains ? "session content remains" : "session content state unavailable",
        );
        continue;
      }
      const recordRemoved = () =>
        recordWorktreeRemoved(taskIndexRepo, ownerTasks, cleanup, group.targetPath);
      // Re-read every authoritative source immediately before Git mutation; any failed read retains the target.
      try {
        const [latestMetas, latestOpenPaths] = await Promise.all([
          options.listLocalTaskMetas(),
          options.getOpenWorkspacePaths(),
        ]);
        const latestPreparations = await Promise.resolve(
          options.taskIndexSyncer.listWorktreePreparations(),
        );
        const latestPaths = [
          group.targetPath,
          ...latestMetas.flatMap((task) =>
            task.executionWorktree?.path ? [task.executionWorktree.path] : [],
          ),
          ...latestOpenPaths,
          ...latestPreparations.map((entry) => entry.targetPath),
        ];
        const latestIdentities = await options.gitService.resolveWorktreePathIdentities({
          paths: latestPaths,
        });
        if (
          latestIdentities.length !== latestPaths.length ||
          latestIdentities.some((identity) => !identity)
        ) {
          throw new Error("incomplete canonical path inventory");
        }
        let latestOffset = 1;
        const latestOwnerIdentities = new Map<string, string>();
        for (const task of latestMetas) {
          if (!task.executionWorktree?.path) continue;
          latestOwnerIdentities.set(
            `${task.workspaceIdentity?.trim() || task.workspacePath}\0${task.taskId}`,
            latestIdentities[latestOffset++]!,
          );
        }
        const latestOpenIdentitySet = new Set(
          latestOpenPaths.map(() => latestIdentities[latestOffset++]!),
        );
        const latestPrepIdentitySet = new Set(
          latestPreparations.map(() => latestIdentities[latestOffset++]!),
        );
        const latestTargetIdentity = latestIdentities[0]!;
        if (
          [...latestOwnerIdentities.entries()].some(([key, identity]) => {
            const task = latestMetas.find(
              (entry) =>
                `${entry.workspaceIdentity?.trim() || entry.workspacePath}\0${entry.taskId}` ===
                key,
            );
            return identity === latestTargetIdentity && task && !task.deleted;
          })
        ) {
          retain(group.targetPath, "ownership changed before removal");
          continue;
        }
        if (latestOpenIdentitySet.has(latestTargetIdentity)) {
          retain(group.targetPath, "workspace opened before removal");
          continue;
        }
        if (latestPrepIdentitySet.has(latestTargetIdentity)) {
          retain(group.targetPath, "worktree preparation started before removal");
          continue;
        }
        const branchName = group.tasks[0]?.executionWorktree?.branchName;
        if (branchName) {
          let branchProtected = false;
          for (const task of latestMetas.filter(
            (entry) => entry.executionWorktree?.branchName === branchName,
          )) {
            try {
              let summary = await options.gitService.getRepositorySummary({
                workspacePath: task.workspacePath,
              });
              if (!summary.isRepository && task.executionWorktree?.path) {
                summary = await options.gitService.getRepositorySummary({
                  workspacePath: task.executionWorktree.path,
                });
              }
              if (summary.isRepository && summary.repoRoot === group.repoPath && !task.deleted) {
                branchProtected = true;
                break;
              }
            } catch {
              branchProtected = true;
              break;
            }
          }
          for (const preparation of latestPreparations) {
            if (preparation.branchName !== branchName) continue;
            const summary = await options.gitService.getRepositorySummary({
              workspacePath: preparation.workspacePath,
            });
            if (summary.isRepository && summary.repoRoot === group.repoPath) branchProtected = true;
          }
          if (branchProtected) {
            retain(group.targetPath, "branch ownership changed before removal");
            continue;
          }
        }
      } catch (error) {
        retain(
          group.targetPath,
          error instanceof Error
            ? `authoritative guard recheck unavailable: ${error.message}`
            : "authoritative guard recheck unavailable",
        );
        continue;
      }
      try {
        const removed = await options.gitService.removeWorktree({
          workspacePath: group.repoPath,
          targetPath: group.targetPath,
          force: true,
        });
        if (removed.ok) {
          await recordRemoved();
          continue;
        }
        try {
          await stat(group.targetPath);
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            (error.code === "ENOENT" || error.code === "ENOTDIR")
          ) {
            await recordRemoved();
            continue;
          }
          throw error;
        }
        fail(
          group.targetPath,
          removed.issues.map((issue) => issue.code).join(", ") || "Git rejected worktree removal",
        );
      } catch (error) {
        fail(group.targetPath, error instanceof Error ? error.message : "worktree removal failed");
      }
    }
    finalize();
  }
  return { cleanupWorktrees };
}

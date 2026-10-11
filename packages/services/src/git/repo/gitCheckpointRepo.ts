import { copyFile, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  GitCheckpointConflict,
  GitCheckpointDiff,
  GitCheckpointMeta,
  GitCheckpointRestoreResult,
} from "@zcode/shared";
import { getGitCheckpointIndexRootDir } from "../../paths.js";
import { toWorkspaceRelativeGitPath } from "../config.js";
import {
  createGitCommandProvider,
  type GitCommandProvider,
} from "../providers/gitCommandProvider.js";
import { createGitCliRepo, type GitCliRepo } from "./gitCliRepo.js";
import {
  buildAffectedRepoPaths,
  buildCheckpointEnv,
  getCheckpointRefName,
  getWorkspacePathspec,
  mergeCheckpointDiff,
  normalizeAffectedRepoPath,
  parseLsTree,
  parseNameStatus,
  parseNumstat,
  removeFileIfExists,
  toAbsolutePath,
} from "./gitCheckpointHelpers.js";
import { ensureGitCommandSucceeded } from "./gitCliHelpers.js";

interface GitCheckpointRepo {
  createCheckpoint(params: {
    workspacePath: string;
    checkpointId: string;
  }): Promise<GitCheckpointMeta>;
  diffCheckpoints(params: {
    workspacePath: string;
    from: GitCheckpointMeta;
    to: GitCheckpointMeta;
  }): Promise<GitCheckpointDiff>;
  restoreBetweenCheckpoints(params: {
    workspacePath: string;
    from: GitCheckpointMeta;
    to: GitCheckpointMeta;
    force?: boolean;
  }): Promise<GitCheckpointRestoreResult>;
  deleteCheckpoint(params: { workspacePath: string; checkpoint: GitCheckpointMeta }): Promise<void>;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export function createGitCheckpointRepo(options?: {
  commandProvider?: GitCommandProvider;
  gitRepo?: Pick<GitCliRepo, "resolveRepository">;
}): GitCheckpointRepo {
  const commandProvider = options?.commandProvider ?? createGitCommandProvider();
  const gitRepo = options?.gitRepo ?? createGitCliRepo({ commandProvider });

  async function ensureRepository(
    workspacePath: string,
  ): Promise<Awaited<ReturnType<typeof gitRepo.resolveRepository>>> {
    // All checkpoint operations require the current workspace to correspond to a real Git repository.
    // Resolve the repository and validate required capabilities here so individual methods do not make inconsistent checks.
    const resolution = await gitRepo.resolveRepository(workspacePath);
    if (!resolution.isGitAvailable) {
      throw new Error("Git binary is not available in the current environment.");
    }
    if (!resolution.isRepository) {
      throw new Error("Workspace is not inside a Git repository.");
    }
    return resolution;
  }

  async function computeCheckpointDiff(params: {
    workspacePath: string;
    from: GitCheckpointMeta;
    to: GitCheckpointMeta;
  }): Promise<GitCheckpointDiff> {
    // Calculate diffs between checkpoints only within the current workspace scope, not across the whole repository.
    // When a monorepo subdirectory is open, later restore/summary/conflict checks then stay within the current workspace boundary.
    const resolution = await ensureRepository(params.workspacePath);
    const pathspec = getWorkspacePathspec(resolution.workspaceInRepoPath);
    const [nameStatusResult, numstatResult] = await Promise.all([
      commandProvider.run({
        cwd: resolution.repoRoot,
        args: [
          "diff",
          "--name-status",
          "--find-renames",
          "-z",
          params.from.commitOid,
          params.to.commitOid,
          "--",
          pathspec,
        ],
      }),
      commandProvider.run({
        cwd: resolution.repoRoot,
        args: [
          "diff",
          "--numstat",
          "--find-renames",
          "-z",
          params.from.commitOid,
          params.to.commitOid,
          "--",
          pathspec,
        ],
      }),
    ]);
    ensureGitCommandSucceeded("git diff --name-status checkpoint", nameStatusResult);
    ensureGitCommandSucceeded("git diff --numstat checkpoint", numstatResult);

    // name-status identifies which files changed and the kind of each change; numstat provides added/removed counts.
    // Together they produce a structured checkpoint diff for callers rather than raw Git text output.
    return mergeCheckpointDiff({
      repoRoot: resolution.repoRoot,
      workspaceInRepoPath: resolution.workspaceInRepoPath,
      fromCheckpointId: params.from.checkpointId,
      toCheckpointId: params.to.checkpointId,
      nameStatusEntries: parseNameStatus(nameStatusResult.stdout),
      numstat: parseNumstat(numstatResult.stdout),
    });
  }

  async function collectWorkspaceConflicts(params: {
    repoRoot: string;
    workspaceInRepoPath: string;
    from: GitCheckpointMeta;
    affectedRepoPaths: string[];
  }): Promise<GitCheckpointConflict[]> {
    if (params.affectedRepoPaths.length === 0) {
      return [];
    }

    // Conflict detection does not ask whether the entire workspace is dirty. It checks whether the paths touched by restore
    // still match the caller-declared fromCheckpoint on disk.
    // This lets the lower-level operation remain safe when unrelated changes exist instead of treating the entire repository as unrestorable.
    const treeResult = await commandProvider.run({
      cwd: params.repoRoot,
      args: ["ls-tree", "-r", "-z", params.from.commitOid, "--", ...params.affectedRepoPaths],
    });
    ensureGitCommandSucceeded("git ls-tree checkpoint paths", treeResult);
    const treeEntries = parseLsTree(treeResult.stdout);

    const conflicts: GitCheckpointConflict[] = [];
    for (const repoRelativePath of params.affectedRepoPaths) {
      const absolutePath = toAbsolutePath(params.repoRoot, repoRelativePath);
      const expectedEntry = treeEntries.get(repoRelativePath);

      if (!expectedEntry) {
        // If this path is absent from fromCheckpoint, it should not exist on disk according to the baseline.
        // If it exists now, the user or another process added it after the checkpoint, creating an overwrite risk.
        if (!(await pathExists(absolutePath))) {
          continue;
        }
        conflicts.push({
          path: absolutePath,
          repoRelativePath,
          workspaceRelativePath: toWorkspaceRelativeGitPath(
            repoRelativePath,
            params.workspaceInRepoPath,
          ),
          reason: "unexpected-file-in-worktree",
        });
        continue;
      }

      let stats: Awaited<ReturnType<typeof lstat>>;
      try {
        stats = await lstat(absolutePath);
      } catch {
        // fromCheckpoint says this file should exist, but it is now missing from disk. Writing it back directly during restore
        // would overwrite the user's actual action that caused the file to disappear, so report a conflict first.
        conflicts.push({
          path: absolutePath,
          repoRelativePath,
          workspaceRelativePath: toWorkspaceRelativeGitPath(
            repoRelativePath,
            params.workspaceInRepoPath,
          ),
          reason: "missing-in-worktree",
        });
        continue;
      }

      const expectsSymlink = expectedEntry.mode === "120000";
      if (stats.isDirectory() || (expectsSymlink && !stats.isSymbolicLink())) {
        // The current implementation handles only file states Git can represent reliably. If the checkpoint expects a file/symlink
        // but the disk now contains a directory or another type, a direct restore could have mismatched semantics; treat it as a type conflict.
        conflicts.push({
          path: absolutePath,
          repoRelativePath,
          workspaceRelativePath: toWorkspaceRelativeGitPath(
            repoRelativePath,
            params.workspaceInRepoPath,
          ),
          reason: "type-mismatch",
        });
        continue;
      }

      const hashResult = await commandProvider.run({
        cwd: params.repoRoot,
        args: ["hash-object", "--no-filters", absolutePath],
      });
      ensureGitCommandSucceeded("git hash-object checkpoint verify", hashResult);
      if (hashResult.stdout.trim() === expectedEntry.objectId) {
        continue;
      }

      // Compare blob hashes directly instead of weak signals such as timestamps or sizes.
      // Treat the disk as still matching the fromCheckpoint baseline only when the contents are identical.
      conflicts.push({
        path: absolutePath,
        repoRelativePath,
        workspaceRelativePath: toWorkspaceRelativeGitPath(
          repoRelativePath,
          params.workspaceInRepoPath,
        ),
        reason: "content-mismatch",
      });
    }

    const deduped = new Map<string, GitCheckpointConflict>();
    for (const conflict of conflicts) {
      deduped.set(conflict.repoRelativePath, conflict);
    }
    return [...deduped.values()];
  }

  return {
    /**
     * Create an immutable snapshot of workspace files.
     *
     * Overall flow:
     * 1. Resolve the Git repository and scope for the workspace.
     * 2. Collect the current live worktree state with a temporary GIT_INDEX_FILE.
     * 3. Generate an internal hidden commit through write-tree / commit-tree.
     * 4. Keep the commit reachable with a hidden ref so Git GC does not remove it early.
     * 5. Return the metadata needed by the manifest.
     *
     * Key constraints:
     * - Do not modify the user's real index.
     * - Do not create user-visible branches or ordinary commits.
     * - Always follow the current workspace scope rather than snapshotting the whole repository indiscriminately.
     */
    async createCheckpoint(params) {
      const resolution = await ensureRepository(params.workspacePath);
      const refName = getCheckpointRefName(params.workspacePath, params.checkpointId);
      const tempIndexRootDir = getGitCheckpointIndexRootDir();
      await mkdir(tempIndexRootDir, { recursive: true });
      const tempIndexDir = await mkdtemp(resolve(tempIndexRootDir, "index-"));
      const tempIndexPath = resolve(tempIndexDir, "index");
      const env = buildCheckpointEnv(tempIndexPath);
      const pathspec = getWorkspacePathspec(resolution.workspaceInRepoPath);

      try {
        // Warm the temporary index: first copy the user's real index, fall back to read-tree HEAD, and finally to an empty index.
        // Background: with an empty index, git add -A opens, reads, hashes, and writes every workspace file to the object store.
        // On Windows + Defender, per-file cost grows to 5–15 ms, so a large repository easily exceeds the 15 s timeout.
        // Reusing the user's index stat cache lets unchanged files take the stat-match fast path, skipping reads and object writes.
        // Mac/Linux benefit too (large-repository add drops from seconds to subsecond), and the final tree still comes from the worktree, so semantics are equivalent.
        // Resolve the real index path with rev-parse --git-path index for worktree/submodule compatibility.
        const indexPathResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["rev-parse", "--git-path", "index"],
        });
        let primed = false;
        if (indexPathResult.exitCode === 0) {
          const indexRelPath = indexPathResult.stdout.trim();
          if (indexRelPath.length > 0) {
            const userIndexPath = resolve(resolution.repoRoot, indexRelPath);
            try {
              await copyFile(userIndexPath, tempIndexPath);
              primed = true;
            } catch {
              // Fall back if the user's index is missing (a newly initialized empty repository) or inaccessible.
            }
          }
        }
        if (!primed) {
          // If there is no index to copy, populate the temporary index from the HEAD tree so tracked files at least use the hash-match path.
          // If HEAD does not exist (a new repository), read-tree fails; allow a quiet fallback to an empty index.
          const readTreeResult = await commandProvider.run({
            cwd: resolution.repoRoot,
            args: ["read-tree", "HEAD"],
            env,
          });
          if (readTreeResult.exitCode === 0) {
            primed = true;
          }
        }

        // Core implementation: freeze the current live workspace state into a hidden commit through a temporary GIT_INDEX_FILE.
        // This reuses Git's object storage without modifying the user's real index/staged state.
        const addResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["add", "-A", "--", pathspec],
          env,
        });
        ensureGitCommandSucceeded("git add checkpoint", addResult);

        // The temporary index now contains the full state for the current workspace scope; freeze it into a tree object next.
        const treeResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["write-tree"],
          env,
        });
        ensureGitCommandSucceeded("git write-tree checkpoint", treeResult);

        // A checkpoint does not need to appear in the user's branch history, but the Git object needs a stable anchor.
        // Create an internal commit here, then point a hidden ref to it.
        const commitResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: [
            "commit-tree",
            treeResult.stdout.trim(),
            "-m",
            `zcode checkpoint ${params.checkpointId}`,
          ],
          env,
        });
        ensureGitCommandSucceeded("git commit-tree checkpoint", commitResult);
        const commitOid = commitResult.stdout.trim();

        // The hidden ref is the checkpoint's long-term reference. It ensures:
        // 1. Git does not garbage-collect the object.
        // 2. Later diff/restore/delete operations can reliably find the commit by refName.
        const updateRefResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["update-ref", refName, commitOid],
        });
        ensureGitCommandSucceeded("git update-ref checkpoint", updateRefResult);

        return {
          checkpointId: params.checkpointId,
          workspacePath: params.workspacePath,
          repoRoot: resolution.repoRoot,
          workspaceInRepoPath: resolution.workspaceInRepoPath,
          createdAt: Date.now(),
          refName,
          commitOid,
          scope: "workspace",
        };
      } finally {
        // The temporary index is used only to build this checkpoint and must be removed afterward so it does not leak into the host environment.
        await rm(tempIndexDir, { recursive: true, force: true });
      }
    },

    /**
     * Compare file changes between two checkpoints within the current workspace scope.
     *
     * This method does not know about ZCode Agent/task/turn; it answers a file-only question:
     * "Between fromCheckpoint and toCheckpoint, what changed in this workspace scope?"
     *
     * The result is reused by restore, future summary features, and potentially debugging tools, so this method remains read-only and side-effect free.
     */
    async diffCheckpoints(params) {
      return await computeCheckpointDiff(params);
    },

    /**
     * Safely restore the current live workspace from fromCheckpoint to toCheckpoint.
     *
     * This is the core method of the subsystem. Its semantics are not "restore directly to a checkpoint,"
     * but a three-way comparison:
     * - Caller expectation: disk should still match fromCheckpoint.
     * - Desired result: restore file state to toCheckpoint.
     * - Current reality: the user or another process may have changed the disk since then.
     *
     * The operation order is:
     * 1. Calculate the paths affected by from -> to.
     * 2. Check whether those paths still match fromCheckpoint on disk.
     * 3. Return conflicts without overwriting when any are found.
     * 4. If there are no conflicts or force=true, write toCheckpoint contents back to the worktree.
     * 5. Validate again to ensure the actual restored disk matches toCheckpoint.
     */
    async restoreBetweenCheckpoints(params) {
      const resolution = await ensureRepository(params.workspacePath);
      const diff = await computeCheckpointDiff({
        workspacePath: params.workspacePath,
        from: params.from,
        to: params.to,
      });
      // The diff may include both the current path and the old path before a rename.
      // Collapse them into the final set of affected paths; later conflict checks and deletion use this set.
      const affectedRepoPaths = buildAffectedRepoPaths(diff.files).map((path) =>
        normalizeAffectedRepoPath(resolution.repoRoot, path),
      );

      if (affectedRepoPaths.length === 0) {
        return {
          success: true,
          restoredPaths: [],
        };
      }

      const conflicts = await collectWorkspaceConflicts({
        repoRoot: resolution.repoRoot,
        workspaceInRepoPath: resolution.workspaceInRepoPath,
        from: params.from,
        affectedRepoPaths,
      });
      if (conflicts.length > 0 && params.force !== true) {
        // In default mode, refuse to write as soon as an affected path differs from fromCheckpoint.
        // This lets the caller show the conflict to the user instead of silently overwriting their newer changes.
        return {
          success: false,
          conflicts,
        };
      }

      const restoreRepoPaths = diff.files
        .filter((file) => file.kind !== "deleted")
        .map((file) => file.repoRelativePath);
      if (restoreRepoPaths.length > 0) {
        // Restore changes only the worktree, not the real index. This keeps rollback as "file-state restoration"
        // instead of silently making a destructive change to the user's staging area.
        const restoreResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: [
            "restore",
            `--source=${params.to.commitOid}`,
            "--worktree",
            "--",
            ...restoreRepoPaths,
          ],
        });
        ensureGitCommandSucceeded("git restore checkpoint", restoreResult);
      }

      const deleteAbsolutePaths = new Set<string>();
      for (const file of diff.files) {
        if (file.kind === "deleted") {
          // These paths are absent from toCheckpoint, so remove any remaining entities from the live worktree after restore.
          deleteAbsolutePaths.add(file.path);
          continue;
        }
        if (file.kind === "renamed" && file.originalPath) {
          // For renames, git restore restores only the new path's contents;
          // explicitly delete the old path to avoid leaving both files in place.
          deleteAbsolutePaths.add(file.originalPath);
        }
      }
      for (const path of deleteAbsolutePaths) {
        await removeFileIfExists(path);
      }

      const verifyConflicts = await collectWorkspaceConflicts({
        repoRoot: resolution.repoRoot,
        workspaceInRepoPath: resolution.workspaceInRepoPath,
        from: params.to,
        affectedRepoPaths,
      });
      if (verifyConflicts.length > 0) {
        // There should be no remaining differences here. If there are, restore did not put the disk into the target state.
        // Returning success would make the incorrect state permanent, so throw and report the failure to the caller.
        throw new Error("Checkpoint restore verification failed.");
      }

      return {
        success: true,
        restoredPaths: diff.files.map((file) => file.path),
      };
    },

    /**
     * Delete the Git reference for a checkpoint.
     *
     * This method deletes only the hidden ref; the caller's store/service deletes the manifest.
     * This keeps Git object reference management in the repo layer and local metadata-file management in the store layer.
     */
    async deleteCheckpoint(params) {
      const resolution = await ensureRepository(params.workspacePath);
      const deleteRefResult = await commandProvider.run({
        cwd: resolution.repoRoot,
        args: ["update-ref", "-d", params.checkpoint.refName],
      });
      ensureGitCommandSucceeded("git update-ref -d checkpoint", deleteRefResult, [0, 1]);
    },
  };
}

export type { GitCheckpointRepo };

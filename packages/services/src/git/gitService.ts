/* eslint-disable max-lines */
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  GitBranchComparison,
  GitBranchMergeStatus,
  GitFileChange,
  GitChangeSectionId,
  GitWorktreeRemovalPreview,
} from "@zcode/shared";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import { toWorkspaceRelativeGitPath } from "./config.js";
import { matchesWorkspaceScope, toAbsolutePath } from "./gitServicePathHelpers.js";
import { filterCommitMessageFilesByCurrentSession } from "./commitMessageFileScope.js";
import type { IGitService } from "./git.js";
import type { GitCommitMessageGenerator } from "./gitCommitMessageGenerator.js";
import { createGitCommandProvider } from "./providers/gitCommandProvider.js";
import { createGhCommandProvider } from "./providers/ghCommandProvider.js";
import {
  createSessionPullRequestsService,
  type SessionPullRequestsService,
} from "./sessionPullRequestsService.js";
import {
  createGitCliRepo,
  type GitBranchComparisonChange,
  type GitBranchComparisonSnapshot,
  type GitCliRepo,
  type GitStatusEntry,
  type GitStatusSnapshot,
} from "./repo/gitCliRepo.js";

function buildFileChange(
  snapshot: GitStatusSnapshot,
  entry: GitStatusEntry,
  section: GitChangeSectionId,
  added: number,
  removed: number,
): GitFileChange {
  return {
    path: toAbsolutePath(snapshot.resolution.repoRoot, entry.path),
    repoRelativePath: entry.path,
    workspaceRelativePath: toWorkspaceRelativeGitPath(
      entry.path,
      snapshot.summary.workspaceInRepoPath,
    ),
    x: entry.x ?? undefined,
    y: entry.y ?? undefined,
    kind: entry.kind,
    section,
    added,
    removed,
    isStaged: section === "staged",
    isUntracked: section === "untracked",
    isConflicted: section === "conflicted",
  };
}

function shouldIncludeUntrackedChange(
  entry: GitStatusEntry,
  stat: { added: number; removed: number },
): boolean {
  // Build directories commonly contain many untracked empty files, broken links, or unreadable artifacts.
  // These entries have no reviewable text changes and used to appear as +0/-0 in the Review panel, cluttering the list and slowing it down.
  // When detailed status exceeds the limit, however, Git represents an entire untracked directory with a trailing `/`; the directory itself is unreadable,
  // so its line count is always zero, but it must remain as a fallback entry that can be staged/discarded.
  return entry.path.endsWith("/") || stat.added > 0 || stat.removed > 0;
}

function toChangeForSource(
  snapshot: GitStatusSnapshot,
  entry: GitStatusEntry,
  sourceId: "unstaged" | "staged",
): GitFileChange | null {
  if (!matchesWorkspaceScope(snapshot.summary.workspaceInRepoPath, entry)) {
    return null;
  }

  if (sourceId === "staged") {
    if (entry.isUntracked || entry.isConflicted || !entry.x || entry.x === ".") {
      return null;
    }

    const stat = snapshot.stagedStats.get(entry.path) ?? {
      added: 0,
      removed: 0,
    };
    return buildFileChange(snapshot, entry, "staged", stat.added, stat.removed);
  }

  if (entry.isConflicted) {
    return buildFileChange(snapshot, entry, "conflicted", 0, 0);
  }

  if (entry.isUntracked) {
    const stat = snapshot.untrackedStats.get(entry.path) ?? {
      added: 0,
      removed: 0,
    };
    if (!shouldIncludeUntrackedChange(entry, stat)) {
      return null;
    }
    return buildFileChange(snapshot, entry, "untracked", stat.added, stat.removed);
  }

  if (!entry.y || entry.y === ".") {
    return null;
  }

  const stat = snapshot.unstagedStats.get(entry.path) ?? {
    added: 0,
    removed: 0,
  };
  return buildFileChange(snapshot, entry, "unstaged", stat.added, stat.removed);
}

function getChangesForSource(
  snapshot: GitStatusSnapshot,
  sourceId: "unstaged" | "staged",
): GitFileChange[] {
  return snapshot.entries
    .map((entry) => toChangeForSource(snapshot, entry, sourceId))
    .filter((entry): entry is GitFileChange => Boolean(entry));
}

function toRemovalPreviewStatus(entry: GitStatusEntry): string {
  if (entry.isUntracked) return "??";
  const codes = [entry.x, entry.y].filter((code) => code && code !== ".").join("");
  return codes || "M";
}

/**
 * Deletion preview for a forced worktree removal. Unlike getChanges it keeps every untracked entry:
 * the review filter drops zero-stat files (binary, over the stat size limit, unreadable), which force
 * removal still deletes. An unavailable or mismatched repository throws so callers report "unknown".
 */
async function buildWorktreeRemovalPreview(
  snapshot: GitStatusSnapshot,
  workspacePath: string,
): Promise<GitWorktreeRemovalPreview> {
  const { resolution } = snapshot;
  if (!resolution.isGitAvailable) throw new Error("Git is unavailable");
  if (!resolution.isRepository) throw new Error("Worktree path is not a Git repository");
  const [repoRoot, worktreeRoot] = await Promise.all([
    realpath(resolution.repoRoot),
    realpath(workspacePath),
  ]);
  if (repoRoot !== worktreeRoot) {
    throw new Error("Worktree path is not the root of its Git repository");
  }
  return {
    files: snapshot.entries.map((entry) => ({
      path: entry.path,
      status: toRemovalPreviewStatus(entry),
    })),
  };
}

function toBranchComparisonChange(
  snapshot: GitBranchComparisonSnapshot,
  change: GitBranchComparisonChange,
): GitFileChange | null {
  if (!matchesWorkspaceScope(snapshot.resolution.workspaceInRepoPath, change)) {
    return null;
  }

  return {
    path: toAbsolutePath(snapshot.resolution.repoRoot, change.path),
    repoRelativePath: change.path,
    workspaceRelativePath: toWorkspaceRelativeGitPath(
      change.path,
      snapshot.resolution.workspaceInRepoPath,
    ),
    kind: change.kind,
    section: "branch",
    added: change.added,
    removed: change.removed,
    isStaged: false,
    isUntracked: false,
    isConflicted: false,
  };
}

const COMMIT_MESSAGE_DIFF_FILE_LIMIT = 8;

// merged-session-highlight spec: the merge observation is cached for 60s;
// branch switches and new commits invalidate it immediately.
const BRANCH_MERGE_STATUS_TTL_MS = 60_000;

interface BranchMergeStatusCacheEntry {
  workspacePath: string;
  headRef: string | null;
  status: GitBranchMergeStatus;
  fetchedAt: number;
}

function getCommitMessageDiffQueries(
  files: readonly GitFileChange[],
  includeUnstaged: boolean,
): Array<{ path: string; sourceId: "unstaged" | "staged" }> {
  const queries: Array<{ path: string; sourceId: "unstaged" | "staged" }> = [];
  for (const file of files.slice(0, COMMIT_MESSAGE_DIFF_FILE_LIMIT)) {
    if (file.section === "staged") {
      queries.push({ path: file.path, sourceId: "staged" });
      continue;
    }

    if (!includeUnstaged) {
      continue;
    }

    queries.push({ path: file.path, sourceId: "unstaged" });
  }
  return queries;
}

export function createGitService(options?: {
  repo?: GitCliRepo;
  commitMessageGenerator?: GitCommitMessageGenerator;
  logger?: ServiceLogger;
  now?: () => number;
  sessionPullRequests?: SessionPullRequestsService;
}): IGitService {
  const repo = options?.repo ?? createGitCliRepo();
  const branchMergeLog = options?.logger ?? createServiceLogger("branch-merge-status");
  const now = options?.now ?? Date.now;
  const sessionPullRequests =
    options?.sessionPullRequests ??
    createSessionPullRequestsService({
      repo,
      gitRunner: createGitCommandProvider(),
      gh: createGhCommandProvider(),
      logger: options?.logger,
      now,
    });
  const branchMergeStatusCache = new Map<string, BranchMergeStatusCacheEntry>();
  // Bugfix: проба, ожидающая repo.getBranchMergeStatus, могла дописать в кэш
  // результат, вычисленный ДО инвалидации (смена ветки/коммит во время полёта),
  // и снова отравить кэш до конца TTL. Generation per key инкрементируется при
  // инвалидации; запись разрешена только неизменившемуся поколению. Ключ
  // регистрируется на СТАРТЕ пробы — в полёте кэш-записи ещё нет, а инвалидация
  // обязана добраться и до неё.
  const branchMergeGeneration = new Map<string, number>();
  const branchMergeKeyWorkspaces = new Map<string, string>();

  function workspaceMergeCacheKey(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): string {
    return params.workspaceIdentity?.trim() || params.workspacePath;
  }

  function invalidateBranchMergeStatus(workspacePath: string): void {
    for (const [key, registeredPath] of branchMergeKeyWorkspaces) {
      if (registeredPath === workspacePath) {
        branchMergeStatusCache.delete(key);
        branchMergeGeneration.set(key, (branchMergeGeneration.get(key) ?? 0) + 1);
      }
    }
  }

  return {
    async getWorktreeStorageInfo(_params) {
      return { globalWorktreesDir: join(homedir(), ".zcode", "worktrees") };
    },
    async getRepositorySummary(params) {
      const status = await repo.getStatus(params.workspacePath);
      return status.summary;
    },

    async getWorkspaceRepositoryInfo(params) {
      return await repo.getWorkspaceRepositoryInfo(params.workspacePath);
    },

    async getRepositoryRemotes(params) {
      return await repo.getRepositoryRemotes(params.workspacePath);
    },

    async getLocalBranches(params) {
      return await repo.listLocalBranches(params.workspacePath);
    },

    async getCommitGraph(params) {
      const snapshot = await repo.getCommitGraph(
        params.workspacePath,
        params.maxCount,
        params.skip,
      );
      return {
        commits: snapshot.commits,
        hasMore: snapshot.hasMore,
      };
    },

    async switchBranch(params) {
      const result = await repo.switchBranch(params.workspacePath, params.targetBranchName);
      invalidateBranchMergeStatus(params.workspacePath);
      return result;
    },

    async createBranchAndSwitch(params) {
      const result = await repo.createBranchAndSwitch(
        params.workspacePath,
        params.branchName,
        params.startPoint,
      );
      invalidateBranchMergeStatus(params.workspacePath);
      return result;
    },

    async listWorktrees(params) {
      return await repo.listWorktrees(params.workspacePath);
    },

    async resolveWorktreePathIdentities(params) {
      return await repo.resolveWorktreePathIdentities(params.paths);
    },

    async verifyWorktreeUsable(params) {
      return await repo.verifyWorktreeUsable(params.workspacePath, params.targetPath);
    },

    async ensureWorktreeExclusion(params) {
      return await repo.ensureWorktreeExclusion(params.workspacePath, params.targetPath);
    },

    async createWorktree(params) {
      return await repo.createWorktree(
        params.workspacePath,
        params.branchName,
        params.targetPath,
        params.baseBranch,
      );
    },

    async removeWorktree(params) {
      return await repo.removeWorktree(params.workspacePath, params.targetPath, params.force);
    },

    async pruneWorktrees(params) {
      return await repo.pruneWorktrees(params.workspacePath);
    },

    async getChanges(params) {
      const status = await repo.getStatus(params.workspacePath);

      // A workspace may be a subdirectory of a monorepo, so scope results here in the service layer.
      // The repo remains responsible only for parsing raw Git status, while callers always receive data within the current workspace boundary.
      return getChangesForSource(status, params.sourceId);
    },

    async getWorktreeRemovalPreview(params) {
      const status = await repo.getStatus(params.workspacePath);
      return await buildWorktreeRemovalPreview(status, params.workspacePath);
    },

    async getIgnoredPaths(params) {
      return await repo.getIgnoredPaths(params.workspacePath, params.paths);
    },

    async getDiff(params) {
      return await repo.getDiff(params);
    },

    async getBranchComparison(params): Promise<GitBranchComparison> {
      const comparison = await repo.getBranchComparison(params.workspacePath);
      return {
        baseRef: comparison.baseRef,
        headRef: comparison.headRef,
        comparisonLabel: comparison.comparisonLabel,
        changes: comparison.changes
          .map((change) => toBranchComparisonChange(comparison, change))
          .filter((change): change is GitFileChange => Boolean(change)),
      };
    },

    async getBranchMergeStatus(params): Promise<GitBranchMergeStatus> {
      const key = workspaceMergeCacheKey(params);
      const cached = branchMergeStatusCache.get(key);
      if (cached && now() - cached.fetchedAt < BRANCH_MERGE_STATUS_TTL_MS) {
        // Bugfix: ключ кэша не содержал ветку, и внешний checkout (мимо
        // инвалидаций приложения) до 60 с подавал статус предыдущей ветки.
        // Попадание принимается только при совпадении HEAD: один дешёвый
        // symbolic-ref вместо полной пробы; HEAD не читается — принимаем.
        const headBranch = await repo.readHeadBranch(params.workspacePath);
        const headMoved =
          headBranch !== null &&
          cached.status.headRef !== null &&
          headBranch !== cached.status.headRef;
        if (!headMoved) {
          return cached.status;
        }
      }

      const generation = branchMergeGeneration.get(key) ?? 0;
      branchMergeKeyWorkspaces.set(key, params.workspacePath);
      const status = await repo.getBranchMergeStatus(params.workspacePath);
      if ((branchMergeGeneration.get(key) ?? 0) === generation) {
        branchMergeStatusCache.set(key, {
          workspacePath: params.workspacePath,
          headRef: status.headRef,
          status,
          fetchedAt: now(),
        });
      }
      if (cached && cached.status.state !== status.state) {
        branchMergeLog.info(undefined, "branch merge state changed", {
          workspacePath: params.workspacePath,
          previous: cached?.status.state ?? null,
          next: status.state,
          headRef: status.headRef,
          baseRef: status.baseRef,
        });
      }
      return status;
    },

    async getSessionPullRequests(params) {
      return await sessionPullRequests.getSessionPullRequests(params);
    },

    async stagePaths(params) {
      await repo.stage(params.workspacePath, params.paths);
    },

    async unstagePaths(params) {
      await repo.unstage(params.workspacePath, params.paths);
    },

    async discardPaths(params) {
      await repo.discard(params.workspacePath, params.paths, params.staged ?? false);
    },

    async generateCommitMessage(params) {
      if (!options?.commitMessageGenerator) {
        throw new Error("Commit message generation is not available.");
      }

      const includeUnstaged = (params as { includeUnstaged?: boolean }).includeUnstaged ?? true;
      const status = await repo.getStatus(params.workspacePath);
      const unstagedChanges = includeUnstaged ? getChangesForSource(status, "unstaged") : [];
      const stagedChanges = getChangesForSource(status, "staged");
      const files = filterCommitMessageFilesByCurrentSession({
        files: [...unstagedChanges, ...stagedChanges],
        workspacePath: params.workspacePath,
        repoRoot: status.resolution.repoRoot,
        workspaceInRepoPath: status.resolution.workspaceInRepoPath,
        currentSessionFilePaths: params.currentSessionFilePaths,
      });
      if (files.length === 0) {
        throw new Error("There are no changes available to commit.");
      }

      const diffQueries = getCommitMessageDiffQueries(files, includeUnstaged);
      const diffResults = await Promise.allSettled(
        diffQueries.map((query) =>
          repo.getDiff({
            workspacePath: params.workspacePath,
            path: query.path,
            sourceId: query.sourceId,
          }),
        ),
      );
      const diffs = diffResults.flatMap((result) =>
        result.status === "fulfilled" && (result.value.patch || result.value.summary)
          ? [result.value]
          : [],
      );

      return await options.commitMessageGenerator.generate({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        ...(params.locale ? { locale: params.locale } : {}),
        branchName: status.summary.branchName,
        files,
        diffs,
        ...(params.conversationContext ? { conversationContext: params.conversationContext } : {}),
      });
    },

    async commit(params) {
      const result = await repo.commit(params.workspacePath, params.message, params.paths, {
        stagedOnly: params.stagedOnly,
      });
      invalidateBranchMergeStatus(params.workspacePath);
      const status = await repo.getStatus(params.workspacePath);
      return {
        commitHash: result.commitHash,
        summary: status.summary,
      };
    },

    async push(params) {
      const result = await repo.push(params.workspacePath);
      return result;
    },

    async getIdentity(params) {
      return await repo.getIdentity(params.workspacePath);
    },

    async refresh(params) {
      const statusPromise = repo.getStatus(params.workspacePath);
      const identityPromise = params.includeIdentity
        ? repo.getIdentity(params.workspacePath)
        : Promise.resolve(null);
      const branchComparisonPromise = params.includeBranchComparison
        ? repo.getBranchComparison(params.workspacePath)
        : Promise.resolve(null);
      const [statusResult, identityResult, comparisonResult] = await Promise.allSettled([
        statusPromise,
        identityPromise,
        branchComparisonPromise,
      ]);
      if (statusResult.status === "rejected") throw statusResult.reason;
      if (identityResult.status === "rejected") throw identityResult.reason;
      const status = statusResult.value;
      const identity = identityResult.value;
      // Comparison is auxiliary: disclose its failure without losing the current status snapshot.
      const branchComparisonSnapshot =
        comparisonResult.status === "fulfilled" ? comparisonResult.value : null;
      const branchComparisonError =
        comparisonResult.status === "rejected"
          ? comparisonResult.reason instanceof Error
            ? comparisonResult.reason.message || comparisonResult.reason.name
            : String(comparisonResult.reason)
          : null;
      const branchComparison: GitBranchComparison | null = branchComparisonSnapshot
        ? {
            baseRef: branchComparisonSnapshot.baseRef,
            headRef: branchComparisonSnapshot.headRef,
            comparisonLabel: branchComparisonSnapshot.comparisonLabel,
            changes: branchComparisonSnapshot.changes
              .map((change) => toBranchComparisonChange(branchComparisonSnapshot, change))
              .filter((change): change is GitFileChange => Boolean(change)),
          }
        : null;

      // The UI's automatic refresh used to call three RPCs concurrently for summary, unstaged, and staged,
      // each rerunning git status. When the agent writes many files, this leaves the renderer stuck with
      // repeated Git I/O and RPC logs. refresh derives all three results from one status snapshot.
      return {
        summary: status.summary,
        identity,
        unstagedChanges: getChangesForSource(status, "unstaged"),
        stagedChanges: getChangesForSource(status, "staged"),
        branchComparison,
        branchComparisonError,
      };
    },
  };
}

/**
 * Shared createWorktree orchestration for both creation entries — the palette setup page
 * Start and the empty-state "New worktree" setup pipeline (specs/composer-worktree-setup-steps.md):
 * same request shape, same issue→message mapping, and the same target-path-exists recovery
 * that lists worktrees and consumes the existing directory for the branch instead of a second one.
 *
 * Unlike the pure functions in worktreeTaskFlow, this module calls gitService and logs; both
 * gitService and message formatting are injected so the two entry points (palette, empty-state) share one semantics.
 */
import type {
  GitLocalBranchListResult,
  GitWorktreeCreateResult,
  GitWorktreeExcludeResult,
  GitWorktreeListResult,
  GitWorktreeVerifyResult,
} from "@zcode/shared";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";
import {
  findWorktreeForBranch,
  resolveWorktreeIssueMessageId,
} from "@/command-center/worktreeTaskFlow.js";

/** Git service surface consumed by the shared creation orchestration (injected for tests). */
export interface WorktreeCreationGitService {
  createWorktree(params: {
    workspacePath: string;
    branchName: string;
    baseBranch?: string;
    targetPath: string;
  }): Promise<GitWorktreeCreateResult>;
  listWorktrees(params: { workspacePath: string }): Promise<GitWorktreeListResult>;
  /**
   * Optional local-branch probe used by the queue-time preflight (unborn HEAD / missing base
   * branch). Absent or failing probes never block Send — the base degrades to HEAD instead.
   */
  getLocalBranches?(params: { workspacePath: string }): Promise<GitLocalBranchListResult>;
  /** Verify the registered worktree's real directory on the target Host before reuse. */
  verifyWorktreeUsable(params: {
    workspacePath: string;
    targetPath: string;
  }): Promise<GitWorktreeVerifyResult>;
  /** Keep an inside-placement worktree out of the main checkout's Review status (best-effort). */
  ensureWorktreeExclusion(params: {
    workspacePath: string;
    targetPath: string;
  }): Promise<GitWorktreeExcludeResult>;
}

/** Result of one worktree-creation attempt, shared by the palette Start and the empty-state send interception. */
export type WorktreeCreationOutcome =
  | { kind: "created"; worktreePath: string }
  /** target-path-exists with an existing worktree for the branch (WT-04): open the existing directory instead of creating a second one. */
  | { kind: "existing-worktree"; worktreePath: string; message: string }
  | {
      kind: "failed";
      message: string;
      /** Issue codes the server rejected with (logging only); empty when the request threw. */
      issueCodes: readonly string[];
      /** Error text from a thrown request (logging only); null when the server rejected. */
      errorDetail: string | null;
      /** Primary issue code of the rejection; null when the request threw or Git classified nothing. */
      issueCode: string | null;
      /**
       * Raw technical detail (Git stderr, or the thrown request's error text) for the failure
       * modal's expandable block. Memory-only: callers must not persist or log it.
       */
      rawDetail: string | null;
    };

/**
 * Inside-placement worktrees (`<repoRoot>/.worktrees/<branch>`) would otherwise show `.worktrees/`
 * as untracked in the main checkout's Review. Awaited so the exclusion is in place before the
 * caller refreshes Git status; a failure only logs and never changes the creation outcome.
 */
export async function ensureWorktreeExclusionSafely(
  gitService: WorktreeCreationGitService,
  workspacePath: string,
  targetPath: string,
): Promise<void> {
  try {
    const exclusion = await gitService.ensureWorktreeExclusion({ workspacePath, targetPath });
    if (!exclusion.ok) {
      logger.warn("[WorktreeTask] worktree exclusion was not written", {
        workspacePath,
        targetPath,
      });
    }
  } catch (error) {
    logger.warn("[WorktreeTask] worktree exclusion request failed", {
      workspacePath,
      targetPath,
      error: getErrorMessage(error),
    });
  }
}

/**
 * Git's own failure line for an unclassified rejection: the first `fatal:`/`error:` line with the
 * prefix removed, else the last non-empty line. `git worktree add` prints a "Preparing worktree"
 * progress line on stderr before the failure, so the first line alone is not the cause.
 */
function summarizeGitFailureDetail(detail: string | null | undefined): string | null {
  const lines = (detail ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const failure = lines.find((line) => /^(fatal|error):/i.test(line)) ?? lines.at(-1);
  if (!failure) return null;
  return failure.replace(/^(fatal|error):\s*/i, "") || null;
}

/** Optional delay for controlled manual/E2E verification; normal app flows have no artificial wait. */
function waitForWorktreeCreationTestGate(): Promise<void> {
  const delayMs = Number(import.meta.env["VITE_E2E_WORKTREE_CREATION_DELAY_MS"] ?? 0);
  if (!Number.isFinite(delayMs) || delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Run one creation attempt for both entries: `formatMessage` formats the shared worktree
 * copy; callers keep their own logging scope and busy/inline-error states.
 */
export async function executeWorktreeCreation({
  gitService,
  workspacePath,
  branchName,
  baseBranch,
  targetPath,
  formatMessage,
}: {
  gitService: WorktreeCreationGitService;
  workspacePath: string;
  branchName: string;
  baseBranch?: string;
  targetPath: string;
  formatMessage: (id: string, values?: Record<string, string>) => string;
}): Promise<WorktreeCreationOutcome> {
  let result: GitWorktreeCreateResult;
  try {
    await waitForWorktreeCreationTestGate();
    result = await gitService.createWorktree({
      workspacePath,
      branchName,
      ...(baseBranch ? { baseBranch } : {}),
      targetPath,
    });
  } catch (error) {
    const errorDetail = getErrorMessage(error);
    return {
      kind: "failed",
      message: formatMessage("commandCenter.worktree.error.requestFailed", {
        error: errorDetail,
      }),
      issueCodes: [],
      errorDetail,
      issueCode: null,
      rawDetail: errorDetail,
    };
  }

  if (result.ok) {
    const worktreePath = result.worktreePath ?? targetPath;
    await ensureWorktreeExclusionSafely(gitService, workspacePath, worktreePath);
    return { kind: "created", worktreePath };
  }

  const issue = result.issues[0];
  if (issue?.code === "target-path-exists" || issue?.code === "branch-in-other-worktree") {
    // Reuse instead of a second directory: the target already exists, or the branch is checked
    // out elsewhere while the requested target is absent. Both resolve through the same
    // registered-worktree lookup for the branch.
    try {
      const list = await gitService.listWorktrees({ workspacePath });
      const existing = findWorktreeForBranch(list.worktrees, branchName);
      if (existing) {
        // `git worktree list` can keep a stale registration after the directory was removed by
        // hand; verify the real directory and its Git link on the target Host before reuse. A
        // stale or inaccessible directory is a recoverable failure — never prune or delete here.
        const verification = await gitService.verifyWorktreeUsable({
          workspacePath,
          targetPath: existing.path,
        });
        if (!verification.ok) {
          logger.warn("[WorktreeTask] registered worktree is not usable on the target Host", {
            workspacePath,
            branchName,
            path: existing.path,
            reason: verification.reason,
          });
          return {
            kind: "failed",
            message: formatMessage("commandCenter.worktree.error.worktreeMissing", {
              branchName,
              path: existing.path,
            }),
            issueCodes: [issue.code],
            errorDetail: null,
            issueCode: issue.code,
            rawDetail: issue.detail ?? null,
          };
        }
        await ensureWorktreeExclusionSafely(gitService, workspacePath, existing.path);
        return {
          kind: "existing-worktree",
          worktreePath: existing.path,
          message: formatMessage("commandCenter.worktree.error.target-path-exists.existing", {
            branchName,
            path: existing.path,
          }),
        };
      }
    } catch (error) {
      logger.warn("[WorktreeTask] existing worktree lookup failed", {
        workspacePath,
        branchName,
        issueCode: issue.code,
        error: getErrorMessage(error),
      });
    }
  }

  const unclassifiedDetail =
    issue?.code === "unknown" ? summarizeGitFailureDetail(issue.detail) : null;
  return {
    kind: "failed",
    message: unclassifiedDetail
      ? formatMessage("commandCenter.worktree.error.unknownWithDetail", {
          detail: unclassifiedDetail,
        })
      : issue
        ? formatMessage(resolveWorktreeIssueMessageId(issue.code), {
            branchName:
              issue.code === "target-branch-not-found" ? (baseBranch ?? branchName) : branchName,
          })
        : formatMessage("commandCenter.worktree.error.unknown"),
    issueCodes: result.issues.map((entry) => entry.code),
    errorDetail: null,
    issueCode: issue?.code ?? null,
    rawDetail: issue?.detail ?? null,
  };
}

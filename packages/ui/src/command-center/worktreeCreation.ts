/**
 * Shared createWorktree orchestration for both creation entries — the palette setup page
 * Start and the empty-state "New worktree" setup pipeline (specs/composer-worktree-setup-steps.md):
 * same request shape, same issue→message mapping, and the same target-path-exists recovery
 * that lists worktrees and consumes the existing directory for the branch instead of a second one.
 *
 * Unlike the pure functions in worktreeTaskFlow, this module calls gitService and logs; both
 * gitService and message formatting are injected so the two entry points (palette, empty-state) share one semantics.
 */
import type { GitWorktreeCreateResult, GitWorktreeListResult } from "@zcode/shared";
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
    };

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
    };
  }

  if (result.ok) {
    return { kind: "created", worktreePath: result.worktreePath ?? targetPath };
  }

  const issue = result.issues[0];
  if (issue?.code === "target-path-exists") {
    // WT-04: when the target directory already exists, look up existing worktrees first — if the branch has one, offer opening it instead of creating a second directory.
    try {
      const list = await gitService.listWorktrees({ workspacePath });
      const existing = findWorktreeForBranch(list.worktrees, branchName);
      if (existing) {
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
      logger.warn("[WorktreeTask] target-path-exists worktree list lookup failed", {
        workspacePath,
        branchName,
        error: getErrorMessage(error),
      });
    }
  }

  return {
    kind: "failed",
    message: issue
      ? formatMessage(resolveWorktreeIssueMessageId(issue.code), {
          branchName:
            issue.code === "target-branch-not-found" ? (baseBranch ?? branchName) : branchName,
        })
      : formatMessage("commandCenter.worktree.error.unknown"),
    issueCodes: result.issues.map((entry) => entry.code),
    errorDetail: null,
  };
}

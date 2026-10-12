/**
 * Shared createWorktree orchestration for both creation entries — the palette setup page
 * Start and the empty-state "New worktree" send interception (review recommendation 6c):
 * same request shape, same issue→message mapping, and the same target-path-exists recovery
 * that lists worktrees and offers the existing directory for the branch instead of a second one.
 *
 * 与 worktreeTaskFlow 的纯函数不同：本模块调用 gitService 并记录日志；gitService 与
 * 文案格式化均通过参数注入，两个入口（palette、empty-state）共享同一语义。
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
  /** target-path-exists 且该分支已有 worktree（WT-04）：直接打开现有目录，不再建第二个目录。 */
  | { kind: "existing-worktree"; worktreePath: string; message: string }
  | {
      kind: "failed";
      message: string;
      /** 服务端拒绝的 issue code 列表（仅日志用）；请求抛错时为空。 */
      issueCodes: readonly string[];
      /** 请求抛错的错误文本（仅日志用）；服务端拒绝时为 null。 */
      errorDetail: string | null;
    };

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
    // WT-04：目标目录已存在时先查现有 worktree —— 若该分支已有 worktree，直接提供打开而不是再建目录。
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
      logger.warn("[WorktreeTask] target-path-exists 恢复查询 worktree 列表失败", {
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

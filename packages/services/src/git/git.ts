import type {
  GitBranchMergeStatus,
  GitBranchMergeStatusRequest,
  GitBranchMutationResult,
  GitBranchComparison,
  GitCommitGraphRequest,
  GitCommitGraphResult,
  GitCreateBranchRequest,
  GitCreateWorktreeRequest,
  GitChangesRequest,
  GitCommitRequest,
  GitCommitResult,
  GitDiffQuery,
  GitDiffResult,
  GitDiscardPathsRequest,
  GitGenerateCommitMessageRequest,
  GitGenerateCommitMessageResult,
  GitIdentity,
  GitIgnoredPathsRequest,
  GitLocalBranchListResult,
  GitPathMutationRequest,
  GitPushRequest,
  GitPushResult,
  GitRefreshRequest,
  GitRefreshResult,
  GitRepositoryRemotesResult,
  GitRepositoryRequest,
  GitRepositorySummary,
  GitWorkspaceRepositoryInfo,
  GitRemoveWorktreeRequest,
  GitWorktreeCreateResult,
  GitWorktreeListResult,
  GitWorktreePathIdentityRequest,
  GitWorktreePruneResult,
  GitWorktreeRemoveResult,
  GitWorktreeExcludeRequest,
  GitWorktreeExcludeResult,
  GitWorktreeVerifyRequest,
  GitWorktreeVerifyResult,
  GitFileChange,
  GitSwitchBranchRequest,
  SessionPullRequestsRequest,
  SessionPullRequestsResult,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IGitService {
  /** Directory belongs to this executing Host, including remote Hosts. */
  getWorktreeStorageInfo(
    params: GitRepositoryRequest,
  ): Promise<{ globalWorktreesDir: string | null }>;
  getRepositorySummary(params: GitRepositoryRequest): Promise<GitRepositorySummary>;
  getWorkspaceRepositoryInfo(params: GitRepositoryRequest): Promise<GitWorkspaceRepositoryInfo>;
  getRepositoryRemotes(params: GitRepositoryRequest): Promise<GitRepositoryRemotesResult>;
  getLocalBranches(params: GitRepositoryRequest): Promise<GitLocalBranchListResult>;
  getCommitGraph(params: GitCommitGraphRequest): Promise<GitCommitGraphResult>;
  switchBranch(params: GitSwitchBranchRequest): Promise<GitBranchMutationResult>;
  createBranchAndSwitch(params: GitCreateBranchRequest): Promise<GitBranchMutationResult>;
  listWorktrees(params: GitRepositoryRequest): Promise<GitWorktreeListResult>;
  resolveWorktreePathIdentities(params: GitWorktreePathIdentityRequest): Promise<string[]>;
  /** Verify a registered worktree's real directory and Git link on this Host; read-only. */
  verifyWorktreeUsable(params: GitWorktreeVerifyRequest): Promise<GitWorktreeVerifyResult>;
  /** Keep inside-placement worktrees (`<repoRoot>/.worktrees/`) out of the main checkout status. */
  ensureWorktreeExclusion(params: GitWorktreeExcludeRequest): Promise<GitWorktreeExcludeResult>;
  createWorktree(params: GitCreateWorktreeRequest): Promise<GitWorktreeCreateResult>;
  removeWorktree(params: GitRemoveWorktreeRequest): Promise<GitWorktreeRemoveResult>;
  pruneWorktrees(params: GitRepositoryRequest): Promise<GitWorktreePruneResult>;
  getChanges(params: GitChangesRequest): Promise<GitFileChange[]>;
  getIgnoredPaths(params: GitIgnoredPathsRequest): Promise<string[]>;
  getDiff(params: GitDiffQuery): Promise<GitDiffResult>;
  getBranchComparison(params: GitRepositoryRequest): Promise<GitBranchComparison>;
  getBranchMergeStatus(params: GitBranchMergeStatusRequest): Promise<GitBranchMergeStatus>;
  /** Task-level pull request status of worktree sessions via the gh CLI (specs/sidebar-pr-status.md). */
  getSessionPullRequests(params: SessionPullRequestsRequest): Promise<SessionPullRequestsResult>;
  stagePaths(params: GitPathMutationRequest): Promise<void>;
  unstagePaths(params: GitPathMutationRequest): Promise<void>;
  discardPaths(params: GitDiscardPathsRequest): Promise<void>;
  generateCommitMessage(
    params: GitGenerateCommitMessageRequest,
  ): Promise<GitGenerateCommitMessageResult>;
  commit(params: GitCommitRequest): Promise<GitCommitResult>;
  push(params: GitPushRequest): Promise<GitPushResult>;
  getIdentity(params: GitRepositoryRequest): Promise<GitIdentity>;
  refresh(params: GitRefreshRequest): Promise<GitRefreshResult>;
}

export const IGitService = createServiceDescriptor<IGitService>(ServiceChannels.Git);

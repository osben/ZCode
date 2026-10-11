import { useCallback, useEffect, useRef, useState } from "react";
import type {
  GitBranchMutationResult,
  GitLocalBranchListResult,
  GitRepositorySummary,
} from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import {
  buildGitBranchAutoCommitMessage,
  getPrimaryGitBranchIssue,
  resolveGitBranchIssueMessageId,
  resolveGitBranchSuccessMessageId,
  summarizeGitBranchIssuePaths,
} from "@/git-branch-switcher/display.js";
import {
  buildGitBranchSwitchAssistState,
  formatGitBranchIssuePathList,
  hasGitCommitIdentity,
  type GitBranchSwitchAssistDialogStep,
  type GitBranchSwitchAssistState,
} from "@/git-branch-switcher/switchAssist.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";

interface UseGitBranchSwitcherOptions {
  workspacePath: string;
  // gitSummary is the source of truth for HEAD (updated by the file watcher). Its current
  // branch/HEAD values are used to discard potentially stale local branch snapshots when HEAD changes.
  currentBranchName: string | null;
  headRefType: GitRepositorySummary["headRefType"];
  onRefreshGit: () => void;
}

export function useGitBranchSwitcher({
  workspacePath,
  currentBranchName,
  headRefType,
  onRefreshGit,
}: UseGitBranchSwitcherOptions) {
  const { gitService } = useServices();
  const { intl, locale } = useZCodeIntl();
  const numberFormatter = new Intl.NumberFormat(locale);
  const [open, setOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createBranchName, setCreateBranchName] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [commitError, setCommitError] = useState<string | null>(null);
  const [switchAssistStep, setSwitchAssistStep] = useState<GitBranchSwitchAssistDialogStep | null>(
    null,
  );
  const [switchAssistState, setSwitchAssistState] = useState<GitBranchSwitchAssistState | null>(
    null,
  );
  const [branchesResult, setBranchesResult] = useState<GitLocalBranchListResult | null>(null);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [mutationPending, setMutationPending] = useState(false);

  const resetSwitchAssistState = useCallback(() => {
    setSwitchAssistStep(null);
    setSwitchAssistState(null);
    setCommitMessage("");
    setCommitError(null);
  }, []);

  const loadBranches = useCallback(async () => {
    setLoadingBranches(true);

    try {
      const nextResult = await gitService.getLocalBranches({ workspacePath });
      setBranchesResult(nextResult);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitBranchSwitcher] 读取本地分支失败", {
        workspacePath,
        error: message,
      });
      toast(
        intl.formatMessage({ id: "git.branchSwitcher.error.requestFailed" }, { error: message }),
      );
    } finally {
      setLoadingBranches(false);
    }
  }, [gitService, intl, workspacePath]);

  useEffect(() => {
    setOpen(false);
    setCreateDialogOpen(false);
    setCreateBranchName("");
    setBranchesResult(null);
    resetSwitchAssistState();
  }, [resetSwitchAssistState, workspacePath]);

  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    // Key behavior: when gitSummary's HEAD changes (for example, after an external branch switch
    // or a watcher update), discard the local branch snapshot cached when the dropdown was last opened.
    // The branch label then falls back to gitSummary.branchName. Otherwise, a stale
    // branchesResult.currentBranchName can mask the real branch name indefinitely.
    // Only reset local UI state here; do not trigger a refresh or RPC, which could reintroduce
    // a refresh/watcher feedback loop.
    if (openRef.current) {
      // Keep the live list while the dropdown is open to avoid flicker. Once closed,
      // the next opening will fetch it again through loadBranches.
      return;
    }
    setBranchesResult(null);
  }, [currentBranchName, headRefType]);

  useEffect(() => {
    if (!open) {
      return;
    }

    // Fetch the branch list every time the dropdown opens so a successful switch does not reuse
    // the snapshot from the previous opening.
    void loadBranches();
  }, [loadBranches, open]);

  const notifyMutationFailure = useCallback(
    (result: GitBranchMutationResult) => {
      const issue = getPrimaryGitBranchIssue(result.issues);
      const messageId = resolveGitBranchIssueMessageId(issue);
      if (!issue) {
        toast(intl.formatMessage({ id: "git.branchSwitcher.error.unknown" }));
        return;
      }

      if (messageId) {
        const { visiblePaths, remainingCount } = summarizeGitBranchIssuePaths(issue.paths);
        const extraPaths =
          remainingCount > 0
            ? intl.formatMessage(
                { id: "git.branchSwitcher.error.moreFiles" },
                { count: numberFormatter.format(remainingCount) },
              )
            : "";
        toast(
          intl.formatMessage(
            { id: messageId },
            {
              branchName: issue.detail ?? result.branchName ?? "",
              paths: formatGitBranchIssuePathList(locale, visiblePaths),
              extraPaths,
            },
          ),
        );
        return;
      }

      const fallbackMessage = issue.detail?.trim() || issue.message.trim();
      toast(
        fallbackMessage.length > 0
          ? fallbackMessage
          : intl.formatMessage({ id: "git.branchSwitcher.error.unknown" }),
      );
    },
    [intl, locale, numberFormatter],
  );

  const prepareSwitchAssistState = useCallback(
    async (result: GitBranchMutationResult): Promise<boolean> => {
      const nextSwitchAssistState = await buildGitBranchSwitchAssistState({
        gitService,
        workspacePath,
        result,
      });
      if (!nextSwitchAssistState) {
        return false;
      }

      // An overwrite-style blocker is no longer shown as a toast. Convert it into a
      // "failure card -> commit -> retry switch automatically" flow so users can see the affected
      // files before deciding whether to commit their current changes and continue.
      setOpen(false);
      setCreateDialogOpen(false);
      setCommitError(null);
      setCommitMessage("");
      setSwitchAssistState(nextSwitchAssistState);
      setSwitchAssistStep("blocked");
      return true;
    },
    [gitService, workspacePath],
  );

  const handleMutationResult = useCallback(
    async (result: GitBranchMutationResult, actionLabel: string) => {
      if (!result.ok) {
        logger.warn("[GitBranchSwitcher] 分支变更被阻塞", {
          workspacePath,
          action: result.action,
          branchName: result.branchName,
          issues: result.issues.map((issue) => issue.code),
        });
        if (await prepareSwitchAssistState(result)) {
          return;
        }
        notifyMutationFailure(result);
        return;
      }

      const successMessageId = resolveGitBranchSuccessMessageId(result);
      if (successMessageId && result.branchName) {
        toast(intl.formatMessage({ id: successMessageId }, { branchName: result.branchName }));
      }

      logger.info(`[GitBranchSwitcher] ${actionLabel}成功`, {
        workspacePath,
        branchName: result.branchName,
        action: result.action,
        didChange: result.didChange,
        created: result.created,
      });

      setOpen(false);
      setCreateDialogOpen(false);
      setCreateBranchName("");
      resetSwitchAssistState();
      setBranchesResult((current) =>
        current
          ? {
              ...current,
              currentBranchName: result.summary.branchName,
              headRefType: result.summary.headRefType,
              branches: current.branches.map((branch) => ({
                ...branch,
                isCurrent:
                  result.summary.branchName !== null && branch.name === result.summary.branchName,
              })),
            }
          : current,
      );
      // Refresh global Git state only when the branch actually changes.
      // Switching to the current branch is already a successful no-op and needs no extra fetch.
      if (result.didChange || result.created) {
        onRefreshGit();
      }
    },
    [
      intl,
      notifyMutationFailure,
      onRefreshGit,
      prepareSwitchAssistState,
      resetSwitchAssistState,
      workspacePath,
    ],
  );

  const switchBranch = useCallback(
    async (targetBranchName: string) => {
      setOpen(false);
      setMutationPending(true);

      try {
        const result = await gitService.switchBranch({
          workspacePath,
          targetBranchName,
        });
        await handleMutationResult(result, "切换分支");
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        logger.warn("[GitBranchSwitcher] 切换分支请求失败", {
          workspacePath,
          targetBranchName,
          error: message,
        });
        toast(
          intl.formatMessage({ id: "git.branchSwitcher.error.requestFailed" }, { error: message }),
        );
      } finally {
        setMutationPending(false);
      }
    },
    [gitService, handleMutationResult, intl, workspacePath],
  );

  const createBranchAndSwitch = useCallback(async () => {
    const branchName = createBranchName.trim();
    if (branchName.length === 0) {
      toast(intl.formatMessage({ id: "git.branchSwitcher.error.invalidBranchName" }));
      return;
    }

    setMutationPending(true);

    try {
      const result = await gitService.createBranchAndSwitch({
        workspacePath,
        branchName,
      });
      await handleMutationResult(result, "创建并切换分支");
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitBranchSwitcher] 创建并切换分支请求失败", {
        workspacePath,
        branchName,
        error: message,
      });
      toast(
        intl.formatMessage({ id: "git.branchSwitcher.error.requestFailed" }, { error: message }),
      );
    } finally {
      setMutationPending(false);
    }
  }, [createBranchName, gitService, handleMutationResult, intl, workspacePath]);

  const openSwitchCommitDialog = useCallback(() => {
    setCommitError(null);
    setSwitchAssistStep("commit");
  }, []);

  const closeSwitchAssistDialog = useCallback(() => {
    resetSwitchAssistState();
  }, [resetSwitchAssistState]);

  const commitAndSwitchBranch = useCallback(async () => {
    if (!switchAssistState) {
      return;
    }

    if (!hasGitCommitIdentity(switchAssistState.identity)) {
      setCommitError(
        intl.formatMessage({
          id: "git.branchSwitcher.commitDialog.identityMissing",
        }),
      );
      return;
    }

    const nextCommitMessage =
      commitMessage.trim() || buildGitBranchAutoCommitMessage(switchAssistState.targetBranchName);

    setCommitError(null);
    setMutationPending(true);

    try {
      logger.info("[GitBranchSwitcher] 开始提交并重试切换分支", {
        workspacePath,
        targetBranchName: switchAssistState.targetBranchName,
        stagedPathCount: switchAssistState.stagePaths.length,
      });

      if (switchAssistState.stagePaths.length > 0) {
        await gitService.stagePaths({
          workspacePath,
          paths: switchAssistState.stagePaths,
        });
      }
      await gitService.commit({
        workspacePath,
        message: nextCommitMessage,
      });
      onRefreshGit();

      const result = await gitService.switchBranch({
        workspacePath,
        targetBranchName: switchAssistState.targetBranchName,
      });
      await handleMutationResult(result, "提交后切换分支");
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitBranchSwitcher] 提交并切换分支失败", {
        workspacePath,
        targetBranchName: switchAssistState.targetBranchName,
        error: message,
      });
      setCommitError(
        intl.formatMessage(
          { id: "git.branchSwitcher.commitDialog.error.requestFailed" },
          { error: message },
        ),
      );
    } finally {
      setMutationPending(false);
    }
  }, [
    commitMessage,
    gitService,
    handleMutationResult,
    intl,
    onRefreshGit,
    switchAssistState,
    workspacePath,
  ]);

  return {
    open,
    setOpen,
    createDialogOpen,
    setCreateDialogOpen,
    createBranchName,
    setCreateBranchName,
    commitMessage,
    setCommitMessage,
    commitError,
    switchAssistStep,
    switchAssistState,
    branchesResult,
    loadingBranches,
    mutationPending,
    switchBranch,
    createBranchAndSwitch,
    openSwitchCommitDialog,
    closeSwitchAssistDialog,
    commitAndSwitchBranch,
  };
}

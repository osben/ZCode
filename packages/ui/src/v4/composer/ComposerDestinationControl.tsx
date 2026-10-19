/* eslint-disable max-lines -- One destination surface: rows, inline branch list, and the reused create/graph dialogs share one state machine; split by view when Stage 2 extends it. */
/**
 * Unified destination control (specs/composer-branch-switcher-semantics.md §4, variant
 * "Switch + branch rows"): one trigger chip + popover replacing the header GitBranchSwitcher and
 * the empty-state "New worktree" checkbox behind a renderer-local feature flag (instant rollback).
 *
 * Rows: [New worktree + switch] (location from settings, pipeline states, withdraw-not-disable)
 * and [Task branch / Base branch] (project mode: intent applied at send; worktree mode: the base
 * the worktree forks from). The inline branch list keeps the base switcher's footer actions —
 * "Create and switch…" (existing GitBranchCreateDialog semantics, protected by the checkout guard) and the
 * branch graph dialog — while list selections write the draft intent instead of switching.
 * ask-codex review adopted: Task/Base labels, dirty-tree cues, HEAD-fallback disclosure.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { GitRepositorySummary } from "@zcode/shared";
import { resolveWorkspaceKey } from "@zcode/shared";
import type { GitLocalBranchListResult } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { cn } from "@/components/lib/utils.js";
import { GitBranchCreateDialog } from "@/git-branch-switcher/GitBranchDialogs.js";
import { GitGraphDialog } from "@/git-graph/GitGraphDialog.js";
import { useGitBranchSwitcher } from "@/hooks/useGitBranchSwitcher.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { matchesGitBranchSearch } from "@/git-branch-switcher/display.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { logger } from "@/logger.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { composeBranchName, resolveWorktreeLocation } from "@/command-center/worktreeTaskFlow.js";
import { generateWorktreeBranchName } from "@/command-center/worktreeNameGenerator.js";
import {
  selectComposerWorktreePipeline,
  useComposerWorktreePipelineStore,
} from "@/store/composerWorktreePipelineStore.js";
import {
  selectDraftBranchIntent,
  selectWorktreeIntentActive,
  useDraftBranchIntentStore,
} from "@/v4/composer/draftBranchIntent.js";
import {
  useComposerDraftWorktreeIntentSlot,
  type ComposerDraftWorktreeIntent,
  type ComposerWorktreeBeginResult,
} from "@/v4/composer/composerDraftWorktreeIntent.js";
import {
  beginWorktreePipelineCreation,
  isComposerWorktreeNameReserved,
} from "@/v4/composer/composerWorktreePipeline.js";
import { useBranchSwitchGuard } from "@/v4/composer/branchSwitchGuard.js";
import { Check, ChevronDown, ChevronRight, GitBranch, GitGraph, Plus, Split } from "lucide-react";

/**
 * Renderer-local rollout flag, default ON so everyone sees the new control immediately.
 * Set to "0" to restore the legacy chip + checkbox pair (instant per-device rollback).
 */
export const COMPOSER_DESTINATION_CONTROL_FLAG = "zcode.fork.composerDestinationControl";

export function readComposerDestinationControlEnabled(): boolean {
  try {
    return window.localStorage.getItem(COMPOSER_DESTINATION_CONTROL_FLAG) !== "0";
  } catch {
    return true;
  }
}

interface ComposerDestinationControlProps {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  gitSummary: GitRepositorySummary;
  dirtyFileCount: number;
  onRefreshGit: () => void;
  compactForRemoteControl?: boolean;
}

export function ComposerDestinationControl({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  gitSummary,
  dirtyFileCount,
  onRefreshGit,
  compactForRemoteControl = false,
}: ComposerDestinationControlProps) {
  const { intl } = useZCodeIntl();
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
  );
  const baseServices = resolution.services;
  const { settings } = useSettings();
  const branchSwitchGuard = useBranchSwitchGuard();
  const workspaceKey = resolveWorkspaceKey({ workspacePath, workspaceIdentity });
  const intentSlot = useComposerDraftWorktreeIntentSlot();
  const branchIntent = useDraftBranchIntentStore((state) =>
    selectDraftBranchIntent(state, workspaceKey),
  );
  const worktreeActive = useDraftBranchIntentStore((state) =>
    selectWorktreeIntentActive(state, workspaceKey),
  );
  const pipeline = useComposerWorktreePipelineStore((state) =>
    selectComposerWorktreePipeline(state, workspaceKey),
  );
  const [open, setOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [baseBranch, setBaseBranch] = useState<string | null>(null);
  const [branchesResult, setBranchesResult] = useState<GitLocalBranchListResult | null>(null);
  const [branchListFailed, setBranchListFailed] = useState(false);
  const [graphDialogOpen, setGraphDialogOpen] = useState(false);
  const [appWorktreesDir, setAppWorktreesDir] = useState<string | null>(null);

  // The shell keeps this control mounted across workspace tab switches, so git-derived draft
  // state must be dropped when the workspace changes: the previous project's cached branch list
  // otherwise survives the switch and its current branch leaks into the next project's worktree
  // creation as the base branch (rejected by git as a branch that does not exist there).
  useEffect(() => {
    setOpen(false);
    setListOpen(false);
    setBaseBranch(null);
    setBranchesResult(null);
    setBranchListFailed(false);
    setAppWorktreesDir(null);
  }, [workspaceKey, workspacePath, resolution.remoteSessionId, baseServices.gitService]);

  // List selections remain draft intent. The create dialog keeps its immediate create-and-switch
  // action, but confirms before it mutates the shared checkout.
  const switcher = useGitBranchSwitcher({
    gitService: baseServices.gitService,
    workspacePath,
    currentBranchName: gitSummary.branchName,
    headRefType: gitSummary.headRefType,
    onRefreshGit,
  });
  const handleCreateBranchAndSwitch = useCallback(async () => {
    if (branchSwitchGuard) {
      const allowed = await branchSwitchGuard({
        workspaceKey,
        targetBranchName: switcher.createBranchName,
        scope: "checkout",
      });
      if (!allowed) return;
    }
    await switcher.createBranchAndSwitch();
  }, [branchSwitchGuard, switcher.createBranchAndSwitch, switcher.createBranchName, workspaceKey]);

  const currentBranchName = gitSummary.branchName;
  const detached = gitSummary.headRefType === "detached";
  const selectedBranch = branchIntent ?? currentBranchName;
  const pipelineLive =
    (pipeline?.status === "creating" || pipeline?.status === "ready") && !pipeline.orphaned;
  const worktreeMode = worktreeActive || pipelineLive;

  const effectiveLocation = useMemo(
    () =>
      resolveWorktreeLocation(
        settings,
        settings?.worktreeProjectOverrides,
        workspacePath,
        appWorktreesDir,
      ),
    [settings, workspacePath, appWorktreesDir],
  );
  useEffect(() => {
    if (effectiveLocation.mode !== "global" || !resolution.rpcReady) return;
    let cancelled = false;
    baseServices.gitService.getWorktreeStorageInfo({ workspacePath }).then(
      ({ globalWorktreesDir }) => {
        if (!cancelled) setAppWorktreesDir(globalWorktreesDir?.trim() || null);
      },
      () => {
        if (!cancelled) setAppWorktreesDir(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [effectiveLocation.mode, baseServices.gitService, workspacePath, resolution.rpcReady]);

  // The branch list reloads on every popover open, so a branch created and switched to from this
  // popover is listed and marked current the next time it opens. The previous snapshot stays
  // rendered while the reload runs (no loading flicker). The effect must not depend on
  // branchesResult or branchListFailed: a result would then retrigger the fetch in a loop. A
  // response from a superseded open or workspace is dropped by the cancelled flag. A failure is
  // disclosed (base defaults to HEAD) and retried on the next open.
  useEffect(() => {
    if (!resolution.rpcReady || !open) return;
    let cancelled = false;
    baseServices.gitService.getLocalBranches({ workspacePath }).then(
      (result) => {
        if (!cancelled) {
          if (result && result.branches.length > 0) {
            setBranchesResult(result);
          } else {
            setBranchListFailed(true);
          }
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          logger.debug("[DestinationControl] branch list failed; base defaults to HEAD", {
            workspacePath,
            error: getErrorMessage(error),
          });
          setBranchListFailed(true);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [baseServices.gitService, open, workspacePath, resolution.rpcReady]);

  const computeWorktreeBranchName = useCallback(() => {
    const branchNameSet = new Set(branchesResult?.branches.map((branch) => branch.name) ?? []);
    const generated = generateWorktreeBranchName({
      isTaken: (raw) => {
        const composed = composeBranchName(effectiveLocation.prefix ?? "", raw);
        return (
          branchNameSet.has(composed) ||
          isComposerWorktreeNameReserved({
            workspaceKey,
            workspacePath,
            branchName: composed,
            effectiveLocation,
          })
        );
      },
    });
    return composeBranchName(effectiveLocation.prefix ?? "", generated);
  }, [branchesResult, effectiveLocation, workspaceKey, workspacePath]);

  // Register the worktree intent into the shared slot while the mode is on — the same contract the
  // checkbox implements; the composer consumes beginCreation at send. The selected base overrides
  // the automatic one, and the fallback reads the workspace's live current branch (the git summary
  // owns "current"); the cached list can outlive a branch switch or a project switch, so it must
  // never name the base. HEAD is the fallback only when no branch can be named (detached HEAD).
  useEffect(() => {
    if (!intentSlot || !worktreeMode) return;
    const headDefault = detached || currentBranchName === null;
    const resolvedBase =
      baseBranch ?? branchIntent ?? (headDefault ? undefined : currentBranchName);
    const intent = {
      workspaceKey,
      beginCreation: (
        queuedPromptPreview: string,
        prepareSession: Parameters<ComposerDraftWorktreeIntent["beginCreation"]>[1],
        syncPreparedWorktree: Parameters<ComposerDraftWorktreeIntent["beginCreation"]>[2],
        submissionId?: string,
      ): Promise<ComposerWorktreeBeginResult> =>
        beginWorktreePipelineCreation({
          gitService: baseServices.gitService,
          workspaceKey,
          workspacePath,
          effectiveLocation,
          branchName: computeWorktreeBranchName(),
          ...(resolvedBase ? { baseBranch: resolvedBase } : {}),
          baseFromHeadDefault: headDefault,
          queuedPromptPreview,
          submissionId,
          prepareSession,
          ...(syncPreparedWorktree ? { syncPreparedWorktree } : {}),
          formatMessage: (id, values) => intl.formatMessage({ id }, values),
        }),
    };
    intentSlot.current = intent;
    return () => {
      if (intentSlot.current === intent) {
        intentSlot.current = null;
      }
    };
  }, [
    baseBranch,
    baseServices.gitService,
    branchIntent,
    computeWorktreeBranchName,
    currentBranchName,
    detached,
    effectiveLocation,
    intentSlot,
    intl,
    workspaceKey,
    workspacePath,
    worktreeMode,
  ]);

  // Both rows are quiet at rest (2026-10-15 user decision); subs disclose state only — the
  // worktree row its pipeline, the branch row the failed-list fallback.
  function resolveWorktreeSub(): string {
    if (pipeline?.orphaned && (pipeline.status === "creating" || pipeline.status === "ready")) {
      return intl.formatMessage({ id: "destination.withdrawing" });
    }
    if (pipeline?.status === "creating") {
      return worktreeActive
        ? intl.formatMessage({ id: "destination.creating" })
        : intl.formatMessage({ id: "destination.withdrawing" });
    }
    if (pipeline?.status === "ready" && pipeline.worktreePath) {
      return intl.formatMessage({ id: "destination.ready" }, { path: pipeline.worktreePath });
    }
    if (pipeline?.status === "failed") {
      return intl.formatMessage({ id: "destination.failedRow" });
    }
    return "";
  }

  const worktreeSub = resolveWorktreeSub();
  const branchRowSub =
    worktreeMode && branchListFailed ? intl.formatMessage({ id: "destination.headFallback" }) : "";

  function resolveTriggerLabel(): string {
    if (worktreeMode) return intl.formatMessage({ id: "destination.worktreeLabel" });
    if (detached) return intl.formatMessage({ id: "git.head.detached" });
    return selectedBranch ?? intl.formatMessage({ id: "git.branchSwitcher.label" });
  }

  const triggerLabel = resolveTriggerLabel();
  const branches = branchesResult?.branches ?? [];
  const rowValue = detached
    ? intl.formatMessage({ id: "git.head.detached" })
    : (baseBranch ?? branchIntent ?? currentBranchName ?? "");

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          // A failed list from an earlier open must not stick: each open retries the load.
          if (nextOpen) setBranchListFailed(false);
          setOpen(nextOpen);
          switcher.setOpen(nextOpen);
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            disabled={!resolution.rpcReady}
            title={
              !resolution.rpcReady
                ? intl.formatMessage({ id: "worktreeSetup.connectionUnavailable" })
                : undefined
            }
            aria-label={intl.formatMessage({ id: "destination.trigger.ariaLabel" })}
            className={cn(
              "min-w-0 rounded-full text-ui-base/relaxed",
              compactForRemoteControl ? "size-8 px-0" : "max-w-full pl-3 pr-2",
              worktreeMode && "text-worktree-task",
            )}
          >
            {worktreeMode ? (
              <Split className="size-4 rotate-90" aria-hidden="true" />
            ) : (
              <GitBranch className="size-4 text-foreground-subtle" aria-hidden="true" />
            )}
            {!compactForRemoteControl ? (
              <>
                <span className="min-w-0 max-w-25 truncate text-left">{triggerLabel}</span>
                <ChevronDown className="size-3.5 text-foreground-subtle" aria-hidden="true" />
              </>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" side="top" className="w-80 gap-0 bg-menu p-0">
          {!listOpen ? (
            <div className="p-1">
              <div className="flex items-center gap-2 rounded-lg px-2 py-2 text-ui-base">
                <Split className="size-4 rotate-90 text-worktree-task" aria-hidden="true" />
                <span className="flex-1 text-left font-medium">
                  {intl.formatMessage({ id: "destination.worktreeLabel" })}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={worktreeActive}
                  aria-label={intl.formatMessage({ id: "destination.worktreeLabel" })}
                  onClick={() => {
                    if (
                      worktreeActive &&
                      (pipeline?.status === "creating" || pipeline?.status === "ready")
                    ) {
                      useComposerWorktreePipelineStore.getState().withdraw(workspaceKey);
                    }
                    useDraftBranchIntentStore
                      .getState()
                      .setWorktreeIntentActive(workspaceKey, !worktreeActive);
                  }}
                  className={cn(
                    "relative h-[18px] w-[30px] cursor-pointer rounded-full border-0 transition-colors",
                    worktreeActive ? "bg-worktree-task" : "bg-border",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-[2px] size-[14px] rounded-full bg-menu shadow transition-[left]",
                      worktreeActive ? "left-[14px]" : "left-[2px]",
                    )}
                  />
                </button>
              </div>
              {worktreeSub ? (
                <p className="px-2 pb-1 text-ui-xs text-foreground-subtle">{worktreeSub}</p>
              ) : null}
              <button
                type="button"
                className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-ui-base hover:bg-surface-hover"
                onClick={() => setListOpen(true)}
              >
                <GitBranch className="size-4 text-foreground-subtle" aria-hidden="true" />
                <span className="flex-1 text-left font-medium">
                  {worktreeMode
                    ? intl.formatMessage({ id: "destination.baseBranch" })
                    : intl.formatMessage({ id: "destination.taskBranch" })}
                </span>
                <span className="max-w-25 truncate text-ui-sm text-foreground-subtle">
                  {rowValue}
                </span>
                <ChevronRight className="size-4 text-foreground-subtle" aria-hidden="true" />
              </button>
              {branchRowSub ? (
                <p className="px-2 pb-2 text-ui-xs text-foreground-subtle">{branchRowSub}</p>
              ) : null}
            </div>
          ) : (
            <Command filter={(value, search) => (matchesGitBranchSearch(value, search) ? 1 : 0)}>
              <div className="flex items-center p-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-ui-sm"
                  onClick={() => setListOpen(false)}
                >
                  <ChevronRight className="size-3.5 rotate-180" aria-hidden="true" />
                  {worktreeMode
                    ? intl.formatMessage({ id: "destination.baseBranch" })
                    : intl.formatMessage({ id: "destination.taskBranch" })}
                </Button>
              </div>
              <CommandInput
                placeholder={intl.formatMessage({ id: "git.branchSwitcher.searchPlaceholder" })}
                className="h-8"
              />
              <CommandList className="max-h-72">
                <CommandEmpty className="px-4 py-5 text-foreground-subtle">
                  {branchListFailed
                    ? intl.formatMessage({ id: "destination.headFallback" })
                    : intl.formatMessage({ id: "git.branchSwitcher.empty" })}
                </CommandEmpty>
                <CommandGroup className="p-1">
                  {branches.map((branch) => {
                    const isCurrent = branch.name === currentBranchName;
                    const isSelected = branch.name === (baseBranch ?? branchIntent);
                    // Checked out in another worktree: not switchable as a task branch (project
                    // mode); still valid as a worktree BASE — a base only needs to exist.
                    const occupiedDirectory = switcher.worktreeOccupancy.get(branch.name);
                    return (
                      <CommandItem
                        key={branch.name}
                        value={branch.name}
                        data-checked={isSelected ? "true" : undefined}
                        disabled={!worktreeMode && occupiedDirectory !== undefined}
                        onSelect={() => {
                          if (worktreeMode) {
                            setBaseBranch(branch.name);
                          } else {
                            useDraftBranchIntentStore
                              .getState()
                              .setDraftBranchIntent(workspaceKey, branch.name);
                          }
                          setListOpen(false);
                        }}
                        className="items-start gap-3 rounded-lg px-3 py-2 text-ui-base"
                      >
                        <GitBranch
                          className="mt-0.5 size-4 text-foreground-subtle"
                          aria-hidden="true"
                        />
                        <span className="flex-1 truncate font-medium">{branch.name}</span>
                        {occupiedDirectory ? (
                          <span className="text-ui-sm text-foreground-subtle">
                            {intl.formatMessage(
                              { id: "git.branchSwitcher.checkedOutIn" },
                              { directory: occupiedDirectory },
                            )}
                          </span>
                        ) : isCurrent && dirtyFileCount > 0 ? (
                          <span className="text-ui-sm text-foreground-subtle">
                            {intl.formatPlural(
                              { id: "git.branchSwitcher.currentDirty" },
                              dirtyFileCount,
                            )}
                          </span>
                        ) : null}
                        {isSelected ? <Check className="size-4" aria-hidden="true" /> : null}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
              <div className="border-t border-border p-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="lg"
                  className="w-full justify-start px-2"
                  onClick={() => {
                    setOpen(false);
                    switcher.setCreateDialogOpen(true);
                  }}
                >
                  <Plus className="size-4 text-foreground-subtle" aria-hidden="true" />
                  {intl.formatMessage({ id: "git.branchSwitcher.createAction" })}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="lg"
                  className="w-full justify-start px-2"
                  onClick={() => {
                    setOpen(false);
                    setGraphDialogOpen(true);
                  }}
                >
                  <GitGraph className="size-4 text-foreground-subtle" aria-hidden="true" />
                  {intl.formatMessage({ id: "destination.viewGraph" })}
                </Button>
              </div>
            </Command>
          )}
        </PopoverContent>
      </Popover>
      <GitBranchCreateDialog
        open={switcher.createDialogOpen}
        branchName={switcher.createBranchName}
        mutationPending={switcher.mutationPending}
        onOpenChange={switcher.setCreateDialogOpen}
        onBranchNameChange={switcher.setCreateBranchName}
        onCancel={() => switcher.setCreateDialogOpen(false)}
        onSubmit={() => void handleCreateBranchAndSwitch()}
      />
      <GitGraphDialog
        open={graphDialogOpen}
        workspacePath={workspacePath}
        onOpenChange={setGraphDialogOpen}
      />
    </>
  );
}

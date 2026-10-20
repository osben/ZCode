/**
 * ChatEmptyState — empty-state component shown when a conversation has no messages.
 *
 * Workspace path helpers and the empty-state dropdown menu were extracted from ChatView.tsx.
 */
/* eslint-disable max-lines -- The empty-state workspace menu centralizes filtering and switching interactions for local, remote, and session workspaces; local style extensions must preserve the same semantics. */
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { InputGroup, InputGroupAddon } from "@/components/ui/input-group.js";
import {
  ChevronDownIcon,
  Cloud,
  Folder,
  FolderPlus,
  House,
  MessageCircle,
  SearchIcon,
  X,
} from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useRemoteConnectionEntryVisibility } from "@/hooks/useRemoteConnectionEntryVisibility.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { cn } from "@/components/lib/utils.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { getPathLeaf } from "@/lib/path.js";
import {
  formatRemoteWorkspaceTargetSubtitle,
  hasRemoteWorkspaceIdentity,
} from "@/lib/remoteWorkspaceHistory.js";
import { logger } from "@/logger.js";
import { SSHDialog } from "@/SSHDialog.js";
import type { GitLocalBranchListResult, GitWorkspaceRepositoryInfo } from "@zcode/shared";
import {
  composeBranchName,
  resolveDefaultBaseBranch,
  resolveWorktreeLocation,
} from "@/command-center/worktreeTaskFlow.js";
import { generateWorktreeBranchName } from "@/command-center/worktreeNameGenerator.js";
import {
  useComposerDraftWorktreeIntentSlot,
  type ComposerDraftWorktreeIntent,
  type ComposerWorktreePreparationParams,
  type ComposerWorktreePreparationSync,
  type ComposerWorktreeBeginResult,
} from "@/v4/composer/composerDraftWorktreeIntent.js";
import {
  beginWorktreePipelineCreation,
  isComposerWorktreeNameReserved,
} from "@/v4/composer/composerWorktreePipeline.js";
import {
  selectComposerWorktreePipeline,
  useComposerWorktreePipelineStore,
} from "@/store/composerWorktreePipelineStore.js";
import { useDraftBranchIntentStore } from "@/v4/composer/draftBranchIntent.js";
import {
  TID_COMPOSER_PROJECT_DETACH,
  TID_COMPOSER_REMOTE_CONNECTION,
  TID_COMPOSER_WORK_OUTSIDE_PROJECT,
  TID_COMPOSER_WORKSPACE_TRIGGER,
  resolveWorkspaceKey,
  type RemoteTarget,
  type RemoteWorkspaceSessionEntry,
  type WorkspacePurpose,
} from "@zcode/shared";
import { runUserAction, runUserActionAsync } from "@/lib/userActionTelemetry.js";
export {
  getScratchWorkspaceLocationHint,
  getScratchWorkspaceNameErrorKind,
} from "@/ChatEmptyScratchWorkspaceDialog.js";

// ---------------------------------------------------------------------------
// Workspace path helpers
// ---------------------------------------------------------------------------

function inferWorkspaceHomePath(path: string) {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const homeMatch = normalizedPath.match(
    /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+)(?:\/|$)/,
  );
  return homeMatch?.[1] ?? null;
}

function getWorkspaceMenuTitle(path: string, homeLabel: string) {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+)$/.test(normalizedPath)) {
    return homeLabel;
  }

  return getPathLeaf(path);
}

function getWorkspaceListTitle(path: string, homeLabel: string) {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+)$/.test(normalizedPath)) {
    return getPathLeaf(path);
  }

  return getWorkspaceMenuTitle(path, homeLabel);
}

export function getWorkspaceTriggerTitle(path: string, homeLabel: string) {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+)$/.test(normalizedPath)) {
    return getPathLeaf(path);
  }

  return getWorkspaceMenuTitle(path, homeLabel);
}

export interface ChatEmptyWorkspaceMenuTab {
  workspacePath: string;
  label: string;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
}

export function isWorkspaceMenuTabSelected(
  workspaceTab: ChatEmptyWorkspaceMenuTab,
  current: { workspacePath: string; workspaceIdentity?: string },
): boolean {
  return resolveWorkspaceKey(workspaceTab) === resolveWorkspaceKey(current);
}

function getRemoteWorkspaceSearchText(workspaceTab: ChatEmptyWorkspaceMenuTab) {
  if (!workspaceTab.remoteTarget) {
    return workspaceTab.workspaceIdentity ?? "";
  }

  return [
    formatRemoteWorkspaceTargetSubtitle(workspaceTab.remoteTarget),
    workspaceTab.workspaceIdentity,
  ]
    .filter(Boolean)
    .join(" ");
}

export function filterVisibleWorkspaceMenuTabs({
  workspaceTabs,
  homeWorkspaceLabel,
  searchQuery,
}: {
  workspaceTabs: ReadonlyArray<ChatEmptyWorkspaceMenuTab>;
  homeWorkspaceLabel: string;
  searchQuery: string;
}) {
  const normalizedQuery = searchQuery.trim().toLowerCase();

  return workspaceTabs
    .filter((workspaceTab) => {
      const isDisconnectedRemoteWorkspace = Boolean(
        hasRemoteWorkspaceIdentity(workspaceTab) && !workspaceTab.remoteSessionId,
      );

      // The empty-state menu lists workspaces that can be switched to immediately.
      // A disconnected remote workspace would lead to an unavailable context, unlike the left sidebar, which keeps disconnected entries so they can be reconnected.
      // Exclude disconnected remote workspaces from this menu and retain only workspaces that can be entered directly; keep the fixed entry at the bottom unchanged.
      return !isDisconnectedRemoteWorkspace;
    })
    .filter((workspaceTab) => {
      if (!normalizedQuery) {
        return true;
      }

      const workspaceTitle = getWorkspaceListTitle(workspaceTab.workspacePath, homeWorkspaceLabel);
      const searchableText = [
        workspaceTitle,
        workspaceTab.label,
        workspaceTab.workspacePath,
        getRemoteWorkspaceSearchText(workspaceTab),
      ]
        .join(" ")
        .toLowerCase();
      return searchableText.includes(normalizedQuery);
    })
    .slice(0, 5);
}

// ---------------------------------------------------------------------------
// Empty-state component
// ---------------------------------------------------------------------------

export function ChatEmptyWorkspacePreviewMenu({
  workspacePath,
  workspaceIdentity,
  isWindowsDesktop = false,
  compactForRemoteControl = false,
  workspaceTabs,
  allowConversationWorkspaceSelection = true,
  allowConversationWorkspaceDetach = allowConversationWorkspaceSelection,
  onSelectWorkspace,
  onSelectConversationWorkspace,
  onOpenFolder,
  allowOpenWorkspace = true,
  allowRemoteWorkspace = true,
  remoteWorkspaceSessions = [],
  onConnectRemote,
  onSelectRemoteProject,
  onCancelRemoteProject,
  containerClassName,
  triggerClassName,
  triggerIndicator,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  isWindowsDesktop?: boolean;
  compactForRemoteControl?: boolean;
  workspaceTabs: ReadonlyArray<ChatEmptyWorkspaceMenuTab>;
  allowConversationWorkspaceSelection?: boolean;
  /** Whether to show the project chip's quick detach button; by default this follows the non-project workspace selection capability. */
  allowConversationWorkspaceDetach?: boolean;
  onSelectWorkspace: (workspaceTab: ChatEmptyWorkspaceMenuTab) => void;
  onSelectConversationWorkspace: () => void | Promise<void>;
  onOpenFolder: () => void;
  allowOpenWorkspace?: boolean;
  allowRemoteWorkspace?: boolean;
  remoteWorkspaceSessions?: RemoteWorkspaceSessionEntry[];
  onConnectRemote: (options: RemoteTarget, requestId?: string) => Promise<string>;
  onSelectRemoteProject: (
    sessionId: string,
    path: string,
    localWorkspacePath?: string,
  ) => Promise<void>;
  onCancelRemoteProject: (sessionId: string) => Promise<void>;
  /** Lets the caller locally adjust the outer appearance of the workspace chip without changing the default style for regular conversations. */
  containerClassName?: string;
  /** Lets the caller locally adjust the workspace trigger appearance without changing the default style for regular conversations. */
  triggerClassName?: string;
  /** Lets the caller replace the trailing indicator locally; regular conversations continue to use the default Lucide chevron. */
  triggerIndicator?: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const [sshDialogOpen, setSshDialogOpen] = useState(false);
  const [workspaceSearchQuery, setWorkspaceSearchQuery] = useState("");
  const showRemoteConnectionEntry = useRemoteConnectionEntryVisibility();
  // Regular Web mode does not have the complete remote-workspace conversation flow, so global feature visibility alone is insufficient.
  // Also check the shell capability flag to keep the empty-state menu from exposing a remote-connection entry that would always fail in local Web mode.
  const canUseRemoteWorkspace = allowRemoteWorkspace && showRemoteConnectionEntry;
  const currentWorkspaceTab =
    workspaceTabs.find((workspaceTab) =>
      isWorkspaceMenuTabSelected(workspaceTab, {
        workspacePath,
        workspaceIdentity,
      }),
    ) ?? null;
  const isConversationWorkspace = currentWorkspaceTab?.workspacePurpose === "conversation";
  const canDetachProject =
    allowConversationWorkspaceSelection &&
    allowConversationWorkspaceDetach &&
    !isConversationWorkspace;
  const localWorkspacePathForRemoteConnection =
    isConversationWorkspace ||
    currentWorkspaceTab?.remoteSessionId ||
    currentWorkspaceTab?.remoteTarget ||
    currentWorkspaceTab?.workspaceIdentity
      ? undefined
      : workspacePath;
  const homeWorkspacePath = inferWorkspaceHomePath(workspacePath);
  const homeWorkspaceLabel = intl.formatMessage({ id: "chat.empty.home" });
  const isCurrentRemoteWorkspace = hasRemoteWorkspaceIdentity(currentWorkspaceTab ?? {});
  const visibleWorkspaceTabs = useMemo(
    () =>
      filterVisibleWorkspaceMenuTabs({
        workspaceTabs: workspaceTabs.filter(
          (workspaceTab) => workspaceTab.workspacePurpose !== "conversation",
        ),
        homeWorkspaceLabel,
        searchQuery: workspaceSearchQuery,
      }),
    [homeWorkspaceLabel, workspaceSearchQuery, workspaceTabs],
  );
  const currentWorkspaceTitle = isConversationWorkspace
    ? intl.formatMessage({ id: "chat.empty.selectProject" })
    : getWorkspaceTriggerTitle(workspacePath, homeWorkspaceLabel);
  const CurrentWorkspaceIcon = isCurrentRemoteWorkspace
    ? Cloud
    : homeWorkspacePath === workspacePath
      ? House
      : Folder;

  return (
    <DropdownMenu>
      <div
        className={cn(
          "group/workspace-chip relative flex min-w-0 items-center rounded-full hover:bg-surface-hover focus-within:bg-surface-hover",
          containerClassName,
        )}
      >
        {canDetachProject ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="pointer-events-none absolute left-1.5 z-10 rounded-full text-foreground-subtle opacity-0 transition-opacity group-hover/workspace-chip:pointer-events-auto group-hover/workspace-chip:opacity-100 group-focus-within/workspace-chip:pointer-events-auto group-focus-within/workspace-chip:opacity-100"
            aria-label={intl.formatMessage({ id: "chat.empty.detachProject" })}
            data-testid={TID_COMPOSER_PROJECT_DETACH}
            onClick={(event) => {
              event.stopPropagation();
              void runUserActionAsync({
                input: {
                  featureId: "workspace.project_binding",
                  action: "detach",
                  trigger: "button",
                },
                operation: () => Promise.resolve(onSelectConversationWorkspace()),
                completed: { resultSource: "optimistic_projection" },
                failureStage: "project_detach",
              });
            }}
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="default"
            className={cn(
              "min-w-0 rounded-full bg-transparent text-ui-base/relaxed hover:bg-transparent",
              // Bugfix: The remote-control empty-state copy area is narrower, so a long workspacePath can crowd the same line.
              // In remote-control mode, narrow the menu trigger so very long paths are truncated inside the button.
              compactForRemoteControl ? "max-w-44 pl-3 pr-2" : "max-w-[15rem] pl-3 pr-2",
              triggerClassName,
            )}
            aria-label={intl.formatMessage({ id: "chat.empty.workspaceMenu" })}
            data-testid={TID_COMPOSER_WORKSPACE_TRIGGER}
          >
            <CurrentWorkspaceIcon
              className={cn(
                "size-4 text-foreground-subtle transition-opacity",
                // The close button and project icon occupy the same position. Hide the underlying icon only when detaching from the project is allowed;
                // otherwise the X would overlap the icon. Scheduled tasks disable this capability, so keep their project icon visible.
                canDetachProject &&
                  "group-hover/workspace-chip:opacity-0 group-focus-within/workspace-chip:opacity-0",
              )}
            />
            <span className="block max-w-full truncate">{currentWorkspaceTitle}</span>
            {triggerIndicator ?? <ChevronDownIcon className="size-3.5 text-foreground-subtle" />}
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="start" side="top" className="w-72 p-0">
        <div
          data-slot="command-input-wrapper"
          className="p-1 border-b border-border"
          onKeyDown={(event) => event.stopPropagation()}
        >
          <InputGroup className="h-8 border-0 !bg-transparent hover:border-input-border-hover ">
            <input
              data-slot="command-input"
              value={workspaceSearchQuery}
              placeholder={intl.formatMessage({
                id: "chat.empty.workspaceSearchPlaceholder",
              })}
              onChange={(event) => setWorkspaceSearchQuery(event.target.value)}
              className="w-full text-ui-base/relaxed text-foreground outline-hidden placeholder:text-foreground-subtlest disabled:cursor-not-allowed disabled:opacity-50"
            />
            <InputGroupAddon>
              <SearchIcon className="size-4 shrink-0 text-foreground-subtlest" />
            </InputGroupAddon>
          </InputGroup>
        </div>
        <div className="p-1">
          {visibleWorkspaceTabs.map((workspaceTab, index) => {
            const workspaceTitle = getWorkspaceListTitle(
              workspaceTab.workspacePath,
              homeWorkspaceLabel,
            );
            const isRemoteWorkspace = hasRemoteWorkspaceIdentity(workspaceTab);
            const WorkspaceIcon = isRemoteWorkspace
              ? Cloud
              : inferWorkspaceHomePath(workspaceTab.workspacePath) === workspaceTab.workspacePath
                ? House
                : Folder;

            return (
              <DropdownMenuCheckboxItem
                key={`${workspaceTab.workspaceIdentity ?? workspaceTab.remoteSessionId ?? "local"}:${workspaceTab.workspacePath}:${index}`}
                checked={isWorkspaceMenuTabSelected(workspaceTab, {
                  workspacePath,
                  workspaceIdentity,
                })}
                onSelect={() => {
                  runUserAction({
                    input: {
                      featureId: isConversationWorkspace
                        ? "workspace.project_binding"
                        : "workspace.local.lifecycle",
                      action: isConversationWorkspace ? "attach" : "switch",
                      trigger: "menu",
                      workspaceKind: isRemoteWorkspace ? "remote" : "local",
                    },
                    operation: () => onSelectWorkspace(workspaceTab),
                    completed: { resultSource: "local_commit" },
                    failureStage: "workspace_switch",
                  });
                }}
              >
                <WorkspaceIcon className="size-4 text-foreground-subtle" />
                <span className="min-w-0 flex-1 truncate">{workspaceTitle}</span>
              </DropdownMenuCheckboxItem>
            );
          })}
          {visibleWorkspaceTabs.length === 0 ? (
            <div className="px-2 py-2 text-ui-base text-foreground-subtlest">
              {intl.formatMessage({ id: "chat.empty.workspaceSearchEmpty" })}
            </div>
          ) : null}

          <DropdownMenuSeparator />
          {allowOpenWorkspace ? (
            <DropdownMenuItem onSelect={onOpenFolder}>
              <FolderPlus className="size-4 text-foreground-subtle" />
              <span>{intl.formatMessage({ id: "workspace.openFolder" })}</span>
            </DropdownMenuItem>
          ) : null}
          {canUseRemoteWorkspace ? (
            <DropdownMenuItem
              data-testid={TID_COMPOSER_REMOTE_CONNECTION}
              onSelect={() => {
                // Let DropdownMenu run its default close flow when opening the remote dialog.
                // Preventing the default selection leaves both the parent menu and modal open; after the overlay stacking change, the parent menu covers the dialog.
                logger.info(
                  `[ChatEmptyWorkspacePreviewMenu] open remote dialog from workspace menu workspace=${workspacePath}`,
                );
                runUserAction({
                  input: {
                    featureId: "workspace.remote.lifecycle",
                    action: "open_dialog",
                    trigger: "menu",
                    workspaceKind: "remote",
                  },
                  operation: () => setSshDialogOpen(true),
                  completed: { resultSource: "local_commit" },
                  failureStage: "dialog_open",
                });
              }}
            >
              <Cloud className="size-4 text-foreground-subtle" />
              <span>{intl.formatMessage({ id: "remote.trigger" })}</span>
            </DropdownMenuItem>
          ) : null}
          {allowConversationWorkspaceSelection ? (
            <DropdownMenuCheckboxItem
              data-testid={TID_COMPOSER_WORK_OUTSIDE_PROJECT}
              checked={isConversationWorkspace}
              onSelect={() =>
                void runUserActionAsync({
                  input: {
                    featureId: "workspace.project_binding",
                    action: "work_outside_project",
                    trigger: "menu",
                  },
                  operation: () => Promise.resolve(onSelectConversationWorkspace()),
                  completed: { resultSource: "optimistic_projection" },
                  failureStage: "project_detach",
                })
              }
            >
              <MessageCircle className="size-4 text-foreground-subtle" />
              <span>{intl.formatMessage({ id: "chat.empty.workOutsideProject" })}</span>
            </DropdownMenuCheckboxItem>
          ) : null}
        </div>
      </DropdownMenuContent>
      {canUseRemoteWorkspace ? (
        <SSHDialog
          onConnect={onConnectRemote}
          onSelectProject={onSelectRemoteProject}
          onCancelSession={onCancelRemoteProject}
          localWorkspacePath={localWorkspacePathForRemoteConnection}
          isWindowsDesktop={isWindowsDesktop}
          remoteWorkspaceSessions={remoteWorkspaceSessions}
          open={sshDialogOpen}
          onOpenChange={setSshDialogOpen}
          hideTriggerWhenClosed
        />
      ) : null}
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Empty-state "New worktree" checkbox (review recommendation 6c)
// ---------------------------------------------------------------------------

/** Minimal tab shape for the gating input; compatible with ChatEmptyWorkspaceMenuTab. */
export interface ChatEmptyWorktreeGatingTab {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  remoteTarget?: unknown;
  workspacePurpose?: WorkspacePurpose;
}

/**
 * Checkbox gate (pure): Git probing happens only for a Desktop local shell, a workspace
 * without remote identity, and a tab (when found) that is not remote / conversation-purpose.
 * Mirrors the palette flow's Desktop-only boundary (supportsWorktreeTasks).
 */
export function canOfferChatEmptyWorktreeTask({
  isDesktop,
  isWebRemoteControlShell,
  workspacePath,
  workspaceIdentity,
  currentTab,
}: {
  isDesktop?: boolean;
  isWebRemoteControlShell?: boolean;
  workspacePath: string;
  workspaceIdentity?: string;
  currentTab: ChatEmptyWorktreeGatingTab | null;
}): boolean {
  if (isDesktop !== true || isWebRemoteControlShell) {
    return false;
  }
  if (!workspacePath.trim() || workspaceIdentity?.trim()) {
    return false;
  }
  if (
    currentTab &&
    (currentTab.remoteSessionId ||
      currentTab.remoteTarget ||
      currentTab.workspacePurpose === "conversation")
  ) {
    return false;
  }
  return true;
}

/** Lazy repo probe result: only main-tree / linked-worktree can host worktree creation (WT-03). */
export function isWorktreeCapableRepository(info: GitWorkspaceRepositoryInfo): boolean {
  return info.isGitAvailable && (info.kind === "main-tree" || info.kind === "linked-worktree");
}

/**
 * Empty-state "New worktree" checkbox (specs/composer-worktree-setup-steps.md). Checking it marks
 * intent ONLY — nothing is created on check. On Send the composer asks the registered intent to
 * begin creation: the pipeline store entry + runner start, setup rows render in the conversation
 * pane, and the queued send dispatches automatically when the worktree is ready. The checkbox
 * reflects the pipeline (withdraw on uncheck mid-creation; uncheck when the pipeline settles).
 */
export function ChatEmptyWorktreeTaskToggle({
  workspacePath,
  workspaceIdentity,
  workspaceTabs,
  isDesktop,
  isWebRemoteControlShell,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceTabs: ReadonlyArray<ChatEmptyWorkspaceMenuTab>;
  isDesktop?: boolean;
  isWebRemoteControlShell: boolean;
}) {
  const { intl } = useZCodeIntl();
  const baseServices = useBaseWorkspaceServices();
  const { settings } = useSettings();
  // Stage F: the global storage directory is desktop-only; stays null without the provider/method (global mode then behaves as an invalid location).
  const platform = useOptionalPlatform();
  const intentSlot = useComposerDraftWorktreeIntentSlot();
  const workspaceKey = resolveWorkspaceKey({ workspacePath, workspaceIdentity });
  const pipeline = useComposerWorktreePipelineStore((state) =>
    selectComposerWorktreePipeline(state, workspaceKey),
  );
  // Frozen destination of a restored failed submission: Retry re-arms this checkbox and creates the
  // frozen branch at the frozen location (the unified control does the same).
  const frozenIntent = useDraftBranchIntentStore(
    (state) => state.frozenWorktreeIntentByWorkspaceKey[workspaceKey],
  );
  const currentTab =
    workspaceTabs.find((workspaceTab) =>
      isWorkspaceMenuTabSelected(workspaceTab, { workspacePath, workspaceIdentity }),
    ) ?? null;
  const shellEligible = canOfferChatEmptyWorktreeTask({
    isDesktop,
    isWebRemoteControlShell,
    workspacePath,
    workspaceIdentity,
    currentTab,
  });
  // Repo probe results cached per workspacePath; a silent failure is treated like "not a
  // repository" (the checkbox stays hidden).
  const [repoEligibleByPath, setRepoEligibleByPath] = useState<Record<string, boolean>>({});
  const [checked, setChecked] = useState(false);
  const [branchesResult, setBranchesResult] = useState<GitLocalBranchListResult | null>(null);
  /** Stage F: lazily loaded global storage directory (fetched only in global mode, cached in component state; failures silently keep null). */
  const [appWorktreesDir, setAppWorktreesDir] = useState<string | null>(null);
  const repoEligible = shellEligible && repoEligibleByPath[workspacePath] === true;
  // Mirror the checkbox intent for the header branch picker (disabled while the worktree setup
  // owns the draft's branch; spec: composer-branch-switcher-semantics.md §1).
  useEffect(() => {
    useDraftBranchIntentStore
      .getState()
      .setWorktreeIntentActive(workspaceKey, checked && repoEligible);
  }, [checked, repoEligible, workspaceKey]);
  useEffect(
    () => () => {
      useDraftBranchIntentStore.getState().setWorktreeIntentActive(workspaceKey, false);
    },
    [workspaceKey],
  );

  useEffect(() => {
    if (!shellEligible || repoEligibleByPath[workspacePath] !== undefined) {
      return;
    }
    let cancelled = false;
    baseServices.gitService
      .getWorkspaceRepositoryInfo({ workspacePath })
      .then((info) => {
        if (cancelled) {
          return;
        }
        setRepoEligibleByPath((current) => ({
          ...current,
          [workspacePath]: info ? isWorktreeCapableRepository(info) : false,
        }));
      })
      .catch((error: unknown) => {
        // Non-blocking silent failure: without repository info the checkbox stays hidden and
        // the empty state is left undisturbed.
        if (!cancelled) {
          logger.debug("[ChatEmptyWorktree] repo probe failed, hiding the checkbox", {
            workspacePath,
            error: getErrorMessage(error),
          });
          setRepoEligibleByPath((current) => ({ ...current, [workspacePath]: false }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [baseServices.gitService, repoEligibleByPath, shellEligible, workspacePath]);

  useEffect(() => {
    if (!repoEligible) {
      return;
    }
    // Reset on workspace change; the branch list loads lazily on check.
    setChecked(false);
    setBranchesResult(null);
  }, [workspacePath, repoEligible]);

  // Re-arm from a restored frozen destination. Declared after the reset effect so a workspace
  // reset in the same commit cannot clear it again.
  useEffect(() => {
    if (frozenIntent && repoEligible) {
      setChecked(true);
    }
  }, [frozenIntent, repoEligible]);

  useEffect(() => {
    if (!checked || !repoEligible || branchesResult !== null) {
      return;
    }
    // Load local branches on check (base resolution + collision-safe naming). The list is an
    // optimization, never a gate: when absent or failed the pipeline degrades to base = HEAD
    // (spec: composer-worktree-setup-steps.md) and naming avoids only known names.
    let cancelled = false;
    baseServices.gitService.getLocalBranches({ workspacePath }).then(
      (result) => {
        if (!cancelled) {
          // ?? null: test doubles may resolve undefined; treat it as "not loaded yet".
          setBranchesResult(result ?? null);
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          // Non-blocking degradation: no branch list → base = HEAD, noted on the setup row.
          logger.debug("[ChatEmptyWorktree] branch list failed; base defaults to HEAD", {
            workspacePath,
            error: getErrorMessage(error),
          });
          setBranchesResult({ headRefType: "branch", currentBranchName: null, branches: [] });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [baseServices.gitService, branchesResult, checked, repoEligible, workspacePath]);

  // Stage D: effective worktree defaults = global settings + this project's override.
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
  // Stage F: fetch the app worktrees dir from the platform only when the effective mode is global (lazy load + component state cache).
  const getAppWorktreesDir = platform?.getAppWorktreesDir;
  useEffect(() => {
    if (
      effectiveLocation.mode !== "global" ||
      typeof getAppWorktreesDir !== "function" ||
      appWorktreesDir !== null
    ) {
      return;
    }
    let cancelled = false;
    getAppWorktreesDir().then(
      (dir) => {
        if (!cancelled) {
          setAppWorktreesDir(dir.trim() || null);
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          // Silent failure: an unavailable directory makes the global mode an invalid location
          // (send interception + inline error).
          logger.debug("[ChatEmptyWorktree] getAppWorktreesDir failed", {
            workspacePath,
            error: getErrorMessage(error),
          });
          setAppWorktreesDir(null);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [effectiveLocation.mode, getAppWorktreesDir, appWorktreesDir, workspacePath]);
  // Send-time inputs (2026-10-13 review: the mini-form is hidden — the checkbox alone means
  // "create a worktree for the first message"). The branch name is fully automatic: generated
  // from the built-in lists, composed with the effective prefix, collisions avoided.
  const effectiveBaseBranch = branchesResult
    ? resolveDefaultBaseBranch(branchesResult, effectiveLocation.baseBranchDefault)
    : "";
  const generateComposedBranchName = useCallback((): string => {
    const branchNameSet = new Set(branchesResult?.branches.map((branch) => branch.name) ?? []);
    const generated = generateWorktreeBranchName({
      isTaken: (raw) => {
        const composed = composeBranchName(effectiveLocation.prefix, raw);
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
    return composeBranchName(effectiveLocation.prefix, generated);
  }, [branchesResult, effectiveLocation, workspaceKey, workspacePath]);

  const beginCreation = useCallback(
    async (
      queuedPromptPreview: string,
      prepareSession: (params: ComposerWorktreePreparationParams) => Promise<string>,
      syncPreparedWorktree?: ComposerWorktreePreparationSync,
      submissionId?: string,
    ): Promise<ComposerWorktreeBeginResult> => {
      // Validation, target path, and the runner kickoff live in the shared begin helper; only the
      // name generation and base resolution are this entry's own.
      const hasBranchList = Boolean(branchesResult && branchesResult.branches.length > 0);
      // The frozen destination is peeked here and released only after admission succeeds, so a
      // preflight, reservation, or prepareSession failure keeps it for the next Retry.
      const frozen = useDraftBranchIntentStore.getState().peekFrozenWorktreeIntent(workspaceKey);
      const result = await beginWorktreePipelineCreation({
        gitService: baseServices.gitService,
        workspaceKey,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        effectiveLocation: frozen?.customLocationPath
          ? { ...effectiveLocation, mode: "custom", customPath: frozen.customLocationPath }
          : effectiveLocation,
        branchName: frozen?.branchName ?? generateComposedBranchName(),
        ...(effectiveBaseBranch && hasBranchList ? { baseBranch: effectiveBaseBranch } : {}),
        baseFromHeadDefault: !hasBranchList,
        queuedPromptPreview,
        submissionId,
        prepareSession,
        ...(syncPreparedWorktree ? { syncPreparedWorktree } : {}),
        formatMessage: (id, values) => intl.formatMessage({ id }, values),
      });
      if (result.ok && frozen) {
        useDraftBranchIntentStore.getState().releaseFrozenWorktreeIntent(workspaceKey, frozen);
      }
      return result;
    },
    [
      baseServices.gitService,
      branchesResult,
      effectiveBaseBranch,
      effectiveLocation,
      generateComposedBranchName,
      intl,
      workspaceKey,
      workspacePath,
      workspaceIdentity,
    ],
  );

  useEffect(() => {
    if (!intentSlot || !checked || !repoEligible) {
      return;
    }
    // Register the setup intent while checked; unregister on uncheck / unmount (including after a
    // workspace switch). The intent closure updates on every render while the slot keeps a stable
    // reference — no extra composer re-renders.
    const intent: ComposerDraftWorktreeIntent = { workspaceKey, beginCreation };
    intentSlot.current = intent;
    return () => {
      if (intentSlot.current === intent) {
        intentSlot.current = null;
      }
    };
  }, [beginCreation, checked, intentSlot, repoEligible, workspaceKey]);

  // Reflect the pipeline on the checkbox: settling (consumed/discarded) clears the intent; a
  // failed pipeline keeps it so the next send starts a fresh attempt.
  useEffect(() => {
    if (pipeline?.status === "consumed" || pipeline?.status === "discarded") {
      setChecked(false);
    }
  }, [pipeline?.status]);

  if (!repoEligible) {
    return null;
  }

  const checkboxId = `chat-empty-worktree-toggle-${workspacePath}`;
  return (
    <label
      htmlFor={checkboxId}
      className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2 text-ui-base/relaxed text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
    >
      <Checkbox
        id={checkboxId}
        checked={checked}
        onCheckedChange={(value) => {
          const enabled = value === true;
          setChecked(enabled);
          if (!enabled) {
            // The user changed the destination: a frozen Retry destination from a restored failure
            // must not survive into the next worktree creation (the flag-on control clears it too).
            useDraftBranchIntentStore.getState().clearFrozenWorktreeIntent(workspaceKey);
          }
          if (!enabled && (pipeline?.status === "creating" || pipeline?.status === "ready")) {
            // Withdraw: the git call is not cancellable; its result lands with an orphan note
            // and the queued send is dropped (spec: composer-worktree-setup-steps.md).
            useComposerWorktreePipelineStore.getState().withdraw(workspaceKey);
          }
        }}
      />
      <span>{intl.formatMessage({ id: "chat.empty.worktree.newWorktree" })}</span>
    </label>
  );
}

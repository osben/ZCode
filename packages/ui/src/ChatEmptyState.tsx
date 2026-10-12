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
import type { GitLocalBranchListResult, GitWorkspaceRepositoryInfo } from "@zcode/shared";
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
import {
  computeWorktreeTargetPath,
  deriveWorktreeFormValues,
  resolveWorktreeLocation,
} from "@/command-center/worktreeTaskFlow.js";
import { executeWorktreeCreation } from "@/command-center/worktreeCreation.js";
import { requestV4ComposerDraftWorkspaceTransfer } from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import { useComposerDraftWorktreeIntentSlot } from "@/v4/composer/composerDraftWorktreeIntent.js";
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

/** Gating 输入的最小 tab 结构；与 ChatEmptyWorkspaceMenuTab 结构兼容。 */
export interface ChatEmptyWorktreeGatingTab {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  remoteTarget?: unknown;
  workspacePurpose?: WorkspacePurpose;
}

/**
 * Checkbox 门槛（纯函数）：仅 Desktop 本地 shell、当前 workspace 无 remote identity、
 * 且对应 tab（若能找到）不是 remote / conversation-purpose 时才做 Git 探测。
 * 与 palette flow 的 Desktop-only 边界一致（supportsWorktreeTasks）。
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

/** 惰性 repo 探测结果：main-tree / linked-worktree 才支持创建 worktree（WT-03）。 */
export function isWorktreeCapableRepository(info: GitWorkspaceRepositoryInfo): boolean {
  return info.isGitAvailable && (info.kind === "main-tree" || info.kind === "linked-worktree");
}

/**
 * Empty-state “New worktree” checkbox：勾选后展开迷你表单（分支名 / base 预览 / 目标路径预览），
 * 并把首发拦截意图注册进 composer slot —— 用户发送首条消息时先创建 worktree、把 draft
 * 重定向到新目录（文本由既有 composer continuity 机制保留），再由用户在新 workspace 里发送。
 * 状态全部留在组件内（不进全局 store）；Git 探测按 workspacePath 缓存在组件 state。
 */
export function ChatEmptyWorktreeTaskToggle({
  workspacePath,
  workspaceIdentity,
  workspaceTabs,
  isDesktop,
  isWebRemoteControlShell,
  onOpenWorktreeDraft,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceTabs: ReadonlyArray<ChatEmptyWorkspaceMenuTab>;
  isDesktop?: boolean;
  isWebRemoteControlShell: boolean;
  /** 打开（或复用）worktree workspace 并 startDraft —— 与 palette 相同的 App 层契约。 */
  onOpenWorktreeDraft: (targetWorkspacePath: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const baseServices = useBaseWorkspaceServices();
  const { settings } = useSettings();
  // Stage F：全局存储目录只在 desktop 实现；无 provider / 方法缺失时保持 null（global 模式按无效位置处理）。
  const platform = useOptionalPlatform();
  const intentSlot = useComposerDraftWorktreeIntentSlot();
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
  // repo 探测结果按 workspacePath 缓存在组件 state；静默失败与“非 repo”同态（checkbox 不出现）。
  const [repoEligibleByPath, setRepoEligibleByPath] = useState<Record<string, boolean>>({});
  const [checked, setChecked] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [branchesResult, setBranchesResult] = useState<GitLocalBranchListResult | null>(null);
  const [busy, setBusy] = useState(false);
  /** 仅发送时才产生的错误（空分支名等）；输入时清除。live 校验问题直接渲染在输入框下。 */
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** target-path-exists 恢复入口（WT-04）：打开现有 worktree，而不是再建目录。 */
  const [recoveryPath, setRecoveryPath] = useState<string | null>(null);
  /** Stage F：懒加载的全局存储目录（仅 global 模式取，缓存于组件 state；失败静默保持 null）。 */
  const [appWorktreesDir, setAppWorktreesDir] = useState<string | null>(null);
  const repoEligible = shellEligible && repoEligibleByPath[workspacePath] === true;

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
        // 非阻塞、静默失败：探测不到仓库信息就隐藏 checkbox，不打扰 empty state。
        if (!cancelled) {
          logger.debug("[ChatEmptyWorktree] repo 探测失败，隐藏 checkbox", {
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
    // 离开当前 workspace 或取消勾选后重置表单意图；分支列表在勾选时按需加载。
    setChecked(false);
    setBranchName("");
    setBranchesResult(null);
    setSubmitError(null);
    setRecoveryPath(null);
  }, [workspacePath, repoEligible]);

  useEffect(() => {
    if (!checked || !repoEligible || branchesResult !== null) {
      return;
    }
    // 勾选时按需加载本地分支（base 解析 + 客户端预校验）。加载态由 branchesResult === null 派生，
    // 不引入会取消在飞请求的 loading 依赖。
    let cancelled = false;
    baseServices.gitService.getLocalBranches({ workspacePath }).then(
      (result) => {
        if (!cancelled) {
          // ?? null：测试替身可能 resolve undefined；与“尚未加载”同态处理。
          setBranchesResult(result ?? null);
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setSubmitError(
            intl.formatMessage(
              { id: "commandCenter.worktree.error.requestFailed" },
              { error: getErrorMessage(error) },
            ),
          );
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [baseServices.gitService, branchesResult, checked, repoEligible, workspacePath]);

  // Stage D：生效 worktree 默认值 = 全局设置 + 该项目的 override。
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
  // Stage F：仅当生效模式为 global 时向平台取 app 目录（懒加载 + 组件 state 缓存）。
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
          // 静默失败：目录不可用时 global 模式按无效位置处理（发送拦截 + 内联错误）。
          logger.debug("[ChatEmptyWorktree] getAppWorktreesDir 失败", {
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
  const {
    effectiveBaseBranch,
    trimmedBranchName,
    composedBranchName: composedBranchNameValue,
    branchNameIssue,
    customLocationInvalid,
    globalLocationUnavailable,
    targetPathPreview,
    targetPathPreviewDisplay,
  } = useMemo(
    () =>
      deriveWorktreeFormValues({
        projectPath: workspacePath,
        branchName,
        branchesResult,
        effectiveLocation,
        isWorktreeDestination: true,
      }),
    [branchName, branchesResult, effectiveLocation, workspacePath],
  );

  const openWorktreeWithDraftTransfer = useCallback(
    (targetPath: string) => {
      // 与“脱离项目”同一契约：先把草稿文本迁移请求登记，再走 App 打开 + startDraft，
      // ConversationComposer 的 scope 切换会把已输入文本带进新 workspace。
      requestV4ComposerDraftWorkspaceTransfer({
        sourceWorkspacePath: workspacePath,
        ...(workspaceIdentity ? { sourceWorkspaceIdentity: workspaceIdentity } : {}),
        targetWorkspacePath: targetPath,
      });
      setChecked(false);
      onOpenWorktreeDraft(targetPath);
    },
    [onOpenWorktreeDraft, workspaceIdentity, workspacePath],
  );

  const interceptFirstSend = useCallback(async (): Promise<boolean> => {
    if (busy) {
      return true;
    }
    // 发送前校验（镜像 palette Start 门槛）：空名 / 客户端预校验问题 / Custom 位置无效都拦截在内联表单。
    if (!trimmedBranchName) {
      setSubmitError(intl.formatMessage({ id: "chat.empty.worktree.branchNameRequired" }));
      return true;
    }
    // Ветки ещё грузятся или их загрузка упала: без списка baseBranch уйдёт undefined и
    // проектный default-base-branch override молча игнорируется — блокируем отправку.
    // Проверяется после пустого имени: оно не зависит от списка веток (иначе гонка с
    // загрузкой меняет текст ошибки).
    if (!branchesResult) {
      setSubmitError(
        (current) =>
          current ?? intl.formatMessage({ id: "commandCenter.worktree.baseBranch.loading" }),
      );
      return true;
    }
    if (branchNameIssue) {
      setSubmitError(
        intl.formatMessage({
          id:
            branchNameIssue === "branch-already-exists"
              ? "commandCenter.worktree.branchName.exists"
              : "commandCenter.worktree.branchName.invalid",
        }),
      );
      return true;
    }
    if (customLocationInvalid) {
      setSubmitError(
        intl.formatMessage({ id: "commandCenter.worktree.error.custom-location-invalid" }),
      );
      return true;
    }
    if (globalLocationUnavailable) {
      setSubmitError(
        intl.formatMessage({ id: "commandCenter.worktree.error.global-location-unavailable" }),
      );
      return true;
    }
    const targetPath = computeWorktreeTargetPath(
      workspacePath,
      composedBranchNameValue,
      effectiveLocation,
    );
    if (!targetPath) {
      setSubmitError(
        intl.formatMessage({ id: "commandCenter.worktree.error.target-path-invalid" }),
      );
      return true;
    }

    setBusy(true);
    setSubmitError(null);
    setRecoveryPath(null);
    try {
      const outcome = await executeWorktreeCreation({
        gitService: baseServices.gitService,
        workspacePath,
        branchName: composedBranchNameValue,
        baseBranch: effectiveBaseBranch || undefined,
        targetPath,
        formatMessage: (id, values) => intl.formatMessage({ id }, values),
      });
      if (outcome.kind === "created") {
        logger.info("[ChatEmptyWorktree] worktree 创建成功，重定向 draft", {
          workspacePath,
          branchName: composedBranchNameValue,
          targetPath: outcome.worktreePath,
        });
        openWorktreeWithDraftTransfer(outcome.worktreePath);
        return true;
      }
      if (outcome.kind === "existing-worktree") {
        setSubmitError(outcome.message);
        setRecoveryPath(outcome.worktreePath);
        return true;
      }
      if (outcome.errorDetail !== null) {
        logger.warn("[ChatEmptyWorktree] 创建 worktree 请求失败", {
          workspacePath,
          branchName: composedBranchNameValue,
          error: outcome.errorDetail,
        });
      } else {
        logger.warn("[ChatEmptyWorktree] 创建 worktree 被拒绝", {
          workspacePath,
          branchName: composedBranchNameValue,
          issues: outcome.issueCodes,
        });
      }
      setSubmitError(outcome.message);
      return true;
    } finally {
      setBusy(false);
    }
  }, [
    baseServices.gitService,
    branchNameIssue,
    branchesResult,
    busy,
    composedBranchNameValue,
    customLocationInvalid,
    globalLocationUnavailable,
    effectiveBaseBranch,
    effectiveLocation,
    intl,
    openWorktreeWithDraftTransfer,
    trimmedBranchName,
    workspacePath,
  ]);

  useEffect(() => {
    if (!intentSlot || !checked || !repoEligible) {
      return;
    }
    // 激活勾选时注册首发拦截；取消勾选 / 组件卸载（含 workspace 切换后）即注销。
    // 拦截器闭包随每次渲染更新，slot 本身保持稳定引用，不触发 composer 额外重渲染。
    const intent = {
      workspaceKey: resolveWorkspaceKey({ workspacePath, workspaceIdentity }),
      interceptFirstSend,
    };
    intentSlot.current = intent;
    return () => {
      if (intentSlot.current === intent) {
        intentSlot.current = null;
      }
    };
  }, [checked, intentSlot, interceptFirstSend, repoEligible, workspaceIdentity, workspacePath]);

  if (!repoEligible) {
    return null;
  }

  const checkboxId = `chat-empty-worktree-toggle-${workspacePath}`;
  return (
    <>
      <label
        htmlFor={checkboxId}
        className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2 text-ui-base/relaxed text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
      >
        <Checkbox
          id={checkboxId}
          checked={checked}
          disabled={busy}
          onCheckedChange={(value) => {
            setChecked(value === true);
            setSubmitError(null);
            setRecoveryPath(null);
          }}
        />
        <span>{intl.formatMessage({ id: "chat.empty.worktree.newWorktree" })}</span>
      </label>
      {checked ? (
        <div className="flex w-full min-w-0 flex-col gap-1 px-1 pt-0.5 pb-1">
          <input
            aria-label={intl.formatMessage({ id: "commandCenter.worktree.branchName" })}
            value={branchName}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            placeholder={intl.formatMessage({
              id: "commandCenter.worktree.branchName.placeholder",
            })}
            onChange={(event) => {
              setBranchName(event.target.value);
              setSubmitError(null);
            }}
            className={cn(
              "h-7 w-full rounded-md border border-input-border bg-input px-2 font-mono text-ui-base text-foreground outline-none transition-colors",
              "placeholder:font-sans placeholder:text-foreground-subtlest",
              "hover:border-input-border-hover focus:border-input-border-focused focus:bg-input-focused",
              (branchNameIssue || submitError) && !busy ? "border-destructive" : undefined,
            )}
          />
          {branchNameIssue ? (
            <p className="text-ui-sm text-destructive">
              {intl.formatMessage({
                id:
                  branchNameIssue === "branch-already-exists"
                    ? "commandCenter.worktree.branchName.exists"
                    : "commandCenter.worktree.branchName.invalid",
              })}
            </p>
          ) : null}
          {submitError && !branchNameIssue ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {submitError}
            </p>
          ) : null}
          {/* WTS-02：有生效 prefix 时预览最终分支名；创建与校验都用合成后的值。 */}
          {effectiveLocation.prefix && trimmedBranchName ? (
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage(
                { id: "commandCenter.worktree.branchName.final" },
                { name: composedBranchNameValue },
              )}
            </p>
          ) : null}
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="shrink-0 text-ui-sm text-foreground-subtle">
              {intl.formatMessage(
                { id: "chat.empty.worktree.baseBranch" },
                {
                  branch:
                    effectiveBaseBranch ||
                    intl.formatMessage({ id: "commandCenter.worktree.baseBranch.loading" }),
                },
              )}
            </span>
            {busy ? (
              <span className="shrink-0 text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "chat.empty.worktree.creating" })}
              </span>
            ) : targetPathPreviewDisplay ? (
              <span
                className="min-w-0 truncate font-mono text-ui-sm text-foreground-subtlest"
                title={targetPathPreview ?? undefined}
              >
                {targetPathPreviewDisplay}
              </span>
            ) : null}
          </div>
          {recoveryPath ? (
            <div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => openWorktreeWithDraftTransfer(recoveryPath)}
              >
                {intl.formatMessage({ id: "commandCenter.worktree.openExisting" })}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

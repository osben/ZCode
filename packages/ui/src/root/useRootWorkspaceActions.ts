/* eslint-disable max-lines -- The root workspace-action hook coordinates project, remote, and conversation entry points; keep action boundaries intact during consolidation and split by domain later. */
import { useCallback, useEffect, useState } from "react";
import {
  DesktopCommandIds,
  type AppSettings,
  type IPlatformService,
  type RemoteTarget,
  type UserInfo,
  type ZCodeTaskClientMode,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { resolveLogoutProviderFamilyDomain } from "@/lib/providerFamilyDomainSettings.js";
import { isRendererReloadNavigation } from "@/lib/rendererNavigation.js";
import { parseWslUncWorkspacePath } from "@/lib/wslUncWorkspace.js";
import { logger } from "@/logger.js";
import { openFolderFromWorkspaceEntry } from "@/root/openWorkspaceFolderEntry.js";
import { useConversationWorkspaceActions } from "@/root/useConversationWorkspaceActions.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { isWorkspaceReadOnly, type TabStore, type TabStoreState } from "@/store/tabStore.js";
import type { RootProps } from "@/root/types.js";
import {
  hadPersistedPaneLayoutAtModuleLoad,
  INITIAL_PANE_LAYOUT,
  usePaneLayoutStore,
} from "@/v4/paneLayoutStore.js";
import { resolveWorkbenchNewTaskTarget } from "@/v4/workbenchNewTaskTarget.js";
import type { WorkbenchNewTaskTarget } from "@/v4/workbenchNewTaskTarget.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
import { persistV4ComposerDraft, V4_DRAFT_SCOPE_ROOT } from "@/v4/composer/composerDraftStore.js";

interface OpenRemoteConnectionPreference {
  preferredKind?: RemoteTarget["kind"];
  preferredWslDistro?: string;
}

/** New-task destination: normalize an omitted identity to null for shared read-only checks and focus/addTab handling. */
interface NewTaskTargetResolution {
  workspacePath: string;
  workspaceIdentity: string | null;
}

/**
 * Resolve the new-task destination: when a request explicitly includes targetWorkspace (starting a saved workflow across projects), use it directly without checking workbench focus;
 * otherwise, lazily fall back to resolveWorkbenchNewTaskTarget. Normalize an omitted identity to null.
 */
function resolveNewTaskTargetFromRequest(
  request: CreateTaskRequest | undefined,
  resolveFallback: () => WorkbenchNewTaskTarget | null,
): NewTaskTargetResolution | null {
  const targetWorkspace =
    typeof request === "string" || !request ? undefined : request.targetWorkspace;
  if (targetWorkspace) {
    return {
      workspacePath: targetWorkspace.workspacePath,
      workspaceIdentity: targetWorkspace.workspaceIdentity ?? null,
    };
  }
  const fallback = resolveFallback();
  if (!fallback) {
    return null;
  }
  return {
    workspacePath: fallback.workspacePath,
    workspaceIdentity: fallback.workspaceIdentity ?? null,
  };
}

export function useRootWorkspaceActions({
  intl,
  platform,
  services,
  tabStoreApi,
  addTab,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  supportsSettings,
  allowOpenWorkspace,
  preferDirectoryBrowser,
  openDirectoryBrowser,
  refreshProviderState,
  updateAppSettings,
  setOAuthError,
  setUser,
  onProviderFamilyDomainClearedAfterLogout,
  userId,
  onOpenRemoteConnection,
  workbenchGroupClientMode = "desktop-continuous",
}: {
  intl: ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["intl"];
  platform: IPlatformService;
  services: IServiceAccessor;
  tabStoreApi: TabStore;
  addTab: TabStoreState["addTab"];
  activeWorkspacePath: string | null;
  activeWorkspaceIdentity: string | null;
  supportsSettings: boolean;
  allowOpenWorkspace: NonNullable<RootProps["allowOpenWorkspace"]>;
  preferDirectoryBrowser: boolean;
  openDirectoryBrowser?: () => void;
  refreshProviderState: () => Promise<void>;
  updateAppSettings: (patch: Partial<AppSettings>) => Promise<void>;
  setOAuthError: (error: string | null) => void;
  setUser: (user: UserInfo | null) => void;
  onProviderFamilyDomainClearedAfterLogout?: () => void;
  userId?: string;
  onOpenRemoteConnection?: (preference?: OpenRemoteConnectionPreference) => void;
  workbenchGroupClientMode?: ZCodeTaskClientMode;
}) {
  const [workspaceActionError, setWorkspaceActionError] = useState<string | null>(null);
  const requestConfirmation = useConfirmDialog();
  const {
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask,
  } = useConversationWorkspaceActions({
    services,
    addTab,
    setWorkspaceActionError,
  });

  useEffect(() => {
    useWorkbenchGroupStore.getState().configureClientMode(workbenchGroupClientMode);
    if (workbenchGroupClientMode === "desktop-continuous" && !isRendererReloadNavigation()) {
      // group/pane are persisted renderer-local UI state. Activating them directly on app cold start would show historical sessions
      // even when activeTaskId=null, violating startup-draft semantics. Renderer reloads retain restoration eligibility to resume streaming output.
      const workbenchState = useWorkbenchGroupStore.getState();
      const activeGroup = workbenchState.activeGroupId
        ? workbenchState.groups[workbenchState.activeGroupId]
        : null;
      const activeGroupWasRestored = Boolean(
        activeGroup &&
        [activeGroup.primaryBinding, ...Object.values(activeGroup.panes)].some(
          (binding) => binding.restoredUnvalidated,
        ),
      );
      if (activeGroupWasRestored) {
        workbenchState.deactivateActiveGroup();
      }
      if (hadPersistedPaneLayoutAtModuleLoad()) {
        usePaneLayoutStore.getState().resetToPrimaryPane();
      }
    }
  }, [workbenchGroupClientMode]);

  const startDraftInWorkspace = useCallback(
    (workspacePath: string, workspaceIdentity?: string) => {
      if (workbenchGroupClientMode === "desktop-continuous") {
        useWorkbenchGroupStore.getState().deactivateActiveGroup();
        usePaneLayoutStore.getState().resetToPrimaryPane();
      }
      useZCodeSessionStore.getState().startDraft(workspacePath, undefined, workspaceIdentity);
    },
    [workbenchGroupClientMode],
  );

  const startNewTaskFromActiveWorkspace = useCallback(
    (source: string, request?: CreateTaskRequest) => {
      const state = tabStoreApi.getState();
      const {
        activeWorkspacePath: currentActiveWorkspacePath,
        activeWorkspaceIdentity: currentActiveWorkspaceIdentity,
        activateTabByPath: focusWorkspace,
      } = state;
      const workbenchGroupState = useWorkbenchGroupStore.getState();
      const activeGroup =
        workbenchGroupClientMode === "desktop-continuous" && workbenchGroupState.activeGroupId
          ? (workbenchGroupState.groups[workbenchGroupState.activeGroupId] ?? null)
          : null;
      // When starting a saved workflow across projects, the new task must belong to the workflow's project, not the active project.
      // Use targetWorkspace when explicitly supplied; otherwise lazily fall back to workbench-focus resolution. With no target, behavior remains byte-for-byte identical to the old version.
      const newTaskTarget = resolveNewTaskTargetFromRequest(request, () =>
        resolveWorkbenchNewTaskTarget({
          activeWorkspacePath: currentActiveWorkspacePath,
          activeWorkspaceIdentity: currentActiveWorkspaceIdentity,
          activeGroup,
          // Remote does not display paneLayout, but the renderer may still have a desktop focused secondary pane.
          // Locate the new task from the visible shell workspace rather than consuming a hidden pane.
          paneLayout:
            workbenchGroupClientMode === "desktop-continuous"
              ? usePaneLayoutStore.getState()
              : INITIAL_PANE_LAYOUT,
        }),
      );

      if (
        typeof request === "object" &&
        request.expectedWorkspaceKey &&
        request.expectedWorkspaceKey !==
          (newTaskTarget?.workspaceIdentity?.trim() || newTaskTarget?.workspacePath)
      ) {
        return;
      }
      if (!newTaskTarget) {
        logger.error(`[Root] ${source} failed: no active workspace`);
        setWorkspaceActionError(intl.formatMessage({ id: "workspace.noActiveForNewTask" }));
        return;
      }

      // Disabling the button does not cover desktop menus or keyboard shortcuts. Recheck an invalid startup workspace at the action boundary
      // so a read-only history page cannot implicitly switch back to a sendable draft.
      if (
        isWorkspaceReadOnly(
          state,
          newTaskTarget.workspacePath,
          newTaskTarget.workspaceIdentity ?? undefined,
        )
      ) {
        return;
      }

      if (
        !focusWorkspace(
          newTaskTarget.workspacePath,
          newTaskTarget.workspaceIdentity
            ? { workspaceIdentity: newTaskTarget.workspaceIdentity }
            : undefined,
        )
      ) {
        addTab(
          newTaskTarget.workspacePath,
          newTaskTarget.workspaceIdentity
            ? { workspaceIdentity: newTaskTarget.workspaceIdentity }
            : undefined,
        );
      }

      setWorkspaceActionError(null);
      const provider = typeof request === "string" ? request : request?.provider;
      const groupedDraftPlacement =
        typeof request === "string" ? undefined : request?.groupedDraftPlacement;
      const rawInitialPrompt = typeof request === "string" ? undefined : request?.initialPrompt;
      // The trailing space after a Skill mention places the cursor after the chip; trimming before saving would remove that editable spacing.
      // Use trim only to check for emptiness and preserve the caller's original text for non-empty drafts.
      const initialPrompt = rawInitialPrompt?.trim() ? rawInitialPrompt : undefined;
      const initialPromptMention =
        typeof request === "string" ? undefined : request?.initialPromptMention;
      logger.info(`[Root] ${source}:`, newTaskTarget.workspacePath, provider ?? "default-provider");
      // Cmd/Ctrl+N creates a new single-panel draft rather than adding another draft to the current workbench group/paneLayout; use the focused pane's workspace.
      useWorkbenchGroupStore.getState().deactivateActiveGroup();
      usePaneLayoutStore.getState().resetToPrimaryPane();
      useZCodeSessionStore
        .getState()
        .startDraft(
          newTaskTarget.workspacePath,
          provider,
          newTaskTarget.workspaceIdentity ?? undefined,
          {
            groupedDraftPlacement,
            createSource: typeof request === "string" ? undefined : request?.createSource,
          },
        );
      if (initialPrompt) {
        // The first composer clears the insert request after consuming it. If a pane/config switch then remounts it,
        // the new composer restores an empty __draft__ and overwrites the prefill. Write the draft source of truth first,
        // then send the immediate insert request: the current composer displays it now, and later remounts restore the same text.
        persistV4ComposerDraft(
          newTaskTarget.workspacePath,
          newTaskTarget.workspaceIdentity ?? undefined,
          V4_DRAFT_SCOPE_ROOT,
          {
            text: initialPrompt,
            ...(initialPromptMention ? { mention: initialPromptMention } : {}),
          },
        );
        useZCodeSessionStore
          .getState()
          .requestComposerTextInsert(
            newTaskTarget.workspacePath,
            initialPrompt,
            newTaskTarget.workspaceIdentity ?? undefined,
            initialPromptMention,
          );
      }
    },
    [addTab, intl, tabStoreApi, workbenchGroupClientMode],
  );

  const handleLogout = useCallback(async () => {
    let runningAgentSessionCount: number | null = null;
    try {
      const sessionActivity = await platform.getDesktopSessionActivity?.();
      runningAgentSessionCount =
        typeof sessionActivity?.runningAgentSessionCount === "number"
          ? sessionActivity.runningAgentSessionCount
          : null;
    } catch (error) {
      logger.warn("[Root] 查询桌面运行中会话数量失败，使用保守退出登录文案", { error });
    }

    const confirmed = await requestConfirmation({
      title: intl.formatMessage({ id: "logout.confirm.title" }),
      description:
        runningAgentSessionCount !== null && runningAgentSessionCount > 0
          ? intl.formatMessage(
              { id: "logout.confirm.descriptionWithRunningSessions" },
              { count: String(runningAgentSessionCount) },
            )
          : intl.formatMessage({ id: "logout.confirm.descriptionDefault" }),
      confirmLabel: intl.formatMessage({ id: "logout.confirm.ok" }),
      cancelLabel: intl.formatMessage({ id: "logout.confirm.cancel" }),
    });
    if (!confirmed) {
      return;
    }

    // Bug cause: telemetry is an auxiliary path; waiting for network retries delays logout and, in the old implementation without a timeout,
    // could block the main flow forever. Schedule the event here; Main handles bounded retries and draining during logout.
    void reportAppTelemetryEvent(
      platform,
      {
        elementName: "app_user_logout",
        eventRegion: "app_profile",
        eventType: "ck",
        eventExtraDetail: {},
        userId,
      },
      "Root",
    );
    const settingsBeforeLogout = await services.settingService.get();
    const nextProviderFamilyDomain = resolveLogoutProviderFamilyDomain({
      currentDomain: settingsBeforeLogout.providerFamilyDomain,
    });
    await services.oauthService.logout();
    await updateAppSettings({
      providerFamilyDomain: (nextProviderFamilyDomain ?? "") as AppSettings["providerFamilyDomain"],
      providerFamilyDomainUpdatedAt: Date.now(),
      providerFamilyDomainMigrated: true,
    });
    if (!nextProviderFamilyDomain) {
      onProviderFamilyDomainClearedAfterLogout?.();
    }
    // ZAI/BigModel provider has returned to the App login mirror.
    // The OAuth logout host hook centrally clears derived Coding/Start keys; Root only refreshes the displayed state.
    setOAuthError(null);
    setUser(null);
    // Refresh Account Source and Registry after logout so the UI does not keep showing the provider state from before logout.
    await refreshProviderState();
    // The Coding Plan website webview uses a separate persistent partition, which App logout must clear too.
    await platform.executeDesktopCommand(DesktopCommandIds.ClearCodingPlanWebviewStorage);
    await platform.executeDesktopCommand(DesktopCommandIds.RelaunchApp);
  }, [
    intl,
    requestConfirmation,
    refreshProviderState,
    onProviderFamilyDomainClearedAfterLogout,
    platform,
    services.oauthService,
    services.modelSelectionService,
    services.settingService,
    setOAuthError,
    setUser,
    updateAppSettings,
    userId,
  ]);

  const handleSelectProject = useCallback(
    async (path: string) => {
      logger.info("[Root] handleSelectProject called with path:", path);
      try {
        const wslUncWorkspace = parseWslUncWorkspacePath(path);
        if (wslUncWorkspace && onOpenRemoteConnection) {
          const shouldOpenWslConnection = await requestConfirmation({
            title: intl.formatMessage({ id: "workspace.wslUncPrompt.title" }),
            description: intl.formatMessage(
              { id: "workspace.wslUncPrompt.description" },
              {
                path,
              },
            ),
            confirmLabel: intl.formatMessage({ id: "workspace.wslUncPrompt.openWsl" }),
            cancelLabel: intl.formatMessage({ id: "workspace.wslUncPrompt.continuePath" }),
          });
          if (shouldOpenWslConnection) {
            logger.info("[Root] 用户选择通过 WSL 远程连接打开 UNC 工作区", {
              distro: wslUncWorkspace.distro,
              path,
            });
            onOpenRemoteConnection({
              preferredKind: "wsl",
              preferredWslDistro: wslUncWorkspace.distro,
            });
            return;
          }
        }

        // Desktop: check whether another window already has this directory open and activate the corresponding tab if so.
        const result = await platform.activateOrSetWorkspace(path);
        if (result.activated) {
          logger.info("[Root] 目录已在其他窗口打开，已激活该窗口对应 tab，跳过重复打开");
          return;
        }

        // Add a tab, or activate it if already open in this window.
        addTab(path);
        // Opening a workspace is a workspace-only intent, not “continue the previous conversation.”
        // Even when an existing tab is matched, clear that workspace's activeTaskId and return to a single-pane draft.
        startDraftInWorkspace(path);
        setWorkspaceActionError(null);

        // Update the recent-project list.
        if (supportsSettings) {
          // The remote-window host does not provide settingService. Updating recentProjects here previously made SSH
          // flows hit a nonexistent settings channel again after opening a project.
          // Only local windows maintain recent projects; remote windows only open the current workspace.
          logger.info("[Root] calling settingService.get()...");
          const settings = await services.settingService.get();
          const updated = [
            path,
            ...settings.recentProjects.filter((projectPath) => projectPath !== path),
          ].slice(0, 10);
          await services.settingService.update({ recentProjects: updated });
          // The system recent-document entry in Dock/Jump List has been removed. Keep only the in-app recentProjects list
          // to avoid maintaining a duplicate system list that could drift from the project picker.
          logger.info("[Root] settingService.update() done");
        }
      } catch (err) {
        logger.error("[Root] handleSelectProject error:", err);
      }
    },
    [
      addTab,
      intl,
      onOpenRemoteConnection,
      platform,
      requestConfirmation,
      services.settingService,
      startDraftInWorkspace,
      supportsSettings,
    ],
  );

  const handleOpenWorkspace = useCallback(() => {
    if (!allowOpenWorkspace) {
      // Web remote control currently supports only entering workspaces already open on Desktop.
      // This previously allowed “Open workspace” and sent the user to an intermediate page, but the later new-workspace/new-conversation
      // flow was not implemented for Web remote control, making the page look stuck. Block the entry here rather than exposing a partially supported state.
      logger.info("[Root] 当前模式不支持打开其他工作区，已忽略请求");
      return;
    }
    setWorkspaceActionError(null);

    if (preferDirectoryBrowser) {
      void openFolderFromWorkspaceEntry({
        preferDirectoryBrowser,
        openDirectoryBrowser,
        selectDirectory: () => platform.selectDirectory(),
        onSelectProject: (path) => {
          void handleSelectProject(path);
        },
      });
      return;
    }

    // Showing the open-workspace intermediate page as a “new tab” took over the entire page on startup empty state, Cmd/Ctrl+O,
    // and menu navigation. Keep opening a workspace as an action: locally, open the system directory picker directly instead of navigating
    // to an intermediate page; shells without a system directory picker rely on startup fallback to create a default workspace.
    if (!supportsSettings) {
      void handleEnsureConversationWorkspace().catch((error) => {
        logger.error("[Root] 创建对话 workspace 失败", { error });
      });
      return;
    }

    void openFolderFromWorkspaceEntry({
      selectDirectory: () => platform.selectDirectory(),
      onSelectProject: (path) => {
        void handleSelectProject(path);
      },
    });
  }, [
    allowOpenWorkspace,
    handleEnsureConversationWorkspace,
    handleSelectProject,
    openDirectoryBrowser,
    platform,
    preferDirectoryBrowser,
    supportsSettings,
  ]);

  const handleOpenFolderFromWorkspaceMenu = useCallback(() => {
    if (!allowOpenWorkspace) {
      logger.info("[Root] 当前模式不支持从空态菜单打开文件夹，已忽略请求");
      return;
    }

    // Open folder in the empty-state workspace menu must reuse the root-level open-workspace action.
    // Call the same entry function here, injecting only Root's selectDirectory and project-selection callbacks.
    if (preferDirectoryBrowser) {
      void openFolderFromWorkspaceEntry({
        preferDirectoryBrowser,
        openDirectoryBrowser,
        selectDirectory: () => platform.selectDirectory(),
        onSelectProject: (path) => {
          void handleSelectProject(path);
        },
      });
      return;
    }

    if (!supportsSettings) {
      void handleEnsureConversationWorkspace().catch((error) => {
        logger.error("[Root] 从空态菜单创建对话 workspace 失败", { error });
      });
      return;
    }

    void openFolderFromWorkspaceEntry({
      selectDirectory: () => platform.selectDirectory(),
      onSelectProject: (path) => {
        void handleSelectProject(path);
      },
    });
  }, [
    allowOpenWorkspace,
    handleEnsureConversationWorkspace,
    handleSelectProject,
    openDirectoryBrowser,
    platform,
    preferDirectoryBrowser,
    supportsSettings,
  ]);

  const handleCreateScratchWorkspace = useCallback(
    async (name: string) => {
      if (!allowOpenWorkspace) {
        logger.info("[Root] 当前模式不支持从空态菜单创建工作区，已忽略请求");
        return null;
      }

      const result = await services.fileService.createScratchWorkspace({ name });
      await handleSelectProject(result.path);
      return result.path;
    },
    [allowOpenWorkspace, handleSelectProject, services.fileService],
  );

  const handleCreateTask = useCallback(
    (request?: CreateTaskRequest) => {
      startNewTaskFromActiveWorkspace("sidebar new task", request);
    },
    [startNewTaskFromActiveWorkspace],
  );

  const handleBackFromSettings = useCallback(() => {
    if (!activeWorkspacePath) {
      return;
    }

    // When returning to a recent workspace from Settings, do not activate by path alone.
    // Multiple remote identities may share a path; dropping activeWorkspaceIdentity would switch the remote workspace into a path-only bucket.
    tabStoreApi
      .getState()
      .activateTabByPath(
        activeWorkspacePath,
        activeWorkspaceIdentity ? { workspaceIdentity: activeWorkspaceIdentity } : undefined,
      );
  }, [activeWorkspaceIdentity, activeWorkspacePath, tabStoreApi]);

  return {
    workspaceActionError,
    setWorkspaceActionError,
    startDraftInWorkspace,
    startNewTaskFromActiveWorkspace,
    handleLogout,
    handleSelectProject,
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask,
    handleOpenWorkspace,
    handleOpenFolderFromWorkspaceMenu,
    handleCreateScratchWorkspace,
    handleCreateTask,
    handleBackFromSettings,
  };
}

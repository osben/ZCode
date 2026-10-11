import type { AppSettings, RemoteWorkspaceSessionEntry } from "@zcode/shared";
import { resolveStartupLocalWorkspaceSessionIndex } from "@zcode/shared";
import {
  buildPersistedWorkspaceSessionEntries,
  buildRemoteWorkspaceSessionEntryMap,
  buildWorkspaceSessionKey,
  readPersistedWorkspaceSessionEntries,
  resolveRemoteWorkspaceSessionIdentity,
} from "@/lib/remoteWorkspaceHistory.js";
import { logger } from "@/logger.js";
import {
  isWorkspaceTab,
  type RestorableWorkspaceTab,
  type TabStore,
  type TabStoreState,
} from "@/store/tabStore.js";

function getRestorableWorkspaceKey(tab: string | RestorableWorkspaceTab): string {
  if (typeof tab === "string") {
    return tab;
  }
  return tab.workspaceIdentity?.trim() || tab.workspacePath;
}

export function buildRemoteWorkspacePersistPatch(
  state: TabStoreState,
  remoteSessions: readonly RemoteWorkspaceSessionEntry[],
): Partial<AppSettings> {
  const remoteSessionMap = buildRemoteWorkspaceSessionEntryMap(remoteSessions);
  const serializedWorkspaceSessions = buildPersistedWorkspaceSessionEntries(
    state.tabs,
    remoteSessionMap,
  );
  const serializedRemoteWorkspaceKeys = new Set(
    serializedWorkspaceSessions.flatMap((entry) =>
      entry.kind === "remote" ? [buildWorkspaceSessionKey(entry)] : [],
    ),
  );
  const pendingRemoteSessions = remoteSessions.filter(
    (entry) => !serializedRemoteWorkspaceKeys.has(buildWorkspaceSessionKey(entry)),
  );
  const workspaceTabs = state.tabs.filter((tab) => tab.kind === "workspace");
  const activeIndex = state.activeWorkspacePath
    ? workspaceTabs.findIndex((tab) => tab.workspacePath === state.activeWorkspacePath)
    : 0;

  return {
    // When the SSH entry point is hidden, remote tab restoration is skipped and only local tabs remain.
    // If serialization uses only the current tabs here, the next setting.json write erases the entire remote session snapshot.
    // Merge “currently serialized items + remote snapshots absent from tabs” so they can reconnect after the entry point is restored.
    lastWorkspaceSession: [...serializedWorkspaceSessions, ...pendingRemoteSessions],
    lastActiveTabIndex: Math.max(activeIndex, 0),
  };
}

export function restorePersistedRemoteWorkspaceSessions({
  settings,
  tabStoreApi,
  allowRemoteWorkspaceRestore = true,
  unavailableWorkspacePath,
  conversationWorkspacePath,
  restoreMode = "all",
}: {
  settings: AppSettings;
  tabStoreApi: TabStore;
  allowRemoteWorkspaceRestore?: boolean;
  unavailableWorkspacePath?: string;
  conversationWorkspacePath?: string;
  restoreMode?: "all" | "active-first";
}): { deferredRestore?: () => void } | undefined {
  const persistedSessions = readPersistedWorkspaceSessionEntries(settings);

  if (persistedSessions.length === 0 && !conversationWorkspacePath) {
    return;
  }

  const restoredTabs: Array<string | RestorableWorkspaceTab> = [];
  const seenLocalWorkspacePaths = new Set<string>();
  const seenRemoteWorkspaceKeys = new Set<string>();
  const activeSessionIndex = resolveStartupLocalWorkspaceSessionIndex(
    persistedSessions,
    settings.lastActiveTabIndex,
  );
  let restoredActiveIndex = 0;
  let canonicalConversationRestoredIndex: number | null = null;
  let shouldActivateCanonicalConversation = false;

  for (const [index, persistedEntry] of persistedSessions.entries()) {
    if (persistedEntry.kind === "local") {
      const isStaleConversationWorkspace = Boolean(
        conversationWorkspacePath &&
        persistedEntry.workspacePurpose === "conversation" &&
        persistedEntry.workspacePath !== conversationWorkspacePath,
      );
      if (isStaleConversationWorkspace) {
        // A test data root or old data root may persist multiple conversation backing paths;
        // these are one logical “session without a project,” so recovery must use the canonical path from the service
        // or the sidebar and scheduled-task picker will show multiple defaults.
        logger.warn("[Root] 跳过非 canonical conversation workspace 恢复", {
          workspacePath: persistedEntry.workspacePath,
          conversationWorkspacePath,
        });
        if (index === activeSessionIndex) {
          shouldActivateCanonicalConversation = true;
          if (canonicalConversationRestoredIndex !== null) {
            restoredActiveIndex = canonicalConversationRestoredIndex;
          }
        }
        continue;
      }

      if (seenLocalWorkspacePaths.has(persistedEntry.workspacePath)) {
        logger.warn("[Root] 跳过重复的本地 workspace 恢复", {
          workspacePath: persistedEntry.workspacePath,
        });
        continue;
      }

      const isConversationWorkspace = persistedEntry.workspacePath === conversationWorkspacePath;
      const workspacePurpose = isConversationWorkspace
        ? "conversation"
        : persistedEntry.workspacePurpose;
      const availability =
        !isConversationWorkspace && persistedEntry.workspacePath === unavailableWorkspacePath
          ? "unavailable-local-directory"
          : undefined;
      restoredTabs.push(
        workspacePurpose || availability
          ? {
              workspacePath: persistedEntry.workspacePath,
              workspacePurpose,
              availability,
            }
          : persistedEntry.workspacePath,
      );
      seenLocalWorkspacePaths.add(persistedEntry.workspacePath);
      const restoredIndex = restoredTabs.length - 1;
      if (isConversationWorkspace) {
        canonicalConversationRestoredIndex = restoredIndex;
      }
      if (
        index === activeSessionIndex ||
        (isConversationWorkspace && shouldActivateCanonicalConversation)
      ) {
        restoredActiveIndex = restoredIndex;
      }
      continue;
    }

    const workspaceIdentity = resolveRemoteWorkspaceSessionIdentity(persistedEntry);
    const workspaceKey = workspaceIdentity?.trim() || persistedEntry.workspacePath;
    if (seenRemoteWorkspaceKeys.has(workspaceKey)) {
      logger.warn("[Root] 跳过身份冲突的远程 workspace 恢复", {
        workspacePath: persistedEntry.workspacePath,
        workspaceIdentity,
      });
      continue;
    }

    if (!allowRemoteWorkspaceRestore) {
      // When policy hides the remote-connection entry point, startup recovery must not silently restore a remote workspace tab.
      // Otherwise, users see no entry point but retain a “disconnected remote item,” making capabilities and presentation inconsistent.
      continue;
    }

    // On startup, restore only “disconnected remote tabs”; do not reconnect automatically.
    // That keeps lastConnectionStatus in setting.json truthful to the previous result,
    // and prevents a remote tab the user closed from returning in the background next time.
    restoredTabs.push({
      workspacePath: persistedEntry.workspacePath,
      remoteTarget: persistedEntry.target,
      workspaceIdentity,
    });
    seenRemoteWorkspaceKeys.add(workspaceKey);
  }

  if (conversationWorkspacePath && !seenLocalWorkspacePaths.has(conversationWorkspacePath)) {
    // The conversation backing workspace uses an app-owned cwd. If older settings omit it,
    // the sidebar does not subscribe to that scope; if purpose is also missing, it may be treated as a project. Use the canonical path resolved by the service during recovery,
    // and create it as a non-active tab while forcing the conversation purpose.
    restoredTabs.push({
      workspacePath: conversationWorkspacePath,
      workspacePurpose: "conversation",
    });
    canonicalConversationRestoredIndex = restoredTabs.length - 1;
    if (shouldActivateCanonicalConversation) {
      restoredActiveIndex = canonicalConversationRestoredIndex;
    }
  }

  if (restoredTabs.length > 0) {
    if (restoreMode === "active-first" && restoredTabs.length > 1) {
      const activeTab = restoredTabs[restoredActiveIndex];
      if (activeTab) {
        const activeWorkspaceKey = getRestorableWorkspaceKey(activeTab);
        logger.info("[Root] 优先恢复 active workspace", {
          deferredCount: restoredTabs.length - 1,
        });
        tabStoreApi.getState().restoreTabs([activeTab], 0);
        return {
          deferredRestore: () => {
            const startupActiveStillOpen = tabStoreApi
              .getState()
              .tabs.filter(isWorkspaceTab)
              .some(
                (tab) =>
                  (tab.workspaceIdentity?.trim() || tab.workspacePath) === activeWorkspaceKey,
              );
            // active-first saves an old settings snapshot; if the user closes the active tab before the idle callback,
            // completing directly would revive it from the old snapshot. Closing is new intent in this window, so exclude that identity when filling gaps.
            const tabsToComplete = startupActiveStillOpen
              ? restoredTabs
              : restoredTabs.filter(
                  (restoredTab) => getRestorableWorkspaceKey(restoredTab) !== activeWorkspaceKey,
                );
            logger.info("[Root] 首帧后补齐 inactive workspace", {
              count: tabsToComplete.length - (startupActiveStillOpen ? 1 : 0),
            });
            tabStoreApi.getState().completeTabRestore(tabsToComplete);
          },
        };
      }
    }
    logger.info("[Root] 恢复组合 workspace 会话", {
      count: restoredTabs.length,
      activeIndex: restoredActiveIndex,
    });
    tabStoreApi.getState().restoreTabs(restoredTabs, restoredActiveIndex);
  }
  return undefined;
}

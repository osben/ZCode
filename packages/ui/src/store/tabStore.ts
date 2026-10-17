/* oxlint-disable eslint(max-lines) */
/** Tab Store — manages multi-tab state. Each window owns an independent tab store (not broadcast across windows). Tab state is persisted through settingService (see useTabPersistence). */
import { create } from "zustand";
import {
  createUuid,
  type RemoteTarget,
  type TabId,
  type TabState,
  type WorkspacePurpose,
} from "@zcode/shared";
import {
  persistWorkspaceExpandedPreference,
  readWorkspaceExpansionState,
  resolveExpandedWorkspacePaths,
  type WorkspaceExpansionState,
} from "@/lib/workspaceExpansionPreference.js";
import { isSameWorkspaceTab } from "@/store/tabWorkspaceIdentity.js";

export const SETTINGS_TAB_ID = "__settings__" satisfies TabId;
export const SESSION_MANAGER_TAB_ID = "__sessions__" satisfies TabId;

/** Workspace the sessions manager was opened for; omitted means the unscoped all-workspaces view. */
export interface SessionManagerScope {
  workspacePath: string;
  workspaceIdentity?: string;
}

export type WorkspaceAvailability = "available" | "unavailable-local-directory";

export interface SettingsTabState {
  id: typeof SETTINGS_TAB_ID;
  kind: "settings";
  label: "settings";
}

/** Full-area sessions-manager surface; scope is navigation state and is not persisted with the window session. */
export interface SessionManagerTabState {
  id: typeof SESSION_MANAGER_TAB_ID;
  kind: "session-manager";
  label: "sessions";
  scope?: SessionManagerScope;
}

export interface WorkspaceTabState extends TabState {
  kind: "workspace";
  /** One-time validation result during startup; not persisted or rechecked at runtime. */
  availability?: WorkspaceAvailability;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  remoteHistoryId?: string;
  workspaceIdentity?: string;
  localWorkspacePath?: string;
  workspacePurpose?: WorkspacePurpose;
}

export interface WorkspaceTabOptions {
  availability?: WorkspaceAvailability;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  remoteHistoryId?: string;
  workspaceIdentity?: string;
  localWorkspacePath?: string;
  workspacePurpose?: WorkspacePurpose;
}

export interface RestorableWorkspaceTab {
  workspacePath: string;
  availability?: WorkspaceAvailability;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  workspaceIdentity?: string;
  localWorkspacePath?: string;
  workspacePurpose?: WorkspacePurpose;
}

export type WindowTabState = WorkspaceTabState | SettingsTabState | SessionManagerTabState;

export function isWorkspaceTab(tab: WindowTabState): tab is WorkspaceTabState {
  return tab.kind === "workspace";
}

export function isWorkspaceTabReadOnly(tab: WindowTabState): tab is WorkspaceTabState & {
  availability: "unavailable-local-directory";
} {
  return isWorkspaceTab(tab) && tab.availability === "unavailable-local-directory";
}

export function isWorkspaceReadOnly(
  state: Pick<TabStoreState, "tabs">,
  workspacePath: string,
  workspaceIdentity?: string,
): boolean {
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  return state.tabs.some(
    (tab) =>
      isWorkspaceTabReadOnly(tab) &&
      (tab.workspaceIdentity?.trim() || tab.workspacePath) === workspaceKey,
  );
}

export function isSettingsTab(tab: WindowTabState): tab is SettingsTabState {
  return tab.kind === "settings";
}

export function isSessionManagerTab(tab: WindowTabState): tab is SessionManagerTabState {
  return tab.kind === "session-manager";
}

// ============================================================================
// State definition
// ============================================================================

export interface TabStoreState {
  /** All tabs currently open in this window (ordered). */
  tabs: WindowTabState[];
  /** ID of the currently active tab, or null if no tab is active. */
  activeTabId: TabId | null;
  /** Path of the currently or most recently active workspace. */
  activeWorkspacePath: string | null;
  /** Identity of the currently or most recently active workspace (isolates remote workspaces that share a path). */
  activeWorkspaceIdentity: string | null;
  /** Set of workspace paths expanded in the left sidebar. */
  expandedWorkspacePaths: Set<string>;
  /** Add a tab and return its ID. */
  addTab: (workspacePath: string, options?: WorkspaceTabOptions) => TabId;
  /** Ensure the workspace appears in the task-area data source without taking focus away from the current tab. */
  ensureWorkspaceTab: (workspacePath: string, options?: WorkspaceTabOptions) => TabId;
  /** Close a tab. */
  closeTab: (tabId: TabId) => void;
  /** Activate the specified tab. */
  activateTab: (tabId: TabId) => void;
  /** Reorder by dragging a tab from fromIndex to toIndex. */
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  /** Reorder only the workspace subsequence, preserving slots occupied by non-workspace tabs such as Settings. */
  reorderWorkspaceTabs: (fromIndex: number, toIndex: number) => void;
  /** Open the Settings tab (unique within the window). */
  openSettingsTab: () => void;
  /** Open the sessions-manager tab (unique within the window); a scope pre-filters it to one workspace. */
  openSessionManagerTab: (scope?: SessionManagerScope) => void;
  /** Activate a tab by workspace path (used for cross-window focus); return whether one was found. */
  activateTabByPath: (path: string, options?: { workspaceIdentity?: string }) => boolean;
  /** Toggle whether a workspace is expanded. */
  toggleWorkspaceExpanded: (path: string) => void;
  /** Expand all workspaces in the current task area. */
  expandAllWorkspaceTabs: (paths: string[]) => void;
  /** Collapse all workspaces in the current task area. */
  collapseAllWorkspaceTabs: (paths: string[]) => void;
  /** Restore multiple tabs (used to restore persisted data during startup). */
  restoreTabs: (tabs: Array<string | RestorableWorkspaceTab>, activeIndex: number) => void;
  /** Complete persisted tabs after the startup first frame; preserve the current active identity and tabs added by the user in the meantime. */
  completeTabRestore: (tabs: Array<string | RestorableWorkspaceTab>) => void;
}

// ============================================================================
// Utility functions
// ============================================================================

/** Extract the folder name from a path for the tab label. */
function labelFromPath(path: string): string {
  // Support both Windows backslashes and Unix forward slashes.
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function createWorkspaceTab(
  workspacePath: string,
  options?: WorkspaceTabOptions,
): WorkspaceTabState {
  return {
    id: createUuid(),
    kind: "workspace",
    workspacePath,
    label: labelFromPath(workspacePath),
    availability: options?.availability,
    remoteSessionId: options?.remoteSessionId,
    remoteTarget: options?.remoteTarget,
    workspaceIdentity: options?.workspaceIdentity,
    localWorkspacePath: options?.localWorkspacePath,
    workspacePurpose: options?.workspacePurpose,
  };
}

function mergeWorkspaceTabOptions(
  tab: WorkspaceTabState,
  options?: WorkspaceTabOptions,
): WorkspaceTabState {
  return {
    ...tab,
    availability: options?.availability ?? tab.availability,
    remoteSessionId: options?.remoteSessionId ?? tab.remoteSessionId,
    remoteTarget: options?.remoteTarget ?? tab.remoteTarget,
    remoteHistoryId: options?.remoteHistoryId ?? tab.remoteHistoryId,
    workspaceIdentity: options?.workspaceIdentity ?? tab.workspaceIdentity,
    localWorkspacePath: options?.localWorkspacePath ?? tab.localWorkspacePath,
    workspacePurpose: options?.workspacePurpose ?? tab.workspacePurpose,
  };
}

function normalizeRestorableWorkspaceTab(
  tab: string | RestorableWorkspaceTab,
): RestorableWorkspaceTab {
  if (typeof tab === "string") {
    return {
      workspacePath: tab,
    };
  }

  return tab;
}

function createSettingsTab(): SettingsTabState {
  return {
    id: SETTINGS_TAB_ID,
    kind: "settings",
    label: "settings",
  };
}

function createSessionManagerTab(scope?: SessionManagerScope): SessionManagerTabState {
  return {
    id: SESSION_MANAGER_TAB_ID,
    kind: "session-manager",
    label: "sessions",
    ...(scope ? { scope } : {}),
  };
}

function moveItem<T>(items: readonly T[], fromIndex: number, toIndex: number): T[] {
  const nextItems = [...items];
  const [movedItem] = nextItems.splice(fromIndex, 1);
  if (!movedItem) {
    return nextItems;
  }

  nextItems.splice(toIndex, 0, movedItem);
  return nextItems;
}

function ensureWorkspaceExpanded(
  expandedWorkspacePaths: Set<string>,
  workspacePath: string,
): Set<string> {
  if (expandedWorkspacePaths.has(workspacePath)) {
    return expandedWorkspacePaths;
  }

  const next = new Set(expandedWorkspacePaths);
  next.add(workspacePath);
  return next;
}

function pruneExpandedWorkspace(
  expandedWorkspacePaths: Set<string>,
  workspacePath: string,
): Set<string> {
  if (!expandedWorkspacePaths.has(workspacePath)) {
    return expandedWorkspacePaths;
  }

  const next = new Set(expandedWorkspacePaths);
  next.delete(workspacePath);
  return next;
}

// ============================================================================
// Store creation
// ============================================================================

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function createTabStore(storage: StorageLike | null | undefined = undefined) {
  return create<TabStoreState>()((set, get) => ({
    tabs: [],
    activeTabId: null,
    activeWorkspacePath: null,
    activeWorkspaceIdentity: null,
    expandedWorkspacePaths: new Set<string>(),

    addTab: (workspacePath: string, options) => {
      // Previously, an existing tab was reused by comparing only workspacePath and history/session fragments.
      // Different remote hosts with the same path (for example, 10.0.0.1:/home/dev and 10.0.0.2:/home/dev) were treated as one tab.
      // Match by workspaceIdentity (authority + canonicalPath) first, and use the path only as a final fallback.
      const existing = get().tabs.find(
        (tab): tab is WorkspaceTabState =>
          isWorkspaceTab(tab) && isSameWorkspaceTab(tab, workspacePath, options),
      );
      if (existing) {
        persistWorkspaceExpandedPreference(existing.workspacePath, true, storage);
        set((state) => ({
          // After manually reconnecting a remote workspace, addTab is called again,
          // but previously a matching tab was only activated; updated metadata such as remoteSessionId was not written to the existing tab.
          // As a result, the UI still saw a stale remoteSessionId,
          // so the reconnect button remained visible and made the workspace look disconnected. Update remote-session fields when reusing a tab.
          tabs: state.tabs.map((tab) =>
            tab.id !== existing.id || !isWorkspaceTab(tab)
              ? tab
              : mergeWorkspaceTabOptions(tab, options),
          ),
          activeTabId: existing.id,
          activeWorkspacePath: existing.workspacePath,
          // Plugin management on the Settings page must keep targeting the same remote through the identity of the most recently active workspace.
          // Previously only the path was saved here; switching to the Settings tab lost the identity and broke isolation for remotes sharing a path.
          activeWorkspaceIdentity: options?.workspaceIdentity ?? existing.workspaceIdentity ?? null,
          expandedWorkspacePaths: ensureWorkspaceExpanded(
            state.expandedWorkspacePaths,
            existing.workspacePath,
          ),
        }));
        return existing.id;
      }

      const tab = createWorkspaceTab(workspacePath, options);
      persistWorkspaceExpandedPreference(workspacePath, true, storage);
      set((state) => ({
        // The left workspace list now supports manual sorting, but newly opened projects were still appended at the bottom.
        // When opening several projects, the newest workspace was always at the bottom, contrary to the sidebar behavior of prioritizing recent context.
        // Insert new workspaces at the front so newly opened projects appear at the top of the list.
        tabs: [tab, ...state.tabs],
        activeTabId: tab.id,
        activeWorkspacePath: workspacePath,
        activeWorkspaceIdentity: tab.workspaceIdentity ?? null,
        expandedWorkspacePaths: ensureWorkspaceExpanded(
          state.expandedWorkspacePaths,
          workspacePath,
        ),
      }));
      return tab.id;
    },

    ensureWorkspaceTab: (workspacePath: string, options) => {
      const existing = get().tabs.find(
        (tab): tab is WorkspaceTabState =>
          isWorkspaceTab(tab) && isSameWorkspaceTab(tab, workspacePath, options),
      );
      if (existing) {
        persistWorkspaceExpandedPreference(existing.workspacePath, true, storage);
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.id !== existing.id || !isWorkspaceTab(tab)
              ? tab
              : mergeWorkspaceTabOptions(tab, options),
          ),
          expandedWorkspacePaths: ensureWorkspaceExpanded(
            state.expandedWorkspacePaths,
            existing.workspacePath,
          ),
        }));
        return existing.id;
      }

      const tab = createWorkspaceTab(workspacePath, options);
      persistWorkspaceExpandedPreference(workspacePath, true, storage);
      set((state) => ({
        // Claude history import may write tasks into a workspace that has never been opened in this window.
        // The task area iterates only over workspace tabs; if we bump the task-list version without adding a tab,
        // the new task may be persisted successfully while its sidebar group still has nothing to render. Ensure visibility here,
        // adding the target workspace to the task-area data source without interrupting the tab or Settings context the user is viewing.
        tabs: [tab, ...state.tabs],
        expandedWorkspacePaths: ensureWorkspaceExpanded(
          state.expandedWorkspacePaths,
          workspacePath,
        ),
      }));
      return tab.id;
    },

    closeTab: (tabId: TabId) => {
      const stateBefore = get();
      const { tabs, activeTabId } = stateBefore;
      const index = tabs.findIndex((t) => t.id === tabId);
      if (index === -1) {
        return;
      }

      const closingTab = tabs[index] ?? null;
      const newTabs = tabs.filter((t) => t.id !== tabId);

      // If the active tab is closed, switch to an adjacent tab.
      let newActiveTabId = activeTabId;
      if (activeTabId === tabId) {
        if (newTabs.length === 0) {
          newActiveTabId = null;
        } else {
          // Prefer the tab on the right; if this is the last tab, activate the one on the left.
          const newIndex = Math.min(index, newTabs.length - 1);
          newActiveTabId = newTabs[newIndex]!.id;
        }
      }

      const nextWorkspaceTab = newTabs.find((tab) => tab.id === newActiveTabId);
      const fallbackWorkspacePath = (() => {
        if (nextWorkspaceTab && isWorkspaceTab(nextWorkspaceTab)) {
          return nextWorkspaceTab.workspacePath;
        }

        if (closingTab && isWorkspaceTab(closingTab)) {
          const replacementWorkspace = newTabs.find(isWorkspaceTab);
          return replacementWorkspace?.workspacePath ?? null;
        }

        return stateBefore.activeWorkspacePath;
      })();
      const fallbackWorkspaceIdentity = (() => {
        if (nextWorkspaceTab && isWorkspaceTab(nextWorkspaceTab)) {
          return nextWorkspaceTab.workspaceIdentity ?? null;
        }

        if (closingTab && isWorkspaceTab(closingTab)) {
          const replacementWorkspace = newTabs.find(isWorkspaceTab);
          return replacementWorkspace?.workspaceIdentity ?? null;
        }

        return stateBefore.activeWorkspaceIdentity;
      })();

      const nextState = {
        tabs: newTabs,
        activeTabId: newActiveTabId,
        activeWorkspacePath: fallbackWorkspacePath,
        activeWorkspaceIdentity: fallbackWorkspaceIdentity,
        expandedWorkspacePaths: (() => {
          const prunedExpandedWorkspacePaths =
            closingTab && isWorkspaceTab(closingTab)
              ? pruneExpandedWorkspace(stateBefore.expandedWorkspacePaths, closingTab.workspacePath)
              : stateBefore.expandedWorkspacePaths;

          // After closing the current workspace, the main content automatically switches to an adjacent tab.
          // When expanded state lived in component-local state, the sidebar expanded the replacement after workspacePath changed.
          // Now that the store owns this state, carry over the same fallback; otherwise "close current tab" leaves an active but collapsed workspace.
          return fallbackWorkspacePath
            ? ensureWorkspaceExpanded(prunedExpandedWorkspacePaths, fallbackWorkspacePath)
            : prunedExpandedWorkspacePaths;
        })(),
      };

      if (fallbackWorkspacePath) {
        persistWorkspaceExpandedPreference(fallbackWorkspacePath, true, storage);
      }

      set(nextState);
    },

    activateTab: (tabId: TabId) => {
      const stateBefore = get();
      const tab = stateBefore.tabs.find((t) => t.id === tabId);
      if (!tab) {
        return;
      }

      const nextState = {
        activeTabId: tabId,
        activeWorkspacePath: isWorkspaceTab(tab)
          ? tab.workspacePath
          : stateBefore.activeWorkspacePath,
        activeWorkspaceIdentity: isWorkspaceTab(tab)
          ? (tab.workspaceIdentity ?? null)
          : stateBefore.activeWorkspaceIdentity,
        expandedWorkspacePaths: isWorkspaceTab(tab)
          ? ensureWorkspaceExpanded(stateBefore.expandedWorkspacePaths, tab.workspacePath)
          : stateBefore.expandedWorkspacePaths,
      };

      if (isWorkspaceTab(tab)) {
        persistWorkspaceExpandedPreference(tab.workspacePath, true, storage);
      }

      set(nextState);
    },

    reorderTabs: (fromIndex: number, toIndex: number) => {
      set((state) => {
        if (
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= state.tabs.length ||
          toIndex >= state.tabs.length ||
          fromIndex === toIndex
        ) {
          return state;
        }

        const newTabs = moveItem(state.tabs, fromIndex, toIndex);
        return { tabs: newTabs };
      });
    },

    reorderWorkspaceTabs: (fromIndex: number, toIndex: number) => {
      set((state) => {
        const workspaceTabs = state.tabs.filter(isWorkspaceTab);
        if (
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= workspaceTabs.length ||
          toIndex >= workspaceTabs.length ||
          fromIndex === toIndex
        ) {
          return state;
        }

        const reorderedWorkspaceTabs = moveItem(workspaceTabs, fromIndex, toIndex);
        let workspaceIndex = 0;
        const newTabs = state.tabs.map((tab) => {
          if (!isWorkspaceTab(tab)) {
            return tab;
          }

          return reorderedWorkspaceTabs[workspaceIndex++] ?? tab;
        });

        return { tabs: newTabs };
      });
    },

    openSettingsTab: () => {
      const existing = get().tabs.find(isSettingsTab);
      if (existing) {
        set({ activeTabId: existing.id });
        return;
      }

      const settingsTab = createSettingsTab();
      set((state) => ({
        tabs: [...state.tabs, settingsTab],
        activeTabId: settingsTab.id,
      }));
    },

    openSessionManagerTab: (scope) => {
      const existing = get().tabs.find(isSessionManagerTab);
      if (existing) {
        // Re-activation replaces the scope (a scoped entry while the unscoped view is open narrows it; the unscoped command clears it).
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            isSessionManagerTab(tab)
              ? { ...tab, ...(scope ? { scope } : { scope: undefined }) }
              : tab,
          ),
          activeTabId: existing.id,
        }));
        return;
      }

      const sessionManagerTab = createSessionManagerTab(scope);
      set((state) => ({
        tabs: [...state.tabs, sessionManagerTab],
        activeTabId: sessionManagerTab.id,
      }));
    },

    toggleWorkspaceExpanded: (path: string) => {
      set((state) => {
        const expandedWorkspacePaths = new Set(state.expandedWorkspacePaths);
        const nextExpanded = !expandedWorkspacePaths.has(path);
        if (expandedWorkspacePaths.has(path)) {
          expandedWorkspacePaths.delete(path);
        } else {
          expandedWorkspacePaths.add(path);
        }

        persistWorkspaceExpandedPreference(path, nextExpanded, storage);

        return { expandedWorkspacePaths };
      });
    },

    expandAllWorkspaceTabs: (paths: string[]) => {
      set((state) => {
        const expandedWorkspacePaths = new Set(state.expandedWorkspacePaths);
        for (const path of paths) {
          expandedWorkspacePaths.add(path);
          persistWorkspaceExpandedPreference(path, true, storage);
        }
        return { expandedWorkspacePaths };
      });
    },

    collapseAllWorkspaceTabs: (paths: string[]) => {
      set((state) => {
        const expandedWorkspacePaths = new Set(state.expandedWorkspacePaths);
        for (const path of paths) {
          expandedWorkspacePaths.delete(path);
          persistWorkspaceExpandedPreference(path, false, storage);
        }
        return { expandedWorkspacePaths };
      });
    },

    activateTabByPath: (path: string, options) => {
      const stateBefore = get();
      const tab = stateBefore.tabs.find((currentTab): currentTab is WorkspaceTabState => {
        if (!isWorkspaceTab(currentTab) || currentTab.workspacePath !== path) {
          return false;
        }

        if (options?.workspaceIdentity) {
          return currentTab.workspaceIdentity === options.workspaceIdentity;
        }

        return true;
      });
      if (!tab) {
        return false;
      }

      const nextState = {
        activeTabId: tab.id,
        activeWorkspacePath: path,
        activeWorkspaceIdentity: tab.workspaceIdentity ?? null,
        expandedWorkspacePaths: ensureWorkspaceExpanded(stateBefore.expandedWorkspacePaths, path),
      };

      persistWorkspaceExpandedPreference(path, true, storage);

      set(nextState);
      return true;
    },

    restoreTabs: (tabsInput, activeIndex: number) => {
      if (tabsInput.length === 0) return;
      const tabs = tabsInput.map((tab) => {
        const normalized = normalizeRestorableWorkspaceTab(tab);
        return createWorkspaceTab(normalized.workspacePath, {
          remoteSessionId: normalized.remoteSessionId,
          remoteTarget: normalized.remoteTarget,
          workspaceIdentity: normalized.workspaceIdentity,
          workspacePurpose: normalized.workspacePurpose,
          availability: normalized.availability,
        });
      });
      const safeIndex = Math.min(Math.max(activeIndex, 0), tabs.length - 1);
      const activeWorkspaceTab = tabs[safeIndex];
      if (!activeWorkspaceTab || !isWorkspaceTab(activeWorkspaceTab)) {
        return;
      }
      const expansionState: WorkspaceExpansionState = readWorkspaceExpansionState(storage);
      set({
        tabs,
        activeTabId: activeWorkspaceTab.id,
        activeWorkspacePath: activeWorkspaceTab.workspacePath,
        activeWorkspaceIdentity: activeWorkspaceTab.workspaceIdentity ?? null,
        expandedWorkspacePaths: resolveExpandedWorkspacePaths(
          tabs.map((tab) => tab.workspacePath),
          expansionState,
        ),
      });
    },

    completeTabRestore: (tabsInput) => {
      if (tabsInput.length === 0) return;
      set((state) => {
        const consumedTabIds = new Set<TabId>();
        const completedTabs = tabsInput.map((tabInput) => {
          const normalized = normalizeRestorableWorkspaceTab(tabInput);
          const options: WorkspaceTabOptions = {
            remoteSessionId: normalized.remoteSessionId,
            remoteTarget: normalized.remoteTarget,
            workspaceIdentity: normalized.workspaceIdentity,
            localWorkspacePath: normalized.localWorkspacePath,
            workspacePurpose: normalized.workspacePurpose,
            availability: normalized.availability,
          };
          const existing = state.tabs.find(
            (tab): tab is WorkspaceTabState =>
              isWorkspaceTab(tab) &&
              !consumedTabIds.has(tab.id) &&
              isSameWorkspaceTab(tab, normalized.workspacePath, options),
          );
          if (existing) {
            consumedTabIds.add(existing.id);
            return mergeWorkspaceTabOptions(existing, options);
          }
          return createWorkspaceTab(normalized.workspacePath, options);
        });
        const extraWorkspaceTabs = state.tabs.filter(
          (tab): tab is WorkspaceTabState => isWorkspaceTab(tab) && !consumedTabIds.has(tab.id),
        );
        const nonWorkspaceTabs = state.tabs.filter((tab) => !isWorkspaceTab(tab));
        const tabs = [...extraWorkspaceTabs, ...completedTabs, ...nonWorkspaceTabs];
        const expansionState = readWorkspaceExpansionState(storage);

        // If active-first restoration calls restoreTabs again in phase two, it recreates the active tab ID,
        // causing an already mounted session view to lose its identity; it also overwrites tabs opened by the user after the first frame.
        // The completion phase only merges missing tabs, explicitly preserving current focus and the active workspace projection.
        return {
          tabs,
          activeTabId: state.activeTabId,
          activeWorkspacePath: state.activeWorkspacePath,
          activeWorkspaceIdentity: state.activeWorkspaceIdentity,
          expandedWorkspacePaths: resolveExpandedWorkspacePaths(
            tabs.filter(isWorkspaceTab).map((tab) => tab.workspacePath),
            expansionState,
          ),
        };
      });
    },
  }));
}

export type TabStore = ReturnType<typeof createTabStore>;

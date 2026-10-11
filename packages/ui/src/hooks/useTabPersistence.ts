/** useTabPersistence — tab persistence. On mount, restore the last opened tabs from settingService; subscribe to tab-store changes and debounce writes back to settingService. */
import { useEffect, useRef } from "react";
import { useState } from "react";
import type { AppSettings } from "@zcode/shared";
import type { ISettingService } from "@zcode/services";
import { readPersistedWorkspaceSessionEntries } from "@/lib/remoteWorkspaceHistory.js";
import { useTabStoreApi } from "../store/TabStoreProvider.js";
import { isWorkspaceTab, type TabStoreState } from "../store/tabStore.js";
import { logger } from "../logger.js";

const DEBOUNCE_MS = 300;

export interface TabPersistenceRestoreLifecycle {
  settingService?: ISettingService;
  restoreSession: boolean;
  completed: boolean;
  fullyCompleted: boolean;
}

export interface TabPersistenceRestoreResult {
  /** Path recognized during restore as app-owned; do not use it to update recent projects. */
  excludedRecentProjectPaths?: readonly string[];
  /** After restoring the active workspace, fill in inactive workspaces during the idle period after the first frame. */
  deferredRestore?: () => void;
}

function scheduleDeferredRestore(callback: () => void): () => void {
  if (typeof globalThis.requestIdleCallback === "function") {
    const idleCallbackId = globalThis.requestIdleCallback(() => callback(), {
      timeout: 1_000,
    });
    return () => globalThis.cancelIdleCallback(idleCallbackId);
  }

  const timer = globalThis.setTimeout(callback, 0);
  return () => globalThis.clearTimeout(timer);
}

export function hasCompletedTabPersistenceInitialRestore({
  settingService,
  restoreSession,
  restoreLifecycle,
}: {
  settingService?: ISettingService;
  restoreSession: boolean;
  restoreLifecycle: TabPersistenceRestoreLifecycle;
}): boolean {
  const shouldRestoreSession = Boolean(settingService && restoreSession);
  return (
    !shouldRestoreSession ||
    (restoreLifecycle.settingService === settingService &&
      restoreLifecycle.restoreSession === restoreSession &&
      restoreLifecycle.completed)
  );
}

export function getRecentProjectPathsFromSettings(
  settings: Pick<AppSettings, "lastWorkspaceSession">,
  excludedPaths: readonly string[] = [],
): string[] {
  const excludedPathSet = new Set(excludedPaths);
  return readPersistedWorkspaceSessionEntries(settings)
    .flatMap((entry) =>
      entry.kind === "local" &&
      entry.workspacePurpose !== "conversation" &&
      !excludedPathSet.has(entry.workspacePath)
        ? [entry.workspacePath]
        : [],
    )
    .slice(0, 10);
}

export function buildRestoredRecentProjectPaths(
  settings: Pick<AppSettings, "lastWorkspaceSession" | "recentProjects">,
  excludedPaths: readonly string[] = [],
): string[] {
  const excludedPathSet = new Set(excludedPaths);
  const existingRecent = (settings.recentProjects ?? []).filter(
    (path) => !excludedPathSet.has(path),
  );
  const restoredProjects = getRecentProjectPathsFromSettings(settings, excludedPaths);
  return [...new Set([...existingRecent, ...restoredProjects])].slice(0, 10);
}

function buildDefaultPersistPatch(state: TabStoreState): Partial<AppSettings> {
  const workspaceTabs = state.tabs.filter(isWorkspaceTab).filter((tab) => !tab.remoteSessionId);
  const activeIndex = state.activeWorkspacePath
    ? workspaceTabs.findIndex((tab) => tab.workspacePath === state.activeWorkspacePath)
    : 0;

  return {
    lastWorkspaceSession: workspaceTabs.map((tab) => ({
      kind: "local" as const,
      workspacePath: tab.workspacePath,
      ...(tab.workspacePurpose ? { workspacePurpose: tab.workspacePurpose } : {}),
    })),
    lastActiveTabIndex: Math.max(activeIndex, 0),
  };
}

export function useTabPersistence({
  settingService,
  restoreSession = true,
  persistSession = restoreSession,
  restorePersistedSession,
  buildPersistPatch,
}: {
  settingService?: ISettingService;
  /** Whether to restore the previous session: true for the first window, false for additional windows. */
  restoreSession?: boolean;
  /** Whether to write this window’s session to global settings: true for the first window, false for additional windows. */
  persistSession?: boolean;
  /** Custom restore flow; when absent, fall back to the default local-tab restore logic. */
  restorePersistedSession?: (
    settings: AppSettings,
  ) => Promise<TabPersistenceRestoreResult | void> | TabPersistenceRestoreResult | void;
  /** Custom persistence patch; when absent, write back only the local workspace session. */
  buildPersistPatch?: (state: TabStoreState) => Partial<AppSettings>;
}) {
  const store = useTabStoreApi();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldRestoreSession = Boolean(settingService && restoreSession);
  const initialRestoreFullyCompletedRef = useRef(!shouldRestoreSession);
  const [restoreLifecycle, setRestoreLifecycle] = useState<TabPersistenceRestoreLifecycle>(() => ({
    settingService,
    restoreSession,
    completed: !shouldRestoreSession,
    fullyCompleted: !shouldRestoreSession,
  }));
  // In the same render where the provider/OAuth gate changes from false to true,
  // the session-restore effect has not yet set isRestoring=true. Bind completion to the current settingService + restoreSession here,
  // so initialWorkspacePath does not call addTab before restoreTabs.
  const hasCompletedInitialRestore = hasCompletedTabPersistenceInitialRestore({
    settingService,
    restoreSession,
    restoreLifecycle,
  });
  const hasCompletedFullRestore =
    !shouldRestoreSession ||
    (restoreLifecycle.settingService === settingService &&
      restoreLifecycle.restoreSession === restoreSession &&
      restoreLifecycle.fullyCompleted);
  const isRestoring = shouldRestoreSession && !hasCompletedInitialRestore;

  // Restore session
  useEffect(() => {
    if (!settingService || !restoreSession) {
      initialRestoreFullyCompletedRef.current = true;
      setRestoreLifecycle({
        settingService,
        restoreSession,
        completed: true,
        fullyCompleted: true,
      });
      return;
    }

    let cancelled = false;
    let cancelDeferredRestore: (() => void) | null = null;
    initialRestoreFullyCompletedRef.current = false;
    // On the Root’s first frame, the empty default tab store renders the “Open workspace” center page,
    // then this hook asynchronously restores lastWorkspaceSession, briefly flashing “Open project” during startup.
    // Expose the restoring state so the outer layer keeps showing loading until the session check completes,
    // instead of showing the default empty state prematurely.
    setRestoreLifecycle({
      settingService,
      restoreSession,
      completed: false,
      fullyCompleted: false,
    });

    settingService
      .get()
      .then(async (settings) => {
        let restoreResult: TabPersistenceRestoreResult | void = undefined;
        if (restorePersistedSession) {
          restoreResult = await restorePersistedSession(settings);
        } else {
          const tabs = readPersistedWorkspaceSessionEntries(settings).flatMap((entry) =>
            entry.kind === "local"
              ? [
                  entry.workspacePurpose
                    ? {
                        workspacePath: entry.workspacePath,
                        workspacePurpose: entry.workspacePurpose,
                      }
                    : entry.workspacePath,
                ]
              : [],
          );
          const activeIndex = settings.lastActiveTabIndex ?? 0;
          if (tabs.length > 0) {
            logger.info("[useTabPersistence] 恢复标签页:", tabs);
            store.getState().restoreTabs(tabs, activeIndex);
          }
        }

        const excludedRecentProjectPaths = restoreResult?.excludedRecentProjectPaths ?? [];
        // recentProjects updates only when the user selects a project through the open-workspace action,
        // but most users open workspaces by restoring sessions, leaving recentProjects empty.
        // Session restore now includes both local and remote workspaces, and they share lastActiveTabIndex;
        // extract local workspaces from the full session snapshot and update recentProjects here,
        // so adding remote restore does not return history to showing only manually opened local projects.
        // Older versions lost workspacePurpose and could add the app-owned default cwd
        // to recentProjects as a regular project. Filtering only this restore is not enough;
        // also remove old entries so the project picker does not continue rendering it as a workspace.
        const merged = buildRestoredRecentProjectPaths(settings, excludedRecentProjectPaths);
        const persistedRecent = settings.recentProjects ?? [];
        if (
          merged.length !== persistedRecent.length ||
          merged.some((p, i) => p !== persistedRecent[i])
        ) {
          settingService.update({ recentProjects: merged }).catch((err) => {
            logger.error("[useTabPersistence] 同步 recentProjects 失败:", err);
          });
        }
        if (!cancelled) {
          const deferredRestore = restoreResult?.deferredRestore;
          setRestoreLifecycle({
            settingService,
            restoreSession,
            completed: true,
            fullyCompleted: !deferredRestore,
          });
          if (deferredRestore) {
            cancelDeferredRestore = scheduleDeferredRestore(() => {
              if (cancelled) {
                return;
              }
              // active-only is a startup transient and must not be persisted early; the store event from the completed merge
              // is the first event that contains a full session snapshot and can be written back.
              initialRestoreFullyCompletedRef.current = true;
              try {
                deferredRestore();
              } catch (error) {
                logger.error("[useTabPersistence] 补齐 inactive workspace 失败:", error);
              } finally {
                if (!cancelled) {
                  setRestoreLifecycle({
                    settingService,
                    restoreSession,
                    completed: true,
                    fullyCompleted: true,
                  });
                }
              }
            });
          } else {
            initialRestoreFullyCompletedRef.current = true;
          }
        }
      })
      .catch((err) => {
        logger.error("[useTabPersistence] 恢复标签页失败:", err);
        if (!cancelled) {
          initialRestoreFullyCompletedRef.current = true;
          setRestoreLifecycle({
            settingService,
            restoreSession,
            completed: true,
            fullyCompleted: true,
          });
        }
      });

    return () => {
      cancelled = true;
      cancelDeferredRestore?.();
    };
  }, [restorePersistedSession, settingService, restoreSession, store]);

  // Persist: subscribe to store changes and debounce writes.
  useEffect(() => {
    if (!settingService || !persistSession) return;

    const unsubscribe = store.subscribe((state) => {
      if (!initialRestoreFullyCompletedRef.current) {
        return;
      }
      if (timerRef.current) clearTimeout(timerRef.current);

      timerRef.current = setTimeout(() => {
        // If a new secondary window also writes its tabs to global settings,
        // it can overwrite the session the main window intends to restore, so next startup would open the wrong window.
        // Make session persistence an independent switch and let only the first local window write back.
        settingService
          .update((buildPersistPatch ?? buildDefaultPersistPatch)(state))
          .catch((err) => {
            logger.error("[useTabPersistence] 持久化失败:", err);
          });
      }, DEBOUNCE_MS);
    });

    return () => {
      unsubscribe();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [buildPersistPatch, persistSession, store, settingService]);

  return { isRestoring, hasCompletedInitialRestore, hasCompletedFullRestore };
}

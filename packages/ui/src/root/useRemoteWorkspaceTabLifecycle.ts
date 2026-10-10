import { useEffect, useRef } from "react";
import type { IPlatformService } from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  bindRemoteWorkspaceIdentity,
  bindRemoteWorkspacePath,
  unbindRemoteWorkspaceIdentity,
  unbindRemoteWorkspacePath,
  unregisterRemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import { isWorkspaceTab, type WindowTabState, type WorkspaceTabState } from "@/store/tabStore.js";

function remoteWorkspaceKey(tab: WorkspaceTabState): string | null {
  if (!tab.workspaceIdentity?.trim() && !tab.remoteSessionId && !tab.remoteTarget) {
    return null;
  }

  return tab.workspaceIdentity?.trim() || tab.workspacePath;
}

function collectClosedRemoteWorkspaceKeys(
  previousWorkspaceTabs: WorkspaceTabState[],
  nextWorkspaceTabs: WorkspaceTabState[],
): string[] {
  const nextRemoteWorkspaceKeys = new Set(
    nextWorkspaceTabs.flatMap((tab) => {
      const workspaceKey = remoteWorkspaceKey(tab);
      return workspaceKey ? [workspaceKey] : [];
    }),
  );
  const closedRemoteWorkspaceKeys = new Set<string>();

  for (const previousTab of previousWorkspaceTabs) {
    const workspaceKey = remoteWorkspaceKey(previousTab);
    if (!workspaceKey || nextRemoteWorkspaceKeys.has(workspaceKey)) {
      continue;
    }
    closedRemoteWorkspaceKeys.add(workspaceKey);
  }

  return [...closedRemoteWorkspaceKeys];
}

function collectClosedRemoteWorkspaceSessionIds(
  previousWorkspaceTabs: WorkspaceTabState[],
  nextWorkspaceTabs: WorkspaceTabState[],
  rememberedSessionIdsByWorkspaceKey: ReadonlyMap<string, string>,
): string[] {
  const previousLiveSessionIds = new Set(
    previousWorkspaceTabs
      .map((tab) => tab.remoteSessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId)),
  );

  return collectClosedRemoteWorkspaceKeys(previousWorkspaceTabs, nextWorkspaceTabs).flatMap(
    (workspaceKey) => {
      const sessionId = rememberedSessionIdsByWorkspaceKey.get(workspaceKey);
      // Tabs that still have remoteSessionId are released by the normal removal flow below;
      // release here only for sessions where disconnect happened before the tab field was cleared, avoiding duplicate dispose.
      return sessionId && !previousLiveSessionIds.has(sessionId) ? [sessionId] : [];
    },
  );
}

export function useRemoteWorkspaceTabLifecycle({
  tabs,
  activeWorkspaceTab,
  platform,
  onRemoteWorkspaceTabsClosed,
}: {
  tabs: WindowTabState[];
  activeWorkspaceTab: WorkspaceTabState | null;
  platform: IPlatformService;
  onRemoteWorkspaceTabsClosed?: (workspaceKeys: string[]) => void;
}) {
  const previousWorkspaceTabsRef = useRef<WindowTabState[]>([]);
  const rememberedSessionIdsByWorkspaceKeyRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const previousWorkspaceTabs = previousWorkspaceTabsRef.current.filter(isWorkspaceTab);
    const nextWorkspaceTabs = tabs.filter(isWorkspaceTab);
    const closedRemoteWorkspaceKeys = collectClosedRemoteWorkspaceKeys(
      previousWorkspaceTabs,
      nextWorkspaceTabs,
    );
    const closedRemoteSessionIds = collectClosedRemoteWorkspaceSessionIds(
      previousWorkspaceTabs,
      nextWorkspaceTabs,
      rememberedSessionIdsByWorkspaceKeyRef.current,
    );
    if (closedRemoteWorkspaceKeys.length > 0) {
      onRemoteWorkspaceTabsClosed?.(closedRemoteWorkspaceKeys);
      for (const workspaceKey of closedRemoteWorkspaceKeys) {
        rememberedSessionIdsByWorkspaceKeyRef.current.delete(workspaceKey);
      }
    }
    for (const tab of nextWorkspaceTabs) {
      const workspaceKey = remoteWorkspaceKey(tab);
      if (workspaceKey && tab.remoteSessionId) {
        rememberedSessionIdsByWorkspaceKeyRef.current.set(workspaceKey, tab.remoteSessionId);
      }
    }

    for (const sessionId of closedRemoteSessionIds) {
      void (async () => {
        try {
          // The disconnect event clears remoteSessionId from the tab first, preventing the normal removal flow below
          // from releasing this session. Use the remembered sessionId here to cover the cleanup path where the tab is closed after disconnect.
          await platform.disposeRemoteSession(sessionId);
        } catch (error) {
          logger.warn("[Root] 释放断连远程 session 失败:", { sessionId, error });
        } finally {
          unregisterRemoteWorkspaceSession(sessionId);
        }
      })();
    }

    const nextRemoteSessionIds = new Set(
      nextWorkspaceTabs
        .map((tab) => tab.remoteSessionId)
        .filter((sessionId): sessionId is string => Boolean(sessionId)),
    );

    for (const previousTab of previousWorkspaceTabs) {
      const stillExists = nextWorkspaceTabs.some((nextTab) => nextTab.id === previousTab.id);
      if (stillExists) {
        continue;
      }

      if (!previousTab.remoteSessionId) {
        continue;
      }

      const survivingRemoteTab = nextWorkspaceTabs.find((nextTab) => {
        if (!nextTab.remoteSessionId) {
          return false;
        }

        if (previousTab.workspaceIdentity && nextTab.workspaceIdentity) {
          return nextTab.workspaceIdentity === previousTab.workspaceIdentity;
        }

        return nextTab.workspacePath === previousTab.workspacePath;
      });

      if (survivingRemoteTab?.remoteSessionId) {
        // The mapping was previously keyed only by workspacePath, so closing one remote tab could “unbind” another remote tab at the same path.
        // Prefer the surviving tab's binding and update the workspaceIdentity mapping too, preventing later RPCs from hitting the wrong session.
        bindRemoteWorkspacePath(
          survivingRemoteTab.workspacePath,
          survivingRemoteTab.remoteSessionId,
        );
        if (survivingRemoteTab.workspaceIdentity) {
          bindRemoteWorkspaceIdentity(
            survivingRemoteTab.workspaceIdentity,
            survivingRemoteTab.remoteSessionId,
          );
        }
      } else {
        unbindRemoteWorkspacePath(previousTab.workspacePath);
        if (previousTab.workspaceIdentity) {
          unbindRemoteWorkspaceIdentity(previousTab.workspaceIdentity);
        }
      }
    }

    const disposedSessionIds = new Set<string>();
    for (const previousTab of previousWorkspaceTabs) {
      const sessionId = previousTab.remoteSessionId;
      if (!sessionId || nextRemoteSessionIds.has(sessionId) || disposedSessionIds.has(sessionId)) {
        continue;
      }

      disposedSessionIds.add(sessionId);
      const workspacePath = previousTab.workspacePath;
      void (async () => {
        try {
          logger.info("[Root] remote workspace tab 已移除，主动释放远程 session", {
            workspacePath,
            workspaceIdentity: previousTab.workspaceIdentity,
            sessionId,
          });
          await platform.disposeRemoteSession(sessionId);
        } catch (error) {
          logger.warn("[Root] 释放远程 session 失败:", {
            sessionId,
            error,
          });
        } finally {
          unregisterRemoteWorkspaceSession(sessionId);
        }
      })();
    }

    previousWorkspaceTabsRef.current = nextWorkspaceTabs;
  }, [onRemoteWorkspaceTabsClosed, platform, tabs]);

  useEffect(() => {
    if (!activeWorkspaceTab?.remoteSessionId) {
      return;
    }

    // When switching between remote tabs at the same path, do not bind the path mapping only once at connection time,
    // or after switching it will still point to the old tab and hooks resolving services by workspacePath may hit the old session.
    // Refresh path and workspaceIdentity mappings to the current tab after active-tab changes so workspace-level RPCs follow it.
    bindRemoteWorkspacePath(activeWorkspaceTab.workspacePath, activeWorkspaceTab.remoteSessionId);
    if (activeWorkspaceTab.workspaceIdentity) {
      bindRemoteWorkspaceIdentity(
        activeWorkspaceTab.workspaceIdentity,
        activeWorkspaceTab.remoteSessionId,
      );
    }
  }, [
    activeWorkspaceTab?.remoteSessionId,
    activeWorkspaceTab?.workspaceIdentity,
    activeWorkspaceTab?.workspacePath,
  ]);
}

import { useEffect, useRef, useState } from "react";
import type {
  BrowserViewScreenshotSurfacePreparePayload,
  BrowserViewScreenshotSurfaceReleasePayload,
} from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import type { BrowserUseSidePaneTab, WorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";

function matchesTab(
  tab: BrowserUseSidePaneTab,
  payload: BrowserViewScreenshotSurfacePreparePayload,
): boolean {
  return (
    tab.workspaceKey === payload.workspaceKey &&
    tab.sessionId === payload.sessionId &&
    tab.browserId === payload.browserId &&
    tab.browserGeneration === payload.browserGeneration &&
    tab.tabId === payload.tabId
  );
}

/**
 * A browser tab restored across processes (browser: prefix) has a browserId /
 * browserGeneration value from the previous process in the persistent shell; after the tab is adopted by a new scope, the main-side
 * owner is updated, but the renderer has no reliable sync channel (residency transition carries new values only when state
 * changes). If prepare/release requires an exact seven-tuple match, screenshot
 * surface matching for a restored tab always fails: prepare is silently ignored, so screenshots time out after 3s; release never matches
 * and the pane gets stuck in a nearly transparent fixed layer (perceived as a frozen transparent overlay). So fall back to
 * matching workspaceKey + sessionId + tabId; tabId is a globally unique UUID, and the first two prevent
 * cross-workspace/session mixups; stale protection is handled by the main-side coordinator using the generation in the request.
 */
function matchesTabLoose(
  tab: BrowserUseSidePaneTab,
  payload: BrowserViewScreenshotSurfacePreparePayload,
): boolean {
  return (
    tab.workspaceKey === payload.workspaceKey &&
    tab.sessionId === payload.sessionId &&
    tab.tabId === payload.tabId
  );
}

function matchesRequest(
  request: BrowserViewScreenshotSurfacePreparePayload,
  payload: BrowserViewScreenshotSurfaceReleasePayload,
): boolean {
  return (
    request.requestId === payload.requestId &&
    request.workspaceKey === payload.workspaceKey &&
    request.sessionId === payload.sessionId &&
    request.tabId === payload.tabId &&
    request.webContentsId === payload.webContentsId
  );
}

function findScreenshotSurfaceTab(
  tabs: readonly WorkspaceSidePaneTab[],
  payload: BrowserViewScreenshotSurfacePreparePayload,
): BrowserUseSidePaneTab | undefined {
  return tabs.find(
    (tab): tab is BrowserUseSidePaneTab => tab.type === "browser-use" && matchesTab(tab, payload),
  );
}

/**
 * After the current renderer has received prepare, browserGeneration may continue updating during attach/restore.
 * Still send the same transient request to the original tab; main uses the generation in the request for final stale protection.
 */
export function findScreenshotSurfaceTabForRender(
  tabs: readonly WorkspaceSidePaneTab[],
  payload: BrowserViewScreenshotSurfacePreparePayload,
): BrowserUseSidePaneTab | undefined {
  return (
    findScreenshotSurfaceTab(tabs, payload) ??
    tabs.find(
      (tab): tab is BrowserUseSidePaneTab =>
        tab.type === "browser-use" && matchesTabLoose(tab, payload),
    )
  );
}

/**
 * Match prepare reception: prefer an exact scope match; for a tab restored across processes, registry scope metadata
 * still has the old process values (see matchesTabLoose), so fall back to a looser match to receive prepare.
 */
function findScreenshotSurfaceTabForPrepare(
  tabs: readonly WorkspaceSidePaneTab[],
  payload: BrowserViewScreenshotSurfacePreparePayload,
): BrowserUseSidePaneTab | undefined {
  return findScreenshotSurfaceTabForRender(tabs, payload);
}

/**
 * Store only transient prepare requests that match the current renderer tab registry. Requests do not enter the workspace store,
 * so desktop compositing synchronization does not spread into remote/replayable task state.
 */
export function useBrowserScreenshotSurfaceRequest(
  tabs: readonly WorkspaceSidePaneTab[],
): BrowserViewScreenshotSurfacePreparePayload | null {
  const platform = usePlatform();
  const [request, setRequest] = useState<BrowserViewScreenshotSurfacePreparePayload | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  useEffect(() => {
    const disposePrepare = platform.onBrowserViewScreenshotSurfacePrepare?.((payload) => {
      // A browser-use operation updates the tab registry; the old effect depended on tabs,
      // so when a command and React effect cleanup happened together, the IPC listener was briefly removed and the prepare message
      // was permanently lost, making a background screenshot wait the full 30 seconds. Register the listener for the platform lifecycle only and read the latest tabs when matching.
      if (!findScreenshotSurfaceTabForPrepare(tabsRef.current, payload)) {
        logger.debug("[browser-use] 忽略非当前 renderer tab 的截图 surface prepare", {
          requestId: payload.requestId,
          tabId: payload.tabId,
        });
        return;
      }
      logger.debug("[browser-use] 接收截图 surface prepare", {
        requestId: payload.requestId,
        tabId: payload.tabId,
        webContentsId: payload.webContentsId,
      });
      setRequest((current) => {
        if (current && current.requestId !== payload.requestId) {
          logger.debug("[browser-use] 保留仍在准备中的截图 surface 请求", {
            requestId: current.requestId,
            tabId: current.tabId,
          });
          return current;
        }
        return payload;
      });
    });
    const disposeRelease = platform.onBrowserViewScreenshotSurfaceRelease?.((payload) => {
      setRequest((current) => {
        if (!current || !matchesRequest(current, payload)) {
          return current;
        }
        return null;
      });
    });
    return () => {
      disposePrepare?.();
      disposeRelease?.();
    };
  }, [platform]);

  return request;
}

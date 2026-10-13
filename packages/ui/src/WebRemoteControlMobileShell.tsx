import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, LoaderIcon, Search } from "lucide-react";
import {
  resolveWebRemoteControlWorkspaceKey,
  type WebRemoteControlMobileNavigationIntent,
  type WebRemoteControlWorkspaceListResult,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  WebRemoteControlMobileTaskHome,
  persistWebRemoteControlMobileTaskHomePreferences,
  readWebRemoteControlMobileTaskHomePreferences,
  type WebRemoteControlMobileTaskHomePreferences,
} from "@/WebRemoteControlMobileTaskHome.js";
import { WebRemoteControlThemeMenu } from "@/WebRemoteControlThemeMenu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { WebRemoteControlTerminalTransportState } from "@/root/types.js";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";
import { useWebRemoteControlTerminalTransportState } from "@/webRemoteControlTerminalTransportState.js";

type WebRemoteControlMobilePage = "home" | "chat";

interface WebRemoteControlMobileHistoryState {
  zcodeMobilePage?: WebRemoteControlMobilePage;
}

export function isWebRemoteControlMobileChatHistoryState(
  state: unknown,
): state is WebRemoteControlMobileHistoryState {
  return (
    typeof state === "object" &&
    state !== null &&
    (state as WebRemoteControlMobileHistoryState).zcodeMobilePage === "chat"
  );
}

function pushWebRemoteControlMobileChatHistory() {
  if (typeof window === "undefined") {
    return;
  }

  if (isWebRemoteControlMobileChatHistoryState(window.history.state)) {
    return;
  }

  window.history.pushState({ zcodeMobilePage: "chat" }, "");
}

function resolveInitialWebRemoteControlMobilePage(
  initialNavigationIntent?: WebRemoteControlMobileNavigationIntent,
): WebRemoteControlMobilePage {
  if (initialNavigationIntent === "chat") {
    return "chat";
  }

  // Bugfix: when the mobile client refreshes on the chat page, React in-memory state is lost, but the
  // browser keeps the current history.state. Reuse the history state written when the chat page was
  // entered by clicking, so a refresh does not restore only the task selection while landing back on home.
  if (
    typeof window !== "undefined" &&
    isWebRemoteControlMobileChatHistoryState(window.history.state)
  ) {
    return "chat";
  }

  return "home";
}

export function WebRemoteControlMobileShell({
  activeTaskId,
  activeWorkspaceIdentity,
  activeWorkspacePath,
  chatContent,
  chatOverlay,
  initialNavigationIntent,
  initialWorkspaceList,
  isSidePaneOpen = false,
  onCloseSidePane,
  onOpenCommandCenter,
  onSelectTask,
  onStartDraftInWorkspace,
  renderChatHeader,
  sidePaneContent,
  switcher,
  webRemoteControlTerminalTransportState,
}: {
  switcher: WebRemoteControlWorkspaceSwitcherApi;
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  initialNavigationIntent?: WebRemoteControlMobileNavigationIntent;
  initialWorkspaceList?: WebRemoteControlWorkspaceListResult;
  isSidePaneOpen?: boolean;
  onCloseSidePane?: () => void;
  /** Opens the unified Command Center; the phone shell has no sidebar, so the chat header carries the entry. */
  onOpenCommandCenter?: () => void;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
  onStartDraftInWorkspace?: (targetWorkspacePath: string, targetWorkspaceIdentity?: string) => void;
  renderChatHeader: (options: { onBackHome: () => void }) => ReactNode;
  chatContent: ReactNode;
  chatOverlay?: ReactNode;
  sidePaneContent?: ReactNode;
  webRemoteControlTerminalTransportState?: WebRemoteControlTerminalTransportState;
}) {
  const { intl } = useZCodeIntl();
  const [currentPage, setCurrentPage] = useState<WebRemoteControlMobilePage>(() =>
    resolveInitialWebRemoteControlMobilePage(initialNavigationIntent),
  );
  const [taskHomePreferences, setTaskHomePreferences] =
    useState<WebRemoteControlMobileTaskHomePreferences>(() =>
      readWebRemoteControlMobileTaskHomePreferences(),
    );
  const [homeRefreshKey, setHomeRefreshKey] = useState(0);
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const terminalTransportState = useWebRemoteControlTerminalTransportState(
    webRemoteControlTerminalTransportState,
  );
  const syncedMobileViewStateRef = useRef<string | null>(null);
  const shouldInertChatSurface = Boolean(sidePaneContent) && isSidePaneOpen;

  const navigateToChat = useCallback(() => {
    setCurrentPage("chat");
    pushWebRemoteControlMobileChatHistory();
  }, []);

  const handleTaskHomePreferencesChange = useCallback(
    (preferences: WebRemoteControlMobileTaskHomePreferences) => {
      // Bugfix: after the mobile remote task home enters a task, the component is only unmounted, so
      // shell in-memory state is enough to preserve sorting; a page refresh, however, rebuilds the whole
      // React tree and the previous defaults would override the user's choice. Write to localStorage while
      // updating shell state so the same sort/group preferences survive a refresh.
      persistWebRemoteControlMobileTaskHomePreferences(preferences);
      logger.debug("[WebRemoteControlMobileShell] 更新手机端任务首页偏好", preferences);
      setTaskHomePreferences(preferences);
    },
    [],
  );

  const navigateHome = useCallback(() => {
    setHomeRefreshKey((key) => key + 1);
    if (
      typeof window !== "undefined" &&
      isWebRemoteControlMobileChatHistoryState(window.history.state)
    ) {
      window.history.back();
      return;
    }

    setCurrentPage("home");
  }, []);

  useEffect(() => {
    if (initialNavigationIntent !== "chat") {
      return;
    }

    navigateToChat();
  }, [initialNavigationIntent, navigateToChat]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handlePopState = (event: PopStateEvent) => {
      const nextPage = isWebRemoteControlMobileChatHistoryState(event.state) ? "chat" : "home";
      setCurrentPage(nextPage);
      if (nextPage === "home") {
        setHomeRefreshKey((key) => key + 1);
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  useEffect(() => {
    if (!switcher.updateMobileViewState) {
      return;
    }
    const workspaceKey = resolveWebRemoteControlWorkspaceKey({
      workspacePath: activeWorkspacePath,
      workspaceIdentity: activeWorkspaceIdentity,
    });
    const dedupeKey = `${workspaceKey}:${activeTaskId ?? ""}`;
    if (syncedMobileViewStateRef.current === dedupeKey) {
      return;
    }
    syncedMobileViewStateRef.current = dedupeKey;

    // Bugfix: mobile "new task / fork" auto-switches to the new task, but previously mobileViewState
    // was reported only when a task list item was clicked. The desktop would keep believing the phone
    // was still on the old task, lagging the new task list refresh. Sync immediately whenever
    // activeTaskId changes so cross-device selection state and the task list converge.
    void switcher.updateMobileViewState(workspaceKey, activeTaskId ?? undefined).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("[WebRemoteControlMobileShell] 同步 mobileViewState 失败", {
        error: message,
        workspaceKey,
        taskId: activeTaskId ?? null,
      });
    });
  }, [activeTaskId, activeWorkspaceIdentity, activeWorkspacePath, switcher]);

  // Bugfix: mobile chat/sidebar are flex subtrees; the default min-width:auto grows the drawer to the
  // min-content width of long messages, and narrow screens then clip the body from the left. Explicitly
  // allow shrinking along the whole width chain so subagent output, process panels, and body text wrap
  // inside the drawer.
  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col bg-background">
      {currentPage === "home" ? (
        <WebRemoteControlMobileTaskHome
          activeTaskId={activeTaskId}
          activeWorkspaceIdentity={activeWorkspaceIdentity}
          activeWorkspacePath={activeWorkspacePath}
          initialResult={initialWorkspaceList}
          onCrossWorkspaceSwitchingChange={setSwitchingWorkspace}
          onNavigateHome={navigateHome}
          onNavigateToChat={navigateToChat}
          preferences={taskHomePreferences}
          onPreferencesChange={handleTaskHomePreferencesChange}
          refreshKey={homeRefreshKey}
          onSelectTask={onSelectTask}
          onStartDraftInWorkspace={onStartDraftInWorkspace}
          switcher={switcher}
        />
      ) : (
        <section
          className="flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground"
          data-mobile-page="chat"
        >
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-header px-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={intl.formatMessage({
                id: "webRemoteControl.mobileShell.backHome",
              })}
              onClick={navigateHome}
            >
              <ArrowLeft className="size-4" />
            </Button>
            <span className="min-w-0 flex-1 truncate text-ui-base font-medium">
              {intl.formatMessage({ id: "webRemoteControl.mobileShell.chatTitle" })}
            </span>
            {onOpenCommandCenter ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={intl.formatMessage({ id: "commandCenter.open" })}
                onClick={onOpenCommandCenter}
              >
                <Search className="size-4" />
              </Button>
            ) : null}
            <WebRemoteControlThemeMenu />
          </div>
          {renderChatHeader({ onBackHome: navigateHome })}
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <main
              className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
              aria-hidden={shouldInertChatSurface ? true : undefined}
              data-mobile-chat-surface={shouldInertChatSurface ? "inert" : undefined}
              inert={shouldInertChatSurface ? true : undefined}
            >
              {/* Bugfix: with the mobile sidebar open, the bottom composer is covered by the drawer.
                  If the chat area stayed in the interaction tree, controls like model selection would be
                  visually covered yet still hittable by the browser, misleadingly appearing as "buttons
                  that cannot be clicked". The covered chat surface is set inert here so the right drawer
                  is the only interactive area. */}
              {chatContent}
            </main>
            {sidePaneContent ? (
              <div
                className={[
                  "absolute inset-0 z-30 transition-opacity duration-200 ease-out",
                  isSidePaneOpen ? "opacity-100" : "pointer-events-none opacity-0",
                ].join(" ")}
                aria-hidden={!isSidePaneOpen}
                data-mobile-side-pane-overlay="true"
              >
                <button
                  type="button"
                  className="absolute inset-0 bg-background/60 backdrop-blur-[1px]"
                  aria-label={intl.formatMessage({ id: "sidePane.collapse" })}
                  onClick={onCloseSidePane}
                />
                <div
                  className={[
                    "absolute top-0 right-0 h-full w-[min(88vw,28rem)] max-w-full border-l border-border bg-background shadow-2xl transition-transform duration-200 ease-out",
                    isSidePaneOpen ? "translate-x-0" : "translate-x-full",
                  ].join(" ")}
                >
                  {/* Bugfix: the mobile remote previously rendered the side pane as a bottom vertical
                      panel, which squeezed the chat area and did not feel like the desktop sidebar. It is
                      now a right-side overlay drawer covering only the mobile chat area, leaving the
                      desktop split layout unchanged. */}
                  {sidePaneContent}
                </div>
              </div>
            ) : null}
            {chatOverlay ? (
              <div
                className="pointer-events-none absolute inset-0 z-40"
                data-mobile-chat-overlay="true"
              >
                {/* Bugfix: the find box belongs to the chat's visual area but must not be a descendant
                    of the inert chat surface. A separate overlay keeps the drawer isolation while file
                    change search stays focusable, toggleable, and closable. */}
                <div className="pointer-events-auto">{chatOverlay}</div>
              </div>
            ) : null}
          </div>
        </section>
      )}

      {switchingWorkspace ? (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-background/72 backdrop-blur-[1px]"
          aria-live="polite"
          aria-busy="true"
        >
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle shadow-sm">
            <LoaderIcon className="size-4 animate-spin" />
            {intl.formatMessage({ id: "common.loading" })}
          </div>
        </div>
      ) : null}
      {terminalTransportState === "reconnecting" ? (
        <div
          className="pointer-events-none absolute top-3 left-1/2 z-50 flex -translate-x-1/2 justify-center px-3"
          aria-live="polite"
          aria-busy="true"
          data-web-remote-control-reconnect-notice="true"
        >
          <div className="flex max-w-[calc(100vw-1.5rem)] items-center gap-2 rounded-lg border border-border bg-toast px-3 py-2 text-ui-base text-foreground shadow-lg">
            <LoaderIcon className="size-4 shrink-0 animate-spin text-foreground-subtle" />
            <span className="min-w-0 whitespace-nowrap">
              {intl.formatMessage({ id: "webRemoteControl.mobileShell.reconnecting" })}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

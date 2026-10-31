import { Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { TID_TERMINAL, TID_TERMINAL_CLOSE_BUTTON } from "@zcode/shared/test-ids";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { logger } from "@/logger.js";
import { Button } from "@/components/ui/button.js";
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs.js";
import { getPathLeaf } from "@/lib/path.js";
import { TerminalTabTrigger } from "@/terminal/TerminalTabTrigger.js";
import { TerminalSession } from "@/terminal/TerminalSession.js";
import {
  closeTerminalSession,
  createTerminalSession,
  createWorkspaceTerminalState,
  ensureWorkspaceTerminalState,
  exitTerminalSession,
  formatTerminalTabTitle,
  getNextTerminalSessionIndex,
  getTerminalSessionCloseAction,
  type TerminalPanelState,
  type TerminalSessionDescriptor,
} from "@/terminal/terminalPanelState.js";

export function Terminal({
  services,
  cwd,
  workspaceKey,
  openWorkspaceKeys,
  isVisible,
  isPanelResizing = false,
  isWindowsDesktop = false,
  onClose,
  onOpenBrowserUrl,
}: {
  services: IServiceAccessor;
  cwd?: string;
  workspaceKey: string;
  openWorkspaceKeys?: string[];
  isVisible: boolean;
  isPanelResizing?: boolean;
  isWindowsDesktop?: boolean;
  onClose: () => void;
  onOpenBrowserUrl: (url: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const [panelState, setPanelState] = useState<TerminalPanelState>(() => {
    const { session, workspace } = createWorkspaceTerminalState({
      workspaceKey,
      services,
      cwd,
    });
    return {
      sessions: {
        [session.id]: session,
      },
      workspaces: {
        [workspaceKey]: workspace,
      },
    };
  });
  const closePanelAfterSessionRemovalWorkspaceRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isVisible) {
      return;
    }

    // Business logic: Terminal sessions are stored separately by workspace identity. Switching workspaces changes only the visible tab;
    // it does not unmount the previous workspace's xterm/PTY, which could kill long-running commands due to React lifecycle changes.
    // PTY exit removes the final session; when the panel is reopened, a new terminal is lazily created here.
    setPanelState((current) =>
      ensureWorkspaceTerminalState(current, {
        workspaceKey,
        services,
        cwd,
      }),
    );
  }, [cwd, isVisible, services, workspaceKey]);

  useEffect(() => {
    const removedWorkspaceKey = closePanelAfterSessionRemovalWorkspaceRef.current;
    if (!removedWorkspaceKey) {
      return;
    }

    closePanelAfterSessionRemovalWorkspaceRef.current = null;
    if (removedWorkspaceKey === workspaceKey) {
      onClose();
    }
  }, [onClose, panelState, workspaceKey]);

  useEffect(() => {
    if (!openWorkspaceKeys) {
      return;
    }

    // Terminals now stay alive across workspace switches, but a hidden terminal must not keep its PTY process after the workspace tab is actually closed.
    // Reclaim terminals based on the workspace keys that remain open.
    const retainedWorkspaceKeys = new Set(openWorkspaceKeys);
    retainedWorkspaceKeys.add(workspaceKey);
    setPanelState((current) => {
      const removedWorkspaceKeys = Object.keys(current.workspaces).filter(
        (key) => !retainedWorkspaceKeys.has(key),
      );
      if (removedWorkspaceKeys.length === 0) {
        return current;
      }

      const nextWorkspaces = { ...current.workspaces };
      const nextSessions = { ...current.sessions };
      for (const removedWorkspaceKey of removedWorkspaceKeys) {
        const workspace = nextWorkspaces[removedWorkspaceKey];
        delete nextWorkspaces[removedWorkspaceKey];
        for (const sessionId of workspace?.sessionIds ?? []) {
          delete nextSessions[sessionId];
        }
      }

      return {
        sessions: nextSessions,
        workspaces: nextWorkspaces,
      };
    });
  }, [openWorkspaceKeys, workspaceKey]);

  const handleShellLabelChange = useCallback((sessionId: string, shellLabel: string | null) => {
    setPanelState((current) => {
      const session = current.sessions[sessionId];
      if (!session || session.shellLabel === shellLabel) {
        return current;
      }

      return {
        ...current,
        sessions: {
          ...current.sessions,
          [sessionId]: {
            ...session,
            shellLabel,
          },
        },
      };
    });
  }, []);

  const handleCreateSession = useCallback(() => {
    setPanelState((current) => {
      const ensured = ensureWorkspaceTerminalState(current, {
        workspaceKey,
        services,
        cwd,
      });
      const workspace = ensured.workspaces[workspaceKey];
      if (!workspace) {
        return ensured;
      }

      const session = createTerminalSession({
        workspaceKey,
        services,
        cwd,
        index: getNextTerminalSessionIndex(ensured, workspaceKey),
      });
      logger.info("[Terminal] create terminal tab", {
        cwd,
        terminalTabId: session.id,
        workspaceKey,
      });

      return {
        sessions: {
          ...ensured.sessions,
          [session.id]: session,
        },
        workspaces: {
          ...ensured.workspaces,
          [workspaceKey]: {
            sessionIds: [...workspace.sessionIds, session.id],
            activeSessionId: session.id,
          },
        },
      };
    });
  }, [cwd, services, workspaceKey]);

  const handleCloseSession = useCallback((sessionId: string) => {
    setPanelState((current) => {
      const session = current.sessions[sessionId];
      const closeAction = getTerminalSessionCloseAction(current, sessionId);
      const next = closeTerminalSession(current, sessionId);
      if (!session || closeAction === "none" || next === current) {
        return current;
      }

      // Bug cause: the single-tab close button used to only collapse the keep-alive panel without deleting the descriptor,
      // so TerminalSession never unmounted and the Windows PTY was never disposed.
      // Delete the session from the single source of truth first, commit, then collapse the panel — TerminalSession stays the single owner of resource cleanup.
      if (closeAction === "close-panel") {
        closePanelAfterSessionRemovalWorkspaceRef.current = session.workspaceKey;
      }
      logger.info("[Terminal] close terminal tab", {
        action: closeAction,
        terminalTabId: sessionId,
        workspaceKey: session.workspaceKey,
      });
      return next;
    });
  }, []);

  const handleSessionExit = useCallback(
    (sessionId: string, exitCode: number) => {
      setPanelState((current) => {
        const exitedWorkspaceKey = current.sessions[sessionId]?.workspaceKey;
        const result = exitTerminalSession(current, sessionId, workspaceKey);
        if (result.action === "none") {
          return current;
        }

        // Do not merely write “process exited” in xterm while leaving the descriptor in the tab registry.
        // PTY exit ends the session lifecycle, so remove the tab too; close the panel only when this is the current workspace's final tab.
        logger.info("[Terminal] auto close exited terminal tab", {
          action: result.action,
          exitCode,
          terminalTabId: sessionId,
          workspaceKey: exitedWorkspaceKey,
        });
        if (result.action === "close-panel") {
          closePanelAfterSessionRemovalWorkspaceRef.current = exitedWorkspaceKey ?? null;
        }
        return result.state;
      });
    },
    [workspaceKey],
  );

  const handleActivateSession = useCallback((sessionId: string) => {
    setPanelState((current) => {
      const session = current.sessions[sessionId];
      if (!session) {
        return current;
      }

      const workspace = current.workspaces[session.workspaceKey];
      if (!workspace || workspace.activeSessionId === sessionId) {
        return current;
      }

      return {
        ...current,
        workspaces: {
          ...current.workspaces,
          [session.workspaceKey]: {
            ...workspace,
            activeSessionId: sessionId,
          },
        },
      };
    });
  }, []);

  const workspace = panelState.workspaces[workspaceKey];
  const currentSessions =
    workspace?.sessionIds
      .map((sessionId) => panelState.sessions[sessionId])
      .filter((session): session is TerminalSessionDescriptor => Boolean(session)) ?? [];
  const activeSession =
    currentSessions.find((session) => session.id === workspace?.activeSessionId) ??
    currentSessions[0] ??
    null;
  const allSessions = Object.values(panelState.sessions);

  // Closing the panel only collapses the UI and does not dispose tabs; a tab's close button always deletes that session.
  // The PTY stays owned by TerminalSession and is released on unmount.
  return (
    <section
      data-testid={TID_TERMINAL}
      className="flex h-full min-h-0 flex-col gap-2 overflow-hidden bg-background p-3 pb-2"
    >
      <Tabs
        value={activeSession?.id ?? ""}
        onValueChange={handleActivateSession}
        className="h-full min-h-0 gap-2"
      >
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex min-w-0 shrink-0 items-center gap-2">
            <div className="truncate text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "terminal.title" })}
            </div>
            {activeSession?.shellLabel ? (
              <div className="shrink-0 text-ui-base text-foreground-subtle">
                {activeSession.shellLabel}
              </div>
            ) : null}
          </div>

          <div className="min-w-0 flex-1 overflow-x-auto !scrollbar-hide">
            <TabsList className="flex !h-7 w-max justify-start gap-1 rounded-none bg-transparent p-0">
              {currentSessions.map((session) => {
                const projectName =
                  getPathLeaf(session.cwd ?? "") || intl.formatMessage({ id: "terminal.title" });
                const title = formatTerminalTabTitle(projectName, session.index);
                return (
                  <TerminalTabTrigger
                    key={session.id}
                    session={session}
                    title={title}
                    closeLabel={intl.formatMessage({ id: "terminal.closeTab" }, { title })}
                    isActive={session.id === activeSession?.id}
                    onClose={handleCloseSession}
                  />
                );
              })}
            </TabsList>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {!isOfficeMode && (
              <Button
                type="button"
                size="icon-md"
                variant="ghost"
                onClick={handleCreateSession}
                title={intl.formatMessage({ id: "terminal.new" })}
                aria-label={intl.formatMessage({ id: "terminal.new" })}
              >
                <Plus className="h-4 w-4" />
              </Button>
            )}
            <Button
              type="button"
              size="icon-md"
              variant="ghost"
              onClick={onClose}
              data-testid={TID_TERMINAL_CLOSE_BUTTON}
              title={intl.formatMessage({ id: "terminal.close" })}
              aria-label={intl.formatMessage({ id: "terminal.close" })}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {allSessions.map((session) => (
            <TabsContent
              key={session.id}
              value={session.id}
              forceMount
              className="h-full min-h-0 flex-1 data-[state=inactive]:hidden"
            >
              <TerminalSession
                sessionId={session.id}
                services={session.services}
                cwd={session.cwd}
                isVisible={
                  isVisible &&
                  session.workspaceKey === workspaceKey &&
                  session.id === activeSession?.id
                }
                isPanelResizing={isPanelResizing}
                isWindowsDesktop={isWindowsDesktop}
                onShellLabelChange={handleShellLabelChange}
                onExit={handleSessionExit}
                onOpenBrowserUrl={onOpenBrowserUrl}
              />
            </TabsContent>
          ))}
        </div>
      </Tabs>
    </section>
  );
}

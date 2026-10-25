import { useCallback } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { TerminalSession } from "@/terminal/TerminalSession.js";

export function SidePaneTerminalPane({
  services,
  sessionId,
  workspaceKey,
  cwd,
  isVisible,
  isWindowsDesktop = false,
  onOpenBrowserUrl,
}: {
  services: IServiceAccessor;
  /**
   * Keep the terminal alive: sessionId reuses tab.id (stable across workspaces) and also serves as TerminalSession's persistentKey.
   * Move xterm+PTY ownership into the module-level sidePaneTerminalSessionRegistry singleton,
   * so unmounting the component detaches without disposing; remounting reuses by key and preserves scrollback across workspaces.
   */
  sessionId: string;
  /**
   * Workspace identity isolation key (= workspaceIdentity?.trim() || workspacePath).
   * Stored in registry entry.workspaceKey and used to reclaim PTYs in bulk when a workspace tab closes.
   */
  workspaceKey?: string;
  cwd?: string;
  isVisible: boolean;
  isWindowsDesktop?: boolean;
  onOpenBrowserUrl: (url: string) => void;
}) {
  const handleShellLabelChange = useCallback(() => {
    // Product note: The outer side-pane tab already carries the terminal title, so only one shell instance is needed here;
    // do not display or synchronize a second terminal tab title, which would create nested tabs.
  }, []);

  return (
    <section className="h-full min-h-0 overflow-hidden bg-background p-3">
      <TerminalSession
        sessionId={sessionId}
        persistentKey={sessionId}
        workspaceKey={workspaceKey}
        services={services}
        cwd={cwd}
        isVisible={isVisible}
        isWindowsDesktop={isWindowsDesktop}
        onShellLabelChange={handleShellLabelChange}
        onOpenBrowserUrl={onOpenBrowserUrl}
      />
    </section>
  );
}

import { BrowserWindow } from "electron";
import { claimsRemoteWorkspaceIdentity } from "@zcode/shared";
import { handleOpenWorkspacePath } from "./desktopOAuthDeepLink.js";

type WebRemoteControlWorkspaceOpenLogger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

/**
 * Opens (or reuses) a local workspace in the desktop window that owns the Web remote-control
 * session. Reuses the deep-link workspace-open routing (path validation + OpenWorkspacePath IPC +
 * target-window focus) so the renderer keeps the same activate/addTab + startDraft contract as the
 * desktop command-center flow; resolves once Main dispatched the open to the renderer.
 *
 * The path-only renderer open keys the tab by path, so it cannot carry a remote workspace identity.
 * A remote identity (including one that claims the remote form but does not parse) therefore fails
 * closed here instead of opening the remote filesystem path as a local workspace.
 */
export function openWebRemoteControlWorkspaceInWindow(
  windowId: number,
  target: { workspacePath: string; workspaceIdentity?: string },
  logger: WebRemoteControlWorkspaceOpenLogger,
): Promise<void> {
  const identity = target.workspaceIdentity?.trim() ?? "";
  if (identity && claimsRemoteWorkspaceIdentity(identity)) {
    logger.warn("[web-remote-control] remote workspace open rejected: identity is not routable", {
      workspacePath: target.workspacePath,
    });
    return Promise.reject(
      new Error(
        `Web remote control cannot open a remote workspace identity on desktop: ${target.workspacePath}`,
      ),
    );
  }

  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) {
    return Promise.reject(
      new Error("Desktop window is not available for Web remote control workspace open."),
    );
  }

  const dispatched = handleOpenWorkspacePath(target.workspacePath, logger, {
    resolveApplicationWindow: () => win,
  });
  if (!dispatched) {
    return Promise.reject(
      new Error(`Web remote control workspace open was rejected: ${target.workspacePath}`),
    );
  }

  return Promise.resolve();
}

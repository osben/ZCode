import { BrowserWindow } from "electron";
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
 * `workspaceIdentity` is carried by the protocol for correlation only: the reused renderer path is
 * keyed by path, and freshly created worktrees have no identity yet.
 */
export function openWebRemoteControlWorkspaceInWindow(
  windowId: number,
  target: { workspacePath: string; workspaceIdentity?: string },
  logger: WebRemoteControlWorkspaceOpenLogger,
): Promise<void> {
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

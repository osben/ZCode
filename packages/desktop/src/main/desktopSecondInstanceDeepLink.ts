import type { BrowserWindow } from "electron";
import type { ExternalWorkspaceOpenDialogCopy } from "./desktopOAuthDeepLink.js";
import type { TaskDraftDialogCopy } from "./desktopTaskDraftDeepLink.js";
import {
  extractDeepLinkUrlFromArgs,
  extractDeepLinkUrlFromSingleInstanceData,
  extractOpenWorkspacePathFromArgs,
  extractOpenWorkspacePathFromSingleInstanceData,
} from "./desktopDeepLinkUrl.js";

interface SecondInstanceWorkspaceDeps {
  additionalData: unknown;
  argv: readonly string[];
  forceUpdateBlocked: boolean;
  focusForceUpdateGateWindow: () => void;
  handleDeepLink: (
    url: string,
    options: {
      canOpenWorkspace: () => boolean;
      confirmationCopy?: ExternalWorkspaceOpenDialogCopy;
      taskDraftConfirmationCopy?: TaskDraftDialogCopy;
      onWorkspaceOpenBlocked: () => void;
      resolveApplicationWindow?: () => BrowserWindow | null;
    },
  ) => boolean;
  handleOpenWorkspacePath: (
    path: string,
    options?: {
      allowWithoutReadyWindow?: boolean;
      resolveApplicationWindow?: () => BrowserWindow | null;
    },
  ) => boolean;
  logger: { warn: (...args: unknown[]) => void };
  workspaceConfirmationCopy?: ExternalWorkspaceOpenDialogCopy;
  taskDraftConfirmationCopy?: TaskDraftDialogCopy;
  resolveApplicationWindow?: () => BrowserWindow | null;
}

export function handleSecondInstanceWorkspaceRequest(deps: SecondInstanceWorkspaceDeps): boolean {
  const url =
    // Linux desktop environments may reorder or append arguments to second-instance argv.
    // Electron recommends passing exact arguments through additionalData; prefer the deep link pre-parsed by the second instance.
    extractDeepLinkUrlFromSingleInstanceData(deps.additionalData) ??
    extractDeepLinkUrlFromArgs(deps.argv);
  if (
    url &&
    deps.handleDeepLink(url, {
      canOpenWorkspace: () => !deps.forceUpdateBlocked,
      confirmationCopy: deps.workspaceConfirmationCopy,
      taskDraftConfirmationCopy: deps.taskDraftConfirmationCopy,
      resolveApplicationWindow: deps.resolveApplicationWindow,
      onWorkspaceOpenBlocked: () => {
        deps.logger.warn(
          "[force-update] 已忽略强制升级期间的 second-instance workspace deep link 请求",
        );
        deps.focusForceUpdateGateWindow();
      },
    })
  ) {
    return true;
  }

  const openWorkspacePath =
    extractOpenWorkspacePathFromSingleInstanceData(deps.additionalData) ??
    extractOpenWorkspacePathFromArgs(deps.argv);
  if (openWorkspacePath && deps.forceUpdateBlocked) {
    deps.logger.warn("[force-update] 已忽略强制升级期间的 second-instance workspace 请求");
    deps.focusForceUpdateGateWindow();
    return true;
  }
  return Boolean(
    openWorkspacePath &&
    deps.handleOpenWorkspacePath(openWorkspacePath, {
      resolveApplicationWindow: deps.resolveApplicationWindow,
    }),
  );
}

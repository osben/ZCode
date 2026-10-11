import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  runXdgCommand,
  XDG_COMMAND_TIMEOUT_MS,
  type LinuxDesktopCommandRunner,
  type LinuxDeepLinkRegistrationLogger,
} from "./desktopLinuxXdg.js";

// AppImage per-user icon installation logic split from desktopLinuxDeepLinkRegistration:
// icon integration is an optional desktop enhancement and separate from deep-link protocol registration, so keep it in its own module.

const LINUX_APP_ICON_NAME = "zcode";
const LINUX_APP_ICON_SIZE = "512x512";

function resolveLinuxUserIconFilePath(dataDir: string): string {
  return join(
    dataDir,
    "icons",
    "hicolor",
    LINUX_APP_ICON_SIZE,
    "apps",
    `${LINUX_APP_ICON_NAME}.png`,
  );
}

function copyFileIfChanged(sourcePath: string, targetPath: string): boolean {
  if (existsSync(targetPath) && readFileSync(sourcePath).equals(readFileSync(targetPath))) {
    return false;
  }

  copyFileSync(sourcePath, targetPath);
  return true;
}

export function shouldInstallAppImageDesktopIcon(params: {
  env?: { APPIMAGE?: string };
  iconSourcePath?: string;
}): boolean {
  return Boolean(params.env?.APPIMAGE?.trim() && params.iconSourcePath);
}

export function installLinuxAppImageDesktopIcon(params: {
  dataDir: string;
  iconSourcePath: string;
  logger: LinuxDeepLinkRegistrationLogger;
  runCommand?: LinuxDesktopCommandRunner;
}): { iconFilePath: string; installed: boolean; changed: boolean } {
  const iconFilePath = resolveLinuxUserIconFilePath(params.dataDir);
  if (!existsSync(params.iconSourcePath)) {
    params.logger.warn("[deep-link] Linux AppImage 图标源文件不存在，跳过用户级图标安装", {
      iconSourcePath: params.iconSourcePath,
      iconFilePath,
    });
    return { iconFilePath, installed: false, changed: false };
  }

  mkdirSync(dirname(iconFilePath), { recursive: true });
  const changed = copyFileIfChanged(params.iconSourcePath, iconFilePath);
  // Running an AppImage directly does not add Icon=zcode to the hicolor icon theme like a deb package does.
  // Add the same-named icon to the per-user hicolor directory so the taskbar/Dock can find the real icon through the desktop entry.
  if (!changed) {
    return { iconFilePath, installed: true, changed };
  }

  const runCommand = params.runCommand ?? runXdgCommand;
  const cacheResult = runCommand("gtk-update-icon-cache", [
    "-f",
    "-t",
    join(params.dataDir, "icons", "hicolor"),
  ]);
  if (cacheResult.error) {
    params.logger.warn("[deep-link] gtk-update-icon-cache 不可用，已跳过", {
      iconFilePath,
      message: cacheResult.error.message,
    });
  } else if (cacheResult.signal === "SIGTERM") {
    params.logger.warn("[deep-link] Linux 用户级图标缓存刷新超时，已跳过", {
      iconFilePath,
      timeoutMs: XDG_COMMAND_TIMEOUT_MS,
    });
  } else if (cacheResult.status !== 0) {
    params.logger.warn("[deep-link] Linux 用户级图标缓存刷新失败", {
      iconFilePath,
      status: cacheResult.status,
      stderr: cacheResult.stderr?.trim(),
    });
  }

  return { iconFilePath, installed: true, changed };
}

export function installLinuxAppImageDesktopIconBestEffort(params: {
  dataDir: string;
  env?: { APPIMAGE?: string };
  iconSourcePath?: string;
  logger: LinuxDeepLinkRegistrationLogger;
  runCommand?: LinuxDesktopCommandRunner;
}): { iconFilePath: string; installed: boolean; changed: boolean } | null {
  if (
    !shouldInstallAppImageDesktopIcon({
      env: params.env,
      iconSourcePath: params.iconSourcePath,
    }) ||
    !params.iconSourcePath
  ) {
    return null;
  }

  try {
    return installLinuxAppImageDesktopIcon({
      dataDir: params.dataDir,
      iconSourcePath: params.iconSourcePath,
      logger: params.logger,
      runCommand: params.runCommand,
    });
  } catch (error) {
    params.logger.warn("[deep-link] Linux AppImage 图标安装失败，已降级", {
      iconSourcePath: params.iconSourcePath,
      error,
    });
    return null;
  }
}

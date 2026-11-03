import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { dirname, normalize, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserWindow } from "electron";
import { shell } from "electron";

type DesktopIpcLogger = {
  info?: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

export async function openFileUrlInDefaultApp(
  url: string,
  logger: DesktopIpcLogger,
): Promise<void> {
  try {
    const filePath = fileURLToPath(url);
    await openPathInDefaultApp(filePath, logger);
  } catch (error) {
    logger.warn("[open-external] file URL 打开失败", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// "Open in default app" is for documents. These targets would run as programs, and the request can
// come from a compromised renderer or the web-remote proxy, so they are revealed instead of opened.
const POSIX_EXECUTABLE_EXTENSIONS = new Set([
  ".app",
  ".command",
  ".tool",
  ".terminal",
  ".fileloc",
  ".pkg",
  ".mpkg",
  ".jar",
  ".desktop",
  ".appimage",
  ".run",
]);
const WINDOWS_EXECUTABLE_EXTENSIONS = new Set([
  ".exe",
  ".com",
  ".bat",
  ".cmd",
  ".ps1",
  ".vbs",
  ".vbe",
  ".js",
  ".jse",
  ".wsf",
  ".wsh",
  ".msc",
  ".scr",
  ".pif",
  ".cpl",
  ".hta",
  ".msi",
  ".msp",
  ".lnk",
  ".url",
  ".reg",
  ".jar",
  ".appref-ms",
  ".application",
]);
const EXECUTABLE_TARGET_BLOCKED_ERROR = "executable-target-blocked";

export function isExecutableOpenTarget(
  target: string,
  entry: { isFile: boolean; isDirectory: boolean; mode: number },
  platform: NodeJS.Platform = process.platform,
  pathext: string | undefined = process.env.PATHEXT,
): boolean {
  if (platform === "win32") {
    // Windows ignores trailing dots and spaces, so "evil.exe." still runs as evil.exe.
    const extension = win32.extname(target.replace(/[. ]+$/u, "")).toLowerCase();
    if (!extension) return false;
    const pathextExtensions = (pathext ?? "")
      .split(";")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    return WINDOWS_EXECUTABLE_EXTENSIONS.has(extension) || pathextExtensions.includes(extension);
  }
  const extension = posix.extname(target.replace(/\/+$/u, "")).toLowerCase();
  if (POSIX_EXECUTABLE_EXTENSIONS.has(extension)) return entry.isFile || entry.isDirectory;
  // macOS runs an extensionless executable in Terminal; any execute bit counts.
  return entry.isFile && (entry.mode & 0o111) !== 0;
}

async function isBlockedExecutableTarget(target: string): Promise<boolean> {
  try {
    const entry = await stat(target);
    return isExecutableOpenTarget(target, {
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
      mode: entry.mode,
    });
  } catch {
    // A missing path goes to shell.openPath unchanged so the OS reports its own error.
    return false;
  }
}

export async function openPathInDefaultApp(
  rawPath: string,
  logger: DesktopIpcLogger,
): Promise<{ success: boolean; error?: string }> {
  const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!trimmed) {
    const error = "empty path";
    logger.warn("[open-external] 本地文件打开失败", { path: rawPath, error });
    return { success: false, error };
  }

  const normalized = normalize(trimmed);
  let target = normalized;
  try {
    target = await realpath(normalized);
  } catch {
    // If the path is missing or cannot be resolved, still try the normalized original path so the system can return a more specific error.
  }

  if (await isBlockedExecutableTarget(target)) {
    logger.warn("[open-external] executable target revealed instead of opened", { path: target });
    shell.showItemInFolder(target);
    return { success: false, error: EXECUTABLE_TARGET_BLOCKED_ERROR };
  }

  try {
    const error = await shell.openPath(target);
    if (error) {
      logger.warn("[open-external] 本地文件打开失败", { path: target, error });
      return { success: false, error };
    }
    logger.info?.("[open-external] 本地文件打开成功", { path: target });
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("[open-external] 本地文件打开失败", { path: target, error: message });
    return { success: false, error: message };
  }
}

export async function openPathInFileManager(
  rawPath: string,
  logger: DesktopIpcLogger,
): Promise<{ success: boolean; error?: string }> {
  const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!trimmed) {
    return { success: false, error: "empty path" };
  }
  const normalized = normalize(trimmed);
  let target = normalized;
  try {
    target = await realpath(normalized);
  } catch {
    // If the path is missing or cannot be resolved, still try opening the normalized original path to help diagnose permission issues.
  }

  let openTarget = target;
  try {
    // Classify via the lexical path (stat follows symlinks), but reveal the path the caller
    // named: realpath would replace a workspace symlink with its destination's folder.
    if ((await stat(normalized)).isFile()) {
      // A file means "reveal": open the containing folder with the file selected. Falling through
      // to shell.openPath would launch the file's default application instead of the file manager.
      shell.showItemInFolder(normalized);
      return { success: true };
    }
  } catch (error) {
    // Only a missing entry (the agent may have deleted or moved the file after the message was
    // sent) falls back to its parent directory. Permission or transient I/O errors propagate, so
    // the caller reports a failure instead of silently opening the wrong folder.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("[open-in-file-manager] 无法确认条目类型", { path: target, error: message });
      return { success: false, error: message };
    }
    const parent = dirname(target);
    if (parent && parent !== target) {
      openTarget = await stat(parent).then(
        (entry) => (entry.isDirectory() ? parent : target),
        () => target,
      );
    }
  }

  // Application bundles (.app) are directories that `open`/`shell.openPath` would execute; a
  // location-only action must reveal them instead. Files never reach this point (revealed above),
  // and isExecutableOpenTarget's other rules classify file targets, not plain directories.
  if (await isBlockedExecutableTarget(target)) {
    shell.showItemInFolder(target);
    return { success: true };
  }

  if (process.platform === "darwin") {
    return openDarwinPathInFileManager(openTarget, logger);
  }

  const error = await shell.openPath(openTarget);
  if (error) {
    logger.warn("[open-in-file-manager] shell.openPath 失败", {
      path: target,
      error,
    });
    return { success: false, error };
  }
  return { success: true };
}

export async function captureWindowScreenshot(senderWindow: BrowserWindow | null) {
  if (!senderWindow || senderWindow.isDestroyed()) {
    return null;
  }

  // Feedback from the error banner should include what the user saw.
  // Capture the current window in the main process to avoid requiring screen-recording permission in the renderer or capturing only a portion of the DOM.
  const image = await senderWindow.webContents.capturePage();
  const buffer = image.toPNG();
  return {
    dataBase64: buffer.toString("base64"),
    filename: `zcode-error-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
    contentType: "image/png",
    size: buffer.byteLength,
  };
}

async function openDarwinPathInFileManager(target: string, logger: DesktopIpcLogger) {
  const runOpen = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      execFile("open", args, (error) => (error ? reject(error) : resolve()));
    });

  try {
    await runOpen([target]);
    return { success: true };
  } catch (firstError) {
    try {
      await runOpen(["-a", "Finder", target]);
      return { success: true };
    } catch (finderError) {
      const shellMessage = await shell.openPath(target);
      if (!shellMessage) {
        return { success: true };
      }
      logger.warn("[open-in-file-manager] macOS 打开目录均失败", {
        path: target,
        shellMessage,
        firstError: firstError instanceof Error ? firstError.message : String(firstError),
        finderError: finderError instanceof Error ? finderError.message : String(finderError),
      });
      return { success: false, error: shellMessage };
    }
  }
}

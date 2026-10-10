import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { normalize } from "node:path";
import type { BrowserWindow } from "electron";
import { shell } from "electron";

type DesktopIpcLogger = {
  info?: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

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

  if (process.platform === "darwin") {
    return openDarwinPathInFileManager(target, logger);
  }

  const error = await shell.openPath(target);
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

import { execFile } from "node:child_process";
import path from "node:path";
import type {
  MicrophoneAccessResult,
  MicrophoneResetResult,
  MicrophoneSettingsTarget,
} from "@zcode/shared";
import { PlatformChannels } from "@zcode/shared";
import { app, ipcMain, shell, systemPreferences } from "electron";

// 只允许打开这里列出的固定地址，renderer 只能选 target，不能传任意 URL。
// Linux 桌面环境没有统一的设置页地址，不提供跳转（docs/chat/composer-voice-input.md）。
const MICROPHONE_SETTINGS_URLS: Partial<
  Record<NodeJS.Platform, Record<MicrophoneSettingsTarget, string>>
> = {
  darwin: {
    privacy: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    sound: "x-apple.systempreferences:com.apple.preference.sound?input",
  },
  win32: {
    privacy: "ms-settings:privacy-microphone",
    sound: "ms-settings:sound",
  },
};

// Bundle identifiers reach tccutil as an argument; only accept the reverse-DNS characters macOS allows.
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9.-]+$/;

type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

function runCommand(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

/**
 * The bundle id of the running app, read from the Info.plist next to the executable
 * (ZCode.app/Contents/MacOS/ZCode -> ZCode.app/Contents/Info.plist).
 */
async function readOwnBundleId(): Promise<string> {
  const infoPlist = path.join(path.dirname(path.dirname(process.execPath)), "Info.plist");
  const bundleId = (
    await runCommand("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", infoPlist])
  ).trim();
  if (!BUNDLE_ID_PATTERN.test(bundleId)) throw new Error(`invalid bundle id: ${bundleId}`);
  return bundleId;
}

export async function ensureMicrophoneAccess(
  platform: NodeJS.Platform = process.platform,
): Promise<MicrophoneAccessResult> {
  if (platform !== "darwin" && platform !== "win32") return "unsupported";
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return "granted";
  if (platform === "darwin" && status === "not-determined") {
    return (await systemPreferences.askForMediaAccess("microphone")) ? "granted" : "denied";
  }
  // Windows 的 "unknown" / "not-determined" 不能证明被拒绝，交给 getUserMedia 的真实结果。
  return status === "denied" || status === "restricted" ? "denied" : "unsupported";
}

/**
 * macOS only. A previously denied microphone decision cannot be re-requested by the system prompt,
 * so a packaged build clears this app's TCC entry with tccutil, then asks again. A dev build is not
 * a bundle with a stable identity, so it skips tccutil and reports restart-required when still denied.
 */
export async function resetMicrophoneAccess(logger: Logger): Promise<MicrophoneResetResult> {
  if (process.platform !== "darwin") return "failed";
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return "granted";
  if (status === "restricted") return "failed";
  if (app.isPackaged) {
    try {
      await runCommand("/usr/bin/tccutil", ["reset", "Microphone", await readOwnBundleId()]);
    } catch (error) {
      logger.warn(
        `[voice-input] reset microphone access failed error=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return "failed";
    }
  }
  const afterReset = systemPreferences.getMediaAccessStatus("microphone");
  if (afterReset === "granted") return "granted";
  if (afterReset === "not-determined") {
    return (await systemPreferences.askForMediaAccess("microphone")) ? "granted" : "denied";
  }
  return "restart-required";
}

export function registerDesktopMicrophoneIpcHandlers(logger: Logger) {
  ipcMain.handle(PlatformChannels.MicrophoneAccess, async (): Promise<MicrophoneAccessResult> => {
    const result = await ensureMicrophoneAccess();
    logger.info(`[voice-input] microphone access platform=${process.platform} result=${result}`);
    return result;
  });
  // Concurrent clicks share one reset: tccutil must not run twice against the same TCC entry.
  let inFlightReset: Promise<MicrophoneResetResult> | null = null;
  ipcMain.handle(PlatformChannels.ResetMicrophoneAccess, (): Promise<MicrophoneResetResult> => {
    inFlightReset ??= resetMicrophoneAccess(logger)
      .catch((error: unknown) => {
        logger.warn(
          `[voice-input] reset microphone access error=${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return "failed" as const;
      })
      .then((result) => {
        logger.info(
          `[voice-input] reset microphone access result=${result} packaged=${app.isPackaged}`,
        );
        return result;
      })
      .finally(() => {
        inFlightReset = null;
      });
    return inFlightReset;
  });
  ipcMain.handle(
    PlatformChannels.OpenMicrophoneSettings,
    async (_event, target: unknown): Promise<boolean> => {
      if (target !== "privacy" && target !== "sound") return false;
      const url = MICROPHONE_SETTINGS_URLS[process.platform]?.[target];
      if (!url) return false;
      try {
        await shell.openExternal(url);
        return true;
      } catch (error) {
        logger.warn(
          `[voice-input] open microphone settings failed target=${target} error=${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return false;
      }
    },
  );
}

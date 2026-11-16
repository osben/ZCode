import { execFile } from "node:child_process";
import { app, ipcMain, shell, systemPreferences } from "electron";
import { PlatformChannels } from "@zcode/shared";
import type {
  MicrophoneAccessStatus,
  MicrophoneResetResult,
  SystemSettingsTarget,
} from "@zcode/shared";

/**
 * System microphone permission for voice dictation (specs/voice-dictation.md "Microphone
 * permission guide"). All OS access happens in main: the renderer only sees the four platform
 * capabilities. macOS is the only platform with a reset path — after a denied prompt the system
 * never re-prompts, so "re-authorize" resets this app's own TCC microphone record (`tccutil reset
 * Microphone <bundle id>`) and asks again. Dev builds skip tccutil: the unpackaged app shares the
 * Electron bundle id and TCC records dev apps by path, so resetting by bundle id would be a no-op
 * here and could disturb other projects. The reset state machine returns `restart-required` when
 * the process still reads `denied` afterwards: TCC only re-reads on next launch.
 */

const COMMAND_TIMEOUT_MS = 5_000;

type ExecAsync = (file: string, args: string[]) => Promise<string>;

function execAsync(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: COMMAND_TIMEOUT_MS }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

/** macOS system settings URLs the service may open; the renderer picks only a named target. */
const SETTINGS_URLS: Record<string, Record<SystemSettingsTarget, string>> = {
  darwin: {
    "microphone-privacy":
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    "sound-input": "x-apple.systempreferences:com.apple.preference.sound?input",
  },
  win32: {
    "microphone-privacy": "ms-settings:privacy-microphone",
    "sound-input": "ms-settings:sound",
  },
};

export interface DesktopMicrophoneAccessOptions {
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  /** Test seams; production uses the Electron APIs and the real tccutil. */
  platform?: NodeJS.Platform;
  exec?: ExecAsync;
  getMediaAccessStatus?: (mediaType: "microphone") => string;
  askForMediaAccess?: (mediaType: "microphone") => Promise<boolean>;
  getBundleId?: () => string | undefined;
  isPackaged?: boolean;
  openExternal?: (url: string) => Promise<void>;
}

/**
 * Runs one "re-authorize" attempt through the documented state machine. Concurrent attempts share
 * a single serialized chain so two windows cannot run tccutil or the system prompt simultaneously.
 */
export function resolveMicrophoneReset(options: {
  status: () => Promise<MicrophoneAccessStatus>;
  ask: () => Promise<boolean>;
  resetTcc: () => Promise<boolean>;
  /** True when the tccutil step applies (packaged macOS build with a bundle id). */
  canResetTcc: boolean;
}): Promise<MicrophoneResetResult> {
  const run = async (): Promise<MicrophoneResetResult> => {
    // Already granted (e.g. the user fixed it in System Settings): never reset a working grant.
    if ((await options.status()) === "granted") return "granted";
    if (!options.canResetTcc) {
      // Dev build: no tccutil. The current process keeps its old denial, only a restart re-reads it.
      return "restart-required";
    }
    if (!(await options.resetTcc())) return "failed";
    const status = await options.status();
    if (status === "granted") return "granted";
    if (status === "not-determined") return (await options.ask()) ? "granted" : "denied";
    // Still denied (or restricted): this process keeps reading the stale record until relaunch.
    return "restart-required";
  };
  return run();
}

export function registerDesktopMicrophoneAccessIpc(options: DesktopMicrophoneAccessOptions) {
  const { logger } = options;
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? execAsync;
  const readStatus =
    options.getMediaAccessStatus ?? ((type) => systemPreferences.getMediaAccessStatus(type));
  const ask = options.askForMediaAccess ?? ((type) => systemPreferences.askForMediaAccess(type));
  const getBundleId =
    options.getBundleId ??
    (() => {
      try {
        return app.getInfoValueForKey?.("CFBundleIdentifier");
      } catch {
        return undefined;
      }
    });
  const isPackaged = options.isPackaged ?? app.isPackaged;
  const openExternal = options.openExternal ?? ((url) => shell.openExternal(url));

  const status = async (): Promise<MicrophoneAccessStatus> => {
    // Linux has no system permission API; the renderer falls back to its getUserMedia error path.
    if (platform !== "darwin" && platform !== "win32") return "unsupported";
    const raw = readStatus("microphone");
    return raw === "granted" || raw === "denied" || raw === "restricted" || raw === "not-determined"
      ? raw
      : "unsupported";
  };

  // One reset at a time: the chain makes a second click wait for the first attempt's outcome
  // instead of running tccutil or a system prompt concurrently.
  let resetChain: Promise<MicrophoneResetResult> = Promise.resolve("denied");

  ipcMain.handle(PlatformChannels.GetMicrophoneAccessStatus, () => status());

  ipcMain.handle(PlatformChannels.AskMicrophoneAccess, async () => {
    if (platform !== "darwin") return (await status()) === "granted";
    return ask("microphone");
  });

  ipcMain.handle(PlatformChannels.ResetMicrophoneAccess, () => {
    const bundleId = getBundleId();
    const canResetTcc =
      platform === "darwin" && isPackaged && typeof bundleId === "string" && bundleId !== "";
    const next = resetChain
      .catch(() => undefined)
      .then(() =>
        resolveMicrophoneReset({
          status,
          ask: () => ask("microphone"),
          canResetTcc,
          resetTcc: async () => {
            try {
              await exec("/usr/bin/tccutil", ["reset", "Microphone", bundleId!]);
              return true;
            } catch (error) {
              logger.warn(
                `[microphone-access] tccutil reset failed: ${error instanceof Error ? error.message : String(error)}`,
              );
              return false;
            }
          },
        }),
      );
    // Each caller awaits its own attempt's result; the chain only serializes execution.
    resetChain = next;
    void next.then((result) =>
      logger.info(`[microphone-access] reset microphone access result=${result}`),
    );
    return next;
  });

  ipcMain.handle(
    PlatformChannels.OpenSystemSettings,
    async (_event, payload: { target: string }) => {
      const urls = SETTINGS_URLS[platform];
      const target = payload?.target;
      if (!urls || (target !== "microphone-privacy" && target !== "sound-input")) return;
      try {
        await openExternal(urls[target]);
      } catch (error) {
        logger.warn(
          `[microphone-access] failed to open system settings (${target}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}

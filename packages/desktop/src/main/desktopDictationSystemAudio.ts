import { execFile, execFileSync } from "node:child_process";
import { app, ipcMain, type WebContents } from "electron";
import { PlatformChannels } from "@zcode/shared";

/**
 * System-wide output mute used by voice dictation "mute while recording" (spec:
 * docs/ui/voice-dictation-feedback-sounds.md). The main process owns the mute so it survives
 * renderer/Host failures: the previous mute state is snapshotted when the first recording mutes
 * the output and restored when the last one releases, on quit, or when the owning renderer dies.
 * Handy-parity per-OS backends: macOS osascript, Linux wpctl→pactl→amixer; Windows stays a logged
 * no-op because preserving mute state there needs a native dependency we do not ship.
 */

const COMMAND_TIMEOUT_MS = 2_000;

type ExecAsync = (file: string, args: string[]) => Promise<string>;
type ExecSync = (file: string, args: string[]) => string;

function execAsync(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: COMMAND_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

function execSync(file: string, args: string[]): string {
  return String(
    execFileSync(file, args, {
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
}

interface SystemAudioBackend {
  readMuted(): Promise<boolean>;
  setMuted(muted: boolean): Promise<void>;
  readMutedSync(): boolean;
  setMutedSync(muted: boolean): void;
}

function createMacosBackend(exec: { async: ExecAsync; sync: ExecSync }): SystemAudioBackend {
  const readArgs = ["-e", "output muted of (get volume settings)"];
  const setArgs = (muted: boolean) => ["-e", `set volume output muted ${muted ? "true" : "false"}`];
  return {
    async readMuted() {
      return (await exec.async("osascript", readArgs)).trim() === "true";
    },
    async setMuted(muted) {
      await exec.async("osascript", setArgs(muted));
    },
    readMutedSync() {
      return exec.sync("osascript", readArgs).trim() === "true";
    },
    setMutedSync(muted) {
      exec.sync("osascript", setArgs(muted));
    },
  };
}

const LINUX_TOOLS = ["wpctl", "pactl", "amixer"] as const;
type LinuxTool = (typeof LINUX_TOOLS)[number];

function parseLinuxMuted(tool: LinuxTool, stdout: string): boolean {
  if (tool === "wpctl") return /\[MUTED\]/i.test(stdout);
  if (tool === "pactl") return /mute:\s*yes/i.test(stdout);
  return /\[off\]/i.test(stdout);
}

function linuxReadArgs(tool: LinuxTool): string[] {
  if (tool === "wpctl") return ["get-volume", "@DEFAULT_AUDIO_SINK@"];
  if (tool === "pactl") return ["get-sink-mute", "@DEFAULT_SINK@"];
  return ["get", "Master"];
}

function linuxSetArgs(tool: LinuxTool, muted: boolean): string[] {
  if (tool === "wpctl") return ["set-mute", "@DEFAULT_AUDIO_SINK@", muted ? "1" : "0"];
  if (tool === "pactl") return ["set-sink-mute", "@DEFAULT_SINK@", muted ? "1" : "0"];
  return ["set", "Master", muted ? "mute" : "unmute"];
}

function createLinuxBackend(exec: { async: ExecAsync; sync: ExecSync }): SystemAudioBackend {
  // Pick the first tool that answers and cache it; a missing tool falls through to the next one,
  // and a failed probe of every tool surfaces as an error so muting is skipped safely.
  let tool: LinuxTool | null = null;
  const resolveTool = async (): Promise<LinuxTool> => {
    if (tool) return tool;
    for (const candidate of LINUX_TOOLS) {
      try {
        parseLinuxMuted(candidate, await exec.async(candidate, linuxReadArgs(candidate)));
        tool = candidate;
        return tool;
      } catch {
        // Tool absent or unusable — try the next one.
      }
    }
    throw new Error("no linux audio mute tool available (wpctl/pactl/amixer)");
  };
  return {
    async readMuted() {
      const resolved = await resolveTool();
      return parseLinuxMuted(resolved, await exec.async(resolved, linuxReadArgs(resolved)));
    },
    async setMuted(muted) {
      const resolved = await resolveTool();
      await exec.async(resolved, linuxSetArgs(resolved, muted));
    },
    readMutedSync() {
      // The async path always resolves the tool before any sync use; without it there is no safe guess.
      return tool ? parseLinuxMuted(tool, exec.sync(tool, linuxReadArgs(tool))) : false;
    },
    setMutedSync(muted) {
      if (tool) exec.sync(tool, linuxSetArgs(tool, muted));
    },
  };
}

function createSystemAudioBackend(
  platform: NodeJS.Platform,
  exec: { async: ExecAsync; sync: ExecSync },
): SystemAudioBackend | null {
  if (platform === "darwin") return createMacosBackend(exec);
  if (platform === "linux") return createLinuxBackend(exec);
  return null;
}

interface MuteSession {
  /** Whether this session actually muted the output (false when it was already muted before). */
  didMute: boolean;
  owners: Map<number, { webContents: WebContents; lost: () => void }>;
  /** Detaches one owner; releases the mute when the last owner disappears. */
  onOwnerLost: (webContentsId: number) => void;
}

export interface DictationSystemAudioLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export function registerDesktopDictationSystemAudioIpc(options: {
  logger: DictationSystemAudioLogger;
  platform?: NodeJS.Platform;
  execAsync?: ExecAsync;
  execSync?: ExecSync;
}) {
  const { logger } = options;
  const exec = {
    async: options.execAsync ?? execAsync,
    sync: options.execSync ?? execSync,
  };
  const platform = options.platform ?? process.platform;
  const backend = createSystemAudioBackend(platform, exec);
  let session: MuteSession | null = null;
  // Serialize read/set pairs so a rapid stop/start cannot interleave snapshot and restore.
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (task: () => Promise<void>) => {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
  };

  const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

  const detachOwnerListeners = (current: MuteSession) => {
    for (const { webContents, lost } of current.owners.values()) {
      webContents.removeListener("destroyed", lost);
      webContents.removeListener("render-process-gone", lost);
    }
  };

  const restore = (sync: boolean) => {
    const current = session;
    if (!current) return;
    session = null;
    detachOwnerListeners(current);
    if (!current.didMute || !backend) return;
    if (sync) {
      try {
        backend.setMutedSync(false);
      } catch (error) {
        logger.warn(`[dictation-audio] failed to restore output mute state: ${describe(error)}`);
      }
      return;
    }
    void backend.setMuted(false).catch((error: unknown) => {
      logger.warn(`[dictation-audio] failed to restore output mute state: ${describe(error)}`);
    });
  };

  if (!backend) {
    logger.warn(
      `[dictation-audio] system output mute is not implemented for platform=${platform}; the setting will have no effect`,
    );
  }

  ipcMain.handle(PlatformChannels.SetDictationSystemMute, (event, payload: { active: boolean }) => {
    if (!payload || typeof payload.active !== "boolean") return;
    if (!backend) return;
    const sender = event.sender;
    // The enqueue promise is returned so the renderer's invoke resolves only after the OS-level
    // change completed; the stop chime depends on that ordering to stay audible.
    if (payload.active) {
      return enqueue(async () => {
        if (!session) {
          let alreadyMuted: boolean;
          try {
            alreadyMuted = await backend.readMuted();
          } catch (error) {
            logger.warn(
              `[dictation-audio] failed to read output mute state, skipping mute: ${describe(error)}`,
            );
            return;
          }
          if (!alreadyMuted) {
            try {
              await backend.setMuted(true);
            } catch (error) {
              logger.warn(`[dictation-audio] failed to mute output, skipping: ${describe(error)}`);
              return;
            }
          }
          const created: MuteSession = {
            didMute: !alreadyMuted,
            owners: new Map(),
            onOwnerLost: (webContentsId) => {
              created.owners.delete(webContentsId);
              if (created.owners.size === 0 && session === created) restore(false);
            },
          };
          session = created;
          logger.info(
            `[dictation-audio] output ${created.didMute ? "muted" : "kept muted (already muted)"} for dictation`,
          );
        }
        const current = session;
        if (!current.owners.has(sender.id)) {
          const lost = () => current.onOwnerLost(sender.id);
          current.owners.set(sender.id, { webContents: sender, lost });
          sender.once("destroyed", lost);
          sender.once("render-process-gone", lost);
        }
      });
    }
    return enqueue(async () => {
      if (!session) return;
      session.owners.delete(sender.id);
      if (session.owners.size === 0) restore(false);
    });
  });

  // Quitting mid-recording must not leave the system muted; the sync restore is used because an
  // async spawn would not outlive the quit. A hard kill of the whole app still leaks the mute
  // (documented residual risk in the spec).
  app.on("before-quit", () => restore(true));
}

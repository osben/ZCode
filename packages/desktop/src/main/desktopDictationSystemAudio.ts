import { execFile, execFileSync } from "node:child_process";
import { ipcMain, type WebContents } from "electron";
import { PlatformChannels } from "@zcode/shared";

/**
 * System-wide output mute used by voice dictation "mute while recording" (spec:
 * docs/ui/voice-dictation-feedback-sounds.md). The main process owns the mute so it survives
 * renderer/Host failures: ownership is registered before the OS commands run, the previous mute
 * state is snapshotted, and the output is restored when the last owner releases, on quit, or when
 * the owning renderer dies. Handy-parity per-OS backends: macOS osascript, Linux
 * wpctl→pactl→amixer; Windows stays a logged no-op because preserving mute state there needs a
 * native dependency we do not ship.
 */

const COMMAND_TIMEOUT_MS = 2_000;
const DRAIN_TIMEOUT_MS = 3_000;

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

function linuxReadArgs(tool: LinuxTool, target: string): string[] {
  if (tool === "wpctl") return ["get-volume", target];
  if (tool === "pactl") return ["get-sink-mute", target];
  return ["get", target];
}

function linuxSetArgs(tool: LinuxTool, target: string, muted: boolean): string[] {
  if (tool === "wpctl") return ["set-mute", target, muted ? "1" : "0"];
  if (tool === "pactl") return ["set-sink-mute", target, muted ? "1" : "0"];
  return ["set", target, muted ? "mute" : "unmute"];
}

/** Resolves the concrete default-sink identifier so mute and restore address the same sink. */
async function resolveWpctlDefaultSink(exec: { async: ExecAsync }): Promise<string> {
  const status = await exec.async("wpctl", ["status"]);
  const sinksIndex = status.indexOf("Sinks:");
  if (sinksIndex === -1) throw new Error("wpctl status has no Sinks section");
  // Bound the search to the Sinks block: without a starred sink, a starred Sources entry would
  // otherwise match and the backend would end up muting the microphone. Section headers ("Sources:",
  // "Filters:", "Clients:") start at column 0 with a letter, while sink lines are indented behind
  // the box-drawing tree column, so a leading letter marks the next section.
  const afterHeading = status.slice(sinksIndex + "Sinks:".length);
  const nextSection = afterHeading.search(/^[A-Za-z]/m);
  const sinksBlock = nextSection === -1 ? afterHeading : afterHeading.slice(0, nextSection);
  const defaultEntry = sinksBlock.match(/^\W*\*\s*(\d+)\./m);
  if (!defaultEntry) throw new Error("wpctl status has no default sink");
  return defaultEntry[1];
}

function createLinuxBackend(exec: { async: ExecAsync; sync: ExecSync }): SystemAudioBackend {
  // The concrete sink is resolved once and retained: the default output can change during a
  // recording (for example Bluetooth disconnects), and restoring via the default handle would
  // then unmute the wrong sink while the originally muted one stays muted.
  let resolved: { tool: LinuxTool; target: string } | null = null;
  const resolveTarget = async (): Promise<{ tool: LinuxTool; target: string }> => {
    if (resolved) return resolved;
    for (const tool of LINUX_TOOLS) {
      try {
        if (tool === "wpctl") {
          const target = await resolveWpctlDefaultSink(exec);
          resolved = { tool, target };
          return resolved;
        }
        if (tool === "pactl") {
          const target =
            (await exec.async("pactl", ["get-default-sink"])).trim() || "@DEFAULT_SINK@";
          resolved = { tool, target };
          return resolved;
        }
        resolved = { tool, target: "Master" };
        return resolved;
      } catch {
        // Tool absent or unusable — try the next one.
      }
    }
    throw new Error("no linux audio mute tool available (wpctl/pactl/amixer)");
  };
  return {
    async readMuted() {
      const { tool, target } = await resolveTarget();
      return parseLinuxMuted(tool, await exec.async(tool, linuxReadArgs(tool, target)));
    },
    async setMuted(muted) {
      const { tool, target } = await resolveTarget();
      await exec.async(tool, linuxSetArgs(tool, target, muted));
    },
    readMutedSync() {
      // The async path always resolves the target before any sync use; without it there is no safe guess.
      return resolved
        ? parseLinuxMuted(
            resolved.tool,
            exec.sync(resolved.tool, linuxReadArgs(resolved.tool, resolved.target)),
          )
        : false;
    },
    setMutedSync(muted) {
      if (resolved) exec.sync(resolved.tool, linuxSetArgs(resolved.tool, resolved.target, muted));
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

/**
 * Mute lifecycle: `muting` covers the in-flight OS commands (ownership is already registered, so a
 * lost owner or a quit during this window still restores), `muted` means the output was muted by
 * this session, `failed` means no mute happened and there is nothing to restore.
 */
type MuteSessionState = "muting" | "muted" | "failed";

interface MuteSession {
  state: MuteSessionState;
  /**
   * Per-renderer acquisition counts: split panes share one webContents, so every recording in the
   * same renderer must be counted individually or the first stop would unmute the others.
   */
  owners: Map<number, { count: number; sender: WebContents; lost: () => void }>;
}

export interface DictationSystemAudioLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/**
 * Sync restore for the accepted shutdown path (`exitPreparedApp` right before `app.exit`) and the
 * updater handoff. Must not hang off `before-quit`: this app cancels that event for quit
 * confirmation and async shutdown preparation, and a canceled quit must keep the recording's mute
 * session alive. Paths that exit without going through the prepared funnel (hard kills) bypass
 * the restore — documented residual risk in the spec.
 */
let restoreForShutdown: (() => Promise<void>) | null = null;

/**
 * Drain the mute command chain and release the session before the process exits. Resolves once
 * the restore finished (or the bounded drain timeout elapsed). Setting this also blocks new mute
 * applies, so a recording starting during shutdown cannot re-mute the output on exit.
 */
export function restoreDictationSystemMuteForShutdown(): Promise<void> {
  return restoreForShutdown?.() ?? Promise.resolve();
}

export function registerDesktopDictationSystemAudioIpc(options: {
  logger: DictationSystemAudioLogger;
  platform?: NodeJS.Platform;
  execAsync?: ExecAsync;
  execSync?: ExecSync;
  /** Bounded wait for an in-flight mute command before giving up on the shutdown restore. */
  drainTimeoutMs?: number;
}) {
  const { logger } = options;
  const exec = {
    async: options.execAsync ?? execAsync,
    sync: options.execSync ?? execSync,
  };
  const platform = options.platform ?? process.platform;
  const backend = createSystemAudioBackend(platform, exec);
  let session: MuteSession | null = null;
  // Serialize read/set pairs so a rapid stop/start cannot interleave snapshot and restore, and so
  // a release only resolves after the OS-level restore finished.
  let chain: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
  };

  const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

  const detachOwner = (owner: { sender: WebContents; lost: () => void }) => {
    owner.sender.removeListener("destroyed", owner.lost);
    owner.sender.removeListener("render-process-gone", owner.lost);
  };

  /**
   * Drop the session and undo its mute. Returns the unmute promise so callers inside the chain can
   * await it. A failed restore keeps the session alive (state stays "muted") so the next
   * recording's release, a re-apply, or the shutdown drain retries the unmute instead of leaving
   * the output muted with nothing left to retry.
   */
  const releaseSession = (current: MuteSession): Promise<void> | undefined => {
    for (const owner of current.owners.values()) detachOwner(owner);
    current.owners.clear();
    // Nothing was muted (already-muted input or a failed mute): forget the session outright.
    if (!backend || (current.state !== "muted" && current.state !== "muting")) {
      if (session === current) session = null;
      return undefined;
    }
    return backend
      .setMuted(false)
      .then(() => {
        if (session === current) session = null;
      })
      .catch((error: unknown) => {
        logger.warn(
          `[dictation-audio] failed to restore output mute state, will retry on the next release or quit: ${describe(error)}`,
        );
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
    if (shuttingDown) return;
    const sender = event.sender;
    if (payload.active) {
      // The enqueue promise is returned so the renderer's invoke resolves only after the OS-level
      // change completed; the stop chime depends on that ordering to stay audible.
      return enqueue(async () => {
        // The gate is re-checked here too: shutdown may begin between the IPC entry and this task
        // running on the chain, and a mute started that late would outlive the drain.
        if (shuttingDown || sender.isDestroyed()) return;
        const current = session;
        if (current) {
          // Split panes share one webContents; count each recording separately.
          const owner = current.owners.get(sender.id);
          if (owner) {
            owner.count += 1;
          } else {
            const lost = () => {
              if (!current.owners.delete(sender.id)) return;
              if (current.owners.size === 0 && session === current) {
                void enqueue(async () => {
                  if (session === current && current.owners.size === 0) {
                    await releaseSession(current);
                  }
                });
              }
            };
            current.owners.set(sender.id, { count: 1, sender, lost });
            sender.once("destroyed", lost);
            sender.once("render-process-gone", lost);
          }
          return;
        }
        // Register ownership before touching the OS: if the sender dies or the app quits during
        // the (up to 2s) commands, the owner-loss/quit paths can still restore the output.
        const created: MuteSession = { state: "muting", owners: new Map() };
        const lost = () => {
          if (!created.owners.delete(sender.id)) return;
          if (created.owners.size === 0 && session === created) {
            void enqueue(async () => {
              if (session === created && created.owners.size === 0) {
                await releaseSession(created);
              }
            });
          }
        };
        created.owners.set(sender.id, { count: 1, sender, lost });
        sender.once("destroyed", lost);
        sender.once("render-process-gone", lost);
        session = created;
        try {
          const alreadyMuted = await backend.readMuted();
          // A slow read (up to 2s) can straddle the shutdown drain: starting the mute now would
          // finish after the app exited and leave the output muted.
          if (shuttingDown) {
            created.state = "failed";
            logger.info("[dictation-audio] shutdown began during the state read; mute skipped");
          } else if (!alreadyMuted) {
            await backend.setMuted(true);
            created.state = "muted";
            logger.info("[dictation-audio] output muted for dictation");
          } else {
            created.state = "failed";
            logger.info("[dictation-audio] output kept muted (already muted) for dictation");
          }
        } catch (error) {
          created.state = "failed";
          logger.warn(`[dictation-audio] failed to mute output, skipping: ${describe(error)}`);
        }
        // The owner may have disappeared while the commands were in flight.
        if (created.owners.size === 0) {
          await releaseSession(created);
        }
      });
    }
    return enqueue(async () => {
      const current = session;
      if (!current) return;
      const owner = current.owners.get(sender.id);
      if (!owner) return;
      owner.count -= 1;
      if (owner.count > 0) return;
      current.owners.delete(sender.id);
      detachOwner(owner);
      if (current.owners.size === 0) await releaseSession(current);
    });
  });

  // Quitting mid-recording must not leave the system muted: exitPreparedApp and the updater
  // handoff call restoreDictationSystemMuteForShutdown() before exiting, because before-quit is
  // cancelable in this app (quit confirmation, async shutdown preparation). The restore DRAINS the
  // command chain first: an in-flight read/set finishes and settles the session state, so the
  // sync unmute cannot race it (unmuting an already-muted user or losing to a completing mute).
  // A hung subprocess falls to the bounded timeout and skips the restore rather than racing.
  let shuttingDown = false;
  restoreForShutdown = () => {
    shuttingDown = true;
    const drain = enqueue(async () => {
      const current = session;
      if (!current) return;
      if (current.state === "muted") {
        try {
          backend.setMutedSync(false);
        } catch (error) {
          logger.warn(`[dictation-audio] failed to restore output mute state: ${describe(error)}`);
        }
      }
      if (session === current) session = null;
    });
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      drain,
      new Promise<void>((resolve) => {
        drainTimer = setTimeout(() => {
          logger.warn(
            "[dictation-audio] shutdown drain timed out; skipping the restore instead of racing the in-flight OS command",
          );
          resolve();
        }, options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS);
      }),
    ])
      .finally(() => clearTimeout(drainTimer))
      .then(() => undefined);
  };
}

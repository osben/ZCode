import { spawnSync } from "node:child_process";

// Shared infrastructure for Linux XDG desktop integration, used by deep-link registration (desktopLinuxDeepLinkRegistration)
// and AppImage icon installation (desktopLinuxAppImageIcon). Keep it separate to avoid a dependency cycle between them.

export const XDG_COMMAND_TIMEOUT_MS = 2_000;

export interface LinuxDeepLinkRegistrationLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface LinuxDesktopCommandResult {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
  stderr?: string;
}

export type LinuxDesktopCommandRunner = (
  command: string,
  args: string[],
) => LinuxDesktopCommandResult;

export function runXdgCommand(command: string, args: string[]): LinuxDesktopCommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: XDG_COMMAND_TIMEOUT_MS,
  });
  // With encoding: "utf8", stderr is already a string; no Buffer compatibility branch is needed.
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stderr: result.stderr,
  };
}

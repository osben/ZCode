/**
 * Manual-login helpers for ACP agents: the user-facing command line per shell
 * and the macOS Terminal script that runs it (specs/acp-agent-runtime.md,
 * "Login helper").
 */
import { spawn } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containsAcpForbiddenLineChar } from "@zcode/shared/acp-launch-rules";
import { createServiceLogger } from "../logger/serviceLogger.js";

const TERMINAL_OPEN_TIMEOUT_MS = 10_000;
const log = createServiceLogger("acp-agent");

export async function defaultOpenTerminal(
  commandLine: string,
): Promise<{ opened: boolean; error?: string }> {
  if (process.platform !== "darwin") {
    return { opened: false, error: "Opening a terminal window is only supported on macOS." };
  }
  try {
    const dir = await mkdtemp(join(tmpdir(), "zcode-acp-login-"));
    const scriptPath = join(dir, "login.command");
    await writeFile(scriptPath, buildMacLoginScript(commandLine), "utf8");
    await chmod(scriptPath, 0o755);
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn("open", ["-a", "Terminal", scriptPath], { stdio: "ignore" });
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
        resolve(null);
      }, TERMINAL_OPEN_TIMEOUT_MS);
      child.once("error", (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    if (exitCode === 0) return { opened: true };
    log.warn(undefined, "ACP login terminal did not open", { exitCode });
    return { opened: false, error: `Could not open Terminal (exit code ${exitCode}).` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(undefined, "ACP login terminal failed", { error: message });
    return { opened: false, error: message };
  }
}

/**
 * The macOS `.command` script for the manual login flow. The banner is printed
 * by `printf` from one single-quoted argument, so `$()`, backticks or quotes in
 * a path cannot execute while printing, and no heredoc terminator exists for a
 * crafted line to close (CR/LF are additionally rejected by the shared launch
 * rules before this runs). The script removes its temporary directory after
 * the login command finishes.
 */
export function buildMacLoginScript(commandLine: string): string {
  if (containsAcpForbiddenLineChar(commandLine)) {
    throw new Error("Login command line must not contain NUL, CR or LF characters");
  }
  return [
    "#!/bin/sh",
    `printf '%s\\n' ${quoteShellArg(`[ZCode] Running: ${commandLine}`)}`,
    commandLine,
    'rm -rf "$(dirname "$0")"',
    "",
  ].join("\n");
}

/** Quotes as a single POSIX-shell argument when plain-safe characters are not sufficient. */
function quoteShellArg(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function quotePowerShellArg(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Builds the manual-login command line for the user's shell: POSIX gets
 * single-quoted arguments; PowerShell (Windows fallback) needs the call
 * operator before a quoted executable path.
 */
export function formatLoginCommand(
  commandPath: string,
  loginArgs: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return [
      "&",
      quotePowerShellArg(commandPath),
      ...loginArgs.map((arg) => quotePowerShellArg(arg)),
    ].join(" ");
  }
  return [quoteShellArg(commandPath), ...loginArgs.map((arg) => quoteShellArg(arg))].join(" ");
}

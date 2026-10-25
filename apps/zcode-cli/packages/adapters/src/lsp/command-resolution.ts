import { constants as fsConstants, type Stats } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve as resolvePath } from "node:path";
import type { ResolvedLspServer } from "@zcode/contracts";
import { resolveExecutionCommand, type ResolvedSpawnCommand } from "../exec/execution-command.js";
import { getWindowsEnvValue, windowsExecutableCandidates } from "../exec/windows-executable.js";
import { buildMcpStdioEnv } from "../mcp/network.js";
import { pathApiFor } from "./paths.js";

export type LspProcessEnvBase = Record<string, string | undefined>;

/**
 * Sanitized base env (the same rules as MCP stdio) with the server's own `env` overlaid last. Keys are
 * replaced case-insensitively on Windows so `Path` and `PATH` cannot both survive.
 */
export function buildLspProcessEnv(
  server: ResolvedLspServer,
  baseEnv: LspProcessEnvBase,
  platform: NodeJS.Platform,
): Record<string, string> {
  const env = buildMcpStdioEnv({ env: baseEnv as NodeJS.ProcessEnv });
  for (const [key, value] of Object.entries(server.env)) {
    if (platform === "win32") {
      const lowerKey = key.toLowerCase();
      for (const existing of Object.keys(env)) {
        if (existing.toLowerCase() === lowerKey) delete env[existing];
      }
    }
    env[key] = value;
  }
  return env;
}

export interface ResolveLspSpawnCommandOptions {
  env: Record<string, string>;
  platform: NodeJS.Platform;
  cwd: string;
  /** Synchronous existence probe, used only for Windows shim lookup at spawn time. */
  exists?: (path: string) => boolean;
}

/**
 * Turns a plugin command into argv for `child_process.spawn`. On Windows a `.cmd`/`.bat` shim is routed
 * through ComSpec with the shared quoting helper; no shell string is built from other sources.
 */
export function resolveLspSpawnCommand(
  server: ResolvedLspServer,
  options: ResolveLspSpawnCommandOptions,
): ResolvedSpawnCommand {
  return resolveExecutionCommand(
    { mode: "argv", file: server.command, args: server.args },
    {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      exists: options.exists,
      platform: options.platform,
    },
  );
}

export interface LspCommandLookupOptions {
  env: Record<string, string>;
  platform: NodeJS.Platform;
  cwd: string;
  /** Async file probe; defaults to a real stat plus executable check. Injectable for tests. */
  isExecutableFile?: (path: string, platform: NodeJS.Platform) => Promise<boolean>;
}

/** Resolves `server.command` on PATH (PATHEXT on Windows) without spawning anything. */
export async function isLspCommandInstalled(
  server: ResolvedLspServer,
  options: LspCommandLookupOptions,
): Promise<boolean> {
  const probe = options.isExecutableFile ?? defaultIsExecutableFile;
  for (const candidate of lookupCandidates(server.command, options)) {
    if (await probe(candidate, options.platform)) return true;
  }
  return false;
}

function lookupCandidates(command: string, options: LspCommandLookupOptions): string[] {
  const { platform, env, cwd } = options;
  const pathApi = pathApiFor(platform);
  const hasDirectory =
    command.includes("/") || command.includes("\\") || pathApi.isAbsolute(command);
  if (platform === "win32") {
    return windowsExecutableCandidates(command, env as NodeJS.ProcessEnv, cwd);
  }
  if (hasDirectory) {
    return [isAbsolute(command) ? command : resolvePath(cwd, command)];
  }
  const pathValue = getWindowsEnvValue(env as NodeJS.ProcessEnv, "PATH") ?? env.PATH ?? "";
  return pathValue
    .split(delimiter)
    .filter((dir) => dir.length > 0)
    .map((dir) => join(dir, command));
}

async function defaultIsExecutableFile(path: string, platform: NodeJS.Platform): Promise<boolean> {
  let info: Stats;
  try {
    info = await stat(path);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;
  if (platform === "win32") return true;
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

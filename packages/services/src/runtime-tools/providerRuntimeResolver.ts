import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve as resolvePath } from "node:path";
import { ZCODE_AGENT_RUNTIME, sanitizeZCodeRuntimeEnvInPlace } from "@zcode/shared";
import { getDataBaseDir, getProviderWorkspaceConfigDir } from "../paths.js";
import { buildRuntimeProcessEnvPatch } from "./runtimeCommandEnv.js";

const ZCODE_AGENT_WORKDIR_ENV = "ZCODE_AGENT_WORKDIR";

/** Return the app-specific configuration directory for a provider and workspace. */
export function resolveProviderConfigDir(
  _legacyProvider: string,
  _workspacePath: string,
  _workspaceIdentity?: string,
): string {
  return getProviderWorkspaceConfigDir();
}

/** Build a clean Node.js environment without Electron- or GPU-related variables. */
export function buildCleanEnv(
  provider: string,
  _configDir: string,
  extra?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    // Filter out Electron-specific and GPU-related environment variables.
    if (key.startsWith("ELECTRON_")) continue;
    if (key.startsWith("ORIGINAL_XDG_")) continue;
    if (key === "NODE_OPTIONS") continue;
    // Bugfix: Git Bash / WSL on Windows can inject SHELL=/usr/bin/bash into process.env.
    // The agent runtime uses SHELL to start child processes on Windows (stdio MCP servers),
    // and an invalid POSIX shell path makes every stdio MCP server fail to start.
    // Do not simply remove SHELL, or the agent may also fail to find a shell and connect to MCP.
    // Replace invalid POSIX paths with a native Windows shell (ComSpec first, then cmd.exe).
    if (key === "SHELL" && process.platform === "win32") {
      const winShell = process.env.ComSpec || "cmd.exe";
      env.SHELL = winShell;
      continue;
    }
    if (key === "GOOGLE_API_KEY") continue;
    env[key] = value;
  }
  // Fix rationale: provider/agent runtime child processes must not inherit NODE_ENV, proxy, or certificate variables from the shell by default.
  // These runtime inputs must come from explicit ZCODE_* configuration or app settings, preventing the user's environment from affecting model requests and tool subprocesses.
  sanitizeZCodeRuntimeEnvInPlace(env);
  // Bugfix: Windows environment variable names are case-insensitive, but ordinary JavaScript objects are case-sensitive.
  // During process.env enumeration, PATH commonly appears as "Path" (title case).
  // After copying it into a plain object, buildRuntimeProcessEnvPatch looks for uppercase "PATH" and gets undefined,
  // so it creates a PATH entry containing only tool paths. During child-process initialization, "PATH" overrides "Path",
  // leaving the agent and its children without the system PATH and unable to find commands such as git, node, or cmd.
  // Normalize Path → PATH so downstream code consistently uses the uppercase key.
  if (process.platform === "win32") {
    const nonCanonicalPathKey = Object.keys(env).find(
      (k) => k.toUpperCase() === "PATH" && k !== "PATH",
    );
    if (nonCanonicalPathKey && env[nonCanonicalPathKey]) {
      env.PATH = env[nonCanonicalPathKey]!;
      delete env[nonCanonicalPathKey];
    }
  }
  if (provider === "glm") {
    const glmHome = getDataBaseDir();
    // Bugfix: the GLM agent writes config/session artifacts under ~/.zcode/cli in dataBaseDir.
    // Set the child process HOME to dataBaseDir so the write directory and runtime read directory always match.
    env.HOME = glmHome;
    if (process.platform === "win32") {
      env.USERPROFILE = glmHome;
    }
  }
  Object.assign(env, buildRuntimeProcessEnvPatch(env));
  if (extra) Object.assign(env, extra);
  return env;
}

const packagedResourcesPath =
  typeof (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath === "string"
    ? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    : null;

function resolveExistingPath(candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolvePlatformScopedBundledAgentRoots(moduleDir?: string): Array<string | null> {
  const platformKey = `${process.platform}-${process.arch}`;
  return [
    resolvePath(process.cwd(), "bundled-agents", platformKey),
    resolvePath(process.cwd(), "packages", "desktop", "bundled-agents", platformKey),
    // dev:web starts the server with pnpm --filter @zcode/server dev, so cwd is packages/server.
    // ZCode Agent resources may be in the desktop package or in bundled-agents/<platform> at the repository root.
    // Add all platform-specific repository directory candidates here so desktop, web, and server share one resolution path.
    resolvePath(process.cwd(), "..", "desktop", "bundled-agents", platformKey),
    moduleDir ? resolvePath(moduleDir, "..", "..", "desktop", "bundled-agents", platformKey) : null,
    moduleDir ? resolvePath(moduleDir, "..", "..", "bundled-agents", platformKey) : null,
  ];
}

function resolveLegacyBundledResourceRoots(moduleDir?: string): Array<string | null> {
  return [
    resolvePath(process.cwd(), "bundled-resources"),
    resolvePath(process.cwd(), "packages", "desktop", "bundled-resources"),
    resolvePath(process.cwd(), "..", "desktop", "bundled-resources"),
    moduleDir ? resolvePath(moduleDir, "..", "..", "desktop", "bundled-resources") : null,
    moduleDir ? resolvePath(moduleDir, "..", "..", "bundled-resources") : null,
  ];
}

export function findZCodeAgentRuntimeBinary(): string | null {
  const runtime = ZCODE_AGENT_RUNTIME;
  const entrySegments = runtime.resolveEntrySegments(process.platform);
  const resourceSegments = [runtime.bundledResourceDir, ...entrySegments];
  const envPath = process.env[runtime.binaryEnvVar];
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  // import.meta.dirname is undefined in the bundled CJS bundle (zcode-server.cjs),
  // and passing it directly to resolvePath causes "paths[0]" argument must be of type string.
  // Guard against a missing value and build the corresponding candidate path only when import.meta.dirname exists.
  const moduleDir: string | undefined = import.meta.dirname;
  const platformScopedRoots = resolvePlatformScopedBundledAgentRoots(moduleDir);
  const legacyRoots = resolveLegacyBundledResourceRoots(moduleDir);

  const candidates = [
    packagedResourcesPath ? resolvePath(packagedResourcesPath, ...resourceSegments) : null,
    resolvePath(homedir(), ".zcode", "server", "agents", ...resourceSegments),
    ...platformScopedRoots.map((root) =>
      root ? resolvePath(root, runtime.bundledResourceDir, ...entrySegments) : null,
    ),
    ...legacyRoots.map((root) => (root ? resolvePath(root, ...resourceSegments) : null)),
  ];
  return resolveExistingPath(candidates);
}

/**
 * Find the agent JavaScript bundle (resources/glm/zcode.cjs).
 * In packaged desktop builds, run this bundle directly with the app's bundled Electron Node runtime; no standalone Node binary is shipped.
 * Candidate directories mirror findZCodeAgentRuntimeBinary, but use the platform-independent nodeBundleEntryFile as the entry point.
 * Do not check GLM_BINARY_PATH; that environment variable points to a native binary and has different semantics.
 */
export function findZCodeAgentRuntimeNodeBundle(): string | null {
  const runtime = ZCODE_AGENT_RUNTIME;
  const entrySegments = runtime.resolveNodeBundleSegments();
  const resourceSegments = [runtime.bundledResourceDir, ...entrySegments];

  // As with findZCodeAgentRuntimeBinary, import.meta.dirname is undefined in the bundled CJS bundle;
  // guard against a missing value before building repository candidate paths.
  const moduleDir: string | undefined = import.meta.dirname;
  const platformScopedRoots = resolvePlatformScopedBundledAgentRoots(moduleDir);
  const legacyRoots = resolveLegacyBundledResourceRoots(moduleDir);

  const candidates = [
    packagedResourcesPath ? resolvePath(packagedResourcesPath, ...resourceSegments) : null,
    resolvePath(homedir(), ".zcode", "server", "agents", ...resourceSegments),
    ...platformScopedRoots.map((root) =>
      root ? resolvePath(root, runtime.bundledResourceDir, ...entrySegments) : null,
    ),
    ...legacyRoots.map((root) => (root ? resolvePath(root, ...resourceSegments) : null)),
  ];
  return resolveExistingPath(candidates);
}

/** Find the binary path for the provider. */
export function findBinary(provider: string): string | null {
  if (provider !== "glm") {
    return null;
  }
  // GLM development mode: discover via ZCODE_AGENT_WORKDIR or a neighboring directory, and return the source entry point as the "binary".
  const devEntry = findGlmDevEntry();
  if (devEntry) {
    return devEntry.agentPath;
  }
  return findZCodeAgentRuntimeBinary();
}

/**
 * Discover the GLM source entry point in development mode.
 * Prefer ZCODE_AGENT_WORKDIR.
 * If unset, look for zcode-cli / glm in a directory adjacent to cwd.
 */
interface GlmDevEntry {
  workdir: string;
  entryArg: string;
  agentPath: string;
}

function resolveGlmDevEntry(workdir: string): GlmDevEntry | null {
  const candidates = [
    ["packages", "cli", "src", "main.ts"],
    ["src", "cli.ts"],
  ];
  for (const segments of candidates) {
    const agentPath = resolvePath(workdir, ...segments);
    if (existsSync(agentPath)) {
      return {
        workdir,
        entryArg: segments.join("/"),
        agentPath,
      };
    }
  }
  return null;
}

function findGlmDevEntry(): GlmDevEntry | null {
  const workdir = process.env[ZCODE_AGENT_WORKDIR_ENV];
  if (workdir) {
    const entry = resolveGlmDevEntry(workdir);
    if (entry) {
      return entry;
    }
  }
  // Bugfix: the desktop dev process has packages/desktop as its cwd. The old logic checked only the parent of cwd,
  // finding packages/zcode-cli instead of ../zcode-cli next to the repository. Locate the repository root first,
  // then discover local GLM source next to the repository while keeping the cwd-adjacent lookup as a non-monorepo fallback.
  const repoRoot = findWorkspaceRoot(process.cwd());
  const anchorDirs = [repoRoot, process.cwd()].filter((anchor): anchor is string =>
    Boolean(anchor),
  );
  const candidates = ["zcode-cli", "glm", "cc-refactor"];
  const seen = new Set<string>();
  for (const anchorDir of anchorDirs) {
    for (const name of candidates) {
      const candidate = resolvePath(anchorDir, "..", name);
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      const entry = resolveGlmDevEntry(candidate);
      if (entry) {
        return entry;
      }
    }
  }
  return null;
}

function findWorkspaceRoot(startDir: string): string | null {
  let current = resolvePath(startDir);
  while (true) {
    if (existsSync(resolvePath(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

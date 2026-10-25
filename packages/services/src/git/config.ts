import { join } from "node:path";

export const DEFAULT_GIT_DISCOVERY_TIMEOUT_MS = 3_000;
export const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 15_000;
// `git push` may be blocked for a long time by the repository's pre-push hook (for example, while running `pnpm test`).
// The 15s timeout used for ordinary Git commands would incorrectly fail an explicit push, so extend the timeout for push only.
export const DEFAULT_GIT_PUSH_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_GIT_DIFF_TIMEOUT_MS = 20_000;
export const DEFAULT_GIT_OUTPUT_BYTES = 512 * 1024;
// A pre-push hook may output full test logs; the 512KB limit for ordinary Git commands
// may truncate and stop the operation before the push finishes. Increase the output limit for push only.
export const DEFAULT_GIT_PUSH_OUTPUT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_GIT_DIFF_BYTES = 1024 * 1024;
export const GIT_UNTRACKED_STAT_MAX_BYTES = 1024 * 1024;
export const GIT_UNTRACKED_STAT_CHUNK_BYTES = 64 * 1024;
export const GIT_UNTRACKED_STAT_CONCURRENCY = 4;

const WINDOWS_GIT_BINARY_CANDIDATES = [
  join(
    process.env.ProgramW6432 ?? process.env.ProgramFiles ?? "C:\\Program Files",
    "Git",
    "cmd",
    "git.exe",
  ),
  join(
    process.env.ProgramW6432 ?? process.env.ProgramFiles ?? "C:\\Program Files",
    "Git",
    "bin",
    "git.exe",
  ),
  join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "cmd", "git.exe"),
  join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "bin", "git.exe"),
];
const GIT_LOCAL_ENV_VARS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_INTERNAL_SUPER_PREFIX",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
];

export function getGitBinaryCandidates(): string[] {
  const candidates = [process.env.ZCODE_GIT_BINARY?.trim(), "git"];
  if (process.platform === "win32") {
    candidates.push(...WINDOWS_GIT_BINARY_CANDIDATES);
  }

  return candidates.filter((candidate): candidate is string => Boolean(candidate));
}

export const DEFAULT_GH_DISCOVERY_TIMEOUT_MS = 3_000;
export const DEFAULT_GH_COMMAND_TIMEOUT_MS = 20_000;
export const DEFAULT_GH_OUTPUT_BYTES = 1024 * 1024;

const WINDOWS_GH_BINARY_CANDIDATES = [
  join(
    process.env.ProgramW6432 ?? process.env.ProgramFiles ?? "C:\\Program Files",
    "GitHub CLI",
    "gh.exe",
  ),
  join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "GitHub CLI", "gh.exe"),
];

// sidebar-pr-status spec: binary candidates mirror getGitBinaryCandidates
// (ZCODE_GH_BINARY override doubles as the E2E seam for a fake gh script).
export function getGhBinaryCandidates(): string[] {
  const candidates = [process.env.ZCODE_GH_BINARY?.trim(), "gh"];
  if (process.platform === "win32") {
    candidates.push(...WINDOWS_GH_BINARY_CANDIDATES);
  }

  return candidates.filter((candidate): candidate is string => Boolean(candidate));
}

// gh must never wait for input and output must stay machine-readable.
export function getGhCommandEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
  };
}

export function getGitCommandEnv(): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
  };

  // The pre-push hook injects local environment variables such as GIT_DIR/GIT_WORK_TREE into child processes.
  // Passing them through unchanged makes Git service commands run against the hook's repository, contaminating temporary/remote repository operations.
  // Always clear Git-local environment variables first, then add ZCode constraint variables so commands depend only on the explicit cwd.
  for (const variableName of GIT_LOCAL_ENV_VARS) {
    delete env[variableName];
  }

  return {
    ...env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    TERM: "dumb",
    LC_ALL: "C",
    LANG: "C",
  };
}

export function getGitNullDevicePath(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

export function normalizeGitPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function normalizeWorkspaceInRepoPath(path: string): string {
  const normalized = normalizeGitPath(path)
    .replace(/^\.?\//, "")
    .replace(/\/+$/, "");
  return normalized.length > 0 ? normalized : ".";
}

export function isPathInWorkspaceScope(
  repoRelativePath: string,
  workspaceInRepoPath: string,
): boolean {
  const normalizedPath = normalizeGitPath(repoRelativePath).replace(/^\.?\//, "");
  const normalizedWorkspace = normalizeWorkspaceInRepoPath(workspaceInRepoPath);
  if (normalizedWorkspace === ".") {
    return true;
  }

  return (
    normalizedPath === normalizedWorkspace || normalizedPath.startsWith(`${normalizedWorkspace}/`)
  );
}

export function toWorkspaceRelativeGitPath(
  repoRelativePath: string,
  workspaceInRepoPath: string,
): string {
  const normalizedPath = normalizeGitPath(repoRelativePath).replace(/^\.?\//, "");
  const normalizedWorkspace = normalizeWorkspaceInRepoPath(workspaceInRepoPath);
  if (normalizedWorkspace === ".") {
    return normalizedPath;
  }

  if (normalizedPath === normalizedWorkspace) {
    return ".";
  }

  return normalizedPath.startsWith(`${normalizedWorkspace}/`)
    ? normalizedPath.slice(normalizedWorkspace.length + 1)
    : normalizedPath;
}

import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { dirname, join, posix, win32 } from "node:path";
import { promisify } from "node:util";
import type { GitContext } from "@zcode/contracts";
import { getWindowsEnvValue, splitWindowsPath } from "../exec/windows-executable.js";

const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 3000;
const DEFAULT_COMMAND_MAX_BUFFER_BYTES = 1024 * 1024;
const GIT_COMMAND = "git";
const GIT_STATUS_NOT_REPO = "not_repo" as const;
const GIT_STATUS_CLEAN = "clean" as const;
const GIT_STATUS_DIRTY = "dirty" as const;
const MAX_RECENT_COMMITS = 5;
const DEFAULT_MAIN_BRANCH_CANDIDATES = ["main", "master"] as const;
const MAX_GIT_STATUS_CONTEXT_CHARS = 2000;
const GIT_DIRECTORY_ENTRY = ".git";

const execFile = promisify(execFileCallback);

interface GitCommandResult {
  // git's own exit code; absent on timeout, cancellation, or failure to spawn.
  code: number | undefined;
  stderr: string;
  stdout: string;
}

interface ExecFileFailure extends Error {
  code?: number | string | null;
}

/**
 * Walk from the directory up to the filesystem root and return the first directory containing
 * `.git` (a directory or a worktree/submodule gitdir file both count). Symlinks are judged by
 * their target; a missing target does not count.
 * Fix rationale: the old git rev-parse check had no answer on timeout, cancellation, or missing
 * git, so callers had to record "not a repository" or re-run git on every request. Being in a
 * repository is a filesystem fact and does not require spawning git.
 */
export async function findGitRoot(directory: string): Promise<string | undefined> {
  for (let current = directory; ; current = dirname(current)) {
    if (await hasGitEntry(current)) return current;
    // Drive-letter, UNC, and POSIX roots are their own dirname.
    if (dirname(current) === current) return undefined;
  }
}

/**
 * Whether inside a repository: search upward from the directory's real path, where git itself runs.
 * Fix rationale: the old code searched from the path at open time (the link's own location). Links
 * pointing into a repository subdirectory were judged "not a repository"; links inside a repository
 * pointing outside were judged as repositories and every git command failed, leaving the model with
 * a fake snapshot assembled from defaults. If the real path cannot be read (e.g. the directory was
 * deleted), fall back to the path at open time.
 */
export async function resolveIsGitRepository(
  workingDirectory: string,
  // Pass the result when the caller already searched from the open-time path; reuse it directly
  // when the real path equals it, skipping the search.
  givenPathGitRoot?: string | null,
): Promise<boolean> {
  const realPath = await realpath(workingDirectory).catch(() => workingDirectory);
  if (givenPathGitRoot !== undefined && realPath === workingDirectory) {
    return givenPathGitRoot !== null;
  }
  return (await findGitRoot(realPath)) !== undefined;
}

export async function resolveGitSnapshot(
  workingDirectory: string,
  signal?: AbortSignal,
  // Pass the conclusion when the caller already searched for `.git`; skip the upward search.
  isGitRepository?: boolean,
): Promise<GitContext> {
  if (!(isGitRepository ?? (await resolveIsGitRepository(workingDirectory)))) {
    return { isGitRepository: false, gitStatus: GIT_STATUS_NOT_REPO };
  }

  // Fix rationale: with serial commands, a repository where git hangs had to wait through 7–9
  // three-second timeouts. The commands are independent; run them in parallel and assemble the
  // results into fixed fields — the bytes are identical to the serial version.
  const [gitBranch, gitMainBranch, gitUser, statusOutput, recentCommitOutput] = await Promise.all([
    resolveGitBranch(workingDirectory, signal),
    resolveMainBranch(workingDirectory, signal),
    resolveGitUser(workingDirectory, signal),
    readGitOutput(
      ["--no-optional-locks", "status", "--short", "--ignore-submodules=dirty"],
      workingDirectory,
      signal,
    ),
    readGitOutput(
      ["--no-optional-locks", "log", "--oneline", "-n", String(MAX_RECENT_COMMITS)],
      workingDirectory,
      signal,
    ),
  ]);
  const gitStatusLines = splitGitStatusForContext(statusOutput.trim());
  const recentCommits = splitNonEmptyLines(recentCommitOutput).slice(0, MAX_RECENT_COMMITS);

  return {
    isGitRepository: true,
    gitBranch,
    gitMainBranch,
    gitUser,
    gitStatus: gitStatusLines.length > 0 ? GIT_STATUS_DIRTY : GIT_STATUS_CLEAN,
    gitStatusLines,
    recentCommits,
  };
}

async function hasGitEntry(directory: string): Promise<boolean> {
  try {
    await stat(join(directory, GIT_DIRECTORY_ENTRY));
    return true;
  } catch {
    return false;
  }
}

async function resolveGitBranch(
  workingDirectory: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  // Fix rationale: with no commits, rev-parse --abbrev-ref HEAD exits 128 and the branch name
  // degrades to HEAD. symbolic-ref only reads the symref and needs no commits; when detached
  // there is no symref, so still fall back to HEAD.
  const branch = await readTrimmedGitOutput(
    ["symbolic-ref", "--short", "-q", "HEAD"],
    workingDirectory,
    signal,
  );
  return branch || "HEAD";
}

async function resolveMainBranch(
  workingDirectory: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const remoteHead = await readTrimmedGitOutput(
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    workingDirectory,
    signal,
  );
  const originHeadBranch = remoteHead?.replace(/^origin\//, "");
  const candidates = originHeadBranch
    ? [originHeadBranch, ...DEFAULT_MAIN_BRANCH_CANDIDATES]
    : [...DEFAULT_MAIN_BRANCH_CANDIDATES];

  for (const candidate of candidates) {
    if (
      await gitCommandSucceeds(
        ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`],
        workingDirectory,
        signal,
      )
    ) {
      return candidate;
    }
  }

  return "main";
}

async function resolveGitUser(
  workingDirectory: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  return readTrimmedGitOutput(["config", "user.name"], workingDirectory, signal);
}

async function gitCommandSucceeds(
  args: string[],
  workingDirectory: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const result = await execGitNoThrow(args, workingDirectory, signal);
  return result.code === 0;
}

async function readTrimmedGitOutput(
  args: string[],
  workingDirectory: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const output = await readGitOutput(args, workingDirectory, signal);
  const trimmed = output?.trim();
  return trimmed ? trimmed : undefined;
}

async function readGitOutput(
  args: string[],
  workingDirectory: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const result = await execGitNoThrow(args, workingDirectory, signal);
  return result.stdout;
}

// Reuse a found git within the process; a miss is not cached, so git installed later is picked up.
let gitExecutable: Promise<string | undefined> | undefined;

function resolveGitExecutable(): Promise<string | undefined> {
  // The lookup cannot fail: the only throwing read of the process directory happens for relative
  // entries, and an unreadable entry is skipped.
  gitExecutable ??= findExecutableOnPath(GIT_COMMAND, process.env).then((found) => {
    if (found === undefined) gitExecutable = undefined;
    return found;
  });
  return gitExecutable;
}

async function execGitNoThrow(
  args: string[],
  workingDirectory: string,
  signal: AbortSignal | undefined,
): Promise<GitCommandResult> {
  const executable = await resolveGitExecutable();
  // git not found is the same as git failing to spawn: no exit code, empty output.
  if (executable === undefined) return { code: undefined, stderr: "", stdout: "" };
  try {
    // Fix rationale: automatic git is not a tool call and skips permission checks. Executing by
    // bare name with a fully inherited environment used to run a git.exe from the workspace on
    // Windows, execute repo-configured fsmonitor and hooks, and an inherited GIT_DIR made the
    // snapshot read a different repository. Now use the absolute path from PATH, with a fixed
    // config override and environment on every command.
    const result = await execFile(executable, automaticGitArgs(args), {
      cwd: workingDirectory,
      encoding: "utf8",
      env: automaticGitEnv(process.env),
      maxBuffer: DEFAULT_COMMAND_MAX_BUFFER_BYTES,
      // git ends immediately when the request is cancelled; no need to wait out the 3s timeout.
      signal,
      timeout: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    return {
      code: 0,
      stderr: outputToString(result.stderr),
      stdout: outputToString(result.stdout),
    };
  } catch (error) {
    const failure = error as ExecFileFailure;
    return {
      code: typeof failure.code === "number" ? failure.code : undefined,
      // Discard stdout/stderr when the command fails so unreliable error output does not enter provider-visible Git context.
      stderr: "",
      stdout: "",
    };
  }
}

// Hardening for automatic git: resolve git to an absolute path from PATH and attach the same
// config overrides and environment to every command.
// Rules live in the Git snapshot section of docs/design/v2/loop/meta-user-context.md.

const GIT_HOOK_NAMES = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-receive",
  "update",
  "proc-receive",
  "post-receive",
  "post-update",
  "reference-transaction",
  "push-to-checkout",
  "pre-auto-gc",
  "post-rewrite",
  "sendemail-validate",
  "fsmonitor-watchman",
  "p4-changelist",
  "p4-prepare-changelist",
  "p4-post-changelist",
  "p4-pre-submit",
  "post-index-change",
] as const;

const GIT_CONTEXT_ENV = {
  GIT_ALLOW_PROTOCOL: "/",
  GIT_CONFIG_PARAMETERS: [
    "'alias.remote-none=version'",
    "'alias.remote-none.command=version'",
    "'alias.remote-/.command=version'",
    "'fetch.bundleURI='",
    "'help.autocorrect=0'",
  ].join(" "),
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_LFS_SKIP_SMUDGE: "1",
  GIT_SSH_COMMAND: "false",
} as const;

// These inherited variables would make git read a different repository or config; strip them
// case-insensitively.
const INHERITED_GIT_ENV = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_SHALLOW_FILE",
  "GIT_NAMESPACE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_REFERENCE_BACKEND",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG",
]);
const INHERITED_GIT_CONFIG_ENTRY = /^GIT_CONFIG_(KEY|VALUE)_\d+$/i;
const POSIX_NULL_DEVICE = "/dev/null";
const WINDOWS_NULL_DEVICE = "\\\\.\\NUL";
// Same as Node spawning by bare name: try .com then .exe in each directory, ignoring PATHEXT;
// .cmd / .bat cannot start without a shell.
const WINDOWS_SPAWNABLE_EXTENSIONS = [".com", ".exe"] as const;

interface AutomaticGitConfig {
  /** `-c` arguments prefixed to the command. */
  args: readonly string[];
  /** GIT_CONFIG_COUNT / KEY / VALUE mirror of the same config set. */
  env: Readonly<Record<string, string>>;
}

// Config overrides depend only on the platform; build once per platform instead of twice per command.
const automaticGitConfigs = new Map<NodeJS.Platform, AutomaticGitConfig>();

function automaticGitConfig(platform: NodeJS.Platform): AutomaticGitConfig {
  const cached = automaticGitConfigs.get(platform);
  if (cached) return cached;
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ["core.fsmonitor", ""],
    ["core.hooksPath", nullDevice(platform)],
    ["core.askPass", ""],
    ["protocol.ext.allow", "never"],
    ["submodule.recurse", "false"],
    ["log.showSignature", "false"],
    ["format.pretty", "medium"],
    ["gc.auto", "0"],
    ["maintenance.auto", "false"],
    ...GIT_HOOK_NAMES.map((hook) => [`hook.${hook}.enabled`, "false"] as const),
  ];
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  const config = { args: pairs.flatMap(([key, value]) => ["-c", `${key}=${value}`]), env };
  automaticGitConfigs.set(platform, config);
  return config;
}

function nullDevice(platform: NodeJS.Platform): string {
  return platform === "win32" ? WINDOWS_NULL_DEVICE : POSIX_NULL_DEVICE;
}

/** Full arguments for an automatic git command: config overrides first, then the command. */
function automaticGitArgs(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  return [...automaticGitConfig(platform).args, ...args];
}

/** Environment for automatic git commands: drop inherited repository/config selection variables,
 *  add fixed safety variables and the config mirror. */
export function automaticGitEnv(
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const mirrored = automaticGitConfig(platform).env;
  const setKeys = new Set([...Object.keys(GIT_CONTEXT_ENV), ...Object.keys(mirrored)]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    const upper = key.toUpperCase();
    // Drop same-name variables with different casing too; on Windows they are the same variable.
    const replaced = setKeys.has(upper) && key !== upper;
    if (INHERITED_GIT_ENV.has(upper) || INHERITED_GIT_CONFIG_ENTRY.test(key) || replaced) continue;
    env[key] = value;
  }
  Object.assign(env, GIT_CONTEXT_ENV, mirrored);
  env.GIT_PROXY_COMMAND = baseEnv.GIT_PROXY_COMMAND ?? "";
  // Variable names are case-insensitive on Windows; elsewhere only handle the variable named PATH.
  for (const key of Object.keys(env)) {
    const isPath = platform === "win32" ? key.toUpperCase() === "PATH" : key === "PATH";
    const value = env[key];
    if (isPath && value !== undefined) env[key] = absolutePathEntries(value, platform);
  }
  return env;
}

/**
 * Keep only absolute PATH entries so git never launches external programs from the working
 * directory; fall back to the null device when none remain.
 * Fix rationale: the old code split on ":" regardless of platform and kept only "/"-prefixed
 * entries. The desktop host starts the Agent with an uppercase PATH on Windows, all Windows
 * entries were dropped, git could not find git-lfs and other external programs, status failed on
 * LFS repositories, and the snapshot showed clean.
 */
function absolutePathEntries(value: string, platform: NodeJS.Platform): string {
  const pathApi = platform === "win32" ? win32 : posix;
  const entries = platform === "win32" ? splitWindowsPath(value) : value.split(posix.delimiter);
  const kept = entries.filter((entry) => isFullPathEntry(entry, platform));
  return kept.length > 0 ? kept.join(pathApi.delimiter) : nullDevice(platform);
}

/** PATH entries that do not depend on the process directory. Windows accepts only drive-letter
 *  or UNC prefixes; `\dir` resolves against the current drive and its root is a single character. */
function isFullPathEntry(entry: string, platform: NodeJS.Platform): boolean {
  return platform === "win32"
    ? win32.isAbsolute(entry) && win32.parse(entry).root.length > 1
    : posix.isAbsolute(entry);
}

export interface ExecutableLookupOptions {
  /** Base directory for relative PATH entries; defaults to the process directory. */
  cwd?: string;
  platform?: NodeJS.Platform;
  isExecutableFile?: (path: string) => Promise<boolean>;
}

/**
 * Find an executable on PATH and return its absolute path; undefined when not found.
 * Fix rationale: with a bare name, execFile searches cwd first on Windows (libuv search_path),
 * so a git.exe dropped in the workspace would be run by automatic git. Only PATH entries are
 * searched here; the working directory is not added.
 */
export async function findExecutableOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  options: ExecutableLookupOptions = {},
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : posix;
  const isExecutableFile = options.isExecutableFile ?? defaultIsExecutableFile(platform);
  const directories =
    platform === "win32"
      ? splitWindowsPath(getWindowsEnvValue(env, "PATH") ?? "")
      : (env.PATH ?? "").split(posix.delimiter).filter((entry) => entry.length > 0);
  const fileNames =
    platform === "win32"
      ? WINDOWS_SPAWNABLE_EXTENSIONS.map((extension) => name + extension)
      : [name];
  for (const directory of directories) {
    // Fix rationale: the old code read the process directory before searching, and process.cwd()
    // throws when that directory is deleted, hiding even a git at an absolute PATH location. Now
    // only relative entries read the process directory; an unreadable entry is skipped.
    const base = isFullPathEntry(directory, platform)
      ? directory
      : resolveRelativeEntry(directory, options.cwd, pathApi);
    if (base === undefined) continue;
    for (const fileName of fileNames) {
      const candidate = pathApi.join(base, fileName);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function resolveRelativeEntry(
  entry: string,
  cwd: string | undefined,
  pathApi: typeof posix,
): string | undefined {
  try {
    return pathApi.resolve(cwd ?? process.cwd(), entry);
  } catch {
    return undefined;
  }
}

function defaultIsExecutableFile(platform: NodeJS.Platform): (path: string) => Promise<boolean> {
  return async (path) => {
    try {
      if (!(await stat(path)).isFile()) return false;
      if (platform !== "win32") await access(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
}

function outputToString(output: Buffer | string | undefined): string {
  if (typeof output === "string") {
    return output;
  }
  return output?.toString("utf8") ?? "";
}

function splitGitStatusForContext(status: string): string[] {
  if (status.length === 0) {
    return [];
  }

  const boundedStatus =
    status.length > MAX_GIT_STATUS_CONTEXT_CHARS
      ? `${status.substring(0, MAX_GIT_STATUS_CONTEXT_CHARS)}
... (truncated because it exceeds 2k characters. If you need more information, run "git status" using ${gitStatusToolName()})`
      : status;

  // Match the upstream CLI: truncate git status at 2k characters, not by file count, to avoid changing the shape of the provider-visible prompt.
  return boundedStatus.split(/\r?\n/u).filter((line) => line.length > 0);
}

function gitStatusToolName(): "Bash" | "PowerShell" {
  return process.platform === "win32" ? "PowerShell" : "Bash";
}

function splitNonEmptyLines(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

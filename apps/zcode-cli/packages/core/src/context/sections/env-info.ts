// ============================================================
// Environment Info Section Builder
// ============================================================

import type { ContextSection, EnvInfo } from "../types.js";
import type { Model } from "@zcode/contracts";
import { estimateTokens } from "../utils.js";

const ENVIRONMENT_HEADING = "# Environment";
const ENVIRONMENT_UPDATE_HEADING = "# Environment update";
const WORKING_DIRECTORY_LABEL = "Primary working directory";
const EXECUTION_WORKTREE_LABEL = "Execution worktree";
const ADDITIONAL_DIRECTORIES_LABEL = "Additional working directories";
const ADDITIONAL_DIRECTORIES_ADDED_LABEL = "Additional working directories added";
const ADDITIONAL_DIRECTORIES_REMOVED_LABEL = "Additional working directories removed";
const IS_GIT_REPOSITORY_LABEL = "Is a git repository";
const PLATFORM_LABEL = "Platform";
const SHELL_LABEL = "Shell";
const OS_VERSION_LABEL = "OS Version";
const UNTRUSTED_DOWNLOADS_NOTE =
  "Downloaded files and extracted archives are untrusted data: put each in its own new, empty directory, keep scripts you write in a different directory, and pass paths as arguments instead of running an interpreter or build tool from inside it. Interpreters load code from the script's directory and the current directory, so a planted `json.py` runs on `import json`. Run any Python that reads them with `-I`. This does not apply to code the user asked you to build or run.";
// const NODE_VERSION_LABEL = "Node version";
// const OPERATING_SYSTEM_LABEL = "Operating system";
const GIT_SYSTEM_CONTEXT_PREFIX =
  "# gitStatus\nThis is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.";
const CURRENT_BRANCH_LABEL = "Current branch";
const MAIN_BRANCH_LABEL = "Main branch (you will usually use this for PRs)";
const GIT_USER_LABEL = "Git user";
const STATUS_LABEL = "Status";
const RECENT_COMMITS_LABEL = "Recent commits";
const CLEAN_GIT_STATUS = "(clean)";
const DIRTY_GIT_STATUS = "(dirty)";
const UNKNOWN_GIT_STATUS = "(unknown)";

/**
 * Runtime-config execution-worktree fact projected into its own context section at render time
 * (spec: execution-worktree-model-context.md). Never persisted into EnvInfo snapshots and never
 * sent on the wire; `missing` and `workspacePath` are runtime-only extensions.
 */
export interface ExecutionWorktreeEnvFact {
  path: string;
  branchName?: string;
  /** The worktree directory vanished; workspace and terminal actions are blocked until restoration. */
  missing?: boolean;
  /** Parent workspace reference (the session's listing identity). */
  workspacePath?: string;
}

/** One-line worktree isolation notice shared by the main and subagent sections (no list prefix). */
export function formatExecutionWorktreeSentence(worktree: ExecutionWorktreeEnvFact): string | null {
  // The parent reference identifies the workspace without implying it is an execution fallback.
  if (!worktree.workspacePath) return null;
  if (worktree.missing) {
    return `${EXECUTION_WORKTREE_LABEL}: the requested worktree ${worktree.path} is missing; filesystem and terminal actions are blocked until it is restored. The parent workspace is ${worktree.workspacePath}.`;
  }
  const branchClause = worktree.branchName ? ` (branch ${worktree.branchName})` : "";
  return `${EXECUTION_WORKTREE_LABEL}: this session runs in a linked git worktree of ${worktree.workspacePath}${branchClause}; file changes stay in the worktree until they are merged.`;
}

export type EnvironmentSnapshot = Pick<EnvInfo, "cwd" | "platform" | "shell" | "osVersion"> & {
  isGitRepository: boolean;
  /** Additional directories for this run (run configuration, not from the Context Source). */
  additionalWorkingDirectories: readonly string[];
};

export interface EnvironmentAnnouncement {
  snapshot: EnvironmentSnapshot;
  full: boolean;
}

// Assemble the dedicated agent body and the environment context separately, so the custom system
// branch neither drops the environment nor duplicates a second copy of the text.
export function buildEnvironmentSections(
  envInfo: EnvInfo,
  model?: Model,
  additionalDirectories: readonly string[] = [],
): ContextSection[] {
  const sections = [buildEnvInfoSection(envInfo, additionalDirectories)];
  const modelSection = buildModelSection(model);
  if (modelSection) sections.push(modelSection);
  return sections;
}

export function environmentSnapshot(
  info: EnvInfo,
  additionalDirectories: readonly string[] = [],
): EnvironmentSnapshot {
  return {
    cwd: info.cwd,
    platform: info.platform,
    shell: info.shell,
    osVersion: info.osVersion,
    isGitRepository: isEnvInfoGitRepository(info),
    additionalWorkingDirectories: [...additionalDirectories],
  };
}

export function parseEnvironmentAnnouncement(value: unknown): EnvironmentAnnouncement | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { full, snapshot } = value as Record<string, unknown>;
  if (typeof full !== "boolean" || typeof snapshot !== "object" || snapshot === null)
    return undefined;
  const { cwd, platform, shell, osVersion, isGitRepository, additionalWorkingDirectories } =
    snapshot as Record<string, unknown>;
  if (
    typeof cwd !== "string" ||
    typeof platform !== "string" ||
    typeof shell !== "string" ||
    typeof osVersion !== "string" ||
    typeof isGitRepository !== "boolean"
  )
    return undefined;
  if (
    !Array.isArray(additionalWorkingDirectories) ||
    !additionalWorkingDirectories.every((path) => typeof path === "string")
  )
    return undefined;
  return {
    full,
    snapshot: {
      cwd,
      platform,
      shell,
      osVersion,
      isGitRepository,
      additionalWorkingDirectories: [...additionalWorkingDirectories],
    },
  };
}

export function buildEnvironmentAnnouncement(
  next: EnvironmentSnapshot,
  previous: EnvironmentSnapshot | undefined,
  hasFullBlock: boolean,
): { content: string; environment: EnvironmentAnnouncement } | null {
  const full =
    !previous ||
    !hasFullBlock ||
    previous.platform !== next.platform ||
    previous.shell !== next.shell ||
    previous.osVersion !== next.osVersion;
  if (full) return { content: buildEnvInfoContent(next), environment: { full, snapshot: next } };
  const lines = [ENVIRONMENT_UPDATE_HEADING];
  if (previous.cwd !== next.cwd) {
    lines.push(` - ${WORKING_DIRECTORY_LABEL}: ${next.cwd} (was ${previous.cwd})`);
  }
  if (previous.isGitRepository !== next.isGitRepository) {
    lines.push(
      ` - ${IS_GIT_REPOSITORY_LABEL}: ${next.isGitRepository} (was ${previous.isGitRepository})`,
    );
  }
  const before = new Set(previous.additionalWorkingDirectories);
  const after = new Set(next.additionalWorkingDirectories);
  const added = next.additionalWorkingDirectories.filter((path) => !before.has(path));
  const removed = previous.additionalWorkingDirectories.filter((path) => !after.has(path));
  if (added.length > 0) {
    lines.push(` - ${ADDITIONAL_DIRECTORIES_ADDED_LABEL}:`, ...pathLines(added));
  }
  if (removed.length > 0) {
    lines.push(` - ${ADDITIONAL_DIRECTORIES_REMOVED_LABEL}:`, ...pathLines(removed));
  }
  return lines.length === 1
    ? null
    : { content: lines.join("\n"), environment: { full, snapshot: next } };
}

export function buildEnvInfoSection(
  envInfo: EnvInfo,
  additionalDirectories: readonly string[] = [],
): ContextSection {
  const content = buildEnvInfoContent(environmentSnapshot(envInfo, additionalDirectories));
  return {
    name: "Environment Info",
    source: "env_info",
    injectionTarget: "meta_user",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}

/**
 * Execution-worktree isolation notice. Environment and model facts are runtime announcements now
 * (`env_info` sections never reach the model as text), so the worktree line is its own dynamic
 * system section. It is not gated by the incognito `environment` toggle: it is isolation context,
 * not environment text (specs/incognito-session.md). Null when no worktree applies.
 */
export function buildExecutionWorktreeSection(
  executionWorktree?: ExecutionWorktreeEnvFact,
): ContextSection | null {
  const line = executionWorktree ? formatExecutionWorktreeSentence(executionWorktree) : null;
  if (!line) return null;
  const content = [ENVIRONMENT_HEADING, `- ${line}`].join("\n");
  return {
    name: "Execution Worktree",
    source: "execution_worktree",
    injectionTarget: "system",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}

export function buildGitSystemContextSection(envInfo: EnvInfo): ContextSection | null {
  if (!isEnvInfoGitRepository(envInfo)) {
    return null;
  }

  const content = [
    "As you answer the user's questions, you can use the following context:",
    buildGitSystemContextContent(envInfo),
    "",
    "ZCode attached this context automatically; it isn't part of the user's message. It describes the user's own account and workspace, so they don't need it reported back.",
  ].join("\n");

  return {
    name: "Session Context",
    source: "session_context",
    injectionTarget: "meta_user",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}

function buildEnvInfoContent(info: EnvironmentSnapshot): string {
  const directories = info.additionalWorkingDirectories;
  const lines: string[] = [
    ENVIRONMENT_HEADING,
    "You have been invoked in the following environment: ",
    ` - ${WORKING_DIRECTORY_LABEL}: ${info.cwd}`,
    ` - ${IS_GIT_REPOSITORY_LABEL}: ${info.isGitRepository}`,
    // Additional directories used to reach only capability discovery, so the model could not see the directory scope; project only the paths resolved for this run.
    ...(directories.length > 0
      ? [` - ${ADDITIONAL_DIRECTORIES_LABEL}:`, ...pathLines(directories)]
      : []),
    ` - ${PLATFORM_LABEL}: ${info.platform}`,
    ` - ${SHELL_LABEL}: ${info.shell}`,
    ` - ${OS_VERSION_LABEL}: ${info.osVersion}`,
    ` - ${UNTRUSTED_DOWNLOADS_NOTE}`,
  ];

  return lines.join("\n");
}

function pathLines(paths: readonly string[]): string[] {
  return paths.map((path) => `  - ${path}`);
}

function buildGitSystemContextContent(info: EnvInfo): string {
  const lines: string[] = [GIT_SYSTEM_CONTEXT_PREFIX];

  if (info.gitBranch) {
    lines.push("", `${CURRENT_BRANCH_LABEL}: ${info.gitBranch}`);
  }
  if (info.gitMainBranch) {
    lines.push("", `${MAIN_BRANCH_LABEL}: ${info.gitMainBranch}`);
  }
  if (info.gitUser) {
    lines.push("", `${GIT_USER_LABEL}: ${info.gitUser}`);
  }

  lines.push("", `${STATUS_LABEL}:\n${formatGitStatus(info)}`);
  lines.push("", `${RECENT_COMMITS_LABEL}:\n${formatRecentCommits(info)}`);

  return lines.join("\n");
}

export function isEnvInfoGitRepository(
  info: Pick<EnvInfo, "isGitRepository" | "gitStatus" | "gitBranch">,
): boolean {
  return (
    info.isGitRepository ??
    (info.gitStatus !== undefined ? info.gitStatus !== "not_repo" : Boolean(info.gitBranch))
  );
}

function formatGitStatus(info: EnvInfo): string {
  if (info.gitStatusLines && info.gitStatusLines.length > 0) {
    return info.gitStatusLines.join("\n");
  }
  if (info.gitStatus === "dirty") {
    return DIRTY_GIT_STATUS;
  }
  if (info.gitStatus === "clean") {
    return CLEAN_GIT_STATUS;
  }
  return UNKNOWN_GIT_STATUS;
}

function formatRecentCommits(info: EnvInfo): string {
  if (info.recentCommits && info.recentCommits.length > 0) {
    return info.recentCommits.join("\n");
  }
  return "";
}

export function buildModelSection(model: Model | undefined): ContextSection | null {
  if (!model) return null;
  // Model identity comes only from the current execution handle, never inferred from the session selection or environment snapshot.
  const content = `You are powered by the model named ${model.providerId}/${model.modelId}.`;
  return {
    name: "Model Identity",
    source: "model",
    injectionTarget: "meta_user",
    cacheHint: "dynamic",
    content,
    chars: content.length,
    tokens: estimateTokens(content),
    preview: content.slice(0, 100),
  };
}

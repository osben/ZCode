// ============================================================
// Environment Info Section Builder
// ============================================================

import type { ContextSection, EnvInfo } from "../types.js";
import { WINDOWS_CMD_SHELL_DISPLAY_NAME, type Model } from "@zcode/contracts";
import { estimateTokens } from "../utils.js";
import { buildDesktopContextContent } from "./desktop.js";

const ENVIRONMENT_HEADING = "# Environment";
const ENVIRONMENT_UPDATE_HEADING = "# Environment update";
// 修复原因：Windows 上 Bash 工具实际由 cmd.exe 执行，但工具名与描述都说 bash，模型照 bash 写命令
// （冻结重放 36–42% 的下一步用了 cmd 不认的 Unix 命令）。Shell 为 cmd.exe 时把这段放进 Shell 行括号，
// 完整块与换入 cmd.exe 的 update 都是。实验验证的是中文原文放在标题前（降到 1.3%，保留集 0.3%）；
// 英文译文与放进括号都是产品决定，未经实验；改字需重新验证。
const CMD_SHELL_RULE =
  "Bash tool commands are parsed by cmd.exe. Do not use Unix commands such as ls, cat, head, tail, grep, or wc; prefer the dedicated file tools for listing directories and reading files, and use dir, type, or findstr when you need a shell command.";
const WORKING_DIRECTORY_LABEL = "Primary working directory";
const EXECUTION_WORKTREE_LABEL = "Execution worktree";
const ADDITIONAL_DIRECTORIES_LABEL = "Additional working directories";
const ADDITIONAL_DIRECTORIES_ADDED_LABEL = "Additional working directories added";
const ADDITIONAL_DIRECTORIES_REMOVED_LABEL = "Additional working directories removed";
const VISUALIZATION_DIRECTORY_LABEL = "Visualization directory for this session";
const IS_GIT_REPOSITORY_LABEL = "Is a git repository";
const PLATFORM_LABEL = "Platform";
const SHELL_LABEL = "Shell";
const OS_VERSION_LABEL = "OS Version";
const DESKTOP_CONTEXT_NO_LONGER_APPLIES =
  "The ZCode Desktop Context above no longer applies: this session is not shown in ZCode Desktop.";
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
  /** 会话的 Gen UI 输出目录；只在 Desktop 段声明支持 Gen UI 时有。旧元数据没有这个字段。 */
  visualizationDirectory?: string;
  /** 本次运行在 ZCode Desktop 呈现面时为 true，环境块带 Desktop 段。旧元数据没有这个字段，算不在。 */
  desktopContext?: boolean;
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
  const {
    cwd,
    platform,
    shell,
    osVersion,
    isGitRepository,
    additionalWorkingDirectories,
    visualizationDirectory,
    desktopContext,
  } = snapshot as Record<string, unknown>;
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
  if (visualizationDirectory !== undefined && typeof visualizationDirectory !== "string")
    return undefined;
  if (desktopContext !== undefined && typeof desktopContext !== "boolean") return undefined;
  return {
    full,
    snapshot: {
      cwd,
      platform,
      shell,
      osVersion,
      isGitRepository,
      additionalWorkingDirectories: [...additionalWorkingDirectories],
      ...(visualizationDirectory === undefined ? {} : { visualizationDirectory }),
      ...(desktopContext === undefined ? {} : { desktopContext }),
    },
  };
}

export function buildEnvironmentAnnouncement(
  next: EnvironmentSnapshot,
  previous: EnvironmentSnapshot | undefined,
  hasFullBlock: boolean,
): { content: string; environment: EnvironmentAnnouncement } | null {
  // shell 跟随最新设置，新 runtime（冷恢复）可能读到另一个 shell；与目录一样只追加变化行，不整块重发。
  const full =
    !previous ||
    !hasFullBlock ||
    previous.platform !== next.platform ||
    previous.osVersion !== next.osVersion;
  if (full) {
    // 修复原因：重发完整块（系统版本变化、compact 后没有完整块）时原来不看上一次的 shell，从 cmd.exe
    // 换走的会话只看到新 Shell，历史里的 CMD 规则像仍然有效。离开 cmd.exe 时 Shell 行带上 was。
    const leftCmd =
      previous?.shell === WINDOWS_CMD_SHELL_DISPLAY_NAME &&
      next.shell !== WINDOWS_CMD_SHELL_DISPLAY_NAME;
    return {
      content: buildEnvInfoContent(next, leftCmd ? previous.shell : undefined),
      environment: { full, snapshot: next },
    };
  }
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
  if (previous.visualizationDirectory !== next.visualizationDirectory) {
    const was = previous.visualizationDirectory ? ` (was ${previous.visualizationDirectory})` : "";
    lines.push(
      ` - ${VISUALIZATION_DIRECTORY_LABEL}: ${next.visualizationDirectory ?? "none"}${was}`,
    );
  }
  if (previous.shell !== next.shell) {
    // 旧 Windows 会话的 Shell 可能为空，没有可写的旧值。
    lines.push(shellLine(next.shell, previous.shell));
  }
  const parts = lines.length === 1 ? [] : [lines.join("\n")];
  // Desktop 段按写法比较：换了写法追加整段新写法，离开 Desktop 追加一句不再适用。
  const previousDesktop = desktopContextText(previous);
  const nextDesktop = desktopContextText(next);
  if (previousDesktop !== nextDesktop) parts.push(nextDesktop ?? DESKTOP_CONTEXT_NO_LONGER_APPLIES);
  return parts.length === 0
    ? null
    : { content: parts.join("\n\n"), environment: { full, snapshot: next } };
}

/** 环境块里的 Desktop 段：不在 Desktop 时没有；在 Desktop 时按是否有 Gen UI 目录取写法。 */
function desktopContextText(snapshot: EnvironmentSnapshot): string | undefined {
  return snapshot.desktopContext
    ? buildDesktopContextContent(Boolean(snapshot.visualizationDirectory))
    : undefined;
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

function buildEnvInfoContent(info: EnvironmentSnapshot, previousShell?: string): string {
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
    ...(info.visualizationDirectory
      ? [` - ${VISUALIZATION_DIRECTORY_LABEL}: ${info.visualizationDirectory}`]
      : []),
    ` - ${PLATFORM_LABEL}: ${info.platform}`,
    shellLine(info.shell, previousShell),
    ` - ${OS_VERSION_LABEL}: ${info.osVersion}`,
    ` - ${UNTRUSTED_DOWNLOADS_NOTE}`,
  ];
  const desktop = desktopContextText(info);
  return desktop ? `${lines.join("\n")}\n\n${desktop}` : lines.join("\n");
}

/** Shell 行：括号里依次放 was 旧值与 CMD 规则，两者都没有时不带括号。 */
function shellLine(shell: string, previousShell?: string): string {
  const notes = [
    ...(previousShell ? [`was ${previousShell}`] : []),
    ...(shell === WINDOWS_CMD_SHELL_DISPLAY_NAME ? [CMD_SHELL_RULE] : []),
  ];
  return ` - ${SHELL_LABEL}: ${shell}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
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

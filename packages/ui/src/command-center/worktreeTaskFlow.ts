/**
 * Pure helpers for the Command Center "New task in worktree" flow
 * (project page → setup page → Start; see
 * docs/superpowers/specs/2026-10-11-command-center-worktrees-themes-design.md).
 *
 * 保持为纯函数模块：项目列表合并、目标目录计算、分支名校验与错误码映射、
 * 表单派生值（deriveWorktreeFormValues）都不依赖 React 或服务，可被 setup 页面、
 * empty-state 勾选（评审建议 6c）与后续阶段复用；调用 gitService 的创建编排
 * 在 worktreeCreation.ts。
 */
import type {
  GitWorktreeEntry,
  GitWorktreeMutationIssueCode,
  WorktreeLocationMode,
  WorktreeProjectOverrideSettings,
} from "@zcode/shared";
import {
  getContainingDirectoryPath,
  getPathLeaf,
  isAbsoluteFilePath,
  joinFilePath,
} from "@/lib/path.js";

export const NEW_TASK_WORKTREE_COMMAND_ID = "new-task-worktree";
export const NEW_TASK_PROJECT_PAGE_ID = "new-task-project";
export const NEW_TASK_SETUP_PAGE_ID = "new-task-setup";

/** Destination of a new task: a fresh worktree or the project's existing checkout. */
export type WorktreeTaskDestination = "worktree" | "checkout";

/** Workspace identity rule of the repo: `workspaceIdentity?.trim() || workspacePath`. */
export function getWorkspaceIdentityKey(workspace: {
  workspaceIdentity?: string;
  workspacePath: string;
}): string {
  return workspace.workspaceIdentity?.trim() || workspace.workspacePath;
}

/** One selectable project row of the `new-task-project` page. */
export interface WorktreeTaskProject {
  workspacePath: string;
  workspaceIdentity?: string;
  /** Tab label for open workspaces; recent projects have none and fall back to the path leaf. */
  label?: string;
  /** True when the workspace already has a tab; renders the “already open” badge. */
  isOpen: boolean;
  /** True for the currently active workspace. */
  isActive: boolean;
}

/** Minimal tab shape consumed from the tab store; remote/conversation tabs are excluded. */
export interface WorktreeTaskProjectTab {
  workspacePath: string;
  workspaceIdentity?: string;
  label?: string;
  remoteSessionId?: string;
  remoteTarget?: unknown;
  workspacePurpose?: string;
}

/**
 * Build the project list for the project page: open local workspace tabs first
 * (dedup by the repo identity rule), then `recentProjects` that are not already open.
 * Remote and conversation-purpose tabs are excluded: the worktree flow only targets
 * local folders whose Git runs on the local Host.
 */
export function buildWorktreeTaskProjects({
  tabs,
  recentProjects,
  activeWorkspaceKey,
}: {
  tabs: readonly WorktreeTaskProjectTab[];
  recentProjects: readonly string[];
  /** Identity key of the currently active workspace; its row gets the active mark. */
  activeWorkspaceKey: string;
}): WorktreeTaskProject[] {
  const openByKey = new Map<string, WorktreeTaskProject>();
  const openPaths = new Set<string>();
  for (const tab of tabs) {
    if (tab.remoteSessionId || tab.remoteTarget) {
      continue;
    }
    if (tab.workspacePurpose === "conversation") {
      continue;
    }

    const key = getWorkspaceIdentityKey(tab);
    if (!openByKey.has(key)) {
      openByKey.set(key, {
        workspacePath: tab.workspacePath,
        ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
        ...(tab.label ? { label: tab.label } : {}),
        isOpen: true,
        isActive: key === activeWorkspaceKey,
      });
    }

    openPaths.add(tab.workspacePath);
  }

  const projects: WorktreeTaskProject[] = [...openByKey.values()];
  for (const path of recentProjects) {
    const trimmedPath = path.trim();
    if (!trimmedPath) {
      continue;
    }

    // recentProjects 只有路径：除 identity 规则外还要按路径判重，
    // 否则带 identity 的已打开 tab 会与 recent 记录重复出现。
    if (openPaths.has(trimmedPath) || openByKey.has(trimmedPath)) {
      continue;
    }

    projects.push({
      workspacePath: trimmedPath,
      isOpen: false,
      isActive: trimmedPath === activeWorkspaceKey,
    });
  }

  return projects;
}

/** Branch names may contain `/`; the worktree directory segment flattens them to one level. */
export function sanitizeWorktreePathSegment(branchName: string): string {
  return branchName
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Append the sanitized branch segment to its containing directory; an empty segment
 * (no branch typed yet) keeps the container itself so previews still show a usable path.
 */
function appendWorktreeSegment(containerPath: string, segment: string): string {
  return segment ? joinFilePath(containerPath, segment) : containerPath;
}

/**
 * Compute the target worktree directory for the effective location (Stage D, WTS-01; Stage F):
 * - sibling (default): `<projectParent>/<repoName>-worktrees/<sanitized branch name>`;
 * - inside: `<repoRoot>/.worktrees/<sanitized branch name>`;
 * - global: `<appWorktreesDir>/<repoName>/<sanitized branch name>` (app-managed `~/.zcode/worktrees`);
 * - custom: `<customPath>/<repoName>-<sanitized branch name>`.
 * An empty/unusable branch segment returns the containing directory (preview use);
 * null means the inputs have no usable project/repo name, the custom location is not an
 * absolute non-empty path, or the global mode has no app worktrees directory (non-desktop).
 * Start validation requires a non-empty branch name separately.
 */
export function computeWorktreeTargetPath(
  projectPath: string,
  branchName: string,
  location?: Pick<EffectiveWorktreeLocation, "mode" | "customPath" | "appWorktreesDir"> | null,
): string | null {
  const segment = sanitizeWorktreePathSegment(branchName);
  const mode: WorktreeLocationMode = location?.mode ?? "sibling";

  if (mode === "custom") {
    const customPath = location?.customPath?.trim() ?? "";
    if (!isValidCustomWorktreeLocationPath(customPath)) {
      return null;
    }
    const repoName = getPathLeaf(projectPath);
    if (!repoName) {
      return null;
    }
    // Unlike the other modes, the custom container nests under the repo name even without a branch.
    return segment
      ? joinFilePath(customPath, `${repoName}-${segment}`)
      : joinFilePath(customPath, repoName);
  }

  if (mode === "global") {
    // Stage F：全局存储目录由平台提供（desktop-only）；缺失时与无效 custom 位置同语义（null → 阻塞 Start）。
    const appWorktreesDir = location?.appWorktreesDir?.trim() ?? "";
    if (!appWorktreesDir) {
      return null;
    }
    const repoName = getPathLeaf(projectPath);
    if (!repoName) {
      return null;
    }
    return appendWorktreeSegment(joinFilePath(appWorktreesDir, repoName), segment);
  }

  if (mode === "inside") {
    const repoRoot = projectPath.trim();
    if (!repoRoot) {
      return null;
    }
    return appendWorktreeSegment(joinFilePath(repoRoot, ".worktrees"), segment);
  }

  const parentPath = getContainingDirectoryPath(projectPath);
  const repoName = getPathLeaf(projectPath);
  if (!parentPath || !repoName) {
    return null;
  }

  return appendWorktreeSegment(joinFilePath(parentPath, `${repoName}-worktrees`), segment);
}

/** Literal display alias of the app-managed worktrees directory (Stage F). */
const APP_WORKTREES_DIR_DISPLAY_PATH = "~/.zcode/worktrees";

/**
 * Replace the `appWorktreesDir` prefix with the literal `~/.zcode/worktrees` for display only
 * (setup/empty-state previews); paths outside the directory are returned unchanged.
 * Creation requests always use the absolute path — this helper never feeds into them.
 */
export function tildifyAppWorktreesPath(absolutePath: string, appWorktreesDir: string): string {
  const trimmedDir = appWorktreesDir.trim().replace(/[\\/]+$/, "");
  if (
    !trimmedDir ||
    (absolutePath !== trimmedDir &&
      !absolutePath.startsWith(`${trimmedDir}/`) &&
      !absolutePath.startsWith(`${trimmedDir}\\`))
  ) {
    return absolutePath;
  }
  return `${APP_WORKTREES_DIR_DISPLAY_PATH}${absolutePath.slice(trimmedDir.length)}`;
}

/** Effective worktree defaults for one project after applying the project override (Stage D). */
export interface EffectiveWorktreeLocation {
  mode: WorktreeLocationMode;
  /** Absolute custom directory; null unless mode is "custom" with a non-empty path (absolute check via isValidCustomWorktreeLocationPath). */
  customPath: string | null;
  /**
   * App-managed worktree directory for the "global" mode (`~/.zcode/worktrees`, desktop-only via
   * IPlatformService.getAppWorktreesDir). Null when unavailable; the global mode then behaves as
   * an invalid location (Start/send blocked), like a bad custom path.
   */
  appWorktreesDir: string | null;
  /** Effective branch prefix: the project override wins over the global template (WTS-02). */
  prefix: string;
  /** Project-level default base branch; null when the project inherits the repository default. */
  baseBranchDefault: string | null;
  /** True when the project entry sets at least one field (drives the Reset-to-global affordance). */
  hasProjectOverride: boolean;
}

/** WTS-01: the custom worktree location must be a non-empty absolute path. */
export function isValidCustomWorktreeLocationPath(path: string | null | undefined): boolean {
  const trimmedPath = path?.trim() ?? "";
  return trimmedPath.length > 0 && isAbsoluteFilePath(trimmedPath);
}

/**
 * Resolve the effective worktree location for `workspacePath`: global defaults from
 * `settings` plus the per-project override entry from `overrides` (keyed by workspacePath).
 * Location mode is global-only (the spec's project-override table covers base branch and
 * prefix); a missing entry or field inherits the global value, and "Reset to global" is
 * deleting the entry, which is exactly what a missing entry resolves to (WTS-02).
 * `appWorktreesDir` (Stage F) is passed through for the "global" mode; callers fetch it lazily
 * from the platform only when that mode is effective and cache it in component state.
 */
export function resolveWorktreeLocation(
  settings:
    | {
        worktreeLocationMode?: WorktreeLocationMode;
        worktreeCustomLocationPath?: string;
        worktreeBranchPrefix?: string;
      }
    | null
    | undefined,
  overrides: Record<string, WorktreeProjectOverrideSettings> | null | undefined,
  workspacePath: string,
  appWorktreesDir?: string | null,
): EffectiveWorktreeLocation {
  const mode: WorktreeLocationMode = settings?.worktreeLocationMode ?? "sibling";
  const customPath = settings?.worktreeCustomLocationPath?.trim() ?? "";
  const override = overrides?.[workspacePath];
  const overridePrefix = override?.branchPrefix?.trim() ?? "";
  const overrideBaseBranch = override?.defaultBaseBranch?.trim() ?? "";
  const globalPrefix = settings?.worktreeBranchPrefix?.trim() ?? "";
  const effectiveAppWorktreesDir = appWorktreesDir?.trim() ?? "";

  return {
    mode,
    customPath: mode === "custom" && customPath ? customPath : null,
    appWorktreesDir: effectiveAppWorktreesDir || null,
    prefix: overridePrefix || globalPrefix,
    baseBranchDefault: overrideBaseBranch || null,
    hasProjectOverride: Boolean(overridePrefix || overrideBaseBranch),
  };
}

/**
 * Compose the final branch name: the prefix template is literal in the MVP and is applied
 * only when the typed name does not already start with it (idempotent for live preview).
 * An empty typed name stays empty so emptiness validation keeps working.
 */
export function composeBranchName(
  prefix: string | null | undefined,
  typedBranchName: string,
): string {
  const name = typedBranchName.trim();
  if (!name) {
    return "";
  }
  const effectivePrefix = prefix?.trim() ?? "";
  return name.startsWith(effectivePrefix) ? name : `${effectivePrefix}${name}`;
}

export type WorktreeBranchNameIssueCode = "invalid-branch-name" | "branch-already-exists";

// git check-ref-format 基础规则的客户端子集；权威校验仍在服务端（GitWorktreeMutationIssue）。
const BRANCH_NAME_FORBIDDEN_CHARS_RE = /[\s~^:?*[\]\\]/;

// 用码位判断而不是控制字符正则（no-control-regex）：ASCII C0 + DEL 都不允许出现在 refname。
function hasAsciiControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Client-side pre-validation of the new branch name. Mirrors the basics of
 * `git check-ref-format` and checks existence against the local branch list
 * (a Set when the caller loads many branches); the service remains authoritative
 * and its codes are mapped inline by the setup page.
 */
export function validateNewWorktreeBranchName(
  branchName: string,
  existingBranches: ReadonlySet<string> | readonly string[],
): WorktreeBranchNameIssueCode | null {
  const name = branchName.trim();
  if (!name || name.startsWith("-") || name.startsWith(".") || name.endsWith("/")) {
    return "invalid-branch-name";
  }
  if (BRANCH_NAME_FORBIDDEN_CHARS_RE.test(name) || hasAsciiControlCharacter(name)) {
    return "invalid-branch-name";
  }
  if (name.includes("..") || name.includes("//") || name.endsWith(".") || name.endsWith(".lock")) {
    return "invalid-branch-name";
  }
  if (name.split("/").some((component) => component.startsWith(".") || !component)) {
    return "invalid-branch-name";
  }
  // `"has" in` narrows the union (Array.isArray cannot exclude readonly arrays in the false branch).
  const branchExists =
    "has" in existingBranches ? existingBranches.has(name) : existingBranches.includes(name);
  if (branchExists) {
    return "branch-already-exists";
  }

  return null;
}

/**
 * Default base branch: the project override's defaultBaseBranch when it is present in the
 * loaded branch list (Stage D), else the repository's current branch, else the first listed branch.
 */
export function resolveDefaultBaseBranch(
  branchesResult: {
    headRefType: "branch" | "detached";
    currentBranchName: string | null;
    branches: readonly { name: string }[];
  },
  preferredDefaultBranch?: string | null,
): string {
  const preferred = preferredDefaultBranch?.trim();
  if (preferred && branchesResult.branches.some((branch) => branch.name === preferred)) {
    return preferred;
  }
  if (branchesResult.headRefType === "branch" && branchesResult.currentBranchName) {
    return branchesResult.currentBranchName;
  }
  return branchesResult.branches[0]?.name ?? "";
}

/** Find the worktree already checked out at `branchName`; used by the target-path-exists recovery (WT-04). */
export function findWorktreeForBranch(
  worktrees: readonly GitWorktreeEntry[],
  branchName: string,
): GitWorktreeEntry | null {
  return worktrees.find((entry) => entry.branchName === branchName) ?? null;
}

/**
 * Derived form values shared by both creation entries — the palette setup page and the
 * empty-state "New worktree" toggle (review 6c): base-branch resolution, prefix composition,
 * client-side branch-name validation, location validity, and the target-path previews
 * (display variant tildifies the app-managed directory). Pure; call inside useMemo.
 */
export function deriveWorktreeFormValues({
  projectPath,
  branchName,
  selectedBaseBranch,
  branchesResult,
  effectiveLocation,
  isWorktreeDestination,
}: {
  /** Project the worktree will be created in; null before a project is chosen (no target preview). */
  projectPath: string | null;
  /** Raw typed branch name; prefix composition and validation run on the composed value. */
  branchName: string;
  /** Manually chosen base branch; null/undefined falls back to the repository default resolution. */
  selectedBaseBranch?: string | null;
  /** Loaded local branch list; null while loading (the palette keeps `null` distinct from empty). */
  branchesResult: {
    headRefType: "branch" | "detached";
    currentBranchName: string | null;
    branches: readonly { name: string }[];
  } | null;
  /** Effective location: global settings + project override + the app worktrees directory. */
  effectiveLocation: EffectiveWorktreeLocation | null;
  /** Whether the form targets a new worktree (the palette also offers "Current checkout"). */
  isWorktreeDestination: boolean;
}): {
  effectiveBaseBranch: string;
  trimmedBranchName: string;
  composedBranchName: string;
  branchNameIssue: WorktreeBranchNameIssueCode | null;
  customLocationInvalid: boolean;
  globalLocationUnavailable: boolean;
  targetPathPreview: string | null;
  /** Display-only variant: the global mode shows the `~/.zcode/worktrees` prefix; creation uses the absolute path. */
  targetPathPreviewDisplay: string | null;
} {
  const effectiveBaseBranch =
    selectedBaseBranch ??
    (branchesResult
      ? resolveDefaultBaseBranch(branchesResult, effectiveLocation?.baseBranchDefault)
      : "");
  // The prefix composes the final branch name; validation and Start use the composed value (WTS-02).
  const trimmedBranchName = branchName.trim();
  const composedBranchName = composeBranchName(effectiveLocation?.prefix, trimmedBranchName);
  const branchNameSet = new Set(branchesResult?.branches.map((branch) => branch.name) ?? []);
  const branchNameIssue =
    isWorktreeDestination && trimmedBranchName.length > 0
      ? validateNewWorktreeBranchName(composedBranchName, branchNameSet)
      : null;
  const customLocationInvalid =
    isWorktreeDestination &&
    effectiveLocation?.mode === "custom" &&
    !isValidCustomWorktreeLocationPath(effectiveLocation?.customPath);
  // Stage F：global 模式但平台目录不可用（非 desktop / IPC 失败）与无效 custom 位置同语义。
  const globalLocationUnavailable =
    isWorktreeDestination &&
    effectiveLocation?.mode === "global" &&
    !effectiveLocation?.appWorktreesDir;
  const targetPathPreview = projectPath
    ? computeWorktreeTargetPath(projectPath, composedBranchName, effectiveLocation)
    : null;
  const targetPathPreviewDisplay =
    effectiveLocation?.mode === "global" && effectiveLocation.appWorktreesDir && targetPathPreview
      ? tildifyAppWorktreesPath(targetPathPreview, effectiveLocation.appWorktreesDir)
      : targetPathPreview;

  return {
    effectiveBaseBranch,
    trimmedBranchName,
    composedBranchName,
    branchNameIssue,
    customLocationInvalid,
    globalLocationUnavailable,
    targetPathPreview,
    targetPathPreviewDisplay,
  };
}

/** Issue codes with a dedicated `commandCenter.worktree.error.<code>` message; the rest fall back to `.unknown`. */
const WORKTREE_ISSUE_MESSAGE_CODE_SET = new Set<GitWorktreeMutationIssueCode>([
  "invalid-branch-name",
  "branch-already-exists",
  "target-branch-not-found",
  "branch-in-other-worktree",
  "target-path-invalid",
  "target-path-exists",
  "not-a-repository",
  "git-unavailable",
]);

/** i18n message ids for GitWorktreeMutationIssueCode; unmapped codes fall back to `.unknown`. */
export function resolveWorktreeIssueMessageId(code: GitWorktreeMutationIssueCode): string {
  if (WORKTREE_ISSUE_MESSAGE_CODE_SET.has(code)) {
    return `commandCenter.worktree.error.${code}`;
  }
  return "commandCenter.worktree.error.unknown";
}

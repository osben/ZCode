import { open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import ignoreFactory from "ignore";
import type { Ignore } from "ignore";
import type { ServiceLogger } from "../logger/serviceLogger.js";

/**
 * Single source of truth for ignoring files in workspace search.
 *
 * `.zcodeignore` (at the workspace root, using gitignore syntax) is the only rules file for search indexing:
 * automatic creation is temporarily disabled: when the file does not exist, only the root `.gitignore` plus default exclusion rules are used in memory;
 * subsequent `.gitignore` changes do not affect search. Users edit it in Settings or choose "Sync from .gitignore."
 *
 * Delegate rule parsing to the `ignore` npm package (reference implementation of gitignore spec 2.22, also used by ESLint):
 * later rules override earlier ones, `!` negates (including Git's constraint that child files cannot be restored after excluding a parent directory), anchored/basename rules,
 * cross-level `**`, directory suffix `/`, character classes, and escaping. Do not implement gitignore parsing by hand in this repository.
 */

export const WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME = ".zcodeignore";
const GITIGNORE_FILE_NAME = ".gitignore";

type WorkspaceFileIgnoreLogger = Pick<ServiceLogger, "info" | "warn">;

export type WorkspaceFileSearchIgnoreRulesSource =
  | "file"
  | "template"
  | "created-from-gitignore"
  | "created-from-template"
  | "fallback-gitignore"
  | "fallback-builtin";

export interface WorkspaceFileSearchIgnoreRules {
  matcher: Ignore;
  source: WorkspaceFileSearchIgnoreRulesSource;
}

export interface WorkspaceFileSearchIgnoreContent {
  content: string;
  /** file: .zcodeignore already exists; template: it has not been created yet, and content previews what will be written when saved. */
  source: "file" | "template";
}

/**
 * Built-in exclusion rules in the default template: preserve the retired portion of the old defaultWorkspaceFileSearchFilter directory blacklist,
 * so a workspace created from scratch behaves like the old default (node_modules/.git, etc. are still pruned).
 * Prefix wildcards use gitignore syntax (such as cmake-build-*), equivalent to the old SKIPPED_DIRECTORY_PREFIXES.
 */
const BUILTIN_IGNORE_LINES = [
  ".git/",
  ".hg/",
  ".svn/",
  "node_modules/",
  "bower_components/",
  "jspm_packages/",
  "__pycache__/",
  "site-packages/",
  "venv/",
  "coverage/",
  "htmlcov/",
  "lcov-report/",
  "cmakefiles/",
  "cmake-build-*/",
  "bazel-*/",
  "pods/",
  "deriveddata/",
  "storybook-static/",
  "playwright-report/",
  "test-results/",
  "allure-results/",
  "allure-report/",
  "cdk.out/",
  "*.egg-info/",
  "*.dist-info/",
  "eggs/",
  "pip-wheel-metadata/",
  "wheels/",
];

const TEMPLATE_HEADER = [
  "# ZCode 工作区文件搜索忽略规则（.zcodeignore）",
  "# 语法与 .gitignore 一致，只影响 ZCode 的 @ 文件候选 / Command Center / 文件树搜索，",
  "# 不影响文件树浏览、上传或 Agent 文件访问。",
  "# 修改 .gitignore 不会自动同步到本文件；可在设置页「从 .gitignore 同步」。",
  "",
];

/**
 * Section markers (matched exactly by line; deleting a marker makes the corresponding button fall back to rebuilding the whole file):
 * "Sync from .gitignore" rewrites only the content above the SYNC marker;
 * "Restore default rules" rewrites only the default-exclusion section between the two markers;
 * The custom-rule section below the DEFAULTS marker; no button modifies it.
 */
export const WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER =
  "# ===== ↑ 以上同步自 .gitignore（「从 .gitignore 同步」只重写以上部分）=====";
export const WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER =
  "# ----- ↑ 以上为 ZCode 默认排除规则（自定义规则请写在本行下方，不会被同步/恢复改动）-----";

const CUSTOM_SECTION_HINT = "# 自定义规则写在下方（本行提示可删除）";

function buildBuiltinDefaultsSection(gitignoreContent: string | null): string {
  // Deduplicate when creating/restoring defaults: do not repeat a rule from the gitignore section in the default section,
  // so each rule appears at most once in the file—deleting it fully re-enables it, without the confusing case of
  // "removing node_modules/ from defaults while it remains hidden in the copied gitignore section".
  // Deduplication is conservative: lines match after trimming, or when they differ only by one trailing '/' (node_modules covers node_modules/);
  // differences such as anchored (/node_modules/) rules are not considered duplicates, preferring a duplicate over missing a rule.
  if (gitignoreContent === null) {
    return BUILTIN_IGNORE_LINES.join("\n");
  }
  const declared = new Set<string>();
  for (const rawLine of gitignoreContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) {
      continue;
    }
    declared.add(line);
    declared.add(line.replace(/\/$/, ""));
  }
  const deduped = BUILTIN_IGNORE_LINES.filter((line) => {
    const bare = line.replace(/\/$/, "");
    return !declared.has(line) && !declared.has(bare);
  });
  return deduped.join("\n");
}

/**
 * Build the initial `.zcodeignore` contents: a copy of .gitignore rules plus two marked sections (default exclusions / custom rules).
 * Adding the default section is required for behavioral compatibility: if a repository has no node_modules entries in .gitignore and we copy it exactly,
 * dependency directories are scanned in full (reintroducing the whole-repository scanning performance issue). The default section is part of the file
 * for users to edit; removing a rule re-enables it, preserving the promise of "one source of truth, no code-level union".
 * Deduplicate rules against the gitignore section before writing defaults (see buildBuiltinDefaultsSection).
 */
export function buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent: string | null): string {
  const gitignoreSection =
    gitignoreContent !== null && gitignoreContent.trim().length > 0
      ? gitignoreContent.endsWith("\n")
        ? gitignoreContent
        : `${gitignoreContent}\n`
      : `${TEMPLATE_HEADER.join("\n")}\n`;
  return [
    gitignoreSection,
    WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER,
    buildBuiltinDefaultsSection(gitignoreContent),
    WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER,
    CUSTOM_SECTION_HINT,
    "",
  ].join("\n");
}

interface SplitWorkspaceFileSearchIgnoreSections {
  gitignoreSection: string;
  defaultsSection: string;
  customSection: string;
}

/** Split the file using both markers; return null if either marker is missing (legacy format/user deletion), and let the caller rebuild the whole file. */
function splitWorkspaceFileSearchIgnoreSections(
  content: string,
): SplitWorkspaceFileSearchIgnoreSections | null {
  const lines = content.split(/\r?\n/);
  const syncIndex = lines.findIndex(
    (line) => line.trim() === WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER,
  );
  const defaultsIndex = lines.findIndex(
    (line) => line.trim() === WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER,
  );
  if (syncIndex === -1 || defaultsIndex === -1 || defaultsIndex <= syncIndex) {
    return null;
  }
  return {
    gitignoreSection: lines.slice(0, syncIndex).join("\n"),
    defaultsSection: lines
      .slice(syncIndex + 1, defaultsIndex)
      .join("\n")
      .trim(),
    customSection: lines
      .slice(defaultsIndex + 1)
      .join("\n")
      .replace(/^\n+/, ""),
  };
}

/**
 * "Sync from .gitignore": rewrite only the content above the SYNC marker with the current .gitignore,
 * preserving the default exclusion and custom sections exactly as-is (including user edits to defaults).
 * If markers are missing, rebuild the initial contents because the sections cannot be located structurally.
 */
export function syncWorkspaceFileSearchIgnoreFromGitignore(
  currentContent: string,
  gitignoreContent: string | null,
): string {
  const sections = splitWorkspaceFileSearchIgnoreSections(currentContent);
  if (!sections) {
    return buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent);
  }
  const gitignoreSection =
    gitignoreContent !== null && gitignoreContent.trim().length > 0
      ? gitignoreContent.endsWith("\n")
        ? gitignoreContent
        : `${gitignoreContent}\n`
      : `${TEMPLATE_HEADER.join("\n")}\n`;
  return [
    gitignoreSection,
    WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER,
    sections.defaultsSection,
    WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER,
    sections.customSection,
  ]
    .join("\n")
    .replace(/\n+$/, "\n");
}

/**
 * "Restore default rules": reset only the default exclusion section to the built-in list, preserving the gitignore and custom sections as-is.
 * If markers are missing, rebuild the initial contents.
 */
export function resetWorkspaceFileSearchIgnoreDefaults(
  currentContent: string,
  gitignoreContent: string | null,
): string {
  const sections = splitWorkspaceFileSearchIgnoreSections(currentContent);
  if (!sections) {
    return buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent);
  }
  // Recalculate restored defaults after deduplicating against the current gitignore section; do not repeat lines already declared there.
  // If the user previously removed node_modules and similar rules from .gitignore, restoring defaults adds them back as a fallback.
  return [
    sections.gitignoreSection,
    WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER,
    buildBuiltinDefaultsSection(sections.gitignoreSection),
    WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER,
    sections.customSection,
  ]
    .join("\n")
    .replace(/\n+$/, "\n");
}

// Under nodenext, ignore's index.d.ts resolves the default import as a module namespace (without a call signature),
// while at runtime the default is the factory function itself (verified with Node ESM interop). Narrow it explicitly to the factory signature here.
const createIgnoreMatcher: () => Ignore = ignoreFactory as unknown as () => Ignore;

function buildIgnoreMatcher(content: string): Ignore {
  return createIgnoreMatcher().add(content);
}

function isNotFoundError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Atomic write: write a temporary file in the target directory (flush + close), then replace via rename, following
 * the workspace-hook-mutation.ts pattern so Runtime/Settings never observe a partial rules file.
 */
async function atomicWriteIgnoreFile(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  const tempPath = resolve(
    directory,
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx", 0o644);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Load `.zcodeignore` rules before scanning; automatic creation is temporarily commented out:
 * file missing → use .gitignore plus default exclusion rules in memory, without writing to disk;
 * read failure (permissions, etc.) → use .gitignore contents in memory → if that fails, use built-in defaults.
 * Log any fallback only once; an unavailable rules file must never prevent scanning in the @ panel.
 */
export async function loadWorkspaceFileSearchIgnoreRules(
  rootPath: string,
  logger?: WorkspaceFileIgnoreLogger,
): Promise<WorkspaceFileSearchIgnoreRules> {
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);

  const degradeToInMemory = async (
    reason: string,
    error: unknown,
  ): Promise<WorkspaceFileSearchIgnoreRules> => {
    const gitignoreContent = await readOptionalFile(resolve(rootPath, GITIGNORE_FILE_NAME)).catch(
      () => null,
    );
    if (gitignoreContent !== null) {
      logger?.warn(
        undefined,
        `[workspace-file-ignore] ${reason}，降级为运行时使用 .gitignore 规则`,
        error,
      );
      return {
        matcher: buildIgnoreMatcher(gitignoreContent),
        source: "fallback-gitignore",
      };
    }
    logger?.warn(undefined, `[workspace-file-ignore] ${reason}，降级为内置默认忽略规则`, error);
    const template = buildWorkspaceFileSearchIgnoreTemplate(null);
    return {
      matcher: buildIgnoreMatcher(template),
      source: "fallback-builtin",
    };
  };

  let existing: string | null;
  try {
    existing = await readOptionalFile(ignorePath);
  } catch (error) {
    return degradeToInMemory(`读取 ${WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME} 失败`, error);
  }
  if (existing !== null) {
    return { matcher: buildIgnoreMatcher(existing), source: "file" };
  }

  const gitignoreContent = await readOptionalFile(resolve(rootPath, GITIGNORE_FILE_NAME)).catch(
    () => null,
  );
  const initialContent = buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent);
  // The management entry has been temporarily hidden, but the auto-creation logic would still write files into user projects, so it is disabled for now.
  // Keep the original creation and logging logic for re-enabling when the entry returns; currently rules are used in memory only.
  /*
  try {
    await atomicWriteIgnoreFile(ignorePath, initialContent);
  } catch (error) {
    // Creation failure does not affect scanning: the initial content is deterministic, so apply it directly in memory;
    // preserve the initial-content source marker (copied .gitignore / built-in template) to indicate the fail-open fallback.
    logger?.warn(
      undefined,
      `[workspace-file-ignore] 自动创建 ${WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME} 失败，降级为运行时使用${
        gitignoreContent !== null ? ".gitignore" : "内置默认"
      }规则`,
      error,
    );
    return {
      matcher: buildIgnoreMatcher(initialContent),
      source: gitignoreContent !== null ? "fallback-gitignore" : "fallback-builtin",
    };
  }
  logger?.info(
    undefined,
    `[workspace-file-ignore] 已自动创建 ${WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME}（来源：${
      gitignoreContent !== null ? ".gitignore 拷贝" : "默认模板"
    }）`,
  );
  */
  return {
    matcher: buildIgnoreMatcher(initialContent),
    // source: gitignoreContent !== null ? "created-from-gitignore" : "created-from-template",
    source: "template",
  };
}

/**
 * Determine whether a relative path is ignored. Directories must include a trailing slash (gitignore dirOnly rules match only directories);
 * the caller guarantees relativePath uses POSIX separators (fileService's normalizeRelativePath converts it).
 */
export function isWorkspaceFileSearchPathIgnored(
  rules: WorkspaceFileSearchIgnoreRules,
  relativePath: string,
  type: "file" | "directory",
): boolean {
  return type === "directory"
    ? rules.matcher.ignores(`${relativePath}/`)
    : rules.matcher.ignores(relativePath);
}

/** Settings read: when the file does not exist, return an initial content preview (source: template) without writing it to disk. */
export async function readWorkspaceFileSearchIgnore(
  rootPath: string,
): Promise<WorkspaceFileSearchIgnoreContent> {
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);
  const existing = await readOptionalFile(ignorePath);
  if (existing !== null) {
    return { content: existing, source: "file" };
  }
  const gitignoreContent = await readOptionalFile(resolve(rootPath, GITIGNORE_FILE_NAME)).catch(
    () => null,
  );
  return {
    content: buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent),
    source: "template",
  };
}

export type WorkspaceFileSearchIgnoreTransform = "sync-gitignore" | "reset-defaults";

/**
 * Section actions in Settings (return new content for the editor; write to disk only on save):
 * sync-gitignore rewrites only the gitignore sync section; reset-defaults resets only the default exclusion section;
 * both preserve user content outside the markers, as specified by each pure function's contract.
 */
export async function transformWorkspaceFileSearchIgnore(
  rootPath: string,
  transform: WorkspaceFileSearchIgnoreTransform,
): Promise<{ content: string }> {
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);
  const existing = await readOptionalFile(ignorePath).catch(() => null);
  const gitignoreContent = await readOptionalFile(resolve(rootPath, GITIGNORE_FILE_NAME)).catch(
    () => null,
  );
  const currentContent = existing ?? buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent);
  const content =
    transform === "sync-gitignore"
      ? syncWorkspaceFileSearchIgnoreFromGitignore(currentContent, gitignoreContent)
      : resetWorkspaceFileSearchIgnoreDefaults(currentContent, gitignoreContent);
  return { content };
}

/** Settings save: atomically write the entire file; the next scan reads the new contents. */
export async function writeWorkspaceFileSearchIgnore(
  rootPath: string,
  content: string,
): Promise<void> {
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);
  await atomicWriteIgnoreFile(ignorePath, content);
}

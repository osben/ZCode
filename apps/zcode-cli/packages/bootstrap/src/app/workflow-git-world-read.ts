// ============================================================
// git.* world reads: read-only **by construction**
// ============================================================
// This module is the **pure** half of git world reads: argument validation, construction of
// fixed argv, and parsing porcelain-v2 / log / path-list output. Side effects (actually spawning
// git) stay in workflow-world-read.ts.
//
// Why this is a pure module: each property can be pinned down independently—"this op's argv is
// exactly these elements," "branch is absent for detached HEAD," "`-foo` is rejected as a
// base," "filenames containing newlines pass through unchanged." In the execution module these
// could only be asserted indirectly through a fake port; here they can be asserted directly.
//
// ————————————————————————————————————————————————————————————————
// Read-only behavior is achieved **by construction**, not by checking afterward.
// ————————————————————————————————————————————————————————————————
// This module can construct argv only for the five allowed subcommands. No path can assemble a
// shell string or use a script-provided string directly as a subcommand or option: base refs pass
// a strict character check (no leading `-`, no `..` range), paths must be workspace-relative and
// contained, and they **always** appear after `--`. Thus "cannot write" is a property of what
// this code can express, not an authorization check someone might forget later.
//
// ————————————————————————————————————————————————————————————————
// Two output contracts used throughout this module (verified empirically, not inferred from docs).
// ————————————————————————————————————————————————————————————————
// **1. `-z`: NUL-separated, paths preserved byte for byte.** Without `-z`, `core.quotePath`
// defaults to true, and git C-quotes non-ASCII paths using octal escapes—`文档.md` becomes a
// string like `"\346\226\207..."`. This is common for users of this repository, not an edge
// case. `-z` solves two issues: paths are no longer quoted/escaped, and **filenames containing
// newlines** no longer break line-based splitting (which would split one path into two nonexistent
// paths without any error—the kind of "rare and silent failure" this code rejects). Our own
// `git log` also separates fields with `%x00`, keeping the family consistent.
//
// **2. Always return workspace-relative paths, converting them once on our side.** In tests,
// `-z` makes `status --porcelain=v2` output **repository-root-relative** paths, and no flag or
// config changes them back to cwd-relative (`status.relativePaths` does not affect porcelain
// -z); `diff --name-only` is also repository-root-relative by default, while `ls-files --others`
// is **cwd-relative** by default. Three commands, three bases.
//
// Use one rule here: **always use repository-root-relative paths on the wire** (add `--full-name`
// to `ls-files` to align it), then call `rev-parse --show-prefix` to get the workspace's prefix
// relative to the repository root and strip it during parsing. This gives one path base and one
// conversion point instead of relying on three different git defaults. That mix caused
// `changedFiles()` to return paths with two different bases; when the workspace is the repository
// root, all three happen to match, so the bug stayed hidden until a workspace was a subdirectory.
//
// The only exception is `git.diff` **patch text**: it is not a parsed path list but a full output
// block with `a/… b/…` headers, so the prefix cannot be stripped afterward. Use git's own
// `--relative` to align its base.

import { WorkflowError } from "@zcode/dynamic-workflow";

/**
 * One command to run for a git world read. `argv` excludes the `"git"` executable itself; the
 * execution side provides it so this module never touches processes.
 */
interface GitCommandPlan {
  readonly argv: readonly string[];
}

/** Return shape for `git.status()`. The authoritative declaration is `declare interface GitStatus` in FACADE_DTS. */
export interface GitStatusResult {
  branch?: string;
  clean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

/** One `git.log()` entry. The authoritative declaration is `declare interface GitCommit` in FACADE_DTS. */
export interface GitCommitResult {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

/**
 * Strict character set for a base ref: the first character must be a letter/digit; subsequent
 * characters may be `[A-Za-z0-9._/@^~-]`.
 *
 * Disallowing a leading `-` is the only **security-relevant** part of this rule: git would treat
 * `-foo` as an option rather than a ref, and we do not control which options exist. Also disallow
 * a leading `.`, which conveniently rejects `.` / `..` inputs that are not valid refs and look
 * like ranges.
 *
 * Intentionally excluded: whitespace (there is no valid reason for whitespace in a ref), `{`/`}`
 * (reflog syntax such as `@{u}`, unsupported in v1), `:` (`ref:path` syntax), and any `..`
 * (ranges; v1 accepts only a **single** ref). These are not dangerous; they are simply outside
 * the semantics promised by v1. Accepting them would make scripts depend on an undocumented contract.
 */
const GIT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@^~-]*$/;

/** `git log` field format: NUL-separated hash / subject / author name / author date (ISO-8601). */
const GIT_LOG_PRETTY = "--pretty=format:%H%x00%s%x00%an%x00%aI";

/**
 * Workspace prefix relative to the repository root (`"sub/nested/"`, empty at the repo root).
 * This is the only basis for converting repository-root-relative paths on the wire into
 * workspace-relative paths; see output contract 2 at the top of this module.
 */
export const GIT_SHOW_PREFIX_ARGV: readonly string[] = ["rev-parse", "--show-prefix"];

/**
 * Fixed argv for `git status`. `--branch` supplies GitStatus.branch; `-- .` confines observation
 * to the workspace (see {@link WORKSPACE_PATHSPEC}).
 */
export const GIT_STATUS_ARGV: readonly string[] = [
  "status",
  "--porcelain=v2",
  "-z",
  "--branch",
  "--",
  ".",
];

/**
 * Fixed argv for untracked files. `--exclude-standard` respects .gitignore; `--full-name` makes
 * paths repository-root-relative instead of cwd-relative, matching status/diff (output contract
 * 2 at the top of this module).
 */
const GIT_UNTRACKED_ARGV: readonly string[] = [
  "ls-files",
  "--others",
  "--exclude-standard",
  "-z",
  "--full-name",
  "--",
  ".",
];

/**
 * Workspace pathspec. git.* are **world reads**, and this workflow's "world" is the workspace:
 * files.glob/read/grep are workspace-scoped, actor subagent sessions use the workspace as cwd,
 * and permission tiers are also workspace-scoped. Git observations must stay within the same
 * world; otherwise `changedFiles()` could return paths outside the workspace, making the obvious
 * two-line combination `changedFiles() → files.read(p)` a trap.
 *
 * Tradeoff (intentionally accepted in v1): when the workspace is a repository subdirectory, changes outside it are not visible.
 */
const WORKSPACE_PATHSPEC = ".";

/**
 * Validate a base ref and return the original string. A shape mismatch produces a structured
 * `DriverError` (node-level and catchable by the script). The error message explains **why** it
 * was rejected so the script author can fix it instead of guessing.
 */
function validateGitRef(op: string, value: string): string {
  if (value.length === 0) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: base must not be empty. Pass a ref such as "main" or omit it.`,
    );
  }
  if (value.startsWith("-")) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: base '${value}' starts with '-', which git would read as an option, ` +
        `not a ref. Pass a plain ref.`,
    );
  }
  if (value.includes("..")) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: base '${value}' is a '..' range; only a single ref is accepted. Pass ` +
        `one ref.`,
    );
  }
  if (!GIT_REF_PATTERN.test(value)) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: base '${value}' is not a valid ref. A ref starts with a letter or ` +
        `digit, followed by letters, digits and . _ / @ ^ ~ - (no whitespace or syntax ` +
        `characters such as {} :).`,
    );
  }
  return value;
}

/**
 * Validate a workspace-relative path and return its normalized string (separators are unified as `/`).
 *
 * Three **lexical constraints** (symlinks are not followed; see the v1 notes): no absolute
 * paths, no leading `-`, and no `..` segment. The third is the containment check here: in the
 * normalized `relative` result, `..` can appear only at the beginning, so "no `..` segment and
 * not absolute" is equivalent to "still within the workspace after resolution."
 *
 * Reject paths beginning with `-` even though they are safe after `--`: this is defense in depth.
 * If `--` is accidentally omitted one day, a `-foo` path would be interpreted as an option.
 */
function validateGitPath(op: string, value: string): string {
  if (value.length === 0) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: path must not be empty. Pass a workspace-relative path or omit it.`,
    );
  }
  if (value.startsWith("-")) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: path '${value}' starts with '-', which git could read as an option. ` +
        `Pass a path that does not start with '-'.`,
    );
  }
  if (looksAbsolute(value)) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: path '${value}' is absolute; only workspace-relative paths are ` +
        `accepted. Pass the path relative to the workspace root.`,
    );
  }
  // Normalize separators to `/`: git pathspecs accept `/` on all three platforms, and models
  // often produce Windows-style relative paths. Normalize **before** checking for `..`, or
  // `..\x` could slip through segment splitting.
  const normalized = value.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: path '${value}' contains a '..' segment and would leave the ` +
        `workspace. Pass a path inside the workspace.`,
    );
  }
  return normalized;
}

/**
 * Detect absolute paths **independently of the current platform**: the posix version of
 * `node:path` does not recognize `C:\x`, but this validation must return the same answer on all
 * three platforms (cross-platform rule: do not implement based on the developer machine's OS behavior).
 */
function looksAbsolute(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]?/.test(value);
}

/**
 * Commands to run for `git.changedFiles(base?)`.
 *
 * Without a base, return the union of **two** commands: `diff --name-only HEAD` and
 * `ls-files --others --exclude-standard`. Untracked files are changes from a reader's
 * perspective; omitting them would make this primitive useless on a newly created feature branch
 * (where nearly all new files are still untracked).
 *
 * With a base, run one command: `diff --name-only <base>`. "What changed relative to a ref" is a
 * question about **tracked history**; a file never added to git cannot be compared with any ref.
 */
export function gitChangedFilesPlan(base: string | undefined): GitCommandPlan[] {
  const ref = base === undefined ? "HEAD" : validateGitRef("git-changed-files", base);
  const tracked: GitCommandPlan = {
    argv: ["diff", "--name-only", "-z", ref, "--", WORKSPACE_PATHSPEC],
  };
  if (base !== undefined) return [tracked];
  return [tracked, { argv: [...GIT_UNTRACKED_ARGV] }];
}

/**
 * argv for `git.diff(base?, path?)`. base defaults to `HEAD`; path defaults to the workspace
 * pathspec `.` and **always** appears after `--` so a path with the same name as a branch is not
 * interpreted by git as a ref (or vice versa).
 *
 * `--relative` is required here for a different reason than elsewhere: git writes the `a/… b/…`
 * headers in patch text, which we do not parse and cannot adjust afterward. Ask git to use cwd
 * (= workspace) as the base. Without this, `changedFiles()` could say "only a.md changed" while
 * `diff()` returns a repository-level patch containing `../x`; the two primitives would disagree
 * about what counts as a change.
 *
 * `--relative` also excludes changes outside cwd, so `-- .` is redundant when no path is given.
 * **The redundancy is intentional**: workspace scoping should not silently depend on the side
 * effect of another flag; writing it explicitly lets argv tests pin it down.
 */
export function gitDiffArgv(base: string | undefined, path: string | undefined): string[] {
  const ref = base === undefined ? "HEAD" : validateGitRef("git-diff", base);
  const pathspec = path === undefined ? WORKSPACE_PATHSPEC : validateGitPath("git-diff", path);
  return ["diff", "--relative", ref, "--", pathspec];
}

/**
 * argv for `git.log(count)`. The caller validates count and clamps it to [1, cap].
 *
 * **Intentionally omit a pathspec, unlike the other ops in this family.** A commit is a
 * repository-level object; adding a pathspec to log would change its meaning to "commits that
 * touched the workspace," a different, unrequested question. log reads history metadata (hash /
 * subject / author / date), not workspace paths, so workspace scoping has nothing to apply to.
 */
export function gitLogArgv(count: number): string[] {
  return ["log", `-n${count}`, GIT_LOG_PRETTY];
}

/** Convert `rev-parse --show-prefix` output into a prefix string (empty at the repository root). */
export function parseGitShowPrefix(stdout: string): string {
  return stdout.replace(/\r?\n$/, "");
}

/**
 * Split `-z` output into segments on NUL and discard empty segments (the trailing NUL terminator leaves an empty segment).
 *
 * Discarding empty segments is safe and does not affect two-segment consumption for rename
 * entries: a path is never empty, so an empty segment can only come from the terminator.
 */
function nulSegments(stdout: string): string[] {
  return stdout.split("\u0000").filter((segment) => segment.length > 0);
}

/**
 * Strip the workspace prefix to convert a repository-root-relative path into a
 * **workspace-relative** path (output contract 2 at the top of this module).
 *
 * **Fail loudly** on paths outside the prefix instead of returning them unchanged. `-- .` already
 * guarantees that every path is inside the workspace, so reaching this branch means an
 * assumption failed. Returning a path with `../` is exactly what these constraints prevent, and
 * the script could pass it to `files.read`; fail the node instead.
 */
function stripWorkspacePrefix(prefix: string, path: string): string {
  if (prefix.length === 0) return path;
  if (path.startsWith(prefix)) return path.slice(prefix.length);
  throw new WorkflowError(
    "DriverError",
    `git reported path '${path}' outside the workspace prefix '${prefix}'. The pathspec should ` +
      `have scoped the read to the workspace, so the scoping is broken; report this as a bug.`,
  );
}

/**
 * Parse `git status --porcelain=v2 -z --branch -- .`.
 *
 * The first character of each segment is the record type: `#` header, `1` ordinary change, `2`
 * rename/copy, `u` unmerged, `?` untracked, `!` ignored (only appears with `--ignored`, which
 * is not used here). The two `XY` characters for `1`/`2` are **index** and **worktree** status;
 * `.` means unchanged. A file can therefore be both staged and unstaged (modified, staged, then
 * modified again).
 *
 * Two `-z`-specific shapes (both verified in practice):
 *   - Header records are NUL-terminated too, not newline-terminated.
 *   - **Rename/copy records use two segments**: `2 … R100 <new path>\0<old path>` (without `-z`,
 *     the two paths are TAB-separated). The parser must explicitly consume the extra segment or
 *     the old path is treated as the next record and silently discarded because it does not
 *     start with a type character. Do not return the old path; the facade reports which paths
 *     changed now.
 *
 * The path is the record's **trailing remainder**, not a fixed-width field: it can contain
 * spaces (or even newlines, preserved by `-z`). Split by skipping the first N space-separated
 * fields and taking the remainder; never split the whole record.
 */
export function parseGitStatusPorcelainV2(stdout: string, prefix = ""): GitStatusResult {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  let branch: string | undefined;

  const segments = nulSegments(stdout);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment.startsWith("# branch.head ")) {
      const head = segment.slice("# branch.head ".length);
      // For detached HEAD, git writes the literal "(detached)". In that case branch is **absent**,
      // not set to this placeholder; otherwise a script could use it as a branch name in diff.
      if (head !== "(detached)") branch = head;
      continue;
    }
    if (segment.startsWith("#")) continue;

    const kind = segment[0];
    if (kind === "1" || kind === "2") {
      const xy = segment.split(" ")[1] ?? "..";
      // A `1` path begins at field 8; `2` has an extra `<X><score>` field, so its path starts at
      // field 9, and its **original path** occupies the entire next segment (NUL-separated with
      // `-z`), which must be skipped explicitly.
      const path = fieldTail(segment, kind === "1" ? 8 : 9);
      if (kind === "2") index += 1;
      if (path.length === 0) continue;
      const relative = stripWorkspacePrefix(prefix, path);
      if (xy[0] !== undefined && xy[0] !== ".") staged.push(relative);
      if (xy[1] !== undefined && xy[1] !== ".") unstaged.push(relative);
      continue;
    }
    if (kind === "u") {
      // Unmerged (conflict): treat it as pending work in the worktree, so report it as unstaged.
      // It does need attention, while staged would be misleading—a conflicted file is not "ready to commit."
      const path = fieldTail(segment, 10);
      if (path.length > 0) unstaged.push(stripWorkspacePrefix(prefix, path));
      continue;
    }
    if (kind === "?") {
      const path = fieldTail(segment, 1);
      if (path.length > 0) untracked.push(stripWorkspacePrefix(prefix, path));
    }
    // Skip `!` and unrecognized segments.
  }

  const clean = staged.length === 0 && unstaged.length === 0 && untracked.length === 0;
  return {
    ...(branch === undefined ? {} : { branch }),
    clean,
    staged: sortedUnique(staged),
    unstaged: sortedUnique(unstaged),
    untracked: sortedUnique(untracked),
  };
}

/**
 * Parse {@link GIT_LOG_PRETTY} output: one record per line, with NUL-separated fields.
 *
 * Splitting records on **newlines** is reliable here, unlike for path lists: `%s` is the first
 * line of the commit message and by definition contains no newline; neither do the other three
 * fields (hash / author name / ISO date). So `-z` is not needed here.
 *
 * Throw if the field count is not 4: the format string and parser are both in this module, so a
 * mismatch means a local change broke one of them. A partially populated commit would otherwise
 * flow into the journal and model context.
 */
export function parseGitLog(stdout: string): GitCommitResult[] {
  const commits: GitCommitResult[] = [];
  for (const raw of stdout.split("\n")) {
    const record = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (record.length === 0) continue;
    const fields = record.split("\u0000");
    if (fields.length !== 4) {
      throw new WorkflowError(
        "DriverError",
        `world-read git-log: cannot parse the output; a record should have 4 NUL-separated ` +
          `fields, got ${fields.length}. Retry, and report this as a bug if it persists.`,
      );
    }
    commits.push({
      hash: fields[0]!,
      subject: fields[1]!,
      author: fields[2]!,
      date: fields[3]!,
    });
  }
  return commits;
}

/**
 * Split `--name-only -z` / `ls-files -z` output into a list of **workspace-relative** paths.
 * argv has made both repository-root-relative (`--full-name`), so strip the prefix here once.
 */
export function parseGitPathList(stdout: string, prefix = ""): string[] {
  return nulSegments(stdout).map((path) => stripWorkspacePrefix(prefix, path));
}

/**
 * Return the **entire remainder** starting at space-separated field `index`. Porcelain v2 fields
 * are fixed-width and separated by one space; only the final path may contain spaces, so
 * "skip N spaces and take the remainder" is the only correct split.
 */
function fieldTail(line: string, index: number): string {
  let at = 0;
  for (let i = 0; i < index; i += 1) {
    const next = line.indexOf(" ", at);
    if (next === -1) return "";
    at = next + 1;
  }
  return line.slice(at);
}

/** Deduplicate and sort. The journal stores this value, so it must depend only on content, not git output order. */
function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

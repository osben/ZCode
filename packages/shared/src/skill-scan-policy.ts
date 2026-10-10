// ============================================================
// Skill scan policy (pure, no I/O)
// ============================================================
//
// Shared policy for scanning skill directories, used by @zcode/services (recursive desktop scan) and
// @zcode/adapters in apps/zcode-cli (single-level Agent scan),
// to prevent the two sides from disagreeing about which directories to enter.
//
// Keep this as pure logic with no node:* dependencies, or the Web bundle will break.

/** Skill definition filename. */
export const SKILL_FILE_NAME = "SKILL.md";

/**
 * Child directory names to skip during recursive skill-directory scans.
 *
 * Skipping only directories beginning with `.` is not enough:
 * content directories such as `node_modules` would be recursively scanned in full, making a single
 * `skills.list` take 69–256 seconds on Windows. These directories do not contain user skills, so exclude them consistently.
 */
export const SKILL_SCAN_EXCLUDED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  ".cache",
  ".next",
  ".turbo",
  ".venv",
  "__pycache__",
]);

/**
 * Maximum recursive scan depth (relative to the scan root, which is depth 0).
 *
 * Real skill layouts are shallow: `root/<name>/SKILL.md`, or at most
 * `root/<group>/<name>/SKILL.md` when grouped. A depth of 8 leaves ample room and serves as a fallback brake for
 * unusually deep directory chains created by symlinks/junctions.
 */
export const MAX_SKILL_SCAN_DEPTH = 8;

/**
 * By default, do not enter dot-prefixed subdirectories under skill directories (including ~/.zcode/skills),
 * to avoid listing vendored copies such as .agents/.cursor and symlink mirrors more than once;
 * also skip content directories such as node_modules.
 */
const SKILL_DISCOVERY_DOT_DIR_ALLOWLIST = new Set([".system"]);

/** Determines whether a recursive scan should enter a child directory. */
export function shouldWalkSkillDirectoryEntry(entryName: string): boolean {
  if (SKILL_SCAN_EXCLUDED_DIRECTORY_NAMES.has(entryName)) {
    return false;
  }
  if (!entryName.startsWith(".")) {
    return true;
  }
  return SKILL_DISCOVERY_DOT_DIR_ALLOWLIST.has(entryName);
}

import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_SKILL_SCAN_DEPTH,
  SKILL_FILE_NAME,
  shouldWalkSkillDirectoryEntry,
} from "@zcode/shared";

// The scan policy comes from @zcode/shared and is shared by the desktop package and agent side (@zcode/adapters),
// preventing the two sides from disagreeing about which directories to enter. Re-export it here to preserve existing import paths.
export {
  MAX_SKILL_SCAN_DEPTH,
  SKILL_FILE_NAME,
  SKILL_SCAN_EXCLUDED_DIRECTORY_NAMES,
  shouldWalkSkillDirectoryEntry,
} from "@zcode/shared";

interface WalkSkillMarkdownOptions {
  /** Called when readdir/stat fails; if omitted, skip the directory silently and let the caller collect diagnostics as needed. */
  onError?: (path: string, error: unknown) => void;
}

/**
 * Walk depth-first from the root and yield the absolute path of each SKILL.md.
 *
 * Constrained by the @zcode/shared scan policy:
 * - Skip content directories such as node_modules and dot-directories (except .system).
 * - Limit maximum depth (MAX_SKILL_SCAN_DEPTH) as a fallback brake for very deep directory chains.
 * - Deduplicate only symlink directories by realpath to avoid duplicates or infinite scans from Windows junctions/cycles;
 *   ordinary directory trees cannot cycle, so avoid realpath on the hot path.
 *
 */
export async function* walkSkillMarkdownPaths(
  rootPath: string,
  options: WalkSkillMarkdownOptions = {},
): AsyncGenerator<string> {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: rootPath, depth: 0 }];
  const visitedSymlinkTargets = new Set<string>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const { dir, depth } = current;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      options.onError?.(dir, error);
      continue;
    }

    let hasSkillFile = false;
    const childDirectories: string[] = [];
    const childSymlinks: string[] = [];
    for (const entry of entries) {
      // Treat regular files and symlinks to files named SKILL.md as skill definitions.
      if (entry.name === SKILL_FILE_NAME && !entry.isDirectory()) {
        hasSkillFile = true;
        continue;
      }
      if (!shouldWalkSkillDirectoryEntry(entry.name)) {
        continue;
      }
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        childDirectories.push(entryPath);
      } else if (entry.isSymbolicLink()) {
        childSymlinks.push(entryPath);
      }
    }

    if (hasSkillFile) {
      yield join(dir, SKILL_FILE_NAME);
    }

    if (depth >= MAX_SKILL_SCAN_DEPTH) {
      continue;
    }

    for (const childDirectory of childDirectories) {
      stack.push({ dir: childDirectory, depth: depth + 1 });
    }

    // Symlink directory: first confirm it points to a directory, then deduplicate by realpath to avoid repeated or infinite scans from junctions/cycles.
    for (const childSymlink of childSymlinks) {
      let targetStat;
      try {
        targetStat = await stat(childSymlink);
      } catch (error) {
        options.onError?.(childSymlink, error);
        continue;
      }
      if (!targetStat.isDirectory()) {
        continue;
      }
      const canonical = await realpath(childSymlink).catch(() => childSymlink);
      if (visitedSymlinkTargets.has(canonical)) {
        continue;
      }
      visitedSymlinkTargets.add(canonical);
      stack.push({ dir: childSymlink, depth: depth + 1 });
    }
  }
}

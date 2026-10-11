// ============================================================
// Skill-root scanning rules (shared implementation)
// ============================================================

// A manifest's skills entry may point to one skill directory or a one-level collection of skills.
// If the root contains SKILL.md, recognize it as a skill first, then scan one level of
// subdirectories. This matches desktop discovery and avoids silently missing a single skill by
// mistaking it for a collection.
// Plugin discovery paths (countSkillFiles / collectSkillComponents) are synchronous, while the
// skill adapter uses fs/promises. Provide sync and async variants so the rules are written once and
// followed by both implementations.
//
// Error contract: swallow only expected absence—return an empty array when the path does not exist
// (ENOENT) or is not a directory. Rethrow other errors (such as EACCES or EMFILE) so the caller can
// decide whether to emit a skill_scan_failed diagnostic or degrade gracefully. An outer catch
// must not swallow every error: permission errors would become silent empties and make the
// skill_scan_failed diagnostic dead code, reintroducing a silent failure path.
//
// Trust boundary: plugin-scope content is untrusted. Symlinks (including Windows junctions—both
// return true for Dirent.isSymbolicLink/lstat) can point to any directory or file outside the
// plugin root (directory-level skills/evil-link -> ../../outside, or file-level SKILL.md ->
// ~/.aws/credentials). A prior attempt used realpath containment, but the optional boundary
// parameter spread across the data flow, requiring checks at every file access (leaving gaps for
// file-level links, cross-drive relative predicates, and manifest-failure fallback). Use one rule
// instead: plugin scans never follow symlinks; reject links at all three levels—the root itself,
// child-directory candidates, and SKILL.md files. Rejecting links prevents escape without needing
// to determine their targets. User-level skill roots keep following links by default (symlink
// imports from ~/.zcode/skills are supported).

import { lstatSync, readdirSync, statSync } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { SKILL_FILE_NAME, shouldWalkSkillDirectoryEntry } from "@zcode/shared";

export interface ScanSkillFilesOptions {
  /**
   * Whether to follow symlinks at directory and file level; defaults to true (symlink imports from
   * user-level skill roots are supported). Plugin-scope scans must pass false: links may point
   * outside the plugin root, and rejecting them prevents escape without realpath target checks.
   */
  followSymbolicLinks?: boolean;
}

/**
 * All absolute paths to existing SKILL.md files under the root, including the root itself.
 * Return an empty array if the root does not exist or is not a directory; rethrow other scan
 * errors (such as EACCES).
 */
export async function scanSkillFilesUnderRoot(
  rootPath: string,
  options: ScanSkillFilesOptions = {},
): Promise<string[]> {
  const followSymlinks = options.followSymbolicLinks ?? true;
  // In plugin scans, return empty when the root itself is a link (including a junction).
  if (!followSymlinks && (await isSymbolicLink(rootPath))) return [];

  const rootInfo = await stat(rootPath).catch((error) => {
    throwIfUnexpectedScanError(error);
    return null;
  });
  if (!rootInfo?.isDirectory()) return [];

  const files: string[] = [];
  const own = join(rootPath, SKILL_FILE_NAME);
  // It is normal for the root itself to have no SKILL.md; continue into one level of subdirectories.
  if (await isLoadableSkillFile(own, followSymlinks)) files.push(own);

  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const walkable = entry.isDirectory() || (followSymlinks && entry.isSymbolicLink());
    if (!walkable) continue;
    if (!shouldWalkSkillDirectoryEntry(entry.name)) continue;
    // Verify that the file exists for each child-directory match: category directories (such as
    // skills/engineering/) are not skill directories, so the constructed path does not exist.
    // parseSkill would silently skip it, but counts and component enumeration also consume this
    // result; without validation, they would include a nonexistent skill.
    const candidate = join(rootPath, entry.name, SKILL_FILE_NAME);
    if (await isLoadableSkillFile(candidate, followSymlinks)) files.push(candidate);
  }
  return files;
}

/** Synchronous variant of scanSkillFilesUnderRoot with the same error contract. */
export function scanSkillFilesUnderRootSync(
  rootPath: string,
  options: ScanSkillFilesOptions = {},
): string[] {
  const followSymlinks = options.followSymbolicLinks ?? true;
  if (!followSymlinks && isSymbolicLinkSync(rootPath)) return [];

  const rootInfo = statSyncOrNull(rootPath);
  if (!rootInfo?.isDirectory()) return [];

  const files: string[] = [];
  const own = join(rootPath, SKILL_FILE_NAME);
  if (isLoadableSkillFileSync(own, followSymlinks)) files.push(own);

  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    const walkable = entry.isDirectory() || (followSymlinks && entry.isSymbolicLink());
    if (!walkable) continue;
    if (!shouldWalkSkillDirectoryEntry(entry.name)) continue;
    const candidate = join(rootPath, entry.name, SKILL_FILE_NAME);
    if (isLoadableSkillFileSync(candidate, followSymlinks)) files.push(candidate);
  }
  return files;
}

/**
 * Determine whether an SKILL.md candidate is loadable: include only real files. When not following
 * links, reject all symlink files (including junctions) as a defense against file-level escape
 * (SKILL.md -> any external file).
 */
async function isLoadableSkillFile(path: string, followSymlinks: boolean): Promise<boolean> {
  if (!followSymlinks && (await isSymbolicLink(path))) return false;
  const info = await stat(path).catch((error) => {
    throwIfUnexpectedScanError(error);
    return null;
  });
  return info?.isFile() ?? false;
}

function isLoadableSkillFileSync(path: string, followSymlinks: boolean): boolean {
  if (!followSymlinks && isSymbolicLinkSync(path)) return false;
  return statSyncOrNull(path)?.isFile() ?? false;
}

async function isSymbolicLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

function isSymbolicLinkSync(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function statSyncOrNull(path: string): { isFile(): boolean; isDirectory(): boolean } | null {
  try {
    return statSync(path);
  } catch (error) {
    throwIfUnexpectedScanError(error);
    return null;
  }
}

/** ENOENT (missing path) is normal during scanning and is swallowed; rethrow other errors (such as EACCES). */
function throwIfUnexpectedScanError(error: unknown): void {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  ) {
    return;
  }
  throw error;
}

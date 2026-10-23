import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { MAX_SKILL_SCAN_DEPTH, shouldWalkSkillDirectoryEntry } from "@zcode/shared";
import {
  DEFINITION_PREVIEW_MAX_TEXT_BYTES,
  DEFINITION_PREVIEW_MAX_TREE_ENTRIES,
  type DefinitionPreviewReadResult,
  type DefinitionPreviewTreeEntry,
} from "@zcode/shared/definition-preview";
import type { DefinitionFilesPort, DefinitionTreeListing } from "../app/ports.js";

export interface DefinitionFilesAdapterOptions {
  maxTextBytes?: number;
  maxTreeEntries?: number;
  maxDepth?: number;
}

const NOT_FOUND: DefinitionPreviewReadResult = { status: "not_found" };
const REJECTED: DefinitionPreviewReadResult = { status: "rejected" };

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

async function lstatOrNull(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isInside(root: string, target: string): boolean {
  const child = relative(root, target);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

export function createDefinitionFilesAdapter(
  options: DefinitionFilesAdapterOptions = {},
): DefinitionFilesPort {
  const maxTextBytes = options.maxTextBytes ?? DEFINITION_PREVIEW_MAX_TEXT_BYTES;
  const maxTreeEntries = options.maxTreeEntries ?? DEFINITION_PREVIEW_MAX_TREE_ENTRIES;
  const maxDepth = options.maxDepth ?? MAX_SKILL_SCAN_DEPTH;

  /**
   * Opens without following the last component, then proves the opened file is still at an
   * allowed location: Node has no openat(), so intermediate directories cannot be pinned by
   * descriptor. After open, the file's current canonical path must be allowed and its lstat
   * identity must equal the opened handle's. A file reached through a directory swapped for a
   * symlink at any point therefore fails the check, because the handle's inode is not the inode
   * living at an allowed path. Identities are compared as BigInt (64-bit inode numbers on NTFS
   * and some Linux filesystems exceed Number precision).
   */
  async function readVerified(
    path: string,
    before: BigIntStats,
    relativePath: string,
    isAllowedLocation: (canonicalPath: string) => boolean,
  ): Promise<DefinitionPreviewReadResult> {
    if (before.size > BigInt(maxTextBytes)) {
      return { status: "too_large", relativePath, size: Number(before.size), limit: maxTextBytes };
    }
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (isMissing(error)) return NOT_FOUND;
      if (errorCode(error) === "ELOOP") return REJECTED;
      throw error;
    }
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !sameIdentity(opened, before)) return REJECTED;
      let canonical: string;
      try {
        canonical = await realpath(path);
      } catch (error) {
        if (isMissing(error)) return NOT_FOUND;
        throw error;
      }
      if (!isAllowedLocation(canonical)) return REJECTED;
      const after = await lstatOrNull(canonical);
      if (!after || !sameIdentity(after, opened)) return REJECTED;
      const bytes = Buffer.alloc(maxTextBytes + 1);
      let used = 0;
      while (used < bytes.length) {
        const { bytesRead } = await handle.read(bytes, used, bytes.length - used, used);
        if (bytesRead === 0) break;
        used += bytesRead;
      }
      if (used > maxTextBytes) {
        return {
          status: "too_large",
          relativePath,
          size: Number(opened.size),
          limit: maxTextBytes,
        };
      }
      const content = bytes.subarray(0, used);
      if (content.includes(0)) return { status: "binary", relativePath, size: used };
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
        return { status: "text", relativePath, content: text, size: used };
      } catch {
        return { status: "binary", relativePath, size: used };
      }
    } finally {
      await handle.close();
    }
  }

  async function canonicalRegularFile(
    filePath: string,
  ): Promise<{ path: string; stats: BigIntStats } | null> {
    let canonical: string;
    try {
      canonical = await realpath(filePath);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    const stats = await lstatOrNull(canonical);
    return stats?.isFile() ? { path: canonical, stats } : null;
  }

  return {
    async listTree(rootPath: string): Promise<DefinitionTreeListing | null> {
      let canonicalRoot: string;
      try {
        canonicalRoot = await realpath(rootPath);
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
      const rootStats = await lstatOrNull(canonicalRoot);
      if (!rootStats?.isDirectory()) return null;

      const tree: DefinitionPreviewTreeEntry[] = [];
      let truncated = false;

      async function walk(directory: string, prefix: string, depth: number): Promise<void> {
        let entries;
        try {
          entries = await readdir(directory, { withFileTypes: true });
        } catch (error) {
          if (isMissing(error)) return;
          throw error;
        }
        entries.sort((left, right) => {
          const byType = Number(right.isDirectory()) - Number(left.isDirectory());
          return byType !== 0 ? byType : left.name.localeCompare(right.name);
        });
        for (const entry of entries) {
          if (tree.length >= maxTreeEntries) {
            truncated = true;
            return;
          }
          const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
          const absolute = join(directory, entry.name);
          if (entry.isSymbolicLink()) {
            // Links (including Windows junctions) are shown but never followed or read.
            tree.push({ relativePath, kind: "link" });
          } else if (entry.isDirectory()) {
            if (!shouldWalkSkillDirectoryEntry(entry.name)) continue;
            tree.push({ relativePath, kind: "directory" });
            if (depth < maxDepth) await walk(absolute, relativePath, depth + 1);
          } else if (entry.isFile()) {
            const stats = await lstatOrNull(absolute);
            tree.push({
              relativePath,
              kind: "file",
              ...(stats ? { size: Number(stats.size) } : {}),
            });
          }
          if (truncated) return;
        }
      }

      await walk(canonicalRoot, "", 1);
      return { tree, truncated };
    },

    async readFile(
      rootPath: string,
      segments: readonly string[],
    ): Promise<DefinitionPreviewReadResult> {
      // The readable set must equal the listed set: directories the tree hides (node_modules, .git,
      // other dot directories) and paths deeper than the walk limit are not readable either.
      const directories = segments.slice(0, -1);
      if (directories.length >= maxDepth || !directories.every(shouldWalkSkillDirectoryEntry)) {
        return NOT_FOUND;
      }
      let canonicalRoot: string;
      try {
        canonicalRoot = await realpath(rootPath);
      } catch (error) {
        if (isMissing(error)) return NOT_FOUND;
        throw error;
      }
      let current = canonicalRoot;
      let stats: BigIntStats | null = null;
      for (const [index, segment] of segments.entries()) {
        current = join(current, segment);
        stats = await lstatOrNull(current);
        if (!stats) return NOT_FOUND;
        if (stats.isSymbolicLink()) return REJECTED;
        if (index < segments.length - 1 && !stats.isDirectory()) return NOT_FOUND;
      }
      if (!stats?.isFile()) return NOT_FOUND;
      return readVerified(current, stats, segments.join("/"), (canonical) =>
        isInside(canonicalRoot, canonical),
      );
    },

    async readSingleFile(filePath: string): Promise<DefinitionPreviewReadResult> {
      // The Host derived this path from discovery, so a symlinked definition file is followed
      // once; the canonical target must be a regular file and is then read without following.
      const target = await canonicalRegularFile(filePath);
      if (!target) return NOT_FOUND;
      return readVerified(
        target.path,
        target.stats,
        basename(filePath),
        (canonical) => canonical === target.path,
      );
    },

    async isRegularFile(filePath: string): Promise<boolean> {
      return (await canonicalRegularFile(filePath)) !== null;
    },
  };
}

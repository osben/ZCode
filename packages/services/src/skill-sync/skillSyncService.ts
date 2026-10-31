import { existsSync } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { SKILL_DATA_SYNC_MAX_ITEM_BYTES } from "@zcode/shared";
import type { ISkillSyncService } from "./skillSync.js";
import {
  MAX_SKILL_SCAN_DEPTH,
  shouldWalkSkillDirectoryEntry,
  walkSkillMarkdownPaths,
} from "../skills/skillDiscoveryWalk.js";
import { createSkillDataSyncMethods } from "../data-sync/node.js";

const SKILL_FILE_NAME = "SKILL.md";
const DEFAULT_MAX_ARCHIVE_BYTES = SKILL_DATA_SYNC_MAX_ITEM_BYTES;

/** User-level skill candidate: path points to the SKILL.md inside the skill directory. */
export interface UserSkillCandidate {
  name: string;
  directoryName: string;
  description: string;
  path: string;
}

export function createSkillSyncService(options?: { maxArchiveBytes?: number }): ISkillSyncService {
  const maxArchiveBytes = options?.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
  // Data sync: size cap per skill directory, 20MB by default.
  return createSkillDataSyncMethods({ maxItemBytes: maxArchiveBytes });
}

export function resolveUserHomeDir(): string {
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
}

export function getUserZcodeSkillRoot(): string {
  return join(resolveUserHomeDir(), ".zcode", "skills");
}

function getUserAgentsSkillRoot(): string {
  return join(resolveUserHomeDir(), ".agents", "skills");
}

/**
 * User-level skill candidates: `~/.zcode/skills` wins; entries in `~/.agents/skills` with the same directory name or name are dropped, then deduplicated by realpath.
 * File counts and byte signatures are computed by the data-sync listing itself.
 */
export async function collectUserSkillCandidates(): Promise<UserSkillCandidate[]> {
  const seenSkillRealpaths = new Set<string>();
  const userZcodeSkillRoot = getUserZcodeSkillRoot();
  const rawZcodeCandidates = await collectUserSkillCandidatesInRoot(userZcodeSkillRoot);
  const zcodeDirectoryNames = await collectCoveredSkillDirectoryNamesInRoot(userZcodeSkillRoot);
  const zcodeSkillNameKeys = new Set(
    rawZcodeCandidates.map((candidate) => normalizeSkillNameKey(candidate.name)),
  );
  const zcodeCandidates = await dedupeCandidatesByCanonicalSkillPath(
    rawZcodeCandidates,
    seenSkillRealpaths,
  );
  const agentsCandidates = await dedupeCandidatesByCanonicalSkillPath(
    (await collectUserSkillCandidatesInRoot(getUserAgentsSkillRoot())).filter(
      (candidate) =>
        !zcodeDirectoryNames.has(candidate.directoryName) &&
        !zcodeSkillNameKeys.has(normalizeSkillNameKey(candidate.name)),
    ),
    seenSkillRealpaths,
  );

  return [...zcodeCandidates, ...agentsCandidates].sort((left, right) =>
    left.directoryName.localeCompare(right.directoryName),
  );
}

async function dedupeCandidatesByCanonicalSkillPath(
  candidates: UserSkillCandidate[],
  seenSkillRealpaths: Set<string>,
): Promise<UserSkillCandidate[]> {
  const result: UserSkillCandidate[] = [];
  for (const candidate of candidates) {
    const canonicalPath = await realpath(candidate.path).catch(() => candidate.path);
    if (seenSkillRealpaths.has(canonicalPath)) {
      continue;
    }
    seenSkillRealpaths.add(canonicalPath);
    result.push(candidate);
  }
  return result;
}

async function collectUserSkillCandidatesInRoot(root: string): Promise<UserSkillCandidate[]> {
  if (!existsSync(root)) {
    return [];
  }
  const candidates: UserSkillCandidate[] = [];
  for await (const skillPath of walkSkillMarkdownPaths(root)) {
    const directoryPath = dirname(skillPath);
    const relativePath = normalizeSkillDirectoryRelativePath(root, directoryPath);
    if (!relativePath) {
      continue;
    }
    const content = await readSkillFileOrNull(skillPath);
    if (content !== null) {
      const metadata = parseSkillMetadata(content, basename(relativePath));
      candidates.push({
        name: metadata.name,
        directoryName: relativePath,
        description: metadata.description,
        path: skillPath,
      });
    }
  }

  // Remote-sync candidates must reuse the bounded scan strategy already used by Settings;
  // a separate recursive scan could miss MAX_SKILL_SCAN_DEPTH and symlink realpath deduplication, and loop on cyclic symlinks.
  return candidates.sort((left, right) => left.directoryName.localeCompare(right.directoryName));
}

async function collectCoveredSkillDirectoryNamesInRoot(root: string): Promise<Set<string>> {
  const directoryNames = new Set<string>();
  if (!existsSync(root)) {
    return directoryNames;
  }
  const stack: Array<{ directoryPath: string; relativePath: string; depth: number }> = [
    { directoryPath: root, relativePath: "", depth: 0 },
  ];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const skillFilePath = join(current.directoryPath, SKILL_FILE_NAME);
    if (current.relativePath && (await readSkillFileOrNull(skillFilePath))) {
      directoryNames.add(current.relativePath);
    }
    if (current.depth >= MAX_SKILL_SCAN_DEPTH) {
      continue;
    }
    let entries;
    try {
      entries = await readdir(current.directoryPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      if (!shouldWalkSkillDirectoryEntry(entry.name)) {
        continue;
      }
      const entryPath = join(current.directoryPath, entry.name);
      const isDirectory =
        entry.isDirectory() ||
        (entry.isSymbolicLink() && (await stat(entryPath).catch(() => undefined))?.isDirectory());
      if (!isDirectory) {
        continue;
      }
      stack.push({
        directoryPath: entryPath,
        relativePath: joinSkillRelativePath(current.relativePath, entry.name),
        depth: current.depth + 1,
      });
    }
  }

  return directoryNames;
}

function normalizeSkillDirectoryRelativePath(root: string, directoryPath: string): string {
  return relative(root, directoryPath).replaceAll("\\", "/");
}

export function normalizeSkillNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function joinSkillRelativePath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

export async function readSkillFileOrNull(skillPath: string): Promise<string | null> {
  try {
    return await readFile(skillPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function parseSkillMetadata(
  content: string,
  fallbackName: string,
): {
  name: string;
  description: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (!match) {
    return { name: fallbackName, description: "" };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch {
    return { name: fallbackName, description: "" };
  }
  const metadata = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const name =
    typeof metadata.name === "string" && metadata.name.trim() ? metadata.name.trim() : fallbackName;
  const description = typeof metadata.description === "string" ? metadata.description.trim() : "";
  return { name, description };
}

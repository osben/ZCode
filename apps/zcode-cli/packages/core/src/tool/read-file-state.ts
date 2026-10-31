// ============================================================
// Read File State Helpers
// ============================================================

import { platform as currentPlatform } from "node:process";
import { normalizeToolPathForComparison } from "./path-normalization.js";
import type { ReadFileStateEntry, ReadFileStateMap } from "./types.js";

type ReadFileStatePlatform = NodeJS.Platform;

export function createReadFileStatePathKey(
  filePath: string,
  platform: ReadFileStatePlatform = currentPlatform,
): string {
  return normalizeToolPathForComparison(filePath, platform);
}

/**
 * One entry per file: Read, Write, Edit, and workflow drafts overwrite the file's previous
 * record; Bash backfill and Recall injection add one only when the file has no record yet.
 * Delete-then-set keeps the Map's iteration order equal to most-recent-write order.
 *
 * Fix rationale: storing multiple entries per path+offset+limit meant finding the "latest
 * view" required scanning the whole table, and cold recovery picked by a different rule set,
 * so the same history deduplicated differently before and after a restart.
 */
export function setReadFileStateEntry(
  readFileState: ReadFileStateMap,
  entry: ReadFileStateEntry,
  platform: ReadFileStatePlatform = currentPlatform,
): void {
  const key = createReadFileStatePathKey(entry.path, platform);
  readFileState.delete(key);
  readFileState.set(key, entry);
}

/** Raw spelling from the tool input; not recorded when it equals the normalized path. */
export function requestedPathField(
  requestedPath: string | undefined,
  path: string,
): Pick<ReadFileStateEntry, "requestedPath"> {
  return requestedPath === undefined || requestedPath === path ? {} : { requestedPath };
}

export function findLatestReadFileState(
  readFileState: ReadFileStateMap | undefined,
  filePath: string,
  platform: ReadFileStatePlatform = currentPlatform,
): ReadFileStateEntry | undefined {
  return readFileState?.get(createReadFileStatePathKey(filePath, platform));
}

export function normalizeReadFileStateMtimeMs(mtimeMs: number | undefined): number | undefined {
  if (mtimeMs === undefined) return undefined;
  return Math.floor(mtimeMs);
}

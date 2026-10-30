import { isAbsolute, relative } from "node:path";

import { resolveWorkspacePath } from "../tool/path-policy.js";

// Dream run journal directory. Lowercase because segments are compared case-insensitively. The
// journal module owns the public name; a test pins this literal to it.
const DREAM_JOURNAL_SEGMENT = ".fork_dream-journal";

const SENSITIVE_MEMORY_PATH_SEGMENTS = new Set([
  ".git",
  "hooks",
  ".husky",
  ".githooks",
  "node_modules",
  ".vscode",
  ".idea",
  "head",
  "config",
  "objects",
  "refs",
  ".claude",
  ".zcode",
  "skills",
  "commands",
  "agents",
  ".cargo",
  ".devcontainer",
  ".yarn",
  ".mvn",
  // Dream run journal: snapshots are written by the runtime only. Lowercase because segments are
  // compared case-insensitively; a test pins this entry to DREAM_JOURNAL_DIRECTORY_NAME.
  DREAM_JOURNAL_SEGMENT,
]);

export function resolveContainedMemoryFilePath(input: {
  filePath: string;
  rootDir: string;
  workingDirectory: string;
  workspaceRoot: string;
}): string | undefined {
  const resolvedPath = resolveWorkspacePath({
    inputPath: input.filePath,
    operation: "write",
    workingDirectory: input.workingDirectory,
    workspaceRoot: input.workspaceRoot,
  });
  const relativePath = relative(input.rootDir, resolvedPath);
  return isContainedRelativePath(relativePath) ? resolvedPath : undefined;
}

export function resolveSafeMemoryFilePath(input: {
  filePath: string;
  rootDir: string;
  workingDirectory: string;
  workspaceRoot: string;
}): string | undefined {
  const resolvedPath = resolveContainedMemoryFilePath(input);
  if (!resolvedPath) return undefined;
  const relativePath = memoryFileRelativePath(input.rootDir, resolvedPath);
  return relativePath && !containsSensitiveMemoryPathSegment(relativePath)
    ? resolvedPath
    : undefined;
}

export function memoryFileRelativePath(rootDir: string, filePath: string): string | undefined {
  const relativePath = relative(rootDir, filePath);
  return isContainedRelativePath(relativePath) ? relativePath : undefined;
}

/** True when the path is inside the Dream journal directory, in any letter case. */
export function isDreamJournalRelativePath(relativePath: string): boolean {
  return relativePath.split(/[\\/]+/u)[0]?.toLowerCase() === DREAM_JOURNAL_SEGMENT;
}

export function containsSensitiveMemoryPathSegment(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]+/u)
    .some((segment) => SENSITIVE_MEMORY_PATH_SEGMENTS.has(normalizeSensitiveSegment(segment)));
}

function isContainedRelativePath(relativePath: string): boolean {
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith("../") &&
    !relativePath.startsWith("..\\") &&
    !isAbsolute(relativePath)
  );
}

function normalizeSensitiveSegment(segment: string): string {
  const withoutControls = segment
    .toLowerCase()
    .replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/gu, "");
  return (withoutControls.split(":", 1)[0] ?? "").replace(/[. ]+$/u, "");
}

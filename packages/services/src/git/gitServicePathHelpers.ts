import { resolve } from "node:path";
import { isPathInWorkspaceScope, normalizeGitPath } from "./config.js";

export function toAbsolutePath(repoRoot: string, repoRelativePath: string): string {
  return resolve(repoRoot, ...normalizeGitPath(repoRelativePath).split("/"));
}

export function matchesWorkspaceScope(
  workspaceInRepoPath: string,
  entry: { path: string; originalPath: string | null },
): boolean {
  return (
    isPathInWorkspaceScope(entry.path, workspaceInRepoPath) ||
    (entry.originalPath ? isPathInWorkspaceScope(entry.originalPath, workspaceInRepoPath) : false)
  );
}

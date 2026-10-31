import { realpathSync } from "node:fs";
import { platform as currentPlatform } from "node:process";
import type { ExecutionResult } from "@zcode/contracts";
import {
  getToolPathApi,
  isPathOutsideParent,
  normalizeToolPathForComparison,
  type ToolPathApi,
  type ToolPathPlatform,
} from "../path-normalization.js";
import type { ToolRuntimeScope } from "../types.js";

export interface BashCwdPolicyInput {
  resolvedCwd: string | undefined;
  status: ExecutionResult["status"];
  exitCode: number | undefined;
  platform?: ToolPathPlatform;
  workspaceRoot: string;
  runtimeScope?: ToolRuntimeScope;
}

export interface BashCwdPolicyDecision {
  nextWorkingDirectory?: string;
  stderrSuffix?: string;
}

interface CwdBoundaryPair {
  resolvedCwd: string;
  workspaceRoot: string;
}

interface NormalizedCwdBoundary {
  pathApi: ToolPathApi;
  equivalentPairs: CwdBoundaryPair[];
}

export function decideBashCwdPolicy(input: BashCwdPolicyInput): BashCwdPolicyDecision {
  if (input.status !== "completed") return {};
  if (input.exitCode !== 0) return {};
  if (!input.resolvedCwd) return {};
  if ((input.runtimeScope ?? "main") !== "main") return {};

  const boundary = normalizeCwdBoundaryInput(input);
  // Root cause: writing back the normalized physical path let a symlink root, /private alias, or
  // drive-letter case change how the same directory is spelled; the environment announcement
  // compares strings, so it reported a phantom directory change and re-ran the repo check.
  // Normalization is used for boundary detection only; writes always use the workspace root's spelling (plus the relative path).
  const containing = findContainingPair(boundary);
  if (containing) {
    const relativePath = boundary.pathApi.relative(
      containing.workspaceRoot,
      containing.resolvedCwd,
    );
    return {
      nextWorkingDirectory:
        relativePath === ""
          ? input.workspaceRoot
          : boundary.pathApi.join(input.workspaceRoot, relativePath),
    };
  }

  return {
    nextWorkingDirectory: input.workspaceRoot,
    stderrSuffix: `Shell cwd was reset to ${input.workspaceRoot}`,
  };
}

export const BASH_CONCURRENT_CWD_CHANGE_SUFFIX =
  "Shell cwd was not persisted because another command changed it concurrently";

/**
 * Compare-and-set guard for the cwd write-back. Scheduling admits calls into a parallel group from
 * the model's input, but a PreToolUse hook may rewrite one of them into a directory change; if a
 * sibling that started from the old cwd finished last, its write-back would undo that change.
 * Only write back while the session cwd still equals the cwd this command started from.
 */
export function guardBashCwdWriteBack(
  decision: BashCwdPolicyDecision,
  input: {
    startWorkingDirectory: string;
    currentWorkingDirectory: string | undefined;
    platform?: ToolPathPlatform;
  },
): BashCwdPolicyDecision {
  if (!decision.nextWorkingDirectory || input.currentWorkingDirectory === undefined) {
    return decision;
  }
  if (input.currentWorkingDirectory === input.startWorkingDirectory) return decision;
  const isWindows = (input.platform ?? currentPlatform) === "win32";
  const changedOwnCwd =
    comparableCwd(decision.nextWorkingDirectory, isWindows) !==
    comparableCwd(input.startWorkingDirectory, isWindows);
  return changedOwnCwd ? { stderrSuffix: BASH_CONCURRENT_CWD_CHANGE_SUFFIX } : {};
}

function comparableCwd(value: string, isWindows: boolean): string {
  return realpathCwdBoundary(value, isWindows) ?? normalizeCwdBoundary(value, isWindows);
}

export function appendBashCwdStderrSuffix(stderr: string, suffix: string | undefined): string {
  if (!suffix) return stderr;
  const stderrWithoutTrailingNewlines = stderr.replace(/[\r\n]+$/, "");
  if (!stderrWithoutTrailingNewlines) return suffix;
  return `${stderrWithoutTrailingNewlines}\n${suffix}`;
}

function normalizeCwdBoundaryInput(input: BashCwdPolicyInput): NormalizedCwdBoundary {
  const platform = input.platform ?? currentPlatform;
  const pathApi = getToolPathApi(platform);
  const isWindows = platform === "win32";
  const resolvedCwd = normalizeCwdBoundary(input.resolvedCwd ?? "", isWindows);
  const workspaceRoot = normalizeCwdBoundary(input.workspaceRoot, isWindows);
  const equivalentPairs = [{ resolvedCwd, workspaceRoot }];
  // CWD capture uses pwd -P/realpath to get the physical path; the session root may be a symlink.
  // Collect equivalent boundaries before checking so a physical path inside the project is not mistaken for an outside path.
  const realResolvedCwd = realpathCwdBoundary(input.resolvedCwd ?? "", isWindows);
  const realWorkspaceRoot = realpathCwdBoundary(input.workspaceRoot, isWindows);

  if (realResolvedCwd && realWorkspaceRoot) {
    equivalentPairs.push({
      resolvedCwd: realResolvedCwd,
      workspaceRoot: realWorkspaceRoot,
    });
  }

  return { pathApi, equivalentPairs };
}

function findContainingPair(boundary: NormalizedCwdBoundary): CwdBoundaryPair | undefined {
  return boundary.equivalentPairs.find(({ resolvedCwd, workspaceRoot }) =>
    isInsideOrSamePath(resolvedCwd, workspaceRoot, boundary.pathApi),
  );
}

function isInsideOrSamePath(child: string, parent: string, pathApi: ToolPathApi): boolean {
  const relativePath = pathApi.relative(parent, child);
  return relativePath === "" || !isPathOutsideParent(relativePath, pathApi);
}


function normalizeCwdBoundary(value: string, isWindows: boolean): string {
  let normalized = normalizeToolPathForComparison(value, isWindows ? "win32" : "linux");
  if (!isWindows) {
    normalized = normalized
      .replace(/^\/private\/var\//, "/var/")
      .replace(/^\/private\/tmp(\/|$)/, "/tmp$1");
  }
  return normalized;
}

function realpathCwdBoundary(value: string, isWindows: boolean): string | undefined {
  try {
    return normalizeCwdBoundary(realpathSync.native(value), isWindows);
  } catch {
    return undefined;
  }
}

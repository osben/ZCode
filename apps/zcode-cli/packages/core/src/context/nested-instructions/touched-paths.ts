// ============================================================
// Nested instructions: which paths a successful tool call touched
// ============================================================
// Pure helpers only. They never touch the filesystem; `kind: "unknown"` locations are resolved by discovery with a stat.

import { isRecord } from "../../tool/executor/utils.js";
import {
  getToolPathApi,
  isPathOutsideParent,
  normalizeToolPathForComparison,
} from "../../tool/path-normalization.js";

export interface NestedInstructionLocation {
  /** Absolute path. */
  path: string;
  /**
   * `file`: the directory of this path is checked. `directory`: the path itself is checked.
   * `unknown`: the path may be either, so discovery stats it first.
   */
  kind: "file" | "directory" | "unknown";
}

export interface NestedInstructionTargets {
  locations: NestedInstructionLocation[];
  /** Absolute file paths this call read or wrote. A candidate the call already returned is not injected again. */
  touchedFiles: string[];
}

const FILE_PATH_TOOLS = new Set(["Read", "Edit", "Write"]);
const SEARCH_PATH_TOOLS = new Set(["Glob", "Grep"]);

export function resolveNestedInstructionTargets(input: {
  toolName: string;
  toolInput: unknown;
  /** Handler output; ApplyPatch reports the files it actually wrote, already resolved by the handler. */
  toolOutput?: unknown;
  /** Live session cwd after the call; relative paths and Bash resolve against it. */
  workingDirectory: string;
  platform: NodeJS.Platform;
}): NestedInstructionTargets {
  const api = getToolPathApi(input.platform);
  const record = isRecord(input.toolInput) ? input.toolInput : undefined;
  const resolveInput = (value: string) =>
    api.isAbsolute(value) ? api.normalize(value) : api.resolve(input.workingDirectory, value);
  const fileTargets = (paths: string[]): NestedInstructionTargets => ({
    locations: paths.map((path) => ({ path, kind: "file" })),
    touchedFiles: paths,
  });
  // Bash has no cwd input, and Glob/Grep without a path search the session cwd. The live cwd covers `cd sub && ...`
  // because the runtime updates it after the call.
  const cwdTargets = (): NestedInstructionTargets => ({
    locations: [{ path: api.normalize(input.workingDirectory), kind: "directory" }],
    touchedFiles: [],
  });

  if (FILE_PATH_TOOLS.has(input.toolName)) {
    const filePath = stringField(record, "file_path");
    return fileTargets(filePath ? [resolveInput(filePath)] : []);
  }

  if (input.toolName === "ApplyPatch") {
    return fileTargets(applyPatchOutputPaths(input.toolOutput).map(resolveInput));
  }

  if (SEARCH_PATH_TOOLS.has(input.toolName)) {
    const searchPath = stringField(record, "path");
    if (!searchPath) return cwdTargets();
    return { locations: [{ path: resolveInput(searchPath), kind: "unknown" }], touchedFiles: [] };
  }

  if (input.toolName === "Bash") return cwdTargets();

  return { locations: [], touchedFiles: [] };
}

/**
 * Comparison key for a path. win32 and darwin are case-insensitive by default, so keys are case-folded there.
 * Without this, `Packages/Foo` and `packages/foo` would deliver the same file twice.
 */
export function nestedInstructionKey(absolutePath: string, platform: NodeJS.Platform): string {
  const normalized = normalizeToolPathForComparison(absolutePath, platform);
  return platform === "win32" || platform === "darwin" ? normalized.toLowerCase() : normalized;
}

/**
 * Whether `candidate` is strictly below `root` (lexical check). The root itself returns false,
 * because the startup loader owns it.
 */
export function isStrictlyInsideWorkspace(
  candidate: string,
  root: string,
  platform: NodeJS.Platform,
): boolean {
  const api = getToolPathApi(platform);
  const relativePath = api.relative(api.normalize(root), api.normalize(candidate));
  return relativePath !== "" && !isPathOutsideParent(relativePath, api);
}

function applyPatchOutputPaths(output: unknown): string[] {
  if (!isRecord(output) || !Array.isArray(output.files)) return [];
  const paths: string[] = [];
  for (const file of output.files) {
    if (!isRecord(file)) continue;
    const filePath = stringField(file, "filePath");
    const movePath = stringField(file, "movePath");
    if (filePath) paths.push(filePath);
    if (movePath) paths.push(movePath);
  }
  return paths;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

// ============================================================
// Nested instructions: discovery, budget and reminder body
// ============================================================
// Runs after a successful tool call. Never throws: any failure only skips that candidate (see the catch blocks).

import {
  isFileSystemPortError,
  type FileSystemPort,
  type Logger,
} from "@zcode/contracts";
import { getToolPathApi, type ToolPathApi } from "../../tool/path-normalization.js";
import { formatNestedInstructionMarker, type NestedInstructionHistory } from "./history.js";
import type { NestedInstructionLocation } from "./touched-paths.js";
import { isStrictlyInsideWorkspace, nestedInstructionKey } from "./touched-paths.js";
import type { NestedInstructionTracker } from "./tracker.js";

/** Largest number of bytes of one nested file that is injected. Longer files are cut and marked. */
export const NESTED_INSTRUCTION_MAX_FILE_BYTES = 16 * 1024;
/** Largest total of injected nested bytes that may be visible in one provider-visible history. */
export const NESTED_INSTRUCTION_MAX_CONTEXT_BYTES = 64 * 1024;

const REMINDER_INTRO =
  "Nested AGENTS.md instructions apply to the folders this tool call touched. Each applies to files under its own folder " +
  "and is more specific than the workspace instructions. They do not override system, developer or direct user instructions.";

/** Runtime-supplied nested AGENTS.md state. The tracker is runtime-owned; history is read through `readHistory`. */
export interface NestedInstructionContext {
  priorityFiles: readonly string[];
  /**
   * Startup-loaded instruction files. The startup loader walks from cwd up to the project root, so one of them can sit
   * strictly inside the workspace root; it is already in the system prompt and must not be injected again.
   */
  rootSourcePaths: readonly string[];
  /** Read lazily: a call that finds no nested file never scans history. */
  readHistory(): NestedInstructionHistory;
  tracker: NestedInstructionTracker;
}

export interface NestedInstructionDiscoveryInput extends NestedInstructionContext {
  locations: readonly NestedInstructionLocation[];
  /** Absolute file paths this call read or wrote; a candidate that the call itself returned is not injected again. */
  touchedFiles: readonly string[];
  workspaceRoot: string;
  platform: NodeJS.Platform;
  fileSystem: FileSystemPort;
  now: number;
  signal?: AbortSignal;
  logger?: Logger;
}

interface DirectoryCandidate {
  path: string;
  depth: number;
}

interface FoundCandidate extends DirectoryCandidate {
  file: string;
  key: string;
  sizeBytes: number;
}

type SelectedFile = FoundCandidate & { content: string; bytes: number; truncated: boolean };

interface DiscoveryScope {
  input: NestedInstructionDiscoveryInput;
  api: ToolPathApi;
  root: string;
}

/**
 * Returns lines for `wrapSystemReminderForSource("nested_agents_md", ...)`, or undefined when nothing new is delivered.
 */
export async function discoverNestedInstructions(
  input: NestedInstructionDiscoveryInput,
): Promise<string[] | undefined> {
  const api = getToolPathApi(input.platform);
  const scope: DiscoveryScope = { input, api, root: api.normalize(input.workspaceRoot) };

  if (input.signal?.aborted) return undefined;

  const directories = await resolveDirectories(scope);
  if (directories.length === 0) return undefined;
  // Deepest first: when budget runs out, the broader folders are the ones dropped.
  directories.sort((a, b) => b.depth - a.depth);
  const skipKeys = new Set(
    [...input.rootSourcePaths, ...input.touchedFiles].map((p) => nestedInstructionKey(p, input.platform)),
  );

  // Phase 1: find the existing instruction file of each folder. Folders are independent, so they are stat'ed in parallel.
  // History is not read here, so a call in a folder without nested instructions never scans the transcript.
  const found = (
    await Promise.all(directories.map((dir) => findFolderInstructionFile(scope, dir, skipKeys)))
  ).filter((candidate): candidate is FoundCandidate => candidate !== undefined);
  if (found.length === 0 || input.signal?.aborted) return undefined;

  // Phase 2: only now read history, then apply dedupe and budget to the files that exist.
  const history = input.readHistory();
  const selected: SelectedFile[] = [];
  let plannedBytes = 0;
  let skippedForBudget = 0;

  for (const candidate of found) {
    if (input.signal?.aborted) return undefined;
    if (history.delivered.has(candidate.key)) continue;

    const remaining = NESTED_INSTRUCTION_MAX_CONTEXT_BYTES - history.bytesDelivered - plannedBytes;
    // Estimate before reading so a file that cannot fit is never read.
    if (Math.min(candidate.sizeBytes, NESTED_INSTRUCTION_MAX_FILE_BYTES) > remaining) {
      skippedForBudget += 1;
      continue;
    }

    let read;
    try {
      read = await input.fileSystem.readTextFile(
        { path: candidate.file, maxBytes: NESTED_INSTRUCTION_MAX_FILE_BYTES },
        { signal: input.signal },
      );
    } catch (error) {
      input.logger?.debug("Nested instruction read failed", skipLogContext(scope, candidate.path, error));
      continue;
    }
    if (read.bytesRead > remaining) {
      skippedForBudget += 1;
      continue;
    }
    // No await follows for this file, so reserving here is atomic with the push below.
    if (!input.tracker.reserve(candidate.key)) continue;

    plannedBytes += read.bytesRead;
    selected.push({
      ...candidate,
      sizeBytes: read.sizeBytes,
      content: read.content,
      bytes: read.bytesRead,
      truncated: read.truncated || read.sizeBytes > read.bytesRead,
    });
  }

  if (selected.length === 0) {
    if (skippedForBudget > 0) {
      input.logger?.debug("Nested instructions skipped by budget", {
        event: "instructions.nested.skipped",
        module: "core.tool.executor",
        skippedCount: skippedForBudget,
        visibleBytes: history.bytesDelivered,
      });
    }
    return undefined;
  }

  // The model reads root-to-leaf, so more specific folders come last.
  selected.sort((a, b) => a.depth - b.depth);

  input.logger?.debug("Nested instructions discovered", {
    event: "instructions.nested.discovered",
    module: "core.tool.executor",
    deliveredCount: selected.length,
    deliveredBytes: plannedBytes,
    truncatedCount: selected.filter((file) => file.truncated).length,
    skippedForBudget,
  });

  return buildReminderBody(selected, scope);
}

/** The first existing priority file of a folder decides it, matching the startup upward walk. */
async function findFolderInstructionFile(
  scope: DiscoveryScope,
  dir: DirectoryCandidate,
  skipKeys: ReadonlySet<string>,
): Promise<FoundCandidate | undefined> {
  const { input, api } = scope;
  for (const name of input.priorityFiles) {
    if (input.signal?.aborted) return undefined;
    const file = api.join(dir.path, name);
    const key = nestedInstructionKey(file, input.platform);
    if (skipKeys.has(key)) return undefined;
    if (input.tracker.isKnownMiss(key, input.now)) continue;

    try {
      const stat = await input.fileSystem.stat({ path: file }, { signal: input.signal });
      if (stat.kind === "file") return { ...dir, file, key, sizeBytes: stat.sizeBytes };
      if (stat.kind === "missing") input.tracker.recordMiss(key, input.now);
    } catch (error) {
      if (isMissing(error)) input.tracker.recordMiss(key, input.now);
      else input.logger?.debug("Nested instruction stat failed", skipLogContext(scope, dir.path, error));
    }
  }
  return undefined;
}

async function resolveDirectories(scope: DiscoveryScope): Promise<DirectoryCandidate[]> {
  const { input, api, root } = scope;
  const starts: string[] = [];
  for (const location of input.locations) {
    if (location.kind === "file") {
      starts.push(api.dirname(location.path));
    } else if (location.kind === "directory") {
      starts.push(location.path);
    } else {
      // Glob/Grep `path` may name a file or a folder. A missing path has nothing to discover.
      try {
        const stat = await input.fileSystem.stat({ path: location.path }, { signal: input.signal });
        if (stat.kind === "directory") starts.push(location.path);
        else if (stat.kind === "file") starts.push(api.dirname(location.path));
      } catch (error) {
        input.logger?.debug("Nested instruction target stat failed", skipLogContext(scope, location.path, error));
      }
    }
  }

  // Walk each start up to, but not including, the workspace root. Stop as soon as the path leaves the workspace.
  const seen = new Set<string>();
  const result: DirectoryCandidate[] = [];
  for (const start of starts) {
    let current = api.normalize(start);
    while (isStrictlyInsideWorkspace(current, root, input.platform)) {
      const key = nestedInstructionKey(current, input.platform);
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ path: current, depth: api.relative(root, current).split(api.sep).length });
      }
      const parent = api.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return result;
}

function buildReminderBody(selected: SelectedFile[], { api, root }: DiscoveryScope): string[] {
  const lines: string[] = [REMINDER_INTRO];
  for (const file of selected) {
    lines.push(formatNestedInstructionMarker(file.file, file.bytes));
    lines.push(`Instructions from: ${toPosixDisplay(api.relative(root, file.file))}`);
    lines.push(file.content.replace(/\n+$/, ""));
    if (file.truncated) {
      lines.push(`[truncated: showing first ${file.bytes} of ${file.sizeBytes} bytes]`);
    }
  }
  return lines;
}

function toPosixDisplay(relativePath: string): string {
  return relativePath.split("\\").join("/");
}

function isMissing(error: unknown): boolean {
  return isFileSystemPortError(error) && error.code === "not_found";
}

function skipLogContext({ api, root }: DiscoveryScope, dir: string, error: unknown): Record<string, unknown> {
  return {
    event: "instructions.nested.skipped",
    module: "core.tool.executor",
    relativeDir: toPosixDisplay(api.relative(root, dir)),
    reason: error instanceof Error ? error.name : "unknown",
  };
}

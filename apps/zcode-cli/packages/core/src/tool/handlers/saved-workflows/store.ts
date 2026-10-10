// ============================================================
// Saved workflows - storage layer (scope roots + resolution / listing / writes)
// ============================================================
//
// All filesystem operations are **synchronous**. This is not merely for convenience: the confirmation contract's `prepareApproval`
// must be synchronous (see the core ToolEntry comment: “it inspects the input the executor already holds”), and a run started from a
// `saved` source must load its script **before** the dialog. Without the script there is no causal graph, and the user would approve
// execution in an empty dialog. These are local, single, KB-sized files; synchronous reads cost less than introducing another async
// approval path. The core handler already has the same precedent (`readFileSync` in bash-git-runtime-safety.ts).

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  SAVED_WORKFLOW_FILE_EXTENSION,
  SAVED_WORKFLOW_GLOBAL_DIR,
  SAVED_WORKFLOW_MAX_NAME_CHARS,
  SAVED_WORKFLOW_PROJECT_DIR,
  isValidSavedWorkflowName,
  type SavedWorkflowEntry,
  type SavedWorkflowInvalidEntry,
  type SavedWorkflowMeta,
  type SavedWorkflowScope,
  type SavedWorkflowShadowing,
} from "@zcode/contracts";
import { parseSavedWorkflow, serializeSavedWorkflow } from "./frontmatter.js";

/** A lookup root: scope label plus absolute directory. */
export interface SavedWorkflowRoot {
  scope: SavedWorkflowScope;
  dir: string;
}

/**
 * Optional arguments for `savedWorkflowRoots` and derived functions. `homeDir` is injected only for tests; production always uses
 * `os.homedir()` (the home directory on the agent process's machine), **not** any `storage.dir` setting.
 */
export interface SavedWorkflowRootsOptions {
  homeDir?: string;
}

/**
 * Lookup roots for this session, **in priority order**: `[project, global]`.
 *
 * Project definitions are under `.zcode/workflows/` in the session working directory; global ones are under `~/.zcode/workflows/`
 * in the home directory. Lookups use first-wins order, so a project definition always overrides a global one with the same name.
 */
export function savedWorkflowRoots(
  cwd: string,
  options?: SavedWorkflowRootsOptions,
): SavedWorkflowRoot[] {
  return [
    { scope: "project", dir: join(cwd, SAVED_WORKFLOW_PROJECT_DIR) },
    { scope: "global", dir: join(options?.homeDir ?? homedir(), SAVED_WORKFLOW_GLOBAL_DIR) },
  ];
}

/** Lookup root for one scope. Scope is a known enum, so `savedWorkflowRoots` always contains it. */
export function savedWorkflowRoot(
  cwd: string,
  scope: SavedWorkflowScope,
  options?: SavedWorkflowRootsOptions,
): SavedWorkflowRoot {
  const root = savedWorkflowRoots(cwd, options).find((candidate) => candidate.scope === scope);
  // scope is a SavedWorkflowScope enum member and roots covers every member, so find cannot return undefined.
  return root!;
}

/** A successfully resolved saved definition. */
export interface ResolvedSavedWorkflow {
  name: string;
  path: string;
  scope: SavedWorkflowScope;
  meta: SavedWorkflowMeta;
  script: string;
  /**
   * Original file contents (metadata block + body), **byte for byte**. Draft copies use this value and must match the bytes just read;
   * re-serializing would change `args` defaults, comments, and hand-written YAML formatting. The copy is what the model will return via `path`.
   */
  source: string;
  /** Number of lines before the body; add this when converting diagnostics to file lines (see {@link parseSavedWorkflow}). */
  bodyLineOffset: number;
}

export type SavedWorkflowResolveFailure =
  | { ok: false; reason: "invalid_name"; detail: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "parse_error"; path: string; detail: string }
  | { ok: false; reason: "read_error"; path: string; detail: string };

export type SavedWorkflowResolveResult =
  | ({ ok: true } & ResolvedSavedWorkflow)
  | SavedWorkflowResolveFailure;

export interface SavedWorkflowListResult {
  entries: SavedWorkflowEntry[];
  invalid: SavedWorkflowInvalidEntry[];
}

/** Name → filename. The name has already passed {@link isValidSavedWorkflowName}; no fallback is needed here. */
export function savedWorkflowFileName(name: string): string {
  return `${name}${SAVED_WORKFLOW_FILE_EXTENSION}`;
}

/**
 * Resolve a name under a given root. Share this between reads and writes; independently building the paths is a classic cause of
 * “saved successfully but cannot be read.”
 */
export function savedWorkflowPath(root: SavedWorkflowRoot, name: string): string {
  return join(root.dir, savedWorkflowFileName(name));
}

/**
 * Resolve a saved workflow by name.
 *
 * Validate the name before building a path: this order is itself the path-traversal defense, not merely input hygiene—joining
 * `../../.ssh/id_rsa` would produce a readable absolute path.
 *
 * With `scope`, search only that root (targeted lookups from the hub and `saved.scope`); without it, search both roots in first-wins order.
 */
export function resolveSavedWorkflow(options: {
  cwd: string;
  name: string;
  scope?: SavedWorkflowScope;
  homeDir?: string;
}): SavedWorkflowResolveResult {
  const { cwd, name, scope, homeDir } = options;
  if (!isValidSavedWorkflowName(name)) {
    return {
      ok: false,
      reason: "invalid_name",
      detail: `workflow names may only contain letters, digits, '.', '-' and '_', and must be 1-${SAVED_WORKFLOW_MAX_NAME_CHARS} characters`,
    };
  }

  const roots =
    scope === undefined
      ? savedWorkflowRoots(cwd, { homeDir })
      : [savedWorkflowRoot(cwd, scope, { homeDir })];

  for (const root of roots) {
    const path = savedWorkflowPath(root, name);
    let source: string;
    try {
      source = readFileSync(path, "utf8");
    } catch (error) {
      // It is absent from this root, so try the next one. Other read errors (permissions, directory) are problems with **this** file;
      // report them instead of pretending it was not found, which would make the user check a name that exists.
      if (isNotFound(error)) continue;
      return { ok: false, reason: "read_error", path, detail: describeError(error) };
    }

    const parsed = parseSavedWorkflow(source);
    if (!parsed.ok) {
      return { ok: false, reason: "parse_error", path, detail: parsed.detail };
    }
    return {
      ok: true,
      name,
      path,
      scope: root.scope,
      meta: parsed.meta,
      script: parsed.script,
      source,
      bodyLineOffset: parsed.bodyLineOffset,
    };
  }

  return { ok: false, reason: "not_found" };
}

/**
 * List saved definitions (flat depth-1 scan; do not recurse into subdirectories).
 *
 * Put malformed files in `invalid` instead of throwing: users edit these files by hand, and one typo should not hide the whole catalog.
 *
 * Without `scope`, search both roots in priority order; the first definition wins, and a shadowed copy is **omitted**. The list should
 * answer “what runs when I call this name,” not “how many copies are on disk.” With `scope`, scan only that root and **do not** apply
 * shadowing (the hub's global group must show definitions hidden by project copies).
 */
export function listSavedWorkflows(options: {
  cwd: string;
  scope?: SavedWorkflowScope;
  homeDir?: string;
}): SavedWorkflowListResult {
  const entries: SavedWorkflowEntry[] = [];
  const invalid: SavedWorkflowInvalidEntry[] = [];
  const claimed = new Set<string>();

  const roots =
    options.scope === undefined
      ? savedWorkflowRoots(options.cwd, { homeDir: options.homeDir })
      : [savedWorkflowRoot(options.cwd, options.scope, { homeDir: options.homeDir })];

  for (const root of roots) {
    let fileNames: string[];
    try {
      fileNames = readdirSync(root.dir);
    } catch (error) {
      // A missing directory is normal (most projects have no saved workflows), not an error.
      if (isNotFound(error)) continue;
      invalid.push({ path: root.dir, reason: describeError(error) });
      continue;
    }

    // readdir order depends on the filesystem; sorting makes the list consistent across machines.
    for (const fileName of [...fileNames].sort()) {
      if (!fileName.endsWith(SAVED_WORKFLOW_FILE_EXTENSION)) continue;
      const name = fileName.slice(0, -SAVED_WORKFLOW_FILE_EXTENSION.length);
      const path = join(root.dir, fileName);

      if (!isValidSavedWorkflowName(name)) {
        invalid.push({ path, reason: "file name is not a usable workflow name" });
        continue;
      }
      // A higher-priority scope already claims this name, so this copy cannot run and should not be listed.
      if (claimed.has(name)) continue;

      let source: string;
      try {
        source = readFileSync(path, "utf8");
      } catch (error) {
        // The directory entry exists but cannot be read (subdirectory, permissions): it is broken, not absent.
        invalid.push({ path, reason: describeError(error) });
        continue;
      }

      const parsed = parseSavedWorkflow(source);
      if (!parsed.ok) {
        invalid.push({ path, reason: `${parsed.reason}: ${parsed.detail}` });
        continue;
      }

      claimed.add(name);
      entries.push({
        name,
        description: parsed.meta.description,
        ...(parsed.meta.whenToUse === undefined ? {} : { whenToUse: parsed.meta.whenToUse }),
        ...(parsed.meta.args === undefined ? {} : { args: parsed.meta.args }),
        scope: root.scope,
        path,
      });
    }
  }

  return { entries, invalid };
}

/**
 * Write a saved definition and return its path and whether this call overwrote an existing file.
 *
 * `scope` chooses the root (defaults to `project`, preserving existing behavior). Scope is now a **write-side choice** and required
 * from the model by SaveWorkflow.
 */
export function saveSavedWorkflow(options: {
  cwd: string;
  name: string;
  meta: SavedWorkflowMeta;
  script: string;
  scope?: SavedWorkflowScope;
  homeDir?: string;
}): { path: string; scope: SavedWorkflowScope; overwritten: boolean } {
  const root = savedWorkflowRoot(options.cwd, options.scope ?? "project", {
    homeDir: options.homeDir,
  });
  const path = savedWorkflowPath(root, options.name);
  mkdirSync(root.dir, { recursive: true });
  const overwritten = fileExists(path);
  writeFileSync(path, serializeSavedWorkflow(options.meta, options.script), "utf8");
  return { path, scope: root.scope, overwritten };
}

/** Whether the target already exists (the confirmation dialog distinguishes “overwrite” from “create”). Defaults to project scope. */
export function savedWorkflowExists(options: {
  cwd: string;
  name: string;
  scope?: SavedWorkflowScope;
  homeDir?: string;
}): boolean {
  if (!isValidSavedWorkflowName(options.name)) return false;
  const root = savedWorkflowRoot(options.cwd, options.scope ?? "project", {
    homeDir: options.homeDir,
  });
  return fileExists(savedWorkflowPath(root, options.name));
}

/**
 * Whether the other scope has the same name when saving to `scope` (shadowing fact for the confirmation dialog).
 *
 * Saving a project copy when a global copy exists → `hides_global` (the project copy wins here). Saving a global copy when a project
 * copy exists → `hidden_by_project` (the global copy cannot run in this project). If neither exists, return `undefined`.
 */
export function findSavedWorkflowShadowing(options: {
  cwd: string;
  name: string;
  scope: SavedWorkflowScope;
  homeDir?: string;
}): SavedWorkflowShadowing | undefined {
  if (!isValidSavedWorkflowName(options.name)) return undefined;
  const otherScope: SavedWorkflowScope = options.scope === "project" ? "global" : "project";
  const otherRoot = savedWorkflowRoot(options.cwd, otherScope, { homeDir: options.homeDir });
  if (!fileExists(savedWorkflowPath(otherRoot, options.name))) return undefined;
  return options.scope === "project" ? "hides_global" : "hidden_by_project";
}

/** Result of moving a global definition into a project. */
export type SavedWorkflowMoveResult =
  | { ok: true; from: string; to: string }
  | { ok: false; reason: "invalid_name"; detail: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "target_exists"; path: string }
  | { ok: false; reason: "read_error" | "write_error"; path: string; detail: string };

/**
 * Move `name` from the global root into the project root under `cwd` (**only in this direction**).
 *
 * The reverse direction (project → global) is not a file move: project definitions usually reference repository paths, commands, or
 * conventions, and copying them byte-for-byte would create a global definition that fails in other projects. That direction is a model
 * summary (“promote to global”: the GUI opens a new session in that project with a summary prompt, and the model saves a global copy via
 * SaveWorkflow). Global → project is specialization: a global definition can still run in a particular project, so it remains a file move.
 *
 * Move **byte-for-byte** (no parsing or re-serialization): frontmatter stores no scope, so moving means moving the file.
 * Prefer `renameSync`, with read → write → delete fallback across devices (EXDEV). Reject an existing destination (do not overwrite;
 * overwriting is an action SaveWorkflow performs only after confirmation). Validate the name first as the path-traversal defense.
 */
export function moveSavedWorkflow(options: {
  cwd: string;
  name: string;
  homeDir?: string;
}): SavedWorkflowMoveResult {
  const { cwd, name, homeDir } = options;
  if (!isValidSavedWorkflowName(name)) {
    return {
      ok: false,
      reason: "invalid_name",
      detail: `workflow names may only contain letters, digits, '.', '-' and '_', and must be 1-${SAVED_WORKFLOW_MAX_NAME_CHARS} characters`,
    };
  }

  const fromRoot = savedWorkflowRoot(cwd, "global", { homeDir });
  const toRoot = savedWorkflowRoot(cwd, "project", { homeDir });
  const fromPath = savedWorkflowPath(fromRoot, name);
  const toPath = savedWorkflowPath(toRoot, name);

  if (!fileExists(fromPath)) return { ok: false, reason: "not_found" };
  if (fileExists(toPath)) return { ok: false, reason: "target_exists", path: toPath };

  try {
    mkdirSync(toRoot.dir, { recursive: true });
  } catch (error) {
    return { ok: false, reason: "write_error", path: toPath, detail: describeError(error) };
  }

  try {
    renameSync(fromPath, toPath);
    return { ok: true, from: fromPath, to: toPath };
  } catch (error) {
    // rename reports EXDEV across devices (for example, home and project directories on separate mounts). Fall back to read → write →
    // delete, and classify read/write failures separately so callers can distinguish “cannot read source” from “cannot write destination.”
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "EXDEV") {
      return { ok: false, reason: "write_error", path: toPath, detail: describeError(error) };
    }
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(fromPath);
  } catch (error) {
    return { ok: false, reason: "read_error", path: fromPath, detail: describeError(error) };
  }
  try {
    writeFileSync(toPath, bytes);
    unlinkSync(fromPath);
  } catch (error) {
    return { ok: false, reason: "write_error", path: toPath, detail: describeError(error) };
  }
  return { ok: true, from: fromPath, to: toPath };
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  // ENOTDIR means a path component is a file (for example, `.zcode/workflows` was created as a file). For lookup, this is equivalent
  // to a missing directory.
  return code === "ENOENT" || code === "ENOTDIR";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

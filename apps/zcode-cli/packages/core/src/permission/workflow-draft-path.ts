// ============================================================
// Workflow draft path - pure check for whether a write target is inside the draft directory.
// ============================================================
//
// This is a separate module for two reasons: PermissionService needs only a boolean, not the path comparison details;
// and this check is the **only** gate for skipping confirmation, so it must be testable case by case outside the service (including Windows semantics).
// It never touches the filesystem: no realpath or stat. Permission checks must be pure so the same input
// gives the same answer on every machine and a failed disk read cannot turn a denial into an allow.

import nodePath from "node:path";

import { WORKFLOW_DRAFTS_DIR } from "@zcode/contracts";

/**
 * The subset of `node:path` needed for the check. It is a parameter so tests can inject `path.win32` / `path.posix`:
 * Windows semantics such as drive letters, backslashes, and case are verified only when run with the win32 implementation.
 */
export interface WorkflowDraftPathModule {
  isAbsolute: (path: string) => boolean;
  relative: (from: string, to: string) => string;
  resolve: (...paths: string[]) => string;
}

export interface WorkflowDraftPathInput {
  /** Write target from tool input; resolve relative paths against workingDirectory and keep absolute paths unchanged. */
  filePath: string;
  /** Session working directory; if absent (empty string), the check does not match, as described below. */
  workingDirectory: string;
  /** Platform path implementation; defaults to the current platform's `node:path`. */
  pathModule?: WorkflowDraftPathModule;
}

/**
 * Built-in file-writing tools eligible for draft-directory confirmation bypass. Both use the `edit` permission name
 * and a single `file_path` target, so checking whether the target is in the draft directory is meaningful. ApplyPatch also uses `edit`
 * but is excluded: its `patch_text` input can change multiple files and has no single path to check.
 */
const WORKFLOW_DRAFT_PREAPPROVED_TOOL_NAMES = new Set(["Edit", "Write"]);

export interface WorkflowDraftWriteInput {
  toolName: string;
  /** Tool input before validation against a specific tool schema; only `file_path` is read. */
  input: unknown;
  /** Session working directory; callers may omit it if unavailable, which means confirmation is not bypassed. */
  workingDirectory?: string;
  pathModule?: WorkflowDraftPathModule;
}

/**
 * Check whether this tool call writes into the draft directory and can therefore skip the confirmation dialog.
 *
 * Why it is safe: this is a machine-owned directory whose files are written by the tool itself; its .gitignore excludes everything,
 * the files are not versioned, and users do not store protected data there. Changing a draft does not affect the project.
 * Running a script has a separate gate: CreateWorkflow declares alwaysAsk, and the confirmation dialog reviews the submitted script
 * regardless of how this file was edited. Allowing a write here does not authorize execution.
 *
 * If workingDirectory is absent (not supplied by the caller), the check never matches: confirmation can be skipped only when the target location can be determined;
 * if it cannot, show the dialog.
 */
export function isPreapprovedWorkflowDraftWrite(input: WorkflowDraftWriteInput): boolean {
  if (!WORKFLOW_DRAFT_PREAPPROVED_TOOL_NAMES.has(input.toolName)) return false;
  if (typeof input.workingDirectory !== "string") return false;
  if (!input.input || typeof input.input !== "object") return false;
  const filePath = (input.input as Record<string, unknown>).file_path;
  if (typeof filePath !== "string") return false;
  return isWorkflowDraftPath({
    filePath,
    pathModule: input.pathModule,
    workingDirectory: input.workingDirectory,
  });
}

/** Check whether `filePath` is inside `<workingDirectory>/.zcode/workflow-drafts/`. */
export function isWorkflowDraftPath(input: WorkflowDraftPathInput): boolean {
  const path = input.pathModule ?? nodePath;
  // Without a working directory there is no way to identify the project's draft directory; deny the bypass because the target must be locatable.
  if (input.workingDirectory.length === 0 || input.filePath.length === 0) return false;

  const draftsDir = path.resolve(input.workingDirectory, WORKFLOW_DRAFTS_DIR);
  const resolved = path.resolve(input.workingDirectory, input.filePath);
  const relativePath = path.relative(draftsDir, resolved);

  // All three conditions are required: non-empty excludes the directory itself; non-absolute excludes another drive
  // (on Windows, `relative("C:\\a", "D:\\b")` returns an absolute path, not `..`); not starting with `..` excludes traversal.
  // This checks path strings, not the filesystem: `.zcode/workflow-drafts-other/x.ts` will not be mistaken for a child based on its prefix;
  // `relative` returns `../workflow-drafts-other/x.ts`.
  return (
    relativePath.length > 0 && !path.isAbsolute(relativePath) && !relativePath.startsWith("..")
  );
}

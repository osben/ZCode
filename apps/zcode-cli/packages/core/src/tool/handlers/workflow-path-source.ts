// ============================================================
// `path` source: read a script file from disk as an execution fact
// ============================================================
//
// Four tools share this logic (`CreateWorkflow.path`, `AmendWorkflow.path`, `SaveWorkflow.script_path`, and
// `EvalWorkflowSnippet.path`). The reason is not fewer lines: all four must agree about what a file is. Otherwise the same draft is a
// “saved definition with a metadata block” in Create but a script whose first line is a comment in Save—a divergence discovered only
// when the user saves a draft as a definition.
//
// Read once, and only once: carry those bytes through hooks, confirmation, and the handler (`resolveInput` contract), so editing the
// file after approval cannot change what will execute.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SavedWorkflowMeta } from "@zcode/contracts";
import { SAVED_WORKFLOW_SENTINEL, parseSavedWorkflow } from "./saved-workflows/index.js";
import { describeWorkflowScriptPath } from "./workflow-script-path.js";

/** A successfully read script file. */
export interface WorkflowScriptFile {
  /** Absolute path (the journal stores it; the model uses {@link described}). */
  path: string;
  /** Model-facing form: relative to the workspace when inside it, absolute otherwise. */
  described: string;
  /** Original file contents, byte for byte. */
  source: string;
  /** Content to execute/save: the body when there is a metadata block, otherwise the entire file. */
  script: string;
  /** Declarations parsed from the metadata block; absent when the file has no block. */
  meta?: SavedWorkflowMeta;
  /** Number of lines before the body (0 when there is no block); add this when reporting diagnostics by file line. */
  bodyLineOffset: number;
}

export type WorkflowScriptFileResult =
  | { ok: true; file: WorkflowScriptFile }
  | { ok: false; message: string };

/**
 * Resolve relative paths against the session working directory and normalize absolute paths as-is, matching the path rule used by
 * `Read` (core/src/tool/path-policy.ts `resolveWorkspacePath`).
 *
 * This does not use that helper because it requires `workspaceRoot`, while `resolveInput`'s context (`ToolInputResolutionContext`)
 * intentionally contains only `workingDirectory`. For `operation: "read"`, both have the same behavior: the helper currently does not
 * block paths outside the workspace, and only resolves/normalizes them.
 */
export function resolveWorkflowScriptFilePath(cwd: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? path.normalize(inputPath) : path.resolve(cwd, inputPath);
}

/**
 * Read a script file. If reading fails or its metadata block is malformed, return a structured failure that **names the file**;
 * without that information, the model may assume it just made a mistake and retry the same input.
 *
 * `parseFrontmatter: false` is for `EvalWorkflowSnippet`: snippets do not use saved-definition semantics, so the entire file is code;
 * even one that happens to start with `/* zcode-workflow` must not be consumed as a declaration block.
 */
export async function readWorkflowScriptFile(options: {
  cwd: string;
  inputPath: string;
  parseFrontmatter?: boolean;
}): Promise<WorkflowScriptFileResult> {
  const absolute = resolveWorkflowScriptFilePath(options.cwd, options.inputPath);
  const described = describeWorkflowScriptPath(absolute, options.cwd);

  let source: string;
  try {
    source = await readFile(absolute, "utf8");
  } catch (error) {
    return {
      ok: false,
      message: `The workflow script file ${described} could not be read: ${describeError(error)}. Pass \`path\` for a file that exists, or submit the script inline.`,
    };
  }

  const base = { path: absolute, described, source };
  if (options.parseFrontmatter === false || !startsWithSentinel(source)) {
    return { ok: true, file: { ...base, script: source, bodyLineOffset: 0 } };
  }

  const parsed = parseSavedWorkflow(source);
  if (!parsed.ok) {
    return {
      ok: false,
      message: `The workflow script file ${described} starts with a \`${SAVED_WORKFLOW_SENTINEL}\` metadata block that could not be read (${parsed.reason}): ${parsed.detail}. Fix the block in that file, or remove it and pass the script alone.`,
    };
  }
  return {
    ok: true,
    file: {
      ...base,
      script: parsed.script,
      meta: parsed.meta,
      bodyLineOffset: parsed.bodyLineOffset,
    },
  };
}

/**
 * Check whether the first nonblank line is an opening marker. Keep the predicate identical to {@link parseSavedWorkflow}'s entry
 * point; if the two disagree about whether this is a saved definition, the tool may say there is no block while the parser reports a malformed one.
 */
function startsWithSentinel(source: string): boolean {
  for (const line of source.split("\n")) {
    if (line.trim() === "") continue;
    return line.trim() === SAVED_WORKFLOW_SENTINEL;
  }
  return false;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

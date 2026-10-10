// ============================================================
// Write to the workflow draft directory
// ============================================================
// Every script accepted by a tool needs a home on disk. That file is the **handle** between model submissions: diagnostics use file
// line numbers, and the next submission needs only `path`, so editing one line does not require streaming the 20k-token script again.
// Inline text is therefore only an entry point—when `CreateWorkflow`, `AmendWorkflow`, or direct hub launch receives a script that is
// not from a file, write it here.
//
// Store drafts in `<cwd>/.zcode/workflow-drafts/`, alongside `.zcode/workflows/` (user-saved definitions) and
// `.zcode/workflow-runs/` (compiled entry point for each run). The directory has its own `.gitignore: *`, matching
// dynamic-workflow-runtime/src/child-entry-file.ts (see its comment for the decision): write it once only when missing, leave it alone
// if the user edits it, and never touch the project's `.gitignore`.
//
// **Best effort**: a write failure (read-only checkout, `.zcode` is a regular file, full disk) does not fail the call; return
// `undefined` and let the model fall back to the old instruction to fix the script and submit it inline. Intentionally **do not** fall
// back to a temporary directory: a draft the user cannot find in the project is not worth a path.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SAVED_WORKFLOW_FILE_EXTENSION,
  WORKFLOW_DRAFTS_DIR,
  createWorkflowPhaseNames,
  type CreateWorkflowCausalityGraph,
} from "@zcode/contracts";

/**
 * Characters **not** preserved in draft filenames: everything except Unicode letters/digits and `_ . -`.
 *
 * Intentionally differs from saved-definition names (ASCII only): saved names are used as CLI arguments and URL fragments, while
 * draft names only need to work on all three filesystems and remain recognizable to people and models. In practice, run and phase
 * names are often Chinese (testing showed that ASCII-only names reduced every draft to `workflow-N`, making distinct workflows
 * indistinguishable in the directory). The excluded characters include path separators and Windows reserved characters
 * (`/ \\ : * ? " < > |`), whitespace, and controls, so path traversal remains impossible.
 */
const WORKFLOW_DRAFT_SLUG_DROP_PATTERN = /[^\p{L}\p{N}_.-]/gu;

/** Collapse whitespace to `-`: `PR review #12` → `PR-review-12`, easier to recognize than `PRreview12`. */
const WORKFLOW_DRAFT_WHITESPACE_PATTERN = /\s+/gu;

/** Filename length cap; same value and rationale as `SAVED_WORKFLOW_MAX_NAME_CHARS` (platform PATH_MAX limits). */
const WORKFLOW_DRAFT_MAX_SLUG_CHARS = 64;

/**
 * Fallback when the name contains no usable characters (most commonly a name written in Chinese).
 */
const WORKFLOW_DRAFT_FALLBACK_SLUG = "workflow";

/**
 * Maximum suffix attempts for duplicate names. Reaching the limit means someone is repeatedly submitting the same name; giving up
 * (`undefined`) is preferable to an infinite loop because drafts are convenient, not required for correctness.
 */
const WORKFLOW_DRAFT_MAX_ATTEMPTS = 1_000;

interface WriteWorkflowDraftInput {
  /**
   * Session working directory; drafts go under its `.zcode/workflow-drafts/`. When absent, the host has no working-directory concept
   * (port stub / missing session context), so there is nowhere to write; treat it like a write failure.
   */
  cwd: string | undefined;
  /** Display name for the run, used to build the filename. */
  name: string;
  /** Bytes to write, unchanged (including the metadata block for a saved source). */
  source: string;
}

/**
 * Write a draft and return its absolute path; return `undefined` on failure (never throw).
 *
 * **Create a new file for every inline submission**, including a repeated submission that should have used `path`. Never overwrite a
 * draft behind the model's back; an accidental duplicate could erase the file the user is editing. Resolve name collisions with `-2`,
 * `-3`, etc., and use `wx` (exclusive creation) so concurrent submissions cannot write to the same file, unlike a “stat then write” approach.
 */
export async function writeWorkflowDraft(
  input: WriteWorkflowDraftInput,
): Promise<{ path: string } | undefined> {
  if (input.cwd === undefined || input.cwd === "") return undefined;
  try {
    const dir = path.join(input.cwd, WORKFLOW_DRAFTS_DIR);
    await mkdir(dir, { recursive: true });
    await writeDraftGitignore(dir);
    const slug = workflowDraftSlug(input.name);
    for (let attempt = 1; attempt <= WORKFLOW_DRAFT_MAX_ATTEMPTS; attempt += 1) {
      const fileName = `${attempt === 1 ? slug : `${slug}-${attempt}`}${SAVED_WORKFLOW_FILE_EXTENSION}`;
      const filePath = path.join(dir, fileName);
      try {
        // `wx`: an existing file produces EEXIST, making “choose a name” and “claim the name” one atomic operation.
        await writeFile(filePath, input.source, { encoding: "utf8", flag: "wx" });
        return { path: filePath };
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
    return undefined;
  } catch {
    // Best effort: an unwritable directory, `.zcode` being a file, a full disk, etc. all mean there is no draft for this call. The
    // caller can use the previous message and complete the tool call normally.
    return undefined;
  }
}

/**
 * Choose a draft name: prefer model-provided `name`; otherwise use the first `phase("…")` literal in the script. Every script must
 * include a phase, and phase names use the user's language (CreateWorkflow's Phases rule), so this is the closest thing to a name.
 * Use the fallback only when no phase exists either.
 *
 * Intentionally do not use the run label as fallback (the first script line): in practice it is often a comment banner such as
 * `// ==== Result type ====`.
 */
export function resolveWorkflowDraftName(
  name: string | undefined,
  graph: Pick<CreateWorkflowCausalityGraph, "phases"> | undefined,
): string {
  if (name !== undefined && name.trim() !== "") return name;
  return createWorkflowPhaseNames(graph)?.[0] ?? WORKFLOW_DRAFT_FALLBACK_SLUG;
}

/**
 * Name → filename stem. Collapse whitespace to `-`, discard everything except Unicode letters/digits and `_ . -`, and truncate at
 * the limit by code point rather than UTF-16 unit so a character is not split into half a surrogate pair. Use the fallback when nothing
 * remains or only dots remain (`.` / `..` are directory entries, not filenames).
 */
function workflowDraftSlug(name: string): string {
  const reduced = Array.from(
    name
      .trim()
      .replace(WORKFLOW_DRAFT_WHITESPACE_PATTERN, "-")
      .replace(WORKFLOW_DRAFT_SLUG_DROP_PATTERN, ""),
  )
    .slice(0, WORKFLOW_DRAFT_MAX_SLUG_CHARS)
    .join("")
    .replace(/^[.-]+|[.-]+$/gu, "");
  if (reduced === "" || /^\.+$/u.test(reduced)) return WORKFLOW_DRAFT_FALLBACK_SLUG;
  return reduced;
}

/** `.gitignore` inside the draft directory; write once only when absent and never modify it after the user edits it. */
async function writeDraftGitignore(dir: string): Promise<void> {
  try {
    await writeFile(path.join(dir, ".gitignore"), "*\n", { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Writing the sandbox entry file to disk.
 *
 * Why this file exists: the Windows command-line limit is 32,767 characters, so the payload can no
 * longer be passed through argv. The harness writes the ESM rendered by
 * {@link import("./child-source.js").renderChildEntry} to
 * `<cwd>/.zcode/workflow-runs/<runId>.mjs`; the spawn command line then contains only this path.
 *
 * Decisions:
 *   - Use `.zcode/workflow-runs/`, separate from project-level saved workflows in `.zcode/workflows/`;
 *   - **Keep** files rather than deleting them (overwrite in place for the same runId); the directory
 *     also archives each run's actual executable;
 *   - This module writes a `.gitignore` (`*`) in the directory only if absent and never touches the
 *     project's own `.gitignore`;
 *   - If the project directory is unwritable (read-only checkout, missing cwd, `.zcode` is a regular
 *     file, etc.), fall back to `os.tmpdir()/zcode-workflow-runs/`, report via `onWarning`, and start
 *     the run as usual. If fallback also fails, throw and let the harness normalize the outcome as
 *     failed.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Non-fatal condition reported by the harness to the caller; bootstrap records it as a warning log. */
export interface HarnessWarning {
  kind: "entry_file_fallback";
  /** Intended project directory (`<cwd>/.zcode/workflow-runs`). */
  projectDir: string;
  /** Directory actually used for fallback. */
  fallbackDir: string;
  /** Error text from the failed project-directory write. */
  error: string;
}

export interface WriteChildEntryFileInput {
  cwd: string;
  runId: string;
  /** Rendered entry-file source. */
  source: string;
  onWarning?: (warning: HarnessWarning) => void;
}

export interface ChildEntryFile {
  path: string;
  location: "project" | "tmpdir";
}

/** Entry-file directory inside the project. */
export function workflowRunsDir(cwd: string): string {
  return join(cwd, ".zcode", "workflow-runs");
}

/** Fallback directory (shared across projects under the OS temporary directory). */
export function fallbackWorkflowRunsDir(): string {
  return join(tmpdir(), "zcode-workflow-runs");
}

/** Replace characters outside the runId safe set with `_` to keep path separators out of the filename. */
export function childEntryFileName(runId: string): string {
  return `${runId.replace(/[^A-Za-z0-9._-]/g, "_")}.mjs`;
}

export function writeChildEntryFile(input: WriteChildEntryFileInput): ChildEntryFile {
  const projectDir = workflowRunsDir(input.cwd);
  const fileName = childEntryFileName(input.runId);
  try {
    return { path: writeInto(projectDir, fileName, input.source), location: "project" };
  } catch (error) {
    const fallbackDir = fallbackWorkflowRunsDir();
    input.onWarning?.({
      kind: "entry_file_fallback",
      projectDir,
      fallbackDir,
      error: error instanceof Error ? error.message : String(error),
    });
    return { path: writeInto(fallbackDir, fileName, input.source), location: "tmpdir" };
  }
}

function writeInto(dir: string, fileName: string, source: string): string {
  mkdirSync(dir, { recursive: true });
  try {
    // `wx`: create only when absent; do not touch this .gitignore if the user has edited it.
    writeFileSync(join(dir, ".gitignore"), "*\n", { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
  }
  const path = join(dir, fileName);
  writeFileSync(path, source, "utf8");
  return path;
}

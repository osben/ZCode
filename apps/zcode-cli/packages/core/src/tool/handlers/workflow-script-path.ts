// ============================================================
// Model-facing path format for workflow script files
// ============================================================
// The journal always stores an **absolute path**: it is part of run identity, and the session working directory can change (`cd`,
// or another session reading the same run), so a stored relative path could point to a different file elsewhere.
//
// But the model should see a workspace path because its next action is to `Edit` the file, and this is the form it uses for other
// file operations. This pure function is the only difference between the two forms; compute it once and share it across all three
// model-facing surfaces (terminal notifications, `GetWorkflowRun`, and tool responses) so they cannot diverge.

import path from "node:path";

/**
 * Format an absolute script path for the model: use a workspace-relative path when it is inside the session working directory;
 * otherwise return the absolute path unchanged.
 *
 * “Inside the working directory” means the result of `path.relative` neither starts with `..` nor is absolute. This handles both
 * cases that cannot be made relative: a sibling outside the directory (`../other/x.dwf.ts`, which misleadingly looks like a workspace
 * file) and a Windows cross-drive path (`C:` → `D:`, where `path.relative` returns an absolute path). An empty result (path equals
 * the working directory) also falls back to the absolute path because an empty string is not an editable filename.
 *
 * If `cwd` is absent, the host has no concept of a working directory (some port stubs or missing session context), so no relative path can be computed.
 */
export function describeWorkflowScriptPath(absolutePath: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === "") return absolutePath;
  const relative = path.relative(cwd, absolutePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return absolutePath;
  }
  return relative;
}

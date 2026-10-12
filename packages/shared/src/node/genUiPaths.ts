import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { buildGenUiScopeKey, genUiScopeSchema, type GenUiScope } from "../gen-ui/index.js";

/** Execution Host supplies this process-scoped root; models never choose it. */
export const GEN_UI_OUTPUT_ROOT_ENV = "ZCODE_GEN_UI_OUTPUT_ROOT";
export const GEN_UI_OUTPUT_DIRECTORY = "visualizations";

export function getGenUiOutputDirectory(outputRoot: string, scope: GenUiScope): string {
  genUiScopeSchema.parse(scope);
  if (!isAbsolute(outputRoot) || !isAbsolute(scope.workspacePath))
    throw new Error("Gen UI output root and workspace must be absolute");
  const root = resolve(outputRoot);
  // Root cause: the fixed output directory was mistakenly treated as an outside-workspace
  // restriction, blocking context initialization when opening Home.
  // The directory is decided by the Host; a workspace may contain it, and the workspace/session
  // subdirectories only organize the generated files.
  return join(root, createHash("sha256").update(buildGenUiScopeKey(scope)).digest("hex"));
}

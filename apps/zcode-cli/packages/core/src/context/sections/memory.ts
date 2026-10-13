// ============================================================
// Memory Section Builder
// ============================================================

import { composeMemoryGuidanceDefault, renderMemoryGuidancePrompt } from "@zcode/shared";
import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";
import type { ProjectMemoryRetrievalBranch } from "../../memory/project-memory-retrieval-branch.js";

export function buildMemorySection(
  memoryRoot: string | undefined,
  retrievalBranch: ProjectMemoryRetrievalBranch,
  override?: string,
): ContextSection | null {
  if (!memoryRoot) return null;

  const content = override?.trim()
    ? // A `memory-guidance` override owns the whole body; `{{memoryRoot}}` placeholders are
      // substituted so the dynamic root path survives the override.
      renderMemoryGuidancePrompt(override.trim(), memoryRoot)
    : buildMemoryContent(memoryRoot, retrievalBranch);

  return {
    name: "Memory",
    source: "memory",
    injectionTarget: "system",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}

function buildMemoryContent(
  memoryRoot: string,
  retrievalBranch: ProjectMemoryRetrievalBranch,
): string {
  // The shared constant composes the branch-specific default; rendering here only substitutes
  // the memory root, so the service's reported default and this output stay byte-identical.
  return renderMemoryGuidancePrompt(composeMemoryGuidanceDefault(retrievalBranch), memoryRoot);
}

// ============================================================
// Memory Section Builder
// ============================================================

import { composeMemoryGuidanceDefault, renderSystemPromptTemplate } from "@zcode/shared";
import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";
import type { ProjectMemoryRetrievalBranch } from "../../memory/project-memory-retrieval-branch.js";

export function buildMemorySection(
  memoryRoot: string | undefined,
  retrievalBranch: ProjectMemoryRetrievalBranch,
  override?: string,
): ContextSection | null {
  if (!memoryRoot) return null;

  // A `memory-guidance` override owns the whole body; `{{memoryRoot}}` is substituted so the
  // dynamic root path survives the override. The shared default composes the branch-specific
  // text, so the service's reported default and this output stay byte-identical.
  const content = renderSystemPromptTemplate(
    override?.trim() || composeMemoryGuidanceDefault(retrievalBranch),
    { memoryRoot },
  );

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

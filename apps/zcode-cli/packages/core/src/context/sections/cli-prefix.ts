// ============================================================
// CLI Prefix Section Builder
// ============================================================

import { DEFAULT_CLI_PREFIX_PROMPT } from "@zcode/shared";
import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

export function buildCliPrefixSection(override?: string): ContextSection {
  const content = override?.trim() ? override.trim() : DEFAULT_CLI_PREFIX_PROMPT;

  return {
    name: "CLI Prefix",
    source: "cli_prefix",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}

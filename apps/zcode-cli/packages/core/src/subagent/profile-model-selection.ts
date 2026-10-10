import { parseSubagentMarkdownSelection, type ModelSelection } from "@zcode/shared";

/** Host and Agent share the canonical Markdown codec; Provider migration must happen at the user-storage boundary first. */
export function resolveProfileModelSelection(
  frontmatter: Record<string, unknown>,
): ModelSelection | undefined {
  return parseSubagentMarkdownSelection(frontmatter);
}

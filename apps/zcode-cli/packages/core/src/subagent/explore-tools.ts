// Keep the tool surface aligned with the file-search subagent. The direct branch exposes Glob/Grep;
// the embedded search branch delegates search to Bash find/grep. The allowlist deliberately excludes
// file-writing tools (Write/Edit/ApplyPatch), so Bash is the only side-effect entry point and the Explore prompt enforces read-only behavior.
export const EXPLORE_AGENT_ALLOWED_TOOLS = [
  "Bash",
  "Glob",
  "Grep",
  "LSP",
  "Read",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
] as const;

export type ExploreAgentAllowedTool = (typeof EXPLORE_AGENT_ALLOWED_TOOLS)[number];

export const EXPLORE_AGENT_EMBEDDED_SEARCH_ALLOWED_TOOLS = [
  "Bash",
  "LSP",
  "Read",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
] as const;

const EXPLORE_AGENT_DESCRIPTION_TOOL_PRIORITY = [
  "Glob",
  "Grep",
  "Read",
  "Bash",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
] as const satisfies readonly ExploreAgentAllowedTool[];
const EXPLORE_AGENT_DESCRIPTION_TOOL_PRIORITY_SET = new Set<ExploreAgentAllowedTool>(
  EXPLORE_AGENT_DESCRIPTION_TOOL_PRIORITY,
);

export function buildExploreAllowedTools(options: {
  embeddedSearchEnabled?: boolean;
} = {}): readonly ExploreAgentAllowedTool[] {
  return options.embeddedSearchEnabled
    ? EXPLORE_AGENT_EMBEDDED_SEARCH_ALLOWED_TOOLS
    : EXPLORE_AGENT_ALLOWED_TOOLS;
}

export function formatExploreAllowedToolsForAgentDescription(options: {
  embeddedSearchEnabled?: boolean;
} = {}): string {
  const allowedTools = buildExploreAllowedTools(options);
  const allowedToolSet = new Set(allowedTools);
  const prioritizedTools = EXPLORE_AGENT_DESCRIPTION_TOOL_PRIORITY.filter((tool) =>
    allowedToolSet.has(tool),
  );
  const unprioritizedTools = allowedTools.filter(
    (tool) => !EXPLORE_AGENT_DESCRIPTION_TOOL_PRIORITY_SET.has(tool),
  );
  return [...prioritizedTools, ...unprioritizedTools].join(", ");
}

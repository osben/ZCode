const EMPTY_TOOL_NAME_PLACEHOLDER = "empty_tool_name";

/**
 * Empty tool-name recovery exists only for model continuation and must not materialize as a user-visible tool row.
 * The fixed placeholder string may also be a valid registry / MCP / alias tool name, so it cannot be
 * the sole reason to hide a row. Live handling recognizes only the original empty name; cold/legacy
 * handling also requires both the placeholder name and persisted original-name metadata.
 */
export function shouldHideInvalidToolCallFromProduct(
  toolName: unknown,
  metadata?: Record<string, unknown>,
): boolean {
  if (typeof toolName !== "string") return false;
  if (toolName.trim().length === 0) return true;

  const providerToolName = metadata?.providerToolName;
  return (
    toolName === EMPTY_TOOL_NAME_PLACEHOLDER &&
    providerToolName !== undefined &&
    typeof providerToolName === "string" &&
    providerToolName.trim().length === 0
  );
}

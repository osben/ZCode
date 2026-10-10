import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import type { OfficialMcpToolErrorCode } from "@zcode/shared";

/**
 * Fact that an official Server MCP was deemed unavailable in this session (quota exhausted / no Coding Plan).
 *
 * The source of truth is `display.unavailable` on the tool row. The CLI fills it only for official MCPs with an isError result,
 * so the source does not need to be checked again here.
 */
export interface McpUnavailableNotice {
  code: OfficialMcpToolErrorCode;
  serverName: string;
  toolName: string;
  /** Deduplication key: show the notice once per call; a new failed call can show it again. */
  rowId: number;
}

function readMcpToolCallRow(row: ConversationRow): ToolCallRow | null {
  return row.kind === "toolCall" ? row : null;
}

/**
 * Find the newest official MCP tool call in the window with an unavailable marker.
 *
 * Use the "newest" rather than the "first": a session may hit a quota first, then switch connections and hit an entitlement issue, so the notice must follow the latest fact.
 * rows is a window view; when scrolling far away, an old marker leaves the window and the notice disappears. A recent call is always in the window,
 * so this is an acceptable tradeoff.
 */
export function resolveMcpUnavailableNotice(
  rows: readonly ConversationRow[] | undefined,
): McpUnavailableNotice | null {
  if (!rows || rows.length === 0) return null;
  const seenTools = new Set<string>();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row) continue;
    const toolCallRow = readMcpToolCallRow(row);
    if (!toolCallRow) continue;
    const display = toolCallRow.display;
    if (display?.kind !== "mcp_tool") continue;
    const toolKey = `${display.serverName}\u0000${display.toolName}`;
    if (seenTools.has(toolKey)) continue;
    seenTools.add(toolKey);
    // The latest success for a tool supersedes its older failure; continue looking for failures from other tools that have not been superseded by success.
    if (!display.unavailable) continue;
    return {
      code: display.unavailable.code,
      rowId: toolCallRow.rowId,
      serverName: display.serverName,
      toolName: display.toolName,
    };
  }
  return null;
}

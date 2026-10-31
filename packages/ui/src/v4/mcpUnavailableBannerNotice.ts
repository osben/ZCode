import type {
  ConversationRow,
  ConversationRowsPartition,
  ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import type { OfficialMcpToolErrorCode } from "@zcode/shared";
import { memoizeByRows } from "@/v4/conversationProjectionStore.js";

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

function toolKeyOf(display: { serverName: string; toolName: string }): string {
  return `${display.serverName}\u0000${display.toolName}`;
}

/** The latest MCP call per tool, ordered newest to oldest by position. */
function latestMcpRowsPerTool(rows: readonly ConversationRow[]): ToolCallRow[] {
  const latest: ToolCallRow[] = [];
  const seenTools = new Set<string>();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind !== "toolCall" || row.display?.kind !== "mcp_tool") continue;
    const toolKey = toolKeyOf(row.display);
    if (seenTools.has(toolKey)) continue;
    seenTools.add(toolKey);
    latest.push(row);
  }
  return latest;
}

const latestMcpRowsByRows = memoizeByRows(latestMcpRowsPerTool);

function toNotice(row: ToolCallRow): McpUnavailableNotice | null {
  const display = row.display;
  if (display?.kind !== "mcp_tool" || !display.unavailable) return null;
  return {
    code: display.unavailable.code,
    rowId: row.rowId,
    serverName: display.serverName,
    toolName: display.toolName,
  };
}

/**
 * Take the newest official-MCP tool call in the window carrying an unavailable marker; the
 * result equals reverse-scanning the whole history ++ tail window.
 *
 * Use the "newest" rather than the "first": a session may hit a quota first, then switch connections and hit an entitlement issue, so the notice must follow the latest fact.
 * A tool's latest success fact overrides older failures, so each tool contributes only its latest call.
 * rows is a window view; when scrolling far away, an old marker leaves the window and the notice disappears. A recent call is always in the window,
 * so this is an acceptable tradeoff.
 *
 * Bug root cause: with no unavailable marker present, the old implementation reverse-scanned
 * the entire window on every streaming frame, so cost grew linearly with history. Now each of
 * the two segments yields "the latest call per tool" (the history segment cached by reference):
 * tail rows are all newer than history rows, so scan the tail first, then the history-segment
 * tools absent from the tail — the same order as a whole-window reverse scan.
 */
export function resolveMcpUnavailableNoticeInPartition(
  partition: ConversationRowsPartition | null,
): McpUnavailableNotice | null {
  if (!partition) return null;
  const history = latestMcpRowsByRows(partition.history);
  const tail = latestMcpRowsByRows(partition.tail);
  for (const row of tail) {
    const notice = toNotice(row);
    if (notice) return notice;
  }
  const tailTools = new Set(
    tail.flatMap((row) => (row.display?.kind === "mcp_tool" ? [toolKeyOf(row.display)] : [])),
  );
  for (const row of history) {
    if (row.display?.kind !== "mcp_tool" || tailTools.has(toolKeyOf(row.display))) continue;
    const notice = toNotice(row);
    if (notice) return notice;
  }
  return null;
}

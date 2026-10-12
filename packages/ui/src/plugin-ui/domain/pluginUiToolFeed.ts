import type { McpAppsToolResultPayload } from "@zcode/shared/mcp-apps";
import { MCP_APPS_TRUNCATED_META_KEY } from "@zcode/shared/mcp-apps";
import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import type { PluginUiPresentation } from "../contract.js";
import { parseJsonText, readPluginUiPresentation } from "./readPluginUiPresentation.js";

/** Legacy ChatToolCall subset shared by the inline card and the side pane (toolCallRowAdapter output). */
export interface PluginUiLegacyToolCall {
  status: string;
  input: unknown;
  output?: unknown;
}

export function readPluginUiToolInput(
  toolCall: PluginUiLegacyToolCall | null,
): Record<string, unknown> | undefined {
  return toolCall &&
    typeof toolCall.input === "object" &&
    toolCall.input !== null &&
    !Array.isArray(toolCall.input)
    ? (toolCall.input as Record<string, unknown>)
    : undefined;
}

/** A stopped tool no longer masquerades as a plain result; it goes through ui/notifications/tool-cancelled instead. */
export function isPluginUiToolCancelled(toolCall: PluginUiLegacyToolCall | null): boolean {
  return toolCall?.status === "stopped";
}

/**
 * Tool row → MCP Apps tool-result notification payload. Legacy status vocabulary: pending / in_progress /
 * completed / failed / stopped; unfinished rows produce nothing; stopped produces nothing (a cancelled
 * notification is sent instead). structuredContent / widgetMeta are restored from display.ui's JSON text.
 */
export function buildPluginUiToolResult(
  toolCall: PluginUiLegacyToolCall | null,
  presentation: PluginUiPresentation | null,
): McpAppsToolResultPayload | undefined {
  if (!toolCall || !presentation) return undefined;
  if (toolCall.status === "pending" || toolCall.status === "in_progress") return undefined;
  if (isPluginUiToolCancelled(toolCall)) return undefined;
  const structured = parseJsonText(presentation.structuredContent);
  const meta = parseJsonText(presentation.widgetMeta);
  // H12: prefer the agent-projected raw content array (image / resource blocks are not lost); fall back to plain text when absent.
  const rawContent = parseJsonText(presentation.content);
  const content = Array.isArray(rawContent)
    ? (rawContent.filter(
        (block): block is Record<string, unknown> => typeof block === "object" && block !== null,
      ) as Array<Record<string, unknown>>)
    : typeof toolCall.output === "string"
      ? [{ type: "text", text: toolCall.output }]
      : [];
  const baseMeta =
    typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : {};
  // H12: over-limit fields were omitted by the agent; the page learns the byte count from _meta["zcode/truncated"].bytes and can refetch via tools/call.
  const mergedMeta = presentation.truncated
    ? { ...baseMeta, [MCP_APPS_TRUNCATED_META_KEY]: { bytes: presentation.truncatedBytes ?? 0 } }
    : baseMeta;
  return {
    content,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    ...(toolCall.status === "failed" || presentation.isError ? { isError: true } : {}),
    ...(Object.keys(mergedMeta).length > 0 ? { _meta: mergedMeta } : {}),
  };
}

export function findToolRowById(
  rows: readonly ConversationRow[],
  toolCallId: string,
): ToolCallRow | null {
  const row = rows.find(
    (candidate) => candidate.kind === "toolCall" && candidate.toolCallId === toolCallId,
  );
  return row && row.kind === "toolCall" ? row : null;
}

/** One tool row summary in a surface feed snapshot. */
export interface PluginUiSurfaceFeedEntry {
  rowId: number;
  toolCallId: string;
  status: ToolCallRow["status"];
  presentation: PluginUiPresentation;
  input: Record<string, unknown> | undefined;
}

/**
 * Surface feed snapshot. `latest` is the surface's newest tool row (any status; feeds tool-input and
 * decides cancelled); `result` is the last successful result — running / failed / cancelled / MCP isError
 * never overwrite it, so the pane keeps showing the previous good result until the next success.
 * Both advance monotonically by rowId only; the snapshot survives the projection window trimming old rows.
 */
export interface PluginUiSurfaceFeed {
  latest: PluginUiSurfaceFeedEntry | null;
  result: (PluginUiSurfaceFeedEntry & { toolResult: McpAppsToolResultPayload }) | null;
}

export const EMPTY_PLUGIN_UI_SURFACE_FEED: PluginUiSurfaceFeed = { latest: null, result: null };

// v4 status → legacy vocabulary used by buildPluginUiToolResult (synonymous with v4/toolCallRowAdapter's
// STATUS_MAP; the adapter is not imported here: the domain only depends on protocol row types).
const LEGACY_STATUS: Record<ToolCallRow["status"], string> = {
  inputStreaming: "pending",
  pendingApproval: "pending",
  running: "in_progress",
  success: "completed",
  error: "failed",
  cancelled: "stopped",
};

function readSurfacePresentation(
  row: ToolCallRow,
  surfaceId: string,
  pluginId: string,
): PluginUiPresentation | null {
  const display = row.display;
  if (
    display?.kind !== "mcp_tool" ||
    display.ui?.surface !== surfaceId ||
    display.ui.pluginId !== pluginId
  )
    return null;
  return readPluginUiPresentation({ display });
}

function toSurfaceFeedEntry(
  row: ToolCallRow,
  presentation: PluginUiPresentation,
): PluginUiSurfaceFeedEntry {
  return {
    rowId: row.rowId,
    toolCallId: row.toolCallId,
    status: row.status,
    presentation,
    input: readPluginUiToolInput({ status: row.status, input: row.input }),
  };
}

/**
 * Pure reduction: folds a batch of projection rows into the snapshot. The same rowId updates `latest`
 * only on status change; `result` is constructed once when a successful row first appears and is never
 * rebuilt for the same rowId (reference stays stable; the host uses the reference to decide whether to
 * resend tool-result). Returns the original object when nothing changed.
 */
export function reducePluginUiSurfaceFeed(
  previous: PluginUiSurfaceFeed,
  rows: readonly ConversationRow[],
  surfaceId: string,
  pluginId: string,
  binding?: { serverName?: string; resourceUri: string },
): PluginUiSurfaceFeed {
  let latest = previous.latest;
  let result = previous.result;
  for (const row of rows) {
    if (row.kind !== "toolCall") continue;
    const presentation = readSurfacePresentation(row, surfaceId, pluginId);
    if (
      !presentation ||
      (binding &&
        (presentation.serverName !== binding.serverName ||
          presentation.resourceUri !== binding.resourceUri))
    )
      continue;
    if (
      !latest ||
      row.rowId > latest.rowId ||
      (row.rowId === latest.rowId && row.status !== latest.status)
    ) {
      latest = toSurfaceFeedEntry(row, presentation);
    }
    // A call with MCP isError is success on the v4 row (the model sees it as complete) but is a failure for the pane: do not overwrite the previous good result.
    if (
      row.status === "success" &&
      !presentation.isError &&
      (!result || row.rowId > result.rowId)
    ) {
      const toolResult = buildPluginUiToolResult(
        { status: LEGACY_STATUS[row.status], input: row.input, output: row.output?.text },
        presentation,
      );
      if (toolResult) result = { ...toSurfaceFeedEntry(row, presentation), toolResult };
    }
  }
  return latest === previous.latest && result === previous.result ? previous : { latest, result };
}

/** Takes the newer of two snapshots by rowId (store merging): whoever has the newer row wins. */
export function mergePluginUiSurfaceFeed(
  current: PluginUiSurfaceFeed,
  candidate: PluginUiSurfaceFeed,
): PluginUiSurfaceFeed {
  const latest =
    candidate.latest &&
    (!current.latest ||
      candidate.latest.rowId > current.latest.rowId ||
      (candidate.latest.rowId === current.latest.rowId &&
        candidate.latest.status !== current.latest.status))
      ? candidate.latest
      : current.latest;
  const result =
    candidate.result && (!current.result || candidate.result.rowId > current.result.rowId)
      ? candidate.result
      : current.result;
  return latest === current.latest && result === current.result ? current : { latest, result };
}

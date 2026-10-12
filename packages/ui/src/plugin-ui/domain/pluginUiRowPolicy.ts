import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { PluginUiRowDisposition } from "./pluginUiInstancePolicy.js";

/** Render-layer-supplied disposition by toolCallId: the derivation result plus the user's manual pin / collapse. */
export interface PluginUiRowPinContext {
  disposition?: PluginUiRowDisposition;
  /** User manually pinned (true) or collapsed (false); undefined follows the default rule. */
  manualPinned?: boolean;
}

export type PluginUiRowPinResolver = (toolCallId: string) => PluginUiRowPinContext | undefined;

/**
 * Whether a tool row with plugin UI stays outside the "worked N seconds ago" collapsed area:
 * failed / cancelled rows collapse as usual; rows superseded by a newer success go into the collapsed
 * area (plain tool records); the rest follow manual state → forced inline → auto-expand for the last
 * three turns. Callers without a resolver (read-only shared timelines) keep "everything inline".
 */
export function isPluginUiPinnedToolRow(
  row: ConversationRow,
  resolve?: PluginUiRowPinResolver,
): boolean {
  if (row.kind !== "toolCall") return false;
  if (row.status === "error" || row.status === "cancelled") return false;
  const display = row.display;
  if (display?.kind !== "mcp_tool" || display.ui === undefined) return false;
  // MCP isError does not necessarily map to a row-level error; exclude it first, then apply the pin / recent-turn policy, so error cards do not stay inline.
  if (display.ui.isError === true) return false;
  if (!resolve) return true;
  const context = resolve(row.toolCallId);
  if (!context) return true;
  if (context.disposition?.superseded) return false;
  if (context.manualPinned !== undefined) return context.manualPinned;
  if (!context.disposition) return true;
  return context.disposition.forcedInline || context.disposition.autoExpand;
}

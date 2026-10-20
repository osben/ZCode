import { mcpToolDisplayUiSchema } from "@zcode/shared/mcp-apps";
import type { PluginUiPresentation } from "../contract.js";

/**
 * Reads plugin UI presentation from a ToolCallRow's legacy raw.display. display.ui is projected by the
 * agent and persisted after strict schema validation; validating again here defends against old snapshots
 * or hand-edited data, falling back to the plain McpToolCallBlock on failure.
 */
export function readPluginUiPresentation(raw: unknown): PluginUiPresentation | null {
  if (typeof raw !== "object" || raw === null) return null;
  const display = (raw as { display?: unknown }).display;
  if (typeof display !== "object" || display === null) return null;
  const record = display as Record<string, unknown>;
  if (record.kind !== "mcp_tool" || typeof record.serverName !== "string") return null;
  const parsed = mcpToolDisplayUiSchema.safeParse(record.ui);
  if (!parsed.success) return null;
  return { serverName: record.serverName, ...parsed.data };
}

/** Parses structuredContent / widgetMeta persisted as JSON text inside display.ui; invalid JSON counts as missing. */
export function parseJsonText(text: string | undefined): unknown {
  if (typeof text !== "string" || text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

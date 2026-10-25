import {
  MCP_TOOL_META_TIMEOUT_MAX_MS,
  MCP_TOOL_META_TIMEOUT_MIN_MS,
  type JsonSchema,
  type McpToolAnnotations,
  type McpToolDescriptor,
} from "@zcode/contracts";
import { normalizeMcpToolUiMeta, readMcpToolVisibility } from "@zcode/shared/mcp-apps";

export function normalizeMcpToolDescriptor(
  serverName: string,
  tool: unknown,
  timeoutMs?: number,
  official?: boolean,
  alwaysLoad?: boolean,
): McpToolDescriptor {
  const record = isRecord(tool) ? tool : {};
  const meta = isRecord(record._meta) ? record._meta : {};
  const toolName = typeof record.name === "string" ? record.name : "unknown";
  // Plugin UI: read `tools/list` `_meta` once here and normalize it to descriptor.ui; downstream code never touches raw _meta.
  const ui = normalizeMcpToolUiMeta(record._meta);
  return {
    serverName,
    alwaysLoad: alwaysLoad === true || meta["anthropic/alwaysLoad"] === true,
    searchHint:
      typeof meta["anthropic/searchHint"] === "string"
        ? meta["anthropic/searchHint"].replace(/\s+/g, " ").trim()
        : undefined,
    toolName,
    name: `mcp__${sanitizeMcpName(serverName)}__${sanitizeMcpName(toolName)}`,
    description: typeof record.description === "string" ? record.description : undefined,
    // Tool-level `_meta.timeoutMs` (A8) overrides the server-level timeout: long tasks (engine downloads, rendering) declare their own limit, capped at 30 minutes.
    timeoutMs: readToolMetaTimeoutMs(record._meta) ?? timeoutMs,
    inputSchema: normalizeInputSchema(record.inputSchema),
    outputSchema: isRecord(record.outputSchema) ? (record.outputSchema as JsonSchema) : undefined,
    annotations: normalizeAnnotations(record.annotations),
    // Trust tool error identifiers only for official HTTP MCP; that response shape comes from a ZCode backend with a
    // validated origin and cannot be forged by a plugin (see the official field in mcp.port.ts for the criteria and tradeoffs).
    ...(official ? { official: true } : {}),
    // Visibility is independent of UI presentation: app-only data tools without a resourceUri must not enter the model tool list either.
    visibility: readMcpToolVisibility(record._meta),
    ...(ui ? { ui } : {}),
  };
}

function readToolMetaTimeoutMs(meta: unknown): number | undefined {
  if (!isRecord(meta)) return undefined;
  const value = meta.timeoutMs;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < MCP_TOOL_META_TIMEOUT_MIN_MS) return undefined;
  return Math.min(Math.floor(value), MCP_TOOL_META_TIMEOUT_MAX_MS);
}

function normalizeInputSchema(schema: unknown): JsonSchema {
  if (!isRecord(schema)) {
    return {
      type: "object",
      properties: {},
      additionalProperties: true,
    };
  }

  return {
    ...schema,
    type: "object",
    properties: isRecord(schema.properties) ? schema.properties : {},
  };
}

function normalizeAnnotations(value: unknown): McpToolAnnotations | undefined {
  if (!isRecord(value)) return undefined;
  return {
    readOnlyHint: typeof value.readOnlyHint === "boolean" ? value.readOnlyHint : undefined,
    destructiveHint: typeof value.destructiveHint === "boolean" ? value.destructiveHint : undefined,
    idempotentHint: typeof value.idempotentHint === "boolean" ? value.idempotentHint : undefined,
    openWorldHint: typeof value.openWorldHint === "boolean" ? value.openWorldHint : undefined,
  };
}

function sanitizeMcpName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
  return sanitized.length > 0 ? sanitized : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

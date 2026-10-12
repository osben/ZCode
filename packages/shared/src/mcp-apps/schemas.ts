import { z } from "zod";
import {
  MCP_APPS_RESOURCE_URI_MAX_CHARS,
  MCP_APPS_CONTENT_MAX_BYTES,
  MCP_APPS_STRUCTURED_CONTENT_MAX_BYTES,
  MCP_APPS_SURFACE_ID_MAX_CHARS,
  MCP_APPS_SURFACE_ID_PATTERN,
  MCP_APPS_WIDGET_META_MAX_BYTES,
} from "./contract.js";

/**
 * The schemas below are the runtime validation surface of mcp-apps-protocol: they only cover
 * ZCode's own projection / metadata shapes.
 * Page-host `ui/*` params are validated by the official SDK (`McpUi*Schema`) and are not
 * duplicated here. Types are in contract.ts.
 */

export const mcpAppsDisplayModeSchema = z.enum(["inline", "fullscreen", "pip"]);
export const mcpAppsToolVisibilitySchema = z.enum(["model", "app"]);
/** Panel id. */
export const mcpAppsSurfaceIdSchema = z
  .string()
  .min(1)
  .max(MCP_APPS_SURFACE_ID_MAX_CHARS)
  .regex(MCP_APPS_SURFACE_ID_PATTERN);

export const mcpToolUiCspSchema = z
  .object({
    connectDomains: z.array(z.string().min(1).max(512)).optional(),
    resourceDomains: z.array(z.string().min(1).max(512)).optional(),
    frameDomains: z.array(z.string().min(1).max(512)).optional(),
    baseUriDomains: z.array(z.string().min(1).max(512)).optional(),
  })
  .strict();

/** Normalized shape of resource-level `_meta["zcode/csp"]` (only keys set to true). */
export const mcpAppCspRelaxationsSchema = z
  .object({ unsafeEval: z.boolean().optional(), wasmUnsafeEval: z.boolean().optional() })
  .strict();

export const mcpToolUiDescriptorSchema = z
  .object({
    resourceUri: z.string().min(1).max(MCP_APPS_RESOURCE_URI_MAX_CHARS),
    visibility: z.array(mcpAppsToolVisibilitySchema).optional(),
    preferredDisplayMode: mcpAppsDisplayModeSchema.optional(),
    csp: mcpToolUiCspSchema.optional(),
    prefersBorder: z.boolean().optional(),
    surface: mcpAppsSurfaceIdSchema.optional(),
    showInline: z.boolean().optional(),
  })
  .strict();

/**
 * `display.ui`: plugin UI metadata the agent projects onto ToolCallRow.display.
 * The strict schemas in both contracts and zcode-protocol-v4 reuse this one, avoiding three
 * hand-written copies drifting apart.
 */
export const mcpToolDisplayUiSchema = z
  .object({
    pluginId: z.string().min(1).max(256),
    resourceUri: z.string().min(1).max(MCP_APPS_RESOURCE_URI_MAX_CHARS),
    preferredDisplayMode: mcpAppsDisplayModeSchema.optional(),
    prefersBorder: z.boolean().optional(),
    csp: mcpToolUiCspSchema.optional(),
    // The byte limit is enforced agent-side in UTF-8 bytes; the max here counts characters only
    // as a backstop (character count ≤ byte count).
    structuredContent: z.string().max(MCP_APPS_STRUCTURED_CONTENT_MAX_BYTES).optional(),
    widgetMeta: z.string().max(MCP_APPS_WIDGET_META_MAX_BYTES).optional(),
    /** JSON text of the original `content` array (≤ 32 KiB); the page tool-result uses it instead of the concatenated plain text. */
    content: z.string().max(MCP_APPS_CONTENT_MAX_BYTES).optional(),
    truncated: z.boolean().optional(),
    /** Sum of UTF-8 byte lengths of the omitted fields. */
    truncatedBytes: z.number().int().nonnegative().optional(),
    /** MCP result `isError: true` (the call itself completed, the tool errored); the page tool-result carries isError, and the panel does not use it to overwrite the previous successful snapshot. */
    isError: z.literal(true).optional(),
    /** Tool-level forced always-visible (`openai/widgetShowCodexWidgetInline`); the card stays out of the collapsed area. */
    showInline: z.literal(true).optional(),
    // Owning panel; kept in sync with mcpToolDisplayUiPayloadSchema on the contracts side.
    surface: mcpAppsSurfaceIdSchema.optional(),
  })
  .strict();
export type McpToolDisplayUi = z.infer<typeof mcpToolDisplayUiSchema>;

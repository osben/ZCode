import { z } from "zod";

/**
 * App-Provided Tools (MCP Apps spec "App-Provided Tools"): after the page declares the `tools` capability
 * in `ui/initialize`, the host discovers page tools via `tools/list`, registers them with the agent to
 * expose to the model; model calls reach the renderer through the "instance mailbox" (live-only projected
 * incremental `pluginUi.appToolCall`, delivered by scopeId + generation), the page executes `tools/call`
 * and returns the result. This module only holds quotas, descriptor normalization, and model-side naming;
 * pure domain, zero IO.
 */

/** Maximum number of tools registered per page instance (spec-recommended value). */
export const MCP_APPS_APP_TOOLS_MAX_PER_INSTANCE = 50;
export const MCP_APPS_APP_TOOL_NAME_MAX_CHARS = 128;
export const MCP_APPS_APP_TOOL_TITLE_MAX_CHARS = 256;
export const MCP_APPS_APP_TOOL_DESCRIPTION_MAX_CHARS = 4096;
/** Upper bound for serialized inputSchema / outputSchema (UTF-8 bytes). */
export const MCP_APPS_APP_TOOL_SCHEMA_MAX_BYTES = 64 * 1024;
/** Deadline for the renderer to claim a pending call; on timeout the page is treated as not running (mailbox delivery is not resent). */
export const MCP_APPS_APP_TOOL_CLAIM_TIMEOUT_MS = 5_000;
/** Deadline for the page to execute tools/call after claiming (spec-recommended value). */
export const MCP_APPS_APP_TOOL_CALL_TIMEOUT_MS = 30_000;
/** Serialization cap for a single result (spec-recommended value). */
export const MCP_APPS_APP_TOOL_RESULT_MAX_BYTES = 10 * 1024 * 1024;
/** Cap on model call arguments before they enter the mailbox; over the cap the call ends with an error immediately and is not delivered. */
export const MCP_APPS_APP_TOOL_ARGUMENTS_MAX_BYTES = 1024 * 1024;
/** Minimum interval for re-registration triggered by list_changed. */
export const MCP_APPS_APP_TOOLS_REFRESH_INTERVAL_MS = 1_000;
export const MCP_APPS_APP_TOOL_ERROR_MESSAGE_MAX_CHARS = 4096;
export const MCP_APPS_APP_TOOL_CALL_ID_MAX_CHARS = 128;
/** Model-side name prefix: naturally does not collide with server tools' `mcp__`. */
export const MCP_APPS_APP_TOOL_MODEL_NAME_PREFIX = "app__";

const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;

/** Same sanitization rule as the agent's MCP tool names: characters outside `[A-Za-z0-9_-]` become `_`, consecutive underscores merged. */
export function sanitizeMcpAppsModelNamePart(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
  return sanitized.length > 0 ? sanitized : "unknown";
}

/** Model-side name `app__<server>__<tool>`. */
export function buildMcpAppsAppToolModelName(serverName: string, toolName: string): string {
  return `${MCP_APPS_APP_TOOL_MODEL_NAME_PREFIX}${sanitizeMcpAppsModelNamePart(serverName)}__${sanitizeMcpAppsModelNamePart(toolName)}`;
}

const objectSchemaSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => value.type === "object", { message: "schema type must be object" })
  .refine((value) => utf8Bytes(JSON.stringify(value)) <= MCP_APPS_APP_TOOL_SCHEMA_MAX_BYTES, {
    message: "schema is too large",
  });

export const mcpAppsAppToolAnnotationsSchema = z.strictObject({
  title: z.string().max(MCP_APPS_APP_TOOL_TITLE_MAX_CHARS).optional(),
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});
export type McpAppsAppToolAnnotations = z.infer<typeof mcpAppsAppToolAnnotationsSchema>;

export const mcpAppsAppToolDescriptorSchema = z.strictObject({
  name: z.string().min(1).max(MCP_APPS_APP_TOOL_NAME_MAX_CHARS),
  title: z.string().max(MCP_APPS_APP_TOOL_TITLE_MAX_CHARS).optional(),
  description: z.string().max(MCP_APPS_APP_TOOL_DESCRIPTION_MAX_CHARS).optional(),
  inputSchema: objectSchemaSchema,
  outputSchema: objectSchemaSchema.optional(),
  annotations: mcpAppsAppToolAnnotationsSchema.optional(),
});
export type McpAppsAppToolDescriptor = z.infer<typeof mcpAppsAppToolDescriptorSchema>;

const ANNOTATION_BOOLEAN_KEYS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const;

/**
 * Renderer side: narrows the page's `tools/list` result into registrable descriptors. Non-conforming
 * items are skipped (without failing the whole registration); over 50, only the first 50 are taken.
 * Returns the skipped names and reasons for logging.
 */
export function normalizeMcpAppsAppTools(tools: readonly unknown[]): {
  tools: McpAppsAppToolDescriptor[];
  skipped: Array<{ name: string | null; reason: string }>;
} {
  const accepted: McpAppsAppToolDescriptor[] = [];
  const skipped: Array<{ name: string | null; reason: string }> = [];
  const seen = new Set<string>();
  for (const raw of tools) {
    const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    const name = typeof record?.name === "string" ? record.name : null;
    if (accepted.length >= MCP_APPS_APP_TOOLS_MAX_PER_INSTANCE) {
      skipped.push({ name, reason: "limit" });
      continue;
    }
    if (!record || name === null) {
      skipped.push({ name, reason: "invalid" });
      continue;
    }
    if (seen.has(name)) {
      skipped.push({ name, reason: "duplicate" });
      continue;
    }
    const rawAnnotations =
      record.annotations && typeof record.annotations === "object"
        ? (record.annotations as Record<string, unknown>)
        : null;
    const annotations: Record<string, unknown> = {};
    if (typeof rawAnnotations?.title === "string") annotations.title = rawAnnotations.title;
    for (const key of ANNOTATION_BOOLEAN_KEYS) {
      if (typeof rawAnnotations?.[key] === "boolean") annotations[key] = rawAnnotations[key];
    }
    const candidate = {
      name,
      ...(typeof record.title === "string" ? { title: record.title } : {}),
      ...(typeof record.description === "string" ? { description: record.description } : {}),
      inputSchema: record.inputSchema,
      ...(record.outputSchema !== undefined ? { outputSchema: record.outputSchema } : {}),
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
    };
    const parsed = mcpAppsAppToolDescriptorSchema.safeParse(candidate);
    if (!parsed.success) {
      skipped.push({ name, reason: parsed.error.issues[0]?.message ?? "invalid" });
      continue;
    }
    seen.add(name);
    accepted.push(parsed.data);
  }
  return { tools: accepted, skipped };
}

/** Result of the page's `tools/call` (MCP CallToolResult shape, loose field set: content items kept as-is). */
export const mcpAppsAppToolCallResultSchema = z.object({
  content: z.array(z.record(z.string(), z.unknown())),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});
export type McpAppsAppToolCallResult = z.infer<typeof mcpAppsAppToolCallResultSchema>;

/** One pending call in the mailbox: delivered to the unique instance by (scopeId, generation). */
export interface McpAppsAppToolCallRequest {
  activity?: boolean;
  cancelled?: boolean;
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

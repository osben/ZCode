import { z } from "zod";
import { PersistedToolSearchContentSchema } from "./tool-search.js";
import { OFFICIAL_MCP_TOOL_ERROR_CODES } from "@zcode/shared";
import {
  MCP_APPS_RESOURCE_URI_MAX_CHARS,
  MCP_APPS_CONTENT_MAX_BYTES,
  MCP_APPS_STRUCTURED_CONTENT_MAX_BYTES,
  MCP_APPS_SURFACE_ID_MAX_CHARS,
  MCP_APPS_SURFACE_ID_PATTERN,
  MCP_APPS_WIDGET_META_MAX_BYTES,
} from "@zcode/shared/mcp-apps";

import {
  CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS,
  CreateWorkflowCausalityGraphSchema,
  createWorkflowToolResultDisplayDiagnosticSchema,
} from "./create-workflow.js";
import {
  evalWorkflowSnippetToolResultDisplayPayloadSchema,
  getWorkflowRunToolResultDisplayPayloadSchema,
  listModelsToolResultDisplayPayloadSchema,
  listWorkflowRunsToolResultDisplayPayloadSchema,
  resumeWorkflowRunToolResultDisplayPayloadSchema,
  savedWorkflowListToolResultDisplayPayloadSchema,
} from "./workflow-observation-display.js";

export const COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION = 1;
export const TASK_OUTPUT_DISPLAY_MAX_STATUS_CHARS = 64;
export const TASK_OUTPUT_DISPLAY_MAX_OUTPUT_CHARS = 2_000;
export const MCP_TOOL_DISPLAY_MAX_NAME_CHARS = 256;
export const MCP_TOOL_DISPLAY_MAX_DESCRIPTION_CHARS = 4 * 1024;
export const CUA_TARGET_APP_DISPLAY_META_KEY = "zcode.cua/target-app-display-v1" as const;

export const applicationIconLocatorSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("darwin-bundle-id"), value: z.string().trim().min(1).max(512) })
    .strict(),
  z
    .object({
      kind: z.literal("windows-executable-path"),
      value: z.string().trim().min(1).max(32_768),
    })
    .strict(),
  z.object({ kind: z.literal("windows-aumid"), value: z.string().trim().min(1).max(512) }).strict(),
]);

export const cuaTargetAppDisplaySchema = z
  .object({
    schemaVersion: z.literal(1),
    displayName: z.string().trim().min(1).max(512).optional(),
    iconLocators: z.array(applicationIconLocatorSchema).max(3),
  })
  .strict();

export const cuaRequestAccessStatusDisplaySchema = z
  .object({
    schemaVersion: z.literal(1),
    platform: z.literal("darwin"),
    grantOwner: z.string().trim().min(1).max(512),
    accessibility: z.enum(["granted", "stale", "denied"]),
    screenRecording: z.enum(["granted", "denied", "unknown"]),
  })
  .strict();

// Length limits and item schema for CreateWorkflow display diagnostics moved to
// create-workflow.ts (shared by the create_workflow and eval_workflow_snippet display payloads;
// keeping them here would create a cycle).

export const toolResultDisplayDiffHunkSchema = z
  .object({
    oldStart: z.number().int(),
    oldLines: z.number().int(),
    newStart: z.number().int(),
    newLines: z.number().int(),
    lines: z.array(z.string()),
  })
  .strict();

export const fileDiffToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("file_diff"),
    filePath: z.string().min(1),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    structuredPatch: z.array(toolResultDisplayDiffHunkSchema),
    truncated: z.boolean().optional(),
  })
  .strict();

export const localAgentMessageToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("local_agent_message"),
    status: z.enum(["success", "failed"]),
    error: z.string().optional(),
    message: z.string().optional(),
  })
  .strict();

export const taskStopToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("task_stop"),
    taskId: z.string().min(1),
    taskType: z.string().min(1),
    command: z.string().min(1).optional(),
    message: z.string().min(1),
    truncated: z.boolean().optional(),
  })
  .strict();

export const taskOutputToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("task_output"),
    retrievalStatus: z.enum(["success", "not_ready", "timeout"]),
    taskStatus: z.string().min(1).max(TASK_OUTPUT_DISPLAY_MAX_STATUS_CHARS).optional(),
    output: z.string().min(1).max(TASK_OUTPUT_DISPLAY_MAX_OUTPUT_CHARS).optional(),
    truncated: z.literal(true).optional(),
  })
  .strict();

export const respondToCoordinatorToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("respond_to_coordinator"),
    status: z.enum(["success", "failed"]),
  })
  .strict();

export const cuaToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("cua"),
    schemaVersion: z.literal(1),
    toolName: z.string().min(1),
    status: z.enum(["success", "failed"]),
    // Old v1 history records duplicated ToolCallRow.input. Continue accepting it only for
    // replay compatibility; new producers no longer write it.
    input: z.string().optional(),
    structuredContent: z.string().optional(),
    text: z.string().optional(),
    errorCode: z.string().optional(),
    suggestedAction: z.string().optional(),
    targetApp: cuaTargetAppDisplaySchema.optional(),
    permissionStatus: cuaRequestAccessStatusDisplaySchema.optional(),
    media: z
      .array(
        z
          .object({
            mimeType: z.string().min(1),
            // Maximum base64 length after encoding a 256 KiB original image; the projector
            // enforces the total budget.
            data: z.string().min(1).max(349_528).optional(),
            artifactUri: z.string().min(1).optional(),
          })
          .strict(),
      )
      .max(4)
      .optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

/**
 * Target application identity for a node_repl cell (Computer Use). `appKey` is the producer's
 * representation:
 * `darwin:<bundleId>` / `windows-aumid:<aumid>` / `windows-exe:<path>` / `linux-exe:<path>`；
 * The UI derives an `ApplicationIconLocator` from its prefix and passes it to the platform
 * service for resolution; the protocol does not carry icon bytes.
 */
export const nodeReplCuaAppDisplaySchema = z
  .object({
    appKey: z.string().trim().min(1).max(2_048),
    displayName: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

export const nodeReplImageToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("node_repl_images"),
    // images is optional rather than min(1): CUA action-only cells (clicks, typing) have no
    // screenshots, but still need to project app identity.
    // Keep the kind name node_repl_images; renaming it would strip the entire persisted row
    // from the strict union.
    images: z
      .array(
        z
          .object({
            base64: z
              .string()
              .min(1)
              .max(200 * 1024),
            mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/iu),
          })
          .strict(),
      )
      .min(1)
      .max(2)
      .optional(),
    app: nodeReplCuaAppDisplaySchema.optional(),
    truncated: z.boolean().optional(),
    source: z.literal("browser_turn_end").optional(),
  })
  .strict();

/**
 * Plugin UI metadata.
 * Contracts still uses zod v3 and cannot directly reuse the zod v4 schema object from
 * `@zcode/shared/mcp-apps`, so this schema is reproduced here using the same constants. Its fields
 * must match `mcpToolDisplayUiSchema`; core/tests/mcp-ui-display.test.ts parses the same fixture with
 * both schemas to keep them aligned.
 */
export const mcpToolDisplayUiPayloadSchema = z
  .object({
    pluginId: z.string().min(1).max(MCP_TOOL_DISPLAY_MAX_NAME_CHARS),
    resourceUri: z.string().min(1).max(MCP_APPS_RESOURCE_URI_MAX_CHARS),
    preferredDisplayMode: z.enum(["inline", "fullscreen", "pip"]).optional(),
    prefersBorder: z.boolean().optional(),
    csp: z
      .object({
        connectDomains: z.array(z.string().min(1).max(512)).optional(),
        resourceDomains: z.array(z.string().min(1).max(512)).optional(),
      })
      .strict()
      .optional(),
    structuredContent: z.string().max(MCP_APPS_STRUCTURED_CONTENT_MAX_BYTES).optional(),
    widgetMeta: z.string().max(MCP_APPS_WIDGET_META_MAX_BYTES).optional(),
    // Raw content-array JSON (≤ 32 KiB) and omitted byte count; keep in sync with shared mcpToolDisplayUiSchema.
    content: z.string().max(MCP_APPS_CONTENT_MAX_BYTES).optional(),
    truncated: z.boolean().optional(),
    truncatedBytes: z.number().int().nonnegative().optional(),
    // MCP isError result (the call completed but the tool reported an error); keep in sync with shared.
    isError: z.literal(true).optional(),
    // Tool-level pinning; keep in sync with shared.
    showInline: z.literal(true).optional(),
    // Keep in sync with shared mcpToolDisplayUiSchema; widgetStateVisibility was removed.
    surface: z
      .string()
      .min(1)
      .max(MCP_APPS_SURFACE_ID_MAX_CHARS)
      .regex(MCP_APPS_SURFACE_ID_PATTERN)
      .optional(),
  })
  .strict();

export const mcpToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("mcp_tool"),
    serverName: z.string().min(1).max(MCP_TOOL_DISPLAY_MAX_NAME_CHARS),
    toolName: z.string().min(1).max(MCP_TOOL_DISPLAY_MAX_NAME_CHARS),
    description: z.string().min(1).max(MCP_TOOL_DISPLAY_MAX_DESCRIPTION_CHARS).optional(),
    /**
     * Structured identifier sent when the official Server MCP determines this call is
     * unavailable (quota exhausted / no Coding Plan). Present only when the tool result has
     * isError and the MCP is an official source; the UI uses it to show a notice above the
     * input field. The codes share a source with `@zcode/shared`'s
     * OFFICIAL_MCP_TOOL_ERROR_CODES.
     */
    unavailable: z
      .object({ code: z.enum(OFFICIAL_MCP_TOOL_ERROR_CODES) })
      .strict()
      .optional(),
    // Keep in sync with mcp_tool.ui in `@zcode/shared` v4 toolDisplay; both sides are strict, so zod silently strips any missing field.
    ui: mcpToolDisplayUiPayloadSchema.optional(),
  })
  .strict();

/**
 * ⚠ This field set is **frozen**. Adding keys to an existing kind does not mean an old client
 * simply ignores a field; it makes the whole display fail validation. Both strict parsing
 * points (packages/ui's create-workflow renderer safeParse and the legacy v3 kind lookup) then
 * drop the entire tool result. Facts specific to a gate must always use the **tool input**
 * channel (which has no schema across versions); reusable workflows already do this for their
 * saved source.
 */
export const createWorkflowToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("create_workflow"),
    ok: z.boolean(),
    errorCount: z.number().int().nonnegative(),
    diagnostics: z
      .array(createWorkflowToolResultDisplayDiagnosticSchema)
      .max(CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS),
    // The tool output is already bounded (see the graph schema in create-workflow.ts); display
    // reuses the same contract directly.
    causalityGraph: CreateWorkflowCausalityGraphSchema.optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

// Contracts uses zod v3 and App uses v4; keep this strict contract aligned with shared/bash-output-display.ts.
const bashOutputDisplaySchema = z
  .object({
    kind: z.literal("bash_output"),
    output: z.string().max(150_000),
    truncated: z.boolean(),
    outputPath: z.string().min(1).max(32_768).optional(),
  })
  .strict();

export const toolResultDisplayPayloadSchema = z.discriminatedUnion("kind", [
  bashOutputDisplaySchema,
  fileDiffToolResultDisplayPayloadSchema,
  localAgentMessageToolResultDisplayPayloadSchema,
  taskStopToolResultDisplayPayloadSchema,
  taskOutputToolResultDisplayPayloadSchema,
  respondToCoordinatorToolResultDisplayPayloadSchema,
  cuaToolResultDisplayPayloadSchema,
  nodeReplImageToolResultDisplayPayloadSchema,
  mcpToolResultDisplayPayloadSchema,
  createWorkflowToolResultDisplayPayloadSchema,
  getWorkflowRunToolResultDisplayPayloadSchema,
  listWorkflowRunsToolResultDisplayPayloadSchema,
  evalWorkflowSnippetToolResultDisplayPayloadSchema,
  savedWorkflowListToolResultDisplayPayloadSchema,
  listModelsToolResultDisplayPayloadSchema,
  resumeWorkflowRunToolResultDisplayPayloadSchema,
]);

export type FileDiffToolResultDisplayPayload = z.infer<
  typeof fileDiffToolResultDisplayPayloadSchema
>;
export type LocalAgentMessageToolResultDisplayPayload = z.infer<
  typeof localAgentMessageToolResultDisplayPayloadSchema
>;
export type TaskStopToolResultDisplayPayload = z.infer<
  typeof taskStopToolResultDisplayPayloadSchema
>;
export type TaskOutputToolResultDisplayPayload = z.infer<
  typeof taskOutputToolResultDisplayPayloadSchema
>;
export type RespondToCoordinatorToolResultDisplayPayload = z.infer<
  typeof respondToCoordinatorToolResultDisplayPayloadSchema
>;
export type CuaToolResultDisplayPayload = z.infer<typeof cuaToolResultDisplayPayloadSchema>;
export type ApplicationIconLocator = z.infer<typeof applicationIconLocatorSchema>;
export type CuaTargetAppDisplay = z.infer<typeof cuaTargetAppDisplaySchema>;
export type CuaRequestAccessStatusDisplay = z.infer<typeof cuaRequestAccessStatusDisplaySchema>;
export type NodeReplImageToolResultDisplayPayload = z.infer<
  typeof nodeReplImageToolResultDisplayPayloadSchema
>;
export type McpToolResultDisplayPayload = z.infer<typeof mcpToolResultDisplayPayloadSchema>;
export type CreateWorkflowToolResultDisplayPayload = z.infer<
  typeof createWorkflowToolResultDisplayPayloadSchema
>;
export type NodeReplCuaAppDisplay = z.infer<typeof nodeReplCuaAppDisplaySchema>;

export type ToolResultDisplayPayload = z.infer<typeof toolResultDisplayPayloadSchema>;

export const toolResultSerializationMetadataSchema = z
  .object({
    truncated: z.boolean(),
    originalBytes: z.number().int().nonnegative(),
    returnedBytes: z.number().int().nonnegative(),
    budgetStrategy: z.enum(["inline", "truncate", "artifact"]),
    artifactPath: z.string().min(1).optional(),
  })
  .strict();

export type ToolResultSerializationMetadata = z.infer<typeof toolResultSerializationMetadataSchema>;

export const completedToolPartMetadataSchema = z
  .object({
    // 错误结果沿用字符串内容；仅接受数组会使 V4 冷恢复丢弃整份 metadata，包括 display。
    modelContent: z.union([z.string(), PersistedToolSearchContentSchema]).optional(),
    schemaVersion: z.literal(COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION),
    display: toolResultDisplayPayloadSchema.optional(),
    serialization: toolResultSerializationMetadataSchema.optional(),
  })
  .passthrough();

export type CompletedToolPartMetadata = z.infer<typeof completedToolPartMetadataSchema>;

export function parseCompletedToolPartMetadata(
  input: unknown,
): CompletedToolPartMetadata | undefined {
  const scrubbed =
    isPlainRecord(input) && "display" in input
      ? { ...input, display: scrubPersistedDisplay(input.display) }
      : input;
  const result = completedToolPartMetadataSchema.safeParse(scrubbed);
  return result.success ? result.data : undefined;
}

export function parseToolResultDisplayPayload(
  input: unknown,
): ToolResultDisplayPayload | undefined {
  const result = toolResultDisplayPayloadSchema.safeParse(scrubPersistedDisplay(input));
  return result.success ? result.data : undefined;
}

/**
 * Shared cleanup before parsing.
 *
 * display is **persisted** in the tool part's `metadata.display`, so it must pass strict
 * parsing again on every read. The renderer also has a strict mirrored schema for every frame.
 * Therefore, strip legacy fields on the CLI side before parsing. The two entry points above
 * are the only choke points; both v4 cold-start hydration and session-transcript replay pass
 * through them.
 *
 * Each stripper recognizes only its own kind and changes only keys that are present; all other
 * kinds pass through parsing unchanged.
 */
function scrubPersistedDisplay(display: unknown): unknown {
  return stripProviderStopFromGetWorkflowRunError(stripWithdrawnRefinedNames(display));
}

/**
 * Strip `providerStop` from persisted get_workflow_run cards.
 *
 * An earlier builder also wrote `providerStop`, which belongs only to the model channel, into
 * display. The renderer's mirrored schema accepts only `{code, message}`, so those frames were
 * rejected. The builder now includes only code / message, but persisted historical parts are
 * reread on every cold start, so strip it here.
 *
 * Recognize only payloads of kind get_workflow_run where error is a plain object and
 * `providerStop` is present. Return errors without that key and absent errors unchanged; do
 * not add an undefined value.
 */
function stripProviderStopFromGetWorkflowRunError(display: unknown): unknown {
  if (!isPlainRecord(display) || display.kind !== "get_workflow_run") return display;
  const error = display.error;
  if (!isPlainRecord(error) || !("providerStop" in error)) return display;
  const { providerStop: _dropped, ...rest } = error;
  return { ...display, error: rest };
}

/**
 * Strip model-refinement fields that have been withdrawn.
 *
 * Persisted create_workflow display from earlier versions may have `refinedName` on lanes and
 * phases, and `refinedLabel` on steps. These three fields were removed from the schema, and
 * both entry points parse strictly. Unless stripped first, the entire display (including the
 * graph) for an old session would be rejected here, rather than just losing a name.
 *
 * Recognize only create_workflow payloads with a causalityGraph; pass other kinds through
 * parsing unchanged. Change only keys that are present; do not invent undefined values for
 * absent fields such as `phases`.
 */
function stripWithdrawnRefinedNames(display: unknown): unknown {
  if (!isPlainRecord(display) || display.kind !== "create_workflow") return display;
  const graph = display.causalityGraph;
  if (!isPlainRecord(graph)) return display;
  return {
    ...display,
    causalityGraph: {
      ...graph,
      ...("lanes" in graph ? { lanes: withoutKey(graph.lanes, "refinedName") } : {}),
      ...("steps" in graph ? { steps: withoutKey(graph.steps, "refinedLabel") } : {}),
      ...("phases" in graph ? { phases: withoutKey(graph.phases, "refinedName") } : {}),
    },
  };
}

function withoutKey(items: unknown, key: string): unknown {
  if (!Array.isArray(items)) return items;
  return items.map((item) => {
    if (!isPlainRecord(item) || !(key in item)) return item;
    const { [key]: _dropped, ...rest } = item;
    return rest;
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

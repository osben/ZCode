// Display schemas for zcode-protocol-v4 toolCall.
// Extracted from rows.ts after additive changes on both sides brought it to oxlint's max-lines(400) limit.
// This file contains only pure display unions that do not depend on rowBaseFields; rows.ts depends on it one-way, with no cycle.
import { z } from "zod";
import { bashOutputDisplaySchema } from "../bash-output-display.js";
import { timestampSchema } from "./core.js";
import { OFFICIAL_MCP_TOOL_ERROR_CODES } from "../official-mcp-tool-error.js";
import { cuaRequestAccessStatusSchema } from "./cuaPermission.js";
import { mcpToolDisplayUiSchema } from "../mcp-apps/schemas.js";
import { toolCallCreateWorkflowDisplaySchema } from "./create-workflow-display.js";
import {
  toolCallEvalWorkflowSnippetDisplaySchema,
  toolCallGetWorkflowRunDisplaySchema,
  toolCallListModelsDisplaySchema,
  toolCallListWorkflowRunsDisplaySchema,
  toolCallSavedWorkflowListDisplaySchema,
  toolCallResumeWorkflowRunDisplaySchema,
} from "./workflow-observation-display.js";

// toolCall 终态 output 的结构化展示模型（port 自 feat；CUA 工具靠 kind:"cua" 分支把
// errorCode/suggestedAction/media(screenshot) 等结构化内容带到 renderer）。consume-main 之前
// 缺这个 union + toolOutputSchema.display 字段——协议层 zod 校验会把 agent 下发的 display 整个
// strip 掉，导致 UI 永远拿不到 display?.kind==="cua"，CUA 工具调用退化成 fallback 渲染。
export const toolResultDisplaySchema = z.discriminatedUnion("kind", [
  bashOutputDisplaySchema,
  z.object({
    kind: z.literal("file_diff"),
    filePath: z.string().min(1),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    structuredPatch: z.array(
      z.object({
        oldStart: z.number().int(),
        oldLines: z.number().int(),
        newStart: z.number().int(),
        newLines: z.number().int(),
        lines: z.array(z.string()),
      }),
    ),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("local_agent_message"),
    status: z.enum(["success", "failed"]),
    error: z.string().optional(),
    message: z.string().optional(),
  }),
  z.object({
    kind: z.literal("task_stop"),
    taskId: z.string().min(1),
    taskType: z.string().min(1),
    command: z.string().min(1).optional(),
    message: z.string().min(1),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("task_output"),
    retrievalStatus: z.enum(["success", "not_ready", "timeout"]),
    taskStatus: z.string().min(1).max(64).optional(),
    output: z.string().min(1).max(2_000).optional(),
    truncated: z.literal(true).optional(),
  }),
  z.object({
    kind: z.literal("respond_to_coordinator"),
    status: z.enum(["success", "failed"]),
  }),
  z.object({
    kind: z.literal("cua"),
    schemaVersion: z.literal(1),
    toolName: z.string().min(1),
    status: z.enum(["success", "failed"]),
    // Older v1 snapshots duplicated ToolCallRow.input; continue accepting it only for historical replay.
    input: z.string().optional(),
    structuredContent: z.string().optional(),
    text: z.string().optional(),
    errorCode: z.string().optional(),
    suggestedAction: z.string().optional(),
    permissionStatus: cuaRequestAccessStatusSchema.optional(),
    targetApp: z
      .object({
        schemaVersion: z.literal(1),
        displayName: z.string().trim().min(1).max(512).optional(),
        iconLocators: z
          .array(
            z.discriminatedUnion("kind", [
              z
                .object({
                  kind: z.literal("darwin-bundle-id"),
                  value: z.string().trim().min(1).max(512),
                })
                .strict(),
              z
                .object({
                  kind: z.literal("windows-executable-path"),
                  value: z.string().trim().min(1).max(32_768),
                })
                .strict(),
              z
                .object({
                  kind: z.literal("windows-aumid"),
                  value: z.string().trim().min(1).max(512),
                })
                .strict(),
            ]),
          )
          .max(3),
      })
      .strict()
      .optional(),
    media: z
      .array(
        z.object({
          mimeType: z.string().min(1),
          data: z.string().min(1).max(349_528).optional(),
          artifactUri: z.string().min(1).optional(),
        }),
      )
      .max(4)
      .optional(),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("mcp_tool"),
    serverName: z.string().min(1).max(256),
    toolName: z.string().min(1).max(256),
    description: z
      .string()
      .min(1)
      .max(4 * 1024)
      .optional(),
    // Shares its source with toolCallMcpDisplaySchema. If it is not declared here, Zod silently strips
    // the Agent's unavailable value, disabling official MCP quota warnings on the V4 path (the same
    // display-stripping issue described above).
    unavailable: z
      .object({ code: z.enum(OFFICIAL_MCP_TOOL_ERROR_CODES) })
      .strict()
      .optional(),
    // Plugin UI metadata; shared with the CLI contract mcpToolResultDisplayPayloadSchema; see mcp-apps/schemas.ts.
    ui: mcpToolDisplayUiSchema.optional(),
  }),
  // buildToolOutput copies the CLI's ToolResultDisplayPayload into toolOutput.display unchanged, but
  // this union is strict. Without create_workflow as a member, CreateWorkflow's entire display is
  // rejected/stripped and the tool card falls back to plain text. Keep both member lists in sync with
  // contracts' toolResultDisplayPayloadSchema by reusing the equivalent schema from toolCall.
  toolCallCreateWorkflowDisplaySchema,
  // This includes the five display kinds for observational workflow tools and the ResumeWorkflowRun
  // recovery card; as above, a missing member strips the entire value.
  toolCallGetWorkflowRunDisplaySchema,
  toolCallListWorkflowRunsDisplaySchema,
  toolCallEvalWorkflowSnippetDisplaySchema,
  toolCallSavedWorkflowListDisplaySchema,
  toolCallListModelsDisplaySchema,
  toolCallResumeWorkflowRunDisplaySchema,
]);
export type ToolResultDisplay = z.infer<typeof toolResultDisplaySchema>;

// §4.4.5 toolCall. Terminal output is uniformly truncated to head + tail across all profiles (R-10); excess content is fetched on demand via truncated.ref.
//
// ⚠ **Do not gate display at the envelope layer** (`.optional().catch(undefined)`): if parsing fails, degrade to “this card has no
// payload” rather than failing the entire row, frame, or subscription. This rule is shared by four embedding points—this file’s
// toolOutputSchema, toolCallRow in rows.ts, the confirmation preview in snapshot.ts, and the start row in workflow-row-meta.ts;
// see docs/v4-refactor/10-protocol-spec.md §4.4.5 and
// the closed-world rule 11 in docs/v4-refactor/04-sync-and-recovery.md.
//
// Cause (2026-09-21, sess_4142de31): display is decorative payload, but it lives in an envelope critical to liveness. The CLI added
// two lineage keys to `list_workflow_runs` run rows, but this side’s mirror was not updated → the entire frame was rejected with
// `proto.frameAssemblyInvalidPayload` → the recovery ladder retried the same content → the session stalled at
// `fault.subscription.recoveryFailed`. Every snapshot replayed the same stale payload, so the session could never recover. The same incident
// had already occurred on 2026-09-17 (`providerStop` in `get_workflow_run`), and only that one field was fixed.
//
// Strict parsing is preserved at the appropriate layer: the renderer’s readToolResultDisplay
// (packages/ui/src/ToolCallBlocks/toolResultDisplay.ts) already strictly parses each kind and returns
// undefined on failure, degrading the card to plain text—as the specs have always promised. The envelope-layer gate was a redundant second
// gate whose only distinct effect was to kill the session.
//
// Member schemas remain `.strict()`: they define “shapes recognized by this side.” catch downgrades “unrecognized” from fatal to
// no card. Skew is now silent; parity tests between construction and mirror sides compensate, rather than discovering it in live subscriptions.
export const toolOutputSchema = z.object({
  text: z.string(),
  display: toolResultDisplaySchema.optional().catch(undefined),
  truncated: z
    .object({
      totalBytes: z.number(),
      ref: z.string(),
    })
    .optional(),
});
export type ToolOutput = z.infer<typeof toolOutputSchema>;

// Progress during tool execution: MCP `notifications/progress` is projected onto the row through the ToolCallProgress event.
// Derive fraction from payload progress/total (omit it when total is missing); bytes / previewLine are reserved for shell-output progress.
export const toolProgressSchema = z.object({
  bytes: z.number().optional(),
  previewLine: z.string().optional(),
  fraction: z.number().min(0).max(1).optional(),
  total: z.number().optional(),
  message: z.string().max(200).optional(),
  updatedAt: timestampSchema,
});
export type ToolProgress = z.infer<typeof toolProgressSchema>;

/**
 * Target application identity for a node_repl cell (the Computer Use tool-card icon). Keep this in sync
 * with CLI contracts `nodeReplCuaAppDisplaySchema`; both sides are strict, and a missing field strips
 * the entire display.
 */
const toolCallNodeReplCuaAppDisplaySchema = z
  .object({
    appKey: z.string().trim().min(1).max(2_048),
    displayName: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

const toolCallNodeReplImageDisplaySchema = z
  .object({
    kind: z.literal("node_repl_images"),
    // images is optional because action-only CUA cells have no screenshot, but they still include app
    // identity. Keep the kind name unchanged; renaming it would fail validation for persisted rows in
    // this strict union.
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
    app: toolCallNodeReplCuaAppDisplaySchema.optional(),
    truncated: z.boolean().optional(),
    source: z.literal("browser_turn_end").optional(),
  })
  .strict();

const toolCallTaskOutputDisplaySchema = z
  .object({
    kind: z.literal("task_output"),
    retrievalStatus: z.enum(["success", "not_ready", "timeout"]),
    taskStatus: z.string().min(1).max(64).optional(),
    output: z.string().min(1).max(2_000).optional(),
    truncated: z.literal(true).optional(),
  })
  .strict();

const toolCallRespondToCoordinatorDisplaySchema = z
  .object({
    kind: z.literal("respond_to_coordinator"),
    status: z.enum(["success", "failed"]),
  })
  .strict();

const toolCallMcpDisplaySchema = z
  .object({
    kind: z.literal("mcp_tool"),
    serverName: z.string().min(1).max(256),
    toolName: z.string().min(1).max(256),
    description: z
      .string()
      .min(1)
      .max(4 * 1024)
      .optional(),
    /**
     * Structured marker sent when the official Server MCP determines this call is unavailable (quota
     * exhausted / no Coding Plan). The CLI sets it only for official sources when isError is true; the
     * UI uses it to show a notice above the input. Keep it in sync with CLI contracts'
     * mcpToolResultDisplayPayloadSchema; both sides are strict, and omitting it on either side fails the
     * entire row validation.
     */
    unavailable: z
      .object({ code: z.enum(OFFICIAL_MCP_TOOL_ERROR_CODES) })
      .strict()
      .optional(),
    ui: mcpToolDisplayUiSchema.optional(),
  })
  .strict();

export const toolCallDisplaySchema = z.discriminatedUnion("kind", [
  toolCallNodeReplImageDisplaySchema,
  toolCallTaskOutputDisplaySchema,
  toolCallRespondToCoordinatorDisplaySchema,
  toolCallMcpDisplaySchema,
  toolCallCreateWorkflowDisplaySchema,
  toolCallGetWorkflowRunDisplaySchema,
  toolCallListWorkflowRunsDisplaySchema,
  toolCallEvalWorkflowSnippetDisplaySchema,
  toolCallSavedWorkflowListDisplaySchema,
  toolCallListModelsDisplaySchema,
  toolCallResumeWorkflowRunDisplaySchema,
]);
export type ToolCallDisplay = z.infer<typeof toolCallDisplaySchema>;

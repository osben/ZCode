import { requestVerificationReasons } from "../request-security-edition/verification-policy.js";
import { zcodeProtocolTraceSchema } from "./trace.js";
// Bot reverse-reply name resolution and clarification results use the same strict schema as App and CLI.
export { channelReplyRequestSchema, channelReplyResultSchema } from "../channel-mention.js";
export { zcodeProtocolTraceSchema, type ZCodeProtocolTrace } from "./trace.js";
import {
  databaseMigrationFactsSchema,
  databaseStartupErrorCodeSchema,
  databaseStartupErrorDetailsSchema,
} from "../database-startup.js";
import {
  MCP_APPS_APP_TOOLS_MAX_PER_INSTANCE,
  MCP_APPS_APP_TOOL_CALL_ID_MAX_CHARS,
  MCP_APPS_APP_TOOL_ERROR_MESSAGE_MAX_CHARS,
  mcpAppsAppToolCallResultSchema,
  mcpAppsAppToolDescriptorSchema,
} from "../mcp-apps/appTools.js";
import { mcpAppsSamplingParamsSchema, mcpAppsSamplingResultSchema } from "../mcp-apps/sampling.js";
import { mcpAppInstanceSchema } from "../mcp-apps/instance.js";
export { conversationQuoteSchema, conversationQuotesSchema } from "../conversationSelection.js";
/* oxlint-disable eslint(max-lines) -- Keep the ZCode Protocol schema in one file so the app and agent can share the same contract. */
// ── Legacy protocol removal boundary ──────────────────────
// About 257 exports remain: legacy ZCode Protocol method contracts, request/response/event schemas,
// and session/workspace state snapshot projections (core types have moved to zcode-protocol-legacy-types.ts).
// Dead methods already removed at the root (vocabulary + schema + both implementations): session/steer,
// session/rewind, session/rewindCascade, session/previewFileRewind, session/applyFileRewind,
// the entire prompt/enhance family (including the promptEnhanceResult notification), and plugins/marketplace/list;
// the session/fork client chain is gone (the retained op + schema are consumed by the v4 forkSessionAtMessage hook).
// Consumers: the legacy services stack (zcodeProtocolClient/zcodeAgent/zcodeAgentService/zcodeSession*),
// the CLI bootstrap legacy protocol server (zcode-protocol/server-operations, plugins, session-mapper, etc.),
// and legacy UI projections (read paths such as zcodeSessionProjection).
// Delete this whole file when the legacy protocol client/server groups above are removed.
// Note: schemas with no external consumers are often internal dependencies of live schema unions; handle them with their host file, not individually.
import { z } from "zod";
import { accountProviderUnavailableReasonSchema } from "../account-provider-state.js";
import { bashOutputDisplaySchema } from "../bash-output-display.js";
import { zcodeAutomationBotDeliveryTargetSchema } from "../bots.js";
import { executionOutputPreviewSchema } from "../execution-output-preview.js";
import { completeModelPropertiesDataSchema } from "../model-config.js";
import { modelExecutionSchema } from "../model-execution.js";
import { modelSelectionSchema } from "../model-selection.js";
import { APP_USAGE_RANGES, appUsageSnapshotSchema } from "../usage-stats.js";
import { DYNAMIC_WORKFLOW_MODES } from "../dynamic-workflow-feature.js";
import { errorAttributionSchema } from "../zcode-protocol-v4/snapshot.js";
// Shared compact read-only response schema for background details; it carries no command or timing metadata.
export * from "../background-bash-output.js";
export * from "../process-diagnostic.js";
export { attachmentSourceKindSchema, type AttachmentSourceKind } from "../attachment-source.js";
import { PROTOCOL_V4_LIMITS } from "../zcode-protocol-v4/core.js";

export const zcodeTopicResourceReadParamsSchema = z
  .object({
    requestId: z.string().min(1).max(256),
    taskId: z.string().min(1).max(256),
    inputId: z.string().min(1).max(256),
    authorizationId: z.string().min(1).max(256),
    messageId: z.string().min(1).max(256),
    resourceIndex: z.number().int().nonnegative(),
  })
  .strict();
export const zcodeTopicResourceReadResultSchema = z
  .object({
    ref: z.string().min(1),
    fileName: z.string().min(1).max(1024),
    mime: z.string().min(1).max(256),
    bytes: z.number().int().min(0).max(PROTOCOL_V4_LIMITS.attachmentMaxBytes),
  })
  .strict();
export const zcodeTopicResourceCancelParamsSchema = z
  .object({ requestId: z.string().min(1).max(256), taskId: z.string().min(1).max(256) })
  .strict();
export const zcodeTopicResourceCancelResultSchema = z.object({ cancelled: z.boolean() }).strict();
export type ZCodeTopicResourceReadParams = z.infer<typeof zcodeTopicResourceReadParamsSchema>;
export type ZCodeTopicResourceReadResult = z.infer<typeof zcodeTopicResourceReadResultSchema>;
export { activeWorkSummarySchema, type ActiveWorkSummary } from "../zcode-protocol-v4/snapshot.js";
// Single source of truth for browser-use command/result contracts: agent construction, protocol validation, and the main executor share this schema.
import {
  browserBackendListResultSchema,
  browserSessionContextKindSchema,
} from "../browser-use/backend.js";
import { browserClientModeSchema, browserCommandSchema } from "../browser-use/commands.js";
import { browserCommandResultSchema } from "../browser-use/result.js";
import { OFFICIAL_MCP_AUTH_PORT_FAILURE_REASONS } from "../official-mcp-auth.js";
import { integratedTerminalShellSelectionSchema } from "../validationAppSettings.js";
import {
  zcodeSyntheticUserMessageSourceSchema as legacyZcodeSyntheticUserMessageSourceSchema,
  zcodeDeliveryKindSchema,
  zcodeInteractionRequestOriginSchema,
  zcodeMessagePartSchema,
  zcodeMessageVisibilitySchema,
  zcodeMessageWithPartsSchema,
  zcodePermissionDecisionSchema,
  zcodePermissionResponseSchema,
  zcodePermissionUpdateSchema,
  zcodeSessionApiRetryStatusSchema,
  zcodeSessionContextUsageSchema,
  zcodeSessionGoalSchema,
  zcodeSessionGoalVerificationSchema,
  zcodeSessionGoalVerificationTimelineSchema,
  zcodeSessionInfoSchema,
  zcodeSessionKindSchema,
  zcodeSessionModeSchema,
  zcodeSessionRuntimeStateSchema,
  zcodeSessionStatusSchema,
  zcodeToolStateSchema,
  zcodeWorkspaceRefSchema,
} from "../zcode-protocol-legacy-types.js";
import { zcodeTaskModeSchema } from "../zcode-task-mode-schema.js";

export * from "../localTtft.js";
export {
  hookExecutionProjectionSchema,
  hookInvocationRowSchema,
  type HookExecutionProjection,
  type HookInvocationRow,
} from "../zcode-protocol-v4/rows.js";

export const ZCODE_PROTOCOL_NAME = "ZCode Protocol" as const;
export const ZCODE_PROTOCOL_VERSION = 1 as const;
// V4 wire and the legacy main protocol coexist; do not change the legacy version for V4 physical framing.
export const ZCODE_PROTOCOL_V4_WIRE_VERSION = 3 as const;
export const zcodeRuntimeCapabilitiesSchema = z.object({
  independentPlanState: z.boolean().optional(),
});
export const zcodeProtocolErrorCodes = {
  sessionUnavailable: -32004,
} as const;

const nonEmptyString = z.string().trim().min(1);
const jsonObjectSchema = z.record(z.string(), z.unknown());
const timestampMsSchema = z.number().int().nonnegative();
const protocolInstantSchema = z.union([timestampMsSchema, nonEmptyString, z.date()]);

// Tool-result display is not covered by the model text budget. Strictly cap Node REPL images at the Agent/App protocol boundary
// so screenshots cannot turn continuous or replayable messages into unbounded payloads.
export const zcodeNodeReplImageToolResultDisplaySchema = z
  .object({
    kind: z.literal("node_repl_images"),
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
      .max(2),
    truncated: z.boolean().optional(),
    source: z.literal("browser_turn_end").optional(),
  })
  .strict();

// Likewise, CreateWorkflow type-check diagnostics use the display channel and must be capped at the protocol boundary
// so a large number of diagnostics cannot make continuous/replayable messages unbounded.
// causalityGraph is already capped at the tool-output boundary; mirror the same limits here (matching v4 rows).
// The graph vocabulary is intentionally small: step cards + actor lanes + one arrow (runs after; `back` marks only a loop edge) +
// return markers. Analyzer kind / certainty / exact / region are not included in the payload.
// For names formed only at runtime (`` agent(`Researcher${i + 1}`) ``), the statically available shape is the literal before
// the first hole (head) and the literal after the last hole (tail). At least one must be present; both are trimmed and non-empty.
// Bug fix: these two fields landed in contracts and the v4 mirror with 0a8b059f40, but were missing here in v3. Under .strict(),
// workflows with interpolated names then failed display validation and lost the whole graph, so this must match v4 field-for-field.
const zcodeWorkflowNamePatternSchema = z
  .object({
    head: z.string().min(1).max(128).optional(),
    tail: z.string().min(1).max(128).optional(),
  })
  .strict();

// One edge means “runs after”; step and phase edges share a shape, and `back` marks only a loop edge.
const zcodeWorkflowEdgeSchema = z
  .object({
    from: z.string().min(1).max(64),
    to: z.string().min(1).max(64),
    back: z.literal(true).optional(),
  })
  .strict();

const zcodeCreateWorkflowCausalityGraphDisplaySchema = z
  .object({
    steps: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            // `hole`: site ID for an open hole (docs/dynamic-workflow/presentation.md, "Holes on the timeline"); mirrors v4.
            kind: z.enum(["ask", "world-read", "hole"]),
            label: z.string().min(1).max(128),
            // Static shape of the name when an inline `agent()` receiver falls back to the label string.
            labelPattern: zcodeWorkflowNamePatternSchema.optional(),
            line: z.number().int().positive().optional(),
            column: z.number().int().positive().optional(),
            lane: z.string().min(1).max(64),
            lanes: z.array(z.string().min(1).max(64)).max(32).optional(),
            // ID of the expansion source; present only on copies expanded into may-set lanes (the live overlay correlation key).
            // This is an additive field; older payloads without it still pass .strict().
            source: z.string().min(1).max(64).optional(),
            // Phase assigned by the author with `phase("…")`.
            // Present or absent together with the graph's phases / phaseEdges / exits.
            phase: z.string().min(1).max(64).optional(),
            repeat: z.enum(["stack", "serial"]).optional(),
            // This site was filled by a completion; the value is the hole's site ID. Mirrors v4.
            fill: z.string().min(1).max(64).optional(),
          })
          .strict(),
      )
      .max(64),
    lanes: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            name: z.string().min(1).max(128).optional(),
            // Static shape when `name` is absent and the first `agent()` argument is a template with holes; mutually exclusive with name.
            namePattern: zcodeWorkflowNamePatternSchema.optional(),
            line: z.number().int().positive().optional(),
            column: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .max(32),
    // Participants and handoffs; mirrors v4.
    participants: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            phase: z.string().min(1).max(64),
            lane: z.string().min(1).max(64),
            steps: z.array(z.string().min(1).max(64)).min(1).max(64),
            member: z
              .object({ index: z.number().int().nonnegative(), of: z.number().int().positive() })
              .strict()
              .optional(),
            many: z.literal(true).optional(),
          })
          .strict(),
      )
      .max(64),
    handoffs: z
      .array(
        zcodeWorkflowEdgeSchema
          .extend({ types: z.array(z.string().min(1).max(128)).min(1).max(8).optional() })
          .strict(),
      )
      .max(256),
    // Phase vocabulary: author-defined grouping represented as nodes in the main view. Present or absent together with
    // phaseEdges / exits / Step.phase; scripts without phase markers omit all of them, and the UI falls back to step/lane view.
    // Phases with no members are still included. `unphased` has no name; the UI localizes its display label.
    phases: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            name: z.string().min(1).max(128).optional(),
            line: z.number().int().positive().optional(),
            column: z.number().int().positive().optional(),
            // Other phases still running when this phase starts (their strands have not joined yet), in phase-table order and excluding itself;
            // omitted when empty. This is a node fact, not an edge: control did not transfer from those phases, so it is not in phaseEdges.
            // The timeline uses this to fold adjacent phases into a branching band; the sidebar mini-track renders a double segment.
            alongside: z.array(z.string().min(1).max(64)).min(1).max(32).optional(),
            // This phase was filled by a completion; the value is the hole's site ID. Mirrors v4.
            fill: z.string().min(1).max(64).optional(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    phaseEdges: z.array(zcodeWorkflowEdgeSchema).max(128).optional(),
    // Phase streams (docs/dynamic-workflow/presentation.md, "Streams"): data edges whose endpoints are alongside each other,
    // represented only by {from, to}. They are not runs-after edges, do not enter phaseEdges, and have no back edge. Keep them in sync with the vocabulary.
    phaseStreams: z
      .array(z.object({ from: z.string().min(1).max(64), to: z.string().min(1).max(64) }).strict())
      .max(128)
      .optional(),
    // Still-open holes, in source order (docs/dynamic-workflow/authoring.md, "Holes"); mirrors v4.
    holes: z
      .array(
        z
          .object({
            siteId: z.string().min(1).max(64),
            name: z.string().min(1).max(128),
            type: z.string().min(1).max(128),
            phase: z.string().min(1).max(64).optional(),
            tail: z.boolean().optional(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    // Phases after which control flow can complete normally (the phase → return marker arrow in phase view); may be empty within a group.
    exits: z.array(z.string().min(1).max(64)).max(32).optional(),
    sink: z.array(z.string().min(1).max(64)).max(64).optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

export const zcodeCreateWorkflowToolResultDisplaySchema = z
  .object({
    kind: z.literal("create_workflow"),
    ok: z.boolean(),
    errorCount: z.number().int().nonnegative(),
    diagnostics: z
      .array(
        z
          .object({
            line: z.number().int().nonnegative(),
            column: z.number().int().nonnegative(),
            code: z.number().int().nonnegative(),
            message: z.string().min(1).max(2_048),
          })
          .strict(),
      )
      .max(100),
    causalityGraph: zcodeCreateWorkflowCausalityGraphDisplaySchema.optional(),
    truncated: z.boolean().optional(),
    // Which hole the FillWorkflowHole row fills (docs/dynamic-workflow/presentation.md, "The fill row"); mirrors v4.
    // Fix rationale: dwf-recursive added hole fields only to contracts and v4. The v3 .strict() schema rejected the entire tool.updated event,
    // so desktop v3 subscriptions discarded CreateWorkflow / FillWorkflowHole results containing holes as invalid events.
    fill: z
      .object({
        siteId: z.string().min(1).max(64),
        name: z.string().min(1).max(128),
        draftPath: z.string().min(1).max(1_024).optional(),
        line: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const zcodeToolResultObjectSchema = jsonObjectSchema.superRefine((result, context) => {
  const display = result.display;
  if (typeof display !== "object" || display === null || Array.isArray(display)) {
    return;
  }
  const kind = (display as Record<string, unknown>).kind;
  const schemaByKind: Record<string, z.ZodTypeAny> = {
    node_repl_images: zcodeNodeReplImageToolResultDisplaySchema,
    create_workflow: zcodeCreateWorkflowToolResultDisplaySchema,
    bash_output: bashOutputDisplaySchema,
  };
  const schema = typeof kind === "string" ? schemaByKind[kind] : undefined;
  if (!schema) return;
  const parsed = schema.safeParse(display);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    context.addIssue({ ...issue, path: ["display", ...issue.path] });
  }
});

export const zcodeProtocolRequestIdSchema = z.union([z.string(), z.number().int()]);
export type ZCodeProtocolRequestId = z.infer<typeof zcodeProtocolRequestIdSchema>;

// Remote historical attachments travel only through the existing connection's private reverse channel; each chunk stays within the RPC frame budget.
export const TOPIC_RESOURCE_RELAY_CHUNK_BYTES = 384 * 1024;
export const TOPIC_RESOURCE_RELAY_CHANNEL = "host-topic-resource";
export const zcodeTopicResourceRelayRequestSchema = zcodeTopicResourceReadParamsSchema
  .extend({
    workspacePath: z.string().min(1).max(4096),
    workspaceIdentity: z.string().min(1).max(4096),
    remoteSessionId: z.string().min(1).max(256),
    trace: zcodeProtocolTraceSchema.optional(),
  })
  .strict();
export type ZCodeTopicResourceRelayRequest = z.infer<typeof zcodeTopicResourceRelayRequestSchema>;
export const zcodeTopicResourceRelayKeySchema = zcodeTopicResourceCancelParamsSchema;
export const zcodeTopicResourceRelayChunkRequestSchema = zcodeTopicResourceRelayKeySchema
  .extend({
    index: z.number().int().nonnegative(),
  })
  .strict();
export const zcodeTopicResourceRelayMetadataSchema = z
  .object({
    fileName: z.string().min(1).max(1024),
    mime: z.string().min(1).max(256),
    bytes: z.number().int().min(0).max(PROTOCOL_V4_LIMITS.attachmentMaxBytes),
    totalChunks: z
      .number()
      .int()
      .min(0)
      .max(Math.ceil(PROTOCOL_V4_LIMITS.attachmentMaxBytes / TOPIC_RESOURCE_RELAY_CHUNK_BYTES)),
    checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export const zcodeTopicResourceRelayChunkSchema = z
  .object({
    dataBase64: z.string().max((TOPIC_RESOURCE_RELAY_CHUNK_BYTES / 3) * 4),
  })
  .strict();

export const zcodeProtocolRequestSchema = z
  .object({
    id: zcodeProtocolRequestIdSchema,
    method: nonEmptyString,
    params: z.unknown().optional(),
    trace: zcodeProtocolTraceSchema.optional(),
  })
  .strict();
export type ZCodeProtocolRequest = z.infer<typeof zcodeProtocolRequestSchema>;

export const zcodeProtocolNotificationSchema = z
  .object({
    method: nonEmptyString,
    params: z.unknown().optional(),
    trace: zcodeProtocolTraceSchema.optional(),
  })
  .strict();
export type ZCodeProtocolNotification = z.infer<typeof zcodeProtocolNotificationSchema>;

export const zcodeProtocolResponseSchema = z
  .object({
    id: zcodeProtocolRequestIdSchema,
    result: z.unknown(),
  })
  .strict();
export type ZCodeProtocolResponse = z.infer<typeof zcodeProtocolResponseSchema>;

export const zcodeProtocolErrorSchema = z
  .object({
    id: zcodeProtocolRequestIdSchema,
    error: z
      .object({
        code: z.number().int(),
        message: nonEmptyString,
        data: z.unknown().optional(),
      })
      .strict(),
  })
  .strict();
export type ZCodeProtocolError = z.infer<typeof zcodeProtocolErrorSchema>;

export const zcodeProtocolMessageSchema = z.union([
  zcodeProtocolRequestSchema,
  zcodeProtocolNotificationSchema,
  zcodeProtocolResponseSchema,
  zcodeProtocolErrorSchema,
]);
export type ZCodeProtocolMessage = z.infer<typeof zcodeProtocolMessageSchema>;

export const zcodeProtocolNotifications = {
  storageStartup: "startup/storageState",
  providerRuntimeHeadersCancelled: "interaction/providerRuntimeHeadersCancelled",
  mcpTelemetry: "process/mcpTelemetry",
  mcpResourceSamples: "process/mcpResourceSamples",
  toolExecResource: "process/toolExecResource",
  pluginOperationProgress: "plugins/operationProgress",
  processResourceSample: "process/resourceSample",
  processNetworkRequests: "process/networkRequests",
} as const;

/** Startup control plane is independent of the task stream; database identity must not carry paths or credentials. */
export const zcodeStorageStartupStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    attemptId: z.string().min(1).max(128),
    sequence: z.number().int().positive(),
    databaseId: z.string().min(1).max(128),
    databaseKind: z.enum(["session", "tasks-index"]),
    phase: z.enum(["checking", "waiting_for_lock", "migrating", "committing", "ready", "failed"]),
    // Optional lastAppliedMigrationId is captured under the lock, before version SQL; older notifications still parse.
    migration: databaseMigrationFactsSchema.optional(),
    elapsedMs: z.number().nonnegative().finite(),
    completed: z.number().int().nonnegative().optional(),
    total: z.number().int().nonnegative().optional(),
    errorCode: databaseStartupErrorCodeSchema.optional(),
    ...databaseStartupErrorDetailsSchema.shape,
  })
  .strict()
  .superRefine((state, context) => {
    if (state.phase === "failed" && !state.errorCode)
      context.addIssue({ code: "custom", message: "failed requires errorCode" });
  });
export type ZCodeStorageStartupState = z.infer<typeof zcodeStorageStartupStateSchema>;

const zcodeMcpTelemetryPlatformSchema = z.enum([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "netbsd",
  "openbsd",
  "sunos",
  "win32",
  "cygwin",
]);
const zcodeMcpTelemetryArchSchema = z.enum([
  "arm",
  "arm64",
  "ia32",
  "loong64",
  "mips",
  "mipsel",
  "ppc",
  "ppc64",
  "riscv64",
  "s390",
  "s390x",
  "x64",
]);
const zcodeMcpTelemetryBaseSchema = z
  .object({
    arch: zcodeMcpTelemetryArchSchema,
    occurredAt: z.number().int().nonnegative(),
    platform: zcodeMcpTelemetryPlatformSchema,
  })
  .strict();
const zcodeMcpProcessTelemetryBaseShape = {
  mcpId: z
    .string()
    .regex(
      /^(?:builtin:(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})+(?::(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})+)*|(?:plugin|custom):[a-f0-9]{12})$/,
    ),
  mcpInstanceId: nonEmptyString,
  mcpIsolation: z.enum(["session", "workspace"]),
  mcpSource: z.enum(["builtin", "plugin", "custom"]),
} as const;

export const zcodeMcpTelemetryEventSchema = z.discriminatedUnion("kind", [
  zcodeMcpTelemetryBaseSchema
    .extend({
      kind: z.literal("process_start"),
      ...zcodeMcpProcessTelemetryBaseShape,
    })
    .strict(),
  zcodeMcpTelemetryBaseSchema
    .extend({
      kind: z.literal("process_crash"),
      ...zcodeMcpProcessTelemetryBaseShape,
      affectedSessionCount: z.number().int().nonnegative().max(10_000),
      exitCode: z.number().int().nullable(),
      signal: nonEmptyString.nullable(),
      uptimeMs: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  zcodeMcpTelemetryBaseSchema
    .extend({
      kind: z.literal("session_startup"),
      configuredCount: z.number().int().nonnegative().max(10_000),
      connectedCount: z.number().int().nonnegative().max(10_000),
      failedCount: z.number().int().nonnegative().max(10_000),
      processCount: z.number().int().nonnegative().max(10_000),
      sessionId: nonEmptyString,
    })
    .strict(),
  zcodeMcpTelemetryBaseSchema
    .extend({
      kind: z.literal("memory"),
      ...zcodeMcpProcessTelemetryBaseShape,
      memoryKb: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
      memoryScope: z.enum(["process_tree", "direct_process"]),
      orphanSuspected: z.boolean(),
      ownerSessionCount: z.number().int().nonnegative().max(10_000),
      unownedSeconds: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
]);
export type ZCodeMcpTelemetryEvent = z.infer<typeof zcodeMcpTelemetryEventSchema>;

/** Probe MCPs only once every five minutes; the producer and total-device expiry check share this interval. */
export const ZCODE_MCP_RESOURCE_SAMPLE_INTERVAL_MS = 5 * 60_000;

export const zcodeMcpResourceSampleSchema = z
  .object({
    mcpId: zcodeMcpProcessTelemetryBaseShape.mcpId,
    instanceToken: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    sampledAt: z.number().int().nonnegative(),
    intervalMs: z.number().finite().positive(),
    processCount: z.number().int().positive().max(100_000),
    rssKbTotal: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    rssKbMaxProcess: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    cpuTimeMsDelta: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    uptimeMinutes: z.number().int().nonnegative(),
    platform: zcodeMcpTelemetryPlatformSchema,
    arch: zcodeMcpTelemetryArchSchema,
    logicalCpuCount: z.number().int().positive().max(4_096),
    totalMemoryGb: z.number().int().nonnegative().max(1_048_576),
  })
  .strict();
export type ZCodeMcpResourceSample = z.infer<typeof zcodeMcpResourceSampleSchema>;
// Notification input is bounded; main also enforces an event budget of 32 MCP groups per reporting window.
export const zcodeMcpResourceSamplesSchema = z.array(zcodeMcpResourceSampleSchema).max(1_024);

export const BASH_RESOURCE_SAMPLE_INTERVAL_MS = 15_000;
export const BASH_RESOURCE_MAX_SAMPLES = 20;

/** Bounded completion facts for Bash child processes; commands, paths, and session identifiers must not enter the telemetry side channel. */
export const zcodeToolExecResourceSchema = z
  .object({
    // The same completion fact may be forwarded by multiple Hosts; main uses this random identifier only for deduplication, and older CLIs may omit it.
    completionToken: z.string().uuid().optional(),
    platform: zcodeMcpTelemetryPlatformSchema,
    toolName: z.literal("bash"),
    durationMs: z.number().finite().min(BASH_RESOURCE_SAMPLE_INTERVAL_MS),
    exitKind: z.enum(["completed", "timeout", "killed", "error"]),
    treeRssKbPeak: z.number().finite().nonnegative().optional(),
    treeCpuTimeMs: z.number().finite().nonnegative().optional(),
    sampleCount: z.number().int().nonnegative().max(BASH_RESOURCE_MAX_SAMPLES),
    cliRssKb: z.number().finite().nonnegative(),
    systemFreeMemoryKb: z.number().finite().nonnegative(),
  })
  .strict();
export type ZCodeToolExecResource = z.infer<typeof zcodeToolExecResourceSchema>;

export const zcodeProcessResourceSampleSchema = z
  .object({
    platform: z.enum([
      "aix",
      "android",
      "darwin",
      "freebsd",
      "haiku",
      "linux",
      "netbsd",
      "openbsd",
      "sunos",
      "win32",
      "cygwin",
    ]),
    arch: z.enum([
      "arm",
      "arm64",
      "ia32",
      "loong64",
      "mips",
      "mipsel",
      "ppc",
      "ppc64",
      "riscv64",
      "s390",
      "s390x",
      "x64",
    ]),
    logicalCpuCount: z.number().int().positive().max(4_096),
    intervalMs: z
      .number()
      .int()
      .positive()
      .max(7 * 24 * 60 * 60 * 1_000),
    cpuCores: z.number().finite().nonnegative().max(4_096),
    cpuPercent: z.number().finite().nonnegative().max(100_000),
    rssKb: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    /**
     * The following four telemetry fields are all optional: samples from older CLIs still validate, so
     * **do not increment the protocol handshake version** (the handshake version is a compatibility switch, not a field version).
     */
    heapUsedKb: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    uptimeMinutes: z
      .number()
      .int()
      .nonnegative()
      .max(10 * 365 * 24 * 60)
      .optional(),
    totalMemoryGb: z.number().int().nonnegative().max(1_048_576).optional(),
    /**
     * Random instance identifier generated when the CLI process starts, used only by app-side main to count concurrent CLI processes
     * and track maximum per-process RSS. It is not an ARMS attribute and contains no pid. The restricted character set enforces a privacy boundary:
     * paths and workspace identifiers cannot pass validation.
     */
    instanceToken: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,64}$/)
      .optional(),
  })
  .strict();
export type ZCodeProcessResourceSample = z.infer<typeof zcodeProcessResourceSampleSchema>;

export const zcodeProcessChildProcessesParamsSchema = z.object({}).strict();
export const zcodeProcessChildProcessSchema = z
  .object({
    pid: z.number().int().positive(),
    serverName: nonEmptyString,
    mcpSource: z.enum(["builtin", "plugin", "custom"]),
    /** Plugin name for official/third-party plugins (`name` in `plugin:<name>:<key>`, or the plugin associated with an official host MCP); absent for custom. */
    pluginName: nonEmptyString.optional(),
  })
  .strict();
export const zcodeProcessChildProcessesResultSchema = z
  .object({
    processes: z.array(zcodeProcessChildProcessSchema).max(10_000),
  })
  .strict();
export type ZCodeProcessChildProcess = z.infer<typeof zcodeProcessChildProcessSchema>;
export type ZCodeProcessChildProcessesResult = z.infer<
  typeof zcodeProcessChildProcessesResultSchema
>;

export type ZCodeDeliveryKind = z.infer<typeof zcodeDeliveryKindSchema>;
// TurnStarted and persisted messages must share the same source vocabulary; otherwise a live event may pass while a cold
// message is rejected at the app/agent boundary, splitting continuous and replayable semantics.
// Persisted messages and input share the same source schema; agent_listing_delta is provider context only and does not start a new turn.
const zcodeTurnInputSourceSchema = legacyZcodeSyntheticUserMessageSourceSchema;
export const zcodeSessionPersistenceSchema = z.enum(["immediate", "deferred"]);
export type ZCodeSessionPersistence = z.infer<typeof zcodeSessionPersistenceSchema>;
export type ZCodeWorkspaceRef = z.infer<typeof zcodeWorkspaceRefSchema>;
export const zcodePermissionOptionSchema = z
  .object({
    optionId: nonEmptyString,
    kind: nonEmptyString,
    name: nonEmptyString,
    description: z.string().optional(),
    response: zcodePermissionResponseSchema,
  })
  .strict();

const zcodeProtocolMcpEntrySchema = z
  .object({
    name: nonEmptyString,
    value: z.string(),
  })
  .strict();

const zcodeProtocolMcpOAuthSchema = z.union([
  z
    .object({
      type: z.literal("client_credentials"),
      clientId: nonEmptyString,
      clientSecret: nonEmptyString,
      clientName: nonEmptyString.optional(),
      scope: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("authorization_code"),
      clientId: nonEmptyString.optional(),
      clientSecret: nonEmptyString.optional(),
      clientName: nonEmptyString.optional(),
      redirectPath: nonEmptyString.optional(),
      scope: z.string().optional(),
    })
    .strict(),
]);

export const zcodeProtocolMcpServerSchema = z.union([
  z
    .object({
      name: nonEmptyString,
      command: nonEmptyString,
      args: z.array(z.string()),
      env: z.array(zcodeProtocolMcpEntrySchema),
      isolation: z.enum(["session", "workspace"]).optional(),
      protocolVersion: z.enum(["legacy", "auto", "2026-07-28"]).optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      name: nonEmptyString,
      type: z.enum(["http", "sse"]),
      url: nonEmptyString,
      headers: z.array(zcodeProtocolMcpEntrySchema),
      oauth: zcodeProtocolMcpOAuthSchema.optional(),
      isolation: z.enum(["session", "workspace"]).optional(),
      protocolVersion: z.enum(["legacy", "auto", "2026-07-28"]).optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
]);
export type ZCodeProtocolMcpServer = z.infer<typeof zcodeProtocolMcpServerSchema>;

export const zcodeMcpServerStatusKindSchema = z.enum([
  "connecting",
  "connected",
  "disabled",
  "disconnected",
  "failed",
  "untrusted",
]);
export const MCP_SERVER_FAILURE_KINDS = [
  "config_invalid",
  "runtime_unavailable",
  "process_start_failed",
  "network_unreachable",
  "connection_timeout",
  "protocol_negotiation_failed",
  "tool_list_failed",
  "unexpected_disconnect",
  "oauth_authorization_failed",
  "official_origin_untrusted",
  "not_authenticated",
  "coding_plan_required",
  "server_not_found",
  "server_unavailable",
  "rate_limited",
  "server_internal_error",
  "protocol_error",
  "status_unavailable",
  "connection_failed",
] as const;
export const mcpServerFailureKindSchema = z.enum(MCP_SERVER_FAILURE_KINDS);
export type McpServerFailureKind = z.infer<typeof mcpServerFailureKindSchema>;
export const zcodeMcpServerStatusSnapshotSchema = z
  .object({
    status: zcodeMcpServerStatusKindSchema,
    transport: z.enum(["stdio", "http", "sse"]),
    toolCount: z.number().int().nonnegative(),
    updatedAt: nonEmptyString,
    error: z.string().optional(),
    failureKind: mcpServerFailureKindSchema.optional(),
    serverRequestId: nonEmptyString.optional(),
    protocolEra: z.enum(["legacy", "modern"]).optional(),
    authorization: z
      .object({
        type: z.literal("oauth_authorization_code"),
        authorizationUrl: nonEmptyString,
        startedAt: nonEmptyString,
      })
      .strict()
      .optional(),
  })
  .strict();
export type ZCodeMcpServerStatusSnapshot = z.infer<typeof zcodeMcpServerStatusSnapshotSchema>;

export const zcodeMcpListModeSchema = z.enum(["connect", "status"]);
export type ZCodeMcpListMode = z.infer<typeof zcodeMcpListModeSchema>;

export const zcodeMcpListParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    mcpServers: z.array(zcodeProtocolMcpServerSchema).optional(),
    mode: zcodeMcpListModeSchema.default("connect"),
  })
  .strict();
export const zcodeMcpListResultSchema = z
  .object({
    statuses: z.record(z.string(), zcodeMcpServerStatusSnapshotSchema),
  })
  .strict();
export type ZCodeMcpListResult = z.infer<typeof zcodeMcpListResultSchema>;

// Plugin UI: MCP resource reads and tool calls initiated by the UI are scoped to a server by pluginId;
// fail closed on the agent side.
export const zcodeMcpUiOpenInstanceParamsSchema = z
  .object({
    accountContext: z.string().max(256).optional(),
    workspace: zcodeWorkspaceRefSchema,
    sessionId: nonEmptyString,
    pluginId: nonEmptyString,
    serverName: nonEmptyString,
    scopeId: nonEmptyString.max(4096),
    resourceUri: nonEmptyString.max(2048),
    ownerWebContentsId: z.number().int().positive(),
  })
  .strict();
export const zcodeMcpUiOpenInstanceResultSchema = mcpAppInstanceSchema;
export type ZCodeMcpUiOpenInstanceParams = z.infer<typeof zcodeMcpUiOpenInstanceParamsSchema>;
const zcodeMcpUiPluginScopeShape = {
  instance: mcpAppInstanceSchema,

  workspace: zcodeWorkspaceRefSchema,
  sessionId: nonEmptyString,
  pluginId: nonEmptyString,
  serverName: nonEmptyString,
};
export const zcodeMcpUiCloseInstanceParamsSchema = z
  .object({ ...zcodeMcpUiPluginScopeShape, onlyIfIdle: z.boolean().optional() })
  .strict();
export const zcodeMcpUiCloseInstanceResultSchema = z.object({ closed: z.boolean() }).strict();
export const zcodeMcpReadResourceParamsSchema = z
  .object({ ...zcodeMcpUiPluginScopeShape, uri: nonEmptyString.max(2048) })
  .strict();
export type ZCodeMcpReadResourceParams = z.infer<typeof zcodeMcpReadResourceParamsSchema>;
export const zcodeMcpResourceContentSchema = z
  .object({
    uri: z.string(),
    mimeType: z.string().optional(),
    text: z.string().optional(),
    blob: z.string().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export const zcodeMcpReadResourceResultSchema = z
  .object({ contents: z.array(zcodeMcpResourceContentSchema) })
  .strict();
export type ZCodeMcpReadResourceResult = z.infer<typeof zcodeMcpReadResourceResultSchema>;

/**
 * Proxy for `resources/read` initiated by a plugin page.
 * It shares the parameter shape of `mcp/readResource` (the host fetches ui:// HTML), but strips `_meta`
 * from results and enforces an 8 MiB limit and a mimeType allowlist.
 */
export const zcodeMcpUiReadResourceParamsSchema = zcodeMcpReadResourceParamsSchema;
export type ZCodeMcpUiReadResourceParams = z.infer<typeof zcodeMcpUiReadResourceParamsSchema>;
export const zcodeMcpUiResourceContentSchema = z
  .object({
    uri: z.string(),
    mimeType: z.string().optional(),
    text: z.string().optional(),
    blob: z.string().optional(),
  })
  .strict();
export const zcodeMcpUiReadResourceResultSchema = z
  .object({ contents: z.array(zcodeMcpUiResourceContentSchema) })
  .strict();
export type ZCodeMcpUiReadResourceResult = z.infer<typeof zcodeMcpUiReadResourceResultSchema>;

export const zcodeMcpUiSamplingParamsSchema = z
  .object({
    ...zcodeMcpUiPluginScopeShape,
    operationId: nonEmptyString.max(128),
    request: mcpAppsSamplingParamsSchema,
  })
  .strict();
export const zcodeMcpUiCancelSamplingParamsSchema = z
  .object({ ...zcodeMcpUiPluginScopeShape, operationId: nonEmptyString.max(128) })
  .strict();
export const zcodeMcpUiSamplingResultSchema = mcpAppsSamplingResultSchema;
export type ZCodeMcpUiSamplingParams = z.infer<typeof zcodeMcpUiSamplingParamsSchema>;
export type ZCodeMcpUiCancelSamplingParams = z.infer<typeof zcodeMcpUiCancelSamplingParamsSchema>;

export const zcodeMcpUiCallToolParamsSchema = z
  .object({
    ...zcodeMcpUiPluginScopeShape,
    toolName: nonEmptyString,
    arguments: z.record(z.string(), z.unknown()).optional(),
    /** Host-generated call ID, used with `mcp/uiCancelCall` to cancel an in-flight call. */
    callId: nonEmptyString.max(128),
  })
  .strict();
export type ZCodeMcpUiCallToolParams = z.infer<typeof zcodeMcpUiCallToolParamsSchema>;
/** Cancel a tool call initiated by the page (card unmount or session switch); abort the MCP client on the agent side. */
export const zcodeMcpUiCancelCallParamsSchema = z
  .object({ ...zcodeMcpUiPluginScopeShape, callId: nonEmptyString.max(128) })
  .strict();
export type ZCodeMcpUiCancelCallParams = z.infer<typeof zcodeMcpUiCancelCallParamsSchema>;
export const zcodeMcpUiCancelCallResultSchema = z.object({ cancelled: z.boolean() }).strict();
export type ZCodeMcpUiCancelCallResult = z.infer<typeof zcodeMcpUiCancelCallResultSchema>;
/** Proxies for page-initiated resources/list, resources/templates/list, subscribe, and unsubscribe requests. */
export const zcodeMcpUiListResourcesParamsSchema = z
  .object({ ...zcodeMcpUiPluginScopeShape, cursor: nonEmptyString.max(2048).optional() })
  .strict();
export type ZCodeMcpUiListResourcesParams = z.infer<typeof zcodeMcpUiListResourcesParamsSchema>;
const zcodeMcpUiResourceDescriptorSchema = z
  .object({
    uri: z.string(),
    name: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    // Standard MCP Resource fields. The specification puts resource-level csp / prefersBorder here; the host uses them when an HTML item lacks _meta.
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export const zcodeMcpUiListResourcesResultSchema = z
  .object({
    resources: z.array(zcodeMcpUiResourceDescriptorSchema),
    nextCursor: z.string().optional(),
  })
  .strict();
export type ZCodeMcpUiListResourcesResult = z.infer<typeof zcodeMcpUiListResourcesResultSchema>;
export const zcodeMcpUiListResourceTemplatesResultSchema = z
  .object({
    resourceTemplates: z.array(
      z
        .object({
          uriTemplate: z.string(),
          name: z.string().optional(),
          title: z.string().optional(),
          description: z.string().optional(),
          mimeType: z.string().optional(),
        })
        .strict(),
    ),
    nextCursor: z.string().optional(),
  })
  .strict();
export type ZCodeMcpUiListResourceTemplatesResult = z.infer<
  typeof zcodeMcpUiListResourceTemplatesResultSchema
>;
/** Subscriber identity = session + sandbox scope + instance generation (initId); dispose unsubscribes only this generation and does not affect a new instance. */
export const zcodeMcpUiResourceSubscriptionParamsSchema = z
  .object({
    ...zcodeMcpUiPluginScopeShape,
    scopeId: nonEmptyString.max(256),
    generation: z.number().int().nonnegative(),
    uri: nonEmptyString.max(2048),
  })
  .strict();
export type ZCodeMcpUiResourceSubscriptionParams = z.infer<
  typeof zcodeMcpUiResourceSubscriptionParamsSchema
>;
export const zcodeMcpUiResourceSubscriptionResultSchema = z.object({}).strict();
/**
 * App-Provided Tools: instance identity = session + sandbox scope + generation (the same tuple as resource subscriptions).
 * Registration replaces the whole instance; call claims and results are idempotent by callId.
 */
const zcodeMcpUiAppToolInstanceShape = {
  ...zcodeMcpUiPluginScopeShape,
  scopeId: nonEmptyString.max(256),
  generation: z.number().int().nonnegative(),
};
export const zcodeMcpUiRegisterAppToolsParamsSchema = z
  .object({
    ...zcodeMcpUiAppToolInstanceShape,
    tools: z.array(mcpAppsAppToolDescriptorSchema).max(MCP_APPS_APP_TOOLS_MAX_PER_INSTANCE),
  })
  .strict();
export type ZCodeMcpUiRegisterAppToolsParams = z.infer<
  typeof zcodeMcpUiRegisterAppToolsParamsSchema
>;
export const zcodeMcpUiRegisterAppToolsResultSchema = z
  .object({ tools: z.array(z.object({ name: z.string(), modelName: z.string() }).strict()) })
  .strict();
export type ZCodeMcpUiRegisterAppToolsResult = z.infer<
  typeof zcodeMcpUiRegisterAppToolsResultSchema
>;
export const zcodeMcpUiUnregisterAppToolsParamsSchema = z
  .object(zcodeMcpUiAppToolInstanceShape)
  .strict();
export type ZCodeMcpUiUnregisterAppToolsParams = z.infer<
  typeof zcodeMcpUiUnregisterAppToolsParamsSchema
>;
export const zcodeMcpUiUnregisterAppToolsResultSchema = z
  .object({ removed: z.number().int().nonnegative() })
  .strict();
export type ZCodeMcpUiUnregisterAppToolsResult = z.infer<
  typeof zcodeMcpUiUnregisterAppToolsResultSchema
>;
export const zcodeMcpUiClaimAppToolCallParamsSchema = z
  .object({
    ...zcodeMcpUiAppToolInstanceShape,
    callId: nonEmptyString.max(MCP_APPS_APP_TOOL_CALL_ID_MAX_CHARS),
  })
  .strict();
export type ZCodeMcpUiClaimAppToolCallParams = z.infer<
  typeof zcodeMcpUiClaimAppToolCallParamsSchema
>;
export const zcodeMcpUiAppToolAcceptedResultSchema = z.object({ accepted: z.boolean() }).strict();
export type ZCodeMcpUiAppToolAcceptedResult = z.infer<typeof zcodeMcpUiAppToolAcceptedResultSchema>;
export const zcodeMcpUiResolveAppToolCallParamsSchema = z
  .object({
    ...zcodeMcpUiAppToolInstanceShape,
    callId: nonEmptyString.max(MCP_APPS_APP_TOOL_CALL_ID_MAX_CHARS),
    result: mcpAppsAppToolCallResultSchema.optional(),
    error: z
      .object({ message: z.string().max(MCP_APPS_APP_TOOL_ERROR_MESSAGE_MAX_CHARS) })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => (value.result === undefined) !== (value.error === undefined), {
    message: "exactly one of result or error is required",
  });
export type ZCodeMcpUiResolveAppToolCallParams = z.infer<
  typeof zcodeMcpUiResolveAppToolCallParamsSchema
>;
export const zcodeMcpUiCallToolResultSchema = z
  .object({
    content: z.array(z.record(z.string(), z.unknown())),
    structuredContent: z.unknown().optional(),
    isError: z.boolean().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ZCodeMcpUiCallToolResult = z.infer<typeof zcodeMcpUiCallToolResultSchema>;

export const zcodeSessionImportMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    timestamp: timestampMsSchema.optional(),
  })
  .strict();
export type ZCodeSessionImportMessage = z.infer<typeof zcodeSessionImportMessageSchema>;

export const zcodeSessionImportHistorySchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("claudeCode"),
      title: z.string().optional(),
      createdAt: timestampMsSchema.optional(),
      updatedAt: timestampMsSchema.optional(),
      messages: z.array(zcodeSessionImportMessageSchema).min(1),
    })
    .strict(),
  z
    .object({
      source: z.literal("sharedContext"),
      title: z.string().trim().min(1),
      createdAt: timestampMsSchema.optional(),
      markdown: z.string().min(1),
      provenance: z
        .object({
          shareId: z.string().trim().min(1),
          contextId: z.string().trim().min(1).optional(),
          shareUrl: z.string().url().optional(),
          status: z.enum(["pending", "reserved", "attached", "discarded"]).optional(),
          projectionSha256: z.string().regex(/^[0-9a-f]{64}$/u),
          artifactSetSha256: z.string().regex(/^[0-9a-f]{64}$/u),
          formatterVersion: z.literal(1),
          markdownSha256: z.string().regex(/^[0-9a-f]{64}$/u),
          installedArtifacts: z.array(
            z
              .object({
                artifactId: z.string().trim().min(1),
                workspaceRelativePath: z.string().trim().min(1),
              })
              .strict(),
          ),
        })
        .strict(),
    })
    .strict(),
]);
export type ZCodeSessionImportHistory = z.infer<typeof zcodeSessionImportHistorySchema>;

export const zcodeThoughtLevelOptionSchema = z
  .object({
    value: nonEmptyString,
    label: nonEmptyString,
    description: z.string().optional(),
  })
  .strict();
export const zcodeModelReasoningOptionsSchema = z
  .object({
    levels: z.array(zcodeThoughtLevelOptionSchema),
    defaultLevel: nonEmptyString.optional(),
  })
  .strict();
export type ZCodeModelReasoningOptions = z.infer<typeof zcodeModelReasoningOptionsSchema>;

export const zcodeModelFormatPropertiesSchema = completeModelPropertiesDataSchema.pick({
  inputFormat: true,
  outputFormat: true,
});
export type ZCodeModelFormatProperties = z.infer<typeof zcodeModelFormatPropertiesSchema>;

export const zcodeModelOptionSchema = z
  .object({
    ref: modelSelectionSchema,
    label: nonEmptyString,
    providerLabel: nonEmptyString.optional(),
    description: z.string().optional(),
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    reasoning: zcodeModelReasoningOptionsSchema.optional(),
    properties: zcodeModelFormatPropertiesSchema,
    disabledReason: z.string().optional(),
  })
  .strict();
export type ZCodeModelOption = z.infer<typeof zcodeModelOptionSchema>;

export const zcodeAccountAccessSchema = z.discriminatedUnion("planKind", [
  z
    .object({
      type: z.literal("zhipu-account"),
      family: z.enum(["zai", "bigmodel"]),
      planKind: z.literal("start-plan"),
    })
    .strict(),
  z
    .object({
      type: z.literal("zhipu-account"),
      family: z.enum(["zai", "bigmodel"]),
      planKind: z.literal("individual-coding-plan"),
    })
    .strict(),
  z
    .object({
      type: z.literal("zhipu-account"),
      family: z.enum(["zai", "bigmodel"]),
      planKind: z.literal("team-coding-plan"),
      productId: nonEmptyString,
      organizationId: nonEmptyString,
      projectId: nonEmptyString,
    })
    .strict(),
]);
export type ZCodeAccountAccess = z.infer<typeof zcodeAccountAccessSchema>;

/** Account access category fixed by Active Model; the current product and Team scope are resolved by the account service per request. */
export const zcodeProviderAccountAccessSchema = z
  .object({
    type: z.literal("zhipu-account"),
    accountType: z.enum(["zai", "bigmodel"]),
    // `highspeed` identifies the account access mode for acceleration cards (hidden Provider + unsigned gateway).
    // It is unrelated to the GLM-5.1-Highspeed model name; the match is only lexical. See docs/highspeed/highspeed-access-mode-migration.md.
    mode: z.enum([
      "start-plan",
      "individual-coding-plan",
      "team-coding-plan",
      "off-peak",
      "highspeed",
    ]),
    entitled: z.boolean(),
  })
  .strict();
export type ZCodeProviderAccountAccess = z.infer<typeof zcodeProviderAccountAccessSchema>;

export type ZCodeSessionMode = z.infer<typeof zcodeSessionModeSchema>;
export type ZCodeSessionKind = z.infer<typeof zcodeSessionKindSchema>;
export type ZCodeSessionGoal = z.infer<typeof zcodeSessionGoalSchema>;

export const zcodeSessionTodoItemSchema = z
  .object({
    content: nonEmptyString,
    status: z.enum(["pending", "in_progress", "completed"]),
    priority: z.enum(["high", "medium", "low"]),
  })
  .strict();
export const zcodeSessionGoalStatsSchema = z
  .object({
    timeUsedSeconds: z.number().int().nonnegative(),
    tokensUsed: z.number().int().nonnegative(),
    tokenBudget: z.number().int().positive().nullable(),
    contextUsed: z.number().int().nonnegative(),
    contextWindow: z.number().int().nonnegative(),
    toolCallCount: z.number().int().nonnegative(),
    iterationCount: z.number().int().nonnegative(),
  })
  .strict();
export type ZCodeSessionGoalStats = z.infer<typeof zcodeSessionGoalStatsSchema>;
export type ZCodeSessionGoalVerification = z.infer<typeof zcodeSessionGoalVerificationSchema>;
export type ZCodeSessionGoalVerificationTimeline = z.infer<
  typeof zcodeSessionGoalVerificationTimelineSchema
>;

export const zcodeSessionTodoGroupSchema = z
  .object({
    id: nonEmptyString,
    source: z.enum(["goal_iteration", "session"]),
    goalIteration: z.number().int().positive().optional(),
    targetId: nonEmptyString.optional(),
    startedAt: timestampMsSchema.optional(),
    updatedAt: timestampMsSchema.optional(),
    todos: z.array(zcodeSessionTodoItemSchema),
  })
  .strict();
export type ZCodeSessionTodoGroup = z.infer<typeof zcodeSessionTodoGroupSchema>;

export const zcodeSessionSettingsStateSchema = z
  .object({
    model: z
      .object({
        // Unbound is a valid recovery state; do not fabricate a model or block history reads to satisfy the protocol.
        current: modelSelectionSchema.optional(),
        available: z.array(zcodeModelOptionSchema),
        lastUsed: modelSelectionSchema.optional(),
      })
      .strict(),
    thoughtLevel: z
      .object({
        enabled: z.boolean(),
        current: nonEmptyString.optional(),
        defaultLevel: nonEmptyString.optional(),
        available: z.array(zcodeThoughtLevelOptionSchema),
      })
      .strict(),
    mode: z
      .object({
        current: zcodeSessionModeSchema,
      })
      .strict(),
    permission: z
      .object({
        mode: zcodeSessionModeSchema.optional(),
        rulesRevision: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ZCodeSessionSettingsState = z.infer<typeof zcodeSessionSettingsStateSchema>;
export const zcodePendingPermissionSchema = z
  .object({
    requestId: nonEmptyString,
    toolCallId: nonEmptyString,
    toolName: nonEmptyString,
    reason: z.string(),
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    input: z.unknown().optional(),
    origin: zcodeInteractionRequestOriginSchema.optional(),
    options: z.array(zcodePermissionOptionSchema).min(1),
    requestedAt: timestampMsSchema,
  })
  .strict();
export type ZCodePendingPermission = z.infer<typeof zcodePendingPermissionSchema>;

export const zcodeActiveToolCallSchema = z
  .object({
    toolCallId: nonEmptyString,
    toolName: nonEmptyString,
    status: z.enum(["pending", "running", "completed", "failed", "denied"]),
    startedAt: timestampMsSchema.optional(),
  })
  .strict();
export type ZCodeActiveToolCall = z.infer<typeof zcodeActiveToolCallSchema>;

export const zcodeSessionProjectionSchema = z
  .object({
    sessionId: nonEmptyString,
    status: zcodeSessionStatusSchema,
    mode: zcodeSessionModeSchema,
    turnCount: z.number().int().nonnegative(),
    totalTokenCount: z.number().int().nonnegative(),
    contextUsed: z.number().int().nonnegative(),
    contextWindow: z.number().int().nonnegative(),
    currentTurnId: nonEmptyString.optional(),
    pendingPermissions: z.array(zcodePendingPermissionSchema),
    activeToolCalls: z.array(zcodeActiveToolCallSchema),
    backgroundJobs: z.array(jsonObjectSchema),
    target: zcodeSessionGoalSchema.nullable().optional(),
    lastError: z
      .object({
        type: nonEmptyString,
        code: nonEmptyString.optional(),
        message: nonEmptyString,
        detail: z.string().optional(),
        attribution: errorAttributionSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ZCodeSessionProjection = z.infer<typeof zcodeSessionProjectionSchema>;
export type ZCodeToolState = z.infer<typeof zcodeToolStateSchema>;
export const zcodeSlashCommandSchema = z
  .object({
    name: nonEmptyString,
    description: z.string(),
    inputHint: z.string().optional(),
    source: z.enum(["builtin", "custom"]).optional(),
  })
  .strict();
export type ZCodeSessionApiRetryStatus = z.infer<typeof zcodeSessionApiRetryStatusSchema>;
export type ZCodeSessionContextUsage = z.infer<typeof zcodeSessionContextUsageSchema>;
export const zcodeModelStreamingKindSchema = z.enum([
  "start",
  "finish",
  "error",
  "text_start",
  "text_delta",
  "text_end",
  "reasoning_start",
  "reasoning_delta",
  "reasoning_end",
  "tool_input_start",
  "tool_input_delta",
  "tool_input_end",
  "tool_call",
]);
export const zcodeModelStreamingEventPayloadSchema = z
  .object({
    assistantMessageId: z.string().optional(),
    delta: z.string().optional(),
    done: z.boolean().optional(),
    input: z.unknown().optional(),
    kind: zcodeModelStreamingKindSchema,
    partId: z.string().optional(),
    providerExecuted: z.boolean().optional(),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
  })
  .strict();
export const zcodeSessionStateSnapshotSchema = z
  .object({
    protocol: z
      .object({
        name: z.literal(ZCODE_PROTOCOL_NAME),
        version: z.literal(ZCODE_PROTOCOL_VERSION),
      })
      .strict(),
    session: zcodeSessionInfoSchema,
    settings: zcodeSessionSettingsStateSchema,
    projection: zcodeSessionProjectionSchema,
    runtime: zcodeSessionRuntimeStateSchema,
    messages: z.array(zcodeMessageWithPartsSchema),
    goalStats: zcodeSessionGoalStatsSchema.optional(),
    todos: z.array(zcodeSessionTodoItemSchema).optional(),
    todoGroups: z.array(zcodeSessionTodoGroupSchema).optional(),
    slashCommands: z.array(zcodeSlashCommandSchema).optional(),
  })
  .strict();
export type ZCodeSessionStateSnapshot = z.infer<typeof zcodeSessionStateSnapshotSchema>;

export const zcodeEventEnvelopeSchema = z
  .object({
    eventId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    seq: z.number().int().nonnegative(),
    traceId: nonEmptyString.optional(),
    timestamp: timestampMsSchema,
    deliveryKind: zcodeDeliveryKindSchema.optional(),
  })
  .strict();

const zcodeComputerUseOperationEventBaseSchema = z
  .object({
    eventId: nonEmptyString,
    sequenceNumber: z.number().int().nonnegative(),
    sessionId: nonEmptyString,
    timestamp: timestampMsSchema,
  })
  .strict();

const zcodeComputerUseTurnStartedEventSchema = zcodeComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("turn-started"),
  turnId: nonEmptyString,
});
const zcodeComputerUseTurnCompletedEventSchema = zcodeComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("turn-completed"),
  turnId: nonEmptyString,
});
const zcodeComputerUseTurnFailedEventSchema = zcodeComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("turn-failed"),
  turnId: nonEmptyString,
});
const zcodeComputerUseToolScheduledEventSchema = zcodeComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("tool-scheduled"),
  turnId: nonEmptyString,
  toolCallId: nonEmptyString,
  toolName: nonEmptyString,
  // Whether this cell uses Computer Use. This is only a boolean fact; it no longer carries an action name. The old
  // operationAction extracted action names from model source and broke entirely when the SDK surface changed (see
  // usesComputerUse in bootstrap/src/zcode-protocol/computer-use-operation-event.ts).
  // Present only on scheduled: ToolCallStartedPayload has no input, so model source is unavailable at start time.
  computerUse: z.literal(true).optional(),
});
const zcodeComputerUseToolStartedEventSchema = zcodeComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("tool-started"),
  turnId: nonEmptyString.optional(),
  toolCallId: nonEmptyString,
  toolName: nonEmptyString.optional(),
});
const zcodeComputerUseSessionClosedEventSchema = zcodeComputerUseOperationEventBaseSchema.extend({
  kind: z.literal("session-closed"),
});

export const zcodeComputerUseOperationEventSchema = z.discriminatedUnion("kind", [
  zcodeComputerUseTurnStartedEventSchema,
  zcodeComputerUseTurnCompletedEventSchema,
  zcodeComputerUseTurnFailedEventSchema,
  zcodeComputerUseToolScheduledEventSchema,
  zcodeComputerUseToolStartedEventSchema,
  zcodeComputerUseSessionClosedEventSchema,
]);
export type ZCodeComputerUseOperationEvent = z.infer<typeof zcodeComputerUseOperationEventSchema>;

export const zcodeSessionEventTypeSchema = z.enum([
  "session.created",
  "session.resumed",
  "session.updated",
  "session.titleUpdated",
  "session.closed",
  "turn.started",
  "turn.steerQueued",
  "turn.steerDrained",
  "turn.completed",
  "turn.failed",
  "message.upserted",
  "message.removed",
  "part.started",
  "part.delta",
  "part.upserted",
  "part.removed",
  "model.streaming",
  "tool.updated",
  "permission.requested",
  "permission.resolved",
  "userInput.requested",
  "userInput.resolved",
  "checkpoint.created",
  "rewind.triggered",
  "streamRecovery.updated",
]);
export type ZCodeSessionEventType = z.infer<typeof zcodeSessionEventTypeSchema>;

export const zcodeProtocolErrorDetailSchema = z
  .object({
    type: nonEmptyString,
    message: nonEmptyString,
    stack: z.string().optional(),
    code: z.string().optional(),
    detail: z.string().optional(),
    underlyingErrorMessage: z.string().optional(),
    underlyingErrorDetail: z.string().optional(),
    attribution: errorAttributionSchema.optional(),
    retryable: z.boolean().optional(),
    data: z.unknown().optional(),
  })
  .strict();
export const zcodeSessionCreatedEventPayloadSchema = z
  .object({
    mode: zcodeSessionModeSchema,
    contextWindow: z.number().int().nonnegative(),
  })
  .strict();
export const zcodeSessionResumedEventPayloadSchema = z
  .object({
    directory: nonEmptyString,
    interruptedToolCount: z.number().int().nonnegative(),
    messageCount: z.number().int().nonnegative(),
    partCount: z.number().int().nonnegative(),
    recoveredCompactTimelineCount: z.number().int().nonnegative().optional(),
    recoveredSteerInputCount: z.number().int().nonnegative().optional(),
    resumedTodoCount: z.number().int().nonnegative().optional(),
  })
  .strict();
export const zcodeSessionTitleUpdatedEventPayloadSchema = z
  .object({
    messageID: nonEmptyString.optional(),
    previousTitle: z.string(),
    source: z.enum(["default", "first_input", "generated", "custom"]),
    title: z.string(),
  })
  .strict();
export const zcodeTurnStartedEventPayloadSchema = z
  .object({
    // CLI execution durations may be fractional; without this field, strict validation drops the whole start event, preventing the Bot from clearing its previous reply.
    executionStartedAt: z.number().nonnegative().optional(),
    turnNumber: z.number().int().nonnegative(),
    input: z.string(),
    inputId: nonEmptyString.optional(),
    queryId: nonEmptyString.optional(),
    inputSource: zcodeTurnInputSourceSchema.optional(),
    inputVisibility: zcodeMessageVisibilitySchema.optional(),
    executionKind: z.enum(["agent", "controlOnly"]).optional(),
    targetId: nonEmptyString.optional(),
    messageId: nonEmptyString.optional(),
    foregroundExecutionId: nonEmptyString.optional(),
    intent: jsonObjectSchema.optional(),
    originMeta: jsonObjectSchema.optional(),
    // Runtime forwards the background wake source; the strict schema must declare it too, or the whole event is discarded.
    backgroundSource: z.enum(["bash", "subagent"]).optional(),
    attachments: z.array(jsonObjectSchema).optional(),
  })
  .strict();
const zcodeTurnSteerSourceSchema = z.enum(["plan_approval_feedback", "workflow_refine_feedback"]);
const zcodeTurnSteerCommandKindSchema = z.enum(["sendText", "sendGoalCommand", "compact"]);
const zcodeTurnSteerDeliverySchema = z.enum(["queue", "guide"]);

export const zcodeTurnSteerQueuedEventPayloadSchema = z
  .object({
    pendingInputId: nonEmptyString,
    inputId: nonEmptyString.optional(),
    queryId: nonEmptyString.optional(),
    input: z.string(),
    inputPreview: z.string(),
    inputSize: z.number().int().nonnegative(),
    commandKind: zcodeTurnSteerCommandKindSchema.optional(),
    source: zcodeTurnSteerSourceSchema.optional(),
    toolDisallowlist: z.array(nonEmptyString).optional(),
    delivery: zcodeTurnSteerDeliverySchema.optional(),
    targetTurnId: nonEmptyString,
    queueLength: z.number().int().nonnegative(),
    intent: jsonObjectSchema.optional(),
  })
  .strict();
export const zcodeTurnSteerDrainedEventPayloadSchema = z
  .object({
    pendingInputIds: z.array(nonEmptyString),
    queryIds: z.array(nonEmptyString).optional(),
    targetTurnId: nonEmptyString,
    injectedMessageIds: z.array(nonEmptyString),
    drainedInputs: z
      .array(
        z
          .object({
            pendingInputId: nonEmptyString,
            messageId: nonEmptyString,
            text: z.string(),
            delivery: zcodeTurnSteerDeliverySchema.optional(),
            intent: jsonObjectSchema.optional(),
            toolDisallowlist: z.array(nonEmptyString).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export const zcodeTurnCompletedEventPayloadSchema = z
  .object({
    response: z.string(),
    tokenCount: z.number().int().nonnegative(),
    usage: z.unknown().optional(),
    toolCallCount: z.number().int().nonnegative(),
    historyRoundCount: z.number().int().nonnegative().optional(),
    duration: z.number().nonnegative(),
    // Runtime turn.completed includes cacheStats, which was previously missing from the protocol schema.
    // Strict validation failure makes Desktop discard the terminal event, so the message completes but the UI never shows a reply.
    cacheStats: z
      .object({
        totalMessages: z.number().int().nonnegative(),
        cachedMessages: z.number().int().nonnegative(),
        lastCacheHit: z.boolean(),
        cacheReadTokens: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    inputId: nonEmptyString.optional(),
    resultType: z.enum([
      "success",
      // "cancelled": User interruption is a normal completion; reuse turn.completed reporting so it is not mapped to turn.failed.
      "cancelled",
      "error_max_turns",
      "error_max_budget",
      "error_during_execution",
      "error_max_tool_calls",
    ]),
    backgroundSubagentResultConsumed: z.boolean().optional(),
  })
  .strict();
export const zcodeTurnFailedEventPayloadSchema = z
  .object({
    error: zcodeProtocolErrorDetailSchema,
    turnPhase: z.string(),
    inputId: nonEmptyString.optional(),
    backgroundSubagentResultConsumed: z.boolean().optional(),
  })
  .strict();
export const zcodeMessageUpsertedEventPayloadSchema = z
  .object({
    content: z.string(),
    attachments: z.array(z.unknown()).optional(),
    toolCalls: z.array(z.unknown()).optional(),
    type: z.string().optional(),
    compactBoundary: z.unknown().optional(),
  })
  .strict();
export const zcodeMessageRemovedEventPayloadSchema = z
  .object({
    messageId: nonEmptyString,
    reason: z.string().optional(),
  })
  .strict();
export const zcodeMessagePartDeltaEventPayloadSchema = z
  .object({
    messageId: nonEmptyString,
    partId: nonEmptyString,
    field: z.enum(["text", "reasoning", "input", "output"]).optional(),
    delta: z.string(),
  })
  .strict();
export const zcodeMessagePartUpsertedEventPayloadSchema = z
  .object({
    part: zcodeMessagePartSchema,
  })
  .strict();
export const zcodeMessagePartRemovedEventPayloadSchema = z
  .object({
    messageId: nonEmptyString,
    partId: nonEmptyString,
    reason: z.string().optional(),
  })
  .strict();
const zcodeToolCallBasePayloadSchema = z
  .object({
    toolCallId: nonEmptyString,
    toolName: z.string().optional(),
    parentToolCallId: nonEmptyString.optional(),
    source: z.enum(["subagent"]).optional(),
    agentId: nonEmptyString.optional(),
    agentType: nonEmptyString.optional(),
    // The subagent mirror includes background attribution; if the strict schema omits the field, the entire session/event is discarded.
    background: z.boolean().optional(),
    childSessionId: nonEmptyString.optional(),
    childToolCallId: nonEmptyString.optional(),
    description: z.string().optional(),
  })
  .strict();

export const zcodeToolUpdatedEventPayloadSchema = z.discriminatedUnion("kind", [
  zcodeToolCallBasePayloadSchema
    .extend({
      kind: z.literal("scheduled"),
      // Fix: CLI scheduler events include the owning message ID; omitting it here makes strict validation discard the whole event.
      assistantMessageId: nonEmptyString.optional(),
      toolName: nonEmptyString,
      input: z.unknown().optional(),
      inputByteLength: z.number().int().nonnegative().optional(),
      inputOmitted: z.boolean().optional(),
      inputRef: z.literal("model_stream").optional(),
      dependencies: z.array(nonEmptyString).optional(),
      parallelGroupIndex: z.number().int().nonnegative().optional(),
      canRunParallel: z.boolean().optional(),
      schedule: jsonObjectSchema.optional(),
    })
    .strict(),
  zcodeToolCallBasePayloadSchema
    .extend({
      kind: z.literal("started"),
      startedAt: protocolInstantSchema,
    })
    .strict(),
  zcodeToolCallBasePayloadSchema
    .extend({
      kind: z.literal("progress"),
      elapsedMs: z.number().nonnegative().optional(),
      pid: z.number().int().optional(),
      stdoutBytes: z.number().int().nonnegative().optional(),
      stderrBytes: z.number().int().nonnegative().optional(),
      outputBytes: z.number().int().nonnegative().optional(),
      outputPreview: executionOutputPreviewSchema.optional(),
      stdoutTail: z.string().optional(),
      stderrTail: z.string().optional(),
    })
    .strict(),
  zcodeToolCallBasePayloadSchema
    .extend({
      kind: z.literal("result"),
      result: zcodeToolResultObjectSchema,
      duration: z.number().nonnegative(),
    })
    .strict(),
  zcodeToolCallBasePayloadSchema
    .extend({
      kind: z.literal("error"),
      error: zcodeProtocolErrorDetailSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("batch"),
      toolCallIds: z.array(nonEmptyString),
      successCount: z.number().int().nonnegative(),
      errorCount: z.number().int().nonnegative(),
    })
    .strict(),
  zcodeToolCallBasePayloadSchema
    .extend({
      kind: z.literal("raw"),
      payload: jsonObjectSchema,
    })
    .strict(),
]);
export const zcodePermissionRequestedEventPayloadSchema = z
  .object({
    requestId: nonEmptyString.optional(),
    toolCallId: nonEmptyString,
    toolName: nonEmptyString,
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    reason: z.string(),
    input: z.unknown(),
    suggestedPermissionUpdates: z.array(zcodePermissionUpdateSchema).optional(),
    approvalMode: z.literal("user-once").optional(),
    origin: zcodeInteractionRequestOriginSchema.optional(),
    options: z.array(zcodePermissionOptionSchema).min(1),
    childSessionId: nonEmptyString.optional(),
    background: z.boolean().optional(),
  })
  .strict();
export const zcodePermissionResolvedEventPayloadSchema = z
  .object({
    requestId: nonEmptyString.optional(),
    toolCallId: nonEmptyString,
    toolName: nonEmptyString.optional(),
    decision: zcodePermissionDecisionSchema.optional(),
    reason: z.string().optional(),
    modifiedInput: z.unknown().optional(),
    inputSummary: z.unknown().optional(),
    childSessionId: nonEmptyString.optional(),
    background: z.boolean().optional(),
  })
  .strict();
export const zcodeUserInputRequestedEventPayloadSchema = z
  .object({
    requestId: nonEmptyString,
    prompt: z.string(),
    inputType: z.enum(["text", "choice", "confirm"]).optional(),
    choices: z.array(z.string()).optional(),
  })
  .strict();
export const zcodeUserInputResolvedEventPayloadSchema = z
  .object({
    requestId: nonEmptyString,
    value: z.unknown().optional(),
    cancelled: z.boolean().optional(),
  })
  .strict();
export const zcodeSessionClosedEventPayloadSchema = z
  .object({
    reason: z.string().optional(),
  })
  .strict();

function zcodeSessionEventEnvelopeFor<T extends ZCodeSessionEventType>(
  type: T,
  payload: z.ZodTypeAny,
) {
  return zcodeEventEnvelopeSchema.extend({
    type: z.literal(type),
    payload: payload.optional(),
  });
}

export const zcodeSessionEventSchema = z.discriminatedUnion("type", [
  zcodeSessionEventEnvelopeFor("session.created", zcodeSessionCreatedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("session.resumed", zcodeSessionResumedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("session.updated", jsonObjectSchema),
  zcodeSessionEventEnvelopeFor("session.titleUpdated", zcodeSessionTitleUpdatedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("session.closed", zcodeSessionClosedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("turn.started", zcodeTurnStartedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("turn.steerQueued", zcodeTurnSteerQueuedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("turn.steerDrained", zcodeTurnSteerDrainedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("turn.completed", zcodeTurnCompletedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("turn.failed", zcodeTurnFailedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("message.upserted", zcodeMessageUpsertedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("message.removed", zcodeMessageRemovedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("part.started", zcodeMessagePartUpsertedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("part.delta", zcodeMessagePartDeltaEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("part.upserted", zcodeMessagePartUpsertedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("part.removed", zcodeMessagePartRemovedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("model.streaming", zcodeModelStreamingEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("tool.updated", zcodeToolUpdatedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("permission.requested", zcodePermissionRequestedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("permission.resolved", zcodePermissionResolvedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("userInput.requested", zcodeUserInputRequestedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("userInput.resolved", zcodeUserInputResolvedEventPayloadSchema),
  zcodeSessionEventEnvelopeFor("checkpoint.created", jsonObjectSchema),
  zcodeSessionEventEnvelopeFor("rewind.triggered", jsonObjectSchema),
  zcodeSessionEventEnvelopeFor("streamRecovery.updated", jsonObjectSchema),
]);
export type ZCodeSessionEvent = z.infer<typeof zcodeSessionEventSchema>;

export const zcodeSessionEventsResultSchema = z
  .object({
    events: z.array(zcodeSessionEventSchema),
  })
  .strict();
export const zcodeSessionMessagesResultSchema = z
  .object({
    messages: z.array(zcodeMessageWithPartsSchema),
  })
  .strict();
export const zcodeStateUpdatedNotificationSchema = z
  .object({
    type: z.literal("state.updated"),
    scope: z.enum(["server", "workspace", "session"]),
    workspace: zcodeWorkspaceRefSchema.optional(),
    sessionId: nonEmptyString.optional(),
    revision: z.number().int().nonnegative(),
    reason: z.string().optional(),
    patch: z.unknown(),
  })
  .strict();
export type ZCodeStateUpdatedNotification = z.infer<typeof zcodeStateUpdatedNotificationSchema>;

export const zcodeSessionSubscribeParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    deliveryKind: zcodeDeliveryKindSchema,
    afterSeq: z.number().int().nonnegative().optional(),
    includeSnapshot: z.boolean().default(false),
  })
  .strict();
export type ZCodeSessionSubscribeParams = z.infer<typeof zcodeSessionSubscribeParamsSchema>;

export const zcodeSessionSubscribeResultSchema = z
  .object({
    sessionId: nonEmptyString,
    eventSeq: z.number().int().nonnegative(),
    events: z.array(zcodeSessionEventSchema),
    snapshot: zcodeSessionStateSnapshotSchema.optional(),
  })
  .strict();
export const zcodeSessionListResultSchema = z
  .object({
    sessions: z.array(zcodeSessionInfoSchema),
  })
  .strict();

const zcodeSessionSubagentBaseSchema = z
  .object({
    childSessionId: nonEmptyString,
    agentId: nonEmptyString.optional(),
    toolCallId: nonEmptyString.optional(),
    subagentType: nonEmptyString,
    title: nonEmptyString,
    summary: z.string().optional(),
    startedAt: z.number().int().nonnegative().optional(),
    endedAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export const zcodeSessionRunningSubagentSchema = zcodeSessionSubagentBaseSchema.extend({
  status: z.enum(["running", "waiting", "blocked"]),
});
export type ZCodeSessionRunningSubagent = z.infer<typeof zcodeSessionRunningSubagentSchema>;

export const zcodeSessionEndedSubagentSchema = zcodeSessionSubagentBaseSchema.extend({
  status: z.enum(["success", "failed", "cancelled", "lost"]),
});
export type ZCodeSessionEndedSubagent = z.infer<typeof zcodeSessionEndedSubagentSchema>;

export const zcodeSessionSubagentsResultSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    childSessionIds: z.array(nonEmptyString),
    running: z.array(zcodeSessionRunningSubagentSchema),
    ended: z
      .object({
        total: z.number().int().nonnegative(),
        items: z.array(zcodeSessionEndedSubagentSchema),
        nextCursor: nonEmptyString.optional(),
      })
      .strict(),
  })
  .strict();
export type ZCodeSessionSubagentsResult = z.infer<typeof zcodeSessionSubagentsResultSchema>;
/** Zod representation in the protocol of the server feature-key domain (packages/shared/src/dynamic-workflow-feature.ts). */
export const zcodeDynamicWorkflowModeSchema = z.enum(DYNAMIC_WORKFLOW_MODES);

/**
 * Execution worktree for sessions whose agent runs in a linked git worktree while the session
 * stays listed under the parent workspace. `path` is the absolute worktree directory used as the
 * session execution cwd; `branchName` is the checked-out branch, persisted for display only.
 */
export const zcodeExecutionWorktreeSchema = z
  .object({
    path: nonEmptyString,
    // Optional: cold sessions-index seeds read the persisted row where the branch may be absent.
    branchName: nonEmptyString.optional(),
  })
  .strict();
export type ZCodeExecutionWorktree = z.infer<typeof zcodeExecutionWorktreeSchema>;

export const zcodeSessionCreateParamsSchema = z
  .object({
    sessionId: nonEmptyString.optional(),
    workspace: zcodeWorkspaceRefSchema,
    executionWorktree: zcodeExecutionWorktreeSchema.optional(),
    parentSessionId: nonEmptyString.optional(),
    mode: zcodeSessionModeSchema.optional(),
    model: modelSelectionSchema.optional(),
    persistence: zcodeSessionPersistenceSchema.optional(),
    thoughtLevel: nonEmptyString.optional(),
    titleGenerationEnabled: z.boolean().optional(),
    mcpServers: z.array(zcodeProtocolMcpServerSchema).optional(),
    toolAllowlist: z.array(nonEmptyString).optional(),
    toolDenylist: z.array(nonEmptyString).optional(),
    importedHistory: zcodeSessionImportHistorySchema.optional(),
    // Host decides whether to register tools based only on local-service assembly and remote/endpoint form, not rollout state.
    // Omitted means not registered; rollout and plan admission are checked by the Host handler when it is created.
    offPeakToolEnabled: z.boolean().optional(),
    // Dynamic workflow rollout follows the same pattern as offPeakToolEnabled:
    // Host decides and sends the value; omitted means the workflow tool group is not registered (fail-closed).
    dynamicWorkflowEnabled: z.boolean().optional(),
    // Send rollout mode alongside the boolean (launch.md, "On demand: activation"): `onDemand` tells the CLI
    // to defer registering the ten tools until the session's first `/workflow`; absent means follow the boolean (alwaysOn), for compatibility with older Hosts.
    dynamicWorkflowMode: zcodeDynamicWorkflowModeSchema.optional(),
  })
  .strict();
export type ZCodeSessionCreateParams = z.infer<typeof zcodeSessionCreateParamsSchema>;

export const zcodeSessionResumeParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    workspace: zcodeWorkspaceRefSchema.optional(),
    // For older sessions without a runtime/model_selection entry, use migration hints from the same task's index metadata.
    thoughtLevel: nonEmptyString.optional(),
    mcpServers: z.array(zcodeProtocolMcpServerSchema).optional(),
    // Cold recovery must rebuild the runtime with create's tool-surface constraints (otherwise it bypasses allow/deny, especially for CUA sessions).
    toolAllowlist: z.array(nonEmptyString).optional(),
    toolDenylist: z.array(nonEmptyString).optional(),
    // Same semantics as create; omitting this from resume makes cold recovery lose the Off-Peak tool surface.
    offPeakToolEnabled: z.boolean().optional(),
    // Same semantics as create; omitting this from resume makes cold recovery lose the workflow tool group.
    dynamicWorkflowEnabled: z.boolean().optional(),
    dynamicWorkflowMode: zcodeDynamicWorkflowModeSchema.optional(),
  })
  .strict();
export type ZCodeSessionResumeParams = z.infer<typeof zcodeSessionResumeParamsSchema>;

export const zcodeSessionListParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema.optional(),
    // Explicit identity queries include hidden sessions; ordinary lists still return only primary tasks, so index repair cannot activate a runtime.
    sessionIds: z.array(nonEmptyString).min(1).max(64).optional(),
    includeArchived: z.boolean().default(false),
    limit: z.number().int().positive().optional(),
  })
  .strict();
export type ZCodeSessionListParams = z.infer<typeof zcodeSessionListParamsSchema>;

export const zcodeSessionSubagentsParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    endedCursor: nonEmptyString.optional(),
    endedLimit: z.number().int().positive().max(100).default(20),
  })
  .strict();
export type ZCodeSessionSubagentsParams = z.infer<typeof zcodeSessionSubagentsParamsSchema>;

export const zcodeUsageStatsParamsSchema = z
  .object({
    range: z.enum(APP_USAGE_RANGES),
    timeZone: z.string().optional(),
  })
  .strict();
export const zcodeUsageStatsResultSchema = appUsageSnapshotSchema;
export const zcodeTaskTokenUsageParamsSchema = z
  .object({
    sessionId: nonEmptyString,
  })
  .strict();
export const zcodeTaskTokenUsageResultSchema = z
  .object({
    sessionId: nonEmptyString,
    totalTokens: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
    cacheCreationTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    modelRequestCount: z.number().int().nonnegative(),
    modelErrorCount: z.number().int().nonnegative(),
    inputBaselineBySource: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();
export type ZCodeTaskTokenUsageResult = z.infer<typeof zcodeTaskTokenUsageResultSchema>;

export const zcodeSessionReadParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    deliveryKind: zcodeDeliveryKindSchema.optional(),
    messageLimit: z.number().int().positive().optional(),
    afterSeq: z.number().int().nonnegative().optional(),
    // "index": used only for task index resync. Returns the same snapshot shape with large tool/reasoning/data URL payloads stripped;
    // do not write the result back to UI state. Defaults to "full".
    contentProfile: z.enum(["full", "index"]).optional(),
  })
  .strict();
export type ZCodeSessionReadParams = z.infer<typeof zcodeSessionReadParamsSchema>;

export const zcodeSessionMessagesParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    afterMessageId: nonEmptyString.optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();
export type ZCodeSessionMessagesParams = z.infer<typeof zcodeSessionMessagesParamsSchema>;

export const zcodeSessionEventsParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    afterSeq: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();
export type ZCodeSessionEventsParams = z.infer<typeof zcodeSessionEventsParamsSchema>;

export const zcodeSessionRuntimePreferencesScopeSchema = z.enum([
  "runtime-materialization",
  "user-execution",
]);
export type ZCodeSessionRuntimePreferencesScope = z.infer<
  typeof zcodeSessionRuntimePreferencesScopeSchema
>;

// subagents/readRuntimeConfig returns the complete Host-resolved snapshot or an explicit built-in fallback; it no longer sends Markdown.
export {
  subagentRuntimeConfigSchema,
  type SubagentRuntimeConfig,
} from "../subagent-runtime-config.js";
export const zcodeSubagentsReadRuntimeConfigParamsSchema = z
  .object({ sessionId: nonEmptyString })
  .strict();

export const ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS = 15_000;

export const zcodeSessionRequestRuntimePreferencesParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    scope: zcodeSessionRuntimePreferencesScopeSchema,
  })
  .strict();
export type ZCodeSessionRequestRuntimePreferencesParams = z.infer<
  typeof zcodeSessionRequestRuntimePreferencesParamsSchema
>;

export const DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY = "preflight-v1" as const;

// 3.12.2: legacy is retained only for old-protocol receive compatibility; Runtime always normalizes to the shared defaults above.
export const zcodeModelContextBudgetStrategySchema = z.enum(["legacy", "preflight-v1"]);
export type ZCodeModelContextBudgetStrategy = z.infer<typeof zcodeModelContextBudgetStrategySchema>;

export const zcodeSessionRuntimePreferencesResultSchema = z
  .object({
    nativeSearchEnhancementsEnabled: z.boolean(),
    subagentRuntimeConfigEnabled: z.boolean().optional(),
    memoryEnabled: z.boolean().default(false),
    askUserQuestionAutoResolutionEnabled: z.boolean().default(true),
    integratedTerminalShell: integratedTerminalShellSelectionSchema.optional(),
    // Compatibility with older Hosts: when the field is missing, use the current defaults at the protocol parsing boundary.
    modelContextBudgetStrategy: zcodeModelContextBudgetStrategySchema.default(
      DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
    ),
  })
  .strict();
export type ZCodeSessionRuntimePreferencesResult = z.infer<
  typeof zcodeSessionRuntimePreferencesResultSchema
>;

/**
 * Read-only snapshot of visible IAB state collected by the app before submitting a prompt. This field is only for provider-visible
 * ambient context and is not included in the user-visible transcript; content is bounded and must not include page text or credentials.
 */
export const zcodeBrowserAmbientContextSchema = z
  .object({
    tabCount: z.number().int().positive().max(100),
    currentUrl: z.string().trim().min(1).max(4096).optional(),
  })
  .strict();
export type ZCodeBrowserAmbientContext = z.infer<typeof zcodeBrowserAmbientContextSchema>;

export const zcodeSessionSendParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    modelSelection: modelSelectionSchema.optional(),
    modelExecution: modelExecutionSchema.optional(),
    inputId: nonEmptyString.optional(),
    queryId: nonEmptyString.optional(),
    content: z.string(),
    attachments: z.array(jsonObjectSchema).optional(),
    browserAmbientContext: zcodeBrowserAmbientContextSchema.optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    expectedProviderRevision: nonEmptyString.optional(),
    automationId: nonEmptyString.optional(),
    offPeakTaskId: nonEmptyString.optional(),
    offPeakRunType: z.enum(["init", "resume"]).optional(),
    botDeliveryTarget: zcodeAutomationBotDeliveryTargetSchema.optional(),
    toolDenylist: z.array(nonEmptyString).optional(),
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.automationId && payload.offPeakTaskId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "automationId and offPeakTaskId are mutually exclusive",
      });
    }
    if (payload.offPeakRunType && !payload.offPeakTaskId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "offPeakRunType requires offPeakTaskId",
        path: ["offPeakRunType"],
      });
    }
    if (payload.modelExecution && !payload.modelSelection) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "modelExecution requires modelSelection",
        path: ["modelExecution"],
      });
    }
  });
export const zcodeSessionSendResultSchema = z
  .object({
    sessionId: nonEmptyString,
    accepted: z.literal(true),
    stateRevision: z.number().int().nonnegative(),
  })
  .strict();
export type ZCodeSessionSendResult = z.infer<typeof zcodeSessionSendResultSchema>;

export const zcodeSessionHistoryTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("turn"),
      turnIndex: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("message"),
      messageId: nonEmptyString,
    })
    .strict(),
  z
    .object({
      kind: z.literal("checkpoint"),
      checkpointId: nonEmptyString,
    })
    .strict(),
  z
    .object({
      kind: z.literal("latestCheckpoint"),
    })
    .strict(),
]);
export type ZCodeSessionHistoryTarget = z.infer<typeof zcodeSessionHistoryTargetSchema>;

export const zcodeSessionForkParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    target: zcodeSessionHistoryTargetSchema.default({
      kind: "latestCheckpoint",
    }),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ZCodeSessionForkParams = z.infer<typeof zcodeSessionForkParamsSchema>;

export const zcodeSessionForkResultSchema = z
  .object({
    forkedSessionId: nonEmptyString,
    parentSessionId: nonEmptyString.optional(),
    targetMessageId: nonEmptyString.optional(),
    targetCheckpointId: nonEmptyString.optional(),
    response: z.string(),
    snapshot: zcodeSessionStateSnapshotSchema,
  })
  .strict();
export type ZCodeSessionForkResult = z.infer<typeof zcodeSessionForkResultSchema>;

export const zcodeSessionCompactParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    inputId: nonEmptyString.optional(),
    instructions: z.string().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ZCodeSessionCompactParams = z.infer<typeof zcodeSessionCompactParamsSchema>;

export const zcodeSessionCompactResultSchema = z
  .object({
    response: z.string(),
    snapshot: zcodeSessionStateSnapshotSchema,
    compact: z
      .object({
        state: z.enum(["accepted", "already_running"]),
        inputId: nonEmptyString.optional(),
        operationId: nonEmptyString.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ZCodeSessionCompactResult = z.infer<typeof zcodeSessionCompactResultSchema>;

export const zcodeSessionGoalActionSchema = z.enum([
  "show",
  "set",
  "replace",
  "pause",
  "resume",
  "clear",
]);
export type ZCodeSessionGoalAction = z.infer<typeof zcodeSessionGoalActionSchema>;

export const zcodeSessionGoalParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    inputId: nonEmptyString.optional(),
    action: zcodeSessionGoalActionSchema,
    objective: z.string().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ZCodeSessionGoalParams = z.infer<typeof zcodeSessionGoalParamsSchema>;

export const zcodeSessionGoalResultSchema = z
  .object({
    response: z.string(),
    snapshot: zcodeSessionStateSnapshotSchema,
    startedTurn: z.boolean().optional(),
  })
  .strict();
export type ZCodeSessionGoalResult = z.infer<typeof zcodeSessionGoalResultSchema>;

export const zcodeSessionStopParamsSchema = z
  .object({
    sessionId: nonEmptyString,
  })
  .strict();
const zcodeBackgroundTaskInfoStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "spawn_error",
  "lost",
]);

export const zcodeBackgroundTaskInfoSchema = z
  .object({
    taskId: nonEmptyString,
    toolCallId: nonEmptyString.optional(),
    toolName: nonEmptyString.optional(),
    taskKind: z.enum(["bash", "subagent"]).optional(),
    blocked: z.boolean().optional(),
    blockedReason: z.string().optional(),
    cancellable: z.boolean().optional(),
    cancelRequestedAt: protocolInstantSchema.optional(),
    command: z.string().optional(),
    description: z.string().optional(),
    status: zcodeBackgroundTaskInfoStatusSchema,
    pid: z.number().int().positive().optional(),
    startedAt: protocolInstantSchema.optional(),
    completedAt: protocolInstantSchema.optional(),
    outputPath: z.string().optional(),
    stderrPersistedOutputPath: z.string().optional(),
    stdoutPersistedOutputPath: z.string().optional(),
    outputBytes: z.number().int().nonnegative().optional(),
    outputTruncated: z.boolean().optional(),
    outputTail: z.string().optional(),
    stderrBytes: z.number().int().nonnegative().optional(),
    stderrTail: z.string().optional(),
    stdoutBytes: z.number().int().nonnegative().optional(),
    stdoutTail: z.string().optional(),
    terminalId: nonEmptyString.optional(),
  })
  .strict();
export const zcodeSessionCancelBackgroundTaskParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    taskId: nonEmptyString,
  })
  .strict();
export type ZCodeSessionCancelBackgroundTaskParams = z.infer<
  typeof zcodeSessionCancelBackgroundTaskParamsSchema
>;

export const zcodeSessionCancelBackgroundTaskResultSchema = z
  .object({
    cancelled: z.boolean(),
    reason: z.string().optional(),
    snapshot: zcodeBackgroundTaskInfoSchema.optional(),
    status: zcodeBackgroundTaskInfoStatusSchema,
    taskId: nonEmptyString,
  })
  .strict();
export type ZCodeSessionCancelBackgroundTaskResult = z.infer<
  typeof zcodeSessionCancelBackgroundTaskResultSchema
>;

export const zcodeSessionSetModelParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    model: modelSelectionSchema,
    expectedRevision: z.number().int().nonnegative().optional(),
    persistAsWorkspaceLastUsed: z.boolean().default(true),
  })
  .strict();
export type ZCodeSessionSetModelParams = z.infer<typeof zcodeSessionSetModelParamsSchema>;

export const zcodeSessionSetThoughtLevelParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    thoughtLevel: nonEmptyString.optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    persistAsWorkspaceLastUsed: z.boolean().default(true),
  })
  .strict();
export type ZCodeSessionSetThoughtLevelParams = z.infer<
  typeof zcodeSessionSetThoughtLevelParamsSchema
>;

export const zcodeSessionSetModeParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    mode: zcodeSessionModeSchema,
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ZCodeSessionSetModeParams = z.infer<typeof zcodeSessionSetModeParamsSchema>;

export const zcodeSessionCloseParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    expectedPersistence: zcodeSessionPersistenceSchema.optional(),
  })
  .strict();
export type ZCodeSessionCloseParams = z.infer<typeof zcodeSessionCloseParamsSchema>;
export const zcodeSessionCloseResultSchema = z
  .object({
    closed: z.boolean().optional(),
  })
  .strict();
export type ZCodeSessionCloseResult = z.infer<typeof zcodeSessionCloseResultSchema>;
export const zcodeWorkspaceReadPresentationParamsSchema = z
  .object({ workspace: zcodeWorkspaceRefSchema })
  .strict();
export const zcodeWorkspacePresentationSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    mode: zcodeSessionModeSchema,
    slashCommands: z.array(zcodeSlashCommandSchema),
  })
  .strict();
export type ZCodeWorkspacePresentation = z.infer<typeof zcodeWorkspacePresentationSchema>;
const workspaceHookSha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const zcodeWorkspaceHookTrustGrantParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    bundleDigest: workspaceHookSha256DigestSchema,
    hookDeclarationDigest: workspaceHookSha256DigestSchema,
  })
  .strict();
export type ZCodeWorkspaceHookTrustGrantParams = z.infer<
  typeof zcodeWorkspaceHookTrustGrantParamsSchema
>;
export const zcodeWorkspaceHookTrustGrantReasonCodeSchema = z.enum([
  "workspace_hooks_blocked_by_policy",
  "workspace_hooks_bundle_changed",
  "workspace_hooks_snapshot_mismatch",
  "workspace_hooks_policy_requires_pretrust",
  "workspace_hooks_trust_store_corrupt",
  "workspace_hooks_config_unreadable",
]);
export type ZCodeWorkspaceHookTrustGrantReasonCode = z.infer<
  typeof zcodeWorkspaceHookTrustGrantReasonCodeSchema
>;
export const zcodeWorkspaceHookTrustGrantResultSchema = z
  .object({
    accepted: z.boolean(),
    reasonCode: zcodeWorkspaceHookTrustGrantReasonCodeSchema.optional(),
  })
  .strict();
export type ZCodeWorkspaceHookTrustGrantResult = z.infer<
  typeof zcodeWorkspaceHookTrustGrantResultSchema
>;
const zcodeWorkspaceModelToolCallSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    input: z.unknown(),
  })
  .strict();
const zcodeWorkspaceModelMessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: z.string() }).strict(),
  z.object({ role: z.literal("user"), content: z.string() }).strict(),
  z
    .object({
      role: z.literal("assistant"),
      content: z.string(),
      toolCalls: z.array(zcodeWorkspaceModelToolCallSchema).optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal("tool"),
      content: z.string(),
      toolCallId: nonEmptyString,
      toolName: nonEmptyString,
      isError: z.boolean().optional(),
    })
    .strict(),
]);
const zcodeWorkspaceModelToolSchema = z
  .object({
    name: nonEmptyString,
    description: z.string().optional(),
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .strict();

export const zcodeWorkspaceGenerateTextParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    selection: modelSelectionSchema,
    prompt: nonEmptyString.optional(),
    messages: z.array(zcodeWorkspaceModelMessageSchema).min(1).optional(),
    tools: z.array(zcodeWorkspaceModelToolSchema).optional(),
    querySource: nonEmptyString,
    maxOutputTokens: z.number().int().positive().optional(),
    operationId: nonEmptyString.optional(),
  })
  .strict()
  .refine((value) => value.prompt !== undefined || value.messages !== undefined, {
    message: "prompt 或 messages 至少需要提供一个",
  });
const zcodeProviderRateLimitWindowSchema = z
  .object({
    usedPercent: z.number().min(0).max(100),
    windowMinutes: z.number().int().positive().optional(),
    resetsAt: z.string().optional(),
  })
  .strict();
/**
 * ChatGPT plan (SIWC) usage windows passively captured from model response headers
 * (`x-codex-primary-*` / `x-codex-secondary-*`). Additive optional member of usage payloads;
 * `resetsAt` is the RFC3339 string verbatim. Exported so host-side consumers validate the
 * same shape the protocol carries.
 */
export const zcodeProviderRateLimitsSchema = z
  .object({
    primary: zcodeProviderRateLimitWindowSchema,
    secondary: zcodeProviderRateLimitWindowSchema.optional(),
  })
  .strict();
export type ZCodeProviderRateLimits = z.infer<typeof zcodeProviderRateLimitsSchema>;
export const zcodeWorkspaceGenerateTextResultSchema = z
  .object({
    text: z.string(),
    selection: modelSelectionSchema,
    toolCalls: z.array(zcodeWorkspaceModelToolCallSchema).optional(),
    // Optional for compatibility with older app-server processes still running; new CLIs always return a structured completion reason.
    finishReason: z.string().optional(),
    usage: z
      .object({
        inputTokens: z.number().nonnegative().optional(),
        outputTokens: z.number().nonnegative().optional(),
        totalTokens: z.number().nonnegative().optional(),
        cacheReadTokens: z.number().nonnegative().optional(),
        cacheWriteTokens: z.number().nonnegative().optional(),
        reasoningTokens: z.number().nonnegative().optional(),
        serverToolUse: z
          .object({
            webSearchRequests: z.number().nonnegative().optional(),
            webFetchRequests: z.number().nonnegative().optional(),
          })
          .strict()
          .optional(),
        providerRateLimits: zcodeProviderRateLimitsSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ZCodeWorkspaceGenerateTextParams = z.infer<
  typeof zcodeWorkspaceGenerateTextParamsSchema
>;
export type ZCodeWorkspaceModelMessage = z.infer<typeof zcodeWorkspaceModelMessageSchema>;
export type ZCodeWorkspaceModelTool = z.infer<typeof zcodeWorkspaceModelToolSchema>;
export type ZCodeWorkspaceGenerateTextResult = z.infer<
  typeof zcodeWorkspaceGenerateTextResultSchema
>;
export const zcodeWorkspaceCancelGenerateTextParamsSchema = z
  .object({ operationId: nonEmptyString })
  .strict();
export const zcodeWorkspaceCancelGenerateTextResultSchema = z
  .object({ operationId: nonEmptyString, cancelled: z.boolean() })
  .strict();

export const zcodeProviderTestModelConnectivityParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    selection: modelSelectionSchema,
  })
  .strict();
export const zcodeProviderTestModelConnectivityResultSchema = z
  .object({ success: z.literal(true) })
  .strict();
export type ZCodeProviderTestModelConnectivityParams = z.infer<
  typeof zcodeProviderTestModelConnectivityParamsSchema
>;
export type ZCodeProviderTestModelConnectivityResult = z.infer<
  typeof zcodeProviderTestModelConnectivityResultSchema
>;

export const zcodeProviderUpdateAccountConfigParamsSchema = z
  .object({
    revision: nonEmptyString,
    basedOnZCodeBuiltinRevision: nonEmptyString,
    // @zcode/provider validates Provider Config fields; the protocol layer only constrains the transport envelope.
    providers: z.record(z.string(), z.unknown()),
    // Account state and Overlay must be passed together, or the Worker loses execution gates for plans other than the current one.
    states: z.record(
      z.string(),
      z
        .object({
          availability: z.enum(["available", "pending", "unavailable", "unknown"]),
          entitled: z.boolean(),
          unavailableReason: accountProviderUnavailableReasonSchema.optional(),
          current: z.boolean().optional(),
          connectionKey: z.string().optional(),
          effectiveAt: z.number().finite().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export const zcodeProviderUpdateAccountConfigResultSchema = z
  .object({
    // Receiving the account result does not mean its Built-in has arrived; the app version can only read the Registry snapshot.
    receivedRevision: nonEmptyString,
    providerCount: z.number().int().nonnegative(),
    status: z.enum(["received", "unchanged"]),
  })
  .strict();
export type ZCodeProviderUpdateAccountConfigResult = z.infer<
  typeof zcodeProviderUpdateAccountConfigResultSchema
>;
export const zcodeInteractionPreferencesSchema = z
  .object({
    askUserQuestionAutoResolutionEnabled: z.boolean(),
  })
  .strict();
export type ZCodeInteractionPreferences = z.infer<typeof zcodeInteractionPreferencesSchema>;

export const zcodeWorkspaceUpdateInteractionPreferencesParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    preferences: zcodeInteractionPreferencesSchema,
  })
  .strict();
export type ZCodeWorkspaceUpdateInteractionPreferencesParams = z.infer<
  typeof zcodeWorkspaceUpdateInteractionPreferencesParamsSchema
>;

export const zcodeWorkspaceUpdateInteractionPreferencesResultSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    askUserQuestionAutoResolutionEnabled: z.boolean(),
    snoozedInteractionCount: z.number().int().nonnegative(),
  })
  .strict();
export type ZCodeWorkspaceUpdateInteractionPreferencesResult = z.infer<
  typeof zcodeWorkspaceUpdateInteractionPreferencesResultSchema
>;

export const zcodeModelIoPreferencesSchema = z
  .object({
    fullRetentionEnabled: z.boolean(),
  })
  .strict();
export type ZCodeModelIoPreferences = z.infer<typeof zcodeModelIoPreferencesSchema>;

export const zcodeWorkspaceUpdateModelIoPreferencesParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    preferences: zcodeModelIoPreferencesSchema,
  })
  .strict();
export type ZCodeWorkspaceUpdateModelIoPreferencesParams = z.infer<
  typeof zcodeWorkspaceUpdateModelIoPreferencesParamsSchema
>;

export const zcodeWorkspaceUpdateModelIoPreferencesResultSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    fullRetentionEnabled: z.boolean(),
    updatedSessionCount: z.number().int().nonnegative(),
  })
  .strict();
export type ZCodeWorkspaceUpdateModelIoPreferencesResult = z.infer<
  typeof zcodeWorkspaceUpdateModelIoPreferencesResultSchema
>;

export const zcodeWorkspaceUpdateOffPeakToolPolicyParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    enabled: z.boolean(),
  })
  .strict();
export type ZCodeWorkspaceUpdateOffPeakToolPolicyParams = z.infer<
  typeof zcodeWorkspaceUpdateOffPeakToolPolicyParamsSchema
>;

export const zcodeWorkspaceUpdateOffPeakToolPolicyResultSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    enabled: z.boolean(),
  })
  .strict();
export type ZCodeWorkspaceUpdateOffPeakToolPolicyResult = z.infer<
  typeof zcodeWorkspaceUpdateOffPeakToolPolicyResultSchema
>;

// Dynamic workflow rollout gate is a workspace-level fact,
// synchronized from Host to CLI using the same pattern as Off-Peak; older CLIs return method-not-found, which Host safely ignores.
export const zcodeWorkspaceUpdateDynamicWorkflowPolicyParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    enabled: z.boolean(),
    // launch.md, "On demand: activation": mode accompanies the boolean; if absent, the CLI follows the boolean (alwaysOn).
    mode: zcodeDynamicWorkflowModeSchema.optional(),
  })
  .strict();
export type ZCodeWorkspaceUpdateDynamicWorkflowPolicyParams = z.infer<
  typeof zcodeWorkspaceUpdateDynamicWorkflowPolicyParamsSchema
>;

export const zcodeWorkspaceUpdateDynamicWorkflowPolicyResultSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    enabled: z.boolean(),
  })
  .strict();
export type ZCodeWorkspaceUpdateDynamicWorkflowPolicyResult = z.infer<
  typeof zcodeWorkspaceUpdateDynamicWorkflowPolicyResultSchema
>;

export const zcodePermissionRequestParamsSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    toolCallId: nonEmptyString,
    toolName: nonEmptyString,
    reason: z.string(),
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    input: z.unknown(),
    origin: zcodeInteractionRequestOriginSchema.optional(),
    options: z.array(zcodePermissionOptionSchema).min(1),
  })
  .strict();
export type ZCodePermissionRequestParams = z.infer<typeof zcodePermissionRequestParamsSchema>;

/** Agent asks the app to enumerate browser backends reachable from the current workspace/session with a completed handshake. */
export const zcodeBrowserListParamsSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    workspaceKey: nonEmptyString,
    workspacePath: nonEmptyString,
    workspaceIdentity: nonEmptyString.optional(),
    remoteSessionId: nonEmptyString.optional(),
    clientMode: browserClientModeSchema,
    sessionContext: browserSessionContextKindSchema,
  })
  .strict();
export type ZCodeBrowserListParams = z.infer<typeof zcodeBrowserListParamsSchema>;

export const zcodeBrowserListResultSchema = browserBackendListResultSchema;
export type ZCodeBrowserListResult = z.infer<typeof zcodeBrowserListResultSchema>;

/** Agent sends a browser-use command to the app for execution. */
export const zcodeBrowserExecuteParamsSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    browserId: nonEmptyString.optional(),
    browserGeneration: z.number().int().nonnegative().optional(),
    workspaceKey: nonEmptyString.optional(),
    workspacePath: nonEmptyString.optional(),
    workspaceIdentity: nonEmptyString.optional(),
    remoteSessionId: nonEmptyString.optional(),
    clientMode: browserClientModeSchema.optional(),
    sessionContext: browserSessionContextKindSchema.optional(),
    command: browserCommandSchema,
  })
  .strict();
export type ZCodeBrowserExecuteParams = z.infer<typeof zcodeBrowserExecuteParamsSchema>;

// Browser command results are shared app/agent protocol results. duplicate_request_id lets the boundary that actually owns
// the pending/running lifecycle reject correlation-key collisions; do not rely on upstream UUID collision probability.
export const zcodeBrowserExecuteResultSchema = browserCommandResultSchema;
export type ZCodeBrowserExecuteResult = z.infer<typeof zcodeBrowserExecuteResultSchema>;

export const zcodeUserInputOptionSchema = z
  .object({
    value: nonEmptyString,
    label: nonEmptyString,
    description: z.string().optional(),
    preview: z.string().optional(),
  })
  .strict();
export const zcodeUserInputQuestionSchema = z
  .object({
    question: nonEmptyString,
    header: nonEmptyString,
    options: z.array(zcodeUserInputOptionSchema).min(1),
    multiSelect: z.boolean().optional(),
  })
  .strict();
export type ZCodeUserInputQuestion = z.infer<typeof zcodeUserInputQuestionSchema>;

export const zcodeUserInputRequestParamsSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    toolCallId: nonEmptyString.optional(),
    toolName: nonEmptyString.optional(),
    prompt: z.string().optional(),
    questions: z.array(zcodeUserInputQuestionSchema).min(1).optional(),
    input: z.unknown().optional(),
    origin: zcodeInteractionRequestOriginSchema.optional(),
    schema: z.unknown().optional(),
  })
  .strict();
export type ZCodeUserInputRequestParams = z.infer<typeof zcodeUserInputRequestParamsSchema>;

export const zcodeUserInputResponseSchema = z
  .object({
    action: z.enum(["accept", "decline", "cancel"]),
    content: jsonObjectSchema.optional(),
    reason: z.string().optional(),
  })
  .strict();
export type ZCodeUserInputResponse = z.infer<typeof zcodeUserInputResponseSchema>;

export const zcodeProviderRuntimeHeadersRequestReasonSchema = z.enum(requestVerificationReasons);
export const zcodeProviderRuntimeHeadersRequestParamsSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    turnId: nonEmptyString.optional(),
    workspace: zcodeWorkspaceRefSchema,
    modelSelection: modelSelectionSchema,
    providerId: nonEmptyString,
    accountAccess: zcodeProviderAccountAccessSchema.optional(),
    expectedAccountScope: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    rejectedProjectTokenFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    reason: zcodeProviderRuntimeHeadersRequestReasonSchema,
  })
  .strict();
export type ZCodeProviderRuntimeHeadersRequestParams = z.infer<
  typeof zcodeProviderRuntimeHeadersRequestParamsSchema
>;

/** Cancellation applies only to this credential refresh for the same workspace/session. */
export const zcodeProviderRuntimeHeadersCancelledSchema = z
  .object({
    requestId: nonEmptyString,
    sessionId: nonEmptyString,
    workspace: zcodeWorkspaceRefSchema,
  })
  .strict();
export type ZCodeProviderRuntimeHeadersCancelled = z.infer<
  typeof zcodeProviderRuntimeHeadersCancelledSchema
>;

export const zcodeProviderRuntimeHeadersResponseSchema = z.discriminatedUnion("headersApplied", [
  z
    .object({
      headersApplied: z.literal(true),
      // Merged reconnect: success must carry the current request's auth material and cannot depend on the old Registry having been written.
      requestAuth: z
        .object({
          apiKey: nonEmptyString.optional(),
          apiKeyId: z.string().trim().min(1).optional(),
          accountScope: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          headers: z.record(nonEmptyString, nonEmptyString).optional(),
        })
        .strict(),
      errorMessage: nonEmptyString.optional(),
    })
    .strict(),
  z
    .object({
      headersApplied: z.literal(false),
      errorMessage: nonEmptyString.optional(),
    })
    .strict(),
]);
export type ZCodeProviderRuntimeHeadersResponse = z.infer<
  typeof zcodeProviderRuntimeHeadersResponseSchema
>;

// ── Official Server MCP authentication ──
// The Agent process is not authoritative for user identity: it sends (pluginId, mcpKey, targetOrigin) to Host, which
// resolves the current Coding Plan credentials and returns identity headers for this request. The request contains no secrets.
// Like interaction/requestProviderRuntimeHeaders: initiated by Agent, answered automatically by Host, with no UI.
export const zcodeOfficialMcpAuthHeadersRequestParamsSchema = z
  .object({
    requestId: nonEmptyString,
    workspace: zcodeWorkspaceRefSchema,
    pluginId: nonEmptyString,
    mcpKey: nonEmptyString,
    targetOrigin: nonEmptyString,
  })
  .strict();
export type ZCodeOfficialMcpAuthHeadersRequestParams = z.infer<
  typeof zcodeOfficialMcpAuthHeadersRequestParamsSchema
>;

/**
 * Failure reasons must be enumerable so callers do not branch on text; therefore the response has no errorMessage.
 *
 * `official_mcp_origin_untrusted` is the Host-side second-check rejection reason: `targetOrigin` does not match the current
 * ZCode API origin. The decision uses only the origin; `pluginId` / `mcpKey` are only for log attribution. Keeping this separate from
 * "not logged in/no credentials" lets diagnostics distinguish "rejected" from "no identity".
 */
export const zcodeOfficialMcpAuthFailureReasonSchema = z.enum(
  OFFICIAL_MCP_AUTH_PORT_FAILURE_REASONS,
);

export const zcodeOfficialMcpAuthHeadersResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      headers: z.record(z.string(), z.string()),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      reason: zcodeOfficialMcpAuthFailureReasonSchema,
    })
    .strict(),
]);
export type ZCodeOfficialMcpAuthHeadersResponse = z.infer<
  typeof zcodeOfficialMcpAuthHeadersResponseSchema
>;

// ── Plugin management (list + enable/disable) ──
// Mirrors PluginMetadata from @zcode/contracts, retaining only serializable fields required by the UI.
export const zcodePluginOptionValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export type ZCodePluginOptionValue = z.infer<typeof zcodePluginOptionValueSchema>;
export const zcodePluginScopeSchema = z.enum(["user", "workspace"]);
export type ZCodePluginScope = z.infer<typeof zcodePluginScopeSchema>;
export const zcodePluginHookDetailSchema = z
  .object({
    event: nonEmptyString,
    matcher: z.string().optional(),
    type: z.enum(["command", "process"]),
    command: nonEmptyString,
    args: z.array(z.string()).optional(),
    async: z.boolean().optional(),
    shell: z.union([z.literal(true), z.string()]).optional(),
    timeout: z.number().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    statusMessage: z.string().optional(),
    sourcePath: z.string(),
    runnable: z.boolean(),
  })
  .strict();
export const zcodePluginUserConfigOptionSchema = z
  .object({
    default: zcodePluginOptionValueSchema.optional(),
    description: z.string().optional(),
    required: z.boolean().optional(),
    sensitive: z.boolean().optional(),
    title: z.string().optional(),
    type: z.enum(["string", "number", "boolean", "directory", "file"]).optional(),
  })
  .strict();
export type ZCodePluginUserConfigOption = z.infer<typeof zcodePluginUserConfigOptionSchema>;

// Keep component grouping order aligned with the details dialog and marketplace details: agent / command / skill / hook / mcp.
// These three schemas must be defined before zcodePluginInfoSchema because its (.strict()) components field references them.
export const zcodePluginComponentKindSchema = z.enum(["agent", "command", "skill", "hook", "mcp"]);
export type ZCodePluginComponentKind = z.infer<typeof zcodePluginComponentKindSchema>;

export const zcodePluginComponentItemSchema = z
  .object({
    name: nonEmptyString,
    // Description comes from component frontmatter (SKILL.md / command / agent) or the manifest; omit it when missing rather than inventing one.
    description: z.string().optional(),
  })
  .strict();
export const zcodePluginComponentGroupSchema = z
  .object({
    kind: zcodePluginComponentKindSchema,
    items: z.array(zcodePluginComponentItemSchema),
  })
  .strict();
export type ZCodePluginComponentGroup = z.infer<typeof zcodePluginComponentGroupSchema>;

export const zcodePluginInfoSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    description: z.string().optional(),
    version: z.string().optional(),
    enabled: z.boolean(),
    source: nonEmptyString,
    marketplace: nonEmptyString,
    // Author/homepage fallback from the manifest (plugin.json); details use it when the store listing has no value.
    author: z.string().optional(),
    authorUrl: z.string().optional(),
    homepage: z.string().optional(),
    skillCount: z.number().int().nonnegative().optional(),
    skillRootCount: z.number().int().nonnegative(),
    commandRootCount: z.number().int().nonnegative(),
    // Authoritative component list (name + optional description), enumerated by the CLI from the plugin root regardless of enabled state.
    // Details UI renders it directly, replacing the fragile old approach of getting counts from the protocol and joining names in the UI. Optional for old payload compatibility.
    components: z.array(zcodePluginComponentGroupSchema).optional(),
    declaredMcpServerNames: z.array(z.string()).optional(),
    hostMcpServerNames: z.array(z.string()).optional(),
    mcpServerNames: z.array(z.string()),
    hookDetails: z.array(zcodePluginHookDetailSchema).optional(),
    rootPath: z.string(),
    userConfig: z.record(z.string(), zcodePluginUserConfigOptionSchema).optional(),
    configuredOptions: z.record(z.string(), zcodePluginOptionValueSchema).optional(),
    // Absent means the package is available; missing preserves a declared configuration row not yet materialized on the target Host.
    packageStatus: z.literal("missing").optional(),
    rootSource: zcodePluginScopeSchema.optional(),
    enabledSource: zcodePluginScopeSchema.optional(),
    optionSources: z.record(z.string(), zcodePluginScopeSchema).optional(),
  })
  .strict();
export type ZCodePluginInfo = z.infer<typeof zcodePluginInfoSchema>;

export const zcodePluginDiagnosticSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    severity: z.enum(["warning", "error"]).optional(),
    pluginId: z.string().optional(),
  })
  .strict();
export type ZCodePluginDiagnostic = z.infer<typeof zcodePluginDiagnosticSchema>;

export const zcodePluginsListParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    configScope: zcodePluginScopeSchema.optional(),
  })
  .strict();
export const zcodePluginsListResultSchema = z
  .object({
    plugins: z.array(zcodePluginInfoSchema),
    diagnostics: z.array(zcodePluginDiagnosticSchema),
  })
  .strict();
export type ZCodePluginsListResult = z.infer<typeof zcodePluginsListResultSchema>;

// ── Plugin UI panel entry point ──
// Workspace-level read-only projection of valid entries in enabled plugins' `ui.surfaces[]`; Host refetches after plugin enablement changes.
export const zcodePluginUiSurfaceSchema = z
  .object({
    pluginId: nonEmptyString,
    pluginName: nonEmptyString,
    id: nonEmptyString.max(128),
    title: z.union([nonEmptyString, z.record(z.string(), z.string())]),
    icon: z.string().optional(),
    // Runtime namespaced server name (`plugin:<name>:<server>`), ready to pass to mcp/uiReadResource.
    server: nonEmptyString,
    resourceUri: nonEmptyString.max(2048),
    availability: z.literal("session"),
  })
  .strict();
export type ZCodePluginUiSurface = z.infer<typeof zcodePluginUiSurfaceSchema>;
export const zcodePluginsListUiSurfacesParamsSchema = z
  .object({ workspace: zcodeWorkspaceRefSchema })
  .strict();
export type ZCodePluginsListUiSurfacesParams = z.infer<
  typeof zcodePluginsListUiSurfacesParamsSchema
>;
export const zcodePluginsListUiSurfacesResultSchema = z
  .object({ surfaces: z.array(zcodePluginUiSurfaceSchema) })
  .strict();
export type ZCodePluginsListUiSurfacesResult = z.infer<
  typeof zcodePluginsListUiSurfacesResultSchema
>;

// ── Plugin conversation-reference catalog (docs/plugin-reference-mention.md) ──
// Session-scoped read-only projection: with sessionId, return the identity catalog frozen when that Session was created;
// without it, return the current workspace catalog (for the new-draft Picker). Identity and capability fields contain identifiers only,
// with no rootPath or configuration. Optional icon/displayName(I18n)/description(I18n) fields are only for UI display and Picker search;
// they do not participate in identity, permissions, or runtime reminders.
export const zcodePluginReferenceCatalogEntrySchema = z
  .object({
    // Returned only by referenceCatalogWithCategory; the legacy entry point keeps its original shape.
    category: nonEmptyString.optional(),
    pluginId: nonEmptyString,
    name: nonEmptyString,
    marketplace: nonEmptyString,
    icon: z.string().optional(),
    // Display-only localized name projection from the store listing (following the icon precedent): lets the Picker search/show
    // localized display names; locale resolution reuses the shared plugin-display-name helper.
    displayName: z.string().optional(),
    displayNameI18n: z.record(z.string(), z.string()).optional(),
    // For Picker display only; excluded from capability identity and model-only reminders.
    description: z.string().optional(),
    descriptionI18n: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean(),
    // Non-empty means a V1 fail-closed conflict with another enabled Plugin sharing the manifest name:
    // the Picker disables selection and shows the reason; runtime resolution skips it as ambiguous.
    conflictingPluginIds: z.array(nonEmptyString),
    skillQualifiedNames: z.array(nonEmptyString),
    mcpServerNames: z.array(nonEmptyString),
    // Treat a missing field from an older Host as an empty array; only new Agents use it for the live reminder intersection.
    subagentNames: z.array(nonEmptyString).default([]),
  })
  .strict();
export type ZCodePluginReferenceCatalogEntry = z.infer<
  typeof zcodePluginReferenceCatalogEntrySchema
>;

export const zcodePluginsReferenceCatalogParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    // A Picker for an existing Session must provide sessionId to receive the session-owned catalog;
    // if the session does not exist, fail closed with a protocol error rather than silently falling back to workspace authority.
    sessionId: nonEmptyString.optional(),
  })
  .strict();
export type ZCodePluginsReferenceCatalogParams = z.infer<
  typeof zcodePluginsReferenceCatalogParamsSchema
>;
export const zcodePluginsReferenceCatalogResultSchema = z
  .object({
    authority: z.enum(["session", "workspace"]),
    plugins: z.array(zcodePluginReferenceCatalogEntrySchema),
  })
  .strict();
export type ZCodePluginsReferenceCatalogResult = z.infer<
  typeof zcodePluginsReferenceCatalogResultSchema
>;

// ── Skill conversation-reference catalog ──
// New drafts read the current workspace directory; existing Sessions read discovery results frozen when AgentRuntime first
// initialized context. This protocol carries only the Composer's read-only reference projection; it does not replace the Settings
// Skill management API or persist a runtime snapshot.
export const zcodeSkillReferenceCatalogEntrySchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    description: z.string(),
    path: nonEmptyString,
    scope: z.enum(["workspace", "user", "plugin"]),
    enabled: z.literal(true),
    pluginName: nonEmptyString.optional(),
  })
  .strict();
export type ZCodeSkillReferenceCatalogEntry = z.infer<typeof zcodeSkillReferenceCatalogEntrySchema>;

export const zcodeSkillsReferenceCatalogParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    // With sessionId, the resident Session in that process must be found; an unknown Session fails closed,
    // preventing fallback to the current workspace directory and leaking new Skills into an old conversation.
    sessionId: nonEmptyString.optional(),
  })
  .strict();
export type ZCodeSkillsReferenceCatalogParams = z.infer<
  typeof zcodeSkillsReferenceCatalogParamsSchema
>;
export const zcodeSkillsReferenceCatalogResultSchema = z
  .object({
    authority: z.enum(["session", "workspace"]),
    skills: z.array(zcodeSkillReferenceCatalogEntrySchema),
  })
  .strict();
export type ZCodeSkillsReferenceCatalogResult = z.infer<
  typeof zcodeSkillsReferenceCatalogResultSchema
>;

// ── Saved workflow GUI hub ──
// Five workspace-level, sessionless methods, following skills/referenceCatalog: each call scans
// `<cwd>/.zcode/workflows/` (a mount-time snapshot would miss manually edited files). The shapes match
// saved-workflow.ts in @zcode/contracts exactly. Since dependencies flow contracts → shared, redeclare them structurally here
// instead of importing; bootstrap protocol tests keep both strict shapes aligned.
export const zcodeSavedWorkflowArgTypeSchema = z.enum(["string", "number", "boolean", "json"]);
export type ZCodeSavedWorkflowArgType = z.infer<typeof zcodeSavedWorkflowArgTypeSchema>;
export const zcodeSavedWorkflowArgDeclarationSchema = z
  .object({
    type: zcodeSavedWorkflowArgTypeSchema,
    description: z.string().optional(),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
  })
  .strict();
export type ZCodeSavedWorkflowArgDeclaration = z.infer<
  typeof zcodeSavedWorkflowArgDeclarationSchema
>;
export const zcodeSavedWorkflowArgsDeclarationSchema = z.record(
  z.string(),
  zcodeSavedWorkflowArgDeclarationSchema,
);
export type ZCodeSavedWorkflowArgsDeclaration = z.infer<
  typeof zcodeSavedWorkflowArgsDeclarationSchema
>;
export const zcodeSavedWorkflowMetaSchema = z
  .object({
    description: nonEmptyString,
    whenToUse: nonEmptyString.optional(),
    args: zcodeSavedWorkflowArgsDeclarationSchema.optional(),
  })
  .strict();
export type ZCodeSavedWorkflowMeta = z.infer<typeof zcodeSavedWorkflowMetaSchema>;
// Two scopes: project files go to `<cwd>/.zcode/workflows/`, global files to `~/.zcode/workflows/` on the agent machine. Scope is inferred from the file's directory; frontmatter does not store it.
export const zcodeSavedWorkflowScopeSchema = z.enum(["project", "global"]);
export type ZCodeSavedWorkflowScope = z.infer<typeof zcodeSavedWorkflowScopeSchema>;
export const zcodeSavedWorkflowEntrySchema = z
  .object({
    name: nonEmptyString,
    description: z.string(),
    whenToUse: z.string().optional(),
    args: zcodeSavedWorkflowArgsDeclarationSchema.optional(),
    scope: zcodeSavedWorkflowScopeSchema,
    path: nonEmptyString,
  })
  .strict();
export type ZCodeSavedWorkflowEntry = z.infer<typeof zcodeSavedWorkflowEntrySchema>;
export const zcodeSavedWorkflowInvalidEntrySchema = z
  .object({ path: nonEmptyString, reason: nonEmptyString })
  .strict();
export type ZCodeSavedWorkflowInvalidEntry = z.infer<typeof zcodeSavedWorkflowInvalidEntrySchema>;
/** Invalid name / not found / invalid frontmatter / read error — matches the core store's four resolve failure states exactly. */
export const zcodeSavedWorkflowFailureReasonSchema = z.enum([
  "invalid_name",
  "not_found",
  "parse_error",
  "read_error",
]);
export type ZCodeSavedWorkflowFailureReason = z.infer<typeof zcodeSavedWorkflowFailureReasonSchema>;
const zcodeSavedWorkflowFailureSchema = z
  .object({
    ok: z.literal(false),
    reason: zcodeSavedWorkflowFailureReasonSchema,
    detail: z.string().optional(),
  })
  .strict();

export const zcodeWorkflowsListParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    // Defaults to `project` (this project's scope). `global` scans `~/.zcode/workflows/` on this machine; `workspace`
    // remains required but is only the **carrier runtime** — the protocol handler does not read its path for global scope.
    scope: zcodeSavedWorkflowScopeSchema.optional(),
  })
  .strict();
export type ZCodeWorkflowsListParams = z.infer<typeof zcodeWorkflowsListParamsSchema>;
export const zcodeWorkflowsListResultSchema = z
  .object({
    workflows: z.array(zcodeSavedWorkflowEntrySchema),
    invalid: z.array(zcodeSavedWorkflowInvalidEntrySchema),
    // Scanned directories (local absolute paths) are returned even if they do not exist yet; the GUI file watcher needs them.
    dir: nonEmptyString,
  })
  .strict();
export type ZCodeWorkflowsListResult = z.infer<typeof zcodeWorkflowsListResultSchema>;

export const zcodeWorkflowsGetParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    name: nonEmptyString,
    // Defaults to `project`; `global` searches only the local global root. `workspace` has the same meaning as list (carrier only for global scope).
    scope: zcodeSavedWorkflowScopeSchema.optional(),
  })
  .strict();
export type ZCodeWorkflowsGetParams = z.infer<typeof zcodeWorkflowsGetParamsSchema>;
export const zcodeWorkflowsGetResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      name: nonEmptyString,
      path: nonEmptyString,
      scope: zcodeSavedWorkflowScopeSchema,
      meta: zcodeSavedWorkflowMetaSchema,
      /** Script body (byte-for-byte after frontmatter), which is the content type-checked and executed. */
      script: z.string(),
    })
    .strict(),
  zcodeSavedWorkflowFailureSchema,
]);
export type ZCodeWorkflowsGetResult = z.infer<typeof zcodeWorkflowsGetResultSchema>;

export const zcodeWorkflowsUpdateMetaParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    name: nonEmptyString,
    meta: zcodeSavedWorkflowMetaSchema,
    // Defaults to `project`; `global` writes only to the local global root. `workspace` has the same meaning as list.
    scope: zcodeSavedWorkflowScopeSchema.optional(),
  })
  .strict();
export type ZCodeWorkflowsUpdateMetaParams = z.infer<typeof zcodeWorkflowsUpdateMetaParamsSchema>;
export const zcodeWorkflowsUpdateMetaResultSchema = z.union([
  z.object({ ok: z.literal(true), path: nonEmptyString }).strict(),
  zcodeSavedWorkflowFailureSchema,
]);
export type ZCodeWorkflowsUpdateMetaResult = z.infer<typeof zcodeWorkflowsUpdateMetaResultSchema>;

export const zcodeWorkflowsDeleteParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    name: nonEmptyString,
    // Defaults to `project`; `global` deletes from the root selected by scope (no longer hard-coded to roots[0]). `workspace` has the same meaning as list.
    scope: zcodeSavedWorkflowScopeSchema.optional(),
  })
  .strict();
export type ZCodeWorkflowsDeleteParams = z.infer<typeof zcodeWorkflowsDeleteParamsSchema>;
export const zcodeWorkflowsDeleteResultSchema = z.union([
  z.object({ ok: z.literal(true), path: nonEmptyString }).strict(),
  zcodeSavedWorkflowFailureSchema,
]);
export type ZCodeWorkflowsDeleteResult = z.infer<typeof zcodeWorkflowsDeleteResultSchema>;

export const ZCODE_WORKFLOWS_RUNS_MAX_LIMIT = 50;
export const zcodeWorkflowsRunsParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    /** Runs with exactly this name (`dwf_run.name` literal equality); defaults to all runs in this project. */
    name: nonEmptyString.optional(),
    limit: z.number().int().min(1).max(ZCODE_WORKFLOWS_RUNS_MAX_LIMIT),
    // Defaults to `project`: only query runs where `dwf_run.cwd === workspacePath`. For `global`, do **not** filter by cwd;
    // fetch that workflow's history across all projects (global workflows can run in any project, so history spans cwd). Result rows include `cwd`
    // so the GUI can label the project. `workspace` has the same meaning as list (carrier only for global scope).
    scope: zcodeSavedWorkflowScopeSchema.optional(),
  })
  .strict();
export type ZCodeWorkflowsRunsParams = z.infer<typeof zcodeWorkflowsRunsParamsSchema>;
// Three terminal states: errored means a script error; stopped means interrupted (resumable).
export const zcodeSavedWorkflowRunStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "errored",
  "stopped",
]);
export type ZCodeSavedWorkflowRunStatus = z.infer<typeof zcodeSavedWorkflowRunStatusSchema>;
export const zcodeSavedWorkflowRunStopReasonSchema = z.enum([
  "user",
  "model",
  "provider",
  "interrupted",
  "superseded",
]);
export const zcodeSavedWorkflowRunSchema = z
  .object({
    runId: nonEmptyString,
    name: z.string().optional(),
    status: zcodeSavedWorkflowRunStatusSchema,
    // Present only when `status === "stopped"`.
    stopReason: zcodeSavedWorkflowRunStopReasonSchema.optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    spentTokens: z.number(),
    /** The session and CreateWorkflow tool call that started it; both are needed to open instance details from the hub. Older rows may omit them. */
    parentSessionId: z.string().optional(),
    toolCallId: z.string().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    // Actual project directory (`dwf_run.cwd`). Global `workflows/runs` queries span cwd, so the GUI uses this to label
    // each row; for project scope it always equals workspacePath and the GUI can ignore it. Older rows may omit it.
    cwd: z.string().optional(),
    // **User-facing artifacts** published by this run: the hub's run-history row renders kind chips after the status,
    // and the details header's “Recent artifacts” strip uses this value from the latest completed run.
    // Terminology: an artifact here is output the script publishes for users through `artifact.*`, not the script's top-level return value.
    // Include only fields needed to render chips (≤ 8 items, latest metadata); bytes and entries are fetched on demand via v4 queries.
    // Optional, following the `cwd` precedent above: older CLIs omit it, which is a degraded response rather than an error.
    artifacts: z
      .array(
        z
          .object({
            id: nonEmptyString,
            kind: z.enum(["file", "markdown", "chart", "table", "metrics", "board"]),
            title: z.string().optional(),
            version: z.number(),
            contentType: z.string().optional(),
          })
          .strict(),
      )
      .max(8)
      .optional(),
  })
  .strict();
export type ZCodeSavedWorkflowRun = z.infer<typeof zcodeSavedWorkflowRunSchema>;
export const zcodeWorkflowsRunsResultSchema = z
  .object({
    runs: z.array(zcodeSavedWorkflowRunSchema),
    /** Present and true only when more runs remain beyond this page (determined by fetching one extra row, not `length === limit`). */
    truncated: z.literal(true).optional(),
  })
  .strict();
export type ZCodeWorkflowsRunsResult = z.infer<typeof zcodeWorkflowsRunsResultSchema>;

// workflows/move: move a same-named file from this machine's global root to the `workspace` project root. **One direction only**: project → global is a model-level
// summary (“promote to global” means starting a new session in that project and saving another copy through SaveWorkflow), so there is no `to` parameter. Same machine and user; prefer rename, falling back to copy+unlink on EXDEV.
// Move byte-for-byte without modifying content (frontmatter does not store scope). `move` never overwrites — reject if the target exists
// (overwriting is an explicit SaveWorkflow action behind a confirmation dialog, invariant 7). `workspace` is both the carrier runtime and target project.
export const zcodeWorkflowsMoveParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    name: nonEmptyString,
  })
  .strict();
export type ZCodeWorkflowsMoveParams = z.infer<typeof zcodeWorkflowsMoveParamsSchema>;
export const zcodeWorkflowsMoveResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      /** Source path (global root, before the move). */
      from: nonEmptyString,
      /** Target path (project root, destination). */
      to: nonEmptyString,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      // target_exists: a same-named target already exists (move does not overwrite); not_found: no source with this name;
      // read_error / write_error: I/O failure during move; invalid_name: the name failed validation.
      reason: z.enum(["invalid_name", "not_found", "target_exists", "read_error", "write_error"]),
      path: z.string().optional(),
      detail: z.string().optional(),
    })
    .strict(),
]);
export type ZCodeWorkflowsMoveResult = z.infer<typeof zcodeWorkflowsMoveResultSchema>;

// ── Save a workflow from a run (docs/dynamic-workflow/transcript-and-notifications.md, "Saving the
// run, and running it again") ──
// The completion card's "Save directly" action uses this path: **accept runId only, not script text**.
// The body to write is the script this run actually executed, read by the agent from the journal's `scriptText`.
// Keeping the script out of the GUI has two useful effects: revised runs save the version that settled them,
// and older conversations whose tool-row arguments were snapshot-truncated to a preview can still save the same bytes.
// Name validation, overwrite, shadowing, and type checking all reuse SaveWorkflow's implementation (invariant 3).
/** A same-named definition in another scope (shadowing); matches contracts' SavedWorkflowShadowing exactly. */
export const zcodeSavedWorkflowShadowingSchema = z.enum(["hides_global", "hidden_by_project"]);
export type ZCodeSavedWorkflowShadowing = z.infer<typeof zcodeSavedWorkflowShadowingSchema>;

export const zcodeWorkflowsSaveParamsSchema = z
  .object({
    // Dual purpose: this is both the carrier runtime and the project for this run; its journal and project root are both there.
    // Global scope also includes it (unlike list/get, where global scope is only the carrier) because the script must read this agent's journal.
    workspace: zcodeWorkspaceRefSchema,
    runId: nonEmptyString,
    name: nonEmptyString,
    meta: zcodeSavedWorkflowMetaSchema,
    // Defaults to `project`.
    scope: zcodeSavedWorkflowScopeSchema.optional(),
    // True only after the GUI has shown the overwrite warning; by default, reject if the target exists.
    // Overwrite is the user's decision, not a side effect of saving (the same rule as no-overwrite `workflows/move`).
    overwrite: z.boolean().optional(),
  })
  .strict();
export type ZCodeWorkflowsSaveParams = z.infer<typeof zcodeWorkflowsSaveParamsSchema>;
export const zcodeWorkflowsSaveResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      name: nonEmptyString,
      scope: zcodeSavedWorkflowScopeSchema,
      path: nonEmptyString,
      /** Re-evaluated at write time; do not copy the input's `overwrite` value (same source as SaveWorkflow's `overwritten`). */
      overwritten: z.boolean(),
      shadowing: zcodeSavedWorkflowShadowingSchema.optional(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      // run_not_found: the journal has no such run; script_missing: an old record has no original script text;
      // target_exists: the target exists and the caller did not request overwrite; compile_failed: type checking failed, so no bytes were written.
      reason: z.enum([
        "invalid_name",
        "run_not_found",
        "script_missing",
        "target_exists",
        "compile_failed",
        "write_error",
      ]),
      path: z.string().optional(),
      detail: z.string().optional(),
    })
    .strict(),
]);
export type ZCodeWorkflowsSaveResult = z.infer<typeof zcodeWorkflowsSaveResultSchema>;

// ── Which saved workflow corresponds to a run ──
// The completion card's "Saved" chip and "Run again" action ask this same question, and the answer is
// **derived rather than stored on the card**. Reopening a session, saving from another window, and saving
// in the conversation all use the same check. It lives on the agent because both facts (the run's journal
// record and the definition on disk) are there. Returning the resolved entry means a definition deleted
// later by the user automatically stops counting.
/** Candidate transcribed from the conversation: the model saved it with `SaveWorkflow` and claimed this run in the input. */
export const zcodeWorkflowsForRunCandidateSchema = z
  .object({ name: nonEmptyString, scope: zcodeSavedWorkflowScopeSchema.optional() })
  .strict();
export type ZCodeWorkflowsForRunCandidate = z.infer<typeof zcodeWorkflowsForRunCandidateSchema>;
/** Candidate limit; a run is saved far fewer times than this within a conversation. */
export const ZCODE_WORKFLOWS_FOR_RUN_MAX_CANDIDATES = 8;
export const zcodeWorkflowsForRunParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    runId: nonEmptyString,
    candidates: z
      .array(zcodeWorkflowsForRunCandidateSchema)
      .max(ZCODE_WORKFLOWS_FOR_RUN_MAX_CANDIDATES)
      .optional(),
  })
  .strict();
export type ZCodeWorkflowsForRunParams = z.infer<typeof zcodeWorkflowsForRunParamsSchema>;
export const zcodeWorkflowsForRunResultSchema = z
  .object({
    /** Matching definition; absent means this run has no corresponding saved workflow yet. */
    entry: zcodeSavedWorkflowEntrySchema.optional(),
    /** Which rule matched (for diagnostics and tests; the UI only checks whether entry exists). */
    match: z.enum(["candidate", "script", "name"]).optional(),
    /** Arguments used by this run (as recorded in the journal), to prefill the arguments dialog for "Run again." */
    runArgs: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ZCodeWorkflowsForRunResult = z.infer<typeof zcodeWorkflowsForRunResultSchema>;

// Trusted plugin resolution for recommended prompts: the UI does not parse stableId or infer installability from an old directory snapshot.
export const zcodePluginSuggestedReferenceStatusSchema = z.enum([
  "ready",
  "disabled",
  "missing",
  "conflict",
  "unavailable",
]);
export type ZCodePluginSuggestedReferenceStatus = z.infer<
  typeof zcodePluginSuggestedReferenceStatusSchema
>;
export const zcodePluginOperationStateSchema = z.enum([
  "checking",
  "refreshing",
  "installing",
  "enabling",
  "cancelling",
  "cancelled",
  "complete",
  "failed",
]);
export type ZCodePluginOperationState = z.infer<typeof zcodePluginOperationStateSchema>;
export const zcodePluginOperationProgressNotificationSchema = z
  .object({
    operationId: nonEmptyString,
    state: z.literal("refreshing"),
  })
  .strict();
export type ZCodePluginOperationProgressNotification = z.infer<
  typeof zcodePluginOperationProgressNotificationSchema
>;
export const zcodePluginsResolveSuggestedReferenceParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    stableId: nonEmptyString,
    operationId: nonEmptyString,
    clientMode: zcodeDeliveryKindSchema,
    deliveryKind: zcodeDeliveryKindSchema,
  })
  .strict();
export type ZCodePluginsResolveSuggestedReferenceParams = z.infer<
  typeof zcodePluginsResolveSuggestedReferenceParamsSchema
>;
export const zcodePluginsSetEnabledParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginId: nonEmptyString,
    enabled: z.boolean(),
    operationId: nonEmptyString.optional(),
    scope: zcodePluginScopeSchema.optional(),
  })
  .strict();
export const zcodePluginsSetEnabledResultSchema = z
  .object({
    plugin: zcodePluginInfoSchema,
    enabled: z.boolean(),
  })
  .strict();
export type ZCodePluginsSetEnabledResult = z.infer<typeof zcodePluginsSetEnabledResultSchema>;

// Store listing: display metadata carried by catalog entries (display name/icon/category/author/links/hero/
// example prompts), all optional. The UI applies its fallback matrix when fields are missing (letter avatar/hidden section/omitted info row).
// i18n uses `<field>I18n` maps, and locale resolution reuses the shared plugin-display-name helper.
export const zcodePluginStoreListingSchema = z
  .object({
    displayName: z.string().optional(),
    displayNameI18n: z.record(z.string(), z.string()).optional(),
    descriptionI18n: z.record(z.string(), z.string()).optional(),
    icon: z.string().optional(),
    category: z.string().optional(),
    author: z.string().optional(),
    authorUrl: z.string().optional(),
    homepage: z.string().optional(),
    privacyPolicy: z.string().optional(),
    termsOfService: z.string().optional(),
    heroImage: z.string().optional(),
    examplePrompts: z.array(z.string()).optional(),
    examplePromptsI18n: z.record(z.string(), z.array(z.string())).optional(),
    /**
     * Plugins that work best with a paid plan: the marketplace catalog entry declares `requiresPaidPlan: true`,
     * and the UI shows an indicator beside the title. This describes a usage prerequisite, not a paid product;
     * it does not affect install gating or billing, and the name is not tied to a specific plan product.
     */
    requiresPaidPlan: z.boolean().optional(),
  })
  .strict();
export type ZCodePluginStoreListing = z.infer<typeof zcodePluginStoreListingSchema>;

export const zcodePluginsResolveSuggestedReferenceResultSchema = z
  .object({
    stableId: nonEmptyString,
    status: zcodePluginSuggestedReferenceStatusSchema,
    marketplace: nonEmptyString.optional(),
    pluginName: nonEmptyString.optional(),
    sourceTrust: z.literal("official").optional(),
    // Optional display projection from the official Marketplace listing; not used for identity, installation, or permission decisions.
    icon: z.string().optional(),
    listing: zcodePluginStoreListingSchema.optional(),
    diagnostics: z.array(zcodePluginDiagnosticSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status !== "ready" && value.status !== "disabled" && value.status !== "missing") {
      return;
    }
    if (!value.marketplace || !value.pluginName || value.sourceTrust !== "official") {
      context.addIssue({
        code: "custom",
        message: "actionable suggested Plugin results require trusted install identity",
      });
    }
  });
export type ZCodePluginsResolveSuggestedReferenceResult = z.infer<
  typeof zcodePluginsResolveSuggestedReferenceResultSchema
>;

export const zcodePluginMarketplaceSummarySchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    source: jsonObjectSchema,
    description: z.string().optional(),
    lastUpdated: z.string().optional(),
    pluginCount: z.number().int().nonnegative(),
    isOfficial: z.boolean().optional(),
    // Top-level curated featured list from the catalog (Featured section in the store's “Public” segment).
    featured: z.array(z.string()).optional(),
    refreshFailure: z
      .object({
        code: z.string(),
        failedAt: z.string(),
        message: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ZCodePluginMarketplaceSummary = z.infer<typeof zcodePluginMarketplaceSummarySchema>;

export const zcodeAvailablePluginSummarySchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    marketplace: nonEmptyString,
    description: z.string().optional(),
    version: z.string().optional(),
    installed: z.boolean(),
    componentTypes: z.array(z.string()).optional(),
    listing: zcodePluginStoreListingSchema.optional(),
  })
  .strict();
export type ZCodeAvailablePluginSummary = z.infer<typeof zcodeAvailablePluginSummarySchema>;

export const zcodeInstalledPluginSummarySchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    marketplace: nonEmptyString,
    description: z.string().optional(),
    version: z.string().optional(),
    enabled: z.boolean(),
    scope: zcodePluginScopeSchema,
    installPath: z.string().optional(),
    installedAt: z.string().optional(),
    componentTypes: z.array(z.string()).optional(),
    hookDetails: z.array(zcodePluginHookDetailSchema).optional(),
    updateStatus: z.enum(["none", "update-available", "version-changed"]).optional(),
    latestVersion: z.string().optional(),
    listing: zcodePluginStoreListingSchema.optional(),
  })
  .strict();
export type ZCodeInstalledPluginSummary = z.infer<typeof zcodeInstalledPluginSummarySchema>;

export const zcodePluginsOverviewParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    configScope: zcodePluginScopeSchema.optional(),
  })
  .strict();
export const zcodePluginsOverviewResultSchema = z
  .object({
    marketplaces: z.array(zcodePluginMarketplaceSummarySchema),
    availablePlugins: z.array(zcodeAvailablePluginSummarySchema),
    installedPlugins: z.array(zcodeInstalledPluginSummarySchema),
    restorableBuiltins: z.array(zcodeAvailablePluginSummarySchema),
    diagnostics: z.array(zcodePluginDiagnosticSchema),
    capability: z
      .object({
        supported: z.boolean(),
        reason: z.string().optional(),
      })
      .strict(),
  })
  .strict();
export type ZCodePluginsOverviewResult = z.infer<typeof zcodePluginsOverviewResultSchema>;

export const zcodePluginsMarketplaceAddParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    source: nonEmptyString,
    dryRun: z.boolean().optional(),
    operationId: nonEmptyString.optional(),
  })
  .strict();
export const zcodePluginsMarketplaceRemoveParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    marketplace: nonEmptyString,
  })
  .strict();
export const zcodePluginsMarketplaceUpdateParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    marketplace: nonEmptyString.optional(),
    operationId: nonEmptyString.optional(),
  })
  .strict();
export const zcodePluginsMarketplaceMutationResultSchema = z
  .object({
    marketplace: zcodePluginMarketplaceSummarySchema.optional(),
    marketplaces: z.array(zcodePluginMarketplaceSummarySchema).optional(),
    diagnostics: z.array(zcodePluginDiagnosticSchema).optional(),
  })
  .strict();
export type ZCodePluginsMarketplaceMutationResult = z.infer<
  typeof zcodePluginsMarketplaceMutationResultSchema
>;

export const zcodePluginsInstallParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginName: nonEmptyString,
    marketplace: nonEmptyString,
    scope: zcodePluginScopeSchema.optional(),
    dryRun: z.boolean().optional(),
    operationId: nonEmptyString.optional(),
  })
  .strict();
export const zcodePluginsCancelOperationParamsSchema = z
  .object({
    operationId: nonEmptyString,
  })
  .strict();
export type ZCodePluginsCancelOperationParams = z.infer<
  typeof zcodePluginsCancelOperationParamsSchema
>;

export const zcodePluginsCancelOperationResultSchema = z
  .object({
    operationId: nonEmptyString,
    cancelled: z.boolean(),
  })
  .strict();
export type ZCodePluginsCancelOperationResult = z.infer<
  typeof zcodePluginsCancelOperationResultSchema
>;
export const zcodePluginsUninstallParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginId: nonEmptyString.optional(),
    pluginName: nonEmptyString.optional(),
    marketplace: nonEmptyString.optional(),
    removeCache: z.boolean().optional(),
  })
  .strict();
export const zcodePluginsInstallResultSchema = z
  .object({
    installedPlugins: z.array(zcodeInstalledPluginSummarySchema),
    dependencyClosure: z.array(z.string()),
    diagnostics: z.array(zcodePluginDiagnosticSchema),
  })
  .strict();
export type ZCodePluginsInstallResult = z.infer<typeof zcodePluginsInstallResultSchema>;

export const zcodePluginsUninstallResultSchema = z
  .object({
    removedPlugin: zcodeInstalledPluginSummarySchema.optional(),
    diagnostics: z.array(zcodePluginDiagnosticSchema),
  })
  .strict();
export type ZCodePluginsUninstallResult = z.infer<typeof zcodePluginsUninstallResultSchema>;

export const zcodePluginsUpdateParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginId: nonEmptyString.optional(),
    marketplace: nonEmptyString.optional(),
  })
  .strict();
export const zcodePluginsRestoreBuiltinParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginId: nonEmptyString,
  })
  .strict();
export const zcodePluginsRestoreBuiltinResultSchema = z
  .object({
    pluginId: nonEmptyString,
    diagnostics: z.array(zcodePluginDiagnosticSchema),
  })
  .strict();
export type ZCodePluginsRestoreBuiltinResult = z.infer<
  typeof zcodePluginsRestoreBuiltinResultSchema
>;

export const zcodePluginsConfigureParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginId: nonEmptyString,
    options: jsonObjectSchema,
    clearOptionKeys: z.array(nonEmptyString).optional(),
    scope: zcodePluginScopeSchema.optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();
export const zcodePluginsConfigureResultSchema = z
  .object({
    pluginId: nonEmptyString,
    diagnostics: z.array(zcodePluginDiagnosticSchema),
  })
  .strict();
export type ZCodePluginsConfigureResult = z.infer<typeof zcodePluginsConfigureResultSchema>;

export const zcodePluginsResetConfigParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginId: nonEmptyString,
    scope: zcodePluginScopeSchema.optional(),
  })
  .strict();
export type ZCodePluginsResetConfigParams = z.infer<typeof zcodePluginsResetConfigParamsSchema>;

export const zcodePluginsValidateParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginName: nonEmptyString.optional(),
    marketplace: nonEmptyString.optional(),
    source: nonEmptyString.optional(),
  })
  .strict();
export const zcodePluginsValidateResultSchema = z
  .object({
    ok: z.boolean(),
    diagnostics: z.array(zcodePluginDiagnosticSchema),
    compatibility: z
      .object({
        runnable: z.array(z.string()),
        diagnosticOnly: z.array(z.string()),
        unsupported: z.array(z.string()),
      })
      .strict(),
  })
  .strict();
export type ZCodePluginsValidateResult = z.infer<typeof zcodePluginsValidateResultSchema>;

// plugins/describe: enumerate one plugin's component names and descriptions on demand.
// Installed plugins use the local cache directory; uninstalled candidates resolve or temporarily clone the source, enumerate, then clean up.
export const zcodePluginsDescribeParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginName: nonEmptyString,
    marketplace: nonEmptyString,
  })
  .strict();
export const zcodePluginsDescribeResultSchema = z
  .object({
    components: z.array(zcodePluginComponentGroupSchema),
    diagnostics: z.array(zcodePluginDiagnosticSchema).optional(),
    // Display fallback fields from plugin.json inside the package; used in details for uninstalled candidates when the store listing lacks them.
    metadata: z
      .object({
        author: z.string().optional(),
        authorUrl: z.string().optional(),
        homepage: z.string().optional(),
        version: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ZCodePluginsDescribeResult = z.infer<typeof zcodePluginsDescribeResultSchema>;

export const zcodeAutomationScheduleRuleSchema = z
  .object({
    unit: z.enum(["minute", "hourly", "daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().positive(),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    anchorAt: z.number().int(),
    weekdays: z.array(z.number().int().min(0).max(6)).optional(),
    monthDays: z.array(z.number().int().min(1).max(31)).optional(),
    /** Used for yearly schedules: human month 1–12. Defaults to the month in anchorAt (for older records without this field). */
    months: z.array(z.number().int().min(1).max(12)).optional(),
    monthlyMode: z.enum(["date", "weekday"]).optional(),
  })
  .strict();
export type ZCodeAutomationScheduleRuleProtocol = z.infer<typeof zcodeAutomationScheduleRuleSchema>;

/** Unit enum for the session-side long-interval schedule carrier (same set as scheduleRule.unit). */
export const zcodeAutomationIntervalUnitSchema = z.enum([
  "minute",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
]);

export const zcodeAutomationProtocolSchema = z
  .object({
    automationId: nonEmptyString,
    title: z.string(),
    cronExpr: nonEmptyString,
    prompt: nonEmptyString,
    modelSelection: modelSelectionSchema.optional(),
    mode: zcodeTaskModeSchema.optional(),
    targetTaskId: nonEmptyString.optional(),
    enabled: z.boolean(),
    lifecycleStatus: z.enum(["active", "completed", "failed", "paused"]),
    nextRunAt: timestampMsSchema.optional(),
    lastRunAt: timestampMsSchema.optional(),
    runCount: z.number().int().nonnegative(),
    recurring: z.boolean(),
    maxRuns: z.number().int().positive().optional(),
    // Custom recurrence rule; when absent, scheduling falls back to parsing cronExpr. Session cards need this field to show
    // real intervals cron cannot express (such as every 50 hours or every 40 days; cronExpr remains a compatible `0 * * * *`).
    scheduleRule: zcodeAutomationScheduleRuleSchema.optional(),
  })
  .strict();
export type ZCodeAutomationProtocol = z.infer<typeof zcodeAutomationProtocolSchema>;

export const zcodeAutomationCreateParamsSchema = z
  .object({
    title: z.string().optional(),
    cronExpr: nonEmptyString,
    relativeDelayMinutes: z.number().int().positive().max(525_600).optional(),
    prompt: nonEmptyString,
    modelSelection: modelSelectionSchema.optional(),
    mode: zcodeTaskModeSchema.optional(),
    targetTaskId: nonEmptyString.optional(),
    botDeliveryTarget: zcodeAutomationBotDeliveryTargetSchema.optional(),
    recurring: z.boolean().optional(),
    maxRuns: z.number().int().positive().optional(),
    // Session-side custom recurrence carrier: every N minutes/hours/days/weeks/months/years is normalized through this field into the authoritative scheduleRule;
    // cronExpr is retained only as a valid compatibility display.
    intervalUnit: zcodeAutomationIntervalUnitSchema.optional(),
    interval: z.number().int().min(1).max(200).optional(),
  })
  .strict()
  // intervalUnit and interval must be submitted together (either alone cannot determine the real interval).
  .refine((input) => (input.intervalUnit === undefined) === (input.interval === undefined), {
    message: "intervalUnit and interval must be set together",
    path: ["interval"],
  })
  // The recurrence carrier conflicts with one-time relative-delay semantics; do not submit both.
  .refine((input) => input.intervalUnit === undefined || input.relativeDelayMinutes === undefined, {
    message: "intervalUnit cannot combine with a relative delayMinutes",
    path: ["intervalUnit"],
  })
  .refine((input) => input.intervalUnit === undefined || input.recurring !== false, {
    message: "intervalUnit is a recurring carrier and cannot combine with recurring=false",
    path: ["recurring"],
  })
  .refine((input) => input.intervalUnit === undefined || input.maxRuns === undefined, {
    message: "intervalUnit is a recurring carrier and cannot combine with maxRuns",
    path: ["maxRuns"],
  });
export type ZCodeAutomationCreateProtocolParams = z.infer<typeof zcodeAutomationCreateParamsSchema>;

export const zcodeAutomationCreateResultSchema = z
  .object({ automation: zcodeAutomationProtocolSchema })
  .strict();
export type ZCodeAutomationCreateProtocolResult = z.infer<typeof zcodeAutomationCreateResultSchema>;

export const zcodeAutomationUpdateParamsSchema = z
  .object({
    automationId: nonEmptyString,
    title: nonEmptyString.optional(),
    cronExpr: nonEmptyString.optional(),
    prompt: nonEmptyString.optional(),
    recurring: z.boolean().optional(),
    maxRuns: z.number().int().positive().nullable().optional(),
    // Session-side custom recurrence carrier (same semantics as create).
    intervalUnit: zcodeAutomationIntervalUnitSchema.optional(),
    interval: z.number().int().min(1).max(200).optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.title !== undefined ||
      input.cronExpr !== undefined ||
      input.prompt !== undefined ||
      input.recurring !== undefined ||
      input.maxRuns !== undefined ||
      input.intervalUnit !== undefined,
    { message: "automation update requires at least one field" },
  )
  .refine((input) => input.maxRuns !== null || input.recurring === true, {
    message: "clearing maxRuns requires recurring=true",
    path: ["maxRuns"],
  })
  .refine((input) => input.recurring !== true || typeof input.maxRuns !== "number", {
    message: "recurring=true cannot be combined with a numeric maxRuns",
    path: ["maxRuns"],
  })
  // intervalUnit and interval must be submitted together (same semantics as create).
  .refine((input) => (input.intervalUnit === undefined) === (input.interval === undefined), {
    message: "intervalUnit and interval must be set together",
    path: ["interval"],
  })
  .refine((input) => input.intervalUnit === undefined || input.recurring !== false, {
    message: "intervalUnit is a recurring carrier and cannot combine with recurring=false",
    path: ["recurring"],
  })
  .refine(
    (input) =>
      input.intervalUnit === undefined ||
      input.maxRuns === undefined ||
      (input.maxRuns === null && input.recurring === true),
    {
      message:
        "intervalUnit is a recurring carrier and only allows maxRuns=null with recurring=true",
      path: ["maxRuns"],
    },
  );
export type ZCodeAutomationUpdateProtocolParams = z.infer<typeof zcodeAutomationUpdateParamsSchema>;
export const zcodeAutomationUpdateResultSchema = z
  .object({ automation: zcodeAutomationProtocolSchema })
  .strict();
export type ZCodeAutomationUpdateProtocolResult = z.infer<typeof zcodeAutomationUpdateResultSchema>;

export const zcodeAutomationListParamsSchema = z.object({}).strict();
export type ZCodeAutomationListProtocolParams = z.infer<typeof zcodeAutomationListParamsSchema>;
export const zcodeAutomationListResultSchema = z
  .object({ automations: z.array(zcodeAutomationProtocolSchema) })
  .strict();
export type ZCodeAutomationListProtocolResult = z.infer<typeof zcodeAutomationListResultSchema>;

export const zcodeAutomationCheckTaskBindingParamsSchema = z
  .object({ targetTaskId: nonEmptyString })
  .strict();
export type ZCodeAutomationCheckTaskBindingProtocolParams = z.infer<
  typeof zcodeAutomationCheckTaskBindingParamsSchema
>;
export const zcodeAutomationCheckTaskBindingResultSchema = z
  .object({ bound: z.boolean() })
  .strict();
export type ZCodeAutomationCheckTaskBindingProtocolResult = z.infer<
  typeof zcodeAutomationCheckTaskBindingResultSchema
>;

export const zcodeAutomationDeleteParamsSchema = z
  .object({ automationId: nonEmptyString })
  .strict();
export type ZCodeAutomationDeleteProtocolParams = z.infer<typeof zcodeAutomationDeleteParamsSchema>;
export const zcodeAutomationDeleteResultSchema = z.object({ deleted: z.boolean() }).strict();
export type ZCodeAutomationDeleteProtocolResult = z.infer<typeof zcodeAutomationDeleteResultSchema>;

// ---- In-session creation protocol for Off-Peak tasks ----
// A sibling to automation in a separate domain; do not reuse markers or tables. Host injects the workspace
// from the current session instead of including it in protocol arguments (matching automation/create).
// permissionMode exposes only the product's four supported values (D29-4); Host resolves defaults (D49-4: yolo / last allowed_models entry / highest reasoning level).
export const zcodeOffPeakPermissionModeSchema = z.enum([
  "build",
  "edit",
  "plan",
  "yolo",
  "guarded",
]);
export type ZCodeOffPeakProtocolPermissionMode = z.infer<typeof zcodeOffPeakPermissionModeSchema>;

export const zcodeOffPeakCreateParamsSchema = z
  .object({
    title: nonEmptyString,
    prompt: nonEmptyString,
    permissionMode: zcodeOffPeakPermissionModeSchema.optional(),
    model: nonEmptyString.optional(),
    thoughtLevel: nonEmptyString.optional(),
    // Session creation is bound to the current session (matching automation/create targetTaskId); populated by the CLI port.
    boundSessionId: nonEmptyString.optional(),
  })
  .strict();
export type ZCodeOffPeakCreateProtocolParams = z.infer<typeof zcodeOffPeakCreateParamsSchema>;

// Protocol-side task snapshot: minimum fields for end-of-turn cards and OffPeakList.
// Do not expose serverTicketId across the boundary.
export const zcodeOffPeakTaskSnapshotSchema = z
  .object({
    offPeakTaskId: nonEmptyString,
    title: z.string(),
    status: z.enum(["queued", "paused", "running", "completed", "failed", "cancelled"]),
    queuePosition: z.number().int().positive().optional(),
    sessionId: nonEmptyString.optional(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type ZCodeOffPeakTaskProtocolSnapshot = z.infer<typeof zcodeOffPeakTaskSnapshotSchema>;

// Preserve failure categories across the protocol (mirrors the shared OffPeakTaskCreateResult discriminated union; errors are not degraded to strings).
// Model allowlist prevalidation reuses the client_validation category + errorCode "model_not_allowed"; do not expand the category enum.
export const zcodeOffPeakCreateResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), task: zcodeOffPeakTaskSnapshotSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      failureStage: z.enum(["client_validation", "ticket_request", "local_persist"]),
      errorCategory: z.enum([
        "client_validation",
        "eligibility_3101",
        "quota_3103",
        "network",
        "invalid_response",
        "local_persist",
        "unknown",
      ]),
      errorCode: z.string(),
    })
    .strict(),
]);
export type ZCodeOffPeakCreateProtocolResult = z.infer<typeof zcodeOffPeakCreateResultSchema>;

export const zcodeOffPeakListParamsSchema = z.object({}).strict();
export type ZCodeOffPeakListProtocolParams = z.infer<typeof zcodeOffPeakListParamsSchema>;
export const zcodeOffPeakListResultSchema = z
  .object({ tasks: z.array(zcodeOffPeakTaskSnapshotSchema) })
  .strict();
export type ZCodeOffPeakListProtocolResult = z.infer<typeof zcodeOffPeakListResultSchema>;

export const zcodeProtocolMethods = {
  runtimeCapabilities: "runtime/capabilities",
  computerUseOperationEvent: "computer-use/operation-event",
  sessionCreate: "session/create",
  sessionResume: "session/resume",
  sessionList: "session/list",
  sessionSubagents: "session/subagents",
  sessionRequestRuntimePreferences: "session/requestRuntimePreferences",
  subagentsReadRuntimeConfig: "subagents/readRuntimeConfig",
  sessionRead: "session/read",
  sessionMessages: "session/messages",
  sessionEvents: "session/events",
  sessionDebug: "session/debug",
  sessionSubscribe: "session/subscribe",
  // @deprecated (partial): the main send path has converged on v4 sendText; only the adapter attachment
  // fallback branch still consumes this (v4 attachmentRef upload/storage commands are not modeled). Remove after attachment commands land.
  sessionSend: "session/send",
  // @deprecated: the Host client method is gone (stop has converged on the v4 stop command).
  // Keep the wire case for compatibility (the transport bypass list still references it); remove with the legacy method group.
  sessionStop: "session/stop",
  // @deprecated: the Host client method is gone (it has converged on the v4 cancelBackgroundWork command).
  // Keep the wire case for compatibility and remove it with the legacy method group.
  sessionCancelBackgroundTask: "session/cancelBackgroundTask",
  // @deprecated: the Host client method is gone (the v4 forkAssistant native handler calls
  // server-operations.forkSession directly through the forkSessionAtMessage hook). Keep the wire case and
  // fork params/result schemas because the op is still live; fork records were rewritten natively in v4.
  sessionFork: "session/fork",
  sessionCompact: "session/compact",
  sessionGoal: "session/goal",
  sessionClose: "session/close",
  // setModel is still consumed by zcodeSessionService's legacy Desktop path; replayable
  // switchModelConfig resolves Selection directly through the target Environment Registry.
  sessionSetModel: "session/setModel",
  // The replayable facade's reasoning effort/mode has converged on v4 switchModelConfig/
  // switchCollaborationMode; remaining consumers are zcodeSessionService (legacy Desktop path, to be removed with the
  // Desktop v4 UI migration) and the residual auto value in setMode (intentionally excluded from the v4 value set).
  sessionSetThoughtLevel: "session/setThoughtLevel",
  sessionSetMode: "session/setMode",
  workspaceReadPresentation: "workspace/readPresentation",
  workspaceHookTrustGrant: "workspace/hooks/trustGrant",
  // Process-level Account Provider Config is separate from the workspace runtime directory.
  providerUpdateAccountConfig: "provider/updateAccountConfig",
  workspaceUpdateInteractionPreferences: "workspace/updateInteractionPreferences",
  workspaceUpdateModelIoPreferences: "workspace/updateModelIoPreferences",
  // Off-Peak tool-surface admission is a workspace-level fact (rollout + local/remote), synchronized by Host when the Agent is ready;
  // CLI reads it consistently for legacy create/resume and v4 cold recovery. Host safely ignores method-not-found from older CLIs.
  workspaceUpdateOffPeakToolPolicy: "workspace/updateOffPeakToolPolicy",
  // Dynamic workflow rollout gate: same synchronization pattern as Off-Peak.
  workspaceUpdateDynamicWorkflowPolicy: "workspace/updateDynamicWorkflowPolicy",
  // LLM execution runs in the CLI, so direct access is not possible; consumed only internally by services
  // (commit message), and removable once v4 workspace queries/commands cover it.
  workspaceGenerateText: "workspace/generateText",
  workspaceCancelGenerateText: "workspace/cancelGenerateText",
  providerTestModelConnectivity: "provider/testModelConnectivity",
  mcpList: "mcp/list",
  mcpReadResource: "mcp/readResource",
  mcpUiOpenInstance: "mcp/uiOpenInstance",
  mcpUiCloseInstance: "mcp/uiCloseInstance",
  mcpUiValidateInstance: "mcp/uiValidateInstance",
  mcpUiSampling: "mcp/uiSampling",
  mcpUiCancelSampling: "mcp/uiCancelSampling",
  mcpUiCallTool: "mcp/uiCallTool",
  mcpUiCancelCall: "mcp/uiCancelCall",
  mcpUiReadResource: "mcp/uiReadResource",
  mcpUiListResources: "mcp/uiListResources",
  mcpUiListResourceTemplates: "mcp/uiListResourceTemplates",
  mcpUiSubscribeResource: "mcp/uiSubscribeResource",
  mcpUiUnsubscribeResource: "mcp/uiUnsubscribeResource",
  // App-Provided Tools: page tool registration/unregistration and model-call claim/result (mailbox delivery uses v4 live deltas).
  mcpUiRegisterAppTools: "mcp/uiRegisterAppTools",
  mcpUiUnregisterAppTools: "mcp/uiUnregisterAppTools",
  mcpUiClaimAppToolCall: "mcp/uiClaimAppToolCall",
  mcpUiResolveAppToolCall: "mcp/uiResolveAppToolCall",
  pluginsList: "plugins/list",
  pluginsReferenceCatalog: "plugins/referenceCatalog",
  pluginsListUiSurfaces: "plugins/listUiSurfaces",
  pluginsReferenceCatalogWithCategory: "plugins/referenceCatalogWithCategory",
  skillsReferenceCatalog: "skills/referenceCatalog",
  // Saved workflow GUI hub: workspace-level and sessionless.
  workflowsList: "workflows/list",
  workflowsGet: "workflows/get",
  workflowsUpdateMeta: "workflows/updateMeta",
  workflowsDelete: "workflows/delete",
  workflowsRuns: "workflows/runs",
  // Move a same-named file between project and global scope.
  workflowsMove: "workflows/move",
  // Completion-card "Save directly" and "Saved" resolution (docs/dynamic-workflow/transcript-and-notifications.md):
  // the former writes the script read from the journal by runId; the latter identifies the saved workflow corresponding to this run.
  workflowsSave: "workflows/save",
  workflowsForRun: "workflows/forRun",
  pluginsResolveSuggestedReference: "plugins/resolveSuggestedReference",
  pluginsSetEnabled: "plugins/setEnabled",
  pluginsOverview: "plugins/overview",
  pluginsMarketplaceAdd: "plugins/marketplace/add",
  pluginsMarketplaceRemove: "plugins/marketplace/remove",
  pluginsMarketplaceUpdate: "plugins/marketplace/update",
  pluginsInstall: "plugins/install",
  pluginsCancelOperation: "plugins/cancelOperation",
  pluginsUninstall: "plugins/uninstall",
  pluginsUpdate: "plugins/update",
  pluginsRestoreBuiltin: "plugins/restoreBuiltin",
  pluginsConfigure: "plugins/configure",
  pluginsResetConfig: "plugins/resetConfig",
  pluginsValidate: "plugins/validate",
  pluginsDescribe: "plugins/describe",
  automationCreate: "automation/create",
  topicResourceRead: "topic/resource/read",
  channelReply: "bot/channel/reply",
  topicResourceCancel: "topic/resource/cancel",
  automationUpdate: "automation/update",
  automationCheckTaskBinding: "automation/checkTaskBinding",
  automationList: "automation/list",
  automationDelete: "automation/delete",
  // Off-Peak session creation: a separate method family alongside automation.
  offPeakCreate: "offPeak/create",
  offPeakList: "offPeak/list",
  // @deprecated: Host consumption is gone (zcodeAgentService now uses v4/usage/stats).
  // Only the CLI server's wire compatibility case remains; remove it with the legacy method group.
  usageStats: "usage/stats",
  // ZCode Protocol exposes only session-first methods to the Agent; task is a UI projection concept and must not leak into protocol method names.
  // @deprecated: Host now uses v4/conversation/usage; remove this later with usage/stats.
  sessionUsage: "session/usage",
  // Resource manager: CLI reports MCP child-process pids and plugin ownership (in-memory only, no I/O); sampling occurs on the Host side.
  processChildProcesses: "process/childProcesses",
  processNetworkCapture: "process/networkCapture",
  interactionRequestPermission: "interaction/requestPermission",
  interactionRequestUserInput: "interaction/requestUserInput",
  interactionRequestProviderRuntimeHeaders: "interaction/requestProviderRuntimeHeaders",
  interactionRequestOfficialMcpAuthHeaders: "interaction/requestOfficialMcpAuthHeaders",
  // Browser-use reverse requests are initiated by the Agent and forwarded by Host to the CDP executor in main.
  interactionBrowserList: "interaction/browserList",
  interactionBrowserExecute: "interaction/browserExecute",
} as const;

export type ZCodeProtocolMethod = (typeof zcodeProtocolMethods)[keyof typeof zcodeProtocolMethods];

export const zcodeProtocolEmptyResultSchema = z.object({}).strict();

// The latest v4 main path no longer depends on the complete legacy method table; retain only the minimal contracts still used by compatibility tests and the browser broker
// to avoid reintroducing removed legacy methods.
export const zcodeProtocolSessionMethodContracts = {
  [zcodeProtocolMethods.mcpUiOpenInstance]: {
    params: zcodeMcpUiOpenInstanceParamsSchema,
    result: zcodeMcpUiOpenInstanceResultSchema,
  },
  [zcodeProtocolMethods.mcpUiCloseInstance]: {
    params: zcodeMcpUiCloseInstanceParamsSchema,
    result: zcodeMcpUiCloseInstanceResultSchema,
  },
  [zcodeProtocolMethods.mcpUiValidateInstance]: {
    params: zcodeMcpUiCloseInstanceParamsSchema,
    result: zcodeMcpUiResourceSubscriptionResultSchema,
  },
  [zcodeProtocolMethods.workspaceHookTrustGrant]: {
    params: zcodeWorkspaceHookTrustGrantParamsSchema,
    result: zcodeWorkspaceHookTrustGrantResultSchema,
  },
  [zcodeProtocolMethods.mcpList]: {
    params: zcodeMcpListParamsSchema,
    result: zcodeMcpListResultSchema,
  },
  [zcodeProtocolMethods.mcpReadResource]: {
    params: zcodeMcpReadResourceParamsSchema,
    result: zcodeMcpReadResourceResultSchema,
  },
  [zcodeProtocolMethods.mcpUiSampling]: {
    params: zcodeMcpUiSamplingParamsSchema,
    result: zcodeMcpUiSamplingResultSchema,
  },
  [zcodeProtocolMethods.mcpUiCancelSampling]: {
    params: zcodeMcpUiCancelSamplingParamsSchema,
    result: zcodeMcpUiCancelCallResultSchema,
  },
  [zcodeProtocolMethods.mcpUiCallTool]: {
    params: zcodeMcpUiCallToolParamsSchema,
    result: zcodeMcpUiCallToolResultSchema,
  },
  [zcodeProtocolMethods.mcpUiCancelCall]: {
    params: zcodeMcpUiCancelCallParamsSchema,
    result: zcodeMcpUiCancelCallResultSchema,
  },
  [zcodeProtocolMethods.mcpUiReadResource]: {
    params: zcodeMcpUiReadResourceParamsSchema,
    result: zcodeMcpUiReadResourceResultSchema,
  },
  [zcodeProtocolMethods.mcpUiListResources]: {
    params: zcodeMcpUiListResourcesParamsSchema,
    result: zcodeMcpUiListResourcesResultSchema,
  },
  [zcodeProtocolMethods.mcpUiListResourceTemplates]: {
    params: zcodeMcpUiListResourcesParamsSchema,
    result: zcodeMcpUiListResourceTemplatesResultSchema,
  },
  [zcodeProtocolMethods.mcpUiSubscribeResource]: {
    params: zcodeMcpUiResourceSubscriptionParamsSchema,
    result: zcodeMcpUiResourceSubscriptionResultSchema,
  },
  [zcodeProtocolMethods.mcpUiUnsubscribeResource]: {
    params: zcodeMcpUiResourceSubscriptionParamsSchema,
    result: zcodeMcpUiResourceSubscriptionResultSchema,
  },
  [zcodeProtocolMethods.mcpUiRegisterAppTools]: {
    params: zcodeMcpUiRegisterAppToolsParamsSchema,
    result: zcodeMcpUiRegisterAppToolsResultSchema,
  },
  [zcodeProtocolMethods.mcpUiUnregisterAppTools]: {
    params: zcodeMcpUiUnregisterAppToolsParamsSchema,
    result: zcodeMcpUiUnregisterAppToolsResultSchema,
  },
  [zcodeProtocolMethods.mcpUiClaimAppToolCall]: {
    params: zcodeMcpUiClaimAppToolCallParamsSchema,
    result: zcodeMcpUiAppToolAcceptedResultSchema,
  },
  [zcodeProtocolMethods.mcpUiResolveAppToolCall]: {
    params: zcodeMcpUiResolveAppToolCallParamsSchema,
    result: zcodeMcpUiAppToolAcceptedResultSchema,
  },
  [zcodeProtocolMethods.interactionBrowserList]: {
    params: zcodeBrowserListParamsSchema,
    result: zcodeBrowserListResultSchema,
  },
  [zcodeProtocolMethods.interactionBrowserExecute]: {
    params: zcodeBrowserExecuteParamsSchema,
    result: zcodeBrowserExecuteResultSchema,
  },
} as const satisfies Partial<
  Record<ZCodeProtocolMethod, { params: z.ZodTypeAny; result: z.ZodTypeAny }>
>;

export type ZCodeProtocolSessionMethodContract =
  (typeof zcodeProtocolSessionMethodContracts)[keyof typeof zcodeProtocolSessionMethodContracts];

/** Private control frame used only to prepare the child process; raw paths are excluded from business events and telemetry. */
export const zcodeStoragePreparationFrameSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("startup/storagePath"),
      params: z.object({ path: z.string().min(1).max(32768) }).strict(),
    })
    .strict(),
  z
    .object({ method: z.literal("startup/storagePrepared"), params: z.object({}).strict() })
    .strict(),
  z
    .object({ method: z.literal("startup/storageState"), params: zcodeStorageStartupStateSchema })
    .strict(),
]);
export const zcodeStoragePathReadySchema = z
  .object({ method: z.literal("startup/storagePathReady"), reuse: z.boolean().optional() })
  .strict();

// Strict factual contract for local Desktop TTFT; checkpoints cannot substitute for actual content frames.
export { localTtftFactsSchema } from "../localTtft.js";
// Group source is injected by the trusted Host; V4 commands and persisted inputs use the same runtime validation.
export {
  botIdentitySchema,
  botTopicInputMessageSchema,
  botGroupInputSourceSchema,
  type BotGroupInputSource,
} from "../bots.js";
export {
  botTopicContextSchema,
  botTopicMessageSchema,
  type BotTopicHistoryBatch,
  type BotTopicMessage,
} from "../bots.js";
